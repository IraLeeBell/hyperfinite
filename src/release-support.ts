// Internal shared primitives for the release (src/release.ts) and
// customer-starter (src/customer-starter.ts) packaging tools.
//
// This module is deliberately NOT re-exported from src/index.ts. It exists
// so the two tools can share exact-Git-tree reading, path/hash, output-
// safety, and canonicalization logic without duplicating it or growing the
// package's public API surface. Keep this file free of release- or
// starter-specific business logic (SBOM/provenance/tar/preflight shape);
// that stays in the tool-specific module that owns the concept.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  type Stats
} from "node:fs";
import path from "node:path";

import { canonicalJson } from "./canonical.js";
import type { PackagingDocument, ReleaseFile } from "./packaging-types.js";
import type { Digest } from "./types.js";
import { assertDocument } from "./validation.js";
import { assertReleasePath } from "./release-path.js";

export const MAX_ARCHIVE_BYTES = 67_108_864;
export const MAX_FILE_BYTES = 8_388_608;
export const MAX_FILES = 512;
export const EXPECTED_LICENSE_DIGEST =
  "sha256:60eb5d7deb8d13876be870afae1481c3b8a9446f062f0d99fdef38ac0945646a";
export const EXPECTED_NOTICES_DIGEST =
  "sha256:1e5eabc4458bd403ae53bc1a602ab69d75e0c46cffe83b705e66077bda07bc0d";
const MINIMUM_GIT_VERSION = [2n, 46n, 0n] as const;
export const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true
});

export interface GitTreeFile extends ReleaseFile {
  readonly oid: string;
  readonly content: Buffer;
}

function assertReleaseFilePath(value: string): void {
  assertReleasePath(value);
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertStrictlySortedPaths(
  files: readonly Pick<ReleaseFile, "path">[],
  subject: string
): void {
  let previous: string | null = null;
  for (const file of files) {
    assertReleaseFilePath(file.path);
    if (
      previous !== null &&
      compareCodeUnits(previous, file.path) >= 0
    ) {
      throw new TypeError(`${subject} paths must be strictly sorted and unique`);
    }
    previous = file.path;
  }
}

export function sha256Bytes(value: Uint8Array): Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    HOME: "/dev/null",
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? ""
  };
}

function runGit(
  root: string,
  args: readonly string[],
  encoding: BufferEncoding | null = "utf8",
  maxBuffer = MAX_ARCHIVE_BYTES
): string | Buffer {
  const result = spawnSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.attributesFile=/dev/null",
      "-c",
      "core.quotePath=false",
      "-C",
      root,
      ...args
    ],
    {
      encoding,
      env: fixedGitEnvironment(),
      maxBuffer,
      shell: false,
      timeout: 30_000
    }
  );
  if (result.status !== 0 || result.error !== undefined) {
    throw new TypeError(`fixed git command failed: git ${args[0] ?? ""}`);
  }
  return result.stdout ?? (encoding === null ? Buffer.alloc(0) : "");
}

export function gitText(root: string, args: readonly string[]): string {
  const value = runGit(root, args);
  if (typeof value !== "string") throw new TypeError("git returned binary text");
  return value.trim();
}

export function assertSupportedGitVersion(root: string): void {
  const version = gitText(root, ["--version"]);
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\D.*)?$/u.exec(version);
  if (match === null) {
    throw new TypeError("Git returned an unknown version");
  }
  const actual = [
    BigInt(match[1] ?? "0"),
    BigInt(match[2] ?? "0"),
    BigInt(match[3] ?? "0")
  ];
  for (let index = 0; index < MINIMUM_GIT_VERSION.length; index += 1) {
    const current = actual[index] ?? 0n;
    const minimum = MINIMUM_GIT_VERSION[index] ?? 0n;
    if (current > minimum) return;
    if (current < minimum) {
      throw new TypeError("Git 2.46.0 or newer is required");
    }
  }
}

export function assertGitTopLevel(root: string): void {
  const topLevel = path.resolve(gitText(root, ["rev-parse", "--show-toplevel"]));
  if (realpathSync(topLevel) !== root) {
    throw new TypeError("release repository root must equal the Git top-level");
  }
}

