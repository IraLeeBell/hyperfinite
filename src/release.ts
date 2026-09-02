import { readFileSync } from "node:fs";
import path from "node:path";
import parseSpdxExpression from "spdx-expression-parse";

import { canonicalJson, digest } from "./canonical.js";
import type {
  OpenSourceReadinessAssessment,
  ReleaseCandidateChecklist,
  ReleaseFile,
  ReleaseManifest
} from "./packaging-types.js";
import type { Digest } from "./types.js";
import { assertDocument } from "./validation.js";
import {
  assertReleasePath,
  releaseArchivePath,
  splitCanonicalUstarPath
} from "./release-path.js";
import {
  assertExactHead,
  assertGitTopLevel,
  assertOutsideRepositoryMetadata,
  assertPackagingKind,
  assertSafeOutputRoot,
  assertStrictlySortedPaths,
  assertSupportedGitVersion,
  canonicalDirectory,
  canonicalFile,
  compareCodeUnits,
  createChecksums,
  createRootSpdxDocument,
  EXPECTED_LICENSE_DIGEST,
  EXPECTED_NOTICES_DIGEST,
  type GitTreeFile,
  gitText,
  lockPackages,
  MAX_ARCHIVE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  packageVersionFrom,
  readCanonicalJson,
  readGitTree,
  requiredFile,
  safeOutputPath,
  sha256Bytes,
  sha256Hex,
  type SpdxDocument,
  UTF8_DECODER,
  validateBundleOutputDirectory,
  verifyBundleChecksums,
  writeExclusive
} from "./release-support.js";

export type { SpdxDocument };

const OUTPUT_FILES = [
  "agentic-framework.tar",
  "attestation.json",
  "checksums.txt",
  "provenance.json",
  "release-candidate.json",
  "release-manifest.json",
  "sbom.spdx.json"
] as const;

function isValidSpdxLicense(value: string): boolean {
  if (value === "NONE" || value === "NOASSERTION") return true;
  try {
    parseSpdxExpression(value);
    return true;
  } catch {
    return false;
  }
}

