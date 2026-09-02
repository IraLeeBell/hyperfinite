import { canonicalJson, digest } from "./canonical.js";
import type {
  InstallationAuthorization,
  InstallationBackupEvidence,
  InstallationConfig,
  InstallationLiveValidation,
  InstallationPlan,
  InstallationReceipt,
  InstallationState,
  MigrationManifest,
  PackageMigrationStep,
  PackagingDocument,
  ReleaseFile,
  ReleaseManifest
} from "./packaging-types.js";
import type { Digest } from "./types.js";
import { assertReleasePath } from "./release-path.js";
import {
  assertDocument,
  isCanonicalUtcDateTime
} from "./validation.js";

const VERSION_PATTERN =
  /^(?=.{1,32}$)(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const MAX_INSTALLATION_RECEIPTS = 512;

function targetIdentityDigest(
  target: InstallationPlan["target"]
): Digest {
  const { expectedHeadSha: _expectedHeadSha, ...identity } = target;
  return digest(identity);
}

function installationIdempotencyKey(input: {
  readonly operation: InstallationPlan["operation"];
  readonly releaseManifestDigest: Digest;
  readonly migrationManifestDigest: Digest;
  readonly releaseSource: InstallationPlan["releaseSource"];
  readonly targetBindingDigest: Digest;
  readonly configurationDigest: Digest;
  readonly requiredPreconditions: InstallationPlan["requiredPreconditions"];
  readonly migrationSteps: InstallationPlan["migrationSteps"];
  readonly expectedStateDigest: Digest;
  readonly expectedResultStateDigest: Digest;
  readonly expectedResultHeadSha: string;
  readonly actions: InstallationPlan["actions"];
  readonly retainedEvidencePaths: InstallationPlan["retainedEvidencePaths"];
  readonly nextJournalSequence: number;
}): Digest {
  return digest(input);
}

function assertPackagingDocument<T extends PackagingDocument>(
  value: unknown,
  kind: T["kind"]
): T {
  const snapshot = structuredClone(value);
  const document = assertDocument("PackagingDocument", snapshot);
  if (document.kind !== kind) {
    throw new TypeError(`expected ${kind}, received ${document.kind}`);
  }
  return document as T;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => BigInt(part));
  const rightParts = right.split(".").map((part) => BigInt(part));
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index] ?? 0n;
    const rightPart = rightParts[index] ?? 0n;
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

function assertCanonicalPath(value: string, subject: string): void {
  if (
    value.length < 1 ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.normalize("NFC") !== value
  ) {
    throw new TypeError(`${subject} is not a canonical relative path`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        segment === ".git"
    )
  ) {
    throw new TypeError(`${subject} contains a denied path segment`);
  }
}

function assertReleaseFilePath(value: string, subject: string): void {
  assertReleasePath(value, subject);
}

function assertUniqueSortedFiles(files: readonly ReleaseFile[]): void {
  let previous = "";
  for (const file of files) {
    assertReleaseFilePath(file.path, `release file ${file.path}`);
    if (file.path <= previous) {
      throw new TypeError("release files must be unique and sorted by path");
    }
    previous = file.path;
  }
}

export function migrationStepChecksum(
  step: Omit<PackageMigrationStep, "checksum">
): Digest {
  return digest(step);
}

export function validateMigrationManifest(
  value: unknown
): MigrationManifest {
  const manifest = assertPackagingDocument<MigrationManifest>(
    value,
    "MigrationManifest"
  );
  const ids = new Set<string>();
  const sources = new Set<string>();
  const targets = new Set<string>();
  for (const step of manifest.steps) {
    if (ids.has(step.id) || sources.has(step.from) || targets.has(step.to)) {
      throw new TypeError(
        "migration IDs, source versions, and target versions must be unique"
      );
    }
    ids.add(step.id);
    sources.add(step.from);
    targets.add(step.to);
    const { checksum: _checksum, ...unsigned } = step;
    if (migrationStepChecksum(unsigned) !== step.checksum) {
      throw new TypeError(`migration ${step.id} checksum mismatch`);
    }
    if (
      !VERSION_PATTERN.test(step.from) ||
      !VERSION_PATTERN.test(step.to) ||
      compareVersions(step.from, step.to) >= 0
    ) {
      throw new TypeError(`migration ${step.id} must advance exact semantic versions`);
    }
    if (step.irreversible && step.rollback.supported) {
      throw new TypeError(`irreversible migration ${step.id} cannot support rollback`);
    }
  }
  if (!VERSION_PATTERN.test(manifest.currentVersion)) {
    throw new TypeError("migration currentVersion is invalid");
  }
  if (manifest.steps.length > 0) {
    const fromVersions = new Set(manifest.steps.map((step) => step.from));
    const toVersions = new Set(manifest.steps.map((step) => step.to));
    const starts = manifest.steps.filter((step) => !toVersions.has(step.from));
    const terminals = manifest.steps.filter((step) => !fromVersions.has(step.to));
    if (
      starts.length !== 1 ||
      terminals.length !== 1 ||
      terminals[0]?.to !== manifest.currentVersion
    ) {
      throw new TypeError(
        "migration steps must form one chain terminating at currentVersion"
      );
    }
    const bySource = new Map(manifest.steps.map((step) => [step.from, step]));
    const visited = new Set<string>();
    let version = starts[0]?.from;
    while (version !== undefined && version !== manifest.currentVersion) {
      const step = bySource.get(version);
      if (step === undefined || visited.has(step.id)) {
        throw new TypeError(
          "migration steps must form one chain terminating at currentVersion"
        );
      }
      visited.add(step.id);
      version = step.to;
    }
    if (version !== manifest.currentVersion || visited.size !== manifest.steps.length) {
      throw new TypeError(
        "migration steps must form one chain terminating at currentVersion"
      );
    }
  }
  return structuredClone(manifest);
}

