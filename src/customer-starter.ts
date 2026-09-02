// Deterministic customer-starter and open-source-preflight tooling.
//
// This module produces a configurable, default-deny subset of the exact
// reviewed Git tree ("profile"), plus a deterministic bundle, SBOM,
// provenance record, and non-authoritative CustomerStarterPreflightReport.
// It reuses the release archive/path/hash/output-safety primitives in
// src/release-support.ts and src/release.ts instead of duplicating them.
// It never decides license, publication, visibility, or release; every
// preflight report remains `decision: "no-go"`, `authoritative: false`,
// `selfApproved: false`, and embeds the live, unresolved
// OpenSourceReadinessAssessment by exact digest.

import { readFileSync } from "node:fs";
import path from "node:path";

import MarkdownIt, { type Token } from "markdown-it";

import { canonicalJson, digest } from "./canonical.js";
import {
  createCustomerStarterProfileCatalogSeed,
  findProfileCatalogEntry,
  knownSelectionDocumentPathsFor,
  validateProfileCatalog,
  type CustomerStarterProfileCatalog
} from "./customer-starter-catalog.js";
import type {
  CustomerStarterManifest,
  CustomerStarterPreflightReport,
  CustomerStarterScanId,
  CustomerStarterSelection,
  OpenSourceReadinessAssessment
} from "./packaging-types.js";
import type { Digest } from "./types.js";
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
  type GitTreeEntry,
  type GitTreeFile,
  gitText,
  isAncestorCommit,
  listGitTree,
  lockPackages,
  MAX_ARCHIVE_BYTES,
  MAX_FILE_BYTES,
  packageVersionFrom,
  readCanonicalJson,
  readGitTreeFiles,
  requiredFile,
  safeOutputPath,
  sha256Bytes,
  validateBundleOutputDirectory,
  verifyBundleChecksums,
  writeExclusive
} from "./release-support.js";
import {
  createDeterministicTar,
  validateOpenSourceAssessment,
  validateSpdxDocument,
  type SpdxDocument
} from "./release.js";

const MAX_SELECTION_PREFIXES = 512;
const MAX_STARTER_FILES = 4096;
const OUTPUT_FILES = [
  "checksums.txt",
  "customer-starter.tar",
  "starter-manifest.json",
  "starter-preflight.json",
  "starter-provenance.json",
  "starter-sbom.spdx.json"
] as const;

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

// The production, reviewed profile catalog this module's public
// buildCustomerStarterBundle/verifyCustomerStarterBundle entry points
// always resolve. It is module-private (never exported from this file,
// so it is unreachable via any deep import of the compiled package) and
// recursively frozen immediately after its own independent call to
// createCustomerStarterProfileCatalogSeed() -- it shares no object graph
// with src/customer-starter-catalog.ts's own separately-frozen, exported
// CUSTOMER_STARTER_PROFILE_CATALOG inspection copy, so mutating that
// exported copy (which itself throws, being frozen) could not influence
// this reference even if freezing were somehow defeated there.
// scripts/customer-starter-local.ts (the real CLI) does not import
// src/customer-starter-catalog.ts at all and has no way to reach or
// substitute this value.
const SEALED_PROFILE_CATALOG: CustomerStarterProfileCatalog = deepFreeze(
  validateProfileCatalog(createCustomerStarterProfileCatalogSeed())
);

export interface CustomerStarterProvenance {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "UnsignedCustomerStarterProvenance";
  readonly schemaVersion: "1.0.0";
  readonly source: {
    readonly server: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly packageVersion: string;
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly buildType: "local-deterministic-customer-starter-bundle";
  readonly builder: "agentic-framework-customer-starter-tool";
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
    "not-a-readiness-decision",
    "selection-and-scan-configuration-are-reviewed-inputs-not-model-output"
  ];
}

export interface CustomerStarterBundleResult {
  readonly selectionDigest: Digest;
  readonly starterManifestDigest: Digest;
  readonly sbomDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly preflightReportDigest: Digest;
  readonly archiveDigest: Digest;
  readonly outputRoot: string;
}

export interface ScanDenylistEntry {
  readonly id: string;
  readonly pattern: string;
  readonly reason: string;
}

const DENYLIST_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function validateScanDenylist(value: unknown): readonly ScanDenylistEntry[] {
  if (!Array.isArray(value)) throw new TypeError("scan denylist must be an array");
  const seen = new Set<string>();
  const entries = value.map((raw): ScanDenylistEntry => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError("scan denylist entry must be an object");
    }
    const record = raw as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort(compareCodeUnits);
    if (canonicalJson(keys) !== canonicalJson(["id", "pattern", "reason"])) {
      throw new TypeError("scan denylist entry has an unexpected shape");
    }
    const { id, pattern, reason } = record;
    if (typeof id !== "string" || !DENYLIST_ID.test(id)) {
      throw new TypeError("scan denylist entry id is invalid");
    }
    if (typeof pattern !== "string" || pattern.length < 1 || pattern.length > 256) {
      throw new TypeError(`scan denylist entry ${id} pattern is invalid`);
    }
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 512) {
      throw new TypeError(`scan denylist entry ${id} reason is invalid`);
    }
    // eslint-disable-next-line no-new -- validates the pattern compiles
    new RegExp(pattern, "u");
    if (seen.has(id)) throw new TypeError(`scan denylist entry ${id} is duplicated`);
    seen.add(id);
    return { id, pattern, reason };
  });
  entries.sort((left, right) => compareCodeUnits(left.id, right.id));
  return entries;
}

export function validateCustomerStarterSelection(
  value: unknown,
  expectedSourceHeadSha: string,
  repositoryRootForAncestryCheck?: string,
  knownSelectionDocumentPaths: readonly string[] = []
): CustomerStarterSelection {
  const selection = assertPackagingKind<CustomerStarterSelection>(
    value,
    "CustomerStarterSelection"
  );
  const headMatches =
    selection.sourceHeadSha === expectedSourceHeadSha ||
    (repositoryRootForAncestryCheck !== undefined &&
      isAncestorCommit(
        repositoryRootForAncestryCheck,
        selection.sourceHeadSha,
        expectedSourceHeadSha
      ));
  if (!headMatches) {
    throw new TypeError(
      "customer-starter selection's reviewed sourceHeadSha is not the exact head or an ancestor of it"
    );
  }
  if (
    selection.includedPaths.length < 1 ||
    selection.includedPaths.length > MAX_SELECTION_PREFIXES ||
    selection.excludedPaths.length > MAX_SELECTION_PREFIXES
  ) {
    throw new TypeError("customer-starter selection prefix count is outside the closed bound");
  }
  assertStrictlySortedPaths(
    selection.includedPaths.map((entryPath) => ({ path: entryPath })),
    "customer-starter selection includedPaths"
  );
  assertStrictlySortedPaths(
    selection.excludedPaths.map((entryPath) => ({ path: entryPath })),
    "customer-starter selection excludedPaths"
  );
  if ((selection.extendsProfileId === null) !== (selection.baseSelectionDigest === null)) {
    throw new TypeError(
      "customer-starter selection extendsProfileId and baseSelectionDigest must both be null or both set"
    );
  }
  if (selection.extendsProfileId === selection.profileId) {
    throw new TypeError("customer-starter selection cannot extend itself");
  }
  // The ancestor check above only proves sourceHeadSha is a real commit
  // reachable from the build head; it says nothing about whether a file
  // matching includedPaths/excludedPaths was added, removed, or changed
  // between sourceHeadSha and the build head. resolvedClosureDigest closes
  // that gap: it must match both the exact resolution at sourceHeadSha
  // (proving the pinned value is not stale or fabricated) and the exact
  // resolution at the current build head (proving no drift since review).
  if (repositoryRootForAncestryCheck !== undefined) {
    const reviewedClosureDigest = computeResolvedClosureDigest(
      repositoryRootForAncestryCheck,
      selection,
      selection.sourceHeadSha,
      knownSelectionDocumentPaths
    );
    if (reviewedClosureDigest !== selection.resolvedClosureDigest) {
      throw new TypeError(
        "customer-starter selection resolvedClosureDigest does not match the exact resolution at its reviewed sourceHeadSha"
      );
    }
    const currentClosureDigest =
      selection.sourceHeadSha === expectedSourceHeadSha
        ? reviewedClosureDigest
        : computeResolvedClosureDigest(
            repositoryRootForAncestryCheck,
            selection,
            expectedSourceHeadSha,
            knownSelectionDocumentPaths
          );
    if (currentClosureDigest !== selection.resolvedClosureDigest) {
      throw new TypeError(
        "customer-starter selection's exact resolved closure has drifted since its reviewed sourceHeadSha: a file matching includedPaths/excludedPaths was added, removed, or its mode/content changed"
      );
    }
  }
  return selection;
}

/**
 * Loads and validates a profile's CustomerStarterSelection by resolving
 * profileId through the given, trusted profile catalog to its exact
 * committed selection-document path, then reading that document's exact
 * bytes directly from the exact reviewed Git tree at `headSha` -- never
 * from a caller-supplied in-memory object, and never from the working
 * directory (which may hold uncommitted edits the review never saw).
 * knownSelectionDocumentPaths used for the resolvedClosureDigest
 * recomputation is always exactly the given catalog's own set of
 * selection-document paths; there is no parameter through which a caller
 * of buildCustomerStarterBundle/verifyCustomerStarterBundle can supply an
 * alternate exemption list or an alternate selection object that is not
 * bound to this catalog.
 */
