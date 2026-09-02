import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import {
  buildCustomerStarterBundle,
  checkGeneratedWorkflowSourceClosure,
  checkMarkdownLinkClosure,
  checkModuleImportClosure,
  checkPackageScriptClosure,
  checkSchemaReferenceClosure,
  computeResolvedClosureDigest,
  scanForCustomerData,
  scanForInternalReferences,
  scanForSecrets,
  validateCustomerStarterSelection,
  validateScanDenylist,
  verifyCustomerStarterBundle,
  type CustomerStarterBundleResult
} from "../src/customer-starter.js";
import {
  CUSTOMER_STARTER_PROFILE_CATALOG,
  findProfileCatalogEntry,
  knownSelectionDocumentPathsFor
} from "../src/customer-starter-catalog.js";
import { createRepinnedCustomerStarterSelections } from "../src/customer-starter-authoring.js";
import { listGitTree } from "../src/release-support.js";
import { canonicalJson, digest } from "../src/canonical.js";
import type {
  CustomerStarterManifest,
  CustomerStarterSelection
} from "../src/packaging-types.js";

const ROOT = process.cwd();
// Any fixed, correctly-shaped digest value. Used only for selection fixtures
// exercised without a repository root (the "pure" validation path never
// recomputes or checks resolvedClosureDigest cryptographically), never for
// tests that go through the real repository-backed build/verify path.
const PLACEHOLDER_RESOLVED_CLOSURE_DIGEST = digest({
  placeholder: "customer-starter-test-fixture"
});

// buildCustomerStarterBundle/verifyCustomerStarterBundle accept no
// caller-supplied catalog at all (see src/customer-starter-catalog.ts's
// header comment for why): every test in this file that exercises them
// does so through these two real, sealed, catalog-fixed profileIds and
// their exact real selection paths, against small hermetic synthetic
// repositories that commit their own selection/denylist documents at
// exactly these paths -- never a synthetic profileId or path of the
// test's own choosing.
const CORE_PROFILE = findProfileCatalogEntry(CUSTOMER_STARTER_PROFILE_CATALOG, "control-plane-core");
const DEMO_PROFILE = findProfileCatalogEntry(CUSTOMER_STARTER_PROFILE_CATALOG, "demo-portfolio");
const CORE_PROFILE_ID = CORE_PROFILE.profileId;
const DEMO_PROFILE_ID = DEMO_PROFILE.profileId;
const CORE_SELECTION_PATH = CORE_PROFILE.selectionPath;
const DEMO_SELECTION_PATH = DEMO_PROFILE.selectionPath;
const INTERNAL_REFERENCE_DENYLIST_PATH = CUSTOMER_STARTER_PROFILE_CATALOG.internalReferenceDenylistPath;
const CUSTOMER_DATA_DENYLIST_PATH = CUSTOMER_STARTER_PROFILE_CATALOG.customerDataDenylistPath;
const KNOWN_SELECTION_DOCUMENT_PATHS = knownSelectionDocumentPathsFor(CUSTOMER_STARTER_PROFILE_CATALOG);
// Every advertisedScripts entry across both real profiles, so a single
// shared package.json fixture can define all of them (as trivial, always-
// successful commands with no file references -- checkPackageScriptClosure
// only requires closure for tokens shaped like a script/test/src file,
// tsconfig.json, or package.json/package-lock.json; a bare "true" command
// has no such token) regardless of which profile a given test builds.
const ALL_REAL_ADVERTISED_SCRIPTS = [
  ...new Set([...CORE_PROFILE.advertisedScripts, ...DEMO_PROFILE.advertisedScripts])
];

function run(cwd: string, executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-30T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-30T10:00:00Z"
    },
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * Adds a Git blob at an exact path directly through the index
 * (`hash-object`/`update-index --cacheinfo`) rather than through the
 * working tree. Some paths this module needs to test (e.g. two paths that
 * only differ by letter case) collide on the host's own filesystem, which
 * would silently overwrite one path with the other's content if written
 * through the working tree; the index can still hold both as distinct
 * tracked blobs.
 */
function addBlobAtPath(root: string, relativePath: string, content: string): void {
  const blobId = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: content,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-30T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-30T10:00:00Z"
    },
    shell: false
  });
  assert.equal(blobId.status, 0, blobId.stderr);
  run(root, "git", [
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${blobId.stdout.trim()},${relativePath}`
  ]);
}

function file(relative: string): Pick<{ path: string; content: Buffer }, "path" | "content"> {
  return { path: relative, content: Buffer.from("") };
}

/** Builds a small hermetic Git repository shaped like a customer-starter
 * candidate: a package.json/package-lock.json/LICENSE/THIRD_PARTY_NOTICES.md
 * baseline plus a couple of extra files, committed twice so a base/head pair
 * exists. Mirrors tests/packaging.test.ts's releaseRepository() helper.
 * package.json declares every real profile's advertisedScripts (as bare
 * "true" commands, so checkPackageScriptClosure's file-closure requirement
 * is trivially satisfied without needing any real script implementation
 * files present) so this one fixture works for build/verify tests against
 * either real profileId. */
function starterRepository(): {
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "customer-starter-source-"));
  run(root, "git", ["init", "--quiet"]);
  run(root, "git", ["config", "user.name", "Customer Starter Test"]);
  run(root, "git", ["config", "user.email", "release@example.invalid"]);
  run(root, "git", [
    "remote",
    "add",
    "origin",
    "https://github.com/example-organization/hyperfinite.git"
  ]);
  writeFileSync(
    root + "/package.json",
    `${JSON.stringify({
      name: "agentic-framework",
      version: "0.1.0",
      scripts: Object.fromEntries(ALL_REAL_ADVERTISED_SCRIPTS.map((name) => [name, "true"]))
    })}\n`
  );
  writeFileSync(
    root + "/package-lock.json",
    '{"name":"agentic-framework","version":"0.1.0","lockfileVersion":3,"packages":{"":{"name":"agentic-framework","version":"0.1.0"},"node_modules/example":{"version":"1.2.3","license":"MIT","integrity":"sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}\n'
  );
  writeFileSync(root + "/LICENSE", readFileSync(path.join(ROOT, "LICENSE")));
  writeFileSync(root + "/tsconfig.json", "{}\n");
  writeFileSync(
    root + "/THIRD_PARTY_NOTICES.md",
    readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"))
  );
  const readiness = JSON.parse(
    readFileSync(path.join(ROOT, "config/v1alpha1/open-source-readiness.json"), "utf8")
  ) as { readonly packageVersion: string };
  mkdirSync(path.join(root, "config/v1alpha1"), { recursive: true });
  writeFileSync(
    path.join(root, "config/v1alpha1/open-source-readiness.json"),
    JSON.stringify({ ...readiness, packageVersion: "0.1.0" }, null, 2)
  );
  mkdirSync(path.join(root, "docs"));
  writeFileSync(path.join(root, "docs/overview.md"), "# Overview\n\nNo links here.\n");
  mkdirSync(path.join(root, "docs/provenance"));
  writeFileSync(path.join(root, "docs/provenance/reference-inventory.yml"), "entries: []\n");
  writeFileSync(path.join(root, "docs/provenance/reuse-policy.md"), "# Reuse policy\n");
  // The two shared scan denylists are sealed to the real catalog's exact
  // paths and loaded directly from the exact reviewed Git tree; every
  // build/verify test in this file goes through the real sealed
  // buildCustomerStarterBundle/verifyCustomerStarterBundle, which always
  // resolves these exact paths, so this fixture commits its (initially
  // empty) denylist documents at exactly them.
  writeFileSync(path.join(root, INTERNAL_REFERENCE_DENYLIST_PATH), "[]\n");
  writeFileSync(path.join(root, CUSTOMER_DATA_DENYLIST_PATH), "[]\n");
  run(root, "git", ["add", "."]);
  run(root, "git", ["commit", "--quiet", "-m", "base"]);
  const baseSha = run(root, "git", ["rev-parse", "HEAD"]);
  run(root, "git", ["update-ref", "refs/remotes/origin/main", baseSha]);
  writeFileSync(root + "/README.md", "# Starter\n\nDeterministic starter fixture.\n");
  run(root, "git", ["add", "README.md"]);
  run(root, "git", ["commit", "--quiet", "-m", "head"]);
  return { root, baseSha, headSha: run(root, "git", ["rev-parse", "HEAD"]) };
}

/**
 * The fixed, shared scan-denylist document paths every synthetic test
 * catalog in this file points at; starterRepository() always commits an
 * empty (`[]`) document at both, so a test that needs non-empty denylist
 * content (to prove it is genuinely enforced, not silently ignored) must
 * explicitly overwrite and recommit one of these two paths itself.
 */
const DEFAULT_TEST_DENYLIST_PATHS = {
  internalReferenceDenylistPath: "config/internal-references.json",
  customerDataDenylistPath: "config/customer-data.json"
} as const;

const DEFAULT_INCLUDED_PATHS = [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "config/v1alpha1/open-source-readiness.json",
  "docs/overview.md",
  "docs/provenance/reference-inventory.yml",
  "docs/provenance/reuse-policy.md",
  "package-lock.json",
  "package.json",
  "tsconfig.json"
] as const;

function starterSelection(
  headSha: string,
  options?: {
    readonly root?: string;
    readonly includedPaths?: readonly string[];
    readonly knownSelectionDocumentPaths?: readonly string[];
  }
): CustomerStarterSelection {
  const base = {
    apiVersion: "agentic-framework.github.com/v1alpha1" as const,
    kind: "CustomerStarterSelection" as const,
    schemaVersion: "1.0.0" as const,
    profileId: "test-profile",
    extendsProfileId: null,
    baseSelectionDigest: null,
    sourceHeadSha: headSha,
    includedPaths: options?.includedPaths ?? DEFAULT_INCLUDED_PATHS,
    excludedPaths: []
  };
  return {
    ...base,
    resolvedClosureDigest:
      options?.root === undefined
        ? PLACEHOLDER_RESOLVED_CLOSURE_DIGEST
        : computeResolvedClosureDigest(
            options.root,
            base,
            headSha,
            options.knownSelectionDocumentPaths
          )
  };
}

/**
 * Commits a real CustomerStarterSelection document at `selectionPath`
 * within a hermetic test repository, for exercising
 * buildCustomerStarterBundle/verifyCustomerStarterBundle's sealed,
 * catalog-bound entrypoint the same way the real production CLI does: a
 * selection's bytes are always read from the exact reviewed Git tree,
 * never accepted as an in-memory object, so every test of the build/
 * verify path must itself commit its selection document rather than pass
 * one directly.
 *
 * Computes resolvedClosureDigest against the current HEAD (before this
 * commit), excluding every path the real, sealed
 * CUSTOMER_STARTER_PROFILE_CATALOG itself declares as a selection
 * document (via KNOWN_SELECTION_DOCUMENT_PATHS) -- the same exemption the
 * real system relies on to resolve the self-referential pinning problem
 * (a selection's own committed bytes cannot be included in a digest of
 * itself). Because the exemption means the selection document's own
 * presence/content never affects the digest, the digest computed just
 * before committing the document equals the digest recomputed at the
 * resulting HEAD (which only differs by that one exempted file), so
 * sourceHeadSha is set to the pre-commit HEAD -- an ancestor of the head
 * this function returns -- exactly mirroring how the real repository's
 * own selection documents are pinned against an ancestor commit and then
 * carried forward. Returns the new HEAD (including this commit).
 */
function commitSelection(
  root: string,
  selectionPath: string,
  shape: Omit<CustomerStarterSelection, "resolvedClosureDigest" | "sourceHeadSha">
): { readonly headSha: string; readonly selection: CustomerStarterSelection } {
  const preCommitHeadSha = run(root, "git", ["rev-parse", "HEAD"]);
  const withHead = { ...shape, sourceHeadSha: preCommitHeadSha };
  const resolvedClosureDigest = computeResolvedClosureDigest(
    root,
    withHead,
    preCommitHeadSha,
    KNOWN_SELECTION_DOCUMENT_PATHS
  );
  const selection: CustomerStarterSelection = { ...withHead, resolvedClosureDigest };
  const absolute = path.join(root, selectionPath);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(selection)}\n`);
  run(root, "git", ["add", selectionPath]);
  run(root, "git", ["commit", "--quiet", "-m", `pin ${selectionPath}`]);
  return { headSha: run(root, "git", ["rev-parse", "HEAD"]), selection };
}