function planMigrationPath(
  manifest: MigrationManifest,
  from: string | null,
  to: string | null
): {
  readonly path: readonly string[];
  readonly steps: readonly {
    readonly id: string;
    readonly checksum: Digest;
    readonly direction: "forward" | "rollback";
    readonly irreversible: boolean;
  }[];
  readonly irreversible: readonly string[];
} {
  if (from === to || from === null || to === null) {
    return { path: [], steps: [], irreversible: [] };
  }
  if (!VERSION_PATTERN.test(from) || !VERSION_PATTERN.test(to)) {
    throw new TypeError("installation versions must be canonical semantic versions");
  }

  const path: string[] = [];
  const steps: {
    id: string;
    checksum: Digest;
    direction: "forward" | "rollback";
    irreversible: boolean;
  }[] = [];
  const irreversible: string[] = [];
  const seen = new Set<string>();
  let current = from;
  const forward = compareVersions(from, to) < 0;
  while (current !== to) {
    if (seen.has(current)) throw new TypeError(`migration cycle at ${current}`);
    seen.add(current);
    const step = forward
      ? manifest.steps.find((candidate) => candidate.from === current)
      : manifest.steps.find((candidate) => candidate.to === current);
    if (step === undefined) {
      throw new TypeError(`no migration path from ${current} to ${to}`);
    }
    if (!forward && (!step.rollback.supported || step.irreversible)) {
      throw new TypeError(`migration ${step.id} cannot be rolled back`);
    }
    const next = forward ? step.to : step.from;
    if (
      (forward && compareVersions(next, to) > 0) ||
      (!forward && compareVersions(next, to) < 0)
    ) {
      throw new TypeError(`skipped migration path from ${from} to ${to}`);
    }
    path.push(forward ? step.id : `rollback:${step.id}`);
    steps.push({
      id: step.id,
      checksum: step.checksum,
      direction: forward ? "forward" : "rollback",
      irreversible: step.irreversible
    });
    if (step.irreversible) irreversible.push(step.id);
    current = next;
  }
  return { path, steps, irreversible };
}

export function receiptDigest(receipt: InstallationReceipt): Digest {
  return digest(receipt);
}

export function assertInstallationJournalBound(
  value: unknown
): number {
  if (!Array.isArray(value)) {
    throw new TypeError("installation journal must be an array");
  }
  const receiptCount = value.length;
  if (
    typeof receiptCount !== "number" ||
    !Number.isSafeInteger(receiptCount) ||
    receiptCount < 0
  ) {
    throw new TypeError("installation journal length is invalid");
  }
  if (receiptCount > MAX_INSTALLATION_RECEIPTS) {
    throw new TypeError("installation journal exceeds the closed receipt bound");
  }
  return receiptCount;
}

const installationJournalSnapshotMarker = Symbol(
  "installation-journal-snapshot"
);
const validatedJournalStructureMarker = Symbol(
  "validated-installation-journal-structure"
);

interface InstallationJournalSnapshot {
  readonly [installationJournalSnapshotMarker]: true;
  readonly receipts: readonly InstallationReceipt[];
}

interface ValidatedInstallationJournalSnapshot
  extends InstallationJournalSnapshot {
  readonly [validatedJournalStructureMarker]: true;
}

function snapshotInstallationJournal(
  receipts: readonly InstallationReceipt[]
): InstallationJournalSnapshot {
  const receiptCount = assertInstallationJournalBound(receipts);
  return snapshotBoundedInstallationJournal(receipts, receiptCount);
}

function snapshotBoundedInstallationJournal(
  receipts: readonly InstallationReceipt[],
  receiptCount: number
): InstallationJournalSnapshot {
  const stableReceipts: InstallationReceipt[] = [];
  for (let index = 0; index < receiptCount; index += 1) {
    stableReceipts.push(
      assertPackagingDocument<InstallationReceipt>(
        receipts[index],
        "InstallationReceipt"
      )
    );
  }
  return {
    [installationJournalSnapshotMarker]: true,
    receipts: stableReceipts
  };
}

function validateJournalSnapshotStructure(
  snapshot: InstallationJournalSnapshot,
  expectedSequence: number,
  expectedHead: Digest | null
): ValidatedInstallationJournalSnapshot {
  const stableReceipts = snapshot.receipts;
  let previous: Digest | null = null;
  let sequence = 0;
  for (const receipt of stableReceipts) {
    sequence += 1;
    if (
      receipt.sequence !== sequence ||
      receipt.previousReceiptDigest !== previous
    ) {
      throw new TypeError("installation receipt chain is partial or reordered");
    }

    previous = receiptDigest(receipt);
  }
  if (sequence !== expectedSequence || previous !== expectedHead) {
    throw new TypeError("installation journal does not match the configured CAS head");
  }
  return {
    ...snapshot,
    [validatedJournalStructureMarker]: true
  };
}

export function validateInstallationJournalStructure(
  receipts: readonly InstallationReceipt[],
  expectedSequence: number,
  expectedHead: Digest | null
): readonly InstallationReceipt[] {
  return validateJournalSnapshotStructure(
    snapshotInstallationJournal(receipts),
    expectedSequence,
    expectedHead
  ).receipts;
}

export interface InstallationReceiptVerifier {
  verify(receipt: InstallationReceipt): boolean;
}

function authenticateInstallationJournalSnapshot(input: {
  readonly journal: ValidatedInstallationJournalSnapshot;
  readonly expectedTargetBindingDigest: Digest;
  readonly expectedStateDigest: Digest;
  readonly expectedObservedHeadSha: string;
  readonly verifier: InstallationReceiptVerifier;
}): readonly InstallationReceipt[] {
  const stableReceipts = input.journal.receipts;
  if (stableReceipts.length === 0) return stableReceipts;
  if (typeof input.verifier?.verify !== "function") {
    throw new TypeError(
      "non-empty installation journal requires a trusted receipt verifier"
    );
  }
  let previousResult: Digest | null = null;
  for (const receipt of stableReceipts) {
    const firstVerification = input.verifier.verify(structuredClone(receipt));
    const secondVerification = input.verifier.verify(structuredClone(receipt));
    if (
      firstVerification !== true ||
      secondVerification !== true ||
      receipt.targetBindingDigest !== input.expectedTargetBindingDigest ||
      (previousResult !== null &&
        receipt.expectedStateDigest !== previousResult)
    ) {
      throw new TypeError(
        "installation receipt chain signature, target, or state continuity is invalid"
      );
    }
    previousResult = receipt.resultStateDigest;
  }
  if (previousResult !== input.expectedStateDigest) {
    throw new TypeError(
      "installation journal terminal receipt differs from observed state"
    );
  }
  if (
    stableReceipts.at(-1)?.appliedHeadSha !== input.expectedObservedHeadSha
  ) {
    throw new TypeError(
      "installation journal terminal receipt head differs from observed state"
    );
  }
  return stableReceipts;
}

