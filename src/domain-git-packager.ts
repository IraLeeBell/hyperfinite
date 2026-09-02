import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalJson, digest } from "./canonical.js";
import { isEngineeringTcbPath } from "./bounded-worktree.js";
import {
  domainOperationRequestDigest,
  DomainPackError,
  type DomainEvidenceSigner,
  type DomainEvidenceVerifier,
  type DomainGitHubPackager,
  type DomainOperationGrantChallengeSource,
  type DomainOperationGrantClaim,
  type DomainOperationGrantStoreHead,
  type DomainOperationGrantStore,
  type DomainRepositoryIdentity
} from "./domain-packs.js";
import { validateDocument } from "./validation.js";
import type { Digest } from "./types.js";

interface GitResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function immutableCanonicalSnapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function unsignedEvidence<T extends object>(
  value: T
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== "signature")
  );
}

function fail(message: string): never {
  throw new DomainPackError("PACKAGE_INVALID", message);
}

function exactGitEnvironment(
  root: string,
  extra: Readonly<Record<string, string>> = {}
): Readonly<Record<string, string>> {
  return {
    CI: "true",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "8",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "core.askPass",
    GIT_CONFIG_VALUE_3: "",
    GIT_CONFIG_KEY_4: "diff.external",
    GIT_CONFIG_VALUE_4: "",
    GIT_CONFIG_KEY_5: "core.autocrlf",
    GIT_CONFIG_VALUE_5: "false",
    GIT_CONFIG_KEY_6: "init.templateDir",
    GIT_CONFIG_VALUE_6: "",
    GIT_CONFIG_KEY_7: "protocol.file.allow",
    GIT_CONFIG_VALUE_7: "never",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: root,
    LANG: "C",
    LC_ALL: "C",
    PATH: "/usr/bin:/bin",
    ...extra
  };
}

