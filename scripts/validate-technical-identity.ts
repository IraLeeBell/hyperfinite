#!/usr/bin/env node

import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { canonicalJson } from "../src/canonical.js";
import type { CompatibilityMatrix } from "../src/packaging-types.js";
import { parseStrictJson } from "../src/strict-json.js";
import {
  assertRetainedTechnicalIdentity,
  assertReviewedTechnicalIdentityInventory,
  assertTechnicalIdentityPackageMetadata,
  assertTechnicalIdentityPublishers,
  technicalIdentityRegistryPublishers,
  type TechnicalIdentitySource
} from "../src/technical-identity.js";
import { assertDocument } from "../src/validation.js";

const MAX_FILES = 4_096;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  "coverage",
  "dist",
  "node_modules"
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectSources(
  root: string,
  relativeDirectory = ""
): TechnicalIdentitySource[] {
  const directory = path.join(root, relativeDirectory);
  const sources: TechnicalIdentitySource[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (relativeDirectory === "" && IGNORED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      sources.push(...collectSources(root, relativePath));
      continue;
    }
    const absolutePath = path.join(root, relativePath);
    const status = lstatSync(absolutePath);
    if (status.isSymbolicLink()) {
      throw new TypeError(
        `technical identity inventory refuses symbolic link ${relativePath}`
      );
    }
    if (
      !status.isFile()
    ) {
      continue;
    }
    if (status.size > MAX_FILE_BYTES) {
      throw new TypeError(
        `technical identity inventory file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`
      );
    }
    sources.push({
      path: relativePath,
      content: readFileSync(absolutePath, "utf8")
    });
  }
  return sources;
}

function readListedSources(
  root: string,
  relativePaths: readonly string[]
): TechnicalIdentitySource[] {
  if (relativePaths.length > MAX_FILES) {
    throw new TypeError(`technical identity inventory exceeds ${MAX_FILES} files`);
  }
  return [...relativePaths]
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((relativePath) => {
      const absolutePath = path.join(root, relativePath);
      const status = lstatSync(absolutePath);
      if (status.isSymbolicLink()) {
        throw new TypeError(
          `technical identity inventory refuses symbolic link ${relativePath}`
        );
      }
      if (!status.isFile()) {
        throw new TypeError(
          `technical identity inventory expected regular file ${relativePath}`
        );
      }
      if (status.size > MAX_FILE_BYTES) {
        throw new TypeError(
          `technical identity inventory file exceeds ${MAX_FILE_BYTES} bytes: ${relativePath}`
        );
      }
      return {
        path: relativePath,
        content: readFileSync(absolutePath, "utf8")
      };
    });
}

function gitInventoryPaths(root: string): readonly string[] | null {
  if (!existsSync(path.join(root, ".git"))) return null;
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "" },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000
    }
  );
  const paths = output.split("\0").filter((candidate) => candidate !== "");
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("technical identity inventory received duplicate Git paths");
  }
  return paths;
}

function requiredSource(
  sources: readonly TechnicalIdentitySource[],
  relativePath: string
): string {
  const source = sources.find((candidate) => candidate.path === relativePath);
  if (source === undefined) {
    throw new TypeError(`technical identity source is missing: ${relativePath}`);
  }
  return source.content;
}

function compatibilityMatrix(value: unknown): CompatibilityMatrix {
  const document = assertDocument("PackagingDocument", value);
  if (document.kind !== "CompatibilityMatrix") {
    throw new TypeError("expected CompatibilityMatrix");
  }
  return document;
}

function stringProperty(
  value: Readonly<Record<string, unknown>>,
  key: string,
  subject: string
): string {
  const property = value[key];
  if (typeof property !== "string") {
    throw new TypeError(`${subject}.${key} must be a string`);
  }
  return property;
}

const root = realpathSync(process.cwd());
const gitPaths = gitInventoryPaths(root);
const sources =
  gitPaths === null ? collectSources(root) : readListedSources(root, gitPaths);
if (sources.length > MAX_FILES) {
  throw new TypeError(`technical identity inventory exceeds ${MAX_FILES} files`);
}
const compatibility = compatibilityMatrix(
  parseStrictJson(
    requiredSource(sources, "config/v1alpha1/compatibility.json")
  )
);
const identity = assertRetainedTechnicalIdentity(
  compatibility.technicalIdentity
);

const packageDocument = parseStrictJson(requiredSource(sources, "package.json"));
assertTechnicalIdentityPackageMetadata(packageDocument, identity);
const packageRecord = isRecord(packageDocument)
  ? packageDocument
  : (() => {
      throw new TypeError("package.json must be an object");
    })();