export function validateAuthenticatedInstallationJournal(input: {
  readonly receipts: readonly InstallationReceipt[];
  readonly expectedSequence: number;
  readonly expectedHead: Digest | null;
  readonly expectedTargetBindingDigest: Digest;
  readonly expectedStateDigest: Digest;
  readonly expectedObservedHeadSha: string;
  readonly verifier: InstallationReceiptVerifier;
}): readonly InstallationReceipt[] {
  const expectedSequence = input.expectedSequence;
  const expectedHead = input.expectedHead;
  const expectedTargetBindingDigest = input.expectedTargetBindingDigest;
  const expectedStateDigest = input.expectedStateDigest;
  const expectedObservedHeadSha = input.expectedObservedHeadSha;
  const verifier = input.verifier;
  const receipts = input.receipts;
  const journal = validateJournalSnapshotStructure(
    snapshotInstallationJournal(receipts),
    expectedSequence,
    expectedHead
  );
  return authenticateInstallationJournalSnapshot({
    journal,
    expectedTargetBindingDigest,
    expectedStateDigest,
    expectedObservedHeadSha,
    verifier
  });
}

function plannedFiles(
  operation: InstallationConfig["operation"],
  manifest: ReleaseManifest
): readonly ReleaseFile[] {
  return operation === "uninstall" ? [] : structuredClone(manifest.files);
}

function planActions(
  current: readonly ReleaseFile[],
  desired: readonly ReleaseFile[],
  operation: InstallationConfig["operation"]
): InstallationPlan["actions"] {
  const currentByPath = new Map(current.map((file) => [file.path, file]));
  const desiredByPath = new Map(desired.map((file) => [file.path, file]));
  const paths = [...new Set([...currentByPath.keys(), ...desiredByPath.keys()])].sort();
  const actions: InstallationPlan["actions"][number][] = [];
  for (const filePath of paths) {
    const before = currentByPath.get(filePath);
    const after = desiredByPath.get(filePath);
    if (
      before !== undefined &&
      after !== undefined &&
      before.digest === after.digest &&
      before.mode === after.mode &&
      before.size === after.size
    ) {
      continue;
    }
    if (after === undefined && before !== undefined) {
      actions.push({
        type: "remove-package-file",
        path: filePath,
        beforeDigest: before.digest,
        afterDigest: null,
        mode: before.mode,
        requiresHumanApproval: true
      });
      continue;
    }
    if (after === undefined) continue;
    actions.push({
      type:
        operation === "recover"
          ? "reconcile-package-file"
          : "write-package-file",
      path: filePath,
      beforeDigest: before?.digest ?? null,
      afterDigest: after.digest,
      mode: after.mode,
      requiresHumanApproval: true
    });
  }
  return actions;
}

function assertCanonicalInstallationActions(input: {
  readonly actions: InstallationPlan["actions"];
  readonly operation: InstallationPlan["operation"];
  readonly expectedHeadSha: string;
  readonly expectedResultHeadSha: string;
}): void {
  let previousPath: string | null = null;
  for (const action of input.actions) {
    assertReleaseFilePath(action.path, "installation action path");
    if (previousPath !== null && action.path <= previousPath) {
      throw new TypeError(
        "installation actions must be strictly sorted and unique by path"
      );
    }
    previousPath = action.path;
    if (
      (action.type === "remove-package-file" &&
        (action.beforeDigest === null || action.afterDigest !== null)) ||
      (action.type !== "remove-package-file" && action.afterDigest === null)
    ) {
      throw new TypeError("installation action digest semantics are invalid");
    }
    if (
      (input.operation === "recover" &&
        action.type === "write-package-file") ||
      (input.operation !== "recover" &&
        action.type === "reconcile-package-file")
    ) {
      throw new TypeError(
        "installation action type does not match the selected operation"
      );
    }
    if (
      input.operation === "uninstall" &&
      action.type !== "remove-package-file"
    ) {
      throw new TypeError("uninstall plans may contain only package-file removals");
    }
  }
  if (
    (input.actions.length > 0 &&
      input.expectedResultHeadSha === input.expectedHeadSha) ||
    (input.actions.length === 0 &&
      input.expectedResultHeadSha !== input.expectedHeadSha)
  ) {
    throw new TypeError(
      "installation result head does not match whether repository effects are planned"
    );
  }
}

function assertRetainedEvidenceIsCanonical(
  actions: InstallationPlan["actions"],
  retainedEvidencePaths: InstallationPlan["retainedEvidencePaths"]
): void {
  let previousPath: string | null = null;
  for (const evidencePath of retainedEvidencePaths) {
    assertCanonicalPath(evidencePath, "installation evidence path");
    if (previousPath !== null && evidencePath <= previousPath) {
      throw new TypeError(
        "installation evidence paths must be strictly sorted and unique"
      );
    }
    if (
      actions.some(
        (action) =>
          action.path === evidencePath ||
          action.path.startsWith(`${evidencePath}/`) ||
          evidencePath.startsWith(`${action.path}/`)
      )
    ) {
      throw new TypeError(
        "installation action cannot overlap retained evidence"
      );
    }
    previousPath = evidencePath;
  }
}

function expectedResultState(
  state: InstallationState,
  packageVersion: string | null,
  files: readonly ReleaseFile[],
  expectedResultHeadSha: string,
  evidencePath: string,
  additionalEvidencePaths: readonly string[]
): InstallationState {
  return {
    ...structuredClone(state),
    target: {
      ...structuredClone(state.target),
      expectedHeadSha: expectedResultHeadSha
    },
    status: "stable",
    packageVersion,
    files: structuredClone(files),
    journalSequence: state.journalSequence + 1,
    evidencePaths: [
      ...new Set([
        ...state.evidencePaths,
        ...additionalEvidencePaths,
        evidencePath
      ])
    ].sort()
  };
}