export interface ReleaseProvenance {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "UnsignedLocalProvenance";
  readonly schemaVersion: "1.0.0";
  readonly source: {
    readonly server: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly packageVersion: string;
  readonly buildType: "local-deterministic-source-archive";
  readonly builder: "agentic-framework-release-tool";
  readonly networkUsed: false;
  readonly credentialsUsed: false;
  readonly publicationPerformed: false;
  readonly materials: readonly {
    readonly path: string;
    readonly digest: Digest;
  }[];
  readonly limitations: readonly [
    "unsigned-local-evidence",
    "no-production-key",
    "no-publication",
    "not-a-readiness-decision"
  ];
}

export interface ReleaseAttestation {
  readonly _type: "https://in-toto.io/Statement/v1";
  readonly subject: readonly {
    readonly name: string;
    readonly digest: { readonly sha256: string };
  }[];
  readonly predicateType: "https://agentic-framework.github.com/attestations/unsigned-local-release/v1";
  readonly predicate: {
    readonly packageVersion: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly releaseManifestDigest: Digest;
    readonly sbomDigest: Digest;
    readonly provenanceDigest: Digest;
    readonly signed: false;
    readonly trust: "untrusted-until-human-release-service-signs";
    readonly statement: "This binds local bytes and source identity only; it does not attest review, security, readiness, or publication approval.";
  };
}

export interface ReleaseBundleResult {
  readonly archiveDigest: Digest;
  readonly releaseManifestDigest: Digest;
  readonly sbomDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly attestationDigest: Digest;
  readonly releaseCandidateDigest: Digest;
  readonly outputRoot: string;
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number
): void {
  const octal = value.toString(8);
  if (octal.length > length - 1) throw new TypeError("tar numeric field overflow");
  header.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function tarHeader(filePath: string, mode: "100644" | "100755", size: number): Buffer {
  const header = Buffer.alloc(512);
  const split = splitCanonicalUstarPath(filePath);
  header.write(split.name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode === "100644" ? 0o644 : 0o755);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(split.prefix, 345, 155, "utf8");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export function createDeterministicTar(
  files: readonly GitTreeFile[],
  maxFiles: number = MAX_FILES
): Buffer {
  if (files.length < 1 || files.length > maxFiles) {
    throw new TypeError("release tree file count is outside the closed bound");
  }
  assertStrictlySortedPaths(files, "release archive");
  let projectedBytes = 1024;
  for (const file of files) {
    if (
      file.size !== file.content.byteLength ||
      file.size < 0 ||
      file.size > MAX_FILE_BYTES
    ) {
      throw new TypeError(`release file exceeds the byte bound: ${file.path}`);
    }
    projectedBytes += 512 + Math.ceil(file.size / 512) * 512;
    if (projectedBytes > MAX_ARCHIVE_BYTES) {
      throw new TypeError("release archive exceeds the byte bound");
    }
  }
  const parts: Buffer[] = [];
  for (const file of files) {
    const archivePath = releaseArchivePath(file.path);
    parts.push(tarHeader(archivePath, file.mode, file.size));
    parts.push(file.content);
    const padding = (512 - (file.size % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  const archive = Buffer.concat(parts);
  if (archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new TypeError("release archive exceeds the byte bound");
  }
  return archive;
}

function parseOctal(value: Buffer, subject: string): number {
  const zero = value.indexOf(0);
  const text = value
    .subarray(0, zero === -1 ? value.length : zero)
    .toString("ascii")
    .trim();
  if (!/^[0-7]+$/.test(text)) throw new TypeError(`invalid tar ${subject}`);
  const parsed = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`tar ${subject} overflow`);
  return parsed;
}

function readTarString(value: Buffer): string {
  const zero = value.indexOf(0);
  return UTF8_DECODER.decode(
    value.subarray(0, zero === -1 ? value.length : zero)
  );
}

export function verifyDeterministicTar(
  archive: Buffer,
  manifest: ReleaseManifest
): void {
  const manifestDocument = assertDocument(
    "PackagingDocument",
    structuredClone(manifest)
  );
  if (manifestDocument.kind !== "ReleaseManifest") {
    throw new TypeError("release archive requires a release manifest");
  }
  const stableManifest = manifestDocument;
  if (
    archive.byteLength < 1024 ||
    archive.byteLength > MAX_ARCHIVE_BYTES ||
    archive.byteLength % 512 !== 0
  ) {
    throw new TypeError("release archive has invalid bounds");
  }
  const observed: ReleaseFile[] = [];
  let previousPath: string | null = null;
  let offset = 0;
  let ended = false;
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      const remainder = archive.subarray(offset);
      if (
        remainder.byteLength !== 1024 ||
        !remainder.every((byte) => byte === 0)
      ) {
        throw new TypeError("release archive has a malformed end marker");
      }
      ended = true;
      break;
    }
    const storedChecksum = parseOctal(header.subarray(148, 156), "checksum");
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== storedChecksum) {
      throw new TypeError("release archive header checksum mismatch");
    }
    if (
      header.subarray(257, 263).toString("ascii") !== "ustar\0" ||
      header.subarray(263, 265).toString("ascii") !== "00" ||
      header.subarray(156, 157).toString("ascii") !== "0"
    ) {
      throw new TypeError("release archive contains an unsupported entry type");
    }
    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const archivePath = prefix.length > 0 ? `${prefix}/${name}` : name;
    if (!archivePath.startsWith("payload/")) {
      throw new TypeError("release archive entry is outside payload/");
    }
    const filePath = archivePath.slice("payload/".length);
    assertReleasePath(filePath);
    if (
      previousPath !== null &&
      compareCodeUnits(previousPath, filePath) >= 0
    ) {
      throw new TypeError(
        "release archive paths must be strictly sorted and unique"
      );
    }
    previousPath = filePath;
    const modeValue = parseOctal(header.subarray(100, 108), "mode");
    const mode = modeValue === 0o644 ? "100644" : modeValue === 0o755 ? "100755" : null;
    if (
      mode === null ||
      parseOctal(header.subarray(108, 116), "uid") !== 0 ||
      parseOctal(header.subarray(116, 124), "gid") !== 0 ||
      parseOctal(header.subarray(136, 148), "mtime") !== 0
    ) {
      throw new TypeError("release archive mode, owner, or timestamp drifted");
    }
    const size = parseOctal(header.subarray(124, 136), "size");
    const canonicalHeader = tarHeader(archivePath, mode, size);
    if (!header.equals(canonicalHeader)) {
      throw new TypeError("release archive header differs from canonical ustar");
    }
    if (size > MAX_FILE_BYTES) throw new TypeError("release archive entry exceeds the byte bound");
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.byteLength) throw new TypeError("release archive entry is truncated");
    const content = archive.subarray(dataStart, dataEnd);
    observed.push({
      path: filePath,
      type: "file",
      mode,
      size,
      digest: sha256Bytes(content)
    });
    if (observed.length > MAX_FILES) throw new TypeError("release archive has too many entries");
    const nextOffset = dataStart + Math.ceil(size / 512) * 512;
    if (!archive.subarray(dataEnd, nextOffset).every((byte) => byte === 0)) {
      throw new TypeError("release archive padding is nonzero");
    }
    offset = nextOffset;
  }
  if (
    !ended ||
    canonicalJson(observed) !== canonicalJson(stableManifest.files)
  ) {
    throw new TypeError("release archive files differ from the closed manifest");
  }
  assertStrictlySortedPaths(stableManifest.files, "release manifest");
}

function createSpdx(manifest: ReleaseManifest, files: readonly GitTreeFile[]): SpdxDocument {
  return createRootSpdxDocument({
    packageName: "agentic-framework",
    packageVersion: manifest.packageVersion,
    headSha: manifest.source.headSha,
    sourceDateEpoch: manifest.source.sourceDateEpoch,
    licenseDeclared: "MIT",
    dependencyPackages: lockPackages(requiredFile(files, "package-lock.json"))
  });
}

export function validateSpdxDocument(value: unknown): SpdxDocument {
  const snapshot = structuredClone(value);
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  ) {
    throw new TypeError("SPDX document must be an object");
  }
  const document = snapshot as Readonly<Record<string, unknown>>;
  const expectedDocumentKeys = [
    "SPDXID",
    "creationInfo",
    "dataLicense",
    "documentNamespace",
    "name",
    "packages",
    "spdxVersion"
  ];
  if (
    canonicalJson(Object.keys(document).sort(compareCodeUnits)) !==
      canonicalJson(expectedDocumentKeys) ||
    document["spdxVersion"] !== "SPDX-2.3" ||
    document["dataLicense"] !== "CC0-1.0" ||
    document["SPDXID"] !== "SPDXRef-DOCUMENT" ||
    typeof document["name"] !== "string" ||
    typeof document["documentNamespace"] !== "string" ||
    !Array.isArray(document["packages"]) ||
    document["packages"].length < 1
  ) {
    throw new TypeError("SPDX document shape is invalid");
  }
  const creation = document["creationInfo"];
  if (
    typeof creation !== "object" ||
    creation === null ||
    Array.isArray(creation) ||
    canonicalJson(Object.keys(creation).sort(compareCodeUnits)) !==
      canonicalJson(["created", "creators"]) ||
    typeof (creation as Readonly<Record<string, unknown>>)["created"] !== "string" ||
    canonicalJson(
      (creation as Readonly<Record<string, unknown>>)["creators"]
    ) !== canonicalJson(["Tool: agentic-framework-release-tool"])
  ) {
    throw new TypeError("SPDX creation information is invalid");
  }
  const identifiers = new Set<string>();
  for (const candidate of document["packages"]) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new TypeError("SPDX package must be an object");
    }
    const packageRecord = candidate as Readonly<Record<string, unknown>>;
    const keys = Object.keys(packageRecord).sort(compareCodeUnits);
    const withoutChecksums = [
      "SPDXID",
      "copyrightText",
      "downloadLocation",
      "filesAnalyzed",
      "licenseConcluded",
      "licenseDeclared",
      "name",
      "versionInfo"
    ];
    const withChecksums = [...withoutChecksums, "checksums"].sort(compareCodeUnits);
    const identifier = packageRecord["SPDXID"];
    if (
      (canonicalJson(keys) !==
        canonicalJson(withoutChecksums.sort(compareCodeUnits)) &&
        canonicalJson(keys) !== canonicalJson(withChecksums)) ||
      typeof identifier !== "string" ||
      identifiers.has(identifier) ||
      typeof packageRecord["name"] !== "string" ||
      typeof packageRecord["versionInfo"] !== "string" ||
      packageRecord["downloadLocation"] !== "NOASSERTION" ||
      packageRecord["filesAnalyzed"] !== false ||
      packageRecord["licenseConcluded"] !== "NOASSERTION" ||
      typeof packageRecord["licenseDeclared"] !== "string" ||
      !isValidSpdxLicense(packageRecord["licenseDeclared"]) ||
      packageRecord["copyrightText"] !== "NOASSERTION"
    ) {
      throw new TypeError("SPDX package shape is invalid");
    }
    identifiers.add(identifier);
    const checksums = packageRecord["checksums"];
    if (checksums !== undefined) {
      if (!Array.isArray(checksums) || checksums.length < 1) {
        throw new TypeError("SPDX checksums must be a non-empty array");
      }
      for (const checksum of checksums) {
        if (
          typeof checksum !== "object" ||
          checksum === null ||
          Array.isArray(checksum)
        ) {
          throw new TypeError("SPDX checksum is invalid");
        }
        const record = checksum as Readonly<Record<string, unknown>>;
        const algorithm = record["algorithm"];
        const checksumValue = record["checksumValue"];
        if (
          canonicalJson(Object.keys(record).sort(compareCodeUnits)) !==
            canonicalJson(["algorithm", "checksumValue"]) ||
          (algorithm !== "SHA1" && algorithm !== "SHA512") ||
          typeof checksumValue !== "string" ||
          !/^[0-9a-f]+$/.test(checksumValue) ||
          checksumValue.length !== (algorithm === "SHA1" ? 40 : 128)
        ) {
          throw new TypeError("SPDX checksum shape is invalid");
        }
      }
    }
  }
  return snapshot as SpdxDocument;
}

