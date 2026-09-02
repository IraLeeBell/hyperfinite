import { digest } from "./canonical.js";
import type { TrustedGitHubBinding } from "./github-events.js";
import type {
  GitHubEffect,
  GitHubEffectPlan,
  GitHubProjectFieldValue,
  GitHubSafeOutput
} from "./github-types.js";
import type { Digest } from "./types.js";
import { assertDocument } from "./validation.js";

export type TargetFreeEffectIntent =
  | { readonly type: "issue-comment" }
  | {
      readonly type: "pull-request-review-comment";
      readonly event: "COMMENT";
    }
  | { readonly type: "check-run"; readonly name: string }
  | {
      readonly type: "project-field-update";
      readonly fieldKey: string;
      readonly expectedCurrentValue: GitHubProjectFieldValue | null;
      readonly value:
        | { readonly kind: "single-select"; readonly optionKey: string }
        | { readonly kind: "text"; readonly source: "summary" | "details" }
        | { readonly kind: "number"; readonly value: number };
    };

export interface SafeOutputTranslationInput {
  readonly output: GitHubSafeOutput;
  readonly intent: TargetFreeEffectIntent;
  readonly binding: TrustedGitHubBinding;
  readonly eventId: string;
  readonly contractRevision: number;
  readonly contractDigest: Digest;
  readonly receiptHead: Digest | null;
  readonly routeId: string;
  readonly attempt: number;
}

function renderSafeOutput(output: GitHubSafeOutput): string {
  const safe = (value: string): string =>
    value.replaceAll("<!-- agentic-framework-", "&lt;!-- agentic-framework-");
  const findings = output.findings
    .map(
      (finding) =>
        `- **${finding.severity.toUpperCase()} ${finding.code}:** ${safe(finding.message)}`
    )
    .join("\n");
  const questions = output.openQuestions
    .map((question) => `- ${safe(question)}`)
    .join("\n");
  return [
    safe(output.summary),
    findings.length > 0 ? `### Findings\n${findings}` : "",
    questions.length > 0 ? `### Open questions\n${questions}` : "",
    `### Result\n**${output.result.status}:** ${safe(output.result.details)}`
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}

function translateEffect(
  input: SafeOutputTranslationInput,
  idempotencyKey: Digest
): GitHubEffect {
  switch (input.intent.type) {
    case "issue-comment":
      return {
        type: "issue-comment",
        repository: input.binding.repository,
        workItem: {
          kind: input.binding.workItem.kind,
          number: input.binding.workItem.number,
          nodeId: input.binding.workItem.nodeId
        },
        body: `${renderSafeOutput(input.output)}\n\n<!-- agentic-framework-effect-key ${idempotencyKey} -->`
      };
    case "check-run":
      if (input.binding.workItem.kind !== "pull-request") {
        throw new TypeError("check-run effects require a pull request binding");
      }
      return {
        type: "check-run",
        repository: input.binding.repository,
        pullRequest: {
          number: input.binding.workItem.number,
          nodeId: input.binding.workItem.nodeId,
          base: input.binding.workItem.base,
          head: input.binding.workItem.head
        },
        headSha: input.binding.workItem.head.sha,
        name: input.intent.name,
        status: "completed",
        conclusion:
          input.output.result.status === "success"
            ? "success"
            : input.output.result.status === "blocked"
              ? "action_required"
              : "failure",
        summary: renderSafeOutput(input.output)
      };
    case "pull-request-review-comment":
      if (input.binding.workItem.kind !== "pull-request") {
        throw new TypeError("pull-request review comments require a pull request binding");
      }
      return {
        type: "pull-request-review-comment",
        repository: input.binding.repository,
        pullRequest: {
          number: input.binding.workItem.number,
          nodeId: input.binding.workItem.nodeId,
          base: input.binding.workItem.base,
          head: input.binding.workItem.head
        },
        headSha: input.binding.workItem.head.sha,
        event: input.intent.event,
        body: `${renderSafeOutput(input.output)}\n\n<!-- agentic-framework-effect-key ${idempotencyKey} -->`
      };
    case "project-field-update": {
      const intent = input.intent;
      const field = input.binding.project.fields.find(
        (candidate) => candidate.key === intent.fieldKey
      );
      if (field === undefined) {
        throw new TypeError(`unknown bound Project field ${intent.fieldKey}`);
      }
      let value: Extract<
        GitHubEffect,
        { readonly type: "project-field-update" }
      >["value"];
      switch (intent.value.kind) {
        case "single-select": {
          const optionKey = intent.value.optionKey;
          if (field.dataType !== "SINGLE_SELECT") {
            throw new TypeError(`Project field ${field.key} is not single-select`);
          }
          const option = field.options.find(
            (candidate) => candidate.key === optionKey
          );
          if (option === undefined) {
            throw new TypeError(
              `unknown bound Project option ${optionKey}`
            );
          }
          value = { kind: "single-select", optionNodeId: option.nodeId };
          break;
        }
        case "text":
          if (field.dataType !== "TEXT") {
            throw new TypeError(`Project field ${field.key} is not text`);
          }
          value = {
            kind: "text",
            text:
              intent.value.source === "summary"
                ? input.output.summary
                : input.output.result.details
          };
          break;
        case "number":
          if (field.dataType !== "NUMBER") {
            throw new TypeError(`Project field ${field.key} is not numeric`);
          }
          value = { kind: "number", number: intent.value.value };
          break;
      }
      return {
        type: "project-field-update",
        projectOwnerNodeId: input.binding.project.ownerNodeId,
        projectNodeId: input.binding.project.projectNodeId,
        itemNodeId: input.binding.project.itemNodeId,
        projectBindingDigest: input.binding.project.bindingDigest,
        fieldKey: field.key,
        fieldNodeId: field.nodeId,
        fieldDataType: field.dataType,
        expectedCurrentValue: intent.expectedCurrentValue,
        value
      };
    }
  }
}

export function translateSafeOutput(
  input: SafeOutputTranslationInput
): GitHubEffectPlan {
  assertDocument("GitHubSafeOutput", input.output);
  if (!Number.isSafeInteger(input.contractRevision) || input.contractRevision < 1) {
    throw new TypeError("contractRevision must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
    throw new TypeError("attempt must be a positive safe integer");
  }
  const bindingDigest = digest(input.binding);
  const idempotencyKey = digest({
    attempt: input.attempt,
    bindingDigest,
    contractRevision: input.contractRevision,
    effectType: input.intent.type,
    eventId: input.eventId,
    routeId: input.routeId
  });
  const effect = translateEffect(input, idempotencyKey);
  const pullRequest =
    input.binding.workItem.kind === "pull-request"
      ? input.binding.workItem
      : null;
  return assertDocument("GitHubEffectPlan", {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "GitHubEffectPlan",
    schemaVersion: "1.0.0",
    idempotencyKey,
    bindingDigest,
    eventId: input.eventId,
    routeId: input.routeId,
    attempt: input.attempt,
    expected: {
      contractDigest: input.contractDigest,
      receiptHead: input.receiptHead,
      projectSchemaDigest: input.binding.project.schemaDigest,
      baseSha: pullRequest?.base.sha ?? null,
      headSha: pullRequest?.head.sha ?? null
    },
    effect
  });
}
