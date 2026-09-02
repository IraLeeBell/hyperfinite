/**
 * Forked child entry point for the multi-process durability tests.
 *
 * Real processes are used rather than simulated concurrency because the whole
 * claim under test — that two independent workers cannot both win the same
 * append or the same compare-and-swap — is a property of the on-disk lock, not
 * of anything observable inside a single event loop.
 *
 * Reads its configuration from argv and reports counts over the IPC channel.
 * Reads no environment variable and opens no network connection.
 */

import {
  openDurableSqliteSubstrate,
  type DurableSqliteOpenOptions
} from "../../src/durable-sqlite-substrate.js";
import {
  DurableAmbiguousAcknowledgementError,
  DurableSubstrateError
} from "../../src/durable-substrate.js";
import type { Digest } from "../../src/types.js";

export interface WorkerRequest {
  readonly scenario:
    | "race-append-identical"
    | "race-append-conflicting"
    | "race-cas-same-head"
    | "contended-cas-loop"
    | "provision-open";
  readonly path: string;
  readonly namespace: string;
  readonly key: string;
  readonly workerIndex: number;
  readonly iterations: number;
  readonly maxEntries: number;
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
  /**
   * Only consumed by `"provision-open"`, which races independent processes
   * opening the same absent file for the very first time. Every
   * other scenario provisions the store once, single-threaded, before
   * forking, so it always opens under the fixed `receipt-journal` identity.
   * Letting `provision-open` vary the identity per worker is what lets one
   * test drive a genuine identity conflict during first-open provisioning,
   * not just a same-identity race.
   */
  readonly provisionStoreId?: string;
  readonly provisionStoreNamespace?: string;
}

export interface WorkerReply {
  readonly pid: number;
  readonly appended: number;
  readonly existing: number;
  readonly conflict: number;
  readonly capacityRefusals: number;
  readonly unavailable: number;
  readonly errors: readonly string[];
  /** Populated only by `"provision-open"`. */
  readonly opened?: boolean;
  readonly storeId?: string;
  readonly storeNamespace?: string;
  readonly maxEntries?: number;
  readonly formatVersion?: number;
  readonly refusalCode?: string;
  readonly ambiguous?: boolean;
}

async function runProvisionOpen(request: WorkerRequest): Promise<WorkerReply> {
  const openOptions: DurableSqliteOpenOptions = {
    path: request.path,
    storeId: request.provisionStoreId ?? "receipt-journal",
    storeNamespace: request.provisionStoreNamespace ?? "namespace-receipt-journal",
    maxEntries: request.maxEntries,
    busyTimeoutMs: request.busyTimeoutMs,
    supportedNodeMajors: request.supportedNodeMajors
  };

  try {
    const store = openDurableSqliteSubstrate(openOptions);
    let appended = 0;
    let existing = 0;
    let conflict = 0;
    const errors: string[] = [];
    try {
      // Prove the opened handle is genuinely usable, not merely returned.
      const result = await store.appendOnce({
        namespace: request.namespace,
        key: `w${request.workerIndex}`,
        body: { worker: request.workerIndex }
      });
      if (result.status === "appended") appended += 1;
      else if (result.status === "existing") existing += 1;
      else conflict += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      store.close();
    }
    return {
      pid: process.pid,
      appended,
      existing,
      conflict,
      capacityRefusals: 0,
      unavailable: 0,
      errors,
      opened: true,
      storeId: store.metadata.storeId,
      storeNamespace: store.metadata.storeNamespace,
      maxEntries: store.metadata.maxEntries,
      formatVersion: store.metadata.formatVersion
    };
  } catch (error) {
    if (error instanceof DurableAmbiguousAcknowledgementError) {
      return {
        pid: process.pid,
        appended: 0,
        existing: 0,
        conflict: 0,
        capacityRefusals: 0,
        unavailable: 0,
        errors: [],
        opened: false,
        ambiguous: true
      };
    }
    if (error instanceof DurableSubstrateError) {
      return {
        pid: process.pid,
        appended: 0,
        existing: 0,
        conflict: 0,
        capacityRefusals: 0,
        unavailable: error.code === "STORE_UNAVAILABLE" ? 1 : 0,
        errors: [],
        opened: false,
        refusalCode: error.code
      };
    }
    return {
      pid: process.pid,
      appended: 0,
      existing: 0,
      conflict: 0,
      capacityRefusals: 0,
      unavailable: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      opened: false
    };
  }
}