function loadCatalogSelection(
  root: string,
  headSha: string,
  catalog: CustomerStarterProfileCatalog,
  profileId: string
): CustomerStarterSelection {
  validateProfileCatalog(catalog);
  const entry = findProfileCatalogEntry(catalog, profileId);
  const listing = listGitTree(root, headSha);
  const selectionEntry = listing.find((candidate) => candidate.path === entry.selectionPath);
  if (selectionEntry === undefined) {
    throw new TypeError(
      `customer-starter profile ${profileId}'s catalog selection path ${entry.selectionPath} is not present in the exact reviewed tree at ${headSha}`
    );
  }
  const [selectionFile] = readGitTreeFiles(root, [selectionEntry], {
    maxFiles: 1,
    maxFileBytes: MAX_FILE_BYTES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES
  });
  if (selectionFile === undefined) {
    throw new TypeError("unreachable: customer-starter catalog selection file was not read");
  }
  const parsed = JSON.parse(selectionFile.content.toString("utf8")) as unknown;
  const selection = validateCustomerStarterSelection(
    parsed,
    headSha,
    root,
    knownSelectionDocumentPathsFor(catalog)
  );
  if (selection.profileId !== profileId) {
    throw new TypeError(
      `customer-starter profile ${profileId}'s catalog selection path resolves to a selection document whose own profileId is ${selection.profileId}`
    );
  }
  if (selection.extendsProfileId !== entry.extendsProfileId) {
    throw new TypeError(
      `customer-starter profile ${profileId}'s selection document extendsProfileId (${String(selection.extendsProfileId)}) does not match the catalog's declared extendsProfileId (${String(entry.extendsProfileId)})`
    );
  }
  return selection;
}

/**
 * Loads and validates a scan denylist document at an exact, catalog-
 * declared path directly from the exact reviewed Git tree at `headSha` --
 * never from a caller-supplied in-memory value, and never from the
 * working directory. A caller-suppliable denylist (even one supplied as
 * `[]`) would let an attacker force every scan to report "clean" while
 * doing no meaningful scanning at all; sourcing it exclusively from the
 * fixed profile catalog's declared path and the exact tree closes that
 * gap the same way loadCatalogSelection closes it for selections.
 */
function loadCatalogDenylist(
  root: string,
  headSha: string,
  relativePath: string
): readonly ScanDenylistEntry[] {
  const listing = listGitTree(root, headSha);
  const entry = listing.find((candidate) => candidate.path === relativePath);
  if (entry === undefined) {
    throw new TypeError(
      `customer-starter catalog denylist path ${relativePath} is not present in the exact reviewed tree at ${headSha}`
    );
  }
  const [denylistFile] = readGitTreeFiles(root, [entry], {
    maxFiles: 1,
    maxFileBytes: MAX_FILE_BYTES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES
  });
  if (denylistFile === undefined) {
    throw new TypeError("unreachable: customer-starter catalog denylist file was not read");
  }
  return validateScanDenylist(JSON.parse(denylistFile.content.toString("utf8")));
}

// The reviewed sourceHeadSha/resolvedClosureDigest pinning process is
// inherently self-referential: a selection document cannot commit a digest
// of a resolution that includes its own not-yet-committed final bytes, and
// a broad includedPaths prefix (e.g. "config/v1alpha1") can also
// incidentally cover a *different*, sibling profile's selection document
// (for example control-plane-core's blanket config/v1alpha1 prefix also
// matches demo-portfolio's own selection file), whose independent re-pin
// changes bytes without changing anything this profile's own reviewers
// actually reviewed. Both cases are resolved by excluding an explicit,
// caller-supplied set of exact paths -- never by matching file *content*
// or *shape*: an exclusion keyed by content would let any file anywhere in
// scope escape closure-drift detection simply by being reshaped to parse
// as `{"kind": "CustomerStarterSelection", ...}`, whether or not it is one
// of the system's real, known selection documents. The caller (ultimately
// scripts/customer-starter-local.ts's closed, reviewed PROFILES table) is
// the only party who may declare which paths are exempt, and only exact
// path equality is compared. Each selection document's own
// resolvedClosureDigest/baseSelectionDigest bindings are still
// independently validated whenever *that* profile is itself built or
// verified, so excluding a sibling selection document's path here does not
// skip its integrity checks.
function isKnownSelectionDocumentPath(
  filePath: string,
  knownSelectionDocumentPaths: readonly string[]
): boolean {
  return knownSelectionDocumentPaths.includes(filePath);
}

/**
 * Computes the digest binding a selection's includedPaths/excludedPaths
 * resolution to an exact tree (identified by resolutionHeadSha): a digest
 * over the sorted {path, mode, digest} of every file the selection resolves
 * to at that exact commit, excluding every path in
 * `knownSelectionDocumentPaths` (see isKnownSelectionDocumentPath for why
 * this must be an explicit path set, never inferred from file content).
 * Exported so the selection-authoring flow (scripts/customer-starter-local.ts)
 * can compute and pin the same value that validateCustomerStarterSelection
 * independently recomputes.
 */
export function computeResolvedClosureDigest(
  root: string,
  selection: Pick<CustomerStarterSelection, "profileId" | "includedPaths" | "excludedPaths">,
  resolutionHeadSha: string,
  knownSelectionDocumentPaths: readonly string[] = []
): Digest {
  const listing = listGitTree(root, resolutionHeadSha);
  const ownEntries = resolveSelectionOwnEntries(selection, listing);
  const ownFiles = readGitTreeFiles(root, ownEntries, {
    maxFiles: MAX_STARTER_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES
  });
  const closureFiles = ownFiles.filter(
    (file) => !isKnownSelectionDocumentPath(file.path, knownSelectionDocumentPaths)
  );
  return digest(
    closureFiles
      .map((file) => ({ path: file.path, mode: file.mode, digest: file.digest }))
      .sort((left, right) => compareCodeUnits(left.path, right.path))
  );
}

function prefixMatches(prefix: string, filePath: string): boolean {
  return filePath === prefix || filePath.startsWith(`${prefix}/`);
}

function resolveSelectionOwnEntries<T extends { readonly path: string }>(
  selection: Pick<CustomerStarterSelection, "includedPaths" | "excludedPaths">,
  allEntries: readonly T[]
): readonly T[] {
  for (const prefix of selection.includedPaths) {
    if (!allEntries.some((entry) => prefixMatches(prefix, entry.path))) {
      throw new TypeError(
        `customer-starter selection includedPaths entry matches no file in the exact tree: ${prefix}`
      );
    }
  }
  for (const prefix of selection.excludedPaths) {
    if (
      !allEntries.some(
        (entry) =>
          prefixMatches(prefix, entry.path) &&
          selection.includedPaths.some((included) => prefixMatches(included, entry.path))
      )
    ) {
      throw new TypeError(
        `customer-starter selection excludedPaths entry excludes nothing an includedPaths entry selected: ${prefix}`
      );
    }
  }
  const own = allEntries.filter(
    (entry) =>
      selection.includedPaths.some((prefix) => prefixMatches(prefix, entry.path)) &&
      !selection.excludedPaths.some((prefix) => prefixMatches(prefix, entry.path))
  );
  if (own.length < 1) {
    throw new TypeError("customer-starter selection resolves to zero files");
  }
  return [...own].sort((left, right) => compareCodeUnits(left.path, right.path));
}

function mergeEffectiveEntries<T extends { readonly path: string }>(
  baseEntries: readonly T[],
  ownEntries: readonly T[]
): readonly T[] {
  const basePaths = new Set(baseEntries.map((entry) => entry.path));
  for (const entry of ownEntries) {
    if (basePaths.has(entry.path)) {
      throw new TypeError(
        `customer-starter extension selection overlaps its base profile at: ${entry.path}`
      );
    }
  }
  const merged = [...baseEntries, ...ownEntries];
  merged.sort((left, right) => compareCodeUnits(left.path, right.path));
  return merged;
}

// --- Closure checks -------------------------------------------------------
//
// Every check below is a completeness check over the given selected file
// set: it never widens the selection and never guesses a fix. A violation
// throws, naming the offending source and the missing/extra target, so the
// selection author must adjust the reviewed selection document.

// The customer-starter tool's pinned `typescript` devDependency (7.x, the
// native "tsgo" rewrite) no longer exposes a synchronous single-file parse
// API (no `createSourceFile`/`forEachChild`) through its public entry
// points or its `unstable/ast` subpath export -- confirmed empirically; its
// only full-fidelity parsing surface is `unstable/sync`'s Program/Project
// API, which requires a real tsconfig-backed project and is unsuitable for
// scanning arbitrary in-memory Git blob content. In its absence, this scans
// a comment- and string-literal-aware redaction of the source (never the
// raw text) so specifiers are never matched inside comments or unrelated
// string/template content, which a bare regex over raw source cannot do.
const MODULE_FILE_EXTENSIONS = [".ts", ".mjs", ".cjs", ".js"] as const;