test("validateCustomerStarterSelection enforces sourceHeadSha binding and sorted paths", () => {
  const selection = starterSelection("a".repeat(40));
  assert.throws(
    () => validateCustomerStarterSelection(selection, "b".repeat(40)),
    /is not the exact head or an ancestor of it/
  );
  const unsorted = {
    ...selection,
    includedPaths: [...selection.includedPaths].reverse()
  };
  assert.throws(
    () => validateCustomerStarterSelection(unsorted, selection.sourceHeadSha),
    /strictly sorted/
  );
  assert.deepEqual(
    validateCustomerStarterSelection(selection, selection.sourceHeadSha),
    selection
  );
});

test("validateCustomerStarterSelection accepts an ancestor sourceHeadSha with a repository root", () => {
  const repository = starterRepository();
  // README.md is only added in the head commit, so a selection reviewed at
  // baseSha must not claim it; every other default path pre-exists baseSha
  // and is unchanged through headSha, so resolvedClosureDigest computed at
  // baseSha is identical to the same computation at headSha.
  const preexistingPaths = DEFAULT_INCLUDED_PATHS.filter((entry) => entry !== "README.md");
  const olderSelection = starterSelection(repository.baseSha, {
    root: repository.root,
    includedPaths: preexistingPaths
  });
  // Without a repository root, ancestry cannot be checked, so only an
  // exact match is accepted.
  assert.throws(
    () => validateCustomerStarterSelection(olderSelection, repository.headSha),
    /is not the exact head or an ancestor of it/
  );
  // With a repository root, an ancestor sourceHeadSha is accepted...
  assert.deepEqual(
    validateCustomerStarterSelection(olderSelection, repository.headSha, repository.root),
    olderSelection
  );
  // ...but a sourceHeadSha that is not an ancestor (e.g. the descendant
  // head itself claimed as of the earlier commit) is still rejected.
  const unrelatedSelection = starterSelection("f".repeat(40));
  assert.throws(
    () =>
      validateCustomerStarterSelection(
        unrelatedSelection,
        repository.headSha,
        repository.root
      ),
    /is not the exact head or an ancestor of it/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("validateCustomerStarterSelection rejects a resolved closure that has drifted since sourceHeadSha", () => {
  const repository = starterRepository();
  mkdirSync(path.join(repository.root, "src"));
  writeFileSync(path.join(repository.root, "src/first.ts"), "export const first = 1;\n");
  run(repository.root, "git", ["add", "src/first.ts"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add src/first.ts"]);
  const reviewedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  const selection = starterSelection(reviewedHeadSha, {
    root: repository.root,
    includedPaths: [...DEFAULT_INCLUDED_PATHS, "src"].sort()
  });
  // Nothing has changed yet: the selection validates cleanly against its
  // own reviewed commit.
  assert.deepEqual(
    validateCustomerStarterSelection(selection, reviewedHeadSha, repository.root),
    selection
  );
  // A new file lands under the reviewed "src" prefix after the review.
  writeFileSync(path.join(repository.root, "src/second.ts"), "export const second = 2;\n");
  run(repository.root, "git", ["add", "src/second.ts"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add src/second.ts"]);
  const driftedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  // The stale selection (still pinned to reviewedHeadSha) must not silently
  // package the new file: sourceHeadSha is a real ancestor, but the exact
  // resolved closure has drifted, and that must fail closed.
  assert.throws(
    () => validateCustomerStarterSelection(selection, driftedHeadSha, repository.root),
    /resolved closure has drifted/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("validateCustomerStarterSelection is not fooled by a sibling selection document's own re-pin", () => {
  // A broad includedPaths prefix (e.g. "config") can incidentally cover a
  // *different* profile's selection document too. Re-pinning that sibling
  // document's own resolvedClosureDigest/sourceHeadSha changes its bytes
  // without changing anything this profile's own selection actually
  // reviewed, and must not be reported as drift -- but only because its
  // exact path was declared via knownSelectionDocumentPaths, never because
  // of its content shape.
  const repository = starterRepository();
  mkdirSync(path.join(repository.root, "config"), { recursive: true });
  const siblingSelectionPath = path.join(repository.root, "config/sibling-selection.json");
  const initialSibling: CustomerStarterSelection = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: "sibling-profile",
    extendsProfileId: null,
    baseSelectionDigest: null,
    sourceHeadSha: "a".repeat(40),
    includedPaths: ["README.md"],
    excludedPaths: [],
    resolvedClosureDigest: PLACEHOLDER_RESOLVED_CLOSURE_DIGEST
  };
  writeFileSync(siblingSelectionPath, `${JSON.stringify(initialSibling)}\n`);
  run(repository.root, "git", ["add", "config/sibling-selection.json"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add sibling selection"]);
  const reviewedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  const knownSelectionDocumentPaths = ["config/sibling-selection.json"];
  const selection = starterSelection(reviewedHeadSha, {
    root: repository.root,
    includedPaths: [...DEFAULT_INCLUDED_PATHS, "config"].sort(),
    knownSelectionDocumentPaths
  });
  // The sibling selection document is later re-pinned to a different
  // sourceHeadSha/resolvedClosureDigest, changing its bytes -- this must
  // not be treated as drift by a profile whose broad "config" prefix
  // happens to also match that sibling file, because its exact path was
  // declared as known.
  writeFileSync(
    siblingSelectionPath,
    `${JSON.stringify({ ...initialSibling, sourceHeadSha: "b".repeat(40) })}\n`
  );
  run(repository.root, "git", ["add", "config/sibling-selection.json"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "re-pin sibling selection"]);
  const driftedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.deepEqual(
    validateCustomerStarterSelection(
      selection,
      driftedHeadSha,
      repository.root,
      knownSelectionDocumentPaths
    ),
    selection
  );
  // Without the exact path declared, the same re-pin is correctly rejected:
  // exclusion must never be inferred from the sibling file's content/shape.
  // (It is rejected at the earliest possible check -- the pinned
  // resolvedClosureDigest no longer matches its own reviewed resolution,
  // since that resolution was computed with the exclusion in place and a
  // recomputation without it necessarily differs.)
  assert.throws(
    () => validateCustomerStarterSelection(selection, driftedHeadSha, repository.root),
    /resolvedClosureDigest does not match|resolved closure has drifted/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("computeResolvedClosureDigest does not exclude an unrelated file merely because it is shaped like a selection document", () => {
  // A file that is not one of the system's real, known selection documents
  // must not escape closure-drift detection just by parsing as
  // {"kind": "CustomerStarterSelection", ...}: exclusion is keyed by an
  // explicit, caller-supplied path, never by content shape.
  const repository = starterRepository();
  const disguisedPath = path.join(repository.root, "docs/disguised.json");
  const disguisedContent: CustomerStarterSelection = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: "not-a-real-profile",
    extendsProfileId: null,
    baseSelectionDigest: null,
    sourceHeadSha: "a".repeat(40),
    includedPaths: ["README.md"],
    excludedPaths: [],
    resolvedClosureDigest: PLACEHOLDER_RESOLVED_CLOSURE_DIGEST
  };
  writeFileSync(disguisedPath, `${JSON.stringify(disguisedContent)}\n`);
  run(repository.root, "git", ["add", "docs/disguised.json"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add disguised file"]);
  const reviewedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  const selection = starterSelection(reviewedHeadSha, {
    root: repository.root,
    includedPaths: [...DEFAULT_INCLUDED_PATHS, "docs/disguised.json"].sort()
  });

  test("customer starter selections repin to a new repository root commit", () => {
    const repository = starterRepository();
    try {
      const seed = starterSelection(repository.headSha, {
        root: repository.root
      });
      const core = {
        ...seed,
        profileId: "control-plane-core",
        sourceHeadSha: "a".repeat(40),
        excludedPaths: ["docs/missing-from-customer-copy"]
      };
      const demo = {
        ...seed,
        profileId: "demo-portfolio",
        extendsProfileId: "control-plane-core",
        baseSelectionDigest: digest(core),
        sourceHeadSha: "b".repeat(40),
        includedPaths: ["README.md"]
      };
      const repinned = createRepinnedCustomerStarterSelections({
        root: repository.root,
        headSha: repository.headSha,
        coreSelection: core,
        demoSelection: demo,
        knownSelectionDocumentPaths: []
      });
      assert.equal(repinned.core.sourceHeadSha, repository.headSha);
      assert.deepEqual(repinned.core.excludedPaths, []);
      assert.equal(repinned.demo.sourceHeadSha, repository.headSha);
      assert.equal(repinned.demo.baseSelectionDigest, digest(repinned.core));
      assert.equal(
        repinned.core.resolvedClosureDigest,
        computeResolvedClosureDigest(
          repository.root,
          repinned.core,
          repository.headSha
        )
      );
    } finally {
      rmSync(repository.root, { recursive: true, force: true });
    }
  });
  // Tampering the disguised file's content after review must be reported
  // as drift, exactly like any other selected file -- with no
  // knownSelectionDocumentPaths declared for it.
  writeFileSync(
    disguisedPath,
    `${JSON.stringify({ ...disguisedContent, sourceHeadSha: "b".repeat(40) })}\n`
  );
  run(repository.root, "git", ["add", "docs/disguised.json"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "tamper disguised file"]);
  const tamperedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => validateCustomerStarterSelection(selection, tamperedHeadSha, repository.root),
    /resolved closure has drifted/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("validateCustomerStarterSelection rejects a brand-new file shaped as a selection document added after review", () => {
  // A file that did not exist at sourceHeadSha at all, added post-review
  // under a matched prefix and shaped only as
  // {"kind": "CustomerStarterSelection", ...arbitrary payload}, must be
  // reported as drift like any other unreviewed addition -- it must not
  // silently ship just because it resembles a selection document.
  const repository = starterRepository();
  mkdirSync(path.join(repository.root, "src"), { recursive: true });
  writeFileSync(path.join(repository.root, "src/placeholder.ts"), "export const a = 1;\n");
  run(repository.root, "git", ["add", "src/placeholder.ts"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add src directory"]);
  const reviewedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  const selection = starterSelection(reviewedHeadSha, {
    root: repository.root,
    includedPaths: [...DEFAULT_INCLUDED_PATHS, "src"].sort()
  });
  const injectedContent: CustomerStarterSelection = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: "injected-profile",
    extendsProfileId: null,
    baseSelectionDigest: null,
    sourceHeadSha: "a".repeat(40),
    includedPaths: ["README.md"],
    excludedPaths: [],
    resolvedClosureDigest: PLACEHOLDER_RESOLVED_CLOSURE_DIGEST
  };
  writeFileSync(
    path.join(repository.root, "src/injected.json"),
    `${JSON.stringify(injectedContent)}\n`
  );
  run(repository.root, "git", ["add", "src/injected.json"]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "inject disguised file"]);
  const injectedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => validateCustomerStarterSelection(selection, injectedHeadSha, repository.root),
    /resolved closure has drifted/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("validateCustomerStarterSelection requires paired extendsProfileId and baseSelectionDigest", () => {
  const selection = starterSelection("a".repeat(40));
  assert.throws(
    () =>
      validateCustomerStarterSelection(
        { ...selection, extendsProfileId: "base" },
        selection.sourceHeadSha
      ),
    /must both be null or both set/
  );
  assert.throws(
    () =>
      validateCustomerStarterSelection(
        { ...selection, extendsProfileId: "test-profile", baseSelectionDigest: digest({}) },
        selection.sourceHeadSha
      ),
    /cannot extend itself/
  );
});


test("validateScanDenylist rejects malformed and duplicate entries", () => {
  assert.throws(() => validateScanDenylist({}), /must be an array/);
  assert.throws(
    () => validateScanDenylist([{ id: "a", pattern: "x" }]),
    /unexpected shape/
  );
  assert.throws(
    () => validateScanDenylist([{ id: "Bad Id", pattern: "x", reason: "y" }]),
    /id is invalid/
  );
  assert.throws(
    () => validateScanDenylist([{ id: "a", pattern: "(", reason: "y" }])
  );
  assert.throws(
    () =>
      validateScanDenylist([
        { id: "a", pattern: "x", reason: "y" },
        { id: "a", pattern: "z", reason: "w" }
      ]),
    /is duplicated/
  );
  assert.deepEqual(
    validateScanDenylist([{ id: "a", pattern: "x", reason: "y" }]),
    [{ id: "a", pattern: "x", reason: "y" }]
  );
});

test("scanForSecrets fails closed on credential-like content", () => {
  assert.doesNotThrow(() =>
    scanForSecrets([{ path: "a.md", content: Buffer.from("nothing sensitive here") }])
  );
  assert.throws(
    () =>
      scanForSecrets([
        { path: "a.md", content: Buffer.from("token: ghp_abcdefghijklmnopqrstuvwxyz0123") }
      ]),
    /credential-like content/
  );
});

test("scanForInternalReferences and scanForCustomerData use the reviewed denylist", () => {
  const internal = validateScanDenylist([
    { id: "no-foo", pattern: "foo", reason: "internal codename" }
  ]);
  assert.doesNotThrow(() =>
    scanForInternalReferences([{ path: "a.md", content: Buffer.from("bar") }], internal)
  );
  assert.throws(
    () =>
      scanForInternalReferences([{ path: "a.md", content: Buffer.from("foo") }], internal),
    /no-foo/
  );
  const customerData = validateScanDenylist([
    { id: "no-email", pattern: "[\\w.+-]+@real\\.example", reason: "looks like a real tenant" }
  ]);
  assert.throws(
    () =>
      scanForCustomerData(
        [{ path: "a.md", content: Buffer.from("contact person@real.example") }],
        customerData
      ),
    /no-email/
  );
});

test("reviewed internal-reference policy rejects live Project IDs generically", () => {
  const denylist = validateScanDenylist(
    JSON.parse(
      readFileSync(
        path.join(
          ROOT,
          "config/v1alpha1/customer-starter-internal-references.json"
        ),
        "utf8"
      )
    )
  );
  assert.throws(
    () =>
      scanForInternalReferences(
        [
          {
            path: "customer-target.json",
            content: Buffer.from(["PVT", "live_customer_project"].join("_"))
          }
        ],
        denylist
      ),
    /live-project-node-id/u
  );
  assert.doesNotThrow(() =>
    scanForInternalReferences(
      [
        {
          path: "synthetic-target.json",
          content: Buffer.from("PVT_synthetic_customer_project")
        }
      ],
      denylist
    )
  );
});

test("checkModuleImportClosure fails closed on an unselected relative import", () => {
  const files = [
    { path: "src/a.ts", content: Buffer.from('import { b } from "./b.js";\n') }
  ];
  assert.throws(
    () => checkModuleImportClosure(files),
    /imports src\/b\.ts, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...files,
      { path: "src/b.ts", content: Buffer.from("export const b = 1;\n") }
    ])
  );
});

test("checkModuleImportClosure also catches dynamic import()", () => {
  const files = [
    { path: "src/a.ts", content: Buffer.from('const m = await import("./b.js");\n') }
  ];
  assert.throws(
    () => checkModuleImportClosure(files),
    /imports src\/b\.ts, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...files,
      { path: "src/b.ts", content: Buffer.from("export const b = 1;\n") }
    ])
  );
});

test("checkModuleImportClosure covers .mjs/.cjs require() and re-exports", () => {
  assert.throws(
    () =>
      checkModuleImportClosure([
        { path: "scripts/a.mjs", content: Buffer.from('import { b } from "./b.mjs";\n') }
      ]),
    /imports scripts\/b\.mjs, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      { path: "scripts/a.mjs", content: Buffer.from('import { b } from "./b.mjs";\n') },
      { path: "scripts/b.mjs", content: Buffer.from("export const b = 1;\n") }
    ])
  );
  assert.throws(
    () =>
      checkModuleImportClosure([
        { path: "scripts/a.cjs", content: Buffer.from('const b = require("./b.cjs");\n') }
      ]),
    /imports scripts\/b\.cjs, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      { path: "scripts/a.cjs", content: Buffer.from('const b = require("./b.cjs");\n') },
      { path: "scripts/b.cjs", content: Buffer.from("module.exports = { b: 1 };\n") }
    ])
  );
  // A re-export is a `from "..."` site just like a plain import.
  assert.throws(
    () =>
      checkModuleImportClosure([
        { path: "src/a.ts", content: Buffer.from('export * from "./b.js";\n') }
      ]),
    /imports src\/b\.ts, which is not selected/
  );
});

test("checkModuleImportClosure ignores specifiers inside comments and unrelated strings", () => {
  // A specifier-shaped string inside a line comment, a block comment, and
  // an unrelated string constant must never be treated as a real import.
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      {
        path: "src/a.ts",
        content: Buffer.from(
          [
            '// import { b } from "./missing.js";',
            "/* also from \"./missing.js\" and require(\"./missing.js\") */",
            'const message = "from \\"./missing.js\\"";',
            'const also = "require(\'./missing.js\')";',
            "export const a = 1;\n"
          ].join("\n")
        )
      }
    ])
  );
});

test("checkModuleImportClosure finds a real import inside a template-literal interpolation", () => {
  // A real import()/require() written inside a `${...}` template-literal
  // interpolation is genuine code, not template text, and must still be
  // found -- the redaction that skips comments/strings inside the fixed
  // template text must not also blank out a real specifier written inside
  // an interpolation.
  const files = [
    {
      path: "src/a.ts",
      content: Buffer.from(
        "export const label = `value: ${(await import(\"./b.js\")).value}`;\n"
      )
    }
  ];
  assert.throws(
    () => checkModuleImportClosure(files),
    /imports src\/b\.ts, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...files,
      { path: "src/b.ts", content: Buffer.from("export const value = 1;\n") }
    ])
  );
  // A comment or unrelated string written inside the interpolation must
  // still be ignored, just as it would be at the top level.
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      {
        path: "src/c.ts",
        content: Buffer.from(
          'export const label = `value: ${/* import("./missing.js") */ 1}`;\n'
        )
      }
    ])
  );
});

test("checkModuleImportClosure covers no-substitution template-literal import()/require()", () => {
  // `import(`./found.js`)` (a backtick-delimited specifier with no `${...}`
  // interpolation) is statically resolvable exactly like a quoted string
  // specifier and must be found.
  const dynamicImport = [
    {
      path: "src/a.ts",
      content: Buffer.from("export const p = import(`./found.js`);\n")
    }
  ];
  assert.throws(
    () => checkModuleImportClosure(dynamicImport),
    /imports src\/found\.ts, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...dynamicImport,
      { path: "src/found.ts", content: Buffer.from("export const value = 1;\n") }
    ])
  );

  const requireCall = [
    {
      path: "src/b.cjs",
      content: Buffer.from("const p = require(`./found.cjs`);\n")
    }
  ];
  assert.throws(
    () => checkModuleImportClosure(requireCall),
    /imports src\/found\.cjs, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...requireCall,
      { path: "src/found.cjs", content: Buffer.from("module.exports = { value: 1 };\n") }
    ])
  );

  // A relative template literal WITH an interpolation is not statically
  // resolvable to a single path, and there is no evaluator here to
  // determine what it resolves to; rather than silently ignore it (which
  // would let an arbitrarily-computed relative import bypass closure
  // checking entirely), it must fail closed.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/c.ts",
          content: Buffer.from(
            'export const p = import(`./${dir}/omitted.js`);\nexport const dir = "x";\n'
          )
        }
      ]),
    /cannot verify a dynamically interpolated relative module specifier/
  );
});