function runGit(
  root: string,
  args: readonly string[],
  options: {
    readonly input?: string | Buffer;
    readonly extraEnv?: Readonly<Record<string, string>>;
    readonly maxOutputBytes?: number;
    readonly failureCode?: DomainPackError["code"];
  } = {}
): GitResult {
  const result = spawnSync("git", args, {
    cwd: root,
    env: exactGitEnvironment(root, options.extraEnv),
    input: options.input,
    encoding: null,
    maxBuffer: options.maxOutputBytes ?? 1_048_576,
    timeout: 30_000,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    !Buffer.isBuffer(result.stdout) ||
    !Buffer.isBuffer(result.stderr)
  ) {
    throw new DomainPackError(
      options.failureCode ?? "PACKAGE_INVALID",
      `isolated Git command failed: git ${args.join(" ")} (${String(result.status)}, ${String(result.signal)}, ${result.error?.message ?? result.stderr?.toString("utf8") ?? "unknown"})`
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function stdoutText(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

function sha256Bytes(value: Buffer): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function utcTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (
    !Number.isFinite(parsed) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  ) {
    fail(`${label} is not a canonical UTC timestamp`);
  }
  return parsed;
}

function splitNul(value: Buffer): readonly string[] {
  const text = value.toString("utf8");
  if (text.length === 0) return [];
  if (!text.endsWith("\0")) fail("Git emitted a non-canonical path list");
  return text.slice(0, -1).split("\0");
}

function exactPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes("\n") ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value === "." ||
    value === ".." ||
    value.startsWith("../") ||
    value.split("/").some((segment) => segment === "." || segment === "..") ||
    isEngineeringTcbPath(value)
  ) {
    fail(`domain artifact path is not an exact non-TCB repository path: ${value}`);
  }
  return value;
}

function validateProposalRef(identity: DomainRepositoryIdentity): void {
  if (
    identity.defaultRef !== "refs/heads/main" ||
    !identity.proposalRef.startsWith("refs/heads/agentic-domain/") ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(identity.proposalRef) ||
    identity.proposalRef.includes("..") ||
    identity.proposalRef.endsWith("/") ||
    identity.proposalRef.includes("//")
  ) {
    fail("local packager repository refs are outside the approved namespace");
  }
}

export function localRepositoryRootId(root: string): Digest {
  const worktreeRoot = realpathSync(root);
  const commonDirValue = stdoutText(runGit(worktreeRoot, ["rev-parse", "--git-common-dir"]));
  const gitCommonDir = realpathSync(
    path.isAbsolute(commonDirValue)
      ? commonDirValue
      : path.resolve(worktreeRoot, commonDirValue)
  );
  return digest({ worktreeRoot, gitCommonDir });
}

function parseIndexEntries(value: Buffer): ReadonlyMap<string, {
  readonly mode: string;
  readonly object: string;
}> {
  const entries = new Map<string, { readonly mode: string; readonly object: string }>();
  for (const record of splitNul(value)) {
    const match = /^(?<mode>[0-7]{6}) (?<object>[a-f0-9]{40}) 0\t(?<path>.+)$/u.exec(
      record
    );
    if (match?.groups === undefined) fail("isolated Git index contains an invalid entry");
    const repositoryPath = match.groups["path"];
    const mode = match.groups["mode"];
    const object = match.groups["object"];
    if (
      repositoryPath === undefined ||
      mode === undefined ||
      object === undefined ||
      entries.has(repositoryPath)
    ) {
      fail("isolated Git index contains duplicate or incomplete entries");
    }

    entries.set(repositoryPath, { mode, object });
  }
  return entries;
}

function parseTreeEntries(value: Buffer): ReadonlyMap<string, {
  readonly mode: string;
  readonly object: string;
}> {
  const entries = new Map<string, { readonly mode: string; readonly object: string }>();
  for (const record of splitNul(value)) {
    const match =
      /^(?<mode>[0-7]{6}) (?<type>blob) (?<object>[a-f0-9]{40})\t(?<path>.+)$/u.exec(
        record
      );
    if (match?.groups === undefined) fail("written Git tree contains an invalid entry");
    const repositoryPath = match.groups["path"];
    const mode = match.groups["mode"];
    const object = match.groups["object"];
    if (
      repositoryPath === undefined ||
      mode === undefined ||
      object === undefined ||
      entries.has(repositoryPath)
    ) {
      fail("written Git tree contains duplicate or incomplete entries");
    }
    entries.set(repositoryPath, { mode, object });
  }
  return entries;
}

export class LocalDomainGitPackager {
  readonly #root: string;
  readonly #rootDevice: string;
  readonly #rootInode: string;
  readonly #baseSha: string;
  readonly #repositoryIdentity: DomainRepositoryIdentity;
  readonly #clock: { now(): string };
  readonly #signer: DomainEvidenceSigner;
  readonly #verifier: DomainEvidenceVerifier;
  readonly #operationGrantStore: DomainOperationGrantStore;
  readonly #operationGrantStoreId: string;
  readonly #operationGrantChallengeSource: DomainOperationGrantChallengeSource;
  readonly #beforeRefUpdate: (() => void) | null;
  readonly #beforeRefTransaction: (() => void) | null;
  readonly #afterRefTransaction: (() => void) | null;
  readonly #afterRefUpdate: (() => void) | null;
  readonly #duringRefReconciliation: (() => void) | null;

  constructor(input: {
    readonly root: string;
    readonly baseSha: string;
    readonly repositoryIdentity: DomainRepositoryIdentity;
    readonly clock: { now(): string };
    readonly signer: DomainEvidenceSigner;
    readonly verifier: DomainEvidenceVerifier;
    readonly operationGrantStore: DomainOperationGrantStore;
    readonly operationGrantStoreId: string;
    readonly operationGrantChallengeSource: DomainOperationGrantChallengeSource;
    readonly beforeRefUpdate?: () => void;
    readonly beforeRefTransaction?: () => void;
    readonly afterRefTransaction?: () => void;
    readonly afterRefUpdate?: () => void;
    readonly duringRefReconciliation?: () => void;
  }) {
    const canonicalRoot = realpathSync(input.root);
    const rootStat = statSync(canonicalRoot, { bigint: true });
    if (
      lstatSync(input.root).isSymbolicLink() ||
      !rootStat.isDirectory() ||
      !/^[a-f0-9]{40}$/u.test(input.baseSha) ||
      !/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/u.test(input.operationGrantStoreId) ||
      input.operationGrantStoreId.length > 128 ||
      input.repositoryIdentity.repositoryRootId !== localRepositoryRootId(canonicalRoot)
    ) {
      fail("local packager configuration is not canonical");
    }
    validateProposalRef(input.repositoryIdentity);
    this.#root = canonicalRoot;
    this.#rootDevice = rootStat.dev.toString();
    this.#rootInode = rootStat.ino.toString();
    this.#baseSha = input.baseSha;
    this.#repositoryIdentity = immutableCanonicalSnapshot(input.repositoryIdentity);
    this.#clock = input.clock;
    this.#signer = input.signer;
    this.#verifier = input.verifier;
    this.#operationGrantStore = input.operationGrantStore;
    this.#operationGrantStoreId = input.operationGrantStoreId;
    this.#operationGrantChallengeSource = input.operationGrantChallengeSource;
    this.#beforeRefUpdate = input.beforeRefUpdate ?? null;
    this.#beforeRefTransaction = input.beforeRefTransaction ?? null;
    this.#afterRefTransaction = input.afterRefTransaction ?? null;
    this.#afterRefUpdate = input.afterRefUpdate ?? null;
    this.#duringRefReconciliation = input.duringRefReconciliation ?? null;
  }

  #verifyRepositoryRoot(): void {
    const currentRoot = realpathSync(this.#root);
    const currentStat = statSync(currentRoot, { bigint: true });
    if (
      currentRoot !== this.#root ||
      !currentStat.isDirectory() ||
      currentStat.dev.toString() !== this.#rootDevice ||
      currentStat.ino.toString() !== this.#rootInode ||
      localRepositoryRootId(currentRoot) !==
        this.#repositoryIdentity.repositoryRootId
    ) {
      fail("repository root identity changed");
    }
  }

  #readDirectRef(ref: string, label: "default" | "proposal"): string {
    const fields = stdoutText(
      runGit(this.#root, [
        "for-each-ref",
        "--count=1",
        "--format=%(refname)%09%(symref)%09%(objectname)",
        ref
      ])
    ).split("\t");
    if (
      fields.length !== 3 ||
      fields[0] !== ref ||
      fields[1] !== "" ||
      !/^[a-f0-9]{40}$/u.test(fields[2] ?? "") ||
      stdoutText(runGit(this.#root, ["cat-file", "-t", fields[2] ?? ""])) !== "commit"
    ) {
      fail(`${label} ref is missing, symbolic, or does not name a commit directly`);
    }
    return fields[2] as string;
  }

  async readCurrentBinding(
    expected: DomainRepositoryIdentity
  ): Promise<Awaited<ReturnType<DomainGitHubPackager["readCurrentBinding"]>>> {
    const expectedSnapshot = immutableCanonicalSnapshot(expected);
    if (digest(expectedSnapshot) !== digest(this.#repositoryIdentity)) {
      fail("repository identity does not match the configured local repository");
    }
    this.#verifyRepositoryRoot();
    const baseSha = this.#readDirectRef(
      this.#repositoryIdentity.defaultRef,
      "default"
    );
    if (baseSha !== this.#baseSha) {
      fail("bound default ref does not resolve to the configured base commit");
    }
    return {
      ...this.#repositoryIdentity,
      baseSha,
      headSha: this.#readDirectRef(
        this.#repositoryIdentity.proposalRef,
        "proposal"
      )
    };
  }

  async packageDraftPullRequest(
    input: Parameters<DomainGitHubPackager["packageDraftPullRequest"]>[0]
  ): ReturnType<DomainGitHubPackager["packageDraftPullRequest"]> {
    const packageInput = immutableCanonicalSnapshot(input);
    const packageInputDigest = digest(packageInput);
    const {
      authorization,
      authorityGuard,
      ...baseRequest
    } = packageInput;
    const requestDigest = domainOperationRequestDigest(
      "repository-package",
      baseRequest
    );
    const authorizationDigest = digest(authorization);
    const verifyDetached = (
      payload: Readonly<Record<string, unknown>>,
      signature: unknown,
      purpose: string
    ): boolean => {
      if (
        signature === null ||
        typeof signature !== "object" ||
        !("algorithm" in signature) ||
        !("keyId" in signature) ||
        !("value" in signature)
      ) {
        return false;
      }
      try {
        return this.#verifier.verify(
          payload,
          signature as Parameters<DomainEvidenceVerifier["verify"]>[1],
          purpose
        );
      } catch {
        return false;
      }
    };
    const verifyPackageAuthority = (): void => {
      if (
        authorization.purpose !== "domain-operation" ||
        authorization.operation !== "repository-package" ||
        authorization.capability !== null ||
        authorization.contextDigest !== requestDigest ||
        authorization.authorityDigest !==
          packageInput.authorityBindings.authorityDigest ||
        authorization.repositoryId !== packageInput.repositoryId ||
        authorization.workItemId !== packageInput.workItemId ||
        authorization.repositoryIdentityDigest !==
          digest(packageInput.repositoryIdentity) ||
        authorization.headSha !== packageInput.expectedHeadSha ||
        authorization.threatStatus !== "success" ||
        authorization.policyCurrent !== true ||
        authorization.headCurrent !== true ||
        authorization.stateRevoked !== false ||
        authorization.leaseRevoked !== false ||
        authorization.casResult !== "appended" ||
        authorization.reservedTokens !== 0 ||
        authorization.reservedCostUnits !== 0 ||
        authorization.nonce.length < 16 ||
        authorization.redemptionKey !==
          digest({
            authorityDigest: authorization.authorityDigest,
            kernelAuthorizationDigest: authorization.kernelAuthorizationDigest,
            repositoryIdentityDigest: authorization.repositoryIdentityDigest,
            runId: authorization.runId,
            runAttempt: authorization.runAttempt,
            sequence: authorization.sequence,
            operation: authorization.operation,
            capability: authorization.capability,
            contextDigest: authorization.contextDigest
          }) ||
        !verifyDetached(
          unsignedEvidence(authorization),
          authorization.signature,
          "domain-operation"
        ) ||
        authorityGuard.operation !== "repository-package" ||
        authorityGuard.authorityDigest !== authorization.authorityDigest ||
        authorityGuard.repositoryIdentityDigest !==
          digest(this.#repositoryIdentity) ||
        authorityGuard.artifactSetDigest !== packageInput.artifactSetDigest ||
        authorityGuard.grantContextDigest !== requestDigest ||
        authorityGuard.authorizationDigest !== authorizationDigest ||
        authorityGuard.authorizationSignatureDigest !==
          digest(authorization.signature) ||
        authorityGuard.authorizationNonce !== authorization.nonce ||
        authorityGuard.authorizationRunId !== authorization.runId ||
        authorityGuard.authorizationRunAttempt !== authorization.runAttempt ||
        authorityGuard.authorizationExpiresAt !== authorization.expiresAt ||
        !verifyDetached(
          unsignedEvidence(authorityGuard),
          authorityGuard.signature,
          "domain-claims-rights-authority-guard"
        ) ||
        utcTimestamp(this.#clock.now(), "current time") <
          utcTimestamp(authorization.checkedAt, "authorization checkedAt") ||
        utcTimestamp(this.#clock.now(), "current time") <
          utcTimestamp(authorityGuard.checkedAt, "authority guard checkedAt") ||
        utcTimestamp(this.#clock.now(), "current time") >=
          utcTimestamp(authorization.expiresAt, "authorization expiry") ||
        utcTimestamp(this.#clock.now(), "current time") >=
          utcTimestamp(packageInput.evidenceExpiresAt, "evidence expiry")
      ) {
        fail("repository package authorization is unauthenticated or mismatched");
      }
    };
    verifyPackageAuthority();
    if (
      authorization.headSha !== packageInput.expectedHeadSha ||
      digest(this.#repositoryIdentity) !== digest(packageInput.repositoryIdentity) ||
      packageInput.expectedBaseSha !== this.#baseSha ||
      packageInput.repositoryId !== this.#repositoryIdentity.repositoryId ||
      packageInput.workItemId !== this.#repositoryIdentity.workItemId
    ) {
      fail("repository package authorization is stale or mismatched");
    }
    const current = await this.readCurrentBinding(this.#repositoryIdentity);
    if (
      current.baseSha !== packageInput.expectedBaseSha ||
      current.headSha !== packageInput.expectedHeadSha
    ) {
      throw new DomainPackError("HEAD_STALE", "local Git ref changed before packaging");
    }
    if (packageInput.expectedHeadSha !== packageInput.expectedBaseSha) {
      fail(
        "proposal ref contains accumulated changes without an authorized prior-artifact manifest"
      );
    }
    const ambient = splitNul(
      runGit(this.#root, [
        "diff-index",
        "--cached",
        "--name-only",
        "-z",
        packageInput.expectedHeadSha,
        "--"
      ]).stdout
    );
    if (ambient.length !== 0) {
      fail("ambient Git index contains pre-staged paths");
    }

    const paths = new Set<string>();
    const fileObjects = new Map<string, string>();
    let aggregateContentBytes = 0;
    for (const file of packageInput.files) {
      const repositoryPath = exactPath(file.path);
      const contentBytes = Buffer.from(file.content, "utf8");
      aggregateContentBytes += contentBytes.byteLength;
      if (
        paths.has(repositoryPath) ||
        file.mode !== 100644 ||
        file.contentDigest !== digest({ content: file.content }) ||
        contentBytes.byteLength === 0 ||
        contentBytes.byteLength > packageInput.maxPatchBytes ||
        aggregateContentBytes > packageInput.maxPatchBytes
      ) {
        fail("domain artifact set is duplicate, malformed, or oversized");
      }
      paths.add(repositoryPath);
    }
    if (paths.size === 0) fail("domain artifact set is empty");

    const headChallenge = this.#operationGrantChallengeSource.next();
    const claimChallenge = this.#operationGrantChallengeSource.next();
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(headChallenge) ||
      !/^sha256:[a-f0-9]{64}$/u.test(claimChallenge) ||
      headChallenge === claimChallenge
    ) {
      fail("operation grant challenge source is invalid");
    }
    let storeHead: DomainOperationGrantStoreHead;
    try {
      storeHead = immutableCanonicalSnapshot(
        await this.#operationGrantStore.readHead({
          storeId: this.#operationGrantStoreId,
          challenge: headChallenge
        })
      );
    } catch {
      fail("operation grant store head is not canonical");
    }
    if (!this.#validGrantStoreHead(storeHead, headChallenge)) {
      fail("operation grant store head is unauthenticated");
    }
    const grantClaimRequest = deepFreeze({
      storeId: this.#operationGrantStoreId,
      claimChallenge,
      expectedPreviousHead: storeHead.head,
      expectedStoreSequence: storeHead.storeSequence,
      grantDigest: authorizationDigest,
      redemptionKey: authorization.redemptionKey,
      operation: authorization.operation,
      contextDigest: authorization.contextDigest,
      repositoryIdentityDigest: authorization.repositoryIdentityDigest,
      runId: authorization.runId,
      runAttempt: authorization.runAttempt,
      operationSequence: authorization.sequence,
      grantCheckedAt: authorization.checkedAt,
      grantExpiresAt: authorization.expiresAt
    });
    let grantClaim: DomainOperationGrantClaim | null;
    try {
      const returnedClaim =
        await this.#operationGrantStore.claim(grantClaimRequest);
      grantClaim =
        returnedClaim === null
          ? null
          : immutableCanonicalSnapshot(returnedClaim);
    } catch {
      fail("repository package authorization claim is not canonical");
    }
    if (
      grantClaim === null ||
      !validateDocument("DomainOperationGrantClaim", grantClaim).valid ||
      !this.#validGrantClaim(grantClaim, grantClaimRequest)
    ) {
      fail("repository package authorization was not atomically claimed");
    }
    const operationGrantClaimDigest = digest(grantClaim);
    const observedAt = this.#clock.now();
    if (
      utcTimestamp(observedAt, "package receipt observedAt") <
        utcTimestamp(grantClaim.claimedAt, "operation claim claimedAt") ||
      utcTimestamp(observedAt, "package receipt observedAt") >=
        utcTimestamp(authorization.expiresAt, "authorization expiry") ||
      utcTimestamp(observedAt, "package receipt observedAt") >=
        utcTimestamp(packageInput.evidenceExpiresAt, "evidence expiry")
    ) {
      fail("package receipt time is outside the claimed authorization window");
    }
    this.#verifyRepositoryRoot();
    verifyPackageAuthority();
    if (
      this.#readDirectRef(this.#repositoryIdentity.defaultRef, "default") !==
        packageInput.expectedBaseSha ||
      this.#readDirectRef(this.#repositoryIdentity.proposalRef, "proposal") !==
        packageInput.expectedHeadSha
    ) {
      throw new DomainPackError(
        "HEAD_STALE",
        "repository state changed while claiming the operation grant"
      );
    }

    const indexRoot = mkdtempSync(path.join(tmpdir(), "hyperfinite-domain-index-"));
    const indexPath = path.join(indexRoot, "index");
    const indexEnv = { GIT_INDEX_FILE: indexPath };
    try {
      this.#verifyRepositoryRoot();
      verifyPackageAuthority();
      runGit(this.#root, ["read-tree", packageInput.expectedBaseSha], {
        extraEnv: indexEnv
      });
      for (const file of packageInput.files) {
        const object = stdoutText(
          runGit(this.#root, ["hash-object", "-w", "--stdin"], {
            input: Buffer.from(file.content, "utf8")
          })
        );
        if (!/^[a-f0-9]{40}$/u.test(object)) fail("Git returned an invalid blob identity");
        fileObjects.set(file.path, object);
        runGit(
          this.#root,
          ["update-index", "--add", "--cacheinfo", `100644,${object},${file.path}`],
          { extraEnv: indexEnv }
        );
      }
      const indexEntries = parseIndexEntries(
        runGit(this.#root, ["ls-files", "--stage", "-z"], {
          extraEnv: indexEnv
        }).stdout
      );
      for (const [repositoryPath, object] of fileObjects) {
        const entry = indexEntries.get(repositoryPath);
        if (entry?.mode !== "100644" || entry.object !== object) {
          fail("isolated index does not contain the exact authorized artifact");
        }
      }
      const treeSha = stdoutText(
        runGit(this.#root, ["write-tree"], { extraEnv: indexEnv })
      );
      if (!/^[a-f0-9]{40}$/u.test(treeSha)) fail("Git returned an invalid tree identity");
      const changedPaths = splitNul(
        runGit(this.#root, [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "--no-renames",
          "-r",
          "-z",
          packageInput.expectedBaseSha,
          treeSha
        ]).stdout
      );
      if (
        changedPaths.length !== paths.size ||
        changedPaths.some((repositoryPath) => !paths.has(repositoryPath))
      ) {
        fail("isolated tree differs outside the exact authorized artifact set");
      }
      const treeEntries = parseTreeEntries(
        runGit(
          this.#root,
          ["ls-tree", "-r", "--full-tree", "-z", treeSha, "--", ...paths],
          { extraEnv: indexEnv }
        ).stdout
      );
      if (treeEntries.size !== paths.size) {
        fail("written tree does not contain the complete authorized artifact set");
      }
      for (const [repositoryPath, object] of fileObjects) {
        const entry = treeEntries.get(repositoryPath);
        if (entry?.mode !== "100644" || entry.object !== object) {
          fail("written tree does not contain the exact authorized artifact");
        }
      }
      const patch = runGit(
        this.#root,
        [
          "diff",
          "--binary",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          packageInput.expectedBaseSha,
          treeSha
        ],
        { maxOutputBytes: packageInput.maxPatchBytes + 1 }
      ).stdout;
      const patchBytes = patch.byteLength;
      if (patchBytes < 1 || patchBytes > packageInput.maxPatchBytes) {
        fail("exact isolated Git patch exceeds its authorized size");
      }
      const commitSha = stdoutText(
        runGit(
          this.#root,
          ["commit-tree", treeSha, "-p", packageInput.expectedHeadSha],
          {
            input: "Package proposal artifacts\n",
            extraEnv: {
              GIT_AUTHOR_DATE: observedAt,
              GIT_AUTHOR_EMAIL: "domain-pack@invalid",
              GIT_AUTHOR_NAME: "Trusted Domain Packager",
              GIT_COMMITTER_DATE: observedAt,
              GIT_COMMITTER_EMAIL: "domain-pack@invalid",
              GIT_COMMITTER_NAME: "Trusted Domain Packager"
            }
          }
        )
      );
      const commit = stdoutText(
        runGit(this.#root, ["cat-file", "-p", commitSha])
      );
      if (
        !commit.startsWith(
          `tree ${treeSha}\nparent ${packageInput.expectedHeadSha}\n`
        )
      ) {
        fail("created commit does not bind the exact tree and parent");
      }
      const unsignedReceipt = deepFreeze({
        purpose: "domain-package-receipt" as const,
        repositoryIdentity: this.#repositoryIdentity,
        packageId: `local-draft-pr:${digest({
          artifactSetDigest: packageInput.artifactSetDigest,
          commitSha,
          treeSha
        })}`,
        headSha: commitSha,
        parentSha: packageInput.expectedHeadSha,
        baseSha: packageInput.expectedBaseSha,
        proposalRef: this.#repositoryIdentity.proposalRef,
        treeSha,
        patchDigest: sha256Bytes(patch),
        artifactSetDigest: packageInput.artifactSetDigest,
        patchBytes,
        authorizationDigest: digest(authorization),
        operationGrantClaimDigest,
        authorityGuardDigest: digest(authorityGuard),
        authorityRevision: authorityGuard.revision,
        evidenceDigest: packageInput.evidenceDigest,
        draft: true as const,
        externalEffectsPerformed: false as const,
        observedAt
      });
      const signedReceipt = deepFreeze({
        ...unsignedReceipt,
        signature: this.#signer.sign(
          unsignedReceipt,
          "domain-package-receipt"
        )
      });
      if (
        !this.#verifier.verify(
          unsignedReceipt,
          signedReceipt.signature,
          "domain-package-receipt"
        )
      ) {
        fail("domain package receipt signature is invalid");
      }
      const verifyPreparedPackage = (): void => {
        this.#verifyRepositoryRoot();
        if (
          digest(packageInput) !== packageInputDigest ||
          authorization.contextDigest !== requestDigest
        ) {
          fail("repository package request changed before reconciliation");
        }
        verifyPackageAuthority();
        if (
          !this.#verifier.verify(
            unsignedReceipt,
            signedReceipt.signature,
            "domain-package-receipt"
          )
        ) {
          fail("prepared package authority or receipt is invalid");
        }
        const reconciledCommit = stdoutText(
          runGit(this.#root, ["cat-file", "-p", commitSha])
        );
        if (
          !reconciledCommit.startsWith(
            `tree ${treeSha}\nparent ${packageInput.expectedHeadSha}\n`
          )
        ) {
          fail("reconciled commit does not bind the intended tree and parent");
        }
        const reconciledPaths = splitNul(
          runGit(this.#root, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-z",
            packageInput.expectedBaseSha,
            treeSha
          ]).stdout
        );
        if (
          reconciledPaths.length !== paths.size ||
          reconciledPaths.some((repositoryPath) => !paths.has(repositoryPath))
        ) {
          fail("reconciled tree differs outside the authorized artifact set");
        }
        const reconciledTreeEntries = parseTreeEntries(
          runGit(
            this.#root,
            ["ls-tree", "-r", "--full-tree", "-z", treeSha, "--", ...paths],
            { extraEnv: indexEnv }
          ).stdout
        );
        if (reconciledTreeEntries.size !== paths.size) {
          fail("reconciled tree omits an authorized artifact");
        }
        for (const [repositoryPath, object] of fileObjects) {
          const entry = reconciledTreeEntries.get(repositoryPath);
          if (entry?.mode !== "100644" || entry.object !== object) {
            fail("reconciled tree contains a substituted artifact");
          }
        }
        const reconciledPatch = runGit(
          this.#root,
          [
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            packageInput.expectedBaseSha,
            treeSha
          ],
          { maxOutputBytes: packageInput.maxPatchBytes + 1 }
        ).stdout;
        if (
          reconciledPatch.byteLength !== patchBytes ||
          sha256Bytes(reconciledPatch) !== unsignedReceipt.patchDigest
        ) {
          fail("reconciled patch differs from the signed package receipt");
        }
      };
      const reconcileRefAttempt = (
        attemptError: unknown
      ): typeof signedReceipt => {
        try {
          verifyPreparedPackage();
          const defaultHead = this.#readDirectRef(
            this.#repositoryIdentity.defaultRef,
            "default"
          );
          this.#duringRefReconciliation?.();
          const proposalHead = this.#readDirectRef(
            this.#repositoryIdentity.proposalRef,
            "proposal"
          );
          if (
            defaultHead === packageInput.expectedBaseSha &&
            proposalHead === commitSha
          ) {
            runGit(
              this.#root,
              ["update-ref", "--no-deref", "--stdin"],
              {
                input:
                  `verify ${this.#repositoryIdentity.defaultRef} ${packageInput.expectedBaseSha}\n` +
                  `verify ${this.#repositoryIdentity.proposalRef} ${commitSha}\n`,
                failureCode: "PACKAGE_AMBIGUOUS"
              }
            );
            return signedReceipt;
          }
          if (
            defaultHead === packageInput.expectedBaseSha &&
            proposalHead === packageInput.expectedHeadSha
          ) {
            runGit(
              this.#root,
              ["update-ref", "--no-deref", "--stdin"],
              {
                input:
                  `verify ${this.#repositoryIdentity.defaultRef} ${packageInput.expectedBaseSha}\n` +
                  `verify ${this.#repositoryIdentity.proposalRef} ${packageInput.expectedHeadSha}\n`,
                failureCode: "PACKAGE_AMBIGUOUS"
              }
            );
            throw new DomainPackError(
              "HEAD_STALE",
              attemptError === null
                ? "package ref transaction reported success without applying"
                : "package ref transaction did not apply"
            );
          }
          throw new DomainPackError(
            "PACKAGE_AMBIGUOUS",
            "package ref reconciliation found divergent repository state"
          );
        } catch (error) {
          if (
            error instanceof DomainPackError &&
            (error.code === "HEAD_STALE" ||
              error.code === "PACKAGE_AMBIGUOUS")
          ) {
            throw error;
          }
          throw new DomainPackError(
            "PACKAGE_AMBIGUOUS",
            `package ref reconciliation could not prove its outcome: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      };
      this.#beforeRefUpdate?.();
      this.#verifyRepositoryRoot();
      if (
        digest(packageInput) !== packageInputDigest ||
        authorization.contextDigest !== requestDigest
      ) {
        fail("repository package request changed before ref update");
      }
      verifyPackageAuthority();
      if (
        this.#readDirectRef(this.#repositoryIdentity.defaultRef, "default") !==
        packageInput.expectedBaseSha
      ) {
        throw new DomainPackError(
          "HEAD_STALE",
          "default ref changed before atomic package update"
        );
      }
      if (
        this.#readDirectRef(this.#repositoryIdentity.proposalRef, "proposal") !==
        packageInput.expectedHeadSha
      ) {
        throw new DomainPackError(
          "HEAD_STALE",
          "local Git ref changed or became symbolic before atomic update"
        );
      }
      this.#verifyRepositoryRoot();
      if (
        digest(packageInput) !== packageInputDigest ||
        this.#readDirectRef(this.#repositoryIdentity.defaultRef, "default") !==
          packageInput.expectedBaseSha ||
        this.#readDirectRef(this.#repositoryIdentity.proposalRef, "proposal") !==
          packageInput.expectedHeadSha
      ) {
        throw new DomainPackError(
          "HEAD_STALE",
          "repository state changed while claiming the operation grant"
        );
      }
      let attemptError: unknown = null;
      try {
        this.#beforeRefTransaction?.();
        runGit(
          this.#root,
          ["update-ref", "--no-deref", "--stdin"],
          {
            input:
              `verify ${this.#repositoryIdentity.defaultRef} ${packageInput.expectedBaseSha}\n` +
              `update ${this.#repositoryIdentity.proposalRef} ${commitSha} ${packageInput.expectedHeadSha}\n`,
            failureCode: "HEAD_STALE"
          }
        );
        this.#afterRefTransaction?.();
        this.#afterRefUpdate?.();
      } catch (error) {
        attemptError = error;
      }
      return reconcileRefAttempt(attemptError);
    } finally {
      rmSync(indexRoot, { recursive: true, force: true });
    }
  }

  #validGrantClaim(
    claim: DomainOperationGrantClaim,
    request: {
      readonly storeId: string;
      readonly claimChallenge: Digest;
      readonly expectedPreviousHead: Digest | null;
      readonly expectedStoreSequence: number;
      readonly grantDigest: Digest;
      readonly redemptionKey: Digest;
      readonly operation: DomainOperationGrantClaim["operation"];
      readonly contextDigest: Digest;
      readonly repositoryIdentityDigest: Digest;
      readonly runId: string;
      readonly runAttempt: number;
      readonly operationSequence: number;
      readonly grantCheckedAt: string;
      readonly grantExpiresAt: string;
    }
  ): boolean {
    const { signature, ...unsignedClaim } = claim;
    const { head: _head, ...claimPayload } = unsignedClaim;
    const expectedHead = digest(claimPayload);
    return (
      claim.purpose === "domain-operation-grant-claim" &&
      claim.storeId === this.#operationGrantStoreId &&
      claim.storeId === request.storeId &&
      claim.claimChallenge === request.claimChallenge &&
      claim.casResult === "appended" &&
      claim.previousHead === request.expectedPreviousHead &&
      request.expectedStoreSequence < Number.MAX_SAFE_INTEGER &&
      claim.storeSequence === request.expectedStoreSequence + 1 &&
      claim.grantDigest === request.grantDigest &&
      claim.redemptionKey === request.redemptionKey &&
      claim.operation === request.operation &&
      claim.contextDigest === request.contextDigest &&
      claim.repositoryIdentityDigest === request.repositoryIdentityDigest &&
      claim.runId === request.runId &&
      claim.runAttempt === request.runAttempt &&
      claim.operationSequence === request.operationSequence &&
      claim.grantExpiresAt === request.grantExpiresAt &&
      claim.head === expectedHead &&
      claim.grantCheckedAt === request.grantCheckedAt &&
      utcTimestamp(claim.claimedAt, "operation claim claimedAt") >=
        utcTimestamp(claim.grantCheckedAt, "operation grant checkedAt") &&
      utcTimestamp(claim.claimedAt, "operation claim claimedAt") <=
        utcTimestamp(this.#clock.now(), "current time") &&
      utcTimestamp(claim.claimedAt, "operation claim claimedAt") <
        utcTimestamp(claim.grantExpiresAt, "operation claim expiry") &&
      this.#verifier.verify(
        unsignedClaim,
        signature,
        "domain-operation-grant-claim"
      )
    );
  }

  #validGrantStoreHead(
    head: DomainOperationGrantStoreHead,
    challenge: Digest
  ): boolean {
    if (!validateDocument("DomainOperationGrantStoreHead", head).valid) {
      return false;
    }
    const { signature, ...unsignedHead } = head;
    return (
      head.purpose === "domain-operation-grant-store-head" &&
      head.storeId === this.#operationGrantStoreId &&
      head.challenge === challenge &&
      ((head.storeSequence === 0 && head.head === null) ||
        (head.storeSequence > 0 && head.head !== null)) &&
      utcTimestamp(head.observedAt, "operation store head observedAt") <=
        utcTimestamp(this.#clock.now(), "current time") &&
      utcTimestamp(this.#clock.now(), "current time") <
        utcTimestamp(head.expiresAt, "operation store head expiry") &&
      this.#verifier.verify(
        unsignedHead,
        signature,
        "domain-operation-grant-store-head"
      )
    );
  }
}