export function planInstallation(input: {
  readonly config: unknown;
  readonly releaseManifest: unknown;
  readonly migrationManifest: unknown;
  readonly currentState: unknown;
  readonly backupEvidence: unknown;
  readonly recoveryBaseState?: unknown;
  readonly receipts: readonly InstallationReceipt[];
  readonly receiptVerifier?: InstallationReceiptVerifier;
}): {
  readonly plan: InstallationPlan;
  readonly expectedResultState: InstallationState;
} {
  const config = assertPackagingDocument<InstallationConfig>(
    input.config,
    "InstallationConfig"
  );
  const manifest = assertPackagingDocument<ReleaseManifest>(
    input.releaseManifest,
    "ReleaseManifest"
  );
  const migrations = validateMigrationManifest(input.migrationManifest);
  const state = assertPackagingDocument<InstallationState>(
    input.currentState,
    "InstallationState"
  );
  const backup = assertPackagingDocument<InstallationBackupEvidence>(
    input.backupEvidence,
    "InstallationBackupEvidence"
  );
  if (config.expectedJournalSequence >= MAX_INSTALLATION_RECEIPTS) {
    throw new TypeError(
      "installation journal is at capacity; external archival and an authenticated checkpoint protocol are required before further planning"
    );
  }
  const recoveryBase =
    input.recoveryBaseState === undefined
      ? null
      : assertPackagingDocument<InstallationState>(
          input.recoveryBaseState,
          "InstallationState"
        );
  const receiptVerifier = input.receiptVerifier;
  const rawReceipts = input.receipts;
  const receiptCount = assertInstallationJournalBound(rawReceipts);
  const receiptSnapshot = snapshotBoundedInstallationJournal(
    rawReceipts,
    receiptCount
  );
  assertUniqueSortedFiles(manifest.files);
  assertUniqueSortedFiles(state.files);
  for (const evidencePath of state.evidencePaths) {
    assertCanonicalPath(evidencePath, "installation state evidence path");
  }
  if (canonicalJson(config.target) !== canonicalJson(state.target)) {
    throw new TypeError("installation target binding differs from observed state");
  }
  if (
    !SHA_PATTERN.test(config.target.expectedHeadSha) ||
    !SHA_PATTERN.test(manifest.source.baseSha) ||
    !SHA_PATTERN.test(manifest.source.headSha)
  ) {
    throw new TypeError("release source or target head binding is malformed");
  }
  if (config.releaseManifestDigest !== digest(manifest)) {
    throw new TypeError("release manifest digest differs from explicit configuration");
  }
  const migrationManifestDigest = digest(migrations);
  if (config.migrationManifestDigest !== migrationManifestDigest) {
    throw new TypeError(
      "migration manifest digest differs from explicit configuration"
    );
  }
  if (config.expectedStateDigest !== digest(state)) {
    throw new TypeError("observed installation state drifted from configuration");
  }
  const targetBindingDigest = targetIdentityDigest(config.target);
  if (
    config.backupEvidenceDigest !== digest(backup) ||
    backup.targetBindingDigest !== targetBindingDigest ||
    backup.stateDigest !== config.expectedStateDigest ||
    backup.journalSequence !== config.expectedJournalSequence ||
    backup.journalHead !== config.expectedJournalHead
  ) {
    throw new TypeError("backup evidence does not bind the exact installation state");
  }
  if (config.operation === "recover") {
    if (
      recoveryBase === null ||
      config.recoveryBaseStateDigest !== digest(recoveryBase) ||
      recoveryBase.status !== "stable" ||
      recoveryBase.journalSequence !== state.journalSequence ||
      targetIdentityDigest(recoveryBase.target) !== targetBindingDigest
    ) {
      throw new TypeError(
        "recovery base state does not bind the last completed stable state"
      );
    }
    for (const evidencePath of recoveryBase.evidencePaths) {
      assertCanonicalPath(evidencePath, "recovery base evidence path");
    }
  } else if (
    recoveryBase !== null ||
    config.recoveryBaseStateDigest !== null
  ) {
    throw new TypeError(
      "recovery base state is allowed only for explicit recovery"
    );
  }
  const journalState = recoveryBase ?? state;
  const journal = validateJournalSnapshotStructure(
    receiptSnapshot,
    config.expectedJournalSequence,
    config.expectedJournalHead
  );
  const receipts =
    journal.receipts.length === 0
      ? journal.receipts
      : receiptVerifier === undefined
        ? (() => {
            throw new TypeError(
              "non-empty installation journal requires a trusted receipt verifier"
            );
          })()
        : authenticateInstallationJournalSnapshot({
            journal,
            expectedTargetBindingDigest: targetBindingDigest,
            expectedStateDigest: digest(journalState),
            expectedObservedHeadSha: journalState.target.expectedHeadSha,
            verifier: receiptVerifier
          });
  const terminalReceipt = receipts.at(-1);
  if (
    state.journalSequence !== config.expectedJournalSequence ||
    state.status === "ambiguous" ||
    (state.status === "partial" && config.operation !== "recover")
  ) {
    throw new TypeError("installation state requires explicit recovery");
  }
  if (
    (config.operation === "install" &&
      state.packageVersion !== null &&
      state.packageVersion !== "0.0.0") ||
    (config.operation === "upgrade" &&
      (state.packageVersion === null ||
        config.packageVersion === null ||
        compareVersions(state.packageVersion, config.packageVersion) >= 0)) ||
    (config.operation === "rollback" &&
      (state.packageVersion === null ||
        config.packageVersion === null ||
        compareVersions(state.packageVersion, config.packageVersion) <= 0)) ||
    (config.operation === "recover" && state.status !== "partial") ||
    (config.operation === "uninstall" && state.packageVersion === null)
  ) {
    throw new TypeError(
      "selected installation operation does not match the exact state transition"
    );
  }
  if (
    config.operation === "uninstall"
      ? config.packageVersion !== null
      : config.packageVersion !== manifest.packageVersion
  ) {
    throw new TypeError("configured package version differs from the selected operation");
  }
  const knownVersions = new Set([
    migrations.currentVersion,
    ...migrations.steps.flatMap((step) => [step.from, step.to])
  ]);
  if (
    state.packageVersion !== null &&
    !knownVersions.has(state.packageVersion)
  ) {
    throw new TypeError(
      "installed version is absent from the closed migration graph"
    );
  }
  if (!knownVersions.has(manifest.packageVersion)) {
    throw new TypeError("release version is absent from the closed migration graph");
  }
  if (
    config.operation === "uninstall" &&
    manifest.packageVersion !== state.packageVersion
  ) {
    throw new TypeError(
      "uninstall manifest does not match the installed package version"
    );
  }
  if (
    config.operation === "uninstall" &&
    canonicalJson(state.files) !== canonicalJson(manifest.files)
  ) {
    throw new TypeError(
      "uninstall inventory does not match the installed package manifest"
    );
  }
  if (
    config.operation !== "rollback" &&
    config.operation !== "uninstall" &&
    config.packageVersion !== migrations.currentVersion
  ) {
    throw new TypeError(
      "install, upgrade, and recovery must target migration currentVersion"
    );
  }
  if (config.apply.enabled !== (config.apply.humanChangeId !== null)) {
    throw new TypeError("apply enablement requires exactly one human change identifier");
  }

  const migrationSourceState = recoveryBase ?? state;
  const transition = planMigrationPath(
    migrations,
    migrationSourceState.packageVersion,
    config.packageVersion
  );
  const desiredFiles = plannedFiles(config.operation, manifest);
  const configurationDigest = digest(config);
  const releaseSource = {
    server: manifest.source.server,
    repository: manifest.source.repository,
    baseSha: manifest.source.baseSha,
    headSha: manifest.source.headSha
  } as const;
  const receiptChainEvidenceDigest = digest({
    sequence: config.expectedJournalSequence,
    head: config.expectedJournalHead,
    terminalStateDigest: terminalReceipt?.resultStateDigest ?? null
  });
  const requiredPreconditions = [
    {
      id: "backup-evidence-present" as const,
      evidenceDigest: config.backupEvidenceDigest
    },
    {
      id: "exact-source-version" as const,
      evidenceDigest: digest({
        packageVersion: migrationSourceState.packageVersion
      })
    },
    {
      id: "exact-target-head-current" as const,
      evidenceDigest: digest({
        targetBindingDigest,
        headSha: config.target.expectedHeadSha
      })
    },
    {
      id: "receipt-chain-valid" as const,
      evidenceDigest: receiptChainEvidenceDigest
    }
  ];
  const evidencePath =
    `evidence/installations/${configurationDigest.slice("sha256:".length)}.json`;
  const actions = planActions(state.files, desiredFiles, config.operation);
  assertCanonicalInstallationActions({
    actions,
    operation: config.operation,
    expectedHeadSha: config.target.expectedHeadSha,
    expectedResultHeadSha: config.expectedResultHeadSha
  });
  const resultState = expectedResultState(
    state,
    config.packageVersion,
    desiredFiles,
    config.expectedResultHeadSha,
    evidencePath,
    recoveryBase?.evidencePaths ?? []
  );
  const expectedResultStateDigest = digest(resultState);
  const retainedEvidencePaths = resultState.evidencePaths;
  assertRetainedEvidenceIsCanonical(actions, retainedEvidencePaths);
  const draftKey = installationIdempotencyKey({
    operation: config.operation,
    releaseManifestDigest: config.releaseManifestDigest,
    migrationManifestDigest,
    releaseSource,
    migrationSteps: transition.steps,
    targetBindingDigest,
    configurationDigest,
    requiredPreconditions,
    expectedStateDigest: config.expectedStateDigest,
    expectedResultStateDigest,
    expectedResultHeadSha: config.expectedResultHeadSha,
    actions,
    retainedEvidencePaths,
    nextJournalSequence: config.expectedJournalSequence + 1
  });
  const payload = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "InstallationPlan" as const,
    schemaVersion: "1.0.0" as const,
    mode: "plan" as const,
    operation: config.operation,
    packageName: "agentic-framework" as const,
    fromVersion: migrationSourceState.packageVersion,
    toVersion: config.packageVersion,
    releaseManifestDigest: config.releaseManifestDigest,
    releaseManifest: structuredClone(manifest),
    migrationManifestDigest,
    releaseSource,
    target: structuredClone(config.target),
    targetBindingDigest,
    configurationDigest,
    configuration: structuredClone(config),
    expectedStateDigest: config.expectedStateDigest,
    expectedState: structuredClone(state),
    recoveryBaseStateDigest: config.recoveryBaseStateDigest,
    recoveryBaseState:
      recoveryBase === null ? null : structuredClone(recoveryBase),
    migrationManifest: structuredClone(migrations),
    expectedResultStateDigest,
    expectedResultState: structuredClone(resultState),
    expectedResultHeadSha: config.expectedResultHeadSha,
    expectedJournalSequence: config.expectedJournalSequence,
    expectedJournalHead: config.expectedJournalHead,
    migrationPath: transition.path,
    migrationSteps: transition.steps,
    irreversibleSteps: transition.irreversible,
    requiredPreconditions,
    actions,
    retainedEvidencePaths,
    applyRequested: config.apply.enabled,
    humanChangeId: config.apply.humanChangeId,
    idempotencyKey: draftKey
  };
  const plan = assertPackagingDocument<InstallationPlan>(
    { ...payload, planDigest: digest(payload) },
    "InstallationPlan"
  );
  return { plan: structuredClone(plan), expectedResultState: resultState };
}