function createProvenance(manifest: ReleaseManifest): ReleaseProvenance {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "UnsignedLocalProvenance",
    schemaVersion: "1.0.0",
    source: {
      server: manifest.source.server,
      repository: manifest.source.repository,
      baseSha: manifest.source.baseSha,
      headSha: manifest.source.headSha
    },
    packageVersion: manifest.packageVersion,
    buildType: "local-deterministic-source-archive",
    builder: "agentic-framework-release-tool",
    networkUsed: false,
    credentialsUsed: false,
    publicationPerformed: false,
    materials: [
      { path: "LICENSE", digest: manifest.licenseDigest },
      { path: "THIRD_PARTY_NOTICES.md", digest: manifest.noticesDigest },
      { path: "package-lock.json", digest: manifest.dependencyLockDigest },
      { path: "release-manifest.json", digest: digest(manifest) }
    ],
    limitations: [
      "unsigned-local-evidence",
      "no-production-key",
      "no-publication",
      "not-a-readiness-decision"
    ]
  };
}

function createAttestation(input: {
  readonly manifest: ReleaseManifest;
  readonly archive: Buffer;
  readonly sbom: SpdxDocument;
  readonly provenance: ReleaseProvenance;
}): ReleaseAttestation {
  const releaseManifestDigest = digest(input.manifest);
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "agentic-framework.tar",
        digest: { sha256: sha256Hex(input.archive) }
      },
      {
        name: "release-manifest.json",
        digest: { sha256: sha256Hex(canonicalFile(input.manifest)) }
      }
    ],
    predicateType: "https://agentic-framework.github.com/attestations/unsigned-local-release/v1",
    predicate: {
      packageVersion: input.manifest.packageVersion,
      baseSha: input.manifest.source.baseSha,
      headSha: input.manifest.source.headSha,
      releaseManifestDigest,
      sbomDigest: digest(input.sbom),
      provenanceDigest: digest(input.provenance),
      signed: false,
      trust: "untrusted-until-human-release-service-signs",
      statement: "This binds local bytes and source identity only; it does not attest review, security, readiness, or publication approval."
    }
  };
}