function gitMetadataDirectories(root: string): readonly string[] {
  return [
    gitText(root, ["rev-parse", "--absolute-git-dir"]),
    gitText(root, ["rev-parse", "--git-common-dir"])
  ].map((entry) => realpathSync(path.resolve(root, entry)));
}

function pathIsWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

export function assertOutsideRepositoryMetadata(
  repositoryRoot: string,
  candidate: string
): void {
  if (
    pathIsWithin(repositoryRoot, candidate) ||
    gitMetadataDirectories(repositoryRoot).some((directory) =>
      pathIsWithin(directory, candidate)
    )
  ) {
    throw new TypeError(
      "release output must remain outside the source repository and Git metadata"
    );
  }
}

export interface GitTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly oid: string;
}

const MAX_TREE_LISTING_ENTRIES = 20_000;

export function listGitTree(root: string, headSha: string): readonly GitTreeEntry[] {
  const listing = runGit(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", headSha],
    null
  );
  if (!Buffer.isBuffer(listing)) throw new TypeError("git tree listing was not binary");
  const records = UTF8_DECODER.decode(listing).split("\0").filter(Boolean);
  if (records.length < 1 || records.length > MAX_TREE_LISTING_ENTRIES) {
    throw new TypeError("release tree entry count is outside the closed bound");
  }
  const entries = records.map((record): GitTreeEntry => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/u.exec(record);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
      throw new TypeError("release tree contains a link, submodule, directory, or unsupported mode");
    }
    const mode = match[1] as "100644" | "100755";
    const oid = match[2];
    const filePath = match[3];
    assertReleaseFilePath(filePath);
    assertAsciiPortablePath(filePath);
    return { path: filePath, mode, oid };
  });
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1]?.path === entries[index]?.path) {
      throw new TypeError(`release tree has a duplicate path: ${entries[index]?.path}`);
    }
  }
  assertNoPortablePathCollisions(entries);
  return entries;
}

// String.prototype.toLowerCase() is exact and locale-independent only for
// the ASCII subrange; it is not a verified implementation of full Unicode
// case folding (the Unicode Consortium's CaseFolding.txt), so it silently
// misses real collisions on a case-insensitive filesystem for non-ASCII
// text -- for example Greek "Σ"/"σ"/final "ς" fold to the same identity
// under full case folding, and German "ß" expands under uppercasing, but
// neither is handled by a bare toLowerCase() comparison. Rather than ship
// an unverified partial case-fold, every release and customer-starter path
// is required to be ASCII (assertAsciiPortablePath below): the entire
// reviewed tree is ASCII today, so this is a deliberate, conservative
// policy choice, not a functional limitation, and it makes the toLowerCase
// comparison in assertNoPortablePathCollisions exact by construction.
function assertAsciiPortablePath(filePath: string): void {
  for (let index = 0; index < filePath.length; index += 1) {
    const codeUnit = filePath.charCodeAt(index);
    if (codeUnit < 0x20 || codeUnit > 0x7e) {
      throw new TypeError(
        `release path must be ASCII for portable-extraction collision safety (no verified Unicode case-fold is implemented): ${filePath}`
      );
    }
  }
}

// Two exact Git paths can be byte-distinct yet collide once extracted onto a
// case-insensitive and/or Unicode-normalizing filesystem (e.g. default macOS
// APFS or Windows NTFS): "README.md" vs "readme.md", or two paths that only
// differ by an unnormalized combining-character sequence. Detecting this in
// the shared tree listing protects every consumer that extracts an archive
// derived from this listing (the full release archive in src/release.ts and
// every customer-starter profile in src/customer-starter.ts), since a
// collision here would silently and non-deterministically drop or overwrite
// one of the two files depending on extraction order and host filesystem.
// Every path reaching this point has already passed assertAsciiPortablePath,
// so .normalize("NFC") is a documented no-op (ASCII text has no decomposable
// combining sequences) and .toLowerCase() is exact and locale-independent
// for the ASCII range -- there is no remaining Unicode case-fold ambiguity.
export function assertNoPortablePathCollisions(
  entries: readonly Pick<GitTreeEntry, "path">[]
): void {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    assertAsciiPortablePath(entry.path);
    const key = entry.path.normalize("NFC").toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined && existing !== entry.path) {
      throw new TypeError(
        `release tree has a portable-extraction path collision: ${existing} and ${entry.path}`
      );
    }
    seen.set(key, entry.path);
  }
}

