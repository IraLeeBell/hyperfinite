import { digest } from "./canonical.js";
import { parseStrictJson } from "./strict-json.js";

export const RETAINED_TECHNICAL_IDENTITY = Object.freeze({
  decision: "retain-compatibility-identity",
  productName: "Hyperfinite",
  identifierEpoch: "agentic-framework/v1alpha1",
  packageName: "agentic-framework",
  releaseArchiveName: "agentic-framework.tar",
  apiVersion: "agentic-framework.github.com/v1alpha1",
  schemaBaseUri: "https://agentic-framework.github.com/schemas/",
  projectSchemaName: "agentic-framework-control-plane",
  capabilityPublisher: "agentic-framework",
  domainStem: "agentic-framework",
  issueTaxonomyUserAgent: "agentic-framework-issue-taxonomy/1.0",
  syntheticCanarySeed:
    "agentic-framework credentialless synthetic sandbox canary v1",
  syntheticOidcAudiencePrefix: "synthetic://agentic-framework/"
} as const);

export const HYPERFINITE_PACKAGE_DESCRIPTION =
  "Hyperfinite deterministic control kernel and validation tooling; technical artifacts retain the agentic-framework compatibility identity.";

const IDENTIFIER_EPOCH_FIELD = "identifierEpoch";
const IDENTITY_EPOCH_ALIAS = "identityEpoch";
const TECHNICAL_IDENTITY_EPOCH_ALIAS = "technicalIdentityEpoch";
const EPOCH_FIELD_NAMES = [
  IDENTIFIER_EPOCH_FIELD,
  IDENTITY_EPOCH_ALIAS,
  TECHNICAL_IDENTITY_EPOCH_ALIAS
] as const;

export type TechnicalIdentity = typeof RETAINED_TECHNICAL_IDENTITY;

export type TechnicalIdentityOccurrenceCategory =
  | "product-facing-prose"
  | "package-release-identity"
  | "api-schema-identifier"
  | "capability-registry-publisher"
  | "cryptographic-domain-separation"
  | "fixture-generated-test-expectation";

export interface TechnicalIdentitySource {
  readonly path: string;
  readonly content: string;
}

export interface TechnicalIdentityInventory {
  readonly filesWithOccurrences: number;
  readonly matchingLines: number;
  readonly occurrences: number;
  readonly inventoryDigest: `sha256:${string}`;
  readonly categories: Readonly<
    Record<
      TechnicalIdentityOccurrenceCategory,
      {
        readonly matchingLines: number;
        readonly occurrences: number;
      }
    >
  >;
}

export interface ReviewedTechnicalIdentityInventory {
  readonly inventoryFiles: number;
  readonly inventoryMatchingLines: number;
  readonly inventoryOccurrences: number;
  readonly inventoryDigest: `sha256:${string}`;
}

export type TechnicalIdentityInventoryScope =
  | "authoritative-repository"
  | "control-plane-core"
  | "demo-portfolio";

