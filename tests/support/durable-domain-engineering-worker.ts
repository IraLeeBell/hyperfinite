/**
 * Forked child entry point for the multi-process tests of the domain and
 * engineering durable adapters.
 *
 * Real processes are used rather than simulated concurrency because the claim
 * under test — that two independent callers cannot both win the same operation
 * slot or the same evidence compare-and-swap — is a property of the on-disk
 * lock and the fenced append key, not of anything observable inside one event
 * loop.
 *
 * Reads its configuration from argv and reports over the IPC channel. Reads no
 * environment variable and opens no network connection.
 */

import { digest } from "../../src/canonical.js";
import { openDurableDomainOperationGrantStore } from "../../src/durable-domain-stores.js";
import {
  openDurableEngineeringCostLedger,
  openDurableEngineeringEvidenceStore,
  openDurableEngineeringProviderEvidence
} from "../../src/durable-engineering-stores.js";
import { openDurableSqliteSubstrate } from "../../src/durable-sqlite-substrate.js";
import type { Digest } from "../../src/types.js";

export interface AdapterWorkerRequest {
  readonly scenario:
    | "domain-claim-race"
    | "evidence-append-race"
    | "cost-hold-race";
  readonly path: string;
  readonly workerIndex: number;
  /**
   * When true every worker submits byte-identical bytes. That is the harder
   * case: the substrate reports `existing` rather than `conflict` to the
   * losers, so only an adapter that treats `existing` as a refusal can still
   * produce exactly one winner.
   */
  readonly identical: boolean;
  readonly maxEntries: number;
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
  readonly storeId: string;
  readonly storeNamespace: string;
  readonly now: string;
  readonly grantCheckedAt: string;
  readonly grantExpiresAt: string;
  readonly effectKey: Digest;
  /** Pool authority for the cost-hold race; ignored by other scenarios. */
  readonly totalBudgetCostUnits?: number;
}

/**
 * The rendezvous message a worker sends when it is ready to make its contended
 * write, and the release the parent broadcasts once every worker has arrived.
 */
export interface AdapterWorkerReady {
  readonly type: "ready";
  readonly workerIndex: number;
}

export interface AdapterWorkerRelease {
  readonly type: "go";
}

export interface AdapterWorkerReply {
  readonly pid: number;
  readonly claimed: number;
  readonly refused: number;
  readonly appended: number;
  /** Digest of the hold this worker obtained, when it obtained one. */
  readonly holdDigests?: readonly Digest[];
  readonly conflicted: number;
  readonly heads: readonly string[];
  readonly errors: readonly string[];
}

/** Mirrors `harnessSignature` so parent and child produce identical bytes. */
function harnessSignature(payload: unknown, keyId = "durable:key-1"): {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
} {
  return {
    algorithm: "ed25519",
    keyId,
    value: Buffer.from(digest(payload), "utf8").toString("base64url")
  };
}

/**
 * A true rendezvous: the worker announces that it is ready and then blocks
 * until the parent has heard from every worker and released them together.
 *
 * A wall-clock deadline is not sufficient — a worker that started late would
 * simply arrive after it and never contend, so an implementation with no fence
 * at all could still pass the race tests.
 */
async function rendezvous(workerIndex: number): Promise<void> {
  if (typeof process.send !== "function") return;
  process.send({ type: "ready", workerIndex } satisfies AdapterWorkerReady);
  await new Promise<void>((resolve) => {
    const onMessage = (message: unknown): void => {
      if ((message as AdapterWorkerRelease | undefined)?.type === "go") {
        process.off("message", onMessage);
        resolve();
      }
    };
    process.on("message", onMessage);
  });
}

