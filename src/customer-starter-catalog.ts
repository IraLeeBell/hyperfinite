// The closed, reviewed customer-starter profile catalog.
//
// This is the single trusted source of "which profiles exist, at which
// exact committed selection-document path, extending which base profile
// (if any), advertising which package.json scripts as standalone-
// runnable" plus the two exact committed scan-denylist document paths
// shared by every profile. It exists precisely so that no caller of the
// customer-starter engine (src/customer-starter.ts) -- neither the CLI
// (scripts/customer-starter-local.ts) nor any other future integration --
// can supply an alternate selection object, an alternate selection-
// document path, an alternate "known selection document paths" exemption
// list, an alternate scan denylist, or an alternate advertised-script
// list that is not bound to this catalog. The engine always resolves a
// profile by profileId through the *fixed* production catalog
// (CUSTOMER_STARTER_PROFILE_CATALOG) baked into its public
// buildCustomerStarterBundle/verifyCustomerStarterBundle entry points,
// then reads that profile's exact selection and denylist bytes directly
// from the exact reviewed Git tree; it never accepts any of these as an
// in-memory value from a production caller.
//
// A prior review round found that accepting a caller-supplied catalog as
// a parameter of the public build/verify API was itself exploitable: a
// caller could supply a catalog whose knownSelectionDocumentPaths
// exemption set additionally named a file that did not exist yet at the
// selection's reviewed sourceHeadSha (so the exemption was a no-op there)
// but did exist at the current build head, matching a broad reviewed
// prefix (so it would ship) -- the exemption made resolvedClosureDigest
// match at both ends while the file still shipped. The fix resolved that
// round was: only module-private code in src/customer-starter.ts ever
// resolves the fixed CUSTOMER_STARTER_PROFILE_CATALOG; there is no
// parameter on the public API through which any catalog, denylist, or
// advertised-script list can be substituted.
//
// A subsequent review round found that fix was still incomplete: a
// second, "test-fixture-only" entry point that DID accept a
// caller-supplied catalog was still exported from src/customer-starter.ts
// -- and being exported means it is compiled into the shipped package and
// reachable via a deep import (e.g.
// `require("agentic-framework/dist/src/customer-starter.js").buildCustomerStarterBundleForTestFixturesOnly(...)`)
// regardless of its name or doc comments. Naming/documentation is not an
// authority boundary once a function is exported from a module that
// ships. src/customer-starter.ts therefore exports no such function at
// all any more: tests/customer-starter.test.ts exercises
// buildCustomerStarterBundle/verifyCustomerStarterBundle exclusively
// through their real, sealed, catalog-fixed profileIds
// ("control-plane-core"/"demo-portfolio") against small hermetic
// synthetic repositories that commit their own selection/denylist
// documents at this catalog's exact real paths.
//
// That same round also found the sealed catalog itself was still
// runtime-mutable: CUSTOMER_STARTER_PROFILE_CATALOG below was a plain,
// unfrozen object, and src/customer-starter.ts's production build/verify
// functions read that same live reference -- so a deep import of this
// module could mutate `.profiles`, a denylist path, or an
// `advertisedScripts` array in place, and the production engine would
// observe the mutation. The fix is two-layered:
//
//   1. createCustomerStarterProfileCatalogSeed() below returns a brand
//      new, independent object graph (no shared array/object references)
//      on every call, and is otherwise inert plain data with no ambient
//      state of its own.
//   2. Every consumer of the catalog -- this module's own exported
//      CUSTOMER_STARTER_PROFILE_CATALOG inspection copy, and
//      src/customer-starter.ts's module-private production reference --
//      calls createCustomerStarterProfileCatalogSeed() independently and
//      immediately validates + recursively Object.freezes its own result.
//      Recursive freezing alone (in ES modules, always strict mode)
//      already turns any mutation attempt into a thrown TypeError rather
//      than a silent no-op; constructing the two references from
//      independent seed calls additionally means that even a mutation
//      vector that somehow defeated Object.freeze on one reference could
//      not reach the other, because they do not share a single object
//      graph. src/customer-starter.ts's own reference is never exported
//      from that module at all, so it cannot be reached by a deep import
//      regardless.

export interface CustomerStarterProfileCatalogEntry {
  readonly profileId: string;
  readonly selectionPath: string;
  readonly extendsProfileId: string | null;
  // Sealed here (rather than accepted as a build/verify parameter) so a
  // caller cannot substitute an empty or narrowed script list to make a
  // meaningfully-incomplete profile falsely advertise standalone-
  // runnability, or substitute a wider one claiming standalone support
  // the profile does not actually have.
  readonly advertisedScripts: readonly string[];
}

export interface CustomerStarterProfileCatalog {
  readonly profiles: readonly CustomerStarterProfileCatalogEntry[];
  // Sealed here (rather than accepted as build/verify parameters) so a
  // caller cannot substitute an empty or narrowed denylist to make a
  // real scan hit disappear while still reporting "clean". Both are
  // shared, catalog-level (not per-profile) documents: every profile in
  // this system is scanned against the exact same reviewed pattern set.
  readonly internalReferenceDenylistPath: string;
  readonly customerDataDenylistPath: string;
}

