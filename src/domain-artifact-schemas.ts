import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

import businessControls from "../schemas/v1alpha1/domain-packs/business-operations/controls-approvals.schema.json" with { type: "json" };
import businessDecision from "../schemas/v1alpha1/domain-packs/business-operations/decision-memo.schema.json" with { type: "json" };
import businessImplementation from "../schemas/v1alpha1/domain-packs/business-operations/implementation-plan.schema.json" with { type: "json" };
import businessMeasurement from "../schemas/v1alpha1/domain-packs/business-operations/outcome-measurement.schema.json" with { type: "json" };
import businessPolicy from "../schemas/v1alpha1/domain-packs/business-operations/policy-process-design.schema.json" with { type: "json" };
import businessProblem from "../schemas/v1alpha1/domain-packs/business-operations/problem-framing.schema.json" with { type: "json" };
import businessProcess from "../schemas/v1alpha1/domain-packs/business-operations/process-map.schema.json" with { type: "json" };
import businessRunbook from "../schemas/v1alpha1/domain-packs/business-operations/runbook.schema.json" with { type: "json" };
import businessStakeholders from "../schemas/v1alpha1/domain-packs/business-operations/stakeholder-analysis.schema.json" with { type: "json" };
import marketingAudience from "../schemas/v1alpha1/domain-packs/marketing/audience-evidence.schema.json" with { type: "json" };
import marketingBrandLegal from "../schemas/v1alpha1/domain-packs/marketing/brand-legal-assessment.schema.json" with { type: "json" };
import marketingContentDrafts from "../schemas/v1alpha1/domain-packs/marketing/content-drafts.schema.json" with { type: "json" };
import marketingContentPlan from "../schemas/v1alpha1/domain-packs/marketing/content-plan.schema.json" with { type: "json" };
import marketingIntake from "../schemas/v1alpha1/domain-packs/marketing/initiative-intake.schema.json" with { type: "json" };
import marketingLaunch from "../schemas/v1alpha1/domain-packs/marketing/launch-readiness-assessment.schema.json" with { type: "json" };
import marketingMeasurement from "../schemas/v1alpha1/domain-packs/marketing/measurement-plan.schema.json" with { type: "json" };
import marketingPositioning from "../schemas/v1alpha1/domain-packs/marketing/positioning-messaging.schema.json" with { type: "json" };
import businessControlsTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/controls-approvals.json" with { type: "json" };
import businessDecisionTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/decision-memo.json" with { type: "json" };
import businessImplementationTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/implementation-plan.json" with { type: "json" };
import businessMeasurementTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/outcome-measurement.json" with { type: "json" };
import businessPolicyTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/policy-process-design.json" with { type: "json" };
import businessProblemTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/problem-framing.json" with { type: "json" };
import businessProcessTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/process-map.json" with { type: "json" };
import businessRunbookTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/runbook.json" with { type: "json" };
import businessStakeholdersTemplate from "../config/v1alpha1/domain-packs/business-operations/templates/stakeholder-analysis.json" with { type: "json" };
import marketingAudienceTemplate from "../config/v1alpha1/domain-packs/marketing/templates/audience-evidence.json" with { type: "json" };
import marketingBrandLegalTemplate from "../config/v1alpha1/domain-packs/marketing/templates/brand-legal-assessment.json" with { type: "json" };
import marketingContentDraftsTemplate from "../config/v1alpha1/domain-packs/marketing/templates/content-drafts.json" with { type: "json" };
import marketingContentPlanTemplate from "../config/v1alpha1/domain-packs/marketing/templates/content-plan.json" with { type: "json" };
import marketingIntakeTemplate from "../config/v1alpha1/domain-packs/marketing/templates/initiative-intake.json" with { type: "json" };
import marketingLaunchTemplate from "../config/v1alpha1/domain-packs/marketing/templates/launch-readiness-assessment.json" with { type: "json" };
import marketingMeasurementTemplate from "../config/v1alpha1/domain-packs/marketing/templates/measurement-plan.json" with { type: "json" };
import marketingPositioningTemplate from "../config/v1alpha1/domain-packs/marketing/templates/positioning-messaging.json" with { type: "json" };
import { digest } from "./canonical.js";
import type { Digest } from "./types.js";

type DomainSchemaKey =
  | `marketing/${string}`
  | `business-operations/${string}`;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