export interface TrustedInstallationValidationAdapter {
  readonly adapterId: string;
  now(): Promise<string>;
  observe(target: InstallationPlan["target"]): Promise<InstallationState>;
  verifyAuthorization(input: {
    readonly authorization: InstallationAuthorization;
    readonly plan: InstallationPlan;
  }): Promise<boolean>;
  /**
   * The adapter must atomically recheck authorization, target state/head, and
   * protected time while signing read-only validation evidence.
   */
  attestValidation(input: {
    readonly plan: InstallationPlan;
    readonly authorization: InstallationAuthorization;
    readonly observedState: InstallationState;
    readonly validatedAt: string;
  }): Promise<InstallationLiveValidation>;
  verifyValidation(
    validation: InstallationLiveValidation
  ): Promise<boolean>;
}

export interface TrustedInstallationAdapter
  extends TrustedInstallationValidationAdapter {
  findReceipt(idempotencyKey: Digest): Promise<InstallationReceipt | null>;
  verifyReceipt(receipt: InstallationReceipt): Promise<boolean>;
  /**
   * The adapter must atomically recheck its protected clock, authorization
   * expiry, expected state/head, and idempotency key with the effect.
   */
  apply(input: {
    readonly plan: InstallationPlan;
    readonly authorization: InstallationAuthorization;
    readonly expectedStateDigest: Digest;
    readonly expectedHeadSha: string;
    readonly idempotencyKey: Digest;
    readonly authorizationCheckedAt: string;
  }): Promise<InstallationReceipt>;
}

async function verifyAdapterReceipt(
  adapter: TrustedInstallationAdapter,
  receipt: InstallationReceipt
): Promise<boolean> {
  const first = await adapter.verifyReceipt(structuredClone(receipt));
  const second = await adapter.verifyReceipt(structuredClone(receipt));
  return first === true && second === true;
}

