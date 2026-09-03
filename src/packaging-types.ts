import type { Digest } from "./types.js";

export type InstallationOperation =
  | "install"
  | "upgrade"
  | "rollback"
  | "recover"
  | "uninstall";

export interface InstallationTargetBinding {
  readonly enterpriseSlug: string;
  readonly organizationLogin: string;
  readonly repositoryId: number;
  readonly repositoryNodeId: string;
  readonly repositoryFullName: string;
  readonly installationId: number;
  readonly defaultRef: string;
  readonly expectedHeadSha: string;
}

export interface ReleaseFile {
  readonly path: string;
  readonly type: "file";
  readonly mode: "100644" | "100755";
  readonly size: number;
  readonly digest: Digest;
}

export interface ReleaseManifest {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "ReleaseManifest";
  readonly schemaVersion: "1.0.0";
  readonly packageName: "agentic-framework";
  readonly packageVersion: string;
  readonly source: {
    readonly server: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly sourceDateEpoch: number;
  };
  readonly dependencyLockDigest: Digest;
  readonly licenseDigest: Digest;
  readonly noticesDigest: Digest;
  readonly files: readonly ReleaseFile[];
}

export interface InstallationConfig {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationConfig";
  readonly schemaVersion: "1.0.0";
  readonly operation: InstallationOperation;
  readonly packageVersion: string | null;
  readonly releaseManifestDigest: Digest;
  readonly migrationManifestDigest: Digest;
  readonly backupEvidenceDigest: Digest;
  readonly recoveryBaseStateDigest: Digest | null;
  readonly target: InstallationTargetBinding;
  readonly expectedResultHeadSha: string;
  readonly expectedStateDigest: Digest;
  readonly expectedJournalSequence: number;
  readonly expectedJournalHead: Digest | null;
  readonly apply: {
    readonly enabled: boolean;
    readonly humanChangeId: string | null;
  };
}

export interface InstallationBackupEvidence {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationBackupEvidence";
  readonly schemaVersion: "1.0.0";
  readonly targetBindingDigest: Digest;
  readonly stateDigest: Digest;
  readonly journalSequence: number;
  readonly journalHead: Digest | null;
  readonly backupArtifactDigest: Digest;
  readonly capturedAt: string;
  readonly evidenceRetained: true;
}

export interface InstallationState {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationState";
  readonly schemaVersion: "1.0.0";
  readonly target: InstallationTargetBinding;
  readonly status: "stable" | "partial" | "ambiguous";
  readonly packageVersion: string | null;
  readonly files: readonly ReleaseFile[];
  readonly journalSequence: number;
  readonly evidencePaths: readonly string[];
}

export interface PackageMigrationStep {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly checksum: Digest;
  readonly preconditions: readonly (
    | "backup-evidence-present"
    | "exact-source-version"
    | "exact-target-head-current"
    | "receipt-chain-valid"
  )[];
  readonly irreversible: boolean;
  readonly rollback: {
    readonly supported: boolean;
    readonly humanApprovalRequired: true;
  };
  readonly evidenceRetention: "preserve";
}

export interface MigrationManifest {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "MigrationManifest";
  readonly schemaVersion: "1.0.0";
  readonly packageName: "agentic-framework";
  readonly currentVersion: string;
  readonly steps: readonly PackageMigrationStep[];
}

export interface InstallationAction {
  readonly type:
    | "write-package-file"
    | "remove-package-file"
    | "reconcile-package-file";
  readonly path: string;
  readonly beforeDigest: Digest | null;
  readonly afterDigest: Digest | null;
  readonly mode: "100644" | "100755";
  readonly requiresHumanApproval: true;
}

