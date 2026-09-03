import type { CompatibilityMatrix } from "./packaging-types.js";

export const PRODUCT_BOUNDARY = Object.freeze({
  decision: "repository-and-customer-starter-only",
  maintainerEntryPoint: "authoritative-repository-clone",
  localEvaluatorEntryPoint: "authoritative-repository-clone",
  customerStarterEntryPoint: "verified-profile-source-extraction",
  customerStarterScope: "profile-documented-scripts-only",
  customerSandboxEntryPoint: "reviewed-full-source-file-copy",
  repositoryScripts: "supported-in-repository-context",
  typescriptApi: "unsupported-internal-only",
  npmRegistryPackage: "unsupported-private-metadata-only",
  packagedCli: "unsupported-absent",
  hostedService: "unsupported-absent",
  deployableService: "unsupported-absent",
  liveAdministration: "external-human-prerequisite",
  liveEffects: "external-trust-service-prerequisite",
  futureDistribution: "separate-product-work-required"
}) satisfies CompatibilityMatrix["productBoundary"];

const UNSUPPORTED_ENTRY_FIELDS = [
  "bin",
  "main",
  "module",
  "types",
  "typings"
] as const;

const UNSUPPORTED_LIFECYCLE_SCRIPTS = [
  "deploy",
  "install",
  "postinstall",
  "postpack",
  "preinstall",
  "prepack",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "release",
  "serve",
  "start"
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertProductBoundary(
  value: unknown
): CompatibilityMatrix["productBoundary"] {
  if (!isRecord(value)) {
    throw new TypeError("product boundary must be an object");
  }
  const expected = Object.entries(PRODUCT_BOUNDARY);
  if (Object.keys(value).length !== expected.length) {
    throw new TypeError("product boundary has unknown or missing fields");
  }
  for (const [key, expectedValue] of expected) {
    if (value[key] !== expectedValue) {
      throw new TypeError(`product boundary ${key} must remain ${expectedValue}`);
    }
  }
  return PRODUCT_BOUNDARY;
}

export function assertRepositoryPackageBoundary(
  value: unknown,
  rootEntries: readonly string[]
): void {
  if (!isRecord(value)) {
    throw new TypeError("package metadata must be an object");
  }
  if (value["private"] !== true) {
    throw new TypeError("repository package must remain private");
  }
  const exportsValue = value["exports"];
  if (
    !isRecord(exportsValue) ||
    Object.keys(exportsValue).length !== 1 ||
    exportsValue["./package.json"] !== "./package.json"
  ) {
    throw new TypeError("repository package must export package.json metadata only");
  }
  for (const field of UNSUPPORTED_ENTRY_FIELDS) {
    if (Object.hasOwn(value, field)) {
      throw new TypeError(`repository package must not expose ${field}`);
    }
  }
  const directories = value["directories"];
  if (isRecord(directories) && Object.hasOwn(directories, "bin")) {
    throw new TypeError("repository package must not expose directories.bin");
  }
  const scripts = value["scripts"];
  if (scripts !== undefined && !isRecord(scripts)) {
    throw new TypeError("repository package scripts must be an object");
  }
  if (isRecord(scripts)) {
    for (const script of UNSUPPORTED_LIFECYCLE_SCRIPTS) {
      if (Object.hasOwn(scripts, script)) {
        throw new TypeError(
          `repository package must not advertise lifecycle script ${script}`
        );
      }
    }
  }
  if (rootEntries.includes("server.js")) {
    throw new TypeError(
      "repository package must not expose npm's implicit server.js start entry point"
    );
  }
}
