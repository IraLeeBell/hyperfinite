/**
 * Forked child entry point for `DemoProviderUsageLedger.reconcile()`'s
 * cross-process single-flight proof.
 *
 * The property under test — that at most one process among many racing the
 * same attempt digest ever invokes the injected, potentially billable
 * `resolveUsage` callback — is a property of the on-disk claim record and
 * the substrate's own cross-process `appendOnce` atomicity, not of anything
 * observable inside a single event loop. Real processes are used rather
 * than simulated concurrency for the same reason
 * `tests/support/durable-worker.ts` uses them for the substrate's own
 * primitives.
 *
 * Reads its configuration from argv and reports over the IPC channel. Reads
 * no environment variable and opens no network connection.
 */

import { openDurableSqliteSubstrate } from "../../src/durable-sqlite-substrate.js";
import { createDurableDemoProviderUsageLedger } from "../../src/durable-demo-stores.js";
import type { DemoProviderAttemptEvidence } from "../../src/demo-scheduler.js";
import type { DemoSignature } from "../../src/demo-types.js";

export interface ProviderUsageWorkerRequest {
  readonly path: string;
  readonly maxEntries: number;
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
  readonly attempt: DemoProviderAttemptEvidence;
}

export interface ProviderUsageWorkerReply {
  readonly pid: number;
  readonly resolveUsageCalls: number;
  readonly outcome: "settled" | "pending" | "error";
  readonly errorName: string | null;
}

/** A trivial, non-cryptographic signer: this worker never verifies signatures. */
const workerSigner = {
  sign: (payload: unknown): Promise<DemoSignature> =>
    Promise.resolve({
      algorithm: "ed25519" as const,
      keyId: "worker:key-1",
      value: Buffer.from(JSON.stringify(payload)).toString("base64").slice(0, 64)
    })
};

async function run(request: ProviderUsageWorkerRequest): Promise<ProviderUsageWorkerReply> {
  const substrate = openDurableSqliteSubstrate({
    path: request.path,
    storeId: "receipt-journal",
    storeNamespace: "namespace-receipt-journal",
    maxEntries: request.maxEntries,
    busyTimeoutMs: request.busyTimeoutMs,
    supportedNodeMajors: request.supportedNodeMajors
  });
  let resolveUsageCalls = 0;
  const store = createDurableDemoProviderUsageLedger({
    substrate,
    signer: workerSigner,
    clock: { now: () => "2026-08-30T12:00:00.000Z" },
    resolveUsage: () => {
      resolveUsageCalls += 1;
      return Promise.resolve({
        status: "settled" as const,
        calls: 1 as const,
        tokens: 10,
        costUnits: 1,
        providerUsageDigest: `sha256:${"0".repeat(64)}` as const
      });
    }
  });
  try {
    await store.reconcile(request.attempt);
    return { pid: process.pid, resolveUsageCalls, outcome: "settled", errorName: null };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "DemoProviderUsageLedgerReconciliationPendingError"
    ) {
      return { pid: process.pid, resolveUsageCalls, outcome: "pending", errorName: error.name };
    }
    return {
      pid: process.pid,
      resolveUsageCalls,
      outcome: "error",
      errorName: error instanceof Error ? error.name : String(error)
    };
  } finally {
    substrate.close();
  }
}

const encoded = process.argv[2];
if (encoded !== undefined) {
  const request = JSON.parse(encoded) as ProviderUsageWorkerRequest;
  run(request)
    .then((reply) => {
      // `process.send` is asynchronous. Exiting before it flushes drops the
      // reply and makes the parent report a phantom atomicity failure.
      if (process.send === undefined) process.exit(0);
      else process.send(reply, () => process.exit(0));
    })
    .catch((error: unknown) => {
      process.send?.(
        {
          pid: process.pid,
          resolveUsageCalls: 0,
          outcome: "error",
          errorName: error instanceof Error ? error.message : String(error)
        } satisfies ProviderUsageWorkerReply,
        () => process.exit(1)
      );
    });
}