export interface InstallationPlan {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationPlan";
  readonly schemaVersion: "1.0.0";
  readonly mode: "plan";
  readonly operation: InstallationOperation;
  readonly packageName: "agentic-framework";
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly releaseManifestDigest: Digest;
  readonly releaseManifest: ReleaseManifest;
  readonly migrationManifestDigest: Digest;
  readonly releaseSource: {
    readonly server: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly headSha: string;
  };
  readonly target: InstallationTargetBinding;
  readonly targetBindingDigest: Digest;
  readonly configurationDigest: Digest;
  readonly configuration: InstallationConfig;
  readonly expectedStateDigest: Digest;
  readonly expectedState: InstallationState;
  readonly recoveryBaseStateDigest: Digest | null;
  readonly recoveryBaseState: InstallationState | null;
  readonly migrationManifest: MigrationManifest;
  readonly expectedResultStateDigest: Digest;
  readonly expectedResultState: InstallationState;
  readonly expectedResultHeadSha: string;
  readonly expectedJournalSequence: number;
  readonly expectedJournalHead: Digest | null;
  readonly migrationPath: readonly string[];
  readonly migrationSteps: readonly {
    readonly id: string;
    readonly checksum: Digest;
    readonly direction: "forward" | "rollback";
    readonly irreversible: boolean;
  }[];
  readonly irreversibleSteps: readonly string[];
  readonly requiredPreconditions: readonly {
    readonly id:
      | "backup-evidence-present"
      | "exact-source-version"
      | "exact-target-head-current"
      | "receipt-chain-valid";
    readonly evidenceDigest: Digest;
  }[];
  readonly actions: readonly InstallationAction[];
  readonly retainedEvidencePaths: readonly string[];
  readonly applyRequested: boolean;
  readonly humanChangeId: string | null;
  readonly idempotencyKey: Digest;
  readonly planDigest: Digest;
}

export interface InstallationAuthorization {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationAuthorization";
  readonly schemaVersion: "1.0.0";
  readonly planDigest: Digest;
  readonly configurationDigest: Digest;
  readonly migrationManifestDigest: Digest;
  readonly releaseHeadSha: string;
  readonly targetBindingDigest: Digest;
  readonly expectedHeadSha: string;
  readonly expectedResultHeadSha: string;
  readonly expectedStateDigest: Digest;
  readonly idempotencyKey: Digest;
  readonly operation: InstallationOperation;
  readonly humanChangeId: string;
  readonly approverDigest: Digest;
  readonly destructiveApproved: boolean;
  readonly irreversibleApproved: boolean;
  readonly approvedAt: string;
  readonly expiresAt: string;
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly value: string;
  };
}

export interface InstallationReceipt {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationReceipt";
  readonly schemaVersion: "1.0.0";
  readonly sequence: number;
  readonly previousReceiptDigest: Digest | null;
  readonly planDigest: Digest;
  readonly targetBindingDigest: Digest;
  readonly idempotencyKey: Digest;
  readonly operation: InstallationOperation;
  readonly expectedStateDigest: Digest;
  readonly resultStateDigest: Digest;
  readonly appliedHeadSha: string;
  readonly status: "applied";
  readonly evidenceRetained: true;
  readonly appliedAt: string;
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly value: string;
  };
}

export interface InstallationLiveValidation {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "InstallationLiveValidation";
  readonly schemaVersion: "1.0.0";
  readonly mode: "live-read-only";
  readonly adapterId: string;
  readonly planDigest: Digest;
  readonly authorizationDigest: Digest;
  readonly targetBindingDigest: Digest;
  readonly expectedStateDigest: Digest;
  readonly observedStateDigest: Digest;
  readonly expectedHeadSha: string;
  readonly observedHeadSha: string;
  readonly validatedAt: string;
  readonly signature: {
    readonly keyId: string;
    readonly algorithm: "ed25519";
    readonly value: string;
  };
}

