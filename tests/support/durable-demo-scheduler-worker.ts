/**
 * Forked child entry point for the durable demo run-fence store's
 * cross-process mutual-exclusion proof.
 *
 * Two independent OS processes each attempt to acquire the same work item's
 * fence with two different candidate fences (differing only in
 * `holderDigest`, so their `contentDigest`s differ). The property under
 * test — that at most one process's compare-and-swap can land — is a
 * property of the on-disk write lock the durable substrate provides, not of
 * anything observable inside a single event loop, so it can only be
 * demonstrated with real separate processes (matching the convention already
 * established by `tests/durable-multiprocess.test.ts`).
 *
 * Reads its configuration from argv and reports the outcome over the IPC
 * channel. Reads no environment variable and opens no network connection.
 */

import { createDurableDemoRunFenceStore } from "../../src/durable-demo-scheduler-stores.js";
import { openDurableSqliteSubstrate } from "../../src/durable-sqlite-substrate.js";
import { DurableSubstrateError } from "../../src/durable-substrate.js";
import type { DemoRunFence, DemoRunState } from "../../src/demo-types.js";
import type { Digest } from "../../src/types.js";

export interface FenceWorkerRequest {
  readonly path: string;
  readonly maxEntries: number;
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
  readonly fence: DemoRunFence;
  readonly runningState: DemoRunState;
  readonly expectedRunStateDigest: Digest;
}

export interface FenceWorkerReply {
  readonly pid: number;
  readonly status: "appended" | "existing" | "conflict" | "error";
  readonly error: string | null;
}

async function run(request: FenceWorkerRequest): Promise<FenceWorkerReply> {
  const substrate = openDurableSqliteSubstrate({
    path: request.path,
    storeId: "runtime-state-store",
    storeNamespace: "namespace-runtime-state-store",
    maxEntries: request.maxEntries,
    busyTimeoutMs: request.busyTimeoutMs,
    supportedNodeMajors: request.supportedNodeMajors
  });
  try {
    const store = createDurableDemoRunFenceStore(substrate);
    const result = await store.acquire({
      expectedRunStateDigest: request.expectedRunStateDigest,
      fence: request.fence,
      runningState: request.runningState
    });
    return { pid: process.pid, status: result.status, error: null };
  } catch (error) {
    const message =
      error instanceof DurableSubstrateError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { pid: process.pid, status: "error", error: message };
  } finally {
    substrate.close();
  }
}

const encoded = process.argv[2];
if (encoded !== undefined) {
  const request = JSON.parse(encoded) as FenceWorkerRequest;
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
          status: "error",
          error: error instanceof Error ? error.message : String(error)
        } satisfies FenceWorkerReply,
        () => process.exit(1)
      );
    });
}