async function run(request: WorkerRequest): Promise<WorkerReply> {
  if (request.scenario === "provision-open") {
    return runProvisionOpen(request);
  }

  const store = openDurableSqliteSubstrate({
    path: request.path,
    storeId: "receipt-journal",
    storeNamespace: "namespace-receipt-journal",
    maxEntries: request.maxEntries,
    busyTimeoutMs: request.busyTimeoutMs,
    supportedNodeMajors: request.supportedNodeMajors
  });

  let appended = 0;
  let existing = 0;
  let conflict = 0;
  let capacityRefusals = 0;
  let unavailable = 0;
  const errors: string[] = [];

  try {
    if (request.scenario === "contended-cas-loop") {
      for (let index = 0; index < request.iterations; index += 1) {
        try {
          const head = await store.readHead(request.namespace);
          const result = await store.compareAndSwap({
            namespace: request.namespace,
            key: `w${request.workerIndex}-i${index}`,
            expectedHead: head.head,
            body: { worker: request.workerIndex, index }
          });
          if (result.status === "appended") appended += 1;
          else if (result.status === "existing") existing += 1;
          else conflict += 1;
        } catch (error) {
          if (error instanceof DurableSubstrateError) {
            if (error.code === "CAPACITY_EXHAUSTED") capacityRefusals += 1;
            else if (error.code === "STORE_UNAVAILABLE") unavailable += 1;
            else errors.push(error.message);
          } else {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      }
      return {
        pid: process.pid,
        appended,
        existing,
        conflict,
        capacityRefusals,
        unavailable,
        errors
      };
    }

    // All remaining scenarios race a single contended write.
    try {
      const body =
        request.scenario === "race-append-conflicting"
          ? { worker: request.workerIndex }
          : { shared: "body" };

      const expectedHead: Digest | null = null;
      const result =
        request.scenario === "race-cas-same-head"
          ? await store.compareAndSwap({
              namespace: request.namespace,
              key: `w${request.workerIndex}`,
              expectedHead,
              body
            })
          : await store.appendOnce({
              namespace: request.namespace,
              key: request.key,
              body
            });

      if (result.status === "appended") appended += 1;
      else if (result.status === "existing") existing += 1;
      else conflict += 1;
    } catch (error) {
      if (error instanceof DurableSubstrateError) {
        if (error.code === "CAPACITY_EXHAUSTED") capacityRefusals += 1;
        else if (error.code === "STORE_UNAVAILABLE") unavailable += 1;
        else errors.push(error.message);
      } else {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    store.close();
  }

  return {
    pid: process.pid,
    appended,
    existing,
    conflict,
    capacityRefusals,
    unavailable,
    errors
  };
}

const encoded = process.argv[2];
if (encoded !== undefined) {
  const request = JSON.parse(encoded) as WorkerRequest;
  run(request)
    .then((reply) => {
      // `process.send` is asynchronous. Exiting before it flushes drops the
      // reply and makes the parent report a phantom atomicity failure.
      if (process.send === undefined) process.exit(0);
      else process.send(reply, () => process.exit(0));
    })
    .catch((error: unknown) => {
      process.send?.({
        pid: process.pid,
        appended: 0,
        existing: 0,
        conflict: 0,
        capacityRefusals: 0,
        unavailable: 0,
        errors: [error instanceof Error ? error.message : String(error)]
      } satisfies WorkerReply, () => process.exit(1));
    });
}