test("checkModuleImportClosure fails closed on additional interpolated relative-specifier shapes, but not on a non-relative interpolated specifier", () => {
  // require() variant of the interpolated-specifier fail-closed check.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.cjs",
          content: Buffer.from('const p = require(`./${dir}/x.cjs`);\nconst dir = "x";\n')
        }
      ]),
    /cannot verify a dynamically interpolated relative module specifier/
  );
  // "../" is just as unambiguously relative as "./".
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from('const p = import(`../${dir}/x.js`);\nconst dir = "x";\n')
        }
      ]),
    /cannot verify a dynamically interpolated relative module specifier/
  );
  // An interpolation at the very start of the template (empty literal
  // prefix) is ambiguous -- it could resolve to a relative path -- and
  // must also fail closed.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from('const p = import(`${dir}`);\nconst dir = "./x.js";\n')
        }
      ]),
    /cannot verify a dynamically interpolated relative module specifier/
  );
  // A literal prefix that provably cannot become relative (concatenation
  // never inserts a leading ".") is out of scope for this closure check,
  // exactly like any other non-"." bare specifier -- must not throw.
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      {
        path: "src/a.ts",
        content: Buffer.from('const p = require(`lodash/${subpath}`);\nconst subpath = "x";\n')
      }
    ])
  );
  // A backslash escape sequence in the literal prefix (e.g. "\x2e",
  // which decodes to "." at runtime) must also fail closed: the prefix
  // is examined as raw source text, so a bare startsWith(".") on that
  // raw text alone would miss an escape that decodes to a leading dot,
  // letting an interpolated relative import slip through undetected.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from('const p = import(`\\x2e/${dir}/x.js`);\nconst dir = "x";\n')
        }
      ]),
    /cannot verify a dynamically interpolated relative module specifier/
  );
});