export interface CompatibilityMatrix {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "CompatibilityMatrix";
  readonly schemaVersion: "1.0.0";
  readonly packageVersion: string;
  readonly technicalIdentity: {
    readonly decision: "retain-compatibility-identity";
    readonly productName: "Hyperfinite";
    readonly identifierEpoch: "agentic-framework/v1alpha1";
    readonly packageName: "agentic-framework";
    readonly releaseArchiveName: "agentic-framework.tar";
    readonly apiVersion: "agentic-framework.github.com/v1alpha1";
    readonly schemaBaseUri: "https://agentic-framework.github.com/schemas/";
    readonly projectSchemaName: "agentic-framework-control-plane";
    readonly capabilityPublisher: "agentic-framework";
    readonly domainStem: "agentic-framework";
    readonly issueTaxonomyUserAgent: "agentic-framework-issue-taxonomy/1.0";
    readonly syntheticCanarySeed: "agentic-framework credentialless synthetic sandbox canary v1";
    readonly syntheticOidcAudiencePrefix: "synthetic://agentic-framework/";
  };
  readonly productBoundary: {
    readonly decision: "repository-and-customer-starter-only";
    readonly maintainerEntryPoint: "authoritative-repository-clone";
    readonly localEvaluatorEntryPoint: "authoritative-repository-clone";
    readonly customerSandboxEntryPoint: "customer-starter-or-reviewed-file-copy";
    readonly repositoryScripts: "supported-in-repository-context";
    readonly typescriptApi: "unsupported-internal-only";
    readonly npmRegistryPackage: "unsupported-private-metadata-only";
    readonly packagedCli: "unsupported-absent";
    readonly hostedService: "unsupported-absent";
    readonly deployableService: "unsupported-absent";
    readonly liveAdministration: "external-human-prerequisite";
    readonly liveEffects: "external-trust-service-prerequisite";
    readonly futureDistribution: "separate-product-work-required";
  };
  readonly nodeMajors: readonly number[];
  readonly npmMajors: readonly number[];
  readonly ghCliVersion: "2.96.0";
  readonly gitMinimumVersion: "2.46.0";
  readonly ghAwVersion: "v0.86.2";
  readonly copilotCliVersion: "1.0.79";
  readonly actions: {
    readonly runner: "ubuntu-slim";
    readonly setupNodeMajor: 24;
  };
  readonly platforms: {
    readonly ghec: "supported";
    readonly ghes: "unsupported-unverified";
  };
  readonly contractVersions: {
    readonly packaging: "1.0.0";
    readonly control: "1.0.0";
    readonly project: "1.0.0";
    readonly runtime: "1.0.0";
    readonly demoProject: "2.0.0";
    readonly stageAgentBinding: "2.0.0";
    readonly agentSelection: "1.0.0";
    readonly deploymentTopology: "1.0.0";
    readonly githubAppRegistration: "1.0.0";
    readonly administratorPlan: "1.0.0";
    readonly administratorHandoff: "1.0.0";
    readonly durableStore: "1.0.0";
  };
}

export interface OpenSourceReadinessAssessment {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "OpenSourceReadinessAssessment";
  readonly schemaVersion: "1.0.0";
  readonly packageVersion: string;
  readonly decision: "not-ready";
  readonly authoritative: false;
  readonly licensePreserved: true;
  readonly categories: readonly {
    readonly id:
      | "license-notice-provenance"
      | "contribution-security-governance"
      | "dependency-licensing"
      | "trademarks-branding"
      | "secrets-customer-data"
      | "support-sla"
      | "build-reproducibility"
      | "release-signing"
      | "internal-references";
    readonly status: "unresolved-human-gate";
    readonly requiredEvidence: readonly string[];
    readonly owners: readonly ("legal" | "ospo" | "product" | "security" | "maintainer")[];
  }[];
  readonly prohibitedDecisions: readonly [
    "license-change",
    "publication",
    "repository-visibility-change",
    "release"
  ];
}

export interface ReleaseCandidateChecklist {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "ReleaseCandidateChecklist";
  readonly schemaVersion: "1.0.0";
  readonly packageVersion: string;
  readonly headSha: string;
  readonly archiveDigest: Digest;
  readonly releaseManifestDigest: Digest;
  readonly sbomDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly attestationDigest: Digest;
  readonly decision: "no-go";
  readonly authoritative: false;
  readonly selfApproved: false;
  readonly checks: readonly {
    readonly id: string;
    readonly status:
      | "requires-exact-head-evidence"
      | "requires-human-approval"
      | "unsupported";
    readonly evidenceDigest: Digest | null;
  }[];
  readonly residualRisks: readonly string[];
  readonly deploymentPrerequisites: readonly string[];
  readonly unsupportedEnvironments: readonly string[];
  readonly rollbackLimits: readonly string[];
  readonly manualLiveProbes: readonly string[];
  readonly noGoConditions: readonly string[];
}

