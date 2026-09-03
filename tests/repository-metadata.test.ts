import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  EXPECTED_REPOSITORY_METADATA_CONTRACT,
  assertRepositoryMetadataContract,
  loadRepositoryMetadataContract,
  parseRepositoryMetadataReadback,
  planRepositoryMetadataReconciliation
} from "../scripts/plan-repository-metadata.js";
import { parseStrictJson } from "../src/strict-json.js";

const ROOT = process.cwd();
const CONTRACT = loadRepositoryMetadataContract(ROOT);
const CURRENT_PUBLIC_DESCRIPTION = [
  "GitHub-native agentic",
  "framework for scaling human capability through autonomous teams, deterministic workflows, and human-governed execution."
].join(" ");

function currentPublicReadback(): unknown {
  return {
    description: CURRENT_PUBLIC_DESCRIPTION,
    homepageUrl: "",
    id: "R_kgDOUMHgnA",
    nameWithOwner: "IraLeeBell/hyperfinite",
    repositoryTopics: null,
    viewerCanAdminister: true,
    viewerPermission: "ADMIN"
  };
}

function matchingReadback(): unknown {
  return {
    description: CONTRACT.desired.description,
    homepageUrl: "",
    id: CONTRACT.repository.nodeId,
    nameWithOwner: CONTRACT.repository.fullName,
    repositoryTopics: CONTRACT.desired.topics.map((name) => ({ name })),
    viewerCanAdminister: true,
    viewerPermission: "ADMIN"
  };
}