test("checkModuleImportClosure preserves the \\b word-boundary anchor for an import/require site written at the very start of an interpolation", () => {
  // Finding 4: the "${" interpolation delimiter was previously redacted to
  // "x" word-character filler, so a real import/require call written with
  // no separating whitespace directly after "${" (e.g.
  // `${import("./found.js")}`) would have its "\bimport" anchor defeated
  // by the preceding "xx" filler gluing onto it. Preserving "$"/"{"
  // literally (both non-word characters) keeps the boundary intact.
  const dynamicImport = [
    {
      path: "src/a.ts",
      content: Buffer.from('export const label = `${import("./found.js")}`;\n')
    }
  ];
  assert.throws(
    () => checkModuleImportClosure(dynamicImport),
    /imports src\/found\.ts, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      ...dynamicImport,
      { path: "src/found.ts", content: Buffer.from("export const value = 1;\n") }
    ])
  );

  const requireCall = [
    {
      path: "src/b.cjs",
      content: Buffer.from('const label = `${require("./found.cjs")}`;\n')
    }
  ];
  assert.throws(
    () => checkModuleImportClosure(requireCall),
    /imports src\/found\.cjs, which is not selected/
  );
});

test("checkModuleImportClosure fails closed on a backslash-escaped module specifier in every non-interpolated form (static import/from, dynamic import(), require(), no-substitution template)", () => {
  // A later review round found this same escape-decoding gap applied far
  // more broadly than the interpolated-template-literal case above: any
  // quoted or no-substitution-template module specifier can itself
  // contain a backslash escape sequence (e.g. "\x2e/x.js" or a
  // no-substitution template `\x2e/x.js`) that decodes to a leading "."
  // at runtime without containing a literal "." character in its raw
  // source form, so a bare startsWith(".") on the raw captured specifier
  // text alone would miss it -- regardless of which of the three site
  // kinds (bare/from import, dynamic import(), require()) or which of
  // the three delimiters (', ", `) captured it. There is no reviewed
  // string-escape decoder here, so every one of these forms must fail
  // closed on any backslash rather than assume it is safely non-relative.
  const cases: readonly { readonly label: string; readonly content: string }[] = [
    { label: "double-quoted static import", content: 'import x from "\\x2e/found.ts";\n' },
    { label: "single-quoted bare import", content: 'import "\\x2e/found.ts";\n' },
    { label: "double-quoted dynamic import()", content: 'const p = import("\\x2e/found.js");\n' },
    { label: "double-quoted require()", content: 'const p = require("\\x2e/found.cjs");\n' },
    {
      label: "no-substitution template require()",
      content: "const p = require(`\\x2e/found.cjs`);\n"
    },
    {
      label: "no-substitution template dynamic import() with \\u escape",
      content: "const p = import(`\\u002e/found.js`);\n"
    }
  ];
  for (const { label, content } of cases) {
    assert.throws(
      () => checkModuleImportClosure([{ path: "src/a.ts", content: Buffer.from(content) }]),
      /cannot verify a module specifier containing an escape sequence/,
      label
    );
  }
  // A backslash in a specifier that is obviously never relative either
  // way must still fail closed -- this check cannot safely distinguish
  // "definitely not relative despite the backslash" from "decodes to
  // relative because of the backslash" without a reviewed decoder, so it
  // conservatively rejects any backslash at all in a captured specifier.
  assert.throws(
    () =>
      checkModuleImportClosure([
        { path: "src/a.ts", content: Buffer.from('const p = require("lodash\\\\foo");\n') }
      ]),
    /cannot verify a module specifier containing an escape sequence/
  );
});