const lockDocument = parseStrictJson(
  requiredSource(sources, "package-lock.json")
);
if (!isRecord(lockDocument)) {
  throw new TypeError("package-lock.json must be an object");
}
const lockPackages = lockDocument["packages"];
if (!isRecord(lockPackages) || !isRecord(lockPackages[""])) {
  throw new TypeError("package-lock.json root package metadata is missing");
}
if (
  stringProperty(lockDocument, "name", "package-lock.json") !==
    identity.packageName ||
  stringProperty(lockPackages[""], "name", "package-lock.json packages root") !==
    identity.packageName ||
  stringProperty(packageRecord, "name", "package.json") !== identity.packageName
) {
  throw new TypeError("package and lockfile technical identities drifted");
}
for (const relativePath of [
  "src/release.ts",
  "docs/release/local-release-evidence.md"
]) {
  const releaseSource = requiredSource(sources, relativePath);
  if (!releaseSource.includes(identity.releaseArchiveName)) {
    throw new TypeError(
      `${relativePath} drifted from the retained release archive identity`
    );
  }
}

const projectSchema = parseStrictJson(
  requiredSource(sources, "config/v1alpha1/github-project.json")
);
if (!isRecord(projectSchema)) {
  throw new TypeError("GitHub Project schema must be an object");
}
const projectMetadata = projectSchema["metadata"];
const projectDisplay = projectSchema["project"];
if (!isRecord(projectMetadata) || !isRecord(projectDisplay)) {
  throw new TypeError("GitHub Project schema identity metadata is missing");
}
if (
  stringProperty(projectMetadata, "name", "GitHub Project metadata") !==
    identity.projectSchemaName ||
  stringProperty(projectDisplay, "title", "GitHub Project display") !==
    `${identity.productName} Control Plane`
) {
  throw new TypeError(
    "GitHub Project schema must retain its technical name and use the Hyperfinite display name"
  );
}

const canarySource = sources.find(
  (source) => source.path === "scripts/run-synthetic-sandbox-canary.ts"
);
if (
  canarySource !== undefined &&
  canarySource.content.split(identity.syntheticCanarySeed).length !== 2
) {
  throw new TypeError(
    "synthetic canary seed drifted from the retained cryptographic domain"
  );
}
const taxonomySource = sources.find(
  (source) => source.path === "scripts/reconcile-issue-taxonomy.ts"
);
if (
  taxonomySource !== undefined &&
  taxonomySource.content.split(identity.issueTaxonomyUserAgent).length !== 2
) {
  throw new TypeError(
    "issue taxonomy User-Agent drifted from the retained tool identity"
  );
}
const deploymentTopology = parseStrictJson(
  requiredSource(sources, "examples/pre-app/deployment-topology.json")
);
if (
  !isRecord(deploymentTopology) ||
  !Array.isArray(deploymentTopology["services"]) ||
  deploymentTopology["services"].length !== 8
) {
  throw new TypeError("deployment topology must declare eight trust services");
}
for (const service of deploymentTopology["services"]) {
  if (!isRecord(service) || !isRecord(service["identity"])) {
    throw new TypeError("deployment topology service identity is malformed");
  }
  const serviceId = stringProperty(service, "serviceId", "deployment service");
  if (
    stringProperty(
      service["identity"],
      "oidcAudience",
      `deployment service ${serviceId} identity`
    ) !== `${identity.syntheticOidcAudiencePrefix}${serviceId}`
  ) {
    throw new TypeError(
      "synthetic OIDC audience drifted from the retained protocol identity"
    );
  }
}

const publishers: string[] = [];
for (const source of sources) {
  const baseRegistry =
    source.path === "config/v1alpha1/capability-registry.json";
  const demoRegistry =
    /^config\/v1alpha1\/demo-projects\/[^/]+\/capabilities\.json$/u.test(
      source.path
    );
  if (!baseRegistry && !demoRegistry) {
    continue;
  }
  const registry = parseStrictJson(source.content);
  publishers.push(...technicalIdentityRegistryPublishers(registry, identity));
}
const generatorSource = sources.find(
  (source) => source.path === "scripts/generate-hybrid-demo-contracts.mjs"
);
if (generatorSource !== undefined) {
  const generatorPublishers = [
    ...generatorSource.content.matchAll(
      /publisher\s*:\s*["']([^"']+)["']/gu
    )
  ];
  if (
    generatorPublishers.length !== 1 ||
    generatorPublishers[0]?.[1] !== identity.capabilityPublisher
  ) {
    throw new TypeError(
      "hybrid demo generator publisher drifted from the retained identity"
    );
  }
  publishers.push(identity.capabilityPublisher);
}
assertTechnicalIdentityPublishers(publishers, identity);

for (const source of sources) {
  if (
    !/^(?:config|examples|schemas)\//u.test(source.path) ||
    !source.path.endsWith(".json")
  ) {
    continue;
  }
  for (const match of source.content.matchAll(
    /"apiVersion"\s*:\s*(?:\{\s*"const"\s*:\s*)?"([^"]+)"/gu
  )) {
    if (match[1] !== identity.apiVersion) {
      throw new TypeError(
        `${source.path} declares an API version outside the retained identity epoch`
      );
    }
  }
}

const reviewedInventory = assertReviewedTechnicalIdentityInventory(
  sources,
  identity
);
process.stdout.write(
  `${canonicalJson({
    decision: identity.decision,
    inventoryScope: reviewedInventory.scope,
    scannedFiles: sources.length,
    ...reviewedInventory.inventory
  })}\n`
);