export interface TechnicalIdentityInventoryEvidenceDocument {
  readonly kind: "TechnicalIdentityInventoryEvidence";
  readonly schemaVersion: "1.0.0";
  readonly scopes: Readonly<
    Record<TechnicalIdentityInventoryScope, ReviewedTechnicalIdentityInventory>
  >;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertRetainedTechnicalIdentity(
  value: unknown
): TechnicalIdentity {
  if (!isRecord(value)) {
    throw new TypeError("technical identity must be an object");
  }
  const expectedEntries = Object.entries(RETAINED_TECHNICAL_IDENTITY);
  if (Object.keys(value).length !== expectedEntries.length) {
    throw new TypeError("technical identity has unknown or missing fields");
  }
  for (const [key, expected] of expectedEntries) {
    if (value[key] !== expected) {
      throw new TypeError(`technical identity ${key} must remain ${expected}`);
    }
  }
  return RETAINED_TECHNICAL_IDENTITY;
}

export function assertTechnicalIdentityPackageMetadata(
  value: unknown,
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): void {
  if (!isRecord(value)) {
    throw new TypeError("package metadata must be an object");
  }
  if (
    value["name"] !== identity.packageName ||
    value["description"] !== HYPERFINITE_PACKAGE_DESCRIPTION
  ) {
    throw new TypeError(
      "package metadata must distinguish Hyperfinite from its retained technical package identity"
    );
  }
}

export function assertTechnicalIdentityPublishers(
  publishers: readonly string[],
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): void {
  if (
    publishers.length === 0 ||
    publishers.some((publisher) => publisher !== identity.capabilityPublisher)
  ) {
    throw new TypeError(
      "Capability Registry publisher identity drifted from the retained epoch"
    );
  }
}

export function technicalIdentityRegistryPublishers(
  value: unknown,
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): readonly string[] {
  if (!isRecord(value)) {
    throw new TypeError("Capability Registry document must be an object");
  }
  const kind = value["kind"];
  const body =
    kind === "CapabilityRegistry"
      ? value
      : kind === "DemoCapabilityRegistryShard" && isRecord(value["spec"])
        ? value["spec"]
        : null;
  if (body === null || !Array.isArray(body["capabilities"])) {
    throw new TypeError("Capability Registry document must declare capabilities");
  }
  const publishers = body["capabilities"].map((capability) => {
    if (!isRecord(capability) || typeof capability["publisher"] !== "string") {
      throw new TypeError("Capability Registry capability publisher is missing");
    }
    return capability["publisher"];
  });
  assertTechnicalIdentityPublishers(publishers, identity);
  return publishers;
}

export function assertTechnicalIdentityInventoryEvidence(
  actual: TechnicalIdentityInventory,
  expected: ReviewedTechnicalIdentityInventory
): void {
  if (!technicalIdentityInventoryMatches(actual, expected)) {
    throw new TypeError(
      `technical identity inventory drifted: ${JSON.stringify({
        inventoryFiles: actual.filesWithOccurrences,
        inventoryMatchingLines: actual.matchingLines,
        inventoryOccurrences: actual.occurrences,
        inventoryDigest: actual.inventoryDigest
      })}`
    );
  }
}

function technicalIdentityInventoryMatches(
  actual: TechnicalIdentityInventory,
  expected: ReviewedTechnicalIdentityInventory
): boolean {
  return (
    actual.filesWithOccurrences === expected.inventoryFiles &&
    actual.matchingLines === expected.inventoryMatchingLines &&
    actual.occurrences === expected.inventoryOccurrences &&
    actual.inventoryDigest === expected.inventoryDigest
  );
}

function reviewedInventoryEvidence(
  evidence: TechnicalIdentityInventoryEvidenceDocument,
  scope: TechnicalIdentityInventoryScope
): ReviewedTechnicalIdentityInventory {
  return evidence.scopes[scope];
}

type JsonPath = readonly string[];

function propertyPaths(
  value: unknown,
  propertyName: string,
  currentPath: readonly string[] = []
): readonly JsonPath[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      propertyPaths(entry, propertyName, [...currentPath, String(index)])
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const nextPath = [...currentPath, key];
    return [
      ...(key === propertyName ? [nextPath] : []),
      ...propertyPaths(entry, propertyName, nextPath)
    ];
  });
}

function sameJsonPath(left: JsonPath, right: JsonPath): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function jsonPathValue(value: unknown, path: JsonPath): unknown {
  let current = value;
  for (const segment of path) {
    current = Array.isArray(current)
      ? current[Number(segment)]
      : isRecord(current)
        ? current[segment]
        : undefined;
  }
  return current;
}

function displayJsonPath(path: JsonPath): string {
  return path
    .map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1"))
    .join("/");
}

function isRetainedSchemaUrl(
  value: string,
  schemaBaseUri: string
): boolean {
  try {
    const canonical = new URL(value).href;
    return canonical === value && canonical.startsWith(schemaBaseUri);
  } catch {
    return false;
  }
}