test("checkModuleImportClosure treats postfix ++/-- as value-position, not regex-ok", () => {

  // Finding 5: each "+"/"-" of a postfix "++"/"--" was previously
  // redacted one character at a time, and the generic single-character
  // fallback always left the following token in "regex-ok" position --
  // wrongly, since incrementing/decrementing always yields a number, so a
  // real division immediately after (e.g. `x++ / y`) was misread as the
  // start of a regex literal, which then silently swallowed everything up
  // to some unrelated later "/" in the file -- including a real import.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from(
            [
              "export function f(x: number): number {",
              "  return x++ / 2;",
              "}",
              'import { g } from "./missing.js";',
              "export {};\n"
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/b.ts",
          content: Buffer.from(
            [
              "export function f(x: number): number {",
              "  return --x / 2;",
              "}",
              'import { g } from "./missing.js";',
              "export {};\n"
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
});

test("checkModuleImportClosure treats a control-flow keyword used as a property/method name as an ordinary value, not regex-ok", () => {
  // Finding 5: `obj.catch(fn)` (a Promise method call, one of the most
  // common real-world occurrences of this exact word) was previously
  // treated identically to the "catch" control-flow keyword merely
  // because the two are lexically identical, marking its matching ")" as
  // control-flow and wrongly leaving "regex-ok" afterward -- so a real
  // division immediately after (e.g. `promise.catch(fn) / 2`) was misread
  // as a regex literal, again silently swallowing a later real import.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from(
            'const result = promise.catch(handler) / 2;\nimport { g } from "./missing.js";\nexport {};\n'
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
  // Optional-chain access (`obj?.catch(fn)`) must be guarded the same way.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/b.ts",
          content: Buffer.from(
            'const result = promise?.catch(handler) / 2;\nimport { g } from "./missing.js";\nexport {};\n'
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
  // Other control-flow keywords used as property names (unusual, but
  // syntactically legal -- reserved words are valid IdentifierNames after
  // a member-access "."): "for", "if", "while", "switch".
  for (const keyword of ["for", "if", "while", "switch"]) {
    assert.throws(
      () =>
        checkModuleImportClosure([
          {
            path: "src/c.ts",
            content: Buffer.from(
              `const result = obj.${keyword}(handler) / 2;\nimport { g } from "./missing.js";\nexport {};\n`
            )
          }
        ]),
      /imports src\/missing\.ts, which is not selected/,
      keyword
    );
  }
  // Control: a genuine (non-property-access) control-flow keyword must
  // still correctly enable "regex-ok" after its matching ")", exactly as
  // before -- this guard must not disable the legitimate case.
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      {
        path: "src/d.ts",
        content: Buffer.from(
          ["export function f(x: string): boolean {", "  if (x) /foo/.test(x);", "  return true;", "}"].join(
            "\n"
          )
        )
      }
    ])
  );
});

test("checkModuleImportClosure treats an EXPRESSION_KEYWORDS word used as a property name as an ordinary value, not regex-ok", () => {
  // Independent-review finding: the property-access guard added for
  // CONTROL_FLOW_KEYWORDS (if/for/while/switch/catch) was not also
  // applied to EXPRESSION_KEYWORDS (return/typeof/instanceof/in/of/new/
  // delete/void/throw/case/yield/await/else/do), several of which are
  // realistic property names (e.g. a generator iterator's own `.throw`/
  // `.return` methods). Scanning such an identifier immediately set
  // expressionPosition to "regex-ok" regardless of the preceding "."
  // property access, so a real division right after (e.g.
  // `iter.throw / 2`) was misread as starting a regex literal --
  // silently swallowing a later real import, exactly like the
  // CONTROL_FLOW_KEYWORDS case this same round already fixed.
  for (const keyword of ["throw", "return", "in", "of", "new", "delete", "void", "case", "do"]) {
    assert.throws(
      () =>
        checkModuleImportClosure([
          {
            path: "src/a.ts",
            content: Buffer.from(
              `const result = iter.${keyword} / 2;\nimport { g } from "./missing.js";\nexport {};\n`
            )
          }
        ]),
      /imports src\/missing\.ts, which is not selected/,
      keyword
    );
  }
  // Optional-chain access must be guarded the same way.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/b.ts",
          content: Buffer.from(
            'const result = iter?.throw / 2;\nimport { g } from "./missing.js";\nexport {};\n'
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
  // Control: genuine (non-property-access) EXPRESSION_KEYWORDS usage must
  // still correctly enable "regex-ok" afterward -- e.g. `return /foo/` is
  // a real, if unusual, regex-literal-returning statement.
  assert.doesNotThrow(() =>
    checkModuleImportClosure([
      {
        path: "src/c.ts",
        content: Buffer.from(
          "export function f(): RegExp {\n  return /foo/;\n}\n"
        )
      }
    ])
  );
});

test("checkModuleImportClosure redacts regex literal bodies without desynchronizing string/comment tracking", () => {
  // A regex literal whose body contains a quote character must not be
  // misinterpreted as the start of a string: if it were, string-tracking
  // state would carry forward past the intended regex end and swallow
  // everything until some later, unrelated quote elsewhere in the file --
  // including a real import written after it.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from(
            [
              'const quotePattern = /["\']/u;',
              'import { b } from "./missing.js";',
              "export { quotePattern };\n"
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );

  // A regex literal whose body contains a literal "/*" must not be
  // misinterpreted as the start of a block comment (which would consume
  // everything up to the next stray "*/" as commented-out, hiding a real
  // import written after it).
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/b.ts",
          content: Buffer.from(
            [
              "const commentLike = /\\/\\*/u;",
              'import { c } from "./missing.js";',
              "export { commentLike };\n"
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );

  // A regex literal whose body contains a backtick must not be
  // misinterpreted as the start of a template literal.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/d.ts",
          content: Buffer.from(
            [
              "const backtickLike = /`/u;",
              'import { e } from "./missing.js";',
              "export { backtickLike };\n"
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );

  // A regex literal directly after a control-flow keyword's closing ")"
  // (e.g. `if (x) /foo/.test(y)`) is a real, valid, if unusual, JavaScript
  // construct and must be redacted as a regex (not misparsed as division),
  // while a genuine import written after it must still be found.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/e.ts",
          content: Buffer.from(
            [
              "export function f(x: string): boolean {",
              '  if (x) /foo/.test(x);',
              '  return true;',
              "}",
              'import { g } from "./missing.js";\n'
            ].join("\n")
          )
        }
      ]),
    /imports src\/missing\.ts, which is not selected/
  );
});

test("checkModuleImportClosure fails closed on genuinely ambiguous or unterminated regex-vs-division", () => {
  // A bare "/" directly following a "}" is ambiguous between a
  // block-close (regex may follow) and an object-literal-close (division
  // may follow); rather than guess, the scanner must refuse.
  assert.throws(
    () =>
      checkModuleImportClosure([
        {
          path: "src/a.ts",
          content: Buffer.from("function f() {}\n/x/.test(\"y\");\n")
        }
      ]),
    /ambiguous.*directly after "}"/
  );

  // A regex literal with no closing "/" before end-of-file must fail
  // closed rather than silently treat the rest of the file as regex body
  // (or, worse, fall back to treating it as division and desynchronizing
  // subsequent string tracking).
  assert.throws(
    () =>
      checkModuleImportClosure([
        { path: "src/b.ts", content: Buffer.from('const p = /unterminated;\nconst q = "x";\n') }
      ]),
    /unterminated regex literal/
  );
});

test("checkModuleImportClosure differential regression against the real repository's shipped TypeScript source", () => {
  // Every real .ts file actually shipped in src/ and scripts/ -- including
  // the several files that contain genuine regex literals (e.g.
  // src/customer-starter.ts's own profileId pattern, src/demo-activation.ts's
  // digest/label patterns) -- must be scannable by the new regex-literal-
  // aware redactor without throwing a spurious fail-closed error, and the
  // codebase's already-established import closure must still hold end to
  // end. This is a live-file differential guard against the class of bug
  // this round's fix addresses: the redactor must neither desynchronize on
  // a real shipped regex literal nor silently miss a real shipped import.
  const files: Array<{ path: string; content: Buffer }> = [];
  const roots = ["src", "scripts"];
  const stack = [...roots];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const absolute = path.join(ROOT, current);
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const relative = path.posix.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(relative);
        continue;
      }
      if (!/\.(?:ts|mjs|cjs)$/u.test(entry.name)) continue;
      files.push({ path: relative, content: readFileSync(path.join(ROOT, relative)) });
    }
  }
  assert.ok(files.length > 20, "expected to find a substantial number of real source files");
  // The scanned set intentionally excludes non-TS/JS files (schemas,
  // configs, docs) that a real import might legitimately reference (e.g.
  // `import recordSchema from "../schemas/.../x.schema.json" with { type:
  // "json" }`), so a "which is not selected" TypeError here reflects an
  // incomplete file set for this test, not a scanner defect, and is
  // tolerated. The regex-literal fix this test guards against instead
  // throws a distinctly-worded "ambiguous ... after \"}\"" or "unterminated
  // regex literal" error; those, and any other unexpected exception, must
  // never occur on real shipped source.
  try {
    checkModuleImportClosure(files);
  } catch (error) {
    assert.ok(error instanceof TypeError, `expected a TypeError, got ${String(error)}`);
    assert.match((error as TypeError).message, /which is not selected$/u);
  }
});

test("checkSchemaReferenceClosure fails closed on an unselected relative \\$ref", () => {
  const files = [
    {
      path: "schemas/a.schema.json",
      content: Buffer.from(
        JSON.stringify({ $ref: "./b.schema.json#/$defs/x" })
      )
    }
  ];
  assert.throws(
    () => checkSchemaReferenceClosure(files),
    /references schemas\/b\.schema\.json, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkSchemaReferenceClosure([
      ...files,
      { path: "schemas/b.schema.json", content: Buffer.from(JSON.stringify({ type: "object" })) }
    ])
  );
  // Same-document fragments never require closure.
  assert.doesNotThrow(() =>
    checkSchemaReferenceClosure([
      { path: "schemas/c.schema.json", content: Buffer.from(JSON.stringify({ $ref: "#/$defs/x" })) }
    ])
  );
});

test("checkGeneratedWorkflowSourceClosure requires the Markdown source for a shipped lock", () => {
  assert.throws(
    () =>
      checkGeneratedWorkflowSourceClosure([".github/workflows/example.lock.yml"]),
    /requires \.github\/workflows\/example\.md/
  );
  assert.doesNotThrow(() =>
    checkGeneratedWorkflowSourceClosure([
      ".github/workflows/example.lock.yml",
      ".github/workflows/example.md"
    ])
  );
  // Source without a compiled lock is fine (one-directional closure).
  assert.doesNotThrow(() =>
    checkGeneratedWorkflowSourceClosure([".github/workflows/example.md"])
  );
});

test("checkMarkdownLinkClosure fails closed unless annotated external or directory-satisfied", () => {
  const files = [
    { path: "docs/a.md", content: Buffer.from("See [b](./b.md) for detail.\n") }
  ];
  assert.throws(
    () => checkMarkdownLinkClosure(files),
    /links docs\/b\.md, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      ...files,
      { path: "docs/b.md", content: Buffer.from("detail\n") }
    ])
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      { path: "docs/a.md", content: Buffer.from('See [b](./b.md "external") for detail.\n') }
    ])
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      { path: "docs/a.md", content: Buffer.from("See [dir](./sub/) for detail.\n") },
      { path: "docs/sub/c.md", content: Buffer.from("nested\n") }
    ])
  );
});