function createReleaseCandidate(input: {
  readonly manifest: ReleaseManifest;
  readonly archive: Buffer;
  readonly sbom: SpdxDocument;
  readonly provenance: ReleaseProvenance;
  readonly attestation: ReleaseAttestation;
}): ReleaseCandidateChecklist {
  const exactHeadChecks = [
    "npm-clean-install",
    "typecheck",
    "build",
    "full-tests",
    "schema-validation",
    "runtime-validation",
    "eval-fixture-validation",
    "provenance-validation",
    "workflow-validation",
    "gh-aw-validation",
    "packaging-validation",
    "dependency-audit",
    "git-diff-check",
    "codeql",
    "dependency-review",
    "secret-scanning",
    "independent-security-review",
    "independent-code-review"
  ];
  const humanChecks = [
    "human-release-approval",
    "ospo-legal-approval",
    "security-approval",
    "product-approval",
    "administrator-live-validation"
  ];
  const checklist: ReleaseCandidateChecklist = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "ReleaseCandidateChecklist",
    schemaVersion: "1.0.0",
    packageVersion: input.manifest.packageVersion,
    headSha: input.manifest.source.headSha,
    archiveDigest: sha256Bytes(input.archive),
    releaseManifestDigest: digest(input.manifest),
    sbomDigest: digest(input.sbom),
    provenanceDigest: digest(input.provenance),
    attestationDigest: digest(input.attestation),
    decision: "no-go",
    authoritative: false,
    selfApproved: false,
    checks: [
      ...exactHeadChecks.map((id) => ({
        id,
        status: "requires-exact-head-evidence" as const,
        evidenceDigest: null
      })),
      ...humanChecks.map((id) => ({
        id,
        status: "requires-human-approval" as const,
        evidenceDigest: null
      })),
      {
        id: "ghes",
        status: "unsupported" as const,
        evidenceDigest: null
      }
    ],
    residualRisks: [
      "Trusted deployment services and production key custody are not implemented.",
      "Administrator settings can drift after validation.",
      "Some future GitHub effects may not be reversible.",
      "Unsigned local evidence does not establish release trust."
    ],
    deploymentPrerequisites: [
      "Human-installed least-privilege GitHub App with no PAT fallback.",
      "Independent OIDC redeemer, evidence signer, credential broker, durable stores, and Single Writer.",
      "Human-configured rulesets, Project, GHAS, billing, teams, visibility, monitoring, and retention."
    ],
    unsupportedEnvironments: [
      "GitHub Enterprise Server is unverified and unsupported.",
      "Node.js majors other than the checked compatibility matrix fail closed.",
      "Unpinned gh-aw or Copilot CLI runtimes are unsupported."
    ],
    rollbackLimits: [
      "External GitHub effects may require human reconciliation.",
      "Irreversible migration steps cannot be rolled back.",
      "Uninstall preserves evidence and customer content rather than recursively deleting a target."
    ],
    manualLiveProbes: [
      "Pinned reviewer-runtime live agent resolution and denial probe.",
      "GitHub App permission and target-binding validation.",
      "Ruleset, Dependency Review, CodeQL, and secret-scanning verification."
    ],
    noGoConditions: [
      "Any required exact-head evidence is absent, stale, skipped, warning, or failed.",
      "Any security alert is introduced by the candidate.",
      "Source, dependency, manifest, archive, SBOM, provenance, or attestation binding differs.",
      "Any required human administrator, security, product, OSPO, or legal gate is unresolved.",
      "Publication, signing, or deployment authority is inferred from model output."
    ]
  };
  return assertPackagingKind(checklist, "ReleaseCandidateChecklist");
}