async function run(request: AdapterWorkerRequest): Promise<AdapterWorkerReply> {
  const substrate = openDurableSqliteSubstrate({
    path: request.path,
    storeId: request.storeId,
    storeNamespace: request.storeNamespace,
    maxEntries: request.maxEntries,
    busyTimeoutMs: request.busyTimeoutMs,
    supportedNodeMajors: request.supportedNodeMajors
  });

  let claimed = 0;
  let refused = 0;
  let appended = 0;
  let conflicted = 0;
  const heads: string[] = [];
  const holdDigests: Digest[] = [];
  const errors: string[] = [];

  try {
    if (request.scenario === "cost-hold-race") {
      // Every worker races the *same* (reservation, phase, sequence) hold.
      // A hold is content-addressed on that triple, so the correct outcome is
      // not "one winner and N errors" but "one durable hold that every worker
      // that got an answer agrees on" — a second hold would commit the same
      // reserved units twice.
      const ledger = openDurableEngineeringCostLedger({
        substrate,
        signer: { sign: async (payload) => harnessSignature(payload) },
        providerEvidence: {
          listAttempts: async () => [],
          readUsage: async () => null
        },
        totalBudgetCostUnits: request.totalBudgetCostUnits ?? 100
      });
      // The reservation is read from the ledger's own chain rather than passed
      // in, so no worker can present one the ledger never made.
      const chain = await substrate.verifyChain("engineering.cost-ledger");
      const reservation = chain
        .map((record) => record.body as { readonly kind: string; readonly document: unknown })
        .filter((entry) => entry.kind === "reservation")
        .map((entry) => entry.document)[0];
      try {
        await rendezvous(request.workerIndex);
        const hold = await ledger.hold({
          reservation: reservation as Parameters<typeof ledger.hold>[0]["reservation"],
          phase: "framing",
          sequence: 1,
          now: request.now
        });
        claimed += 1;
        holdDigests.push(digest(hold));
      } catch (error) {
        const code = (error as { readonly code?: unknown }).code;
        if (
          error instanceof Error &&
          ((error.name === "DurableEngineeringStoreError" &&
            (code === "ADAPTER_CONFLICT" || code === "ADAPTER_OUTPUT_INVALID")) ||
            error.name === "DurableEngineeringAmbiguityError" ||
            (error.name === "DurableSubstrateError" && code === "STORE_UNAVAILABLE"))
        ) {
          refused += 1;
        } else {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    } else if (request.scenario === "domain-claim-race") {
      const store = openDurableDomainOperationGrantStore({
        substrate,
        storeId: "operation-grant-store",
        clock: { now: () => request.now },
        signer: { sign: (payload) => harnessSignature(payload) },
        headValidityMs: 60_000
      });
      try {
        // Every worker deliberately fences on *genesis* rather than on the head
        // it just read. Reading the head first would let the workers serialize
        // and each make a legitimate distinct claim, which proves nothing; this
        // way all of them target the same store position, so the append key is
        // the only thing that can decide the winner.
        const observed = await store.readHead({
          storeId: "operation-grant-store",
          challenge: digest({ challenge: "head", worker: request.workerIndex })
        });
        heads.push(String(observed.storeSequence));
        const distinguisher = request.identical ? 0 : request.workerIndex;
        await rendezvous(request.workerIndex);
        const claim = await store.claim({
          storeId: "operation-grant-store",
          claimChallenge: digest({ challenge: "claim", worker: distinguisher }),
          expectedPreviousHead: null,
          expectedStoreSequence: 0,
          grantDigest: digest({ grant: distinguisher }),
          redemptionKey: digest({ redemption: distinguisher }),
          operation: "repository-package",
          contextDigest: digest({ context: "shared" }),
          repositoryIdentityDigest: digest({ repository: "shared" }),
          runId: `run-${String(distinguisher)}`,
          runAttempt: 1,
          operationSequence: 1,
          grantCheckedAt: request.grantCheckedAt,
          grantExpiresAt: request.grantExpiresAt
        });
        if (claim === null) refused += 1;
        else {
          claimed += 1;
          heads.push(claim.head);
        }
      } catch (error) {
        // A loser's own commit may be reported as undecided under contention,
        // and a write lock that never opened is an unambiguous no-op. Neither
        // yields a receipt, so both are counted as refusals rather than as
        // harness failures — the "exactly one winner" assertion stays exact.
        const code = (error as { readonly code?: unknown }).code;
        if (
          error instanceof Error &&
          ((error.name === "DurableDomainStoreError" &&
            code === "ADAPTER_ACKNOWLEDGEMENT_AMBIGUOUS") ||
            (error.name === "DurableSubstrateError" && code === "STORE_UNAVAILABLE"))
        ) {
          refused += 1;
        } else {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    } else {
      const store = openDurableEngineeringEvidenceStore({ substrate });
      const payload = {
        sequence: 1,
        previousEvidenceDigest: null,
        effectKey: request.effectKey,
        effectOrdinal: 1,
        effectType: "create-branch" as const,
        workflowId: "workflow-1",
        contractRevision: 1,
        planDigest: digest({
          plan: request.identical ? 0 : request.workerIndex
        }),
        bindingDigest: digest({ binding: "shared" }),
        state: "pending" as const,
        effectDigest: null,
        createdAt: request.now,
        updatedAt: request.now
      };
      try {
        await rendezvous(request.workerIndex);
        await store.conditionalAppend(null, {
          ...payload,
          signature: harnessSignature(payload)
        });
        appended += 1;
      } catch (error) {
        const code = (error as { readonly code?: unknown }).code;
        if (
          error instanceof Error &&
          (error.name === "EngineeringEvidenceConflictError" ||
            // Under byte-identical contention a loser's own commit may itself
            // be reported as undecided, and a write lock that never opened is
            // an unambiguous no-op. Neither is a win, so both are counted with
            // the conflicts and the "exactly one winner" assertion stays exact.
            error.name === "DurableEngineeringAmbiguityError" ||
            (error.name === "DurableSubstrateError" && code === "STORE_UNAVAILABLE"))
        ) {
          conflicted += 1;
        } else {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  } finally {
    substrate.close();
  }

  return {
    pid: process.pid,
    claimed,
    refused,
    appended,
    conflicted,
    heads,
    holdDigests,
    errors
  };
}

const encoded = process.argv[2];
if (encoded !== undefined) {
  const request = JSON.parse(encoded) as AdapterWorkerRequest;
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
          claimed: 0,
          refused: 0,
          appended: 0,
          conflicted: 0,
          heads: [],
          errors: [error instanceof Error ? error.message : String(error)]
        } satisfies AdapterWorkerReply,
        () => process.exit(1)
      );
    });
}