export function readGitTreeFiles(
  root: string,
  entries: readonly GitTreeEntry[],
  bounds: {
    readonly maxFiles: number;
    readonly maxFileBytes: number;
    readonly maxArchiveBytes: number;
  }
): readonly GitTreeFile[] {
  if (entries.length < 1 || entries.length > bounds.maxFiles) {
    throw new TypeError("release tree file count is outside the closed bound");
  }
  let projectedArchiveBytes = 1024;
  const files = entries.map((entry): GitTreeFile => {
    const declaredSize = Number(gitText(root, ["cat-file", "-s", entry.oid]));
    if (
      !Number.isSafeInteger(declaredSize) ||
      declaredSize < 0 ||
      declaredSize > bounds.maxFileBytes
    ) {
      throw new TypeError(`release file exceeds the byte bound: ${entry.path}`);
    }
    projectedArchiveBytes += 512 + Math.ceil(declaredSize / 512) * 512;
    if (projectedArchiveBytes > bounds.maxArchiveBytes) {
      throw new TypeError("release archive exceeds the byte bound");
    }
    const content = runGit(root, ["cat-file", "blob", entry.oid], null, bounds.maxFileBytes + 1);
    if (
      !Buffer.isBuffer(content) ||
      content.byteLength !== declaredSize
    ) {
      throw new TypeError(`release file exceeds the byte bound: ${entry.path}`);
    }
    return {
      path: entry.path,
      type: "file",
      mode: entry.mode,
      size: content.byteLength,
      digest: sha256Bytes(content),
      oid: entry.oid,
      content
    };
  });
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  return files;
}

export function readGitTree(root: string, headSha: string): readonly GitTreeFile[] {
  return readGitTreeFiles(root, listGitTree(root, headSha), {
    maxFiles: MAX_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES
  });
}

export function isAncestorCommit(
  root: string,
  ancestorSha: string,
  descendantSha: string
): boolean {
  if (!/^[0-9a-f]{40}$/.test(ancestorSha) || !/^[0-9a-f]{40}$/.test(descendantSha)) {
    return false;
  }
  if (ancestorSha === descendantSha) return true;
  try {
    return gitText(root, ["merge-base", ancestorSha, descendantSha]) === ancestorSha;
  } catch {
    return false;
  }
}

export interface GitHubRepositorySource {
  readonly server: string;
  readonly repository: string;
}

export function githubRepositoryFromRemote(
  remote: string
): GitHubRepositorySource {
  const normalized = remote.replace(/\.git$/iu, "");
  const host = String.raw`(?:github\.com|[A-Za-z0-9-]+\.ghe\.com)`;
  const match =
    new RegExp(
      `^https://(${host})/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`,
      "iu"
    ).exec(normalized) ??
    new RegExp(
      `^git@(${host}):([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`,
      "iu"
    ).exec(normalized) ??
    new RegExp(
      `^ssh://git@(${host})/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)$`,
      "iu"
    ).exec(normalized);
  if (match === null) {
    throw new TypeError(
      "release source origin must be a canonical GitHub Enterprise Cloud repository URL"
    );
  }
  return {
    server: match[1]!.toLowerCase(),
    repository: `${match[2]}/${match[3]}`.toLowerCase()
  };
}

