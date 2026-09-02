/**
 * Binds a durable substrate to the merged pre-App deployment contract.
 *
 * The store identity, backend namespace, credential identity, atomic
 * guarantees, and journal bound all come from the `DeploymentDurableStore`
 * entries of a validated `DeploymentTopologyPlan` (ADR 0013). This
 * module deliberately defines no descriptor of its own: a second, parallel
 * store-identity contract would widen ADR 0013's closed four-store set
 * and would drift from it.
 *
 * What this module adds is only the local implementation detail ADR 0013 does not
 * carry — which filesystem path a sandbox substrate opens — and the refusals
 * that keep that binding honest.
 *
 * Nonproduction. No GitHub App credential, no network, no environment read, and
 * no default path. `identity.credentialId` is an opaque logical name from the
 * plan, never a secret value; this module never resolves it to a credential.
 */

import { isAbsolute } from "node:path";

import {
  DURABLE_STORE_IDS,
  type DeploymentDurableStore,
  type DeploymentTopologyPlan,
  type DurableStoreId
} from "./deployment-topology.js";
import { findDuplicateKeys } from "./duplicate-keys.js";
import { refuse, type DurableSubstrate } from "./durable-substrate.js";
import {
  openDurableSqliteSubstrate,
  type DurableSqliteOpenOptions
} from "./durable-sqlite-substrate.js";

export interface DurableStoreBinding {
  readonly storeId: DurableStoreId;
  readonly namespace: string;
  readonly credentialId: string;
  readonly maxEntries: number;
  readonly path: string;
}

export interface DurableStoreBindingInput {
  /** A plan already accepted by `validateDeploymentTopologyPlan`. */
  readonly plan: DeploymentTopologyPlan;
  /** Exact absolute path per store. All four stores must be supplied. */
  readonly storePaths: Readonly<Record<DurableStoreId, string>>;
}

/**
 * Derives the four local store bindings from a validated topology plan.
 *
 * Fails closed on an omitted, duplicated, or unknown store, on a shared backend
 * namespace or credential, on a guarantee the substrate cannot honour, and on a
 * path that is missing, relative, or reused between two stores. Two stores
 * sharing one file would silently collapse the independence the plan asserts.
 */
export function bindDurableStores(
  input: DurableStoreBindingInput
): readonly DurableStoreBinding[] {
  const stores = input.plan.durableStores;

  const duplicateIds = findDuplicateKeys(stores, (store) => store.storeId);
  if (duplicateIds.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `deployment plan repeats durable store id(s): ${duplicateIds.join(", ")}`
    );
  }
  const present = new Set(stores.map((store) => store.storeId));
  const missing = DURABLE_STORE_IDS.filter((id) => !present.has(id));
  if (missing.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `deployment plan omits durable store(s): ${missing.join(", ")}`
    );
  }
  const extra = stores
    .map((store) => store.storeId)
    .filter((id) => !DURABLE_STORE_IDS.includes(id));
  if (extra.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `deployment plan adds unknown durable store(s): ${extra.join(", ")}`
    );
  }

  const duplicateNamespaces = findDuplicateKeys(
    stores,
    (store) => store.identity.namespace
  );
  if (duplicateNamespaces.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable stores share backend namespace(s): ${duplicateNamespaces.join(", ")}`
    );
  }
  const duplicateCredentials = findDuplicateKeys(
    stores,
    (store) => store.identity.credentialId
  );
  if (duplicateCredentials.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable stores share credential id(s): ${duplicateCredentials.join(", ")}`
    );
  }

  const bindings = stores.map((store) => bindOne(store, input.storePaths));

  const duplicatePaths = findDuplicateKeys(bindings, (binding) => binding.path);
  if (duplicatePaths.length > 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable stores share filesystem path(s): ${duplicatePaths.join(", ")}`
    );
  }
  return Object.freeze(bindings);
}

function bindOne(
  store: DeploymentDurableStore,
  storePaths: Readonly<Record<DurableStoreId, string>>
): DurableStoreBinding {
  const guarantees = store.atomicGuarantees;
  // The substrate provides exactly these four guarantees. A plan that declares
  // a store without one of them is describing a store this substrate is not,
  // so binding refuses rather than silently under-delivering.
  if (
    guarantees.casSupported !== true ||
    guarantees.idempotentWrites !== true ||
    guarantees.replayRefusal !== true ||
    guarantees.restartContinuity !== true ||
    guarantees.boundedJournal.enforced !== true
  ) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable store ${store.storeId} does not require the guarantees this substrate provides`
    );
  }
  if (store.isolation.sharedWithModelRunner !== false) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable store ${store.storeId} is shared with a model runner`
    );
  }
  if (store.isolation.dedicatedCredential !== true) {
    refuse(
      "STORE_BINDING_INVALID",
      `durable store ${store.storeId} does not hold a dedicated credential`
    );
  }

  const path = storePaths[store.storeId];
  if (typeof path !== "string" || path.length === 0) {
    refuse(
      "STORE_BINDING_INVALID",
      `no filesystem path supplied for durable store ${store.storeId}`
    );
  }
  if (!isAbsolute(path)) {
    refuse(
      "STORE_PATH_INVALID",
      `durable store ${store.storeId} path must be absolute`
    );
  }

  return Object.freeze({
    storeId: store.storeId,
    namespace: store.identity.namespace,
    credentialId: store.identity.credentialId,
    maxEntries: guarantees.boundedJournal.maxEntries,
    path
  });
}

export interface OpenBoundDurableStoreInput {
  readonly binding: DurableStoreBinding;
  readonly busyTimeoutMs: DurableSqliteOpenOptions["busyTimeoutMs"];
  readonly supportedNodeMajors: DurableSqliteOpenOptions["supportedNodeMajors"];
}

/**
 * Opens the substrate for one bound store.
 *
 * The plan-derived store id, backend namespace, and journal bound are all
 * passed through and are recorded durably on first creation, then verified on
 * every later open. That is what keeps the binding authoritative: the same file
 * cannot be reopened under a different identity or a wider bound.
 */
export function openBoundDurableStore(
  input: OpenBoundDurableStoreInput
): DurableSubstrate {
  return openDurableSqliteSubstrate({
    path: input.binding.path,
    storeId: input.binding.storeId,
    storeNamespace: input.binding.namespace,
    maxEntries: input.binding.maxEntries,
    busyTimeoutMs: input.busyTimeoutMs,
    supportedNodeMajors: input.supportedNodeMajors
  });
}
