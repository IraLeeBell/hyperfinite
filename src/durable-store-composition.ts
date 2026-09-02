/**
 * Closed composition root for the fifteen nonproduction durable store adapters.
 *
 * The deployment topology is validated before any file is opened. Each of ADR
 * 0014's four store identities is opened exactly once, and every port receives
 * only the substrate fixed for it by the normative mapping. The composition is
 * mechanism, never authority: all clocks, signers, provider observations,
 * genesis values, paths, bounds, and runtime compatibility inputs are injected.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  resolve
} from "node:path";

import { canonicalJson, digest } from "./canonical.js";
import type {
  DemoActivationClaimStore,
  DemoEvidenceSigner,
  DemoEvidenceVerifier
} from "./demo-activation.js";
import type { StageAgentSelectionGrantStore } from "./demo-agent-selection.js";
import type { DemoDispatchStore } from "./demo-dispatcher.js";
import type {
  DemoKernelStateStore,
  DemoRecoveryBudgetStore,
  DemoRunStateStore,
  DemoStageReceiptStore
} from "./demo-runtime.js";
import type { DemoBudgetState } from "./demo-runtime-state.js";
import type {
  DemoBudgetLedger,
  DemoProviderUsageLedger,
  DemoRunFenceStore
} from "./demo-scheduler.js";
import type { DemoRunState, DemoSignature } from "./demo-types.js";
import {
  DURABLE_STORE_IDS,
  DeploymentTopologyValidationError,
  type DeploymentTopologyPlan,
  type DurableStoreId,
  validateDeploymentTopologyPlan
} from "./deployment-topology.js";
import type {
  DomainEvidenceSigner,
  DomainOperationGrantStore
} from "./domain-packs.js";
import {
  createDurableDemoBudgetLedger,
  createDurableDemoRunFenceStore
} from "./durable-demo-scheduler-stores.js";
import {
  createDurableDemoActivationClaimStore,
  createDurableDemoDispatchStore,
  createDurableDemoKernelStateStore,
  createDurableDemoProviderUsageLedger,
  createDurableDemoRecoveryBudgetStore,
  createDurableDemoRunStateStore,
  createDurableDemoStageReceiptStore,
  createDurableStageAgentSelectionGrantStore,
  type DurableDemoClock,
  type DurableDemoProviderUsageLedgerOptions
} from "./durable-demo-stores.js";
import {
  openDurableDomainOperationGrantStore,
  type DurableDomainClock
} from "./durable-domain-stores.js";
import {
  openDurableEngineeringClosureCheckpointStore,
  openDurableEngineeringCostLedger,
  openDurableEngineeringEvidenceStore,
  openDurableEngineeringProviderEvidence,
  openDurableEngineeringProviderUsageLedger,
  type DurableProviderUsageObserver
} from "./durable-engineering-stores.js";
import {
  bindDurableStores,
  openBoundDurableStore,
  type DurableStoreBinding
} from "./durable-store-binding.js";
import type {
  DurableBackupManifest,
  DurableSubstrate
} from "./durable-substrate.js";
import type {
  EngineeringClosureCheckpointStore,
  EngineeringCostLedger,
  EngineeringEvidenceStore,
  EngineeringProviderUsageLedger,
  EvidenceSigner
} from "./engineering-slice.js";
import type { Digest, KernelSnapshot } from "./types.js";
import { assertDocument, isCanonicalUtcDateTime } from "./validation.js";

export const DURABLE_ADAPTER_STORE_MAPPING = Object.freeze([
  {
    port: "DemoActivationClaimStore",
    storeId: "operation-grant-store",
    primitive: "appendOnce"
  },
  {
    port: "StageAgentSelectionGrantStore",
    storeId: "operation-grant-store",
    primitive: "appendOnce"
  },
  {
    port: "DomainOperationGrantStore",
    storeId: "operation-grant-store",
    primitive: "appendOnce"
  },
  {
    port: "DemoDispatchStore",
    storeId: "receipt-journal",
    primitive: "appendOnce"
  },
  {
    port: "DemoStageReceiptStore",
    storeId: "receipt-journal",
    primitive: "appendOnce"
  },
  {
    port: "DemoProviderUsageLedger",
    storeId: "receipt-journal",
    primitive: "appendOnce"
  },
  {
    port: "EngineeringProviderUsageLedger",
    storeId: "receipt-journal",
    primitive: "appendOnce"
  },
  {
    port: "DemoKernelStateStore",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "DemoRunStateStore",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "DemoRunFenceStore",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "DemoBudgetLedger",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "DemoRecoveryBudgetStore",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "EngineeringCostLedger",
    storeId: "runtime-state-store",
    primitive: "compareAndSwap"
  },
  {
    port: "EngineeringEvidenceStore",
    storeId: "evidence-store",
    primitive: "appendOnce"
  },
  {
    port: "EngineeringClosureCheckpointStore",
    storeId: "evidence-store",
    primitive: "appendOnce"
  }
] as const);
for (const entry of DURABLE_ADAPTER_STORE_MAPPING) Object.freeze(entry);

export type DurableAdapterPort =
  (typeof DURABLE_ADAPTER_STORE_MAPPING)[number]["port"];

export interface DurableStoreCompositionInput {
  readonly plan: DeploymentTopologyPlan;
  readonly storePaths: Readonly<Record<DurableStoreId, string>>;
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
  readonly demo: {
    readonly signer: DemoEvidenceSigner;
    readonly verifier: DemoEvidenceVerifier;
    readonly clock: DurableDemoClock;
    readonly genesisKernelSnapshot: KernelSnapshot;
    readonly genesisRunState: DemoRunState;
    readonly genesisRecoveryBudget: DemoBudgetState;
    readonly genesisBudget: DemoBudgetState;
    readonly dispatch: {
      readonly repositoryId: number;
      readonly workItemNodeId: string;
      readonly authorityEpoch: number;
      readonly generation: number;
    };
    readonly resolveProviderUsage: DurableDemoProviderUsageLedgerOptions["resolveUsage"];
  };
  readonly domain: {
    readonly clock: DurableDomainClock;
    readonly signer: DomainEvidenceSigner;
    readonly headValidityMs: number;
  };
  readonly engineering: {
    readonly signer: EvidenceSigner;
    readonly providerUsageObserver: DurableProviderUsageObserver;
    readonly totalBudgetCostUnits: number;
  };
  readonly backup: {
    readonly guard: DurableBackupQuiescenceGuard;
    readonly clock: DurableDemoClock;
    readonly signer: DemoEvidenceSigner;
    readonly verifier: DemoEvidenceVerifier;
  };
}

export interface DurableStoreAdapters {
  readonly demoActivationClaims: DemoActivationClaimStore;
  readonly stageAgentSelectionGrants: StageAgentSelectionGrantStore;
  readonly domainOperationGrants: DomainOperationGrantStore;
  readonly demoDispatch: DemoDispatchStore;
  readonly demoStageReceipts: DemoStageReceiptStore;
  readonly demoProviderUsage: DemoProviderUsageLedger;
  readonly engineeringProviderUsage: EngineeringProviderUsageLedger;
  readonly demoKernelState: DemoKernelStateStore;
  readonly demoRunState: DemoRunStateStore;
  readonly demoRunFences: DemoRunFenceStore;
  readonly demoBudget: DemoBudgetLedger;
  readonly demoRecoveryBudget: DemoRecoveryBudgetStore;
  readonly engineeringCost: EngineeringCostLedger;
  readonly engineeringEvidence: EngineeringEvidenceStore;
  readonly engineeringClosureCheckpoints: EngineeringClosureCheckpointStore;
}

export interface DurableStoreCompositionBackupManifest {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "DurableStoreCompositionBackupManifest";
  readonly schemaVersion: "1.0.0";
  readonly topologyDigest: Digest;
  readonly quiescence: DurableBackupQuiescenceEvidence;
  readonly stores: readonly {
    readonly storeId: DurableStoreId;
    readonly manifestDigest: Digest;
  }[];
  readonly backupSetId: Digest;
  readonly nonAuthoritative: true;
  readonly signature: DemoSignature;
}

export interface DurableBackupSet {
  readonly manifest: DurableStoreCompositionBackupManifest;
  readonly stores: Readonly<Record<DurableStoreId, DurableBackupManifest>>;
  readonly paths: Readonly<Record<DurableStoreId, string>>;
}

export interface DurableBackupQuiescenceEvidence {
  readonly schemaVersion: "1.0.0";
  readonly topologyDigest: Digest;
  readonly writerDisabled: true;
  readonly writerGeneration: number;
  readonly checkpointDigest: Digest;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly signature: DemoSignature;
}

export interface DurableBackupQuiescenceGuard {
  read(input: {
    readonly topologyDigest: Digest;
  }): Promise<DurableBackupQuiescenceEvidence>;
}

export type DurableStoreSubstrates = Readonly<
  Record<DurableStoreId, DurableSubstrate>
>;

export interface DurableStoreComposition {
  readonly adapters: DurableStoreAdapters;
  readonly stores: DurableStoreSubstrates;
  backup(destinationRoot: string): Promise<DurableBackupSet>;
  verifyRestoredBackup(manifests: DurableBackupSet): Promise<void>;
  close(): void;
}

export type DurableStoreCompositionRefusalCode =
  | "ADAPTER_MAPPING_INVALID"
  | "BACKUP_NOT_QUIESCENT"
  | "BACKUP_PATH_INVALID"
  | "RESTORE_MISMATCH";

export class DurableStoreCompositionError extends Error {
  constructor(
    readonly code: DurableStoreCompositionRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "DurableStoreCompositionError";
  }
}

function refuse(
  code: DurableStoreCompositionRefusalCode,
  message: string
): never {
  throw new DurableStoreCompositionError(code, message);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function stableDataSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function bindingFor(
  bindings: readonly DurableStoreBinding[],
  storeId: DurableStoreId
): DurableStoreBinding {
  const matches = bindings.filter((binding) => binding.storeId === storeId);
  if (matches.length !== 1 || matches[0] === undefined) {
    refuse(
      "ADAPTER_MAPPING_INVALID",
      `expected exactly one deployment binding for ${storeId}, observed ${String(matches.length)}`
    );
  }
  return matches[0];
}

function storeForPort(
  stores: DurableStoreSubstrates,
  port: DurableAdapterPort
): DurableSubstrate {
  const mappings = DURABLE_ADAPTER_STORE_MAPPING.filter(
    (mapping) => mapping.port === port
  );
  if (mappings.length !== 1 || mappings[0] === undefined) {
    refuse(
      "ADAPTER_MAPPING_INVALID",
      `expected exactly one durable store mapping for ${port}`
    );
  }
  return stores[mappings[0].storeId];
}

function closeStores(stores: readonly DurableSubstrate[]): void {
  const failures: unknown[] = [];
  for (const store of [...stores].reverse()) {
    try {
      store.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "one or more durable stores failed to close");
  }
}

function closeAfterFailure(
  stores: readonly DurableSubstrate[],
  originalError: unknown
): never {
  try {
    closeStores(stores);
  } catch (closeError) {
    throw new AggregateError(
      [originalError, closeError],
      "durable store composition failed and could not clean up every store"
    );
  }
  throw originalError;
}

function openStores(input: {
  readonly bindings: readonly DurableStoreBinding[];
  readonly busyTimeoutMs: number;
  readonly supportedNodeMajors: readonly number[];
}): DurableStoreSubstrates {
  const opened: DurableSubstrate[] = [];
  const open = (storeId: DurableStoreId): DurableSubstrate => {
    const store = openBoundDurableStore({
      binding: bindingFor(input.bindings, storeId),
      busyTimeoutMs: input.busyTimeoutMs,
      supportedNodeMajors: input.supportedNodeMajors
    });
    opened.push(store);
    return store;
  };

  try {
    return Object.freeze({
      "evidence-store": open("evidence-store"),
      "operation-grant-store": open("operation-grant-store"),
      "receipt-journal": open("receipt-journal"),
      "runtime-state-store": open("runtime-state-store")
    });
  } catch (openError) {
    closeAfterFailure(opened, openError);
  }
}

function validateLivePathKeys(
  livePaths: Readonly<Record<DurableStoreId, string>>
): void {
  if (
    livePaths === null ||
    typeof livePaths !== "object" ||
    Array.isArray(livePaths)
  ) {
    refuse(
      "ADAPTER_MAPPING_INVALID",
      "live store paths must be a closed store-id map"
    );
  }
  const suppliedIds = Object.keys(livePaths);
  const knownIds = new Set<string>(DURABLE_STORE_IDS);
  if (
    suppliedIds.length !== DURABLE_STORE_IDS.length ||
    DURABLE_STORE_IDS.some((storeId) => !suppliedIds.includes(storeId)) ||
    suppliedIds.some((storeId) => !knownIds.has(storeId))
  ) {
    refuse(
      "ADAPTER_MAPPING_INVALID",
      "live store paths must contain exactly the four deployment store ids"
    );
  }
}

interface PreparedBackupDirectory {
  readonly paths: Readonly<Record<DurableStoreId, string>>;
  assertCurrent(): void;
}

function assertPrivateDirectory(
  directory: string,
  label: string
): { readonly device: number; readonly inode: number } {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    refuse("BACKUP_PATH_INVALID", `${label} must be a non-symlink directory`);
  }
  if ((stat.mode & 0o022) !== 0) {
    refuse(
      "BACKUP_PATH_INVALID",
      `${label} must not be group- or other-writable`
    );
  }
  if (
    typeof process.getuid === "function" &&
    stat.uid !== process.getuid()
  ) {
    refuse("BACKUP_PATH_INVALID", `${label} must be owned by the current user`);
  }
  return { device: stat.dev, inode: stat.ino };
}

function prepareBackupDirectory(
  livePaths: Readonly<Record<DurableStoreId, string>>,
  destinationRoot: string
): PreparedBackupDirectory {
  if (
    typeof destinationRoot !== "string" ||
    !isAbsolute(destinationRoot) ||
    destinationRoot.includes("\0")
  ) {
    refuse(
      "BACKUP_PATH_INVALID",
      "backup root must be an absolute path without a NUL byte"
    );
  }
  const resolvedRoot = resolve(destinationRoot);
  if (resolvedRoot !== destinationRoot || existsSync(resolvedRoot)) {
    refuse(
      "BACKUP_PATH_INVALID",
      "backup root must be a new canonical path"
    );
  }
  const parent = dirname(resolvedRoot);
  if (!existsSync(parent)) {
    refuse(
      "BACKUP_PATH_INVALID",
      "backup root parent must be an existing directory"
    );
  }
  const canonicalParent = realpathSync(parent);
  const parentIdentity = assertPrivateDirectory(
    canonicalParent,
    "backup root parent"
  );
  const canonicalRoot = join(canonicalParent, basename(resolvedRoot));
  if (existsSync(canonicalRoot)) {
    refuse("BACKUP_PATH_INVALID", "backup root canonical target already exists");
  }
  const live = new Set<string>();
  for (const livePath of DURABLE_STORE_IDS.map((storeId) => livePaths[storeId])) {
    const canonicalLivePath = realpathSync(resolve(livePath));
    live.add(canonicalLivePath);
    live.add(`${canonicalLivePath}-wal`);
    live.add(`${canonicalLivePath}-shm`);
  }
  if (
    live.has(canonicalRoot) ||
    live.has(`${canonicalRoot}-wal`) ||
    live.has(`${canonicalRoot}-shm`)
  ) {
    refuse("BACKUP_PATH_INVALID", "backup root aliases a live durable store");
  }

  mkdirSync(canonicalRoot, { recursive: false, mode: 0o700 });
  const rootIdentity = assertPrivateDirectory(canonicalRoot, "backup root");
  if (
    realpathSync(canonicalRoot) !== canonicalRoot ||
    (lstatSync(canonicalRoot).mode & 0o777) !== 0o700
  ) {
    refuse(
      "BACKUP_PATH_INVALID",
      "backup root was not created with its exact canonical private identity"
    );
  }
  const paths = Object.freeze({
    "evidence-store": join(canonicalRoot, "evidence-store.db"),
    "operation-grant-store": join(canonicalRoot, "operation-grant-store.db"),
    "receipt-journal": join(canonicalRoot, "receipt-journal.db"),
    "runtime-state-store": join(canonicalRoot, "runtime-state-store.db")
  });
  return Object.freeze({
    paths,
    assertCurrent(): void {
      const currentParent = assertPrivateDirectory(
        canonicalParent,
        "backup root parent"
      );
      const currentRoot = assertPrivateDirectory(canonicalRoot, "backup root");
      if (
        currentParent.device !== parentIdentity.device ||
        currentParent.inode !== parentIdentity.inode ||
        currentRoot.device !== rootIdentity.device ||
        currentRoot.inode !== rootIdentity.inode ||
        realpathSync(canonicalParent) !== canonicalParent ||
        realpathSync(canonicalRoot) !== canonicalRoot
      ) {
        refuse(
          "BACKUP_PATH_INVALID",
          "backup directory identity changed during the backup operation"
        );
      }
    }
  });
}

async function verifyOneRestore(input: {
  readonly storeId: DurableStoreId;
  readonly store: DurableSubstrate;
  readonly manifest: DurableBackupManifest;
}): Promise<void> {
  const manifest = assertDocument("DurableStoreBackupManifest", input.manifest);
  if (
    manifest.storeId !== input.storeId ||
    manifest.storeId !== input.store.metadata.storeId ||
    manifest.storeNamespace !== input.store.metadata.storeNamespace ||
    manifest.formatVersion !== input.store.metadata.formatVersion
  ) {
    refuse(
      "RESTORE_MISMATCH",
      `restored ${input.storeId} identity does not match its backup manifest`
    );
  }

  const inventory = await input.store.inventory();
  if (
    canonicalJson(inventory.namespaces) !== canonicalJson(manifest.namespaces) ||
    inventory.entryCount !== manifest.entryCount
  ) {
    refuse(
      "RESTORE_MISMATCH",
      `restored ${input.storeId} namespace inventory does not match its backup manifest`
    );
  }
}

function backupSetIdentity(input: {
  readonly topologyDigest: Digest;
  readonly quiescenceDigest: Digest;
  readonly stores: DurableStoreCompositionBackupManifest["stores"];
}): Digest {
  return digest(input);
}

function quiescencePayload(
  evidence: DurableBackupQuiescenceEvidence
): Omit<DurableBackupQuiescenceEvidence, "signature"> {
  const { signature: _signature, ...payload } = evidence;
  return payload;
}

function validateQuiescenceEvidence(
  value: DurableBackupQuiescenceEvidence,
  topologyDigest: Digest,
  verifier: DemoEvidenceVerifier,
  evaluatedAt?: string
): DurableBackupQuiescenceEvidence {
  let evidence: DurableBackupQuiescenceEvidence;
  try {
    evidence = JSON.parse(canonicalJson(value)) as DurableBackupQuiescenceEvidence;
  } catch {
    refuse(
      "BACKUP_NOT_QUIESCENT",
      "backup quiescence evidence is not canonical data"
    );
  }
  const keys = Object.keys(evidence).sort();
  const observedAt = Date.parse(evidence.observedAt);
  const expiresAt = Date.parse(evidence.expiresAt);
  const evaluatedAtMs =
    evaluatedAt === undefined ? null : Date.parse(evaluatedAt);
  if (
    keys.join(",") !==
      [
        "checkpointDigest",
        "expiresAt",
        "observedAt",
        "schemaVersion",
        "signature",
        "topologyDigest",
        "writerDisabled",
        "writerGeneration"
      ].join(",") ||
    evidence.schemaVersion !== "1.0.0" ||
    evidence.topologyDigest !== topologyDigest ||
    evidence.writerDisabled !== true ||
    !Number.isSafeInteger(evidence.writerGeneration) ||
    evidence.writerGeneration < 0 ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.checkpointDigest) ||
    !isCanonicalUtcDateTime(evidence.observedAt) ||
    !isCanonicalUtcDateTime(evidence.expiresAt) ||
    observedAt >= expiresAt ||
    (evaluatedAt !== undefined &&
      (!isCanonicalUtcDateTime(evaluatedAt) ||
        evaluatedAtMs === null ||
        !Number.isSafeInteger(evaluatedAtMs) ||
        evaluatedAtMs < observedAt ||
        evaluatedAtMs >= expiresAt)) ||
    evidence.signature === null ||
    typeof evidence.signature !== "object" ||
    evidence.signature.algorithm !== "ed25519" ||
    typeof evidence.signature.keyId !== "string" ||
    evidence.signature.keyId.length === 0 ||
    typeof evidence.signature.value !== "string" ||
    evidence.signature.value.length === 0 ||
    !verifier.verify(quiescencePayload(evidence), evidence.signature)
  ) {
    refuse(
      "BACKUP_NOT_QUIESCENT",
      "backup quiescence evidence is invalid, changed, or unauthenticated"
    );
  }
  return Object.freeze(evidence);
}

function compositionManifestPayload(
  manifest: DurableStoreCompositionBackupManifest
): Omit<DurableStoreCompositionBackupManifest, "signature"> {
  const { signature: _signature, ...payload } = manifest;
  return payload;
}

function validateBackupSet(
  backup: DurableBackupSet,
  plan: DeploymentTopologyPlan,
  verifier: DemoEvidenceVerifier
): Readonly<Record<DurableStoreId, DurableBackupManifest>> {
  if (
    backup === null ||
    typeof backup !== "object" ||
    Array.isArray(backup) ||
    backup.stores === null ||
    typeof backup.stores !== "object" ||
    Array.isArray(backup.stores)
  ) {
    refuse("RESTORE_MISMATCH", "restore input is not one closed backup set");
  }
  const suppliedStoreIds = Object.keys(backup.stores);
  if (
    suppliedStoreIds.length !== DURABLE_STORE_IDS.length ||
    DURABLE_STORE_IDS.some((storeId) => !suppliedStoreIds.includes(storeId))
  ) {
    refuse(
      "RESTORE_MISMATCH",
      "restore input does not contain exactly the four durable stores"
    );
  }

  const manifest = assertDocument(
    "DurableStoreCompositionBackupManifest",
    backup.manifest
  );
  const topologyDigest = digest(plan);
  const quiescence = validateQuiescenceEvidence(
    manifest.quiescence,
    topologyDigest,
    verifier
  );
  const stores = DURABLE_STORE_IDS.map((storeId) => ({
    storeId,
    manifestDigest: digest(
      assertDocument("DurableStoreBackupManifest", backup.stores[storeId])
    )
  }));
  if (
    manifest.topologyDigest !== topologyDigest ||
    canonicalJson(manifest.stores) !== canonicalJson(stores) ||
    manifest.backupSetId !==
      backupSetIdentity({
        topologyDigest,
        quiescenceDigest: digest(quiescence),
        stores
      }) ||
    !verifier.verify(
      compositionManifestPayload(manifest),
      manifest.signature
    )
  ) {
    refuse(
      "RESTORE_MISMATCH",
      "restore input mixes stores, manifests, or deployment topologies"
    );
  }
  return backup.stores;
}

function composeAdapters(
  input: DurableStoreCompositionInput,
  stores: DurableStoreSubstrates
): DurableStoreAdapters {
  const providerEvidence = openDurableEngineeringProviderEvidence({
    substrate: storeForPort(stores, "EngineeringProviderUsageLedger")
  });

  return Object.freeze({
    demoActivationClaims: createDurableDemoActivationClaimStore({
      substrate: storeForPort(stores, "DemoActivationClaimStore"),
      signer: input.demo.signer,
      clock: input.demo.clock
    }),
    stageAgentSelectionGrants: createDurableStageAgentSelectionGrantStore({
      substrate: storeForPort(stores, "StageAgentSelectionGrantStore")
    }),
    domainOperationGrants: openDurableDomainOperationGrantStore({
      substrate: storeForPort(stores, "DomainOperationGrantStore"),
      storeId: "operation-grant-store",
      clock: input.domain.clock,
      signer: input.domain.signer,
      headValidityMs: input.domain.headValidityMs
    }),
    demoDispatch: createDurableDemoDispatchStore({
      substrate: storeForPort(stores, "DemoDispatchStore"),
      signer: input.demo.signer,
      clock: input.demo.clock,
      ...input.demo.dispatch
    }),
    demoStageReceipts: createDurableDemoStageReceiptStore({
      substrate: storeForPort(stores, "DemoStageReceiptStore")
    }),
    demoProviderUsage: createDurableDemoProviderUsageLedger({
      substrate: storeForPort(stores, "DemoProviderUsageLedger"),
      signer: input.demo.signer,
      clock: input.demo.clock,
      resolveUsage: input.demo.resolveProviderUsage
    }),
    engineeringProviderUsage: openDurableEngineeringProviderUsageLedger({
      substrate: storeForPort(stores, "EngineeringProviderUsageLedger"),
      signer: input.engineering.signer,
      observer: input.engineering.providerUsageObserver
    }),
    demoKernelState: createDurableDemoKernelStateStore({
      substrate: storeForPort(stores, "DemoKernelStateStore"),
      genesisSnapshot: input.demo.genesisKernelSnapshot
    }),
    demoRunState: createDurableDemoRunStateStore({
      substrate: storeForPort(stores, "DemoRunStateStore"),
      genesisRunState: input.demo.genesisRunState
    }),
    demoRunFences: createDurableDemoRunFenceStore(
      storeForPort(stores, "DemoRunFenceStore")
    ),
    demoBudget: createDurableDemoBudgetLedger({
      substrate: storeForPort(stores, "DemoBudgetLedger"),
      initialBudget: input.demo.genesisBudget,
      signer: input.demo.signer,
      verifier: input.demo.verifier
    }),
    demoRecoveryBudget: createDurableDemoRecoveryBudgetStore({
      substrate: storeForPort(stores, "DemoRecoveryBudgetStore"),
      genesisBudget: input.demo.genesisRecoveryBudget,
      signer: input.demo.signer
    }),
    engineeringCost: openDurableEngineeringCostLedger({
      substrate: storeForPort(stores, "EngineeringCostLedger"),
      signer: input.engineering.signer,
      providerEvidence,
      totalBudgetCostUnits: input.engineering.totalBudgetCostUnits
    }),
    engineeringEvidence: openDurableEngineeringEvidenceStore({
      substrate: storeForPort(stores, "EngineeringEvidenceStore")
    }),
    engineeringClosureCheckpoints:
      openDurableEngineeringClosureCheckpointStore({
        substrate: storeForPort(stores, "EngineeringClosureCheckpointStore")
      })
  });
}

/**
 * Opens all four topology-bound stores and composes all fifteen adapters.
 *
 * The return value deliberately stays outside `src/index.ts`; this is a local
 * pre-App reference integration, not supported package API or deployment.
 */
