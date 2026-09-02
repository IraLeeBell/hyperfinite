import type { ApiVersion, Digest } from "./types.js";
import type { DemoProjectId, DemoProjectionSource } from "./demo-types.js";

export type GitHubProjectFieldType =
  | "DATE"
  | "ITERATION"
  | "NUMBER"
  | "SINGLE_SELECT"
  | "TEXT";

export type GitHubProjectProjectionSlot =
  | "stage"
  | "journey-stage"
  | "demo-project-profile"
  | "depth-profile"
  | "domain-pack"
  | "gate-status"
  | "contract-revision"
  | "last-receipt"
  | "attention"
  | "target-repository"
  | "run-attempt"
  | "current-draft-pr"
  | "current-stage-agent"
  | "stage-interaction"
  | "agent-selection-status";

export interface GitHubProjectSchema {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectSchema";
  readonly metadata: {
    readonly name: string;
    readonly version: string;
  };
  readonly owner: {
    readonly type: "organization" | "user";
    readonly login: string;
  };
  readonly project: {
    readonly title: string;
    readonly shortDescription?: string;
  };
  readonly fields: readonly {
    readonly key: string;
    readonly name: string;
    readonly dataType: GitHubProjectFieldType;
    readonly required: boolean;
    readonly options: readonly {
      readonly key: string;
      readonly name: string;
      readonly description?: string;
      readonly color?:
        | "GRAY"
        | "BLUE"
        | "GREEN"
        | "YELLOW"
        | "ORANGE"
        | "RED"
        | "PINK"
        | "PURPLE";
    }[];
  }[];
  readonly projections: readonly {
    readonly slot: GitHubProjectProjectionSlot;
    readonly fieldKey: string;
    readonly source?: DemoProjectionSource;
    readonly displayOnly?: boolean;
    readonly writeOrder?: number;
  }[];
}

export interface DemoGitHubProjectSchemaEntry {
  readonly demoProjectId: DemoProjectId;
  readonly schema: GitHubProjectSchema;
}

export interface DemoIssueFormBinding {
  readonly demoProjectId: DemoProjectId;
  readonly title:
    | "App Modernization"
    | "Feature Delivery"
    | "Security and Dependency Remediation"
    | "Adaptive Delivery";
  readonly formId: DemoProjectId;
  readonly issueFormPath: string;
  readonly projectSchemaPath: string;
  readonly projectProfileRef: string;
  readonly projectSchemaDigest: Digest;
  readonly consentField: "demo-consent";
}

export interface DemoIssueIntakeSubmission {
  readonly desiredOutcome: string;
  readonly repositoryHint: string;
  readonly constraints: string;
  readonly acceptanceEvidence: string;
  readonly depthProfile: "D0" | "D1" | "D2" | "D3";
  readonly consent: boolean;
}

export type DemoIssueIntakeField =
  | "desired-outcome"
  | "repository-hint"
  | "constraints"
  | "acceptance-evidence";

export interface DemoMissingInformationRequest {
  readonly apiVersion: ApiVersion;
  readonly kind: "DemoMissingInformationRequest";
  readonly schemaVersion: "1.0.0";
  readonly contentDigest: Digest;
  readonly spec: {
    readonly demoProjectId: DemoProjectId;
    readonly issueNodeId: string;
    readonly field: DemoIssueIntakeField;
    readonly request: string;
    readonly evidence: {
      readonly kind: "issue-form-submission";
      readonly formId: DemoProjectId;
      readonly submissionDigest: Digest;
    };
  };
}

export type DemoIssueIntakeBlockCode =
  | "FORM_PROFILE_MISMATCH"
  | "CONSENT_REQUIRED"
  | "ACTIVATION_PROFILE_DISABLED"
  | "SUBMITTER_UNAUTHORIZED"
  | "REPOSITORY_BINDING_UNRESOLVED"
  | "REPOSITORY_BINDING_STALE"
  | "PROJECT_BINDING_STALE"
  | "CONTENT_MALFORMED"
  | "CONTENT_OVERSIZED"
  | "DEPTH_PROFILE_NOT_ALLOWED"
  | "BUDGET_MISSING"
  | "ACTIVATION_WINDOW_INVALID"
  | "MISSING_INFORMATION";

interface DemoIssueIntakeAuthorityBoundary {
  readonly credentials: "denied";
  readonly budgetReservation: "denied";
  readonly inference: "denied";
  readonly issueCreation: "denied";
}

export type DemoIssueIntakeDecision =
  | {
      readonly status: "ready-for-kernel-activation";
      readonly state: "ACTIVATION_PENDING";
      readonly demoProjectId: DemoProjectId;
      readonly profileDigest: Digest;
      readonly projectSchemaDigest: Digest;
      readonly repositoryBindingDigest: Digest;
      readonly projectBindingDigest: Digest;
      readonly submissionDigest: Digest;
      readonly normalizedSubmission: DemoIssueIntakeSubmission;
      readonly authority: DemoIssueIntakeAuthorityBoundary;
    }
  | {
      readonly status: "blocked";
      readonly state: "ACTIVATION_PENDING" | "BLOCKED";
      readonly demoProjectId: DemoProjectId;
      readonly code: DemoIssueIntakeBlockCode;
      readonly message: string;
      readonly submissionDigest: Digest | null;
      readonly missingInformation: DemoMissingInformationRequest | null;
      readonly authority: DemoIssueIntakeAuthorityBoundary;
    };