function assertValidInstallationPlan(value: unknown): InstallationPlan {
  const plan = assertPackagingDocument<InstallationPlan>(
    value,
    "InstallationPlan"
  );
  const { planDigest: _planDigest, ...unsignedPlan } = plan;
  if (
    digest(unsignedPlan) !== plan.planDigest ||
    targetIdentityDigest(plan.target) !== plan.targetBindingDigest ||
    installationIdempotencyKey({
      operation: plan.operation,
      releaseManifestDigest: plan.releaseManifestDigest,
      migrationManifestDigest: plan.migrationManifestDigest,
      releaseSource: plan.releaseSource,
      targetBindingDigest: plan.targetBindingDigest,
      configurationDigest: plan.configurationDigest,
      requiredPreconditions: plan.requiredPreconditions,
      migrationSteps: plan.migrationSteps,
      expectedStateDigest: plan.expectedStateDigest,
      expectedResultStateDigest: plan.expectedResultStateDigest,
      expectedResultHeadSha: plan.expectedResultHeadSha,
      actions: plan.actions,
      retainedEvidencePaths: plan.retainedEvidencePaths,
      nextJournalSequence: plan.expectedJournalSequence + 1
    }) !== plan.idempotencyKey
  ) {
    throw new TypeError("installation plan integrity mismatch");
  }
  const migrationManifest = validateMigrationManifest(plan.migrationManifest);
  const transition = planMigrationPath(
    migrationManifest,
    plan.fromVersion,
    plan.toVersion
  );
  assertUniqueSortedFiles(plan.releaseManifest.files);
  assertUniqueSortedFiles(plan.expectedState.files);
  assertUniqueSortedFiles(plan.expectedResultState.files);
  for (const evidencePath of plan.expectedState.evidencePaths) {
    assertCanonicalPath(evidencePath, "expected installation evidence path");
  }
  for (const evidencePath of plan.expectedResultState.evidencePaths) {
    assertCanonicalPath(evidencePath, "expected result evidence path");
  }
  if (plan.recoveryBaseState !== null) {
    assertUniqueSortedFiles(plan.recoveryBaseState.files);
    for (const evidencePath of plan.recoveryBaseState.evidencePaths) {
      assertCanonicalPath(evidencePath, "recovery base evidence path");
    }
  }
  const expectedReleaseSource = {
    server: plan.releaseManifest.source.server,
    repository: plan.releaseManifest.source.repository,
    baseSha: plan.releaseManifest.source.baseSha,
    headSha: plan.releaseManifest.source.headSha
  };
  const expectedFiles = plannedFiles(plan.operation, plan.releaseManifest);
  const expectedActions = planActions(
    plan.expectedState.files,
    expectedFiles,
    plan.operation
  );
  const expectedResultTarget = {
    ...plan.target,
    expectedHeadSha: plan.expectedResultHeadSha
  };
  const operationEvidencePath =
    `evidence/installations/${plan.configurationDigest.slice("sha256:".length)}.json`;
  const expectedRetainedEvidencePaths = [
    ...new Set([
      ...plan.expectedState.evidencePaths,
      ...(plan.recoveryBaseState?.evidencePaths ?? []),
      operationEvidencePath
    ])
  ].sort();
  const expectedPreconditions: InstallationPlan["requiredPreconditions"] = [
    {
      id: "backup-evidence-present",
      evidenceDigest: plan.configuration.backupEvidenceDigest
    },
    {
      id: "exact-source-version",
      evidenceDigest: digest({ packageVersion: plan.fromVersion })
    },
    {
      id: "exact-target-head-current",
      evidenceDigest: digest({
        targetBindingDigest: plan.targetBindingDigest,
        headSha: plan.target.expectedHeadSha
      })
    },
    {
      id: "receipt-chain-valid",
      evidenceDigest: digest({
        sequence: plan.expectedJournalSequence,
        head: plan.expectedJournalHead,
        terminalStateDigest:
          plan.expectedJournalSequence === 0
            ? null
            : plan.operation === "recover"
              ? plan.recoveryBaseStateDigest
              : plan.expectedStateDigest
      })
    }
  ];
  if (
    canonicalJson(plan.migrationPath) !== canonicalJson(transition.path) ||
    canonicalJson(plan.migrationSteps) !== canonicalJson(transition.steps) ||
    canonicalJson(plan.irreversibleSteps) !== canonicalJson(transition.irreversible) ||
    canonicalJson(plan.requiredPreconditions) !== canonicalJson(expectedPreconditions) ||
    digest(plan.releaseManifest) !== plan.releaseManifestDigest ||
    digest(migrationManifest) !== plan.migrationManifestDigest ||
    digest(plan.configuration) !== plan.configurationDigest ||
    plan.configuration.operation !== plan.operation ||
    plan.configuration.packageVersion !== plan.toVersion ||
    plan.configuration.releaseManifestDigest !== plan.releaseManifestDigest ||
    plan.configuration.migrationManifestDigest !== plan.migrationManifestDigest ||
    canonicalJson(plan.configuration.target) !== canonicalJson(plan.target) ||
    plan.configuration.expectedResultHeadSha !== plan.expectedResultHeadSha ||
    plan.configuration.expectedStateDigest !== plan.expectedStateDigest ||
    plan.configuration.recoveryBaseStateDigest !== plan.recoveryBaseStateDigest ||
    plan.configuration.expectedJournalSequence !== plan.expectedJournalSequence ||
    plan.configuration.expectedJournalHead !== plan.expectedJournalHead ||
    plan.configuration.apply.enabled !== plan.applyRequested ||
    plan.configuration.apply.humanChangeId !== plan.humanChangeId ||
    canonicalJson(plan.releaseSource) !== canonicalJson(expectedReleaseSource) ||
    digest(plan.expectedState) !== plan.expectedStateDigest ||
    digest(plan.expectedResultState) !== plan.expectedResultStateDigest ||
    canonicalJson(plan.expectedState.target) !== canonicalJson(plan.target) ||
    canonicalJson(plan.expectedResultState.target) !==
      canonicalJson(expectedResultTarget) ||
    plan.expectedState.journalSequence !== plan.expectedJournalSequence ||
    plan.expectedResultState.journalSequence !==
      plan.expectedJournalSequence + 1 ||
    plan.expectedResultState.status !== "stable" ||
    plan.expectedResultState.packageVersion !== plan.toVersion ||
    canonicalJson(plan.expectedResultState.files) !==
      canonicalJson(expectedFiles) ||
    canonicalJson(plan.actions) !== canonicalJson(expectedActions) ||
    canonicalJson(plan.retainedEvidencePaths) !==
      canonicalJson(expectedRetainedEvidencePaths) ||
    canonicalJson(plan.expectedResultState.evidencePaths) !==
      canonicalJson(expectedRetainedEvidencePaths) ||
    plan.expectedState.evidencePaths.some(
      (evidencePath) => !plan.retainedEvidencePaths.includes(evidencePath)
    ) ||
    (plan.operation === "recover"
      ? plan.expectedState.status !== "partial" ||
        plan.recoveryBaseState === null ||
        plan.recoveryBaseStateDigest === null ||
        digest(plan.recoveryBaseState) !== plan.recoveryBaseStateDigest ||
        plan.recoveryBaseState.status !== "stable" ||
        plan.recoveryBaseState.packageVersion !== plan.fromVersion ||
        plan.recoveryBaseState.journalSequence !==
          plan.expectedState.journalSequence ||
        targetIdentityDigest(plan.recoveryBaseState.target) !==
          plan.targetBindingDigest ||
        plan.recoveryBaseState.evidencePaths.some(
          (evidencePath) => !plan.retainedEvidencePaths.includes(evidencePath)
        )
      : plan.expectedState.status !== "stable" ||
        plan.expectedState.packageVersion !== plan.fromVersion ||
        plan.recoveryBaseState !== null ||
        plan.recoveryBaseStateDigest !== null) ||
    (plan.operation === "uninstall"
      ? plan.releaseManifest.packageVersion !== plan.fromVersion
      : plan.releaseManifest.packageVersion !== plan.toVersion) ||
    (plan.operation !== "rollback" &&
      plan.operation !== "uninstall" &&
      plan.toVersion !== migrationManifest.currentVersion) ||
    (plan.operation === "install" &&
      plan.fromVersion !== null &&
      plan.fromVersion !== "0.0.0") ||
    (plan.operation === "recover" &&
      plan.expectedState.status !== "partial") ||
    (plan.operation === "uninstall" && plan.fromVersion === null)
  ) {
    throw new TypeError(
      "installation plan migration, state, inventory, action, or precondition mismatch"
    );
  }
  if (plan.expectedJournalSequence >= MAX_INSTALLATION_RECEIPTS) {
    throw new TypeError("installation plan journal is at capacity");
  }
  if (
    plan.applyRequested !== (plan.humanChangeId !== null) ||
    (plan.operation === "uninstall"
      ? plan.toVersion !== null
      : plan.toVersion === null) ||
    (plan.operation === "upgrade" &&
      (plan.fromVersion === null ||
        plan.toVersion === null ||
        compareVersions(plan.fromVersion, plan.toVersion) >= 0)) ||
    (plan.operation === "rollback" &&
      (plan.fromVersion === null ||
        plan.toVersion === null ||
        compareVersions(plan.fromVersion, plan.toVersion) <= 0))
  ) {
    throw new TypeError("installation plan operation invariants are invalid");
  }
  assertCanonicalInstallationActions({
    actions: plan.actions,
    operation: plan.operation,
    expectedHeadSha: plan.target.expectedHeadSha,
    expectedResultHeadSha: plan.expectedResultHeadSha
  });
  assertRetainedEvidenceIsCanonical(plan.actions, plan.retainedEvidencePaths);
  return structuredClone(plan);
}