export function buildReleaseBundle(input: {
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
}): ReleaseBundleResult {
  const request = {
    repositoryRoot: input.repositoryRoot,
    outputRoot: input.outputRoot,
    baseSha: input.baseSha,
    headSha: input.headSha,
    packageVersion: input.packageVersion
  };
  const root = canonicalDirectory(request.repositoryRoot, "release repository root");
  assertSupportedGitVersion(root);
  assertGitTopLevel(root);
  const plannedOutputRoot = safeOutputPath(request.outputRoot);
  assertOutsideRepositoryMetadata(root, plannedOutputRoot);
  const source = assertExactHead(root, request.baseSha, request.headSha);
  const files = readGitTree(root, request.headSha);
  if (packageVersionFrom(files) !== request.packageVersion) {
    throw new TypeError("requested release version differs from package.json");
  }
  const sourceDateEpochText = gitText(root, ["show", "-s", "--format=%ct", request.headSha]);
  const sourceDateEpoch = Number(sourceDateEpochText);
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new TypeError("release commit timestamp is invalid");
  }
  const manifest = assertPackagingKind<ReleaseManifest>(
    {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "ReleaseManifest",
      schemaVersion: "1.0.0",
      packageName: "agentic-framework",
      packageVersion: request.packageVersion,
      source: {
        ...source,
        baseSha: request.baseSha,
        headSha: request.headSha,
        sourceDateEpoch
      },
      dependencyLockDigest: requiredFile(files, "package-lock.json").digest,
      licenseDigest: requiredFile(files, "LICENSE").digest,
      noticesDigest: requiredFile(files, "THIRD_PARTY_NOTICES.md").digest,
      files: files.map(({ oid: _oid, content: _content, ...file }) => file)
    },
    "ReleaseManifest"
  );
  if (
    manifest.licenseDigest !== EXPECTED_LICENSE_DIGEST ||
    manifest.noticesDigest !== EXPECTED_NOTICES_DIGEST
  ) {
    throw new TypeError(
      "release license or notices differ from the reviewed baseline"
    );
  }
  const archive = createDeterministicTar(files);
  verifyDeterministicTar(archive, manifest);
  const sbom = validateSpdxDocument(createSpdx(manifest, files));
  const provenance = createProvenance(manifest);
  const attestation = createAttestation({ manifest, archive, sbom, provenance });
  const releaseCandidate = createReleaseCandidate({
    manifest,
    archive,
    sbom,
    provenance,
    attestation
  });
  const outputRoot = assertSafeOutputRoot(plannedOutputRoot);
  const outputs: Readonly<Record<string, Buffer>> = {
    "agentic-framework.tar": archive,
    "attestation.json": canonicalFile(attestation),
    "provenance.json": canonicalFile(provenance),
    "release-candidate.json": canonicalFile(releaseCandidate),
    "release-manifest.json": canonicalFile(manifest),
    "sbom.spdx.json": canonicalFile(sbom)
  };
  for (const [name, content] of Object.entries(outputs)) {
    writeExclusive(outputRoot, name, content);
  }
  writeExclusive(outputRoot, "checksums.txt", createChecksums(outputs));
  return {
    archiveDigest: sha256Bytes(archive),
    releaseManifestDigest: digest(manifest),
    sbomDigest: digest(sbom),
    provenanceDigest: digest(provenance),
    attestationDigest: digest(attestation),
    releaseCandidateDigest: digest(releaseCandidate),
    outputRoot
  };
}