export interface GitHubProjectBinding {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubProjectBinding";
  readonly schemaVersion: "1.0.0";
  readonly projectSchemaDigest: Digest;
  readonly owner: {
    readonly type: "organization" | "user";
    readonly login: string;
    readonly nodeId: string;
  };
  readonly installation: {
    readonly id: number;
    readonly accountNodeId: string;
  };
  readonly project: {
    readonly number: number;
    readonly nodeId: string;
    readonly title: string;
  };
  readonly fields: readonly {
    readonly key: string;
    readonly nodeId: string;
    readonly name: string;
    readonly dataType: GitHubProjectFieldType;
    readonly options: readonly {
      readonly key: string;
      readonly nodeId: string;
      readonly name: string;
    }[];
  }[];
  readonly validatedAt: string;
}

export interface GitHubSafeOutput {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubSafeOutput";
  readonly schemaVersion: "1.0.0";
  readonly summary: string;
  readonly findings: readonly {
    readonly code: string;
    readonly severity: "info" | "warning" | "blocking";
    readonly message: string;
  }[];
  readonly openQuestions: readonly string[];
  readonly result: {
    readonly status: "success" | "blocked" | "failed";
    readonly details: string;
  };
}

export type GitHubEffect =
  | {
      readonly type: "issue-comment";
      readonly repository: {
        readonly id: number;
        readonly nodeId: string;
        readonly owner: string;
        readonly name: string;
        readonly fullName: string;
      };
      readonly workItem: {
        readonly kind: "issue" | "pull-request";
        readonly number: number;
        readonly nodeId: string;
      };
      readonly body: string;
    }
  | {
      readonly type: "check-run";
      readonly repository: {
        readonly id: number;
        readonly nodeId: string;
        readonly owner: string;
        readonly name: string;
        readonly fullName: string;
      };
      readonly pullRequest: {
        readonly number: number;
        readonly nodeId: string;
        readonly base: {
          readonly repository: {
            readonly id: number;
            readonly nodeId: string;
            readonly owner: string;
            readonly name: string;
            readonly fullName: string;
          };
          readonly ref: string;
          readonly sha: string;
        };
        readonly head: {
          readonly repository: {
            readonly id: number;
            readonly nodeId: string;
            readonly owner: string;
            readonly name: string;
            readonly fullName: string;
          };
          readonly ref: string;
          readonly sha: string;
        };
      };
      readonly headSha: string;
      readonly name: string;
      readonly status: "queued" | "in_progress" | "completed";
      readonly conclusion:
        | "action_required"
        | "cancelled"
        | "failure"
        | "neutral"
        | "success"
        | "timed_out"
        | null;
      readonly summary: string;
    }
  | {
      readonly type: "pull-request-review-comment";
      readonly repository: {
        readonly id: number;
        readonly nodeId: string;
        readonly owner: string;
        readonly name: string;
        readonly fullName: string;
      };
      readonly pullRequest: {
        readonly number: number;
        readonly nodeId: string;
        readonly base: {
          readonly repository: {
            readonly id: number;
            readonly nodeId: string;
            readonly owner: string;
            readonly name: string;
            readonly fullName: string;
          };
          readonly ref: string;
          readonly sha: string;
        };
        readonly head: {
          readonly repository: {
            readonly id: number;
            readonly nodeId: string;
            readonly owner: string;
            readonly name: string;
            readonly fullName: string;
          };
          readonly ref: string;
          readonly sha: string;
        };
      };
      readonly headSha: string;
      readonly event: "COMMENT";
      readonly body: string;
    }
  | {
      readonly type: "project-field-update";
      readonly projectNodeId: string;
      readonly projectOwnerNodeId: string;
      readonly itemNodeId: string;
      readonly projectBindingDigest: Digest;
      readonly fieldKey: string;
      readonly fieldNodeId: string;
      readonly fieldDataType: GitHubProjectFieldType;
      readonly expectedCurrentValue: GitHubProjectFieldValue | null;
      readonly value: GitHubProjectFieldValue;
    };

export type GitHubProjectFieldValue =
  | { readonly kind: "single-select"; readonly optionNodeId: string }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "number"; readonly number: number };

export interface GitHubEffectPlan {
  readonly apiVersion: ApiVersion;
  readonly kind: "GitHubEffectPlan";
  readonly schemaVersion: "1.0.0";
  readonly idempotencyKey: Digest;
  readonly bindingDigest: Digest;
  readonly eventId: string;
  readonly routeId: string;
  readonly attempt: number;
  readonly expected: {
    readonly contractDigest: Digest;
    readonly receiptHead: Digest | null;
    readonly projectSchemaDigest: Digest;
    readonly baseSha: string | null;
    readonly headSha: string | null;
  };
  readonly effect: GitHubEffect;
}