function assertLiveValidationForPlan(
  plan: InstallationPlan,
  authorization: InstallationAuthorization,
  observed: InstallationState,
  validatedAt: string,
  adapterId: string,
  value: unknown
): InstallationLiveValidation {
  const validation = assertPackagingDocument<InstallationLiveValidation>(
    value,
    "InstallationLiveValidation"
  );
  const observedStateDigest = digest(observed);
  if (
    validation.mode !== "live-read-only" ||
    validation.adapterId !== adapterId ||
    validation.planDigest !== plan.planDigest ||
    validation.authorizationDigest !== digest(authorization) ||
    validation.targetBindingDigest !== plan.targetBindingDigest ||
    validation.expectedStateDigest !== plan.expectedStateDigest ||
    validation.observedStateDigest !== observedStateDigest ||
    validation.expectedHeadSha !== plan.target.expectedHeadSha ||
    validation.observedHeadSha !== observed.target.expectedHeadSha ||
    validation.validatedAt !== validatedAt
  ) {
    throw new TypeError("live installation validation binding mismatch");
  }
  return validation;
}

export async function validateLiveInstallationPlan(input: {
  readonly plan: unknown;
  readonly authorization: unknown;
  readonly adapter: TrustedInstallationValidationAdapter;
}): Promise<InstallationLiveValidation> {
  const plan = assertValidInstallationPlan(input.plan);
  if (!plan.applyRequested) {
    throw new TypeError(
      "live validation requires the exact apply-enabled plan authorized by a human"
    );
  }
  const authorization = assertAuthorization(plan, input.authorization);
  assertAuthorizationCurrent(authorization, await input.adapter.now());
  const firstAuthorization = await input.adapter.verifyAuthorization({
    authorization: structuredClone(authorization),
    plan: structuredClone(plan)
  });
  const secondAuthorization = await input.adapter.verifyAuthorization({
    authorization: structuredClone(authorization),
    plan: structuredClone(plan)
  });
  if (firstAuthorization !== true || secondAuthorization !== true) {
    throw new TypeError("trusted installation adapter rejected human authorization");
  }
  const observed = assertPackagingDocument<InstallationState>(
    await input.adapter.observe(structuredClone(plan.target)),
    "InstallationState"
  );
  if (
    digest(observed) !== plan.expectedStateDigest ||
    targetIdentityDigest(observed.target) !== plan.targetBindingDigest ||
    observed.target.expectedHeadSha !== plan.target.expectedHeadSha
  ) {
    throw new TypeError("live installation validation observed stale target state");
  }
  const validatedAt = await input.adapter.now();
  assertAuthorizationCurrent(authorization, validatedAt);
  const validation = assertLiveValidationForPlan(
    plan,
    authorization,
    observed,
    validatedAt,
    input.adapter.adapterId,
    await input.adapter.attestValidation({
      plan: structuredClone(plan),
      authorization: structuredClone(authorization),
      observedState: structuredClone(observed),
      validatedAt
    })
  );
  const firstValidation = await input.adapter.verifyValidation(
    structuredClone(validation)
  );
  const secondValidation = await input.adapter.verifyValidation(
    structuredClone(validation)
  );
  if (firstValidation !== true || secondValidation !== true) {
    throw new TypeError(
      "trusted installation adapter rejected live validation signature"
    );
  }
  return structuredClone(validation);
}

function assertAuthorization(
  plan: InstallationPlan,
  value: unknown
): InstallationAuthorization {
  const authorization = assertPackagingDocument<InstallationAuthorization>(
    value,
    "InstallationAuthorization"
  );
  if (
    authorization.planDigest !== plan.planDigest ||
    authorization.configurationDigest !== plan.configurationDigest ||
    authorization.migrationManifestDigest !== plan.migrationManifestDigest ||
    authorization.releaseHeadSha !== plan.releaseSource.headSha ||
    authorization.targetBindingDigest !== plan.targetBindingDigest ||
    authorization.expectedHeadSha !== plan.target.expectedHeadSha ||
    authorization.expectedResultHeadSha !== plan.expectedResultHeadSha ||
    authorization.expectedStateDigest !== plan.expectedStateDigest ||
    authorization.idempotencyKey !== plan.idempotencyKey ||
    authorization.operation !== plan.operation ||
    authorization.humanChangeId !== plan.humanChangeId
  ) {
    throw new TypeError("installation authorization binding mismatch");
  }
  if (
    plan.actions.some((action) => action.type === "remove-package-file") &&
    !authorization.destructiveApproved
  ) {
    throw new TypeError("destructive package-file removal lacks explicit approval");
  }
  if (
    plan.irreversibleSteps.length > 0 &&
    !authorization.irreversibleApproved
  ) {
    throw new TypeError("irreversible migration lacks explicit approval");
  }
  return authorization;
}

