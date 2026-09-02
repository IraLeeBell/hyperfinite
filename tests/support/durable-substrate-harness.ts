/**
 * Shared harness for the durable substrate tests.
 *
 * Everything time- or signature-related is injected here rather than read from
 * the ambient runtime, so substrate behaviour stays deterministic and the tests
 * can prove the substrate itself never reaches for a clock, a key, or a
 * network. The signer follows the existing deterministic convention used by
 * `tests/demo-runtime.test.ts` so digests are stable across runs.
 *
 * `assertCallerHeadFidelity` is the reusable assertion that the later durable
 * adapter work applies per port.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { digest } from "../../src/canonical.js";
import type { Digest } from "../../src/types.js";
import {
  DURABLE_STORE_IDS,
  type DeploymentTopologyPlan,
  type DurableStoreId
} from "../../src/deployment-topology.js";

export const SUPPORTED_NODE_MAJORS: readonly number[] = [24, 26];
export const BUSY_TIMEOUT_MS = 5_000;

/** A fixed, injected clock. The substrate must never call `Date.now()`. */
export function fixedClock(start = "2026-08-30T12:00:00.000Z"): {
  now(): string;
  advance(ms: number): void;
} {
  let current = Date.parse(start);
  return {
    now: () => new Date(current).toISOString(),
    advance: (ms: number) => {
      current += ms;
    }
  };
}

export interface HarnessSignature {
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly value: string;
}

export function harnessSignature(
  payload: unknown,
  keyId = "durable:key-1"
): HarnessSignature {
  return {
    algorithm: "ed25519",
    keyId,
    value: Buffer.from(digest(payload), "utf8").toString("base64")
  };
}

export const harnessSigner = {
  sign: async (payload: unknown): Promise<HarnessSignature> => harnessSignature(payload)
};

export const harnessVerifier = {
  verify: (payload: unknown, candidate: HarnessSignature): boolean =>
    candidate.algorithm === "ed25519" &&
    candidate.value === harnessSignature(payload, candidate.keyId).value
};

/** Creates an isolated temporary directory and returns a cleanup function. */
export function temporaryStoreRoot(label: string): {
  readonly root: string;
  pathFor(name: string): string;
  cleanup(): void;
} {
  const root = mkdtempSync(path.join(tmpdir(), `hyperfinite-${label}-`));
  return {
    root,
    pathFor: (name: string) => path.join(root, name),
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
}

/**
 * Builds the four synthetic store paths keyed by the closed `DurableStoreId`
 * set from the merged deployment topology contract.
 */
export function storePathsFor(
  root: { pathFor(name: string): string }
): Readonly<Record<DurableStoreId, string>> {
  const entries = DURABLE_STORE_IDS.map(
    (storeId) => [storeId, root.pathFor(`${storeId}.db`)] as const
  );
  return Object.freeze(Object.fromEntries(entries)) as Readonly<
    Record<DurableStoreId, string>
  >;
}

/**
 * The reusable head-fidelity assertion for the later adapter work.
 *
 * Each store port's caller in `src/` recomputes the receipt head from its own
 * payload shape and refuses when it differs — for example
 * `src/demo-activation.ts` recomputes
 * `digest({ storeId, sequence, previousHead, claim, status, persistedAt })`.
 * An adapter that invents its own head shape is therefore not a variant
 * implementation, it is a broken one. This asserts against the caller's
 * recomputation rather than against the adapter's own view of itself.
 */
export function assertCallerHeadFidelity(input: {
  readonly label: string;
  readonly callerRecomputedHead: Digest;
  readonly receiptHead: Digest;
}): void {
  assert.equal(
    input.receiptHead,
    input.callerRecomputedHead,
    `${input.label}: receipt head must equal the head the caller recomputes`
  );
}

/**
 * A minimal synthetic topology plan carrying only the durable-store portion the
 * binding consumes. Field shapes mirror the merged `DeploymentTopologyPlan`
 * (ADR 0013); unrelated sections are supplied as empty collections because
 * `bindDurableStores` reads only `durableStores`.
 */
export function syntheticStorePlan(
  overrides: {
    readonly namespaceFor?: (storeId: DurableStoreId) => string;
    readonly credentialFor?: (storeId: DurableStoreId) => string;
    readonly maxEntries?: number;
  } = {}
): DeploymentTopologyPlan {
  const namespaceFor =
    overrides.namespaceFor ?? ((storeId: DurableStoreId) => `namespace-${storeId}`);
  const credentialFor =
    overrides.credentialFor ?? ((storeId: DurableStoreId) => `credential-${storeId}`);
  const maxEntries = overrides.maxEntries ?? 512;

  const kindByStore: Readonly<Record<DurableStoreId, string>> = {
    "evidence-store": "conditional-evidence-store",
    "operation-grant-store": "operation-grant-claim-store",
    "receipt-journal": "append-only-receipt-journal",
    "runtime-state-store": "compare-and-swap-state-store"
  };

  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "DeploymentTopologyPlan",
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-30T12:00:00.000Z",
    services: [],
    durableStores: DURABLE_STORE_IDS.map((storeId) => ({
      storeId,
      kind: kindByStore[storeId],
      identity: {
        namespace: namespaceFor(storeId),
        credentialId: credentialFor(storeId)
      },
      atomicGuarantees: {
        casSupported: true,
        idempotentWrites: true,
        replayRefusal: true,
        restartContinuity: true,
        boundedJournal: { maxEntries, enforced: true }
      },
      isolation: { dedicatedCredential: true, sharedWithModelRunner: false }
    })),
    budgets: [],
    monitoring: [],
    retention: [],
    protections: [],
    nonAuthoritative: true
  } as unknown as DeploymentTopologyPlan;
}