export function assertExactHead(
  root: string,
  baseSha: string,
  headSha: string
): GitHubRepositorySource {
  const source = githubRepositoryFromRemote(
    gitText(root, ["remote", "get-url", "origin"])
  );
  if (
    !/^[0-9a-f]{40}$/.test(baseSha) ||
    !/^[0-9a-f]{40}$/.test(headSha) ||
    gitText(root, ["rev-parse", "HEAD"]) !== headSha ||
    gitText(root, ["rev-parse", "refs/remotes/origin/main"]) !== baseSha ||
    gitText(root, ["merge-base", baseSha, headSha]) !== baseSha
  ) {
    throw new TypeError("release source is stale or does not descend from the exact base");
  }
  if (gitText(root, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new TypeError("release source worktree must be clean");
  }
  return source;
}

export function packageVersionFrom(files: readonly GitTreeFile[]): string {
  const packageFile = files.find((file) => file.path === "package.json");
  if (packageFile === undefined) throw new TypeError("release tree has no package.json");
  const parsed = JSON.parse(packageFile.content.toString("utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("package.json is invalid");
  }
  const version = (parsed as Readonly<Record<string, unknown>>)["version"];
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new TypeError("package.json version is not a canonical release version");
  }
  return version;
}

export function requiredFile(
  files: readonly GitTreeFile[],
  filePath: string
): GitTreeFile {
  const file = files.find((candidate) => candidate.path === filePath);
  if (file === undefined) throw new TypeError(`release tree lacks ${filePath}`);
  return file;
}

export function canonicalFile(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

// This module's canonicalDirectory/safeOutputPath/assertSafeOutputRoot/
// writeExclusive functions close a check-then-use (TOCTOU) symlink gap
// under an attacker-controlled *writable parent directory* (the classic
// shared, world-writable "/tmp" attack): the original checks confirmed a
// path was a non-symlink directory at the moment of the check, but never
// confirmed that directory was privately owned and free of group/other
// write access, and never re-validated identity after creating a new
// directory -- leaving a window between "we checked" and "we wrote"
// during which another process sharing the same host and writable parent
// could race a symlink swap in. These functions now additionally require
// the parent (for output) or the directory itself (for a path being read
// back, e.g. a verify bundleRoot/repositoryRoot) to be owned by the
// current process user and not group- or other-writable, and re-stat
// after any realpath resolution or directory creation to narrow the
// window further. This explicitly does NOT protect against an attacker
// who already has code-execution as the same user/process identity --
// only against a symlink swap or pre-positioned entry from a *different*
// identity sharing a writable parent directory.
const GROUP_OR_OTHER_WRITABLE_MODE_BITS = 0o022;

function assertPrivateDirectoryStat(stat: Stats, subject: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new TypeError(`${subject} must be owned by the current process user`);
  }
  if ((stat.mode & GROUP_OR_OTHER_WRITABLE_MODE_BITS) !== 0) {
    throw new TypeError(`${subject} must not be group- or other-writable`);
  }
}

export function canonicalDirectory(directory: string, subject: string): string {
  const resolved = path.resolve(directory);
  const stat = lstatSync(resolved);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink()
  ) {
    throw new TypeError(`${subject} must be a canonical non-symbolic-link directory`);
  }
  const canonical = realpathSync(resolved);
  // Re-stat the canonicalized path rather than trusting the pre-realpath
  // lstat above: realpathSync resolves each path component independently
  // and can itself race a symlink swap occurring between our initial
  // lstat and its own resolution, and a canonical path can differ in
  // identity from what was just lstat'd if a component changed
  // underneath us in that window.
  const canonicalStat = lstatSync(canonical);
  if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
    throw new TypeError(`${subject} must be a canonical non-symbolic-link directory`);
  }
  assertPrivateDirectoryStat(canonicalStat, subject);
  return canonical;
}

export function safeOutputPath(outputRoot: string): string {
  const resolved = path.resolve(outputRoot);
  if (!path.isAbsolute(resolved) || resolved === path.parse(resolved).root) {
    throw new TypeError("release output must be a non-root absolute path");
  }
  const parent = path.dirname(resolved);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new TypeError("release output parent must be a canonical non-symbolic-link directory");
  }
  const canonicalParent = realpathSync(parent);
  // As in canonicalDirectory: re-stat the canonicalized parent (closing
  // the lstat-then-realpath race) before trusting it, and before
  // requiring it be privately owned and non-group/other-writable -- an
  // attacker-writable shared parent (e.g. world-writable "/tmp" itself)
  // is exactly the scenario this hardening exists to reject, rather than
  // only rejecting it if it also happens to be a symlink.
  const canonicalParentStat = lstatSync(canonicalParent);
  if (!canonicalParentStat.isDirectory() || canonicalParentStat.isSymbolicLink()) {
    throw new TypeError("release output parent must be a canonical non-symbolic-link directory");
  }
  assertPrivateDirectoryStat(canonicalParentStat, "release output parent directory");
  return path.join(canonicalParent, path.basename(resolved));
}

