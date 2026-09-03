#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AnySchema } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

import { canonicalJson, digest } from "../src/canonical.js";
import { parseStrictJson } from "../src/strict-json.js";

const CONFIG_PATH = "config/v1alpha1/repository-metadata.json";
const SCHEMA_PATH = "schemas/v1alpha1/repository-metadata.schema.json";
const TOPIC_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPOSITORY_PERMISSIONS = [
  "ADMIN",
  "MAINTAIN",
  "READ",
  "TRIAGE",
  "WRITE"
] as const;

export const EXPECTED_REPOSITORY_METADATA_CONTRACT = {
  apiVersion: "agentic-framework.github.com/v1alpha1",
  kind: "RepositoryMetadataContract",
  schemaVersion: "1.0.0",
  repository: {
    owner: "IraLeeBell",
    name: "hyperfinite",
    fullName: "IraLeeBell/hyperfinite",
    databaseId: 1354883228,
    nodeId: "R_kgDOUMHgnA",
    defaultBranch: "main"
  },
  desired: {
    description:
      "GitHub-native control plane that keeps model output advisory and execution authority deterministic.",
    homepage: null,
    topics: [
      "agentic-ai",
      "agentic-workflows",
      "ai-governance",
      "deterministic-systems",
      "github-actions",
      "human-in-the-loop",
      "llm-security",
      "policy-as-code"
    ]
  },
  administration: {
    applyMode: "human-admin-plan-confirm-readback",
    requiredRepositoryRole: "ADMIN",
    requiredApiPermission: "Administration: write",
    builtInGithubTokenCanApply: false,
    mergeAppliesMetadata: false,
    requiresSeparateHumanConfirmation: true,
    requiresFreshPreApplyRead: true,
    requiresFreshPostApplyReadback: true
  },
  authorityBoundary: {
    surface: "display-and-discovery-only",
    grantsLifecycleAuthority: false,
    grantsRepositoryAuthority: false,
    grantsTargetAuthority: false,
    grantsProjectAuthority: false,
    grantsCapabilityAuthority: false,
    grantsCredentialAuthority: false,
    grantsTransitionAuthority: false,
    grantsReleaseAuthority: false,
    grantsEffectAuthority: false
  }
} as const;

export type RepositoryMetadataContract =
  typeof EXPECTED_REPOSITORY_METADATA_CONTRACT;
export type RepositoryPermission = (typeof REPOSITORY_PERMISSIONS)[number];

export interface RepositoryMetadataReadback {
  readonly repository: {
    readonly fullName: string;
    readonly nodeId: string;
  };
  readonly description: string | null;
  readonly homepage: string | null;
  readonly topics: readonly string[];
  readonly viewerCanAdminister: boolean;
  readonly viewerPermission: RepositoryPermission;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRepositoryPermission(
  value: unknown
): value is RepositoryPermission {
  return (
    typeof value === "string" &&
    (REPOSITORY_PERMISSIONS as readonly string[]).includes(value)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Readonly<Record<string, unknown>>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  location: string
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(required)) {
    throw new TypeError(`${location} has unknown or missing fields`);
  }
}

export function assertRepositoryMetadataContract(
  schema: unknown,
  value: unknown
): RepositoryMetadataContract {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema as AnySchema);
  if (!validate(value)) {
    throw new TypeError(
      `repository metadata contract is invalid: ${ajv.errorsText(
        validate.errors,
        { separator: "; " }
      )}`
    );
  }
  if (
    canonicalJson(value) !==
    canonicalJson(EXPECTED_REPOSITORY_METADATA_CONTRACT)
  ) {
    throw new TypeError(
      "repository metadata contract must match the exact reviewed repository and desired state"
    );
  }
  return deepFreeze(
    structuredClone(value)
  ) as RepositoryMetadataContract;
}

export function loadRepositoryMetadataContract(
  root: string
): RepositoryMetadataContract {
  const canonicalRoot = realpathSync(root);
  const schema = parseStrictJson(
    readFileSync(path.join(canonicalRoot, SCHEMA_PATH), "utf8")
  );
  const value = parseStrictJson(
    readFileSync(path.join(canonicalRoot, CONFIG_PATH), "utf8")
  );
  return assertRepositoryMetadataContract(schema, value);
}

function parseTopics(value: unknown): readonly string[] {
  if (value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 20) {
    throw new TypeError(
      "repository metadata readback repositoryTopics must be null or an array of at most 20 topics"
    );
  }
  const topics = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(
        `repository metadata readback repositoryTopics/${index} must be an object`
      );
    }
    assertExactKeys(
      entry,
      ["name"],
      `repository metadata readback repositoryTopics/${index}`
    );
    const name = entry["name"];
    if (
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 50 ||
      !TOPIC_PATTERN.test(name)
    ) {
      throw new TypeError(
        `repository metadata readback repositoryTopics/${index}/name is not a bounded GitHub topic`
      );
    }
    return name;
  });
  if (new Set(topics).size !== topics.length) {
    throw new TypeError(
      "repository metadata readback repositoryTopics contains a duplicate topic"
    );
  }
  return topics.sort();
}

