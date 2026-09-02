import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";

import type {
  ActivePhaseOwner,
  Capability,
  CapabilityRegistry,
  RefusalCode
} from "./types.js";
import { isActivePhaseOwner } from "./lifecycle.js";

const ALLOWED_OUTPUT_PROPERTIES = new Set([
  "acceptanceCriterionIds",
  "artifactDigest",
  "changes",
  "content",
  "deliveryEvidenceDigest",
  "findings",
  "headSha",
  "lockStatus",
  "mergedSha",
  "openQuestions",
  "operationsReceiptDigest",
  "reasonCode",
  "regressionStatus",
  "result",
  "reviewEvent",
  "scannerStatus",
  "slot",
  "steps",
  "summary",
  "targetSlots",
  "threatStatus",
  "dlpStatus",
  "verificationReportDigest",
  "verificationIds"
]);

const PROHIBITED_EFFECT_WORDS = [
  "approve",
  "merge",
  "deploy",
  "publish",
  "production",
  "crm",
  "erp",
  "payment",
  "license",
  "visibility"
];

export interface RegistryError {
  readonly code: RefusalCode;
  readonly path: string;
  readonly message: string;
}

export interface CapabilityResolution {
  readonly ok: true;
  readonly capability: Capability;
}

export interface CapabilityResolutionFailure {
  readonly ok: false;
  readonly errors: readonly RegistryError[];
}

const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "additionalProperties",
  "required",
  "properties",
  "items",
  "enum",
  "const",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "anyOf",
  "oneOf"
]);

const embeddedSchemaValidator = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: false
});

export function validateClosedSchemaDialect(input: {
  readonly schema: unknown;
  readonly path: string;
  readonly targetFreeOutput: boolean;
}): readonly RegistryError[] {
  const errors: RegistryError[] = [];
  if (typeof input.schema !== "object" || input.schema === null) {
    return [
      {
        code: "REGISTRY_INVALID",
        path: input.path,
        message: "capability schema root must be an object"
      }
    ];
  }
  const schema = input.schema as AnySchema;
  if (!embeddedSchemaValidator.validateSchema(schema)) {
    errors.push({
      code: "REGISTRY_INVALID",
      path: input.path,
      message: `schema is invalid: ${embeddedSchemaValidator.errorsText(
        embeddedSchemaValidator.errors,
        { separator: "; " }
      )}`
    });
    return errors;
  }
  try {
    embeddedSchemaValidator.compile(schema);
  } catch (error) {
    errors.push({
      code: "REGISTRY_INVALID",
      path: input.path,
      message: `schema cannot be compiled: ${
        error instanceof Error ? error.message : "unknown compilation error"
      }`
    });
    return errors;
  }
  inspectSchemaNode(
    input.schema,
    input.path,
    errors,
    input.targetFreeOutput,
    true
  );
  return errors;
}