function isModuleImportClosureCandidate(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) return false;
  return MODULE_FILE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function resolveRelativeModuleSpecifier(fromPath: string, specifier: string): string {
  const dir = path.posix.dirname(fromPath);
  const resolved = path.posix.normalize(path.posix.join(dir, specifier));
  // TypeScript's NodeNext module resolution requires .ts sources to import
  // each other by their compiled ".js" output extension; .mjs/.cjs/.js
  // files are never compiled, so their specifiers already name the real
  // on-disk file and must not be rewritten.
  return fromPath.endsWith(".ts") && resolved.endsWith(".js")
    ? `${resolved.slice(0, -3)}.ts`
    : resolved;
}

/**
 * Returns a same-length redacted copy of `text` (comment/string/regex
 * interiors replaced with neutral filler, "x" for string/regex interiors
 * and " " for comments, leaving surrounding code and quote/backtick/slash
 * delimiters untouched so regex match offsets against the redacted text
 * correspond 1:1 to offsets in the original text), together with every
 * backtick template-literal span encountered during the same single scan
 * (used by extractRelativeModuleSpecifiers to additionally fail closed on
 * an interpolated relative module specifier, which cannot be resolved by
 * the plain redacted-text regex matching used for non-interpolated
 * specifiers). A template literal's fixed text is redacted the same as a
 * string, but each `${...}` interpolation is real code and is redacted by
 * recursively re-entering this same code-scanning logic, so a comment,
 * string, or import/require site written inside an interpolation is
 * redacted (and later matched) exactly as it would be at the top level --
 * not opaquely blanked out as if it were template text.
 *
 * A bare "/" is syntactically ambiguous in JavaScript/TypeScript between
 * division (or another operator use) and the start of a regex literal;
 * disambiguating requires knowing whether the position that precedes it
 * is a "value" (division) or an "expression start" (regex), the same
 * "expression position" heuristic real tokenizers (e.g. Acorn's
 * `beforeExpr` token property) use. This function tracks that state
 * (`ExpressionPosition`) as it scans, including a small stack of which
 * "(" openers immediately followed `if`/`for`/`while`/`switch`/`catch`
 * (so their matching ")" is known to precede a possible regex, exactly
 * matching how real tokenizers special-case those keywords) -- but only
 * when that keyword is not itself a property or optional-chain access
 * name (e.g. `obj.catch(fn)`, `obj?.catch(fn)`), which is an ordinary
 * value-producing method call, not the `catch` keyword. A postfix `++`/
 * `--` is tokenized as a single unit that always leaves the following
 * token in "value" position, since incrementing/decrementing always
 * yields a number and no valid JavaScript places a regex literal
 * immediately after one with no operator in between. Genuinely
 * undecidable cases -- a bare "/" directly following "}" (block vs.
 * object-literal close is not disambiguated here) or an unterminated
 * regex literal -- fail closed by throwing, rather than guessing, so
 * this scanner never silently mis-redacts a regex body as if it were
 * ordinary code (the failure mode that let a quote/backtick/"/*" inside
 * a regex body desynchronize string/comment tracking for the rest of the
 * file).
 */
function redactCommentsAndStrings(text: string): {
  readonly redacted: string;
  readonly templateLiteralSpans: readonly TemplateLiteralSpan[];
} {
  const out: string[] = new Array(text.length);
  const templateLiteralSpans: TemplateLiteralSpan[] = [];
  redactCode(text, out, 0, text.length, false, templateLiteralSpans);
  return { redacted: out.join(""), templateLiteralSpans };
}

/**
 * One backtick-delimited template literal encountered while redacting,
 * recorded regardless of whether it turns out to be used as a module
 * specifier. `start`/`end` bound the exact backtick delimiters (`end` is
 * exclusive, i.e. one past the closing backtick, or the scan's own `end`
 * bound if unterminated). `firstInterpolationIndex` is the source index
 * of the "$" of this template's own first *top-level* `${` (not one
 * belonging to a nested template inside an interpolation), or `null` if
 * this template has no interpolation at all.
 */
interface TemplateLiteralSpan {
  readonly start: number;
  readonly end: number;
  readonly hasInterpolation: boolean;
  readonly firstInterpolationIndex: number | null;
}

/** Whether a "/" encountered next would start a regex literal, be a plain
 * operator use (division etc.), or is undecidable and must fail closed. */
type ExpressionPosition = "regex-ok" | "value" | "after-close-brace";

const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_$]/u;
const DIGIT_START = /[0-9]/u;
const NUMERIC_LITERAL = /^(?:0[xXoObB][0-9a-fA-F_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)n?/u;

/** Keywords that leave the following token in "expression start" position
 * (regex-ok), mirroring the `beforeExpr` keyword set real tokenizers use. */
const EXPRESSION_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "yield",
  "await",
  "else",
  "do"
]);

/** Keywords whose immediately-following "(" is known to be a control-flow
 * condition, so its matching ")" leaves the next token regex-ok (e.g.
 * `if (x) /foo/.test(y)`), exactly matching Acorn's `updateContext` --
 * unless the identifier is itself a property or optional-chain access
 * name (`obj.catch(fn)`, `obj?.catch(fn)`), which is checked separately
 * where this set is consulted. */
const CONTROL_FLOW_KEYWORDS = new Set(["if", "for", "while", "switch", "catch"]);

/**
 * Redacts the code span [start, end) into `out`, returning the index just
 * past the last character consumed. When `insideTemplateExpression` is
 * true, a top-level (brace-balance-zero) "}" is not consumed: it belongs
 * to the enclosing `${...}` and scanning stops there so the caller
 * (redactTemplateLiteral) can consume it as the interpolation's own
 * delimiter, exactly mirroring how a real parser tracks brace balance to
 * find the end of a template interpolation. `templateLiteralSpans`
 * collects every backtick template literal span encountered anywhere in
 * this scan (including recursively, inside `${...}` interpolations), for
 * extractRelativeModuleSpecifiers to separately examine.
 */