function prefixMatches(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

test("repository metadata contract is closed to the authoritative repository and accepted wording", () => {
  assert.deepEqual(CONTRACT, EXPECTED_REPOSITORY_METADATA_CONTRACT);
  const issueTaxonomy = parseStrictJson(
    readFileSync("config/v1alpha1/issue-taxonomy.json", "utf8")
  ) as {
    readonly repository: {
      readonly fullName: string;
      readonly repositoryId: number;
      readonly defaultBranch: string;
    };
  };
  assert.equal(
    CONTRACT.repository.fullName,
    issueTaxonomy.repository.fullName
  );
  assert.equal(
    CONTRACT.repository.databaseId,
    issueTaxonomy.repository.repositoryId
  );
  assert.equal(
    CONTRACT.repository.defaultBranch,
    issueTaxonomy.repository.defaultBranch
  );
  assert.equal(CONTRACT.desired.homepage, null);
  assert.deepEqual(CONTRACT.desired.topics, [
    "agentic-ai",
    "agentic-workflows",
    "ai-governance",
    "deterministic-systems",
    "github-actions",
    "human-in-the-loop",
    "llm-security",
    "policy-as-code"
  ]);

  const readme = readFileSync("README.md", "utf8");
  assert.match(
    readme,
    /Hyperfinite is a GitHub-native control plane for governed, model-assisted work\./u
  );
  assert.match(
    readme,
    /Models may propose bounded work; deterministic systems authorize it, bind every\ntarget, and execute only allowed effects\./u
  );
  assert.doesNotMatch(CONTRACT.desired.description, /autonomous team/iu);
});

test("contract schema and independent constants reject widening or substitution", () => {
  const schema = parseStrictJson(
    readFileSync(
      "schemas/v1alpha1/repository-metadata.schema.json",
      "utf8"
    )
  );
  assert.throws(
    () =>
      assertRepositoryMetadataContract(schema, {
        ...EXPECTED_REPOSITORY_METADATA_CONTRACT,
        repository: {
          ...EXPECTED_REPOSITORY_METADATA_CONTRACT.repository,
          fullName: "attacker/substitute"
        }
      }),
    /repository metadata contract is invalid|exact reviewed repository/u
  );
  assert.throws(
    () =>
      assertRepositoryMetadataContract(schema, {
        ...EXPECTED_REPOSITORY_METADATA_CONTRACT,
        desired: {
          ...EXPECTED_REPOSITORY_METADATA_CONTRACT.desired,
          topics: [
            ...EXPECTED_REPOSITORY_METADATA_CONTRACT.desired.topics,
            "unreviewed-topic"
          ]
        }
      }),
    /repository metadata contract is invalid|exact reviewed repository/u
  );
  assert.throws(
    () =>
      assertRepositoryMetadataContract(schema, {
        ...EXPECTED_REPOSITORY_METADATA_CONTRACT,
        unknownAuthority: true
      }),
    /repository metadata contract is invalid/u
  );
});

test("current public state produces the exact human-admin drift plan without mutation", () => {
  const readback = parseRepositoryMetadataReadback(
    CONTRACT,
    currentPublicReadback()
  );
  const plan = planRepositoryMetadataReconciliation(CONTRACT, readback);

  assert.equal(plan.status, "human-admin-apply-required");
  assert.equal(plan.drift.found, true);
  assert.equal(plan.drift.description, "replace");
  assert.equal(plan.drift.homepage, "none");
  assert.deepEqual(plan.drift.topics.add, CONTRACT.desired.topics);
  assert.deepEqual(plan.drift.topics.remove, []);
  assert.equal(plan.administration.adminEligible, true);
  assert.equal(plan.administration.builtInGithubTokenCanApply, false);
  assert.equal(plan.administration.mergeAppliesMetadata, false);
  assert.equal(plan.administration.mutationPerformed, false);
});

test("matching readback is accepted only for the exact identity and complete topic set", () => {
  const readback = parseRepositoryMetadataReadback(
    CONTRACT,
    matchingReadback()
  );
  const plan = planRepositoryMetadataReconciliation(CONTRACT, readback);
  assert.equal(plan.status, "in-sync");
  assert.equal(plan.drift.found, false);
  assert.deepEqual(plan.drift.topics, { add: [], remove: [] });

  const nonAdminPlan = planRepositoryMetadataReconciliation(
    CONTRACT,
    parseRepositoryMetadataReadback(CONTRACT, {
      ...(matchingReadback() as Readonly<Record<string, unknown>>),
      viewerCanAdminister: false,
      viewerPermission: "READ"
    })
  );
  assert.equal(nonAdminPlan.drift.found, false);
  assert.equal(nonAdminPlan.status, "blocked-insufficient-admin");
  assert.equal(nonAdminPlan.administration.adminEligible, false);

  assert.throws(
    () =>
      parseRepositoryMetadataReadback(CONTRACT, {
        ...(matchingReadback() as Readonly<Record<string, unknown>>),
        id: "R_substitute"
      }),
    /exact configured repository identity/u
  );
  assert.throws(
    () =>
      parseRepositoryMetadataReadback(CONTRACT, {
        ...(matchingReadback() as Readonly<Record<string, unknown>>),
        nameWithOwner: "attacker/substitute"
      }),
    /exact configured repository identity/u
  );
});

test("unknown topics are planned for removal and non-admin drift remains blocked", () => {
  const drifted = {
    ...(matchingReadback() as Readonly<Record<string, unknown>>),
    repositoryTopics: [
      ...CONTRACT.desired.topics.map((name) => ({ name })),
      { name: "unreviewed-topic" }
    ],
    viewerCanAdminister: false,
    viewerPermission: "WRITE"
  };
  const plan = planRepositoryMetadataReconciliation(
    CONTRACT,
    parseRepositoryMetadataReadback(CONTRACT, drifted)
  );
  assert.equal(plan.status, "blocked-insufficient-admin");
  assert.deepEqual(plan.drift.topics.add, []);
  assert.deepEqual(plan.drift.topics.remove, ["unreviewed-topic"]);
  assert.equal(plan.administration.adminEligible, false);

  assert.throws(
    () =>
      parseRepositoryMetadataReadback(CONTRACT, {
        ...drifted,
        repositoryTopics: [
          { name: "duplicate-topic" },
          { name: "duplicate-topic" }
        ]
      }),
    /duplicate topic/u
  );
  assert.throws(
    () =>
      parseRepositoryMetadataReadback(CONTRACT, {
        ...drifted,
        unexpected: true
      }),
    /unknown or missing fields/u
  );
});

test("all repository metadata authority flags remain false", () => {
  assert.equal(CONTRACT.authorityBoundary.surface, "display-and-discovery-only");
  const grants = Object.entries(CONTRACT.authorityBoundary).filter(
    ([name]) => name.startsWith("grants")
  );
  assert.equal(grants.length, 9);
  for (const [, granted] of grants) {
    assert.equal(granted, false);
  }
});

test("planner CLI accepts only strict gh repo view JSON on stdin and exposes no apply path", () => {
  const result = spawnSync(
    process.execPath,
    ["dist/scripts/plan-repository-metadata.js"],
    {
      cwd: ROOT,
      encoding: "utf8",
      input: JSON.stringify(currentPublicReadback())
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const output = parseStrictJson(result.stdout) as {
    readonly status: string;
    readonly administration: {
      readonly mutationPerformed: boolean;
    };
  };
  assert.equal(output.status, "human-admin-apply-required");
  assert.equal(output.administration.mutationPerformed, false);

  const withArgument = spawnSync(
    process.execPath,
    ["dist/scripts/plan-repository-metadata.js", "--repo", "attacker/repo"],
    {
      cwd: ROOT,
      encoding: "utf8",
      input: JSON.stringify(currentPublicReadback())
    }
  );
  assert.notEqual(withArgument.status, 0);
  assert.match(withArgument.stderr, /optionless/u);

  const source = readFileSync(
    "scripts/plan-repository-metadata.ts",
    "utf8"
  );
  const imports = [
    ...source.matchAll(/^import(?: type)? .* from "([^"]+)";$/gmu)
  ]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(imports, [
    "../src/canonical.js",
    "../src/strict-json.js",
    "ajv",
    "ajv/dist/2020.js",
    "node:fs",
    "node:path",
    "node:url"
  ]);
  assert.doesNotMatch(
    source,
    /\b(?:fetch|require|XMLHttpRequest|WebSocket)\s*\(/u
  );
  assert.doesNotMatch(source, /\bimport\s*\(/u);
  assert.doesNotMatch(
    source,
    /\b(?:appendFile|chmod|chown|copyFile|link|mkdir|open|rename|rm|symlink|truncate|unlink|writeFile)(?:Sync)?\s*\(/u
  );
});

test("repository administration mechanism is absent from customer-starter profiles", () => {
  const selection = parseStrictJson(
    readFileSync(
      "config/v1alpha1/customer-starter-selection.json",
      "utf8"
    )
  ) as {
    readonly includedPaths: readonly string[];
    readonly excludedPaths: readonly string[];
  };
  const mechanismPaths = [
    "config/v1alpha1/repository-metadata.json",
    "schemas/v1alpha1/repository-metadata.schema.json",
    "scripts/plan-repository-metadata.ts",
    "tests/repository-metadata.test.ts"
  ];
  for (const candidate of mechanismPaths) {
    const selected =
      selection.includedPaths.some((prefix) =>
        prefixMatches(prefix, candidate)
      ) &&
      !selection.excludedPaths.some((prefix) =>
        prefixMatches(prefix, candidate)
      );
    assert.equal(selected, false, candidate);
  }
});