export function parseRepositoryMetadataReadback(
  contract: RepositoryMetadataContract,
  value: unknown
): RepositoryMetadataReadback {
  if (!isRecord(value)) {
    throw new TypeError("repository metadata readback must be an object");
  }
  assertExactKeys(
    value,
    [
      "description",
      "homepageUrl",
      "id",
      "nameWithOwner",
      "repositoryTopics",
      "viewerCanAdminister",
      "viewerPermission"
    ],
    "repository metadata readback"
  );
  if (
    value["nameWithOwner"] !== contract.repository.fullName ||
    value["id"] !== contract.repository.nodeId
  ) {
    throw new TypeError(
      "repository metadata readback does not match the exact configured repository identity"
    );
  }
  const description = value["description"];
  if (
    description !== null &&
    (typeof description !== "string" || description.length > 350)
  ) {
    throw new TypeError(
      "repository metadata readback description must be null or a string of at most 350 characters"
    );
  }
  const homepageUrl = value["homepageUrl"];
  if (
    homepageUrl !== null &&
    (typeof homepageUrl !== "string" || homepageUrl.length > 2048)
  ) {
    throw new TypeError(
      "repository metadata readback homepageUrl must be null or a bounded string"
    );
  }
  const viewerCanAdminister = value["viewerCanAdminister"];
  if (typeof viewerCanAdminister !== "boolean") {
    throw new TypeError(
      "repository metadata readback viewerCanAdminister must be a boolean"
    );
  }
  const viewerPermission = value["viewerPermission"];
  if (!isRepositoryPermission(viewerPermission)) {
    throw new TypeError(
      "repository metadata readback viewerPermission is not recognized"
    );
  }
  return deepFreeze({
    repository: {
      fullName: contract.repository.fullName,
      nodeId: contract.repository.nodeId
    },
    description,
    homepage:
      homepageUrl === null || homepageUrl === "" ? null : homepageUrl,
    topics: parseTopics(value["repositoryTopics"]),
    viewerCanAdminister,
    viewerPermission
  });
}

export function planRepositoryMetadataReconciliation(
  contract: RepositoryMetadataContract,
  readback: RepositoryMetadataReadback
) {
  const desiredTopics = new Set<string>(contract.desired.topics);
  const observedTopics = new Set(readback.topics);
  const addTopics = contract.desired.topics.filter(
    (topic) => !observedTopics.has(topic)
  );
  const removeTopics = readback.topics.filter(
    (topic) => !desiredTopics.has(topic)
  );
  const descriptionAction =
    readback.description === contract.desired.description
      ? "none"
      : "replace";
  const homepageAction =
    readback.homepage === contract.desired.homepage ? "none" : "replace";
  const driftFound =
    descriptionAction !== "none" ||
    homepageAction !== "none" ||
    addTopics.length > 0 ||
    removeTopics.length > 0;
  const adminEligible =
    readback.viewerCanAdminister &&
    readback.viewerPermission ===
      contract.administration.requiredRepositoryRole;
  const status = !adminEligible
    ? "blocked-insufficient-admin"
    : driftFound
      ? "human-admin-apply-required"
      : "in-sync";

  return deepFreeze({
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "RepositoryMetadataReconciliationPlan",
    schemaVersion: "1.0.0",
    contractDigest: digest(contract),
    readbackDigest: digest(readback),
    repository: contract.repository,
    desired: contract.desired,
    observed: readback,
    drift: {
      found: driftFound,
      description: descriptionAction,
      homepage: homepageAction,
      topics: {
        add: addTopics,
        remove: removeTopics
      }
    },
    status,
    administration: {
      ...contract.administration,
      adminEligible,
      mutationPerformed: false
    },
    authorityBoundary: contract.authorityBoundary
  });
}

function main(): void {
  if (process.argv.length !== 2) {
    throw new TypeError("repository metadata planner is optionless");
  }
  const root = realpathSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  );
  const input = readFileSync(0, "utf8");
  if (input.trim() === "") {
    throw new TypeError(
      "repository metadata planner requires gh repo view JSON on stdin"
    );
  }
  const contract = loadRepositoryMetadataContract(root);
  const readback = parseRepositoryMetadataReadback(
    contract,
    parseStrictJson(input)
  );
  process.stdout.write(
    `${canonicalJson(
      planRepositoryMetadataReconciliation(contract, readback)
    )}\n`
  );
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  path.resolve(entryPoint) === fileURLToPath(import.meta.url)
) {
  main();
}