const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ADVERTISED_SCRIPT_NAME = /^[a-z][a-z0-9:_-]*$/u;

function isNonEmptyRelativePath(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("..");
}

/**
 * Validates a profile catalog's internal consistency: every profileId is
 * uniquely and validly shaped, every selectionPath is unique (so no two
 * profiles could ever be confused with one another, and no single path
 * could resolve to two different profiles), every non-null
 * extendsProfileId names another profile actually present in the same
 * catalog (so composition can never point outside the catalog's own
 * closed set) with no self-extension and no multi-level chain (this
 * system supports exactly one level of composition, matching
 * deriveCustomerStarterArtifacts's own enforcement that a base selection
 * must not itself extend another profile), every profile declares at
 * least one validly-named advertised script, and the two shared denylist
 * paths are well-formed, non-empty, and distinct from every selection
 * path (so a denylist document can never be confused with, or silently
 * substitute for, a selection document).
 */
export function validateProfileCatalog(
  catalog: CustomerStarterProfileCatalog
): CustomerStarterProfileCatalog {
  const profiles = catalog.profiles;
  if (profiles.length < 1) throw new TypeError("customer-starter profile catalog must not be empty");
  if (
    !isNonEmptyRelativePath(catalog.internalReferenceDenylistPath) ||
    !isNonEmptyRelativePath(catalog.customerDataDenylistPath)
  ) {
    throw new TypeError("customer-starter profile catalog has an invalid denylist path");
  }
  if (catalog.internalReferenceDenylistPath === catalog.customerDataDenylistPath) {
    throw new TypeError("customer-starter profile catalog's two denylist paths must be distinct");
  }
  const profileIds = new Set<string>();
  const selectionPaths = new Set<string>();
  for (const entry of profiles) {
    if (!PROFILE_ID.test(entry.profileId)) {
      throw new TypeError(`customer-starter profile catalog entry has an invalid profileId: ${entry.profileId}`);
    }
    if (profileIds.has(entry.profileId)) {
      throw new TypeError(`customer-starter profile catalog has a duplicate profileId: ${entry.profileId}`);
    }
    profileIds.add(entry.profileId);
    if (selectionPaths.has(entry.selectionPath)) {
      throw new TypeError(
        `customer-starter profile catalog has a duplicate selectionPath: ${entry.selectionPath}`
      );
    }
    selectionPaths.add(entry.selectionPath);
    if (
      entry.selectionPath === catalog.internalReferenceDenylistPath ||
      entry.selectionPath === catalog.customerDataDenylistPath
    ) {
      throw new TypeError(
        `customer-starter profile catalog entry ${entry.profileId}'s selectionPath collides with a shared denylist path`
      );
    }
    if (entry.extendsProfileId === entry.profileId) {
      throw new TypeError(`customer-starter profile catalog entry ${entry.profileId} cannot extend itself`);
    }
    if (
      entry.advertisedScripts.length < 1 ||
      entry.advertisedScripts.length > 64 ||
      new Set(entry.advertisedScripts).size !== entry.advertisedScripts.length ||
      !entry.advertisedScripts.every((name) => ADVERTISED_SCRIPT_NAME.test(name))
    ) {
      throw new TypeError(
        `customer-starter profile catalog entry ${entry.profileId} has an invalid advertisedScripts list`
      );
    }
  }
  for (const entry of profiles) {
    if (entry.extendsProfileId === null) continue;
    const base = profiles.find((candidate) => candidate.profileId === entry.extendsProfileId);
    if (base === undefined) {
      throw new TypeError(
        `customer-starter profile catalog entry ${entry.profileId} extends ${entry.extendsProfileId}, which is not present in the same catalog`
      );
    }
    if (base.extendsProfileId !== null) {
      throw new TypeError(
        `customer-starter profile catalog entry ${entry.profileId} extends ${entry.extendsProfileId}, which itself extends another profile; only one level of composition is supported`
      );
    }
  }
  return catalog;
}

/** Looks up a profile by exact profileId within a validated catalog. */
export function findProfileCatalogEntry(
  catalog: CustomerStarterProfileCatalog,
  profileId: string
): CustomerStarterProfileCatalogEntry {
  const entry = catalog.profiles.find((candidate) => candidate.profileId === profileId);
  if (entry === undefined) {
    throw new TypeError(
      `unknown customer-starter profileId ${profileId}; known profiles: ${catalog.profiles.map((candidate) => candidate.profileId).join(", ")}`
    );
  }
  return entry;
}

/**
 * Every selection-document path a given catalog declares, derived (never
 * caller-suppliable) so the resolved closure digest can safely exempt a
 * profile's own (or a sibling profile's) selection document by exact path
 * without ever accepting an exemption for any other file.
 */