export interface CustomerStarterSelection {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "CustomerStarterSelection";
  readonly schemaVersion: "1.0.0";
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly baseSelectionDigest: Digest | null;
  readonly sourceHeadSha: string;
  readonly includedPaths: readonly string[];
  readonly excludedPaths: readonly string[];
  // Binds this selection to the exact set of files (path/mode/content
  // digest) that includedPaths/excludedPaths resolve to at sourceHeadSha,
  // excluding this selection document's own self-referential entry. Building
  // or verifying at any later commit re-resolves the same prefixes against
  // the exact current tree and must reproduce this identical digest, or the
  // build fails closed: a file silently added, removed, mode-changed, or
  // content-changed under a reviewed prefix since sourceHeadSha is rejected
  // rather than silently packaged. Ancestry of sourceHeadSha alone is not
  // sufficient evidence that no such drift occurred.
  readonly resolvedClosureDigest: Digest;
}

export interface CustomerStarterManifest {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "CustomerStarterManifest";
  readonly schemaVersion: "1.0.0";
  readonly packageName: "agentic-framework";
  readonly packageVersion: string;
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly baseManifestDigest: Digest | null;
  readonly selectionDigest: Digest;
  readonly source: {
    readonly server: string;
    readonly repository: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly sourceDateEpoch: number;
  };
  readonly licenseDigest: Digest;
  readonly noticesDigest: Digest;
  readonly dependencyLockDigest: Digest | null;
  // Binds the exact reviewed content of the catalog-sealed scan denylists
  // and this profile's catalog-sealed advertisedScripts list into the
  // manifest, so a reader can confirm which reviewed policy documents
  // produced this manifest's scan evidence without trusting an
  // unbindable, out-of-band claim. All three are always derived by the
  // engine itself from the fixed profile catalog and the exact reviewed
  // Git tree; none is ever a caller-suppliable build/verify parameter.
  readonly internalReferenceDenylistDigest: Digest;
  readonly customerDataDenylistDigest: Digest;
  readonly advertisedScriptsDigest: Digest;
  readonly files: readonly ReleaseFile[];
}

export type CustomerStarterScanId =
  | "secret-scan"
  | "internal-reference-scan"
  | "customer-data-scan"
  | "generated-workflow-source-closure"
  | "schema-reference-closure"
  | "module-import-closure"
  | "markdown-link-closure"
  | "package-script-closure";

export interface CustomerStarterPreflightReport {
  readonly apiVersion: "agentic-framework.github.com/v1alpha1";
  readonly kind: "CustomerStarterPreflightReport";
  readonly schemaVersion: "1.0.0";
  readonly packageVersion: string;
  readonly profileId: string;
  readonly extendsProfileId: string | null;
  readonly sourceHeadSha: string;
  readonly starterManifestDigest: Digest;
  readonly sbomDigest: Digest;
  readonly provenanceDigest: Digest;
  readonly openSourceReadinessDigest: Digest;
  readonly decision: "no-go";
  readonly authoritative: false;
  readonly selfApproved: false;
  readonly scans: readonly {
    readonly id: CustomerStarterScanId;
    readonly status: "clean";
    readonly findingsDigest: Digest;
  }[];
  readonly categories: OpenSourceReadinessAssessment["categories"];
  readonly residualRisks: readonly string[];
}

export type PackagingDocument =
  | CompatibilityMatrix
  | CustomerStarterManifest
  | CustomerStarterPreflightReport
  | CustomerStarterSelection
  | InstallationAuthorization
  | InstallationBackupEvidence
  | InstallationConfig
  | InstallationPlan
  | InstallationReceipt
  | InstallationLiveValidation
  | InstallationState
  | MigrationManifest
  | OpenSourceReadinessAssessment
  | ReleaseCandidateChecklist
  | ReleaseManifest;