function redactCode(
  text: string,
  out: string[],
  start: number,
  end: number,
  insideTemplateExpression: boolean,
  templateLiteralSpans: TemplateLiteralSpan[]
): number {
  let index = start;
  let braceDepth = 0;
  let expressionPosition: ExpressionPosition = "regex-ok";
  // Stack of whether each open "(" immediately followed a control-flow
  // keyword (if/for/while/switch/catch); consulted when its matching ")"
  // is scanned to decide the expression position after it.
  const parenIsControlFlow: boolean[] = [];
  let pendingControlFlowKeyword = false;
  // Whether the immediately preceding token was a property-access "."
  // or optional-chain "?." -- if so, the identifier this iteration is
  // about to scan (if any) is a property/method name (e.g. the "catch"
  // of `obj.catch(fn)`), never the "catch" control-flow keyword, even
  // though the two are lexically identical words.
  let precededByPropertyAccessDot = false;
  while (index < end) {
    const char = text[index];
    const next = text[index + 1];
    const isWhitespace = char !== undefined && /\s/u.test(char);
    // Snapshotted before the reset below (which fires on this same
    // iteration whenever an identifier starts, since an identifier's
    // first character is never "."/"?."): the identifier branch further
    // down needs the value as it was *entering* this iteration, not the
    // value already cleared for next time.
    const wasPrecededByPropertyAccessDot = precededByPropertyAccessDot;
    // A pending control-flow keyword is only ever consumed by the "("
    // immediately following it (optionally across whitespace, handled by
    // the identifier/"(" branches themselves); any other token clears it,
    // so a keyword used with no following "(" at all -- e.g. the ES2019
    // optional catch binding `try {} catch {}` -- does not leave a stale
    // flag that could incorrectly mark some later, unrelated "(" as a
    // control-flow paren.
    if (!isWhitespace && char !== "(") {
      pendingControlFlowKeyword = false;
    }
    // A property-access dot is only ever consumed by the identifier it
    // immediately precedes; any other token (including a second ".")
    // clears it.
    if (!isWhitespace && char !== "." && !(char === "?" && next === ".")) {
      precededByPropertyAccessDot = false;
    }
    if (char === "/" && next === "/") {
      while (index < end && text[index] !== "\n") {
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      out[index] = " ";
      out[index + 1] = " ";
      index += 2;
      while (index < end && !(text[index] === "*" && text[index + 1] === "/")) {
        out[index] = text[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      if (index < end) {
        out[index] = " ";
        out[index + 1] = " ";
        index += 2;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      const quote = char;
      out[index] = quote;
      index += 1;
      while (index < end && text[index] !== quote) {
        if (text[index] === "\\" && index + 1 < end) {
          out[index] = "x";
          out[index + 1] = "x";
          index += 2;
          continue;
        }
        out[index] = text[index] === "\n" ? "\n" : "x";
        index += 1;
      }
      if (index < end) {
        out[index] = quote;
        index += 1;
      }
      expressionPosition = "value";
      continue;
    }
    if (char === "`") {
      index = redactTemplateLiteral(text, out, index, end, templateLiteralSpans);
      expressionPosition = "value";
      continue;
    }
    if (char === "/" && next !== "/" && next !== "*") {
      if (expressionPosition === "after-close-brace") {
        throw new Error(
          "redactCommentsAndStrings: ambiguous \"/\" directly after \"}\" at offset " +
            String(index) +
            " -- cannot determine whether this starts a regex literal or is a division/other operator without full block-vs-object-literal parsing; refusing to guess"
        );
      }
      if (expressionPosition === "regex-ok") {
        index = redactRegexLiteral(text, out, index, end);
        expressionPosition = "value";
        continue;
      }
      // expressionPosition === "value": an ordinary operator use (e.g.
      // division), not a regex literal. Leave it untouched and treat the
      // token that follows as being in "regex-ok" position again.
      out[index] = char;
      index += 1;
      expressionPosition = "regex-ok";
      continue;
    }
    if (insideTemplateExpression && char === "{") {
      braceDepth += 1;
      out[index] = char ?? " ";
      index += 1;
      expressionPosition = "regex-ok";
      continue;
    }
    if (insideTemplateExpression && char === "}") {
      if (braceDepth === 0) return index;
      braceDepth -= 1;
      out[index] = char;
      index += 1;
      expressionPosition = "after-close-brace";
      continue;
    }
    if ((char === "+" && next === "+") || (char === "-" && next === "-")) {
      // A postfix (or prefix) "++"/"--" always yields a number, and no
      // valid JavaScript places a regex literal immediately after one
      // with no operator in between; tokenizing it as a single unit that
      // leaves the following token in "value" position fixes the
      // misclassification a per-character scan would otherwise produce
      // (each "+" individually would set "regex-ok", wrongly treating a
      // following "/" as a regex-literal start instead of division, e.g.
      // in `x++ / y`).
      out[index] = char;
      out[index + 1] = char;
      index += 2;
      expressionPosition = "value";
      continue;
    }
    if (char === "?" && next === ".") {
      // Optional-chain member access: the identifier this introduces
      // (e.g. the "catch" of `obj?.catch(fn)`) is a property/method
      // name, never a keyword.
      out[index] = char;
      out[index + 1] = next;
      index += 2;
      precededByPropertyAccessDot = true;
      expressionPosition = "regex-ok";
      continue;
    }
    if (char === "(") {
      out[index] = char ?? " ";
      index += 1;
      parenIsControlFlow.push(pendingControlFlowKeyword);
      pendingControlFlowKeyword = false;
      expressionPosition = "regex-ok";
      continue;
    }
    if (char === ")") {
      out[index] = char ?? " ";
      index += 1;
      const wasControlFlow = parenIsControlFlow.pop() ?? false;
      expressionPosition = wasControlFlow ? "regex-ok" : "value";
      continue;
    }
    if (char === "]") {
      out[index] = char ?? " ";
      index += 1;
      expressionPosition = "value";
      continue;
    }
    if (char === "}") {
      out[index] = char ?? " ";
      index += 1;
      expressionPosition = "after-close-brace";
      continue;
    }
    if (char === "[" || char === "{") {
      out[index] = char ?? " ";
      index += 1;
      expressionPosition = "regex-ok";
      continue;
    }
    if (char === ".") {
      // A property-access dot (e.g. `obj.catch`). A decimal-number dot is
      // never reached here: NUMERIC_LITERAL below consumes a leading
      // digit's entire token, including any embedded ".", in one step.
      out[index] = char;
      index += 1;
      precededByPropertyAccessDot = true;
      expressionPosition = "regex-ok";
      continue;
    }
    if (char !== undefined && IDENTIFIER_START.test(char)) {
      const wordStart = index;
      const isPropertyAccess = wasPrecededByPropertyAccessDot;
      index += 1;
      while (index < end) {
        const wordChar = text[index];
        if (wordChar === undefined || !IDENTIFIER_CONTINUE.test(wordChar)) break;
        index += 1;
      }
      const word = text.slice(wordStart, index);
      for (let copy = wordStart; copy < index; copy += 1) out[copy] = text[copy] ?? " ";
      // A keyword used as a property/method name (e.g. the "throw" of
      // `iter.throw(...)`, the "in"/"of"/"delete"/"return"/etc. of some
      // object's property) is an ordinary identifier whose value the
      // following token follows, not the real keyword -- exactly the
      // same property-access guard already applied below to
      // pendingControlFlowKeyword, but here for EXPRESSION_KEYWORDS
      // (which are checked immediately, not deferred to a matching "("),
      // so it must be applied to this assignment too, or a real division
      // immediately after such a property access (e.g. `iter.throw / 2`)
      // is wrongly read as starting a regex literal.
      expressionPosition = !isPropertyAccess && EXPRESSION_KEYWORDS.has(word) ? "regex-ok" : "value";
      // A control-flow keyword used as a property/method name (e.g. the
      // "catch" of `obj.catch(fn)`) is an ordinary identifier, not the
      // keyword: its matching "(" is a normal call, whose result is a
      // value, so it must not mark the following "(" as control-flow.
      pendingControlFlowKeyword = !isPropertyAccess && CONTROL_FLOW_KEYWORDS.has(word);
      precededByPropertyAccessDot = false;
      continue;
    }
    if (char !== undefined && DIGIT_START.test(char)) {
      const remaining = text.slice(index, end);
      const match = NUMERIC_LITERAL.exec(remaining);
      const length = match !== null && match[0].length > 0 ? match[0].length : 1;
      for (let copy = index; copy < index + length; copy += 1) out[copy] = text[copy] ?? " ";
      index += length;
      expressionPosition = "value";
      continue;
    }
    if (isWhitespace) {
      // Whitespace is grammatically transparent: leave expressionPosition
      // (and any pending control-flow keyword or property-access dot)
      // exactly as it was.
      out[index] = char ?? " ";
      index += 1;
      continue;
    }
    out[index] = char ?? " ";
    index += 1;
    // Any other single-character punctuation/operator (`+ - * % = < > ! &
    // | ^ ~ , : ;` etc.) is treated as leaving the following token in
    // expression-start position, matching the standard tokenizer
    // heuristic for operators that are not themselves a "value".
    expressionPosition = "regex-ok";
  }
  return index;
}

/**
 * Redacts one regex literal starting at the opening "/" at `start`
 * (already confirmed to be in regex-ok expression position, not `//` or
 * `/*`), returning the index just past its trailing flags. A "/" inside
 * an unescaped character class (`[...]`) does not terminate the regex,
 * matching JavaScript regex-literal grammar. Throws (fails closed) if the
 * literal is unterminated before `end` or before a line terminator, since
 * regex literals cannot span a raw newline.
 */
function redactRegexLiteral(text: string, out: string[], start: number, end: number): number {
  out[start] = "/";
  let index = start + 1;
  let inCharacterClass = false;
  while (index < end) {
    const char = text[index];
    if (char === "\n") {
      throw new Error(
        "redactCommentsAndStrings: unterminated regex literal starting at offset " +
          String(start) +
          " -- refusing to guess where it ends"
      );
    }
    if (char === "\\" && index + 1 < end) {
      out[index] = "x";
      out[index + 1] = "x";
      index += 2;
      continue;
    }
    if (char === "[") {
      inCharacterClass = true;
      out[index] = "x";
      index += 1;
      continue;
    }
    if (char === "]") {
      inCharacterClass = false;
      out[index] = "x";
      index += 1;
      continue;
    }
    if (char === "/" && !inCharacterClass) {
      out[index] = "/";
      index += 1;
      while (index < end) {
        const flagChar = text[index];
        if (flagChar === undefined || !IDENTIFIER_CONTINUE.test(flagChar)) break;
        out[index] = flagChar;
        index += 1;
      }
      return index;
    }
    out[index] = "x";
    index += 1;
  }
  throw new Error(
    "redactCommentsAndStrings: unterminated regex literal starting at offset " +
      String(start) +
      " -- refusing to guess where it ends"
  );
}

/**
 * Redacts one template literal starting at the opening backtick at
 * `start`, returning the index just past its closing backtick (or `end`
 * if it is unterminated). Fixed template text is redacted like a string;
 * each `${...}` interpolation recurses into redactCode as real code.
 * Records this template's exact span in `templateLiteralSpans` (used by
 * extractRelativeModuleSpecifiers to detect an interpolated relative
 * module specifier the redacted-text site regexes cannot themselves
 * match, since their `(x*)` capture only matches a *non*-interpolated
 * body).
 *
 * The `${`/`}` interpolation delimiters are redacted to the literal
 * characters themselves (not "x" word-character filler): "$" and "{" are
 * not JavaScript identifier characters, so preserving them guarantees a
 * `\b` word-boundary assertion still fires correctly immediately before
 * an identifier written at the very start of an interpolation -- e.g.
 * `` `${import("./x.js")}` ``, where filling "${" with "xx" would glue
 * two word characters directly onto "import", defeating the `\bimport`
 * anchor the site regexes rely on and silently hiding the import.
 */
function redactTemplateLiteral(
  text: string,
  out: string[],
  start: number,
  end: number,
  templateLiteralSpans: TemplateLiteralSpan[]
): number {
  out[start] = "`";
  let index = start + 1;
  let hasInterpolation = false;
  let firstInterpolationIndex: number | null = null;
  while (index < end) {
    if (text[index] === "\\" && index + 1 < end) {
      out[index] = "x";
      out[index + 1] = "x";
      index += 2;
      continue;
    }
    if (text[index] === "`") {
      out[index] = "`";
      const closeEnd = index + 1;
      templateLiteralSpans.push({ start, end: closeEnd, hasInterpolation, firstInterpolationIndex });
      return closeEnd;
    }
    if (text[index] === "$" && text[index + 1] === "{") {
      if (!hasInterpolation) {
        hasInterpolation = true;
        firstInterpolationIndex = index;
      }
      out[index] = text[index] as string;
      out[index + 1] = text[index + 1] as string;
      index = redactCode(text, out, index + 2, end, true, templateLiteralSpans);
      if (index < end && text[index] === "}") {
        out[index] = text[index] as string;
        index += 1;
      }
      continue;
    }
    out[index] = text[index] === "\n" ? "\n" : "x";
    index += 1;
  }
  templateLiteralSpans.push({ start, end: index, hasInterpolation, firstInterpolationIndex });
  return index;
}

// The third alternative in each delimiter class is a backtick, matching a
// no-substitution template-literal specifier such as
// `import(`./omitted.js`)`. redactTemplateLiteral redacts a template
// literal's fixed text to all-"x" filler and only leaves real characters
// where a `${...}` interpolation was recursively re-scanned as code, so
// the strict "(x*)" requirement between the backticks naturally matches
// only when the template literal has no interpolation at all -- a
// template literal WITH an interpolation can never match here (its
// interior is not all "x"); it is separately handled by
// extractRelativeModuleSpecifiers's templateLiteralSpans walk below,
// which fails closed rather than silently ignoring it.
const FROM_OR_BARE_IMPORT_SITE = /\b(?:from|import)\s*(['"`])(x*)\1/gud;
const DYNAMIC_IMPORT_SITE = /\bimport\s*\(\s*(['"`])(x*)\1\s*\)/gud;
const REQUIRE_CALL_SITE = /\brequire\s*\(\s*(['"`])(x*)\1\s*\)/gud;

// A site-lookback pattern: whether the redacted text immediately
// preceding a template literal's opening backtick looks like an
// import()/require()/bare-import/from module-specifier site. Used only
// to decide whether an *interpolated* template literal (one
// FROM_OR_BARE_IMPORT_SITE/DYNAMIC_IMPORT_SITE/REQUIRE_CALL_SITE cannot
// themselves match, since their capture group requires an all-"x",
// non-interpolated body) must fail closed rather than be silently
// ignored.
const MODULE_SPECIFIER_SITE_PREFIX =
  /(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\b(?:from|import)\s*)$/u;

function extractRelativeModuleSpecifiers(
  originalText: string,
  filePath: string
): readonly string[] {
  const { redacted, templateLiteralSpans } = redactCommentsAndStrings(originalText);
  const specifiers: string[] = [];
  for (const pattern of [FROM_OR_BARE_IMPORT_SITE, DYNAMIC_IMPORT_SITE, REQUIRE_CALL_SITE]) {
    for (const match of redacted.matchAll(pattern)) {
      const range = match.indices?.[2];
      if (range === undefined) continue;
      const specifier = originalText.slice(range[0], range[1]);
      // A quoted or no-substitution-template module specifier can contain
      // a backslash escape sequence (e.g. "\x2e/x.js" or `\u002e/x.js`)
      // that decodes to a leading "." at runtime without containing a
      // literal "." character in its raw source form, so a bare
      // startsWith(".") on the raw text alone would miss it -- the same
      // gap the interpolated-template check below already closes for
      // that one case, generalized here to every specifier form this
      // closure check recognizes (static import/from, dynamic import(),
      // require()). There is no reviewed string-escape decoder here, so
      // rather than assume any backslash-containing specifier is safely
      // non-relative, fail closed and require a human to either remove
      // the escape or extend this checker with an audited decoder.
      if (specifier.includes("\\")) {
        throw new TypeError(
          `customer-starter selection cannot verify a module specifier containing an escape sequence in ${filePath}: ${specifier} -- this closure check has no string-literal decoder and cannot determine whether an escaped character sequence resolves to a relative path`
        );
      }
      if (specifier.startsWith(".")) specifiers.push(specifier);
    }
  }
  // An interpolated template-literal specifier (e.g.
  // `import(`./${dir}/x.js`)`) is not matched by the regexes above at
  // all, since their `(x*)` capture only matches a body with zero
  // interpolation. There is no evaluator here to resolve what an
  // interpolation might produce, so rather than silently treat an
  // unresolvable specifier as absent (which would let an arbitrarily-
  // computed relative import bypass closure checking entirely), fail
  // closed whenever the template is used at a real module-specifier site
  // and its literal (non-interpolated) prefix cannot rule out a relative
  // path: an empty prefix (the interpolation starts at the very
  // beginning), a prefix starting with "." (unambiguously relative, e.g.
  // "./" or "../"), or a prefix containing a backslash all fail closed.
  // The backslash case matters because the prefix examined here is the
  // *raw source text*, not its decoded value: a prefix written as
  // `\x2e` or `\u002e` contains no literal "." character yet decodes to
  // "." at runtime, so a bare `startsWith(".")` on the raw text alone
  // would miss it; conservatively failing closed on any backslash in the
  // prefix (rather than implementing a second, separately-auditable
  // string-escape decoder here) closes that gap without an evaluator. A
  // non-empty, backslash-free prefix that does NOT start with "." (e.g.
  // `require(`lodash/${subpath}`)`) can never become relative merely by
  // interpolating more characters onto its end -- string concatenation
  // cannot retroactively insert a leading "." -- so it is left out of
  // scope exactly like any other non-"." bare specifier this closure
  // check does not resolve.
  for (const span of templateLiteralSpans) {
    if (!span.hasInterpolation) continue;
    const before = redacted.slice(0, span.start);
    if (!MODULE_SPECIFIER_SITE_PREFIX.test(before)) continue;
    const literalPrefixEnd = span.firstInterpolationIndex ?? span.end - 1;
    const literalPrefix = originalText.slice(span.start + 1, literalPrefixEnd);
    if (literalPrefix.length < 1 || literalPrefix.startsWith(".") || literalPrefix.includes("\\")) {
      throw new TypeError(
        `customer-starter selection cannot verify a dynamically interpolated relative module specifier in ${filePath}: ${originalText.slice(span.start, span.end)} -- this closure check has no evaluator and cannot resolve an interpolated relative import/require path`
      );
    }
  }
  return specifiers;
}

export function checkModuleImportClosure(
  files: readonly Pick<GitTreeFile, "path" | "content">[]
): void {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!isModuleImportClosureCandidate(file.path)) continue;
    const text = file.content.toString("utf8");
    for (const specifier of extractRelativeModuleSpecifiers(text, file.path)) {
      const resolved = resolveRelativeModuleSpecifier(file.path, specifier);
      if (!paths.has(resolved)) {
        throw new TypeError(
          `customer-starter selection is not closed under module imports: ${file.path} imports ${resolved}, which is not selected`
        );
      }
    }
  }
}

function collectSchemaRefTargets(node: unknown, refs: string[]): void {
  if (Array.isArray(node)) {
    for (const entry of node) collectSchemaRefTargets(entry, refs);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Readonly<Record<string, unknown>>;
  const ref = record["$ref"];
  if (typeof ref === "string") refs.push(ref);
  for (const value of Object.values(record)) collectSchemaRefTargets(value, refs);
}

export function checkSchemaReferenceClosure(
  files: readonly Pick<GitTreeFile, "path" | "content">[]
): void {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!file.path.endsWith(".schema.json")) continue;
    const parsed = JSON.parse(file.content.toString("utf8")) as unknown;
    const refs: string[] = [];
    collectSchemaRefTargets(parsed, refs);
    for (const ref of refs) {
      if (ref.startsWith("#")) continue; // same-document fragment
      const [targetPath] = ref.split("#");
      if (targetPath === undefined || targetPath.length < 1) continue;
      if (/^[a-z]+:\/\//u.test(targetPath)) continue; // absolute URL, not a bundle-relative file
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), targetPath)
      );
      if (!paths.has(resolved)) {
        throw new TypeError(
          `customer-starter selection is not closed under JSON Schema $ref: ${file.path} references ${resolved}, which is not selected`
        );
      }
    }
  }
}

export function checkGeneratedWorkflowSourceClosure(
  paths: readonly string[]
): void {
  const selected = new Set(paths);
  for (const filePath of paths) {
    if (!filePath.startsWith(".github/workflows/") || !filePath.endsWith(".lock.yml")) {
      continue;
    }
    const sourcePath = `${filePath.slice(0, -".lock.yml".length)}.md`;
    if (!selected.has(sourcePath)) {
      throw new TypeError(
        `customer-starter selection ships a generated workflow lock without its compiler-owned source: ${filePath} requires ${sourcePath}`
      );
    }
  }
}

const markdownParser = new MarkdownIt({ html: true, linkify: false });

function isExternalMarkdownTarget(target: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/iu.test(target) || // scheme (http:, https:, mailto:, etc.)
    target.startsWith("#")
  );
}

const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const RAW_HTML_LINK_OR_IMAGE_TAG = /<\s*(a|img)\b/iu;

// html_inline/html_block token content can legitimately contain an HTML
// comment whose text happens to mention "<a" or "<img" (e.g. documenting
// a link syntax); strip comment regions before testing so only a real,
// live raw HTML tag triggers rejection.
function stripHtmlComments(value: string): string {
  let previous: string;
  let current = value;
  do {
    previous = current;
    current = current.replace(HTML_COMMENT, "");
  } while (current !== previous);
  return current;
}

function containsRawHtmlLinkOrImageTag(content: string): boolean {
  return RAW_HTML_LINK_OR_IMAGE_TAG.test(stripHtmlComments(content));
}

interface MarkdownDestination {
  readonly target: string;
  readonly title: string | null;
}

// markdown-it's own parser resolves reference-style links/images
// (`[text][ref]` plus a `[ref]: target "title"` definition elsewhere in the
// document) into the same link_open/image tokens as inline links, and
// unescapes backslash-escaped destination characters -- so walking its
// token tree (recursing into `children`) covers inline links, reference
// links and their definitions, images, and autolinks uniformly, without
// the regex gaps (e.g. missed reference-style links) a hand-rolled pattern
// has. Parsing with `html: true` additionally surfaces raw HTML as
// `html_inline`/`html_block` tokens (rather than opaque plain text, which
// `html: false` would produce, silently hiding a raw `<a href>`/`<img src>`
// element from closure checking entirely); a raw HTML link or image
// element is rejected outright rather than resolved, since this tool does
// not implement an HTML attribute parser to validate its target. Fenced
// and indented code blocks, and inline code spans, are their own `fence`/
// `code_block`/`code_inline` token types (never html_inline/html_block),
// so a code example showing HTML syntax is never affected.
function collectMarkdownDestinations(
  text: string,
  filePath: string
): readonly MarkdownDestination[] {
  const destinations: MarkdownDestination[] = [];
  const visit = (tokens: readonly Token[]): void => {
    for (const token of tokens) {
      if (token.type === "link_open") {
        const href = token.attrGet("href");
        if (href !== null) destinations.push({ target: href, title: token.attrGet("title") });
      } else if (token.type === "image") {
        const source = token.attrGet("src");
        if (source !== null) destinations.push({ target: source, title: token.attrGet("title") });
      } else if (
        (token.type === "html_inline" || token.type === "html_block") &&
        containsRawHtmlLinkOrImageTag(token.content)
      ) {
        throw new TypeError(
          `customer-starter selection is not closed under Markdown links: ${filePath} contains a raw HTML link or image element, which closure checking does not resolve: ${token.content.trim()}`
        );
      }
      // "image" tokens are self-contained (no matching close token) and
      // store their alt text as `children`, unlike "link_open"/"link_close"
      // pairs which sit flat alongside their text; check the token's own
      // type unconditionally above, then always also recurse into any
      // children, rather than treating "has children" as mutually
      // exclusive with "is itself a link/image".
      if (token.children !== null) visit(token.children);
    }
  };
  visit(markdownParser.parse(text, {}));
  return destinations;
}

export function checkMarkdownLinkClosure(
  files: readonly Pick<GitTreeFile, "path" | "content">[]
): void {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!file.path.endsWith(".md")) continue;
    const text = file.content.toString("utf8");
    for (const destination of collectMarkdownDestinations(text, file.path)) {
      const target = destination.target;
      if (isExternalMarkdownTarget(target)) continue;
      if (destination.title === "external" || destination.title === "non-bundle") continue;
      const withoutFragment = target.split("#")[0];
      if (withoutFragment === undefined || withoutFragment.length < 1) continue;
      const isDirectoryLink = withoutFragment.endsWith("/");
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(file.path), withoutFragment)
      );
      const satisfied = isDirectoryLink
        ? [...paths].some((candidate) => prefixMatches(resolved.replace(/\/$/u, ""), candidate))
        : paths.has(resolved);
      if (!satisfied) {
        throw new TypeError(
          `customer-starter selection is not closed under Markdown links: ${file.path} links ${resolved}, which is not selected and is not annotated external`
        );
      }
    }
  }
}

const KNOWN_BARE_COMMANDS = new Set([
  "node",
  "npm",
  "tsc",
  "npx",
  "--",
  "-p",
  "-c"
]);

function packageScriptSourceCandidates(token: string): readonly string[] {
  const distMatch = /^dist\/(scripts|tests|src)\/(.+)\.js$/u.exec(token);
  if (distMatch?.[1] !== undefined && distMatch[2] !== undefined) {
    return [`${distMatch[1]}/${distMatch[2]}.ts`];
  }
  if (/^(scripts|tests|src)\/.+\.(ts|mjs|json)$/u.test(token)) return [token];
  if (token === "tsconfig.json" || token === "package.json" || token === "package-lock.json") {
    return [token];
  }
  return [];
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .split("*")
    .map((segment) => segment.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${escaped}$`, "u");
}

export function checkPackageScriptClosure(
  files: readonly Pick<GitTreeFile, "path" | "content">[],
  advertisedScripts: readonly string[]
): void {
  const packageJsonFile = files.find((file) => file.path === "package.json");
  if (packageJsonFile === undefined) return;
  const paths = files.map((file) => file.path);
  const pathSet = new Set(paths);
  const parsed = JSON.parse(packageJsonFile.content.toString("utf8")) as {
    readonly scripts?: Readonly<Record<string, string>>;
  };
  for (const name of advertisedScripts) {
    const command = parsed.scripts?.[name];
    if (command === undefined) {
      throw new TypeError(
        `customer-starter selection advertises package.json script "${name}", which package.json does not define`
      );
    }
    for (const rawToken of command.split(/\s+/u)) {
      const token = rawToken.trim();
      if (token.length < 1 || token.startsWith("-") || KNOWN_BARE_COMMANDS.has(token)) {
        continue;
      }
      if (token.includes("*")) {
        const distGlob = /^dist\/(scripts|tests|src)\/(.*)\.js$/u.exec(token);
        const sourceGlob =
          distGlob?.[1] !== undefined && distGlob[2] !== undefined
            ? `${distGlob[1]}/${distGlob[2]}.ts`
            : token;
        if (!paths.some((candidate) => globToRegExp(sourceGlob).test(candidate))) {
          throw new TypeError(
            `customer-starter selection is not closed under package.json scripts: advertised script "${name}" glob ${token} matches no selected file`
          );
        }
        continue;
      }
      for (const candidate of packageScriptSourceCandidates(token)) {
        if (!pathSet.has(candidate)) {
          throw new TypeError(
            `customer-starter selection is not closed under package.json scripts: advertised script "${name}" needs ${candidate}, which is not selected`
          );
        }
      }
    }
  }
}

// --- Scanners --------------------------------------------------------------

const SECRET_PATTERN =
  /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,})/u;

export function scanForSecrets(
  files: readonly Pick<GitTreeFile, "path" | "content">[]
): void {
  for (const file of files) {
    if (SECRET_PATTERN.test(file.content.toString("utf8"))) {
      throw new TypeError(`customer-starter selection contains credential-like content: ${file.path}`);
    }
  }
}

function runDenylistScan(
  files: readonly Pick<GitTreeFile, "path" | "content">[],
  denylist: readonly ScanDenylistEntry[],
  subject: string
): void {
  for (const entry of denylist) {
    const expression = new RegExp(entry.pattern, "u");
    for (const file of files) {
      if (expression.test(file.path) || expression.test(file.content.toString("utf8"))) {
        throw new TypeError(
          `customer-starter selection failed ${subject} rule "${entry.id}" (${entry.reason}): ${file.path}`
        );
      }
    }
  }
}

export function scanForInternalReferences(
  files: readonly Pick<GitTreeFile, "path" | "content">[],
  denylist: readonly ScanDenylistEntry[]
): void {
  runDenylistScan(files, denylist, "internal-reference-scan");
}

export function scanForCustomerData(
  files: readonly Pick<GitTreeFile, "path" | "content">[],
  denylist: readonly ScanDenylistEntry[]
): void {
  runDenylistScan(files, denylist, "customer-data-scan");
}

// --- Bundle build/verify -----------------------------------------------------

function emptyFindingsDigest(scanId: CustomerStarterScanId): Digest {
  return digest({ scanId, findings: [] as readonly never[] });
}

function buildScans(): CustomerStarterPreflightReport["scans"] {
  const ids: readonly CustomerStarterScanId[] = [
    "secret-scan",
    "internal-reference-scan",
    "customer-data-scan",
    "generated-workflow-source-closure",
    "schema-reference-closure",
    "module-import-closure",
    "markdown-link-closure",
    "package-script-closure"
  ];
  return ids.map((id) => ({
    id,
    status: "clean" as const,
    findingsDigest: emptyFindingsDigest(id)
  }));
}

function readOpenSourceReadiness(
  allFiles: readonly GitTreeFile[],
  packageVersion: string
): OpenSourceReadinessAssessment {
  const file = requiredFile(allFiles, "config/v1alpha1/open-source-readiness.json");
  const parsed = JSON.parse(file.content.toString("utf8")) as unknown;
  return validateOpenSourceAssessment(parsed, packageVersion);
}

function runAllChecksAndScans(
  files: readonly GitTreeFile[],
  denylists: {
    readonly internalReferences: readonly ScanDenylistEntry[];
    readonly customerData: readonly ScanDenylistEntry[];
  },
  advertisedScripts: readonly string[]
): void {
  scanForSecrets(files);
  scanForInternalReferences(files, denylists.internalReferences);
  scanForCustomerData(files, denylists.customerData);
  checkGeneratedWorkflowSourceClosure(files.map((file) => file.path));
  checkSchemaReferenceClosure(files);
  checkModuleImportClosure(files);
  checkMarkdownLinkClosure(files);
  checkPackageScriptClosure(files, advertisedScripts);
}

interface DerivedCustomerStarterArtifacts {
  readonly selection: CustomerStarterSelection;
  readonly baseManifest: CustomerStarterManifest | null;
  readonly effectiveFiles: readonly GitTreeFile[];
  readonly manifest: CustomerStarterManifest;
  readonly sbom: SpdxDocument;
  readonly provenance: CustomerStarterProvenance;
  readonly preflightReport: CustomerStarterPreflightReport;
}

/**
 * Builds a CustomerStarterManifest from an already-resolved file set,
 * deriving the commit timestamp, license/notices digests, and dependency
 * lock digest the same way in every call site. Used both to build the
 * final manifest for the profile being built/verified and to
 * independently recompute the *expected* base manifest for whole-document
 * equality against a caller-supplied baseManifest (see
 * deriveCustomerStarterArtifacts): sharing one implementation makes the
 * two manifests provably consistent by construction rather than by two
 * separately-maintained copies of the same field list silently drifting
 * apart.
 */
function buildManifestFromFiles(input: {
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly server: string;
  readonly repository: string;
  readonly baseManifestDigest: Digest | null;
  readonly selectionDigest: Digest;
  readonly internalReferenceDenylistDigest: Digest;
  readonly customerDataDenylistDigest: Digest;
  readonly advertisedScriptsDigest: Digest;
  readonly files: readonly GitTreeFile[];
}): CustomerStarterManifest {
  const sourceDateEpoch = Number(
    gitText(input.root, ["show", "-s", "--format=%ct", input.headSha])
  );
  if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) {
    throw new TypeError("customer-starter commit timestamp is invalid");
  }
  const licenseFile = requiredFile(input.files, "LICENSE");
  const noticesFile = requiredFile(input.files, "THIRD_PARTY_NOTICES.md");
  if (
    licenseFile.digest !== EXPECTED_LICENSE_DIGEST ||
    noticesFile.digest !== EXPECTED_NOTICES_DIGEST
  ) {
    throw new TypeError("customer-starter license or notices differ from the reviewed baseline");
  }
  const lockFile = input.files.find((file) => file.path === "package-lock.json") ?? null;
  return assertPackagingKind<CustomerStarterManifest>(
    {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "CustomerStarterManifest",
      schemaVersion: "1.0.0",
      packageName: "agentic-framework",
      packageVersion: input.packageVersion,
      profileId: input.profileId,
      extendsProfileId: input.extendsProfileId,
      baseManifestDigest: input.baseManifestDigest,
      selectionDigest: input.selectionDigest,
      source: {
        server: input.server,
        repository: input.repository,
        baseSha: input.baseSha,
        headSha: input.headSha,
        sourceDateEpoch
      },
      licenseDigest: licenseFile.digest,
      noticesDigest: noticesFile.digest,
      dependencyLockDigest: lockFile === null ? null : lockFile.digest,
      internalReferenceDenylistDigest: input.internalReferenceDenylistDigest,
      customerDataDenylistDigest: input.customerDataDenylistDigest,
      advertisedScriptsDigest: input.advertisedScriptsDigest,
      files: input.files.map(({ oid: _oid, content: _content, ...file }) => file)
    },
    "CustomerStarterManifest"
  );
}

function deriveCustomerStarterArtifacts(request: {
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
  readonly profileId: string;
  readonly server: string;
  readonly repository: string;
  readonly profileCatalog: CustomerStarterProfileCatalog;
}): DerivedCustomerStarterArtifacts {
  validateProfileCatalog(request.profileCatalog);
  // The advertised-script list and the two scan denylists are likewise
  // sealed into the fixed profile catalog and loaded directly from the
  // exact reviewed Git tree -- never accepted as a caller-supplied
  // in-memory value. An empty or narrowed denylist supplied by a caller
  // would let a real scan hit disappear while still reporting "clean";
  // an empty or narrowed advertisedScripts list would let an incomplete
  // profile falsely claim standalone runnability. Neither is a parameter
  // anywhere on this module's public API.
  const profileEntry = findProfileCatalogEntry(request.profileCatalog, request.profileId);
  const internalReferenceDenylist = loadCatalogDenylist(
    request.root,
    request.headSha,
    request.profileCatalog.internalReferenceDenylistPath
  );
  const customerDataDenylist = loadCatalogDenylist(
    request.root,
    request.headSha,
    request.profileCatalog.customerDataDenylistPath
  );
  const internalReferenceDenylistDigest = digest(internalReferenceDenylist);
  const customerDataDenylistDigest = digest(customerDataDenylist);

  // The selection is always loaded by profileId through the given,
  // trusted catalog directly from the exact reviewed Git tree -- never
  // accepted as a caller-supplied in-memory object. This is the only entry
  // point into this module's build/verify path, so there is no parameter
  // through which a caller could supply an alternate selection object or
  // an alternate knownSelectionDocumentPaths exemption list that is not
  // bound to the given catalog.
  const selection = loadCatalogSelection(
    request.root,
    request.headSha,
    request.profileCatalog,
    request.profileId
  );

  const listing = listGitTree(request.root, request.headSha);

  let baseManifest: CustomerStarterManifest | null = null;
  let baseEntries: readonly GitTreeEntry[] = [];
  if (selection.extendsProfileId !== null) {
    // The base selection is likewise always loaded by profileId through
    // the same trusted catalog directly from the exact reviewed tree, and
    // the base manifest is always independently derived here -- never
    // accepted as a caller-supplied value -- so there is no assertion step
    // left that could be satisfied by a widened or narrowed tampered
    // manifest: the only base manifest that can ever exist in this
    // function is the one this function itself computes from the base
    // profile's own exact reviewed selection and the exact tree.
    const baseSelection = loadCatalogSelection(
      request.root,
      request.headSha,
      request.profileCatalog,
      selection.extendsProfileId
    );
    if (baseSelection.extendsProfileId !== null) {
      throw new TypeError(
        "customer-starter base selection must not itself extend another profile (only one level of composition is supported)"
      );
    }
    if (selection.baseSelectionDigest !== digest(baseSelection)) {
      throw new TypeError("customer-starter selection baseSelectionDigest does not match the base selection");
    }
    const baseProfileEntry = findProfileCatalogEntry(request.profileCatalog, baseSelection.profileId);

    const baseOwnEntries = resolveSelectionOwnEntries(baseSelection, listing);
    const baseOwnFiles = readGitTreeFiles(request.root, baseOwnEntries, {
      maxFiles: MAX_STARTER_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxArchiveBytes: MAX_ARCHIVE_BYTES
    });

    baseManifest = buildManifestFromFiles({
      root: request.root,
      baseSha: request.baseSha,
      headSha: request.headSha,
      packageVersion: request.packageVersion,
      profileId: baseSelection.profileId,
      extendsProfileId: null,
      repository: request.repository,
      server: request.server,
      baseManifestDigest: null,
      selectionDigest: digest(baseSelection),
      internalReferenceDenylistDigest,
      customerDataDenylistDigest,
      advertisedScriptsDigest: digest(baseProfileEntry.advertisedScripts),
      files: baseOwnFiles
    });
    baseEntries = baseOwnEntries;
  }

  const ownEntries = resolveSelectionOwnEntries(selection, listing);
  const effectiveEntries = mergeEffectiveEntries(baseEntries, ownEntries);
  const effectiveFiles = readGitTreeFiles(request.root, effectiveEntries, {
    maxFiles: MAX_STARTER_FILES,
    maxFileBytes: MAX_FILE_BYTES,
    maxArchiveBytes: MAX_ARCHIVE_BYTES
  });

  if (packageVersionFrom(effectiveFiles) !== request.packageVersion) {
    throw new TypeError("requested customer-starter version differs from package.json");
  }

  runAllChecksAndScans(
    effectiveFiles,
    {
      internalReferences: internalReferenceDenylist,
      customerData: customerDataDenylist
    },
    profileEntry.advertisedScripts
  );

  const manifest = buildManifestFromFiles({
    root: request.root,
    baseSha: request.baseSha,
    headSha: request.headSha,
    packageVersion: request.packageVersion,
    profileId: selection.profileId,
    extendsProfileId: selection.extendsProfileId,
    server: request.server,
    repository: request.repository,
    baseManifestDigest: baseManifest === null ? null : digest(baseManifest),
    selectionDigest: digest(selection),
    internalReferenceDenylistDigest,
    customerDataDenylistDigest,
    advertisedScriptsDigest: digest(profileEntry.advertisedScripts),
    files: effectiveFiles
  });

  const sbom = validateSpdxDocument(
    createRootSpdxDocument({
      packageName: "agentic-framework",
      packageVersion: manifest.packageVersion,
      headSha: manifest.source.headSha,
      sourceDateEpoch: manifest.source.sourceDateEpoch,
      licenseDeclared: "MIT",
      dependencyPackages:
        manifest.dependencyLockDigest === null
          ? []
          : lockPackages(requiredFile(effectiveFiles, "package-lock.json"))
    })
  );

  const provenance: CustomerStarterProvenance = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "UnsignedCustomerStarterProvenance",
    schemaVersion: "1.0.0",
    source: {
      server: request.server,
      repository: request.repository,
      baseSha: request.baseSha,
      headSha: request.headSha
    },
    packageVersion: manifest.packageVersion,
    profileId: manifest.profileId,
    extendsProfileId: manifest.extendsProfileId,
    buildType: "local-deterministic-customer-starter-bundle",
    builder: "agentic-framework-customer-starter-tool",
    networkUsed: false,
    credentialsUsed: false,
    publicationPerformed: false,
    materials: [
      { path: "LICENSE", digest: manifest.licenseDigest },
      { path: "THIRD_PARTY_NOTICES.md", digest: manifest.noticesDigest },
      { path: "starter-manifest.json", digest: digest(manifest) }
    ],
    limitations: [
      "unsigned-local-evidence",
      "no-production-key",
      "no-publication",
      "not-a-readiness-decision",
      "selection-and-scan-configuration-are-reviewed-inputs-not-model-output"
    ]
  };

  const readiness = readOpenSourceReadiness(effectiveFiles, request.packageVersion);
  const preflightReport = assertPackagingKind<CustomerStarterPreflightReport>(
    {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "CustomerStarterPreflightReport",
      schemaVersion: "1.0.0",
      packageVersion: manifest.packageVersion,
      profileId: manifest.profileId,
      extendsProfileId: manifest.extendsProfileId,
      sourceHeadSha: request.headSha,
      starterManifestDigest: digest(manifest),
      sbomDigest: digest(sbom),
      provenanceDigest: digest(provenance),
      openSourceReadinessDigest: digest(readiness),
      decision: "no-go",
      authoritative: false,
      selfApproved: false,
      scans: buildScans(),
      categories: readiness.categories,
      residualRisks: [
        "This report is generated evidence, not legal, OSPO, security, or product approval.",
        "The selection's exact file list is reviewed data; only humans may authorize publication.",
        "Deterministic scanners find only the reviewed pattern set; absence of a match is not proof of absence.",
        "LICENSE and open-source readiness remain an unresolved human gate regardless of scan results."
      ]
    },
    "CustomerStarterPreflightReport"
  );

  return { selection, baseManifest, effectiveFiles, manifest, sbom, provenance, preflightReport };
}

/**
 * Builds a deterministic customer-starter bundle for the given profileId.
 * The profile catalog (which profiles exist, at which exact selection
 * path, extending which base, advertising which scripts) and the two
 * scan-denylist document paths are always the fixed, reviewed
 * SEALED_PROFILE_CATALOG -- there is no parameter here through which any
 * of them can be substituted, and no exported function in this module
 * accepts one either. Two prior review rounds found successively deeper
 * versions of the same gap: first, that accepting a caller-supplied
 * catalog as a parameter was itself exploitable (a catalog entry naming a
 * file added only after the selection's reviewed sourceHeadSha could
 * exempt that file from resolvedClosureDigest at the current build head
 * while it was correctly absent from the same exemption at review time,
 * so the digest still matched while the file still shipped); then, that a
 * second "test-fixture-only" function that still accepted a catalog was
 * itself exported and therefore compiled into the shipped package and
 * reachable via a deep import regardless of its name or doc comments.
 * This module now exports no function that accepts a
 * CustomerStarterProfileCatalog at all; tests/customer-starter.test.ts
 * exercises this exact function through its real, sealed, catalog-fixed
 * profileIds ("control-plane-core"/"demo-portfolio").
 */
export function buildCustomerStarterBundle(input: {
  readonly repositoryRoot: string;
  readonly outputRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
  readonly profileId: string;
}): CustomerStarterBundleResult {
  const root = canonicalDirectory(input.repositoryRoot, "customer-starter repository root");
  assertSupportedGitVersion(root);
  assertGitTopLevel(root);
  const plannedOutputRoot = safeOutputPath(input.outputRoot);
  assertOutsideRepositoryMetadata(root, plannedOutputRoot);
  const source = assertExactHead(root, input.baseSha, input.headSha);

  const { selection, effectiveFiles, manifest, sbom, provenance, preflightReport } =
    deriveCustomerStarterArtifacts({
      ...input,
      root,
      ...source,
      profileCatalog: SEALED_PROFILE_CATALOG
    });

  const archive = createDeterministicTar(effectiveFiles, MAX_STARTER_FILES);
  const outputRoot = assertSafeOutputRoot(plannedOutputRoot);
  const outputs: Readonly<Record<string, Buffer>> = {
    "customer-starter.tar": archive,
    "starter-manifest.json": canonicalFile(manifest),
    "starter-sbom.spdx.json": canonicalFile(sbom),
    "starter-provenance.json": canonicalFile(provenance),
    "starter-preflight.json": canonicalFile(preflightReport)
  };
  for (const [name, content] of Object.entries(outputs)) {
    writeExclusive(outputRoot, name, content);
  }
  writeExclusive(outputRoot, "checksums.txt", createChecksums(outputs));

  return {
    selectionDigest: digest(selection),
    starterManifestDigest: digest(manifest),
    sbomDigest: digest(sbom),
    provenanceDigest: digest(provenance),
    preflightReportDigest: digest(preflightReport),
    archiveDigest: sha256Bytes(archive),
    outputRoot
  };
}

/**
 * Verifies a previously-built deterministic customer-starter bundle for
 * the given profileId. Like buildCustomerStarterBundle, the profile
 * catalog is always the fixed, reviewed SEALED_PROFILE_CATALOG -- there
 * is no parameter here through which it can be substituted, and no
 * exported function in this module accepts one either.
 */
export function verifyCustomerStarterBundle(input: {
  readonly repositoryRoot: string;
  readonly bundleRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly packageVersion: string;
  readonly profileId: string;
}): CustomerStarterBundleResult {
  const root = canonicalDirectory(input.repositoryRoot, "customer-starter repository root");
  assertSupportedGitVersion(root);
  assertGitTopLevel(root);
  const bundleRoot = canonicalDirectory(input.bundleRoot, "customer-starter bundle root");
  assertOutsideRepositoryMetadata(root, bundleRoot);
  const source = assertExactHead(root, input.baseSha, input.headSha);
  validateBundleOutputDirectory(bundleRoot, OUTPUT_FILES);
  verifyBundleChecksums(bundleRoot, OUTPUT_FILES);

  const { effectiveFiles, manifest, sbom, provenance, preflightReport } =
    deriveCustomerStarterArtifacts({
      ...input,
      root,
      ...source,
      profileCatalog: SEALED_PROFILE_CATALOG
    });

  const onDiskManifest = assertPackagingKind<CustomerStarterManifest>(
    readCanonicalJson(path.join(bundleRoot, "starter-manifest.json")),
    "CustomerStarterManifest"
  );
  if (canonicalJson(onDiskManifest) !== canonicalJson(manifest)) {
    throw new TypeError("customer-starter manifest on disk does not match the exact recomputed selection");
  }
  const onDiskSbom = validateSpdxDocument(
    readCanonicalJson(path.join(bundleRoot, "starter-sbom.spdx.json"))
  );
  const onDiskProvenance = readCanonicalJson(
    path.join(bundleRoot, "starter-provenance.json")
  ) as CustomerStarterProvenance;
  const onDiskPreflight = assertPackagingKind<CustomerStarterPreflightReport>(
    readCanonicalJson(path.join(bundleRoot, "starter-preflight.json")),
    "CustomerStarterPreflightReport"
  );
  if (
    canonicalJson(onDiskSbom) !== canonicalJson(sbom) ||
    canonicalJson(onDiskProvenance) !== canonicalJson(provenance) ||
    canonicalJson(onDiskPreflight) !== canonicalJson(preflightReport)
  ) {
    throw new TypeError("customer-starter evidence is stale or has a subject/predicate binding mismatch");
  }

  const archive = readFileSync(path.join(bundleRoot, "customer-starter.tar"));
  if (!archive.equals(createDeterministicTar(effectiveFiles, MAX_STARTER_FILES))) {
    throw new TypeError(
      "customer-starter archive bytes are not the deterministic exact-selection encoding"
    );
  }

  return {
    selectionDigest: manifest.selectionDigest,
    starterManifestDigest: digest(manifest),
    sbomDigest: digest(sbom),
    provenanceDigest: digest(provenance),
    preflightReportDigest: digest(preflightReport),
    archiveDigest: sha256Bytes(archive),
    outputRoot: bundleRoot
  };
}