function assertAuthorizationCurrent(
  authorization: InstallationAuthorization,
  now: string
): void {
  if (
    !isCanonicalUtcDateTime(now) ||
    Date.parse(authorization.approvedAt) > Date.parse(now) ||
    Date.parse(authorization.expiresAt) <= Date.parse(now)
  ) {
    throw new TypeError("installation authorization is not current");
  }
}

function assertReceiptForPlan(
  plan: InstallationPlan,
  value: unknown
): InstallationReceipt {
  const receipt = assertPackagingDocument<InstallationReceipt>(
    value,
    "InstallationReceipt"
  );
  if (
    receipt.sequence !== plan.expectedJournalSequence + 1 ||
    receipt.previousReceiptDigest !== plan.expectedJournalHead ||
    receipt.planDigest !== plan.planDigest ||
    receipt.targetBindingDigest !== plan.targetBindingDigest ||
    receipt.idempotencyKey !== plan.idempotencyKey ||
    receipt.operation !== plan.operation ||
    receipt.expectedStateDigest !== plan.expectedStateDigest ||
    receipt.resultStateDigest !== plan.expectedResultStateDigest ||
    receipt.appliedHeadSha !== plan.expectedResultHeadSha
  ) {
    throw new TypeError("installation receipt binding mismatch");
  }
  return receipt;
}

export async function applyInstallationPlan(input: {
  readonly plan: unknown;
  readonly authorization: unknown;
  readonly adapter: TrustedInstallationAdapter;
}): Promise<InstallationReceipt> {
  const adapter = input.adapter;
  const plan = assertValidInstallationPlan(input.plan);
  const resultTarget = {
    ...plan.target,
    expectedHeadSha: plan.expectedResultHeadSha
  };
  if (!plan.applyRequested) {
    throw new TypeError("installation plan is non-mutating; explicit apply was not requested");
  }
  const authorization = assertPackagingDocument<InstallationAuthorization>(
    input.authorization,
    "InstallationAuthorization"
  );
  const checkedAuthorization = assertAuthorization(plan, authorization);

  const existing = await adapter.findReceipt(plan.idempotencyKey);
  if (existing !== null) {
    const receipt = assertReceiptForPlan(plan, existing);
    if (!(await verifyAdapterReceipt(adapter, receipt))) {
      throw new TypeError("trusted installation adapter rejected receipt signature");
    }
    const observed = assertPackagingDocument<InstallationState>(
      await adapter.observe(structuredClone(resultTarget)),
      "InstallationState"
    );
    if (digest(observed) !== plan.expectedResultStateDigest) {
      throw new TypeError("recorded installation receipt has ambiguous live state");
    }
    return structuredClone(receipt);
  }

  const now = await adapter.now();
  assertAuthorizationCurrent(checkedAuthorization, now);
  const authorized = await adapter.verifyAuthorization({
    authorization: structuredClone(checkedAuthorization),
    plan: structuredClone(plan)
  });
  const authorizedAgain = await adapter.verifyAuthorization({
    authorization: structuredClone(checkedAuthorization),
    plan: structuredClone(plan)
  });
  if (authorized !== true || authorizedAgain !== true) {
    throw new TypeError("trusted installation adapter rejected human authorization");
  }

  const before = assertPackagingDocument<InstallationState>(
    await adapter.observe(structuredClone(plan.target)),
    "InstallationState"
  );
  if (digest(before) !== plan.expectedStateDigest) {
    throw new TypeError("installation CAS precondition failed before apply");
  }
  const authorizationCheckedAt = await adapter.now();
  assertAuthorizationCurrent(checkedAuthorization, authorizationCheckedAt);
  const receipt = assertReceiptForPlan(
    plan,
    await adapter.apply({
      plan: structuredClone(plan),
      authorization: structuredClone(checkedAuthorization),
      expectedStateDigest: plan.expectedStateDigest,
      expectedHeadSha: plan.target.expectedHeadSha,
      idempotencyKey: plan.idempotencyKey,
      authorizationCheckedAt
    })
  );
  if (!(await verifyAdapterReceipt(adapter, receipt))) {
    throw new TypeError("trusted installation adapter rejected receipt signature");
  }
  const after = assertPackagingDocument<InstallationState>(
    await adapter.observe(structuredClone(resultTarget)),
    "InstallationState"
  );
  if (digest(after) !== plan.expectedResultStateDigest) {
    throw new TypeError("installation apply acknowledgement is ambiguous");
  }
  const persistedCandidate = await adapter.findReceipt(plan.idempotencyKey);
  if (persistedCandidate === null) {
    throw new TypeError("installation receipt persistence is unproven");
  }
  const persisted = assertReceiptForPlan(plan, persistedCandidate);
  if (
    receiptDigest(persisted) !== receiptDigest(receipt) ||
    !(await verifyAdapterReceipt(adapter, persisted))
  ) {
    throw new TypeError("persisted installation receipt differs from applied receipt");
  }
  return structuredClone(receipt);
}

export async function reconcileInstallation(input: {
  readonly plan: unknown;
  readonly receipt: unknown;
  readonly adapter: TrustedInstallationAdapter;
}): Promise<InstallationReceipt> {
  const adapter = input.adapter;
  const plan = assertValidInstallationPlan(input.plan);
  const resultTarget = {
    ...plan.target,
    expectedHeadSha: plan.expectedResultHeadSha
  };
  const receipt = assertReceiptForPlan(plan, input.receipt);
  if (!(await verifyAdapterReceipt(adapter, receipt))) {
    throw new TypeError("trusted installation adapter rejected receipt signature");
  }
  const persistedCandidate = await adapter.findReceipt(plan.idempotencyKey);
  if (persistedCandidate === null) {
    throw new TypeError("installation receipt persistence is unproven");
  }
  const persisted = assertReceiptForPlan(plan, persistedCandidate);
  if (
    receiptDigest(persisted) !== receiptDigest(receipt) ||
    !(await verifyAdapterReceipt(adapter, persisted))
  ) {
    throw new TypeError("persisted installation receipt differs from recovery receipt");
  }
  const observed = assertPackagingDocument<InstallationState>(
    await adapter.observe(structuredClone(resultTarget)),
    "InstallationState"
  );
  if (digest(observed) !== plan.expectedResultStateDigest) {
    throw new TypeError("recovery cannot prove the intended installation state");
  }
  return structuredClone(receipt);
}