export function assertSafeOutputRoot(outputRoot: string): string {
  const canonical = safeOutputPath(outputRoot);
  const parent = path.dirname(canonical);
  // mkdirSync with recursive:false is itself exclusive: it throws EEXIST
  // if anything at all -- file, directory, or symlink -- already exists
  // at this exact path, so it cannot silently succeed by following or
  // replacing a pre-positioned symlink.
  mkdirSync(canonical, { recursive: false, mode: 0o700 });
  // Revalidate identity/containment immediately after creation: mkdirSync
  // does not itself guarantee that what we just created is still
  // privately owned, non-symlink, and exactly the restrictive mode we
  // asked for after the fact, nor that the parent directory's own
  // identity has not changed since safeOutputPath validated it a moment
  // ago (a parent-replacement race in the window between that check and
  // this mkdirSync call). Re-stat and re-check both here to close that
  // window; if either check fails, the directory just created is not
  // safe to write into.
  const createdStat = lstatSync(canonical);
  if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
    throw new TypeError("release output directory was not created as a canonical non-symbolic-link directory");
  }
  assertPrivateDirectoryStat(createdStat, "release output directory");
  if ((createdStat.mode & 0o777) !== 0o700) {
    throw new TypeError("release output directory was not created with the exact expected restrictive mode");
  }
  if (realpathSync(parent) !== parent) {
    throw new TypeError("release output parent directory identity changed while creating the output directory");
  }
  return canonical;
}

const EXCLUSIVE_WRITE_FLAGS: number = (() => {
  const base = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  // O_NOFOLLOW is POSIX-only (undefined in fs.constants on platforms that
  // do not support it, e.g. Windows); when available it is additional,
  // belt-and-suspenders protection against opening through a symlink --
  // O_EXCL together with O_CREAT already refuses to open if *anything*
  // (including a symlink) exists at the target path at all, so this does
  // not change behavior where it is unavailable.
  const noFollow = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW;
  return typeof noFollow === "number" ? base | noFollow : base;
})();

export function writeExclusive(outputRoot: string, name: string, content: Buffer): void {
  const target = path.join(outputRoot, name);
  const descriptor = openSync(target, EXCLUSIVE_WRITE_FLAGS, 0o600);
  try {
    writeFileSync(descriptor, content);
  } finally {
    closeSync(descriptor);
  }
}


export function createChecksums(files: Readonly<Record<string, Buffer>>): Buffer {
  const lines = Object.entries(files)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([name, content]) => `${sha256Hex(content)}  ${name}`);
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function readCanonicalJson(filePath: string): unknown {
  const source = readFileSync(filePath);
  const parsed = JSON.parse(source.toString("utf8")) as unknown;
  if (!source.equals(canonicalFile(parsed))) {
    throw new TypeError(`${path.basename(filePath)} is not canonical JSON`);
  }
  return parsed;
}

export function validateBundleOutputDirectory(
  root: string,
  expectedFiles: readonly string[]
): void {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("bundle root must be a canonical directory");
  }
  const entries = readdirSync(root).sort();
  if (canonicalJson(entries) !== canonicalJson([...expectedFiles].sort())) {
    throw new TypeError("bundle contains unexpected or missing files");
  }
  for (const name of entries) {
    const file = lstatSync(path.join(root, name));
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.size > MAX_ARCHIVE_BYTES ||
      (file.mode & 0o777) !== 0o600
    ) {
      throw new TypeError(`bundle output is not a bounded regular file: ${name}`);
    }
  }
}

export function verifyBundleChecksums(
  root: string,
  expectedFiles: readonly string[]
): void {
  const expected = createChecksums(
    Object.fromEntries(
      expectedFiles
        .filter((name) => name !== "checksums.txt")
        .map((name) => [name, readFileSync(path.join(root, name))])
    )
  );
  const actual = readFileSync(path.join(root, "checksums.txt"));
  if (!actual.equals(expected)) throw new TypeError("bundle checksum file mismatch");
}