test("checkMarkdownLinkClosure resolves reference-style link/image definitions", () => {
  // A reference-style usage plus its definition, resolved by markdown-it's
  // own parser rather than a regex that only understands inline `](...)`
  // syntax.
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        {
          path: "docs/a.md",
          content: Buffer.from("See [detail][ref] for more.\n\n[ref]: ./b.md\n")
        }
      ]),
    /links docs\/b\.md, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      {
        path: "docs/a.md",
        content: Buffer.from("See [detail][ref] for more.\n\n[ref]: ./b.md\n")
      },
      { path: "docs/b.md", content: Buffer.from("detail\n") }
    ])
  );
  // Reference-style images resolve the same way.
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        {
          path: "docs/a.md",
          content: Buffer.from("![diagram][fig]\n\n[fig]: ./missing.png\n")
        }
      ]),
    /links docs\/missing\.png, which is not selected/
  );
  // A title on the reference definition still activates the external/
  // non-bundle exception.
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      {
        path: "docs/a.md",
        content: Buffer.from('See [detail][ref] for more.\n\n[ref]: ./missing.md "non-bundle"\n')
      }
    ])
  );
  // An inline image and an escaped destination character (a literal
  // parenthesis) both resolve correctly; a bare regex over raw source that
  // stops at the first unescaped ")" would misparse this.
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        { path: "docs/a.md", content: Buffer.from("[report](./assets/fig\\(1\\).md)\n") }
      ]),
    /links docs\/assets\/fig\(1\)\.md, which is not selected/
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      { path: "docs/a.md", content: Buffer.from("[report](./assets/fig\\(1\\).md)\n") },
      { path: "docs/assets/fig(1).md", content: Buffer.from("") }
    ])
  );
});

test("checkMarkdownLinkClosure rejects raw HTML link/image elements outright", () => {
  // With html:false, markdown-it treats raw HTML as opaque plain text, so
  // a raw <a href>/<img src> silently bypasses closure checking entirely
  // (no link_open/image token is ever produced for it). html:true
  // surfaces it as html_inline/html_block, and it must be rejected
  // outright rather than resolved, since this tool implements no HTML
  // attribute parser to validate its target.
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        { path: "docs/a.md", content: Buffer.from('<a href="./missing.md">link</a>\n') }
      ]),
    /raw HTML link or image element/
  );
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        { path: "docs/a.md", content: Buffer.from('<img src="./missing.png"/>\n') }
      ]),
    /raw HTML link or image element/
  );
  // Even when the referenced path is actually selected, a raw HTML link/
  // image element is still rejected outright (never silently resolved).
  assert.throws(
    () =>
      checkMarkdownLinkClosure([
        { path: "docs/a.md", content: Buffer.from('<a href="./b.md">link</a>\n') },
        { path: "docs/b.md", content: Buffer.from("detail\n") }
      ]),
    /raw HTML link or image element/
  );
});

test("checkMarkdownLinkClosure does not reject harmless HTML comments or code examples", () => {
  // A raw HTML tag mentioned only inside an HTML comment, a fenced code
  // block, or an inline code span is never live markup and must not be
  // rejected or resolved.
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      {
        path: "docs/a.md",
        content: Buffer.from('<!-- <a href="./missing.md">example</a> -->\n\nReal text.\n')
      }
    ])
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      {
        path: "docs/a.md",
        content: Buffer.from('```html\n<a href="./missing.md">example</a>\n```\n')
      }
    ])
  );
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      {
        path: "docs/a.md",
        content: Buffer.from('Use `<a href="./missing.md">` in your markup.\n')
      }
    ])
  );
  // A harmless raw HTML tag with no href/src (e.g. <br/>) is untouched.
  assert.doesNotThrow(() =>
    checkMarkdownLinkClosure([
      { path: "docs/a.md", content: Buffer.from("line one<br/>\nline two\n") }
    ])
  );
});

test("checkPackageScriptClosure validates only advertised scripts, including globs", () => {
  const packageJson = {
    path: "package.json",
    content: Buffer.from(
      JSON.stringify({
        scripts: {
          build: "tsc -p tsconfig.json",
          test: "npm run build && node --test tests/*.test.mjs dist/tests/*.test.js",
          "validate:demos": "npm run build && node dist/scripts/validate-demos.js"
        }
      })
    )
  };
  assert.throws(
    () =>
      checkPackageScriptClosure([packageJson], ["validate:demos"]),
    /needs scripts\/validate-demos\.ts, which is not selected/
  );
  assert.throws(
    () => checkPackageScriptClosure([packageJson], ["missing-script"]),
    /which package\.json does not define/
  );
  assert.throws(
    () => checkPackageScriptClosure([packageJson], ["test"]),
    /glob tests\/\*\.test\.mjs matches no selected file/
  );
  assert.doesNotThrow(() =>
    checkPackageScriptClosure(
      [
        packageJson,
        { path: "tests/a.test.mjs", content: Buffer.from("") },
        { path: "tests/a.test.ts", content: Buffer.from("") },
        { path: "tsconfig.json", content: Buffer.from("{}") }
      ],
      ["build", "test"]
    )
  );
  assert.doesNotThrow(() => checkPackageScriptClosure([file("not-package.json")], ["build"]));
});

test("customer-starter bundle reproduces byte-for-byte and verifies exact selection evidence", () => {
  const repository = starterRepository();
  const { headSha } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS],
    excludedPaths: []
  });
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "customer-starter-output-")));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  const buildOnce = (outputRoot: string): CustomerStarterBundleResult =>
    buildCustomerStarterBundle({
      repositoryRoot: repository.root,
      outputRoot,
      baseSha: repository.baseSha,
      headSha,
      packageVersion: "0.1.0",
      profileId: CORE_PROFILE_ID
    });
  const first = buildOnce(firstRoot);
  const second = buildOnce(secondRoot);
  assert.deepEqual({ ...first, outputRoot: "" }, { ...second, outputRoot: "" });
  assert.deepEqual(readdirSync(firstRoot).sort(), readdirSync(secondRoot).sort());
  const manifest = JSON.parse(
    readFileSync(path.join(firstRoot, "starter-manifest.json"), "utf8")
  ) as CustomerStarterManifest;
  assert.equal(manifest.profileId, CORE_PROFILE_ID);
  assert.equal(manifest.extendsProfileId, null);
  assert.ok(manifest.dependencyLockDigest !== null);
  // The catalog-sealed denylists/advertisedScripts digests are bound into
  // the manifest, deterministically derived from the exact tree/catalog,
  // never a caller-suppliable value.
  assert.equal(manifest.internalReferenceDenylistDigest, digest([]));
  assert.equal(manifest.customerDataDenylistDigest, digest([]));
  assert.equal(manifest.advertisedScriptsDigest, digest(CORE_PROFILE.advertisedScripts));
  // The selection document itself is not part of includedPaths, so it must
  // not appear in the shipped manifest -- proving the engine reads it only
  // to determine scope, never treats it as content to bundle.
  assert.ok(!manifest.files.some((entry) => entry.path === CORE_SELECTION_PATH));
  const preflight = JSON.parse(
    readFileSync(path.join(firstRoot, "starter-preflight.json"), "utf8")
  ) as { readonly decision: string; readonly authoritative: boolean; readonly selfApproved: boolean };
  assert.equal(preflight.decision, "no-go");
  assert.equal(preflight.authoritative, false);
  assert.equal(preflight.selfApproved, false);

  const verifyResult = verifyCustomerStarterBundle({
    repositoryRoot: repository.root,
    bundleRoot: firstRoot,
    baseSha: repository.baseSha,
    headSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });
  assert.deepEqual(
    canonicalJson({ ...first, outputRoot: "" }),
    canonicalJson({ ...verifyResult, outputRoot: "" })
  );

  // Catalog-bound enforcement: an unknown profileId is rejected before any
  // selection is even looked up, regardless of what the sealed catalog
  // contains.
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: repository.root,
        outputRoot: path.join(parent, "unknown-profile"),
        baseSha: repository.baseSha,
        headSha,
        packageVersion: "0.1.0",
        profileId: "evil-profile"
      }),
    /unknown customer-starter profileId evil-profile/
  );

  // "Load selection bytes from the exact Git tree" attack: an uncommitted
  // working-tree modification to the selection document (a permissive,
  // unreviewed replacement an attacker with filesystem access but not
  // commit access might make) must never let a build succeed with those
  // dirty bytes. In practice this is caught even earlier than reading the
  // selection itself: assertExactHead requires a clean worktree before any
  // file is loaded at all, so the dirty modification causes the whole
  // build to fail closed outright rather than silently succeeding with
  // either the old or the tampered selection.
  const dirtySelection = {
    ...JSON.parse(
      readFileSync(path.join(repository.root, CORE_SELECTION_PATH), "utf8")
    ) as CustomerStarterSelection,
    includedPaths: ["LICENSE"]
  };
  writeFileSync(
    path.join(repository.root, CORE_SELECTION_PATH),
    `${JSON.stringify(dirtySelection)}\n`
  );
  const dirtyWorkingTreeRoot = path.join(parent, "dirty-working-tree");
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: repository.root,
        outputRoot: dirtyWorkingTreeRoot,
        baseSha: repository.baseSha,
        headSha,
        packageVersion: "0.1.0",
        profileId: CORE_PROFILE_ID
      }),
    /worktree must be clean/
  );
  run(repository.root, "git", ["checkout", "--", CORE_SELECTION_PATH]);
  // With the working tree restored to the exact committed state, the
  // build succeeds again and reproduces the same result -- confirming the
  // rejection above was specifically about the dirty modification, not
  // some other regression.
  const restoredResult = buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: dirtyWorkingTreeRoot,
    baseSha: repository.baseSha,
    headSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });
  assert.deepEqual({ ...first, outputRoot: "" }, { ...restoredResult, outputRoot: "" });

  rmSync(parent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});

