import { digest } from "./canonical.js";
import {
  computeResolvedClosureDigest,
  validateCustomerStarterSelection
} from "./customer-starter.js";
import type { CustomerStarterSelection } from "./packaging-types.js";
import { listGitTree } from "./release-support.js";
import { assertDocument } from "./validation.js";

function selection(value: unknown, profileId: string): CustomerStarterSelection {
  const document = assertDocument("PackagingDocument", value);
  if (
    document.kind !== "CustomerStarterSelection" ||
    document.profileId !== profileId
  ) {
    throw new TypeError(
      `customer starter repin expected ${profileId} selection`
    );
  }
  return document;
}

function prefixMatches(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function normalizeAbsentExclusions(
  selection: CustomerStarterSelection,
  paths: readonly string[]
): CustomerStarterSelection {
  return {
    ...selection,
    excludedPaths: selection.excludedPaths.filter((excluded) =>
      paths.some(
        (candidate) =>
          selection.includedPaths.some((included) =>
            prefixMatches(included, candidate)
          ) && prefixMatches(excluded, candidate)
      )
    )
  };
}

export function createRepinnedCustomerStarterSelections(input: {
  readonly root: string;
  readonly headSha: string;
  readonly coreSelection: unknown;
  readonly demoSelection: unknown;
  readonly knownSelectionDocumentPaths: readonly string[];
}): {
  readonly core: CustomerStarterSelection;
  readonly demo: CustomerStarterSelection;
} {
  const paths = listGitTree(input.root, input.headSha).map((entry) => entry.path);
  const currentCore = normalizeAbsentExclusions(
    selection(input.coreSelection, "control-plane-core"),
    paths
  );
  const currentDemo = normalizeAbsentExclusions(
    selection(input.demoSelection, "demo-portfolio"),
    paths
  );
  if (
    currentCore.extendsProfileId !== null ||
    currentCore.baseSelectionDigest !== null ||
    currentDemo.extendsProfileId !== "control-plane-core" ||
    currentDemo.baseSelectionDigest === null
  ) {
    throw new TypeError("customer starter profile relationship is invalid");
  }

  const coreCandidate = {
    ...currentCore,
    sourceHeadSha: input.headSha
  };
  const core = validateCustomerStarterSelection(
    {
      ...coreCandidate,
      resolvedClosureDigest: computeResolvedClosureDigest(
        input.root,
        coreCandidate,
        input.headSha,
        input.knownSelectionDocumentPaths
      )
    },
    input.headSha,
    input.root,
    input.knownSelectionDocumentPaths
  );

  const demoCandidate = {
    ...currentDemo,
    baseSelectionDigest: digest(core),
    sourceHeadSha: input.headSha
  };
  const demo = validateCustomerStarterSelection(
    {
      ...demoCandidate,
      resolvedClosureDigest: computeResolvedClosureDigest(
        input.root,
        demoCandidate,
        input.headSha,
        input.knownSelectionDocumentPaths
      )
    },
    input.headSha,
    input.root,
    input.knownSelectionDocumentPaths
  );
  return { core, demo };
}