export function verifyReleaseBundle(input: {
  readonly repositoryRoot: string;
  readonly bundleRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
  readonly requireTrustedAttestation: boolean;
}): ReleaseBundleResult {
  const request = {
    repositoryRoot: input.repositoryRoot,
    bundleRoot: input.bundleRoot,
    baseSha: input.baseSha,
    headSha: input.headSha,
    packageVersion: input.packageVersion,
    requireTrustedAttestation: input.requireTrustedAttestation
  };
  const repositoryRoot = canonicalDirectory(
    request.repositoryRoot,
    "release repository root"
  );
  assertSupportedGitVersion(repositoryRoot);
  assertGitTopLevel(repositoryRoot);
  const bundleRoot = canonicalDirectory(request.bundleRoot, "release bundle root");
  assertOutsideRepositoryMetadata(repositoryRoot, bundleRoot);
  const source = assertExactHead(
    repositoryRoot,
    request.baseSha,
    request.headSha
  );
  validateBundleOutputDirectory(bundleRoot, OUTPUT_FILES);
  verifyBundleChecksums(bundleRoot, OUTPUT_FILES);
  const manifest = assertPackagingKind<ReleaseManifest>(
    readCanonicalJson(path.join(bundleRoot, "release-manifest.json")),
    "ReleaseManifest"
  );
  if (
    manifest.packageVersion !== request.packageVersion ||
    manifest.source.server !== source.server ||
    manifest.source.repository !== source.repository ||
    manifest.source.baseSha !== request.baseSha ||
    manifest.source.headSha !== request.headSha
  ) {
    throw new TypeError("release manifest source or version binding mismatch");
  }
  const sourceDateEpoch = Number(
    gitText(repositoryRoot, ["show", "-s", "--format=%ct", request.headSha])
  );
  if (
    !Number.isSafeInteger(sourceDateEpoch) ||
    sourceDateEpoch !== manifest.source.sourceDateEpoch
  ) {
    throw new TypeError("release manifest commit timestamp binding mismatch");
  }
  const sourceFiles = readGitTree(repositoryRoot, request.headSha);
  if (
    packageVersionFrom(sourceFiles) !== request.packageVersion ||
    manifest.licenseDigest !== EXPECTED_LICENSE_DIGEST ||
    manifest.noticesDigest !== EXPECTED_NOTICES_DIGEST
  ) {
    throw new TypeError(
      "release source version, license, or notices baseline mismatch"
    );
  }
  const expectedFiles = sourceFiles.map(({ oid: _oid, content: _content, ...file }) => file);
  if (canonicalJson(expectedFiles) !== canonicalJson(manifest.files)) {
    throw new TypeError("release manifest differs from the exact source tree");
  }
  if (
    requiredFile(sourceFiles, "package-lock.json").digest !== manifest.dependencyLockDigest ||
    requiredFile(sourceFiles, "LICENSE").digest !== manifest.licenseDigest ||
    requiredFile(sourceFiles, "THIRD_PARTY_NOTICES.md").digest !== manifest.noticesDigest
  ) {
    throw new TypeError("release material digest drifted");
  }
  const archive = readFileSync(path.join(bundleRoot, "agentic-framework.tar"));
  verifyDeterministicTar(archive, manifest);
  if (!archive.equals(createDeterministicTar(sourceFiles))) {
    throw new TypeError(
      "release archive bytes are not the deterministic exact-tree encoding"
    );
  }
  const sbom = validateSpdxDocument(
    readCanonicalJson(path.join(bundleRoot, "sbom.spdx.json"))
  );
  const provenance = readCanonicalJson(path.join(bundleRoot, "provenance.json")) as ReleaseProvenance;
  const attestation = readCanonicalJson(path.join(bundleRoot, "attestation.json")) as ReleaseAttestation;
  const releaseCandidate = assertPackagingKind<ReleaseCandidateChecklist>(
    readCanonicalJson(path.join(bundleRoot, "release-candidate.json")),
    "ReleaseCandidateChecklist"
  );
  if (
    canonicalJson(sbom) !== canonicalJson(createSpdx(manifest, sourceFiles)) ||
    canonicalJson(provenance) !== canonicalJson(createProvenance(manifest)) ||
    canonicalJson(attestation) !== canonicalJson(createAttestation({ manifest, archive, sbom, provenance })) ||
    canonicalJson(releaseCandidate) !==
      canonicalJson(createReleaseCandidate({ manifest, archive, sbom, provenance, attestation }))
  ) {
    throw new TypeError("release evidence is stale or has a subject/predicate binding mismatch");
  }
  if (request.requireTrustedAttestation) {
    throw new TypeError("bundle contains unsigned local evidence, not a trusted release attestation");
  }
  return {
    archiveDigest: sha256Bytes(archive),
    releaseManifestDigest: digest(manifest),
    sbomDigest: digest(sbom),
    provenanceDigest: digest(provenance),
    attestationDigest: digest(attestation),
    releaseCandidateDigest: digest(releaseCandidate),
    outputRoot: bundleRoot
  };
}

export function validateOpenSourceAssessment(
  value: unknown,
  expectedPackageVersion: string
): OpenSourceReadinessAssessment {
  const assessment = assertPackagingKind<OpenSourceReadinessAssessment>(
    value,
    "OpenSourceReadinessAssessment"
  );
  const expectedCategories = [
    "build-reproducibility",
    "contribution-security-governance",
    "dependency-licensing",
    "internal-references",
    "license-notice-provenance",
    "release-signing",
    "secrets-customer-data",
    "support-sla",
    "trademarks-branding"
  ];
  const actual = assessment.categories.map((category) => category.id).sort();
  if (
    assessment.packageVersion !== expectedPackageVersion ||
    canonicalJson(actual) !== canonicalJson(expectedCategories)
  ) {
    throw new TypeError("open-source readiness assessment is incomplete or stale");
  }
  return structuredClone(assessment);
}