test("customer-starter build rejects an unlisted path outside the exact tree", () => {
  const repository = starterRepository();
  // A path that matches no file in the exact tree is rejected as soon as
  // its closure is resolved -- which happens both when the selection
  // document is first pinned (via computeResolvedClosureDigest, exercised
  // here through commitSelection) and independently again inside
  // buildCustomerStarterBundle/verifyCustomerStarterBundle themselves, so
  // this fails closed regardless of which of those two resolution points
  // is reached first.
  assert.throws(
    () =>
      commitSelection(repository.root, CORE_SELECTION_PATH, {
        apiVersion: "agentic-framework.github.com/v1alpha1",
        kind: "CustomerStarterSelection",
        schemaVersion: "1.0.0",
        profileId: CORE_PROFILE_ID,
        extendsProfileId: null,
        baseSelectionDigest: null,
        includedPaths: [...DEFAULT_INCLUDED_PATHS, "does/not/exist.md"].sort(),
        excludedPaths: []
      }),
    /matches no file in the exact tree/
  );
  rmSync(repository.root, { recursive: true, force: true });
});


test("customer-starter build and verify reject a portable-extraction path collision anywhere in the tree", () => {
  // Building a genuinely clean, real-file working tree containing two
  // distinct Git paths that collide under case-fold or NFC normalization
  // is not reliably constructible on every host: on a case- and Unicode-
  // normalizing-insensitive filesystem (e.g. this host's APFS volume),
  // writing the colliding path either overwrites the original file's bytes
  // (breaking the fixture) or leaves `git status` reporting the path as
  // modified no matter which of the two writes "wins" on disk -- an
  // orthogonal, legitimate clean-worktree gate (assertExactHead) that
  // build/verify always check first would then mask the collision check
  // this test targets. listGitTree reads the exact committed tree directly
  // from the object database (`git ls-tree`), independent of on-disk
  // working-tree state, so this exercises the exact shared function both
  // buildCustomerStarterBundle and verifyCustomerStarterBundle call.
  const repository = starterRepository();
  addBlobAtPath(repository.root, "docs/Overview.md", "duplicate\n");
  run(repository.root, "git", ["commit", "--quiet", "-m", "collide"]);
  const headSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => listGitTree(repository.root, headSha),
    /portable-extraction path collision/
  );
  rmSync(repository.root, { recursive: true, force: true });
});


test("customer-starter extension composes as the deterministic union of an exact base", () => {
  const repository = starterRepository();
  mkdirSync(path.join(repository.root, "extra"));
  writeFileSync(path.join(repository.root, "extra/note.md"), "extension-only file\n");
  run(repository.root, "git", ["add", "."]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "extend", "--allow-empty"]);

  const { selection: baseSelection } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS],
    excludedPaths: []
  });
  const { headSha: finalHeadSha } = commitSelection(repository.root, DEMO_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: DEMO_PROFILE_ID,
    extendsProfileId: CORE_PROFILE_ID,
    baseSelectionDigest: digest(baseSelection),
    includedPaths: ["extra/note.md"],
    excludedPaths: []
  });

  const baseParent = realpathSync(mkdtempSync(path.join(tmpdir(), "customer-starter-base-")));
  const baseRoot = path.join(baseParent, "output");
  buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: baseRoot,
    baseSha: repository.baseSha,
    headSha: finalHeadSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });
  const baseManifest = JSON.parse(
    readFileSync(path.join(baseRoot, "starter-manifest.json"), "utf8")
  ) as CustomerStarterManifest;

  // The extension build never receives a base manifest as an input at
  // all: the engine resolves selection.extendsProfileId
  // ("control-plane-core") through the same trusted, sealed catalog,
  // loads that profile's own selection from the exact reviewed tree, and
  // derives its manifest internally -- there is no parameter through
  // which a caller could supply a different, tampered base manifest.
  const extensionParent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-extension-"))
  );
  const extensionRoot = path.join(extensionParent, "output");
  buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: extensionRoot,
    baseSha: repository.baseSha,
    headSha: finalHeadSha,
    packageVersion: "0.1.0",
    profileId: DEMO_PROFILE_ID
  });
  const extensionManifest = JSON.parse(
    readFileSync(path.join(extensionRoot, "starter-manifest.json"), "utf8")
  ) as CustomerStarterManifest;
  assert.equal(extensionManifest.baseManifestDigest, digest(baseManifest));
  const basePaths = new Set(baseManifest.files.map((f) => f.path));
  const extensionPaths = extensionManifest.files.map((f) => f.path);
  assert.ok(extensionPaths.includes("extra/note.md"));
  for (const p of basePaths) assert.ok(extensionPaths.includes(p));
  assert.equal(extensionPaths.length, basePaths.size + 1);

  rmSync(baseParent, { recursive: true, force: true });
  rmSync(extensionParent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});

test("customer-starter extension build rejects an extension selection that overlaps its base profile", () => {
  const repository = starterRepository();
  const { selection: baseSelection } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS],
    excludedPaths: []
  });
  // Re-lists a path (README.md) the base profile already claims.
  const { headSha } = commitSelection(repository.root, DEMO_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: DEMO_PROFILE_ID,
    extendsProfileId: CORE_PROFILE_ID,
    baseSelectionDigest: digest(baseSelection),
    includedPaths: ["README.md"],
    excludedPaths: []
  });
  const overlapParent = realpathSync(mkdtempSync(path.join(tmpdir(), "customer-starter-overlap-")));
  const overlapRoot = path.join(overlapParent, "output");
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: repository.root,
        outputRoot: overlapRoot,
        baseSha: repository.baseSha,
        headSha,
        packageVersion: "0.1.0",
        profileId: DEMO_PROFILE_ID
      }),
    /extension selection overlaps its base profile/
  );
  rmSync(overlapParent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});


test("customer-starter build fails closed on a file added under a reviewed prefix after the selection was pinned", () => {
  // This is what remains of a two-part attack a prior review round found:
  // (1) even after removing the caller-suppliable
  // `selection`/`baseSelection`/`baseManifest`/`knownSelectionDocumentPaths`
  // parameters, buildCustomerStarterBundle/verifyCustomerStarterBundle
  // still accepted a caller-supplied `profileCatalog` parameter, and that
  // alone was exploitable: a catalog entry naming a file (e.g.
  // "src/evil.ts") is absent at the selection's reviewed sourceHeadSha (so
  // exempting it from resolvedClosureDigest there is a no-op -- it was
  // never part of the closure to begin with) but present at the current
  // build head, matching a broad reviewed prefix (e.g. "src") -- so
  // exempting it there too made resolvedClosureDigest match at *both* ends
  // while the file still shipped, because resolveSelectionOwnEntries
  // (which determines what actually ships) never consulted the exemption
  // list at all, only the digest computation did. (2) a subsequent review
  // round found that even after sealing the catalog to a fixed,
  // module-private constant inside src/customer-starter.ts, a second,
  // exported "test-fixture-only" function still accepted an arbitrary
  // caller-supplied catalog -- and being exported meant it was compiled
  // into the shipped package and reachable via a deep import regardless of
  // its name or doc comments. Neither buildCustomerStarterBundle nor
  // verifyCustomerStarterBundle nor any other exported function in
  // src/customer-starter.ts accepts a CustomerStarterProfileCatalog
  // parameter at all any more (see the `@ts-expect-error` test below), so
  // there is no longer any way -- even for a caller able to construct an
  // arbitrary in-memory object -- to attempt the "attacker-controlled
  // catalog" half of this attack; only the "honest sealed catalog, file
  // added after review" half remains meaningfully reproducible, and it
  // must still fail closed.
  const repository = starterRepository();
  mkdirSync(path.join(repository.root, "src"));
  writeFileSync(path.join(repository.root, "src/a.ts"), "export const a = 1;\n");
  run(repository.root, "git", ["add", "."]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add src"]);

  const { headSha: pinnedHeadSha } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS, "src"].sort(),
    excludedPaths: []
  });

  const firstParent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-catalog-sealed-"))
  );
  const firstOutputRoot = path.join(firstParent, "output");
  buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: firstOutputRoot,
    baseSha: repository.baseSha,
    headSha: pinnedHeadSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });

  // A file lands under the reviewed "src" prefix after the selection was
  // pinned. With the real, sealed catalog (which only ever declares the
  // two real profiles' own selection paths, never an exemption for an
  // arbitrary added file), there is no exemption available for it, so
  // building at the new head must fail closed with a closure-drift error,
  // proving the added file cannot ship silently under normal operation.
  writeFileSync(path.join(repository.root, "src/evil.ts"), "export const evil = true;\n");
  run(repository.root, "git", ["add", "src/evil.ts"]);
  run(repository.root, "git", [
    "commit",
    "--quiet",
    "-m",
    "add a file after the selection was pinned"
  ]);
  const headWithNewFile = run(repository.root, "git", ["rev-parse", "HEAD"]);
  const secondParent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-catalog-sealed-drift-"))
  );
  const secondOutputRoot = path.join(secondParent, "output");
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: repository.root,
        outputRoot: secondOutputRoot,
        baseSha: repository.baseSha,
        headSha: headWithNewFile,
        packageVersion: "0.1.0",
        profileId: CORE_PROFILE_ID
      }),
    /resolved closure has drifted/
  );

  rmSync(firstParent, { recursive: true, force: true });
  rmSync(secondParent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});