function normalizeAsciiUnicodeEscapes(value: string): string {
  return value
    .replace(
      /\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/gu,
      (sequence, braced: string | undefined, fixed: string | undefined) => {
        const codePoint = Number.parseInt(braced ?? fixed ?? "", 16);
        return Number.isFinite(codePoint) && codePoint <= 0x7f
          ? String.fromCodePoint(codePoint)
          : sequence;
      }
    )
    .replace(/\\x([0-9a-fA-F]{2})/gu, (sequence, encoded: string) => {
      const codePoint = Number.parseInt(encoded, 16);
      return codePoint <= 0x7f ? String.fromCodePoint(codePoint) : sequence;
    });
}

function normalizeStaticPropertySpellings(value: string): string {
  let normalized = normalizeAsciiUnicodeEscapes(
    value.replace(/\\\r?\n/gu, "")
  );
  let previous: string;
  do {
    previous = normalized;
    normalized = normalized
      .replace(
        /(["'])([A-Za-z]*)\1\s*\+\s*(["'])([A-Za-z]*)\3/gu,
        (_expression, _leftQuote, left: string, _rightQuote, right: string) =>
          `"${left}${right}"`
      )
      .replace(
        /`([A-Za-z]*)\$\{\s*["']([A-Za-z]+)["']\s*\}([A-Za-z]*)`/gu,
        (_expression, prefix: string, middle: string, suffix: string) =>
          `"${prefix}${middle}${suffix}"`
      )
      .replace(
        /\[\s*((?:["'][A-Za-z]+["']\s*,\s*)+["'][A-Za-z]+["'])\s*\]\.join\(\s*["']{2}\s*\)/gu,
        (_expression, literals: string) =>
          `"${[...literals.matchAll(/["']([A-Za-z]+)["']/gu)]
            .map((match) => match[1] ?? "")
            .join("")}"`
      );
  } while (normalized !== previous);
  return normalized;
}

function assertNoEpochPatternProperties(
  value: unknown,
  sourcePath: string,
  currentPath: readonly string[] = []
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoEpochPatternProperties(entry, sourcePath, [
        ...currentPath,
        String(index)
      ])
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...currentPath, key];
    if (key === "patternProperties") {
      if (!isRecord(entry)) {
        throw new TypeError(
          `${sourcePath} has malformed patternProperties at ${nextPath.join("/")}`
        );
      }
      for (const pattern of Object.keys(entry)) {
        let matcher: RegExp;
        try {
          matcher = new RegExp(pattern, "u");
        } catch {
          throw new TypeError(
            `${sourcePath} has an invalid patternProperties expression at ${nextPath.join("/")}`
          );
        }
        if (EPOCH_FIELD_NAMES.some((field) => matcher.test(field))) {
          throw new TypeError(
            `${sourcePath} patternProperties admits a technical identity epoch at ${nextPath.join("/")}`
          );
        }
      }
    }
    assertNoEpochPatternProperties(entry, sourcePath, nextPath);
  }
}

function braceDepth(value: string): number {
  let depth = 0;
  for (const character of value) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
  }
  return depth;
}

function assertCompatibilityTypeEpochLocation(
  source: string,
  identity: TechnicalIdentity
): void {
  const interfaceMarker = "export interface CompatibilityMatrix {";
  const technicalIdentityMarker = "readonly technicalIdentity: {";
  const epochMarker = `readonly ${IDENTIFIER_EPOCH_FIELD}: "${identity[IDENTIFIER_EPOCH_FIELD]}";`;
  const interfaceStart = source.indexOf(interfaceMarker);
  const interfaceBrace = source.indexOf("{", interfaceStart);
  const technicalIdentityStart = source.indexOf(
    technicalIdentityMarker,
    interfaceBrace + 1
  );
  const technicalIdentityBrace = source.indexOf(
    "{",
    technicalIdentityStart
  );
  const epochStart = source.indexOf(epochMarker, technicalIdentityBrace + 1);
  if (
    interfaceStart === -1 ||
    interfaceBrace === -1 ||
    technicalIdentityStart === -1 ||
    technicalIdentityBrace === -1 ||
    epochStart === -1 ||
    source.indexOf(epochMarker, epochStart + epochMarker.length) !== -1 ||
    braceDepth(source.slice(interfaceBrace, technicalIdentityStart)) !== 1 ||
    braceDepth(source.slice(technicalIdentityBrace, epochStart)) !== 1
  ) {
    throw new TypeError(
      "CompatibilityMatrix must own the exact technical identity epoch declaration"
    );
  }
}

export function assertIdentifierEpochBoundaries(
  sources: readonly TechnicalIdentitySource[],
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): void {
  assertRetainedTechnicalIdentity(identity);
  const technicalDeclaration = new RegExp(
    `^\\s*${IDENTIFIER_EPOCH_FIELD}:\\s*"agentic-framework/v1alpha1",\\s*$`,
    "u"
  );
  const compatibilityTypeDeclaration = new RegExp(
    `^\\s*readonly ${IDENTIFIER_EPOCH_FIELD}:\\s*"agentic-framework/v1alpha1";\\s*$`,
    "u"
  );
  const internalEpochDeclarationLines = new Set([
    `const IDENTIFIER_EPOCH_FIELD = "${IDENTIFIER_EPOCH_FIELD}";`,
    `const IDENTITY_EPOCH_ALIAS = "${IDENTITY_EPOCH_ALIAS}";`,
    `const TECHNICAL_IDENTITY_EPOCH_ALIAS = "${TECHNICAL_IDENTITY_EPOCH_ALIAS}";`
  ]);
  const allowedJsonPaths = new Map<string, JsonPath>([
    [
      "config/v1alpha1/compatibility.json",
      ["technicalIdentity", IDENTIFIER_EPOCH_FIELD]
    ],
    [
      "schemas/v1alpha1/packaging.schema.json",
      [
        "$defs",
        "compatibilityMatrix",
        "allOf",
        "1",
        "properties",
        "technicalIdentity",
        "properties",
        IDENTIFIER_EPOCH_FIELD
      ]
    ]
  ]);
  const requiredApiSchemas = new Set([
    "schemas/v1alpha1/copilot-runtime-authorization.schema.json",
    "schemas/v1alpha1/copilot-runtime-policy.schema.json",
    "schemas/v1alpha1/copilot-runtime-state.schema.json",
    "schemas/v1alpha1/packaging.schema.json"
  ]);

  for (const source of sources) {
    if (source.path.endsWith(".json")) {
      const document = parseStrictJson(source.content);
      assertNoEpochPatternProperties(document, source.path);
      const epochPaths = propertyPaths(document, IDENTIFIER_EPOCH_FIELD);
      const aliasPaths = [
        IDENTITY_EPOCH_ALIAS,
        TECHNICAL_IDENTITY_EPOCH_ALIAS
      ].flatMap((alias) =>
        propertyPaths(document, alias)
      );
      const allowedPath = allowedJsonPaths.get(source.path);
      if (
        aliasPaths.length !== 0 ||
        epochPaths.length !== (allowedPath === undefined ? 0 : 1) ||
        (allowedPath !== undefined &&
          (epochPaths[0] === undefined ||
            !sameJsonPath(epochPaths[0], allowedPath)))
      ) {
        throw new TypeError(
          `${source.path} exposes a technical identity epoch outside the exact compatibility declaration`
        );
      }
      if (allowedPath !== undefined) {
        const epochValue = jsonPathValue(document, allowedPath);
        const expectedEpoch = identity[IDENTIFIER_EPOCH_FIELD];
        const validEpochValue =
          source.path === "config/v1alpha1/compatibility.json"
            ? epochValue === expectedEpoch
            : isRecord(epochValue) && epochValue["const"] === expectedEpoch;
        if (!validEpochValue) {
          throw new TypeError(
            `${source.path} does not fix the exact retained technical identity epoch`
          );
        }
      }

      if (
        source.path.startsWith("schemas/") ||
        source.path === "docs/provenance/reference-inventory.schema.json"
      ) {
        const schemaIdPaths = propertyPaths(document, "$id");
        if (
          source.path.endsWith(".schema.json") &&
          schemaIdPaths.length === 0
        ) {
          throw new TypeError(`${source.path} must declare a retained schema ID`);
        }
        for (const schemaIdPath of schemaIdPaths) {
          const schemaId = jsonPathValue(document, schemaIdPath);
          if (
            typeof schemaId !== "string" ||
            !isRetainedSchemaUrl(schemaId, identity.schemaBaseUri)
          ) {
            throw new TypeError(
              `${source.path} declares a schema ID outside the retained origin at ${displayJsonPath(schemaIdPath)}`
            );
          }
        }
        for (const referenceKey of [
          "$ref",
          "$dynamicRef",
          "$recursiveRef"
        ]) {
          for (const referencePath of propertyPaths(document, referenceKey)) {
            const reference = jsonPathValue(document, referencePath);
            const absoluteReference =
              typeof reference === "string" &&
              (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) ||
                reference.startsWith("//"));
            const retainedReference =
              typeof reference === "string" &&
              (reference.startsWith("#") ||
                (absoluteReference &&
                  isRetainedSchemaUrl(reference, identity.schemaBaseUri)));
            if (
              typeof reference !== "string" ||
              !retainedReference
            ) {
              throw new TypeError(
                `${source.path} declares a schema reference outside the retained origin at ${displayJsonPath(referencePath)}`
              );
            }
          }
        }
        const apiVersionPaths = propertyPaths(document, "apiVersion");
        if (
          requiredApiSchemas.has(source.path) &&
          apiVersionPaths.length === 0
        ) {
          throw new TypeError(
            `${source.path} must close its API version to the retained identity epoch`
          );
        }
        for (const apiVersionPath of apiVersionPaths) {
          const current = jsonPathValue(document, apiVersionPath);
          if (
            !isRecord(current) ||
            current["const"] !== identity.apiVersion
          ) {
            throw new TypeError(
              `${source.path} has a selectable or drifted API version at ${displayJsonPath(apiVersionPath)}`
            );
          }
        }
        if (source.path === "schemas/v1alpha1/packaging.schema.json") {
          for (const packageNamePath of propertyPaths(
            document,
            "packageName"
          )) {
            const current = jsonPathValue(document, packageNamePath);
            if (
              !isRecord(current) ||
              current["const"] !== identity.packageName
            ) {
              throw new TypeError(
                `${source.path} has a selectable or drifted package identity at ${displayJsonPath(packageNamePath)}`
              );
            }
          }
        }
      }
      continue;
    }

    if (!/\.(?:cjs|js|mjs|ts)$/u.test(source.path)) continue;
    if (!/^(?:scripts|src)\//u.test(source.path)) continue;
    const normalized = normalizeStaticPropertySpellings(source.content);
    for (const [index, line] of normalized.split(/\r?\n/u).entries()) {
      const matchedEpochField = EPOCH_FIELD_NAMES.find(
        (candidate) => new RegExp(`\\b${candidate}\\b`, "u").test(line)
      );
      if (matchedEpochField === undefined) continue;
      const allowed =
        (source.path === "src/technical-identity.ts" &&
          internalEpochDeclarationLines.has(line.trim())) ||
        (matchedEpochField === IDENTIFIER_EPOCH_FIELD &&
          ((source.path === "src/technical-identity.ts" &&
            technicalDeclaration.test(line)) ||
            (source.path === "src/packaging-types.ts" &&
              compatibilityTypeDeclaration.test(line))));
      if (!allowed) {
        throw new TypeError(
          `${source.path}:${index + 1} exposes a technical identity epoch outside the exact compatibility type`
        );
      }
    }
    if (source.path === "src/packaging-types.ts") {
      assertCompatibilityTypeEpochLocation(source.content, identity);
    }
  }
}

function classifyOccurrence(
  path: string,
  line: string
): TechnicalIdentityOccurrenceCategory | null {
  if (/^(?:tests|examples)\//u.test(path)) {
    return "fixture-generated-test-expectation";
  }
  if (
    path.endsWith(".md") ||
    (path === "package.json" && /"description"\s*:/u.test(line)) ||
    /"title"\s*:/u.test(line)
  ) {
    return "product-facing-prose";
  }
  if (/(?:capabilityPublisher|["']publisher["']|publisher)\s*:/iu.test(line)) {
    return "capability-registry-publisher";
  }
  if (
    /apiVersion|schemaBaseUri|projectSchemaName|agentic-framework\.github\.com\/(?:schemas\/|v1alpha1)|agentic-framework\.github-project|agentic-framework-control-plane/iu.test(
      line
    )
  ) {
    return "api-schema-identifier";
  }
  if (
    /^(?:package(?:-lock)?\.json|src\/(?:release|release-support|packaging-types|customer-starter|customer-starter-catalog)\.ts|scripts\/(?:validate-packaging|validate-customer-starter-extraction)\.ts)/u.test(
      path
    ) ||
    /packageName|releaseArchiveName|issueTaxonomyUserAgent|\.tar|release-tool|customer-starter-tool|issue-taxonomy\/|github-adapter\/|spdx\/|attestations\/|require\(["']agentic-framework\//iu.test(
      line
    )
  ) {
    return "package-release-identity";
  }
  if (/^(?:config|schemas|scripts|src)\//u.test(path)) {
    return "cryptographic-domain-separation";
  }
  return null;
}

function newCategoryCounts(): Record<
  TechnicalIdentityOccurrenceCategory,
  { matchingLines: number; occurrences: number }
> {
  return {
    "product-facing-prose": { matchingLines: 0, occurrences: 0 },
    "package-release-identity": { matchingLines: 0, occurrences: 0 },
    "api-schema-identifier": { matchingLines: 0, occurrences: 0 },
    "capability-registry-publisher": { matchingLines: 0, occurrences: 0 },
    "cryptographic-domain-separation": { matchingLines: 0, occurrences: 0 },
    "fixture-generated-test-expectation": {
      matchingLines: 0,
      occurrences: 0
    }
  };
}

function identityBearingFileDigest(
  source: TechnicalIdentitySource
): `sha256:${string}` {
  if (
    source.path !== "config/v1alpha1/customer-starter-selection.json" &&
    source.path !==
      "config/v1alpha1/customer-starter-demo-portfolio-selection.json"
  ) {
    return digest(source.content);
  }
  const selection = parseStrictJson(source.content);
  if (
    !isRecord(selection) ||
    selection["kind"] !== "CustomerStarterSelection" ||
    typeof selection["sourceHeadSha"] !== "string" ||
    typeof selection["resolvedClosureDigest"] !== "string" ||
    (selection["baseSelectionDigest"] !== null &&
      typeof selection["baseSelectionDigest"] !== "string")
  ) {
    throw new TypeError(
      `${source.path} is not a valid customer-starter selection`
    );
  }
  const digestPlaceholder =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";
  return digest({
    ...selection,
    sourceHeadSha: "0000000000000000000000000000000000000000",
    baseSelectionDigest:
      selection["baseSelectionDigest"] === null ? null : digestPlaceholder,
    resolvedClosureDigest: digestPlaceholder
  });
}

export function inventoryTechnicalIdentity(
  sources: readonly TechnicalIdentitySource[],
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): TechnicalIdentityInventory {
  assertRetainedTechnicalIdentity(identity);
  const categories = newCategoryCounts();
  const matchedFiles = new Set<string>();
  let matchingLines = 0;
  let occurrences = 0;
  const productStem = identity.productName.toLowerCase();
  const forbiddenTechnicalPatterns = [
    new RegExp(`${productStem}\\.github\\.com`, "iu"),
    new RegExp(
      `(?:apiVersion|packageName|capabilityPublisher|publisher|${IDENTIFIER_EPOCH_FIELD})["']?\\s*:\\s*["']${productStem}(?:["'./-]|$)`,
      "iu"
    ),
    new RegExp(`${productStem}\\.(?:runtime|demo)`, "iu"),
    new RegExp(
      `${productStem}-(?:release-tool|customer-starter-tool|github-adapter)`,
      "iu"
    ),
    new RegExp(`synthetic://${productStem}/`, "iu"),
    new RegExp(`${productStem}-issue-taxonomy/`, "iu"),
    new RegExp(
      `${productStem}\\s+credentialless synthetic sandbox canary`,
      "iu"
    )
  ];
  const reviewedFiles: {
    readonly path: string;
    readonly contentDigest: `sha256:${string}`;
    readonly lines: readonly {
      readonly ordinal: number;
      readonly content: string;
      readonly category: TechnicalIdentityOccurrenceCategory;
      readonly occurrences: number;
    }[];
  }[] = [];

  const orderedSources = [...sources].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  for (const source of orderedSources) {
    for (const pattern of forbiddenTechnicalPatterns) {
      if (pattern.test(source.content)) {
        throw new TypeError(
          `${source.path} introduces an unsupported Hyperfinite technical identifier`
        );
      }
    }

    const lines = source.content.split(/\r?\n/u);
    const reviewedLines: {
      readonly ordinal: number;
      readonly content: string;
      readonly category: TechnicalIdentityOccurrenceCategory;
      readonly occurrences: number;
    }[] = [];
    let identityLineOrdinal = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const matches = [
        ...line.matchAll(new RegExp("agentic[- ]framework", "giu"))
      ];
      if (matches.length === 0) continue;
      if (
        matches.some((match) => match[0] !== identity.domainStem)
      ) {
        throw new TypeError(
          `${source.path}:${index + 1} uses stale product spelling for the retained technical identity`
        );
      }
      const category = classifyOccurrence(source.path, line);
      if (category === null) {
        throw new TypeError(
          `${source.path}:${index + 1} has an unclassified technical identity occurrence`
        );
      }
      matchedFiles.add(source.path);
      matchingLines += 1;
      occurrences += matches.length;
      categories[category].matchingLines += 1;
      categories[category].occurrences += matches.length;
      identityLineOrdinal += 1;
      reviewedLines.push({
        ordinal: identityLineOrdinal,
        content: line,
        category,
        occurrences: matches.length
      });
    }
    if (reviewedLines.length > 0) {
      reviewedFiles.push({
        path: source.path,
        contentDigest: identityBearingFileDigest(source),
        lines: reviewedLines
      });
    }
  }

  return {
    filesWithOccurrences: matchedFiles.size,
    matchingLines,
    occurrences,
    inventoryDigest: digest(reviewedFiles),
    categories
  };
}

export function assertReviewedTechnicalIdentityInventory(
  sources: readonly TechnicalIdentitySource[],
  evidence: TechnicalIdentityInventoryEvidenceDocument,
  expectedScope: TechnicalIdentityInventoryScope,
  identity: TechnicalIdentity = RETAINED_TECHNICAL_IDENTITY
): {
  readonly scope: TechnicalIdentityInventoryScope;
  readonly inventory: TechnicalIdentityInventory;
} {
  assertIdentifierEpochBoundaries(sources, identity);
  const inventory = inventoryTechnicalIdentity(sources, identity);
  assertTechnicalIdentityInventoryEvidence(
    inventory,
    reviewedInventoryEvidence(evidence, expectedScope)
  );
  return { scope: expectedScope, inventory };
}