export function openDurableStoreComposition(
  input: DurableStoreCompositionInput
): DurableStoreComposition {
  const plan = assertDocument(
    "DeploymentTopologyPlan",
    stableDataSnapshot(input.plan)
  );
  const issues = validateDeploymentTopologyPlan(plan);
  if (issues.length > 0) {
    throw new DeploymentTopologyValidationError(issues);
  }

  const storePaths = stableDataSnapshot(input.storePaths);
  validateLivePathKeys(storePaths);
  const stableInput: DurableStoreCompositionInput = Object.freeze({
    ...input,
    plan,
    storePaths,
    demo: Object.freeze({
      ...input.demo,
      genesisKernelSnapshot: stableDataSnapshot(
        input.demo.genesisKernelSnapshot
      ),
      genesisRunState: stableDataSnapshot(input.demo.genesisRunState),
      genesisRecoveryBudget: stableDataSnapshot(
        input.demo.genesisRecoveryBudget
      ),
      genesisBudget: stableDataSnapshot(input.demo.genesisBudget),
      dispatch: stableDataSnapshot(input.demo.dispatch)
    }),
    domain: Object.freeze({ ...input.domain }),
    engineering: Object.freeze({ ...input.engineering }),
    backup: Object.freeze({ ...input.backup })
  });
  const bindings = bindDurableStores({
    plan,
    storePaths
  });
  const stores = openStores({
    bindings,
    busyTimeoutMs: input.busyTimeoutMs,
    supportedNodeMajors: input.supportedNodeMajors
  });
  let adapters: DurableStoreAdapters;
  try {
    adapters = composeAdapters(stableInput, stores);
  } catch (compositionError) {
    closeAfterFailure(Object.values(stores), compositionError);
  }

  const openStoresRemaining = new Set<DurableSubstrate>(Object.values(stores));
  return Object.freeze({
    adapters,
    stores,
    async backup(destinationRoot: string): Promise<DurableBackupSet> {
      const topologyDigest = digest(plan);
      const before = validateQuiescenceEvidence(
        await stableInput.backup.guard.read({ topologyDigest }),
        topologyDigest,
        stableInput.backup.verifier,
        stableInput.backup.clock.now()
      );
      const destination = prepareBackupDirectory(
        storePaths,
        destinationRoot
      );
      destination.assertCurrent();
      const evidence = await stores["evidence-store"].backup(
        destination.paths["evidence-store"]
      );
      destination.assertCurrent();
      const operationGrants = await stores["operation-grant-store"].backup(
        destination.paths["operation-grant-store"]
      );
      destination.assertCurrent();
      const receipts = await stores["receipt-journal"].backup(
        destination.paths["receipt-journal"]
      );
      destination.assertCurrent();
      const runtimeState = await stores["runtime-state-store"].backup(
        destination.paths["runtime-state-store"]
      );
      destination.assertCurrent();
      const after = validateQuiescenceEvidence(
        await stableInput.backup.guard.read({ topologyDigest }),
        topologyDigest,
        stableInput.backup.verifier,
        stableInput.backup.clock.now()
      );
      if (canonicalJson(after) !== canonicalJson(before)) {
        refuse(
          "BACKUP_NOT_QUIESCENT",
          "writer quiescence changed while the four-store backup was copied"
        );
      }
      const storeManifests = Object.freeze({
        "evidence-store": evidence,
        "operation-grant-store": operationGrants,
        "receipt-journal": receipts,
        "runtime-state-store": runtimeState
      });
      const manifestStores = Object.freeze(
        DURABLE_STORE_IDS.map((storeId) =>
          Object.freeze({
            storeId,
            manifestDigest: digest(storeManifests[storeId])
          })
        )
      );
      const unsigned = {
        apiVersion: "agentic-framework.github.com/v1alpha1" as const,
        kind: "DurableStoreCompositionBackupManifest" as const,
        schemaVersion: "1.0.0" as const,
        topologyDigest,
        quiescence: after,
        stores: manifestStores,
        backupSetId: backupSetIdentity({
          topologyDigest,
          quiescenceDigest: digest(after),
          stores: manifestStores
        }),
        nonAuthoritative: true as const
      };
      const manifest = assertDocument(
        "DurableStoreCompositionBackupManifest",
        {
          ...unsigned,
          signature: await stableInput.backup.signer.sign(unsigned)
        }
      );
      const backup = Object.freeze({
        manifest,
        stores: storeManifests,
        paths: destination.paths
      });
      validateBackupSet(backup, plan, stableInput.backup.verifier);
      return backup;
    },
    async verifyRestoredBackup(backup: DurableBackupSet): Promise<void> {
      const manifests = validateBackupSet(
        backup,
        plan,
        stableInput.backup.verifier
      );
      await verifyOneRestore({
        storeId: "evidence-store",
        store: stores["evidence-store"],
        manifest: manifests["evidence-store"]
      });
      await verifyOneRestore({
        storeId: "operation-grant-store",
        store: stores["operation-grant-store"],
        manifest: manifests["operation-grant-store"]
      });
      await verifyOneRestore({
        storeId: "receipt-journal",
        store: stores["receipt-journal"],
        manifest: manifests["receipt-journal"]
      });
      await verifyOneRestore({
        storeId: "runtime-state-store",
        store: stores["runtime-state-store"],
        manifest: manifests["runtime-state-store"]
      });
    },
    close(): void {
      if (openStoresRemaining.size === 0) return;
      const failures: unknown[] = [];
      for (const store of [...Object.values(stores)].reverse()) {
        if (!openStoresRemaining.has(store)) continue;
        try {
          store.close();
          openStoresRemaining.delete(store);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          "one or more durable stores failed to close"
        );
      }
    }
  });
}