const schemas: Readonly<Record<DomainSchemaKey, AnySchema>> = {
  "marketing/initiative-intake": immutableSnapshot(marketingIntake),
  "marketing/audience-evidence": immutableSnapshot(marketingAudience),
  "marketing/positioning-messaging": immutableSnapshot(marketingPositioning),
  "marketing/content-plan": immutableSnapshot(marketingContentPlan),
  "marketing/content-drafts": immutableSnapshot(marketingContentDrafts),
  "marketing/measurement-plan": immutableSnapshot(marketingMeasurement),
  "marketing/brand-legal-assessment": immutableSnapshot(marketingBrandLegal),
  "marketing/launch-readiness-assessment": immutableSnapshot(marketingLaunch),
  "business-operations/problem-framing": immutableSnapshot(businessProblem),
  "business-operations/stakeholder-analysis": immutableSnapshot(businessStakeholders),
  "business-operations/process-map": immutableSnapshot(businessProcess),
  "business-operations/decision-memo": immutableSnapshot(businessDecision),
  "business-operations/policy-process-design": immutableSnapshot(businessPolicy),
  "business-operations/implementation-plan": immutableSnapshot(businessImplementation),
  "business-operations/runbook": immutableSnapshot(businessRunbook),
  "business-operations/controls-approvals": immutableSnapshot(businessControls),
  "business-operations/outcome-measurement": immutableSnapshot(businessMeasurement)
};

const templates: Readonly<Record<DomainSchemaKey, unknown>> = {
  "marketing/initiative-intake": immutableSnapshot(marketingIntakeTemplate),
  "marketing/audience-evidence": immutableSnapshot(marketingAudienceTemplate),
  "marketing/positioning-messaging": immutableSnapshot(marketingPositioningTemplate),
  "marketing/content-plan": immutableSnapshot(marketingContentPlanTemplate),
  "marketing/content-drafts": immutableSnapshot(marketingContentDraftsTemplate),
  "marketing/measurement-plan": immutableSnapshot(marketingMeasurementTemplate),
  "marketing/brand-legal-assessment": immutableSnapshot(marketingBrandLegalTemplate),
  "marketing/launch-readiness-assessment": immutableSnapshot(marketingLaunchTemplate),
  "business-operations/problem-framing": immutableSnapshot(businessProblemTemplate),
  "business-operations/stakeholder-analysis": immutableSnapshot(
    businessStakeholdersTemplate
  ),
  "business-operations/process-map": immutableSnapshot(businessProcessTemplate),
  "business-operations/decision-memo": immutableSnapshot(businessDecisionTemplate),
  "business-operations/policy-process-design": immutableSnapshot(businessPolicyTemplate),
  "business-operations/implementation-plan": immutableSnapshot(
    businessImplementationTemplate
  ),
  "business-operations/runbook": immutableSnapshot(businessRunbookTemplate),
  "business-operations/controls-approvals": immutableSnapshot(businessControlsTemplate),
  "business-operations/outcome-measurement": immutableSnapshot(
    businessMeasurementTemplate
  )
};

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map<DomainSchemaKey, ValidateFunction>(
  Object.entries(schemas).map(([key, schema]) => [
    key as DomainSchemaKey,
    ajv.compile(schema)
  ])
);

function key(packId: string, slot: string): DomainSchemaKey {
  return `${packId}/${slot}` as DomainSchemaKey;
}

export function validateDomainArtifactSchema(
  packId: string,
  slot: string,
  value: unknown
): readonly string[] {
  const validator = validators.get(key(packId, slot));
  if (validator === undefined) return [`unknown domain artifact schema ${packId}/${slot}`];
  if (validator(value)) return [];
  return (validator.errors ?? []).map(
    (error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}

export function domainArtifactSchemaDigest(
  packId: string,
  slot: string
): Digest {
  const schema = schemas[key(packId, slot)];
  if (schema === undefined) {
    throw new TypeError(`unknown domain artifact schema ${packId}/${slot}`);
  }
  return digest(schema);
}

export function domainArtifactTemplateDigest(
  packId: string,
  slot: string
): Digest {
  const template = templates[key(packId, slot)];
  if (template === undefined) {
    throw new TypeError(`unknown domain artifact template ${packId}/${slot}`);
  }
  return digest(template);
}

export function domainArtifactSchemaCount(): number {
  return validators.size;
}