test("customer-starter sealed build/verify structurally reject a caller-supplied catalog, denylist, or advertised-script list", () => {
  // Compile-time proof complementing the runtime attack-reproduction test
  // above: buildCustomerStarterBundle/verifyCustomerStarterBundle's public
  // signatures have no profileCatalog/internalReferenceDenylist/
  // customerDataDenylist/advertisedScripts fields at all, so a real caller
  // (including a future accidental edit) cannot pass any of them --
  // TypeScript's excess-property check on an object literal argument
  // rejects the attempt outright, before this file would even build.
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: ROOT,
        outputRoot: "/nonexistent",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        packageVersion: "0.0.0",
        profileId: "control-plane-core",
        // @ts-expect-error buildCustomerStarterBundle accepts no profileCatalog parameter.
        profileCatalog: { profiles: [], internalReferenceDenylistPath: "x", customerDataDenylistPath: "y" }
      }),
    // Fails for an unrelated reason (this is not a real repository at
    // "/nonexistent"/these are not real SHAs) -- the point of this
    // assertion is only that the file still compiles, i.e. that the
    // `@ts-expect-error` above is genuinely necessary and TypeScript
    // really would otherwise accept the excess `profileCatalog` property.
    () => true
  );
  assert.throws(
    () =>
      verifyCustomerStarterBundle({
        repositoryRoot: ROOT,
        bundleRoot: "/nonexistent",
        baseSha: "a".repeat(40),
        headSha: "a".repeat(40),
        packageVersion: "0.0.0",
        profileId: "control-plane-core",
        // @ts-expect-error verifyCustomerStarterBundle accepts no profileCatalog parameter.
        profileCatalog: { profiles: [], internalReferenceDenylistPath: "x", customerDataDenylistPath: "y" }
      }),
    () => true
  );
});

test("customer-starter shipped module exports no test-fixture-only build/verify function", () => {
  // A later review round found that a second, "test-fixture-only"
  // function accepting an arbitrary caller-supplied
  // CustomerStarterProfileCatalog was still exported from
  // src/customer-starter.ts -- and being exported means it is compiled
  // into the shipped package and reachable via a deep import (e.g.
  // require("agentic-framework/dist/src/customer-starter.js").buildCustomerStarterBundleForTestFixturesOnly(...))
  // regardless of its name or doc comments. Naming/documentation is not an
  // authority boundary once a function is exported from a module that
  // ships. src/customer-starter.ts now exports no such function at all;
  // this test proves both the source text (so a future edit cannot
  // silently reintroduce one) and the actual compiled output (so a
  // reintroduction cannot slip in through some other exported name this
  // string check would miss) contain no such export.
  const source = readFileSync(path.join(ROOT, "src/customer-starter.ts"), "utf8");
  assert.ok(
    !source.includes("ForTestFixturesOnly"),
    "src/customer-starter.ts must never export a *ForTestFixturesOnly function: any exported function here is compiled into the shipped package and deep-importable regardless of naming or doc comments"
  );
});

test("customer-starter compiled module ships no test-fixture-only export", async () => {
  const compiled = (await import(
    pathToFileURL(path.join(ROOT, "dist/src/customer-starter.js")).href
  )) as Record<string, unknown>;
  assert.ok(
    !Object.keys(compiled).some((name) => name.includes("ForTestFixturesOnly")),
    "dist/src/customer-starter.js must never export a *ForTestFixturesOnly function"
  );
});

test("customer-starter CLI never imports the profile catalog module", () => {
  // scripts/customer-starter-local.ts (the real CLI that actually calls
  // buildCustomerStarterBundle/verifyCustomerStarterBundle) must never
  // import src/customer-starter-catalog.ts at all: the sealed engine
  // functions in src/customer-starter.ts are the only code that may
  // resolve the production catalog.
  // scripts/validate-customer-starter-extraction.ts legitimately imports
  // it read-only, purely to discover the real profileIds/advertisedScripts
  // for its own evidence record -- it never passes the catalog to the
  // engine (it shells out to the CLI per profileId instead), so it is
  // exempt from this stricter check.
  assert.ok(
    !readFileSync(path.join(ROOT, "scripts/customer-starter-local.ts"), "utf8").includes(
      "customer-starter-catalog"
    ),
    "scripts/customer-starter-local.ts must never import src/customer-starter-catalog.ts"
  );
});

test("mutating the exported CUSTOMER_STARTER_PROFILE_CATALOG inspection copy cannot influence buildCustomerStarterBundle's output", () => {
  // HIGH finding: CUSTOMER_STARTER_PROFILE_CATALOG was a plain, mutable
  // object, and src/customer-starter.ts's production build/verify
  // functions read that exact same live reference, so a deep import of
  // src/customer-starter-catalog.ts could mutate `.profiles`, a denylist
  // path, or an `advertisedScripts` array in place and the production
  // engine would observe the mutation. The fix keeps a module-private,
  // independently-constructed, recursively-frozen reference inside
  // src/customer-starter.ts that this exported copy is never aliased to;
  // every mutation attempt against the exported copy below must itself
  // throw (ES modules are always strict mode, so mutating a frozen object
  // throws rather than silently no-opping), and even if freezing were
  // somehow defeated, a subsequent build's output must be byte-for-byte
  // unaffected, because production code never reads this exported
  // reference at all.
  const repository = starterRepository();
  const { headSha } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS],
    excludedPaths: []
  });
  const parent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-catalog-frozen-"))
  );
  const before = buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: path.join(parent, "before"),
    baseSha: repository.baseSha,
    headSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });

  assert.throws(() => {
    (CUSTOMER_STARTER_PROFILE_CATALOG.profiles as unknown[]).push({
      profileId: "evil-profile",
      selectionPath: "src/evil.ts",
      extendsProfileId: null,
      advertisedScripts: ["build"]
    });
  }, TypeError);
  assert.throws(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (CUSTOMER_STARTER_PROFILE_CATALOG.profiles[0] as any).advertisedScripts = [];
  }, TypeError);
  assert.throws(() => {
    (CUSTOMER_STARTER_PROFILE_CATALOG.profiles[0]!.advertisedScripts as unknown[]).length = 0;
  }, TypeError);
  assert.throws(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (CUSTOMER_STARTER_PROFILE_CATALOG as any).internalReferenceDenylistPath =
      "config/does-not-exist.json";
  }, TypeError);

  const after = buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: path.join(parent, "after"),
    baseSha: repository.baseSha,
    headSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });
  assert.deepEqual({ ...before, outputRoot: "" }, { ...after, outputRoot: "" });

  rmSync(parent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});

test("customer-starter seals scan denylists into the fixed profile catalog and genuinely enforces their reviewed content", () => {
  // HIGH finding: denylists and advertisedScripts were caller-controlled;
  // an empty or narrowed denylist can make a real scan hit disappear while
  // still reporting "clean". Both are now sealed into the fixed profile
  // catalog and loaded/validated directly from the exact reviewed Git
  // tree; neither is a build/verify parameter, and there is no longer any
  // exported function through which an alternate catalog (and therefore an
  // alternate denylist path) could be substituted at all. This test proves
  // the exact reviewed denylist content is what is actually enforced: a
  // rule that matches causes a real failure, and its digest is bound into
  // the manifest.
  const repository = starterRepository();
  const { headSha: cleanHeadSha } = commitSelection(repository.root, CORE_SELECTION_PATH, {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: CORE_PROFILE_ID,
    extendsProfileId: null,
    baseSelectionDigest: null,
    includedPaths: [...DEFAULT_INCLUDED_PATHS],
    excludedPaths: []
  });
  const cleanParent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-denylist-clean-"))
  );
  const cleanOutputRoot = path.join(cleanParent, "output");
  buildCustomerStarterBundle({
    repositoryRoot: repository.root,
    outputRoot: cleanOutputRoot,
    baseSha: repository.baseSha,
    headSha: cleanHeadSha,
    packageVersion: "0.1.0",
    profileId: CORE_PROFILE_ID
  });
  const cleanManifest = JSON.parse(
    readFileSync(path.join(cleanOutputRoot, "starter-manifest.json"), "utf8")
  ) as CustomerStarterManifest;
  assert.equal(cleanManifest.internalReferenceDenylistDigest, digest([]));

  // Recommit a non-empty, genuinely matching internal-reference denylist
  // rule (README.md's own content always contains the word "Starter" per
  // starterRepository()'s fixture) and rebuild: the new rule must be
  // genuinely read from the exact tree and enforced -- not silently
  // ignored as an empty/cached value -- proving denylist content actually
  // drives scan behavior rather than being a caller-suppliable formality.
  const matchingDenylist = [
    { id: "no-starter-word", pattern: "Starter", reason: "test: must genuinely match README.md" }
  ];
  writeFileSync(
    path.join(repository.root, INTERNAL_REFERENCE_DENYLIST_PATH),
    `${JSON.stringify(matchingDenylist)}\n`
  );
  run(repository.root, "git", ["add", INTERNAL_REFERENCE_DENYLIST_PATH]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "tighten internal-reference denylist"]);
  const tightenedHeadSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  // The selection is unaffected by this denylist-only change (the
  // denylist path is not part of includedPaths), so resolvedClosureDigest
  // still matches; ancestry lets the same pinned selection validate at
  // the new head.
  const matchParent = realpathSync(
    mkdtempSync(path.join(tmpdir(), "customer-starter-denylist-match-"))
  );
  const matchOutputRoot = path.join(matchParent, "output");
  assert.throws(
    () =>
      buildCustomerStarterBundle({
        repositoryRoot: repository.root,
        outputRoot: matchOutputRoot,
        baseSha: repository.baseSha,
        headSha: tightenedHeadSha,
        packageVersion: "0.1.0",
        profileId: CORE_PROFILE_ID
      }),
    /failed internal-reference-scan rule "no-starter-word"/
  );

  rmSync(cleanParent, { recursive: true, force: true });
  rmSync(matchParent, { recursive: true, force: true });
  rmSync(repository.root, { recursive: true, force: true });
});