function inspectSchemaNode(
  value: unknown,
  path: string,
  errors: RegistryError[],
  forbidTargets: boolean,
  root: boolean
): void {
  if (typeof value !== "object" || value === null) {
    errors.push({
      code: "REGISTRY_INVALID",
      path,
      message: "capability schema nodes must be objects"
    });
    return;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const type = record["type"];
  const supportedTypes = new Set([
    "object",
    "array",
    "string",
    "integer",
    "number",
    "boolean",
    "null"
  ]);
  if (root && record["type"] !== "object") {
    errors.push({
      code: "REGISTRY_INVALID",
      path,
      message: "capability schema root must be an object"
    });
  }
  if (type !== undefined && (typeof type !== "string" || !supportedTypes.has(type))) {
    errors.push({
      code: "REGISTRY_INVALID",
      path: `${path}/type`,
      message: "capability schema type must be one supported scalar type"
    });
  }
  for (const literalKey of ["enum", "const"] as const) {
    const literal = record[literalKey];
    const values = literalKey === "enum" && Array.isArray(literal) ? literal : [literal];
    if (
      literal !== undefined &&
      values.some((candidate) => typeof candidate === "object" && candidate !== null)
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/${literalKey}`,
        message: "object and array literals are not supported in capability schemas"
      });
    }
  }
  for (const key of Object.keys(record)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/${key}`,
        message: "unsupported or ambiguous capability schema keyword"
      });
    }
  }
  const typeSpecificKeywords: readonly {
    readonly label: string;
    readonly types: ReadonlySet<unknown>;
    readonly keywords: ReadonlySet<string>;
  }[] = [
    {
      label: "object",
      types: new Set(["object"]),
      keywords: new Set(["additionalProperties", "required", "properties"])
    },
    {
      label: "array",
      types: new Set(["array"]),
      keywords: new Set(["items", "minItems", "maxItems", "uniqueItems"])
    },
    {
      label: "string",
      types: new Set(["string"]),
      keywords: new Set(["minLength", "maxLength", "pattern"])
    },
    {
      label: "numeric",
      types: new Set(["integer", "number"]),
      keywords: new Set(["minimum", "maximum"])
    }
  ];
  for (const { label, types, keywords } of typeSpecificKeywords) {
    if (
      !types.has(type) &&
      [...keywords].some((keyword) => record[keyword] !== undefined)
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path,
        message: `${label}-specific schema keywords require a compatible type`
      });
    }
  }
  if (
    record["type"] === "object" &&
    record["additionalProperties"] !== false &&
    record["oneOf"] === undefined &&
    record["anyOf"] === undefined
  ) {
    errors.push({
      code: "REGISTRY_INVALID",
      path,
      message: "every capability object schema must set additionalProperties to false"
    });
  }
  if (
    record["type"] === undefined &&
    record["enum"] === undefined &&
    record["const"] === undefined &&
    record["oneOf"] === undefined &&
    record["anyOf"] === undefined
  ) {
    errors.push({
      code: "REGISTRY_INVALID",
      path,
      message: "capability schema node has an ambiguous open type"
    });
  }
  if (record["type"] === "array" && record["items"] === undefined) {
    errors.push({
      code: "REGISTRY_INVALID",
      path,
      message: "capability array schemas must declare items"
    });
  }
  const properties = record["properties"];
  if (properties !== undefined) {
    if (
      typeof properties !== "object" ||
      properties === null ||
      Array.isArray(properties)
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/properties`,
        message: "capability schema properties must be an object"
      });
    } else {
      for (const [key, child] of Object.entries(properties)) {
        if (forbidTargets && !ALLOWED_OUTPUT_PROPERTIES.has(key)) {
          errors.push({
            code: "REGISTRY_INVALID",
            path: `${path}/properties/${key}`,
            message:
              "model-facing output property is outside the approved target-free vocabulary"
          });
        }
        inspectSchemaNode(
          child,
          `${path}/properties/${key}`,
          errors,
          forbidTargets,
          false
        );
      }
    }
  }
  if (record["items"] !== undefined) {
    inspectSchemaNode(
      record["items"],
      `${path}/items`,
      errors,
      forbidTargets,
      false
    );
  }
  const oneOf = record["oneOf"];
  if (oneOf !== undefined) {
    if (!Array.isArray(oneOf) || oneOf.length < 2) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/oneOf`,
        message: "oneOf must contain at least two closed schema branches"
      });
    } else {
      oneOf.forEach((child, index) =>
        inspectSchemaNode(
          child,
          `${path}/oneOf/${index}`,
          errors,
          forbidTargets,
          false
        )
      );
    }
  }
  const anyOf = record["anyOf"];
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf) || anyOf.length < 2) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/anyOf`,
        message: "anyOf must contain at least two closed schema branches"
      });
    } else {
      anyOf.forEach((child, index) =>
        inspectSchemaNode(
          child,
          `${path}/anyOf/${index}`,
          errors,
          forbidTargets,
          false
        )
      );
    }
  }
}

function hasWildcard(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

export function validateRegistrySemantics(
  registry: CapabilityRegistry
): readonly RegistryError[] {
  const errors: RegistryError[] = [];
  const identities = new Set<string>();

  if (
    registry.defaults.tools !== "deny" ||
    registry.defaults.network !== "deny" ||
    registry.defaults.writes !== "deny" ||
    registry.defaults.secrets !== "deny"
  ) {
    errors.push({
      code: "REGISTRY_INVALID",
      path: "/defaults",
      message: "all registry defaults must deny access"
    });
  }

  registry.capabilities.forEach((capability, index) => {
    const path = `/capabilities/${index}`;
    const identity = `${capability.id}@${capability.version}`;
    if (identities.has(identity)) {
      errors.push({
        code: "REGISTRY_INVALID",
        path,
        message: `duplicate capability ${identity}`
      });
    }
    identities.add(identity);

    if (
      !Array.isArray(capability.allowedPhases) ||
      capability.allowedPhases.length === 0 ||
      capability.allowedPhases.some((phase) => !isActivePhaseOwner(phase))
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/allowedPhases`,
        message: "capabilities must be limited to approved active phases"
      });
    }
    if (capability.access.write.allowed || capability.access.write.scopes.length > 0) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/access/write`,
        message: "read-only capabilities cannot perform writes"
      });
    }
    for (const [field, values] of Object.entries({
      tools: capability.access.tools,
      shellCommands: capability.access.shellCommands,
      networkDestinations: capability.access.networkDestinations,
      mcpTools: capability.access.mcpTools,
      mcpReadTools: capability.access.mcpReadTools,
      mcpMutationTools: capability.access.mcpMutationTools
    })) {
      if (Array.isArray(values) && values.some(hasWildcard)) {
        errors.push({
          code: "REGISTRY_INVALID",
          path: `${path}/access/${field}`,
          message: "wildcards are forbidden in capability access declarations"
        });
      }
    }
    const mcpTools = capability.access.mcpTools;
    const mcpReadTools = capability.access.mcpReadTools;
    const mcpMutationTools = capability.access.mcpMutationTools;
    if (
      !Array.isArray(mcpTools) ||
      !Array.isArray(mcpReadTools) ||
      !Array.isArray(mcpMutationTools)
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/access/mcpTools`,
        message: "every MCP tool must be classified exactly once as read-only or mutating"
      });
    } else {
      const classifiedMcpTools = [...mcpReadTools, ...mcpMutationTools];
      if (
        new Set(classifiedMcpTools).size !== classifiedMcpTools.length ||
        classifiedMcpTools.length !== mcpTools.length ||
        !classifiedMcpTools.every((tool) => mcpTools.includes(tool))
      ) {
        errors.push({
          code: "REGISTRY_INVALID",
          path: `${path}/access/mcpTools`,
          message: "every MCP tool must be classified exactly once as read-only or mutating"
        });
      }
    }
    for (const destination of capability.access.networkDestinations) {
      try {
        const url = new URL(destination);
        if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
          throw new TypeError("non-canonical destination");
        }
      } catch {
        errors.push({
          code: "REGISTRY_INVALID",
          path: `${path}/access/networkDestinations`,
          message: `network destination must be an explicit credential-free HTTPS URL: ${destination}`
        });
      }
    }
    if (
      PROHIBITED_EFFECT_WORDS.some((word) =>
        capability.effectClass.toLowerCase().includes(word)
      )
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/effectClass`,
        message: "prohibited effect class"
      });
    }
    if (
      (capability.provenance.classification === "adapted" ||
        capability.provenance.classification === "verbatim") &&
      (capability.provenance.legalReview !== "approved" ||
        capability.provenance.securityReview !== "approved")
    ) {
      errors.push({
        code: "REGISTRY_INVALID",
        path: `${path}/provenance`,
        message: "adapted or verbatim capabilities require legal and security approval"
      });
    }
    errors.push(
      ...validateClosedSchemaDialect({
        schema: capability.inputSchema,
        path: `${path}/inputSchema`,
        targetFreeOutput: false
      }),
      ...validateClosedSchemaDialect({
        schema: capability.outputSchema,
        path: `${path}/outputSchema`,
        targetFreeOutput: true
      })
    );
  });

  return errors;
}

export function resolveCapability(
  registry: CapabilityRegistry,
  reference: string,
  phase: ActivePhaseOwner
): CapabilityResolution | CapabilityResolutionFailure {
  const capability = registry.capabilities.find(
    (candidate) => `${candidate.id}@${candidate.version}` === reference
  );
  if (capability === undefined) {
    return {
      ok: false,
      errors: [
        {
          code: "REGISTRY_INVALID",
          path: "/capabilities",
          message: `unknown capability ${reference}`
        }
      ]
    };
  }
  if (capability.status !== "active") {
    return {
      ok: false,
      errors: [
        {
          code: "REGISTRY_INVALID",
          path: `/capabilities/${capability.id}`,
          message: `capability ${reference} is ${capability.status}`
        }
      ]
    };
  }
  if (
    !Array.isArray(capability.allowedPhases) ||
    !capability.allowedPhases.every(isActivePhaseOwner) ||
    !capability.allowedPhases.includes(phase)
  ) {
    return {
      ok: false,
      errors: [
        {
          code: "REGISTRY_INVALID",
          path: `/capabilities/${capability.id}/allowedPhases`,
          message: `capability ${reference} is not allowed in ${phase}`
        }
      ]
    };
  }
  return { ok: true, capability };
}