export function knownSelectionDocumentPathsFor(
  catalog: CustomerStarterProfileCatalog
): readonly string[] {
  return catalog.profiles.map((entry) => entry.selectionPath);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Returns a brand-new, independent CustomerStarterProfileCatalog object
 * graph (no shared array/object references with any other call's result)
 * describing the reviewed, fixed set of customer-starter profiles. This
 * is deliberately exported plain data with no ambient state: it is not
 * itself the authority boundary. Every real consumer -- this module's own
 * CUSTOMER_STARTER_PROFILE_CATALOG inspection copy below, and
 * src/customer-starter.ts's separate module-private production reference
 * -- calls this function independently and immediately validates +
 * recursively freezes its own result, so the two never share one
 * mutable object graph.
 */
export function createCustomerStarterProfileCatalogSeed(): CustomerStarterProfileCatalog {
  return {
    internalReferenceDenylistPath: "config/v1alpha1/customer-starter-internal-references.json",
    customerDataDenylistPath: "config/v1alpha1/customer-starter-customer-data-patterns.json",
    profiles: [
      {
        profileId: "control-plane-core",
        selectionPath: "config/v1alpha1/customer-starter-selection.json",
        extendsProfileId: null,
        advertisedScripts: [
          "build",
          "typecheck",
          "test",
          "validate:packaging",
          "validate:provenance",
          "validate:technical-identity"
          // "github:setup" is intentionally not advertised: bare (with no
          // extra CLI arguments) its default "plan" command always throws
          // ("plan requires --live with an exported fresh Project read"),
          // discovered empirically by
          // scripts/validate-customer-starter-extraction.ts. Advertising it
          // here would be a false claim that this profile does not
          // actually keep; scripts/github-setup.ts's own richer command
          // surface is still shipped and usable with the arguments it
          // documents.
        ]
      },
      {
        profileId: "demo-portfolio",
        selectionPath: "config/v1alpha1/customer-starter-demo-portfolio-selection.json",
        extendsProfileId: "control-plane-core",
        advertisedScripts: [
          "build",
          "typecheck",
          "test",
          "validate:packaging",
          "validate:provenance",
          "validate:technical-identity",
          "validate:schemas",
          "validate:runtime",
          // "validate:workflows" and "validate:gh-aw" are intentionally not
          // advertised: both shell out to `gh aw compile`, which itself
          // requires running inside a real Git repository ("compile
          // without arguments requires being in a git repository"), so
          // neither can run standalone in an extracted (no-.git) bundle --
          // discovered empirically by
          // scripts/validate-customer-starter-extraction.ts. This is the
          // same category of limitation as scripts/installer.ts and
          // tests/packaging.test.ts (ADR 0009's exact-head model), not a
          // gap this profile introduces. "validate:demos" is excluded for
          // the same underlying reason: it unconditionally shells out to
          // dist/scripts/validate-workflows.js as one of its own steps, so
          // it inherits the same real-Git-repository requirement
          // transitively. "validate:hardening" is excluded too: its
          // closed, human-reviewed hardening plan
          // (config/v1alpha1/demo-portfolio/hardening-plan.json) mandates
          // dist/tests/packaging.test.js among its exact 21 test files,
          // and that test file's own installer-CLI subprocess cases
          // require the real repository's Git history to pass -- the same
          // root cause, not a gap in the plan itself.
          "validate:eval-fixtures",
          // "validate:review-agent-runtime" is excluded: it unconditionally
          // requires the COPILOT_CLI_ARCHIVE_PATH and GH_AW_HARNESS_PATH
          // environment variables, pointing at a pre-fetched Copilot CLI
          // archive and gh-aw harness this profile does not ship or
          // fetch, so it cannot run bare with zero external setup.
          "simulate:demos"
          // "eval:behavioral" is excluded: it unconditionally requires
          // --responses-dir=<reviewed-response-records>, pointing at
          // externally-reviewed response records this profile does not
          // ship ("this command never starts paid inference").
          // "generate:hybrid-demo-contracts" is repository-only because its
          // reviewed output includes private live Project target identities.
          // The demo customer starter excludes both that generator and
          // the target-bound bootstrap test rather than exporting live targets.
        ]
      }
    ]
  };
}

// A detached, immutable inspection copy of the production catalog, for
// read-only tooling that needs to discover profileIds/selectionPaths/
// advertisedScripts (e.g. scripts/validate-customer-starter-extraction.ts's
// own evidence-gathering, and tests/customer-starter.test.ts's fixtures)
// without ever being able to influence what src/customer-starter.ts's
// build/verify functions actually resolve. It is constructed from its own
// independent call to createCustomerStarterProfileCatalogSeed() and
// recursively frozen immediately, so mutating it (which throws under ES
// modules' always-strict-mode semantics) has no effect on, and shares no
// object graph with, src/customer-starter.ts's own separately-constructed
// module-private reference.
export const CUSTOMER_STARTER_PROFILE_CATALOG: CustomerStarterProfileCatalog = deepFreeze(
  validateProfileCatalog(createCustomerStarterProfileCatalogSeed())
);