export function assertPackagingKind<T extends PackagingDocument>(
  value: unknown,
  kind: T["kind"]
): T {
  const snapshot = structuredClone(value);
  const document = assertDocument("PackagingDocument", snapshot);
  if (document.kind !== kind) throw new TypeError(`expected ${kind}`);
  return document as T;
}

export interface SpdxPackage {
  readonly SPDXID: string;
  readonly name: string;
  readonly versionInfo: string;
  readonly downloadLocation: "NOASSERTION";
  readonly filesAnalyzed: false;
  readonly licenseConcluded: "NOASSERTION";
  readonly licenseDeclared: string;
  readonly copyrightText: "NOASSERTION";
  readonly checksums?: readonly {
    readonly algorithm: "SHA1" | "SHA512";
    readonly checksumValue: string;
  }[];
}

export interface SpdxDocument {
  readonly spdxVersion: "SPDX-2.3";
  readonly dataLicense: "CC0-1.0";
  readonly SPDXID: "SPDXRef-DOCUMENT";
  readonly name: string;
  readonly documentNamespace: string;
  readonly creationInfo: {
    readonly created: string;
    readonly creators: readonly ["Tool: agentic-framework-release-tool"];
  };
  readonly packages: readonly SpdxPackage[];
}

export function lockPackages(lockFile: GitTreeFile): readonly SpdxPackage[] {
  const lock = JSON.parse(lockFile.content.toString("utf8")) as unknown;
  if (typeof lock !== "object" || lock === null || Array.isArray(lock)) {
    throw new TypeError("package-lock.json is invalid");
  }

  const packages = (lock as Readonly<Record<string, unknown>>)["packages"];
  if (typeof packages !== "object" || packages === null || Array.isArray(packages)) {
    throw new TypeError("package-lock.json has no closed packages map");
  }
  const result: SpdxPackage[] = [];
  for (const [packagePath, raw] of Object.entries(packages).sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (packagePath === "") continue;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError(`package-lock entry is invalid: ${packagePath}`);
    }
    const entry = raw as Readonly<Record<string, unknown>>;
    const version = entry["version"];
    if (typeof version !== "string") throw new TypeError(`package-lock version is missing: ${packagePath}`);
    const segments = packagePath.split("node_modules/");
    const name = segments.at(-1);
    if (name === undefined || name.length < 1) throw new TypeError("package-lock package name is invalid");
    const integrity = entry["integrity"];
    const checksum =
      typeof integrity === "string" &&
      (integrity.startsWith("sha1-") || integrity.startsWith("sha512-"))
        ? {
            algorithm: integrity.startsWith("sha1-")
              ? "SHA1" as const
              : "SHA512" as const,
            checksumValue: Buffer.from(
              integrity.slice(integrity.indexOf("-") + 1),
              "base64"
            ).toString("hex")
          }
        : null;
    result.push({
      SPDXID: `SPDXRef-Package-${result.length + 1}`,
      name,
      versionInfo: version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared:
        typeof entry["license"] === "string" ? entry["license"] : "NOASSERTION",
      copyrightText: "NOASSERTION",
      ...(checksum === null ? {} : { checksums: [checksum] })
    });
  }
  return result;
}

export function canonicalDateFromEpoch(epoch: number): string {
  const value = new Date(epoch * 1000).toISOString();
  return value.endsWith(".000Z") ? `${value.slice(0, -5)}Z` : value;
}

export function createRootSpdxDocument(input: {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly headSha: string;
  readonly sourceDateEpoch: number;
  readonly licenseDeclared: string;
  readonly dependencyPackages: readonly SpdxPackage[];
}): SpdxDocument {
  const root: SpdxPackage = {
    SPDXID: "SPDXRef-Package-Root",
    name: input.packageName,
    versionInfo: input.packageVersion,
    downloadLocation: "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: input.licenseDeclared,
    copyrightText: "NOASSERTION"
  };
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${input.packageName}-${input.packageVersion}`,
    documentNamespace: `https://agentic-framework.github.com/spdx/${input.headSha}/${input.packageVersion}`,
    creationInfo: {
      created: canonicalDateFromEpoch(input.sourceDateEpoch),
      creators: ["Tool: agentic-framework-release-tool"]
    },
    packages: [root, ...input.dependencyPackages]
  };
}
