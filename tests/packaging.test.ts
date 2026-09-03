import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import * as agenticFramework from "../src/index.js";
import {
  applyInstallationPlan,
  assertReleasePath,
  buildReleaseBundle,
  canonicalJson,
  createDeterministicTar,
  digest,
  MAX_INSTALLATION_RECEIPTS,
  migrationStepChecksum,
  planInstallation,
  receiptDigest,
  reconcileInstallation,
  splitCanonicalUstarPath,
  validateAuthenticatedInstallationJournal,
  validateDocument,
  validateInstallationJournalStructure,
  validateLiveInstallationPlan,
  validateMigrationManifest,
  validateOpenSourceAssessment,
  validateSpdxDocument,
  verifyDeterministicTar,
  verifyReleaseBundle,
  type InstallationAuthorization,
  type InstallationBackupEvidence,
  type InstallationConfig,
  type InstallationLiveValidation,
  type InstallationPlan,
  type InstallationReceipt,
  type InstallationState,
  type MigrationManifest,
  type ReleaseFile,
  type ReleaseManifest,
  type TrustedInstallationAdapter
} from "../src/index.js";
import {
  assertSafeOutputRoot,
  canonicalDirectory,
  githubRepositoryFromRemote,
  listGitTree,
  safeOutputPath
} from "../src/release-support.js";
import {
  assertIdentifierEpochBoundaries,
  assertRetainedTechnicalIdentity,
  assertReviewedTechnicalIdentityInventory,
  assertTechnicalIdentityInventoryEvidence,
  assertTechnicalIdentityPackageMetadata,
  assertTechnicalIdentityPublishers,
  inventoryTechnicalIdentity,
  RETAINED_TECHNICAL_IDENTITY,
  technicalIdentityRegistryPublishers
} from "../src/technical-identity.js";

const ROOT = process.cwd();

test("Hyperfinite retains one closed technical compatibility identity", () => {
  const compatibility = agenticFramework.assertDocument(
    "PackagingDocument",
    json("config/v1alpha1/compatibility.json")
  );
  assert.equal(compatibility.kind, "CompatibilityMatrix");
  if (compatibility.kind !== "CompatibilityMatrix") {
    assert.fail("expected CompatibilityMatrix");
  }

  assert.deepEqual(
    assertRetainedTechnicalIdentity(compatibility.technicalIdentity),
    RETAINED_TECHNICAL_IDENTITY
  );
  assertTechnicalIdentityPackageMetadata(
    json("package.json"),
    RETAINED_TECHNICAL_IDENTITY
  );
  assertTechnicalIdentityPublishers(
    [RETAINED_TECHNICAL_IDENTITY.capabilityPublisher],
    RETAINED_TECHNICAL_IDENTITY
  );

  const migratedStem = ["hyper", "finite"].join("");
  const migrated = {
    ...compatibility,
    technicalIdentity: {
      ...compatibility.technicalIdentity,
      packageName: migratedStem
    }
  };
  assert.equal(
    validateDocument("PackagingDocument", migrated).valid,
    false
  );
  assert.throws(
    () => assertRetainedTechnicalIdentity(migrated.technicalIdentity),
    /must remain/
  );
  assert.throws(
    () =>
      assertTechnicalIdentityPublishers(
        [migratedStem],
        RETAINED_TECHNICAL_IDENTITY
      ),
    /publisher identity drifted/
  );

  const epochField = ["identifier", "Epoch"].join("");
  const migrations = agenticFramework.assertDocument(
    "PackagingDocument",
    json("config/v1alpha1/migrations.json")
  );
  assert.equal(migrations.kind, "MigrationManifest");
  if (migrations.kind !== "MigrationManifest") {
    assert.fail("expected MigrationManifest");
  }
  assert.equal(
    validateDocument("PackagingDocument", {
      ...migrations,
      packageName: migratedStem,
      [epochField]: RETAINED_TECHNICAL_IDENTITY.identifierEpoch
    }).valid,
    false
  );

  const runtimePolicy = agenticFramework.assertDocument(
    "CopilotRuntimePolicy",
    json("config/v1alpha1/copilot-runtime-policy.json")
  );
  assert.equal(
    validateDocument("CopilotRuntimePolicy", {
      ...runtimePolicy,
      apiVersion: `${migratedStem}.github.com/v1alpha1`,
      [epochField]: RETAINED_TECHNICAL_IDENTITY.identifierEpoch
    }).valid,
    false
  );

  const retainedDomainLine =
    'const domain = "agentic-framework.runtime-signature.v1";';
  const inventorySources = [
    {
      path: "docs/identity.md",
      content: "Hyperfinite retains `agentic-framework` for compatibility."
    },
    {
      path: "src/api.ts",
      content:
        'const apiVersion = "agentic-framework.github.com/v1alpha1";'
    },
    {
      path: "config/v1alpha1/capability-registry.json",
      content: '{"publisher":"agentic-framework"}'
    },
    {
      path: "src/release.ts",
      content: 'const packageName = "agentic-framework";'
    },
    {
      path: "src/runtime.ts",
      content: retainedDomainLine
    },
    {
      path: "examples/example.json",
      content: '{"apiVersion":"agentic-framework.github.com/v1alpha1"}'
    }
  ];
  const inventory = inventoryTechnicalIdentity(inventorySources);
  assert.equal(inventory.occurrences, 6);
  for (const count of Object.values(inventory.categories)) {
    assert.equal(count.occurrences, 1);
  }
  const enabledDomain = inventoryTechnicalIdentity([
    {
      path: "src/runtime.ts",
      content: ["if (true) {", "  authorize();", retainedDomainLine, "}"].join(
        "\n"
      )
    }
  ]);
  const disabledDomain = inventoryTechnicalIdentity([
    {
      path: "src/runtime.ts",
      content: ["if (false) {", "  authorize();", retainedDomainLine, "}"].join(
        "\n"
      )
    }
  ]);
  assert.equal(enabledDomain.occurrences, disabledDomain.occurrences);
  assert.notEqual(enabledDomain.inventoryDigest, disabledDomain.inventoryDigest);
  const selectionEvidence = {
    apiVersion: RETAINED_TECHNICAL_IDENTITY.apiVersion,
    kind: "CustomerStarterSelection",
    schemaVersion: "1.0.0",
    profileId: "control-plane-core",
    extendsProfileId: null,
    baseSelectionDigest: null,
    sourceHeadSha: "1".repeat(40),
    includedPaths: ["src"],
    excludedPaths: [],
    resolvedClosureDigest: `sha256:${"2".repeat(64)}`
  };
  const firstSelectionInventory = inventoryTechnicalIdentity([
    {
      path: "config/v1alpha1/customer-starter-selection.json",
      content: JSON.stringify(selectionEvidence, null, 2)
    }
  ]);
  const repinnedSelectionInventory = inventoryTechnicalIdentity([
    {
      path: "config/v1alpha1/customer-starter-selection.json",
      content: JSON.stringify(
        {
          ...selectionEvidence,
          sourceHeadSha: "3".repeat(40),
          resolvedClosureDigest: `sha256:${"4".repeat(64)}`
        },
        null,
        2
      )
    }
  ]);
  assert.equal(
    firstSelectionInventory.inventoryDigest,
    repinnedSelectionInventory.inventoryDigest
  );
  const widenedSelectionInventory = inventoryTechnicalIdentity([
    {
      path: "config/v1alpha1/customer-starter-selection.json",
      content: JSON.stringify(
        {
          ...selectionEvidence,
          includedPaths: ["src", "scripts"]
        },
        null,
        2
      )
    }
  ]);
  assert.notEqual(
    firstSelectionInventory.inventoryDigest,
    widenedSelectionInventory.inventoryDigest
  );
  const reviewedInventoryEvidence = {
    kind: "TechnicalIdentityInventoryEvidence" as const,
    schemaVersion: "1.0.0" as const,
    scopes: {
      "authoritative-repository": {
        inventoryFiles: inventory.filesWithOccurrences,
        inventoryMatchingLines: inventory.matchingLines,
        inventoryOccurrences: inventory.occurrences,
        inventoryDigest: inventory.inventoryDigest
      },
      "control-plane-core": {
        inventoryFiles: 1,
        inventoryMatchingLines: 1,
        inventoryOccurrences: 1,
        inventoryDigest: `sha256:${"0".repeat(64)}` as const
      },
      "demo-portfolio": {
        inventoryFiles: 1,
        inventoryMatchingLines: 1,
        inventoryOccurrences: 1,
        inventoryDigest: `sha256:${"1".repeat(64)}` as const
      }
    }
  };
  assert.equal(
    assertReviewedTechnicalIdentityInventory(
      inventorySources,
      reviewedInventoryEvidence,
      "authoritative-repository"
    ).scope,
    "authoritative-repository"
  );
  assert.throws(
    () =>
      assertReviewedTechnicalIdentityInventory(
        inventorySources,
        reviewedInventoryEvidence,
        "control-plane-core"
      ),
    /inventory drifted/
  );
  assert.doesNotThrow(() =>
    assertTechnicalIdentityInventoryEvidence(inventory, {
      inventoryFiles: inventory.filesWithOccurrences,
      inventoryMatchingLines: inventory.matchingLines,
      inventoryOccurrences: inventory.occurrences,
      inventoryDigest: inventory.inventoryDigest
    })
  );
  assert.throws(
    () =>
      assertTechnicalIdentityInventoryEvidence(inventory, {
        inventoryFiles: inventory.filesWithOccurrences,
        inventoryMatchingLines: inventory.matchingLines,
        inventoryOccurrences: inventory.occurrences - 1,
        inventoryDigest: inventory.inventoryDigest
      }),
    /inventory drifted/
  );

  const staleDisplayName = ["Agentic", "Framework"].join(" ");
  assert.throws(
    () =>
      inventoryTechnicalIdentity([
        { path: "docs/stale.md", content: staleDisplayName }
      ]),
    /stale product spelling/
  );
  assert.throws(
    () =>
      inventoryTechnicalIdentity([
        {
          path: "src/migrated.ts",
          content: `const apiVersion = "${migratedStem}.github.com/v1alpha1";`
        }
      ]),
    /unsupported Hyperfinite technical identifier/
  );
  for (const forbiddenTechnicalIdentity of [
    `synthetic://${migratedStem}/authorization-redeemer`,
    `${migratedStem}-issue-taxonomy/1.0`,
    `${migratedStem} credentialless synthetic sandbox canary v1`
  ]) {
    assert.throws(
      () =>
        inventoryTechnicalIdentity([
          {
            path: "src/migrated-domain.ts",
            content: forbiddenTechnicalIdentity
          }
        ]),
      /unsupported Hyperfinite technical identifier/
    );
  }

  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "config/v1alpha1/migrations.json",
          content: `{"identifier\\u0045poch":"agentic-framework/v1alpha1"}`
        }
      ]),
    /outside the exact compatibility declaration/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/packaging.schema.json",
          content: JSON.stringify({
            $defs: {
              "compatibilityMatrix/allOf/1/properties/technicalIdentity": {
                properties: {
                  [epochField]: {
                    const: RETAINED_TECHNICAL_IDENTITY.identifierEpoch
                  }
                }
              }
            }
          })
        }
      ]),
    /outside the exact compatibility declaration/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/packaging.schema.json",
          content: JSON.stringify({
            $defs: {
              migrationManifest: {
                properties: {
                  [epochField]: {
                    enum: ["agentic-framework/v1alpha1"]
                  }
                }
              }
            }
          })
        }
      ]),
    /outside the exact compatibility declaration/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "src/runtime-input.ts",
          content: `interface RuntimeInput { ${epochField}: string }`
        }
      ]),
    /outside the exact compatibility type/
  );
  assert.throws(
    () =>
      technicalIdentityRegistryPublishers(
        JSON.parse(
          `{"kind":"CapabilityRegistry","capabilities":[{"publ\\u0069sher":"${migratedStem}"}]}`
        ),
        RETAINED_TECHNICAL_IDENTITY
      ),
    /publisher identity drifted/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/example.schema.json",
          content: JSON.stringify({
            type: "object",
            patternProperties: {
              [`^${epochField}$`]: { type: "string" }
            }
          })
        }
      ]),
    /patternProperties admits/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/example.schema.json",
          content: JSON.stringify({
            $id: `https://${migratedStem}.github.com/schemas/example.schema.json`,
            type: "object",
            additionalProperties: false
          })
        }
      ]),
    /schema ID outside the retained origin/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/example.schema.json",
          content: JSON.stringify({
            $id: RETAINED_TECHNICAL_IDENTITY.schemaBaseUri + "example.schema.json",
            $ref: "../../../alternate-origin.schema.json"
          })
        }
      ]),
    /schema reference outside the retained origin/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "schemas/v1alpha1/example.schema.json",
          content: JSON.stringify({
            $id:
              RETAINED_TECHNICAL_IDENTITY.schemaBaseUri +
              "../outside.schema.json",
            type: "object",
            additionalProperties: false
          })
        }
      ]),
    /schema ID outside the retained origin/
  );
  const nestedCompatibilityType = [
    "export interface CompatibilityMatrix {",
    "  readonly runtimeInput: {",
    "    readonly technicalIdentity: {",
    `      readonly ${epochField}: "${RETAINED_TECHNICAL_IDENTITY.identifierEpoch}";`,
    "    };",
    "  };",
    "}"
  ].join("\n");
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "src/packaging-types.ts",
          content: nestedCompatibilityType
        }
      ]),
    /CompatibilityMatrix must own/
  );
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "src/runtime-input.ts",
          content: 'interface RuntimeInput { ["identifier" + "Epoch"]: string }'
        }
      ]),
    /outside the exact compatibility type/
  );
  const continuedEpochProperty =
    '"identifierEpo' + "\\" + "\n" + 'ch": string';
  assert.throws(
    () =>
      assertIdentifierEpochBoundaries([
        {
          path: "src/runtime-input.ts",
          content: `interface RuntimeInput { ${continuedEpochProperty} }`
        }
      ]),
    /outside the exact compatibility type/
  );
});

test("source repository identity includes the canonical GitHub host", () => {
  assert.deepEqual(
    githubRepositoryFromRemote(
      "https://github.com/example-organization/hyperfinite.git"
    ),
    {
      server: "github.com",
      repository: "example-organization/hyperfinite"
    }
  );
  assert.deepEqual(
    githubRepositoryFromRemote(
      "git@github.com:example-organization/hyperfinite.git"
    ),
    {
      server: "github.com",
      repository: "example-organization/hyperfinite"
    }
  );
  assert.deepEqual(
    githubRepositoryFromRemote(
      "ssh://git@github.com/example-organization/hyperfinite.git"
    ),
    {
      server: "github.com",
      repository: "example-organization/hyperfinite"
    }
  );
  assert.deepEqual(
    githubRepositoryFromRemote(
      "https://ACME.ghe.com/Platform/Hyperfinite.git"
    ),
    {
      server: "acme.ghe.com",
      repository: "platform/hyperfinite"
    }
  );
  assert.deepEqual(
    githubRepositoryFromRemote(
      "git@ACME.ghe.com:Platform/Hyperfinite.git"
    ),
    {
      server: "acme.ghe.com",
      repository: "platform/hyperfinite"
    }
  );
  assert.notDeepEqual(
    githubRepositoryFromRemote(
      "https://github.com/platform/hyperfinite.git"
    ),
    githubRepositoryFromRemote(
      "https://acme.ghe.com/platform/hyperfinite.git"
    )
  );
  assert.throws(
    () =>
      githubRepositoryFromRemote(
        "https://example.invalid/example-organization/hyperfinite.git"
      ),
    /canonical GitHub Enterprise Cloud repository URL/u
  );
});

function json<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8")) as T;
}

function example(): {
  readonly config: InstallationConfig;
  readonly backup: InstallationBackupEvidence;
  readonly manifest: ReleaseManifest;
  readonly migrations: MigrationManifest;
  readonly state: InstallationState;
} {
  return {
    config: json("examples/customer-installation/installation.json"),
    backup: json("examples/customer-installation/backup-evidence.json"),
    manifest: json("examples/customer-installation/release-manifest.json"),
    migrations: json("config/v1alpha1/migrations.json"),
    state: json("examples/customer-installation/state.json")
  };
}

function backupFor(
  state: InstallationState,
  journalHead: InstallationReceipt["previousReceiptDigest"] = null
): InstallationBackupEvidence {
  const { expectedHeadSha: _expectedHeadSha, ...targetIdentity } = state.target;
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "InstallationBackupEvidence",
    schemaVersion: "1.0.0",
    targetBindingDigest: digest(targetIdentity),
    stateDigest: digest(state),
    journalSequence: state.journalSequence,
    journalHead,
    backupArtifactDigest: digest("synthetic-administrator-backup"),
    capturedAt: "2026-08-28T10:00:00Z",
    evidenceRetained: true
  };
}

function rebindConfig(
  config: InstallationConfig,
  state: InstallationState,
  manifest: ReleaseManifest,
  update: Partial<InstallationConfig> = {}
): InstallationConfig {
  return {
    ...config,
    ...update,
    target: state.target,
    releaseManifestDigest: digest(manifest),
    migrationManifestDigest: config.migrationManifestDigest,
    backupEvidenceDigest: digest(backupFor(state)),
    expectedStateDigest: digest(state),
    expectedJournalSequence: state.journalSequence,
    expectedJournalHead: null
  };
}

function historicalManifest(manifest: ReleaseManifest): ReleaseManifest {
  const content = Buffer.from("historical package payload\n");
  return {
    ...manifest,
    packageVersion: "0.0.0",
    files: [
      {
        path: "payload/historical.txt",
        type: "file",
        mode: "100644",
        size: content.byteLength,
        digest: `sha256:${createHash("sha256").update(content).digest("hex")}`
      }
    ]
  };
}

function planEnabled(): {
  readonly plan: InstallationPlan;
  readonly resultState: InstallationState;
  readonly config: InstallationConfig;
} {
  const fixture = example();
  const backup = backupFor(fixture.state);
  const config = rebindConfig(fixture.config, fixture.state, fixture.manifest, {
    apply: { enabled: true, humanChangeId: "CHANGE-1" }
  });
  const result = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: fixture.state,
    backupEvidence: backup,
    receipts: []
  });
  return {
    plan: result.plan,
    resultState: result.expectedResultState,
    config
  };
}

function authorization(
  plan: InstallationPlan,
  destructiveApproved = false,
  irreversibleApproved = false
): InstallationAuthorization {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "InstallationAuthorization",
    schemaVersion: "1.0.0",
    planDigest: plan.planDigest,
    configurationDigest: plan.configurationDigest,
    migrationManifestDigest: plan.migrationManifestDigest,
    releaseHeadSha: plan.releaseSource.headSha,
    targetBindingDigest: plan.targetBindingDigest,
    expectedHeadSha: plan.target.expectedHeadSha,
    expectedResultHeadSha: plan.expectedResultHeadSha,
    expectedStateDigest: plan.expectedStateDigest,
    idempotencyKey: plan.idempotencyKey,
    operation: plan.operation,
    humanChangeId: plan.humanChangeId ?? "CHANGE-1",
    approverDigest: digest("human-approver"),
    destructiveApproved,
    irreversibleApproved,
    approvedAt: "2026-08-28T10:00:00Z",
    expiresAt: "2026-08-28T11:00:00Z",
    signature: {
      keyId: "trusted-installer:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
}

function rehashPlan(
  plan: InstallationPlan,
  update: Partial<InstallationPlan>
): InstallationPlan {
  const changed = { ...plan, ...update };
  const idempotencyKey = digest({
    operation: changed.operation,
    releaseManifestDigest: changed.releaseManifestDigest,
    migrationManifestDigest: changed.migrationManifestDigest,
    releaseSource: changed.releaseSource,
    targetBindingDigest: changed.targetBindingDigest,
    configurationDigest: changed.configurationDigest,
    requiredPreconditions: changed.requiredPreconditions,
    migrationSteps: changed.migrationSteps,
    expectedStateDigest: changed.expectedStateDigest,
    expectedResultStateDigest: changed.expectedResultStateDigest,
    expectedResultHeadSha: changed.expectedResultHeadSha,
    actions: changed.actions,
    retainedEvidencePaths: changed.retainedEvidencePaths,
    nextJournalSequence: changed.expectedJournalSequence + 1
  });
  const { planDigest: _planDigest, ...unsigned } = {
    ...changed,
    idempotencyKey
  };
  return {
    ...unsigned,
    planDigest: digest(unsigned)
  };
}

function receipt(plan: InstallationPlan): InstallationReceipt {
  return {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "InstallationReceipt",
    schemaVersion: "1.0.0",
    sequence: plan.expectedJournalSequence + 1,
    previousReceiptDigest: plan.expectedJournalHead,
    planDigest: plan.planDigest,
    targetBindingDigest: plan.targetBindingDigest,
    idempotencyKey: plan.idempotencyKey,
    operation: plan.operation,
    expectedStateDigest: plan.expectedStateDigest,
    resultStateDigest: plan.expectedResultStateDigest,
    appliedHeadSha: plan.expectedResultHeadSha,
    status: "applied",
    evidenceRetained: true,
    appliedAt: "2026-08-28T10:30:00Z",
    signature: {
      keyId: "trusted-installer:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
}

class FakeAdapter implements TrustedInstallationAdapter {
  readonly adapterId = "trusted-installer:test";
  state: InstallationState;
  existing: InstallationReceipt | null = null;
  authorize = true;
  receiptValid = true;
  validationValid = true;
  applyCalls = 0;
  failApply = false;
  persistReceipt = true;
  currentTime = "2026-08-28T10:30:00Z";
  advanceTimeAfterObserve: string | null = null;
  verifiedChangeIds: string[] = [];
  appliedChangeIds: string[] = [];
  appliedPaths: string[][] = [];
  appliedAuthorizationChecks: string[] = [];
  readonly resultState: InstallationState;

  constructor(state: InstallationState, resultState: InstallationState) {
    this.state = structuredClone(state);
    this.resultState = structuredClone(resultState);
  }

  async now(): Promise<string> {
    return this.currentTime;
  }

  async observe(target: InstallationPlan["target"]): Promise<InstallationState> {
    if (target.expectedHeadSha !== this.state.target.expectedHeadSha) {
      throw new TypeError("synthetic adapter observed the wrong expected head");
    }
    const observed = structuredClone(this.state);
    if (this.advanceTimeAfterObserve !== null) {
      this.currentTime = this.advanceTimeAfterObserve;
      this.advanceTimeAfterObserve = null;
    }
    return observed;
  }

  async findReceipt(): Promise<InstallationReceipt | null> {
    return this.existing;
  }

  async verifyAuthorization(input: {
    readonly authorization: InstallationAuthorization;
  }): Promise<boolean> {
    this.verifiedChangeIds.push(input.authorization.humanChangeId);
    return this.authorize;
  }

  async verifyReceipt(): Promise<boolean> {
    return this.receiptValid;
  }

  async attestValidation(input: {
    readonly plan: InstallationPlan;
    readonly authorization: InstallationAuthorization;
    readonly observedState: InstallationState;
    readonly validatedAt: string;
  }): Promise<InstallationLiveValidation> {
    return {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "InstallationLiveValidation",
      schemaVersion: "1.0.0",
      mode: "live-read-only",
      adapterId: this.adapterId,
      planDigest: input.plan.planDigest,
      authorizationDigest: digest(input.authorization),
      targetBindingDigest: input.plan.targetBindingDigest,
      expectedStateDigest: input.plan.expectedStateDigest,
      observedStateDigest: digest(input.observedState),
      expectedHeadSha: input.plan.target.expectedHeadSha,
      observedHeadSha: input.observedState.target.expectedHeadSha,
      validatedAt: input.validatedAt,
      signature: {
        keyId: "trusted-installer:key-1",
        algorithm: "ed25519",
        value: "c2lnbmF0dXJl"
      }
    };
  }

  async verifyValidation(): Promise<boolean> {
    return this.validationValid;
  }

  async apply(input: {
    readonly plan: InstallationPlan;
    readonly authorization: InstallationAuthorization;
    readonly authorizationCheckedAt: string;
  }): Promise<InstallationReceipt> {
    this.applyCalls += 1;
    this.appliedChangeIds.push(input.authorization.humanChangeId);
    this.appliedPaths.push(input.plan.actions.map((action) => action.path));
    this.appliedAuthorizationChecks.push(input.authorizationCheckedAt);
    if (this.failApply) throw new TypeError("synthetic lost acknowledgement");
    this.state = structuredClone(this.resultState);
    const applied = receipt(input.plan);
    if (this.persistReceipt) this.existing = applied;
    return applied;
  }
}

test("example installation plans deterministically and remains disabled", () => {
  const fixture = example();
  const first = planInstallation({
    config: fixture.config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: fixture.state,
    backupEvidence: fixture.backup,
    receipts: []
  });

  const second = planInstallation({
    config: structuredClone(fixture.config),
    releaseManifest: structuredClone(fixture.manifest),
    migrationManifest: structuredClone(fixture.migrations),
    currentState: structuredClone(fixture.state),
    backupEvidence: structuredClone(fixture.backup),
    receipts: []
  });
  assert.deepEqual(first, second);
  assert.equal(first.plan.mode, "plan");
  assert.equal(first.plan.applyRequested, false);
  assert.notEqual(
    first.plan.releaseSource.headSha,
    first.plan.target.expectedHeadSha
  );
  assert.equal(first.plan.target.expectedHeadSha, "c".repeat(40));
  assert.equal(first.plan.expectedResultHeadSha, "d".repeat(40));
  assert.equal(
    first.expectedResultState.target.expectedHeadSha,
    first.plan.expectedResultHeadSha
  );
  assert.deepEqual(first.plan.migrationPath, ["package-0-0-0-to-0-1-0"]);
  assert.equal(first.plan.actions[0]?.type, "write-package-file");
  assert.ok(
    first.expectedResultState.evidencePaths.includes(
      "evidence/backups/pre-install.json"
    )
  );
  const { planDigest: _planDigest, ...payload } = first.plan;
  assert.equal(first.plan.planDigest, digest(payload));
});

test("planner snapshots accessor-backed configuration and manifest inputs once", () => {
  const fixture = example();
  let operationReads = 0;
  const config = {
    ...fixture.config,
    get operation(): InstallationConfig["operation"] {
      operationReads += 1;
      return operationReads === 1 ? "install" : "uninstall";
    }
  };
  let fileReads = 0;
  const manifest = {
    ...fixture.manifest,
    get files(): ReleaseManifest["files"] {
      fileReads += 1;
      return fileReads === 1
        ? fixture.manifest.files
        : [{ ...fixture.manifest.files[0]!, path: "../evil" }];
    }
  };
  const result = planInstallation({
    config,
    releaseManifest: manifest,
    migrationManifest: fixture.migrations,
    currentState: fixture.state,
    backupEvidence: fixture.backup,
    receipts: []
  });
  assert.equal(result.plan.operation, "install");
  assert.equal(operationReads, 1);
  assert.equal(fileReads, 1);
});

test("planner rejects target, source, state, and manifest drift", () => {
  const fixture = example();
  const valid = {
    config: fixture.config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: fixture.state,
    backupEvidence: fixture.backup,
    receipts: []
  } as const;
  for (const mutation of [
    {
      ...valid,
      currentState: {
        ...fixture.state,
        target: { ...fixture.state.target, repositoryId: 2 }
      }
    },
    {
      ...valid,
      releaseManifest: {
        ...fixture.manifest,
        source: { ...fixture.manifest.source, headSha: "c".repeat(40) }
      }
    },
    {
      ...valid,
      currentState: { ...fixture.state, journalSequence: 1 }
    },
    {
      ...valid,
      releaseManifest: {
        ...fixture.manifest,
        files: [
          {
            ...fixture.manifest.files[0]!,
            path: "../escape"
          }
        ]
      }
    }
  ]) {
    assert.throws(() => planInstallation(mutation));
  }
});

test("migration manifest rejects checksum, skipped, unknown, and irreversible rollback", () => {
  const fixture = example();
  const step = fixture.migrations.steps[0]!;
  assert.throws(
    () =>
      validateMigrationManifest({
        ...fixture.migrations,
        steps: [{ ...step, checksum: digest("wrong") }]
      }),
    /checksum/
  );
  const duplicateTarget = {
    ...step,
    id: "package-0-0-5-to-0-1-0",
    from: "0.0.5"
  };
  const { checksum: _duplicateChecksum, ...unsignedDuplicate } = duplicateTarget;
  assert.throws(
    () =>
      validateMigrationManifest({
        ...fixture.migrations,
        steps: [
          step,
          {
            ...duplicateTarget,
            checksum: migrationStepChecksum(unsignedDuplicate)
          }
        ]
      }),
    /target versions/
  );
  const beyondCurrent = {
    ...step,
    id: "package-0-1-0-to-0-2-0",
    from: "0.1.0",
    to: "0.2.0"
  };
  const { checksum: _beyondChecksum, ...unsignedBeyond } = beyondCurrent;
  assert.throws(
    () =>
      validateMigrationManifest({
        ...fixture.migrations,
        steps: [
          step,
          {
            ...beyondCurrent,
            checksum: migrationStepChecksum(unsignedBeyond)
          }
        ]
      }),
    /terminating at currentVersion/
  );
  const enormousDescending = {
    ...step,
    id: "enormous-descending-version",
    from: `${"9".repeat(400)}.0.0`,
    to: "1.0.0"
  };
  const { checksum: _enormousChecksum, ...unsignedEnormous } =
    enormousDescending;
  assert.throws(
    () =>
      validateMigrationManifest({
        ...fixture.migrations,
        currentVersion: "1.0.0",
        steps: [
          {
            ...enormousDescending,
            checksum: migrationStepChecksum(unsignedEnormous)
          }
        ]
      }),
    /validation failed/
  );
  const preciseAscending = {
    ...step,
    id: "precise-large-version",
    from: "9007199254740992.0.0",
    to: "9007199254740993.0.0"
  };
  const { checksum: _preciseChecksum, ...unsignedPrecise } = preciseAscending;
  assert.doesNotThrow(() =>
    validateMigrationManifest({
      ...fixture.migrations,
      currentVersion: preciseAscending.to,
      steps: [
        {
          ...preciseAscending,
          checksum: migrationStepChecksum(unsignedPrecise)
        }
      ]
    })
  );
  const skippedStep = {
    ...step,
    id: "package-0-0-0-to-0-2-0",
    to: "0.2.0"
  };
  const { checksum: _checksum, ...unsignedSkipped } = skippedStep;
  const skippedManifest: MigrationManifest = {
    ...fixture.migrations,
    currentVersion: "0.2.0",
    steps: [
      {
        ...skippedStep,
        checksum: migrationStepChecksum(unsignedSkipped)
      }
    ]
  };
  assert.throws(
    () =>
      planInstallation({
        config: {
          ...fixture.config,
          migrationManifestDigest: digest(skippedManifest)
        },
        releaseManifest: fixture.manifest,
        migrationManifest: skippedManifest,
        currentState: fixture.state,
        backupEvidence: fixture.backup,
        receipts: []
      }),
    /closed migration graph|selected operation/
  );
  const irreversible = {
    ...step,
    irreversible: true,
    rollback: { supported: false, humanApprovalRequired: true as const }
  };
  const { checksum: _old, ...unsigned } = irreversible;
  const manifest: MigrationManifest = {
    ...fixture.migrations,
    steps: [{ ...irreversible, checksum: migrationStepChecksum(unsigned) }]
  };
  const installedState: InstallationState = {
    ...fixture.state,
    packageVersion: "0.1.0",
    files: fixture.manifest.files
  };
  const rollbackManifest = historicalManifest(fixture.manifest);
  const config = {
    ...rebindConfig(
      fixture.config,
      installedState,
      rollbackManifest,
      { operation: "rollback", packageVersion: "0.0.0" }
    ),
    migrationManifestDigest: digest(manifest)
  };
  assert.throws(
    () =>
      planInstallation({
        config,
        releaseManifest: rollbackManifest,
        migrationManifest: manifest,
        currentState: installedState,
        backupEvidence: backupFor(installedState),
        receipts: []
      }),
    /cannot be rolled back/
  );
});

test("planner enforces exact backup evidence and journal-to-state binding", () => {
  const fixture = example();
  assert.throws(
    () =>
      planInstallation({
        config: fixture.config,
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: fixture.state,
        backupEvidence: {
          ...fixture.backup,
          backupArtifactDigest: digest("substituted-backup")
        },
        receipts: []
      }),
    /backup evidence/
  );

  const initial = planEnabled();
  const firstReceipt = receipt(initial.plan);
  const tamperedReceipt = {
    ...firstReceipt,
    resultStateDigest: digest("wrong-terminal-state")
  };
  const head = receiptDigest(tamperedReceipt);
  const backup = backupFor(initial.resultState, head);
  const config: InstallationConfig = {
    ...rebindConfig(
      initial.config,
      initial.resultState,
      example().manifest,
      { operation: "uninstall", packageVersion: null }
    ),
    expectedJournalHead: head,
    backupEvidenceDigest: digest(backup)
  };
  assert.throws(
    () =>
      planInstallation({
        config,
        releaseManifest: example().manifest,
        migrationManifest: example().migrations,
        currentState: initial.resultState,
        backupEvidence: backup,
        receipts: [tamperedReceipt]
      }),
    /trusted receipt verifier/
  );
  assert.throws(
    () =>
      planInstallation({
        config,
        releaseManifest: example().manifest,
        migrationManifest: example().migrations,
        currentState: initial.resultState,
        backupEvidence: backup,
        receipts: [tamperedReceipt],
        receiptVerifier: { verify: () => true }
      }),
    /terminal receipt/
  );
  const unrelatedReceipt = {
    ...firstReceipt,
    targetBindingDigest: digest("unrelated-target")
  };
  const unrelatedHead = receiptDigest(unrelatedReceipt);
  const unrelatedBackup = backupFor(initial.resultState, unrelatedHead);
  assert.throws(
    () =>
      planInstallation({
        config: {
          ...config,
          expectedJournalHead: unrelatedHead,
          backupEvidenceDigest: digest(unrelatedBackup)
        },
        releaseManifest: example().manifest,
        migrationManifest: example().migrations,
        currentState: initial.resultState,
        backupEvidence: unrelatedBackup,
        receipts: [unrelatedReceipt],
        receiptVerifier: { verify: () => true }
      }),
    /signature, target, or state continuity/
  );
  const wrongHeadReceipt = {
    ...firstReceipt,
    appliedHeadSha: "e".repeat(40)
  };
  const wrongHead = receiptDigest(wrongHeadReceipt);
  const wrongHeadBackup = backupFor(initial.resultState, wrongHead);
  assert.throws(
    () =>
      planInstallation({
        config: {
          ...config,
          expectedJournalHead: wrongHead,
          backupEvidenceDigest: digest(wrongHeadBackup)
        },
        releaseManifest: example().manifest,
        migrationManifest: example().migrations,
        currentState: initial.resultState,
        backupEvidence: wrongHeadBackup,
        receipts: [wrongHeadReceipt],
        receiptVerifier: { verify: () => true }
      }),
    /terminal receipt head/
  );
});

test("planner authenticates one receipt snapshot despite changing array length", () => {
  const initial = planEnabled();
  const forgedReceipt: InstallationReceipt = {
    ...receipt(initial.plan),
    targetBindingDigest: digest("forged-target"),
    expectedStateDigest: digest("forged-before-state"),
    resultStateDigest: digest("forged-after-state"),
    appliedHeadSha: "e".repeat(40),
    signature: {
      keyId: "forged:key",
      algorithm: "ed25519",
      value: "Zm9yZ2Vk"
    }
  };
  const forgedHead = receiptDigest(forgedReceipt);
  const backup = backupFor(initial.resultState, forgedHead);
  const config: InstallationConfig = {
    ...rebindConfig(
      initial.config,
      initial.resultState,
      example().manifest,
      { operation: "uninstall", packageVersion: null }
    ),
    expectedJournalHead: forgedHead,
    backupEvidenceDigest: digest(backup)
  };
  let lengthReads = 0;
  let elementReads = 0;
  const receipts = new Proxy([forgedReceipt], {
    get(target, property, receiver) {
      if (property === "length") {
        lengthReads += 1;
        return lengthReads === 2 ? 0 : Reflect.get(target, property, receiver);
      }
      if (property === "0") elementReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () =>
      planInstallation({
        config,
        releaseManifest: example().manifest,
        migrationManifest: example().migrations,
        currentState: initial.resultState,
        backupEvidence: backup,
        receipts
      }),
    /trusted receipt verifier/
  );
  assert.equal(lengthReads, 1);
  assert.equal(elementReads, 1);
});

test("planner snapshots bindings before receipt element getters can rewrite input", () => {
  const initial = planEnabled();
  const signedReceipt = receipt(initial.plan);
  const signedHead = receiptDigest(signedReceipt);
  const wrongHead = digest("wrong-journal-head");
  const wrongBackup = backupFor(initial.resultState, wrongHead);
  const signedBackup = backupFor(initial.resultState, signedHead);
  const baseConfig = rebindConfig(
    initial.config,
    initial.resultState,
    example().manifest,
    { operation: "uninstall", packageVersion: null }
  );
  const wrongConfig: InstallationConfig = {
    ...baseConfig,
    expectedJournalHead: wrongHead,
    backupEvidenceDigest: digest(wrongBackup)
  };
  const signedConfig: InstallationConfig = {
    ...baseConfig,
    expectedJournalHead: signedHead,
    backupEvidenceDigest: digest(signedBackup)
  };
  const plannerInput = {
    config: wrongConfig as unknown,
    releaseManifest: example().manifest as unknown,
    migrationManifest: example().migrations as unknown,
    currentState: initial.resultState as unknown,
    backupEvidence: wrongBackup as unknown,
    receipts: [] as readonly InstallationReceipt[],
    receiptVerifier: { verify: () => true }
  };
  let elementReads = 0;
  plannerInput.receipts = new Proxy([signedReceipt], {
    get(target, property, receiver) {
      if (property === "0") {
        elementReads += 1;
        plannerInput.config = signedConfig;
        plannerInput.backupEvidence = signedBackup;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => planInstallation(plannerInput),
    /configured CAS head/
  );
  assert.equal(elementReads, 1);
});

test("authenticated journal validation isolates receipt getters and verifier mutation", () => {
  const initial = planEnabled();
  const signedReceipt = receipt(initial.plan);
  let targetReads = 0;
  const accessorReceipt = {
    ...signedReceipt,
    get targetBindingDigest(): InstallationReceipt["targetBindingDigest"] {
      targetReads += 1;
      return targetReads === 1
        ? signedReceipt.targetBindingDigest
        : digest("forged-target");
    }
  };
  let lengthReads = 0;
  let elementReads = 0;
  const receipts = new Proxy([accessorReceipt], {
    get(target, property, receiver) {
      if (property === "length") lengthReads += 1;
      if (property === "0") elementReads += 1;
      return Reflect.get(target, property, receiver);
    }
  });
  let verifierCalls = 0;
  const validated = validateAuthenticatedInstallationJournal({
    receipts,
    expectedSequence: 1,
    expectedHead: receiptDigest(signedReceipt),
    expectedTargetBindingDigest: signedReceipt.targetBindingDigest,
    expectedStateDigest: signedReceipt.resultStateDigest,
    expectedObservedHeadSha: signedReceipt.appliedHeadSha,
    verifier: {
      verify(candidate) {
        verifierCalls += 1;
        (
          candidate as {
            targetBindingDigest: InstallationReceipt["targetBindingDigest"];
          }
        ).targetBindingDigest = digest("mutated-verifier-copy");
        return true;
      }
    }
  });
  assert.equal(validated[0]?.targetBindingDigest, signedReceipt.targetBindingDigest);
  assert.equal(targetReads, 1);
  assert.equal(lengthReads, 1);
  assert.equal(elementReads, 1);
  assert.equal(verifierCalls, 2);
});

test("authenticated journal captures expected bindings before receipt getters", () => {
  const initial = planEnabled();
  const signedReceipt = receipt(initial.plan);
  const forgedReceipt: InstallationReceipt = {
    ...signedReceipt,
    targetBindingDigest: digest("forged-target"),
    expectedStateDigest: digest("forged-before"),
    resultStateDigest: digest("forged-after"),
    appliedHeadSha: "e".repeat(40)
  };
  const envelope = {
    receipts: [] as readonly InstallationReceipt[],
    expectedSequence: 1,
    expectedHead: receiptDigest(signedReceipt),
    expectedTargetBindingDigest: signedReceipt.targetBindingDigest,
    expectedStateDigest: signedReceipt.resultStateDigest,
    expectedObservedHeadSha: signedReceipt.appliedHeadSha,
    verifier: { verify: () => true }
  };
  let elementReads = 0;
  envelope.receipts = new Proxy([forgedReceipt], {
    get(target, property, receiver) {
      if (property === "0") {
        elementReads += 1;
        envelope.expectedHead = receiptDigest(forgedReceipt);
        envelope.expectedTargetBindingDigest = forgedReceipt.targetBindingDigest;
        envelope.expectedStateDigest = forgedReceipt.resultStateDigest;
        envelope.expectedObservedHeadSha = forgedReceipt.appliedHeadSha;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => validateAuthenticatedInstallationJournal(envelope),
    /configured CAS head/
  );
  assert.equal(elementReads, 1);
});

test("rollback and uninstall are explicit, bounded, and evidence preserving", () => {
  const fixture = example();
  const installedState: InstallationState = {
    ...fixture.state,
    packageVersion: "0.1.0",
    files: fixture.manifest.files
  };
  const oldManifest = historicalManifest(fixture.manifest);
  const rollbackConfig = rebindConfig(
    fixture.config,
    installedState,
    oldManifest,
    { operation: "rollback", packageVersion: "0.0.0" }
  );
  const rollback = planInstallation({
    config: rollbackConfig,
    releaseManifest: oldManifest,
    migrationManifest: fixture.migrations,
    currentState: installedState,
    backupEvidence: backupFor(installedState),
    receipts: []
  });
  assert.deepEqual(rollback.plan.migrationPath, [
    "rollback:package-0-0-0-to-0-1-0"
  ]);
  assert.ok(
    rollback.plan.actions.some(
      (action) => action.type === "remove-package-file"
    )
  );
  assert.deepEqual(
    rollback.expectedResultState.evidencePaths,
    [...rollback.expectedResultState.evidencePaths].sort()
  );

  const uninstallConfig = rebindConfig(
    fixture.config,
    installedState,
    fixture.manifest,
    { operation: "uninstall", packageVersion: null }
  );
  const uninstall = planInstallation({
    config: uninstallConfig,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: installedState,
    backupEvidence: backupFor(installedState),
    receipts: []
  });
  assert.equal(uninstall.expectedResultState.packageVersion, null);
  assert.deepEqual(uninstall.expectedResultState.files, []);
  assert.ok(
    uninstall.plan.actions.every(
      (action) =>
        action.type === "remove-package-file" &&
        action.path === "payload/example.txt" &&
        action.requiresHumanApproval
    )
  );
});

test("partial and ambiguous states fail closed outside explicit recovery", () => {
  const fixture = example();
  for (const status of ["partial", "ambiguous"] as const) {
    const state = { ...fixture.state, status };
    const config = rebindConfig(fixture.config, state, fixture.manifest);
    assert.throws(
      () =>
        planInstallation({
          config,
          releaseManifest: fixture.manifest,
          migrationManifest: fixture.migrations,
          currentState: state,
          backupEvidence: backupFor(state),
          receipts: []
        }),
      /recovery/
    );
  }
  const partial = { ...fixture.state, status: "partial" as const };
  const recoveryConfig = rebindConfig(fixture.config, partial, fixture.manifest, {
    operation: "recover",
    recoveryBaseStateDigest: digest(fixture.state)
  });
  const recovery = planInstallation({
    config: recoveryConfig,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: partial,
    backupEvidence: backupFor(partial),
    recoveryBaseState: fixture.state,
    receipts: []
  });
  assert.ok(
    recovery.plan.actions.every(
      (action) => action.type === "reconcile-package-file"
    )
  );
});

test("journaled partial recovery binds the last completed stable state", () => {
  const fixture = example();
  const initial = planEnabled();
  const completedReceipt = receipt(initial.plan);
  const receiptHead = receiptDigest(completedReceipt);
  const partial: InstallationState = {
    ...initial.resultState,
    status: "partial"
  };
  const backup = backupFor(partial, receiptHead);
  const config: InstallationConfig = {
    ...rebindConfig(initial.config, partial, fixture.manifest, {
      operation: "recover",
      recoveryBaseStateDigest: digest(initial.resultState)
    }),
    expectedJournalHead: receiptHead,
    backupEvidenceDigest: digest(backup)
  };
  const recovery = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: partial,
    backupEvidence: backup,
    recoveryBaseState: initial.resultState,
    receipts: [completedReceipt],
    receiptVerifier: { verify: () => true }
  });
  assert.equal(recovery.plan.operation, "recover");
  assert.equal(recovery.expectedResultState.status, "stable");
});

test("recovery can remove stale package-owned inventory with explicit approval", () => {
  const fixture = example();
  const initial = planEnabled();
  const completedReceipt = receipt(initial.plan);
  const receiptHead = receiptDigest(completedReceipt);
  const staleFile: ReleaseFile = {
    path: "stale-package-file.txt",
    type: "file",
    mode: "100644",
    size: 5,
    digest: digest("stale")
  };
  const partial: InstallationState = {
    ...initial.resultState,
    status: "partial",
    files: [...initial.resultState.files, staleFile]
  };
  const backup = backupFor(partial, receiptHead);
  const config: InstallationConfig = {
    ...rebindConfig(initial.config, partial, fixture.manifest, {
      operation: "recover",
      recoveryBaseStateDigest: digest(initial.resultState),
      expectedResultHeadSha: "e".repeat(40)
    }),
    expectedJournalHead: receiptHead,
    backupEvidenceDigest: digest(backup)
  };
  const recovery = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: partial,
    backupEvidence: backup,
    recoveryBaseState: initial.resultState,
    receipts: [completedReceipt],
    receiptVerifier: { verify: () => true }
  });
  assert.deepEqual(
    recovery.plan.actions.map((action) => action.type),
    ["remove-package-file"]
  );
  assert.equal(recovery.plan.actions[0]?.path, staleFile.path);
});

test("recovery derives irreversible migrations from the stable base", async () => {
  const fixture = example();
  const stableBase: InstallationState = {
    ...fixture.state,
    journalSequence: 1,
    evidencePaths: [
      ...fixture.state.evidencePaths,
      "evidence/stable-state.json"
    ]
  };
  const stableTargetDigest = backupFor(stableBase).targetBindingDigest;
  const completedReceipt: InstallationReceipt = {
    apiVersion: "agentic-framework.github.com/v1alpha1",
    kind: "InstallationReceipt",
    schemaVersion: "1.0.0",
    sequence: 1,
    previousReceiptDigest: null,
    planDigest: digest("stable-plan"),
    targetBindingDigest: stableTargetDigest,
    idempotencyKey: digest("stable-idempotency"),
    operation: "install",
    expectedStateDigest: digest("pre-stable-state"),
    resultStateDigest: digest(stableBase),
    appliedHeadSha: stableBase.target.expectedHeadSha,
    status: "applied",
    evidenceRetained: true,
    appliedAt: "2026-08-28T10:00:00Z",
    signature: {
      keyId: "trusted-installer:key-1",
      algorithm: "ed25519",
      value: "c2lnbmF0dXJl"
    }
  };
  const receiptHead = receiptDigest(completedReceipt);
  const partial: InstallationState = {
    ...stableBase,
    status: "partial",
    packageVersion: "0.1.0",
    files: fixture.manifest.files,
    target: {
      ...stableBase.target,
      expectedHeadSha: fixture.config.expectedResultHeadSha
    },
    evidencePaths: ["evidence/partial-state.json"]
  };
  const step = fixture.migrations.steps[0]!;
  const irreversible = {
    ...step,
    irreversible: true,
    rollback: {
      supported: false,
      humanApprovalRequired: true as const
    }
  };
  const { checksum: _checksum, ...unsigned } = irreversible;
  const migrations: MigrationManifest = {
    ...fixture.migrations,
    steps: [
      {
        ...irreversible,
        checksum: migrationStepChecksum(unsigned)
      }
    ]
  };
  const backup = backupFor(partial, receiptHead);
  const config: InstallationConfig = {
    ...rebindConfig(fixture.config, partial, fixture.manifest, {
      operation: "recover",
      recoveryBaseStateDigest: digest(stableBase)
    }),
    migrationManifestDigest: digest(migrations),
    expectedJournalHead: receiptHead,
    backupEvidenceDigest: digest(backup)
  };
  const recovery = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: migrations,
    currentState: partial,
    backupEvidence: backup,
    recoveryBaseState: stableBase,
    receipts: [completedReceipt],
    receiptVerifier: { verify: () => true }
  });
  assert.deepEqual(recovery.plan.migrationPath, [
    "package-0-0-0-to-0-1-0"
  ]);
  assert.deepEqual(recovery.plan.irreversibleSteps, [
    "package-0-0-0-to-0-1-0"
  ]);
  assert.ok(
    recovery.plan.retainedEvidencePaths.includes("evidence/stable-state.json")
  );
  assert.ok(
    recovery.plan.retainedEvidencePaths.includes("evidence/partial-state.json")
  );
  const retainedEvidencePaths = recovery.plan.retainedEvidencePaths.filter(
    (evidencePath) => evidencePath !== "evidence/stable-state.json"
  );
  const expectedResultState = {
    ...recovery.plan.expectedResultState,
    evidencePaths: retainedEvidencePaths
  };
  const dropsStableEvidence = rehashPlan(recovery.plan, {
    retainedEvidencePaths,
    expectedResultState,
    expectedResultStateDigest: digest(expectedResultState)
  });
  const adapter = new FakeAdapter(partial, expectedResultState);
  await assert.rejects(
    applyInstallationPlan({
      plan: dropsStableEvidence,
      authorization: authorization(dropsStableEvidence),
      adapter
    }),
    /state, inventory/
  );
  assert.equal(adapter.verifiedChangeIds.length, 0);
  assert.equal(adapter.applyCalls, 0);
});

test("receipt journal rejects replay, gaps, reordering, and wrong head", () => {
  const { plan } = planEnabled();
  const first = receipt(plan);
  validateInstallationJournalStructure([first], 1, receiptDigest(first));
  assert.throws(() =>
    validateInstallationJournalStructure([first], 2, receiptDigest(first))
  );
  assert.throws(() =>
    validateInstallationJournalStructure(
      [{ ...first, sequence: 2 }],
      1,
      receiptDigest(first)
    )
  );
  assert.throws(() =>
    validateInstallationJournalStructure([first, first], 2, receiptDigest(first))
  );
  const overriddenMap = [first];
  Object.defineProperty(overriddenMap, "map", {
    value: () => [],
    enumerable: false
  });
  assert.throws(
    () => validateInstallationJournalStructure(overriddenMap, 0, null),
    /configured CAS head/
  );
});

test("receipt journal bound is enforced before journal element access or cloning", () => {
  const { plan } = planEnabled();
  const base = receipt(plan);
  const receipts: InstallationReceipt[] = [];
  let previousReceiptDigest: InstallationReceipt["previousReceiptDigest"] = null;
  let expectedStateDigest = digest("journal-genesis");
  for (let sequence = 1; sequence <= MAX_INSTALLATION_RECEIPTS; sequence += 1) {
    const next: InstallationReceipt = {
      ...base,
      sequence,
      previousReceiptDigest,
      expectedStateDigest,
      resultStateDigest: digest(`journal-state-${sequence}`)
    };
    receipts.push(next);
    previousReceiptDigest = receiptDigest(next);
    expectedStateDigest = next.resultStateDigest;
  }
  assert.equal(
    validateInstallationJournalStructure(
      receipts,
      MAX_INSTALLATION_RECEIPTS,
      previousReceiptDigest
    ).length,
    MAX_INSTALLATION_RECEIPTS
  );
  assert.equal(
    validateAuthenticatedInstallationJournal({
      receipts,
      expectedSequence: MAX_INSTALLATION_RECEIPTS,
      expectedHead: previousReceiptDigest,
      expectedTargetBindingDigest: base.targetBindingDigest,
      expectedStateDigest,
      expectedObservedHeadSha: base.appliedHeadSha,
      verifier: { verify: () => true }
    }).length,
    MAX_INSTALLATION_RECEIPTS
  );

  let oversizedElementReads = 0;
  const oversized = new Proxy(
    new Array<InstallationReceipt>(MAX_INSTALLATION_RECEIPTS + 1),
    {
      get(target, property, receiver) {
        if (property !== "length") oversizedElementReads += 1;
        return Reflect.get(target, property, receiver);
      }
    }
  );
  assert.throws(
    () =>
      validateInstallationJournalStructure(
        oversized,
        MAX_INSTALLATION_RECEIPTS + 1,
        null
      ),
    /closed receipt bound/
  );
  assert.equal(oversizedElementReads, 0);

  let coercions = 0;
  let coercibleElementReads = 0;
  const coercibleLength = new Proxy([base], {
    get(target, property, receiver) {
      if (property === "length") {
        return {
          valueOf() {
            coercions += 1;
            return coercions === 1 ? 0 : MAX_INSTALLATION_RECEIPTS + 1;
          }
        };
      }
      if (typeof property === "string" && /^\d+$/.test(property)) {
        coercibleElementReads += 1;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => validateInstallationJournalStructure(coercibleLength, 0, null),
    /length is invalid/
  );
  assert.equal(coercions, 0);
  assert.equal(coercibleElementReads, 0);

  const fixture = example();
  assert.throws(
    () =>
      planInstallation({
        config: fixture.config,
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: fixture.state,
        backupEvidence: fixture.backup,
        receipts: oversized
      }),
    /closed receipt bound/
  );
  assert.equal(oversizedElementReads, 0);
});

test("planner fails closed when the uncompacted journal reaches capacity", () => {
  const fixture = example();
  assert.throws(
    () =>
      planInstallation({
        config: {
          ...fixture.config,
          expectedJournalSequence: MAX_INSTALLATION_RECEIPTS
        },
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: fixture.state,
        backupEvidence: fixture.backup,
        receipts: []
      }),
    /external archival.*checkpoint/
  );
});

test("apply requires trusted current human authorization and exact CAS state", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  const adapter = new FakeAdapter(fixture.state, resultState);
  await assert.rejects(
    applyInstallationPlan({
      plan: { ...plan, applyRequested: false },
      authorization: authorization(plan),
      adapter
    }),
    /plan integrity|non-mutating/
  );
  adapter.authorize = false;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /rejected/
  );
  adapter.authorize = true;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: { ...authorization(plan), humanChangeId: "WRONG-CHANGE" },
      adapter
    }),
    /binding mismatch/
  );
  adapter.currentTime = "2026-08-29T10:30:00Z";
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /not current/
  );
  adapter.currentTime = "2026-08-28T10:30:00Z";
  adapter.currentTime = authorization(plan).expiresAt;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /not current/
  );
  adapter.currentTime = "2026-08-28T10:30:00Z";
  adapter.state = { ...fixture.state, journalSequence: 1 };
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /CAS/
  );
  assert.equal(adapter.applyCalls, 0);
});

test("apply rejects authorization that expires during awaited pre-effect checks", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  const adapter = new FakeAdapter(fixture.state, resultState);
  adapter.advanceTimeAfterObserve = authorization(plan).expiresAt;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /not current/
  );
  assert.equal(adapter.applyCalls, 0);
});

test("apply rejects self-rehashed plans with noncanonical action invariants", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  const action = plan.actions[0]!;
  const operationEvidencePath = plan.retainedEvidencePaths.find(
    (evidencePath) => evidencePath.startsWith("evidence/installations/")
  )!;
  const retainedWithoutOperation = plan.retainedEvidencePaths.filter(
    (evidencePath) => evidencePath !== operationEvidencePath
  );
  const resultWithoutOperationEvidence = {
    ...plan.expectedResultState,
    evidencePaths: retainedWithoutOperation
  };
  const customerFile: ReleaseFile = {
    path: "customer/data.txt",
    type: "file",
    mode: "100644",
    size: 8,
    digest: digest("customer-data")
  };
  const customerManifest: ReleaseManifest = {
    ...plan.releaseManifest,
    files: [customerFile]
  };
  const customerResultState: InstallationState = {
    ...plan.expectedResultState,
    files: [customerFile]
  };
  const malformedPlans = [
    rehashPlan(plan, { actions: [action, action] }),
    rehashPlan(plan, {
      actions: [
        { ...action, path: "z.txt" },
        { ...action, path: "a.txt" }
      ]
    }),
    rehashPlan(plan, {
      actions: [{ ...action, afterDigest: null }]
    }),
    rehashPlan(plan, {
      actions: [
        {
          ...action,
          type: "remove-package-file",
          beforeDigest: null,
          afterDigest: null
        }
      ]
    }),
    rehashPlan(plan, {
      actions: [],
      expectedResultHeadSha: plan.expectedResultHeadSha
    }),
    rehashPlan(plan, {
      operation: "recover",
      actions: [action]
    }),
    rehashPlan(plan, {
      actions: [{ ...action, path: "a".repeat(101) }]
    }),
    rehashPlan(plan, {
      retainedEvidencePaths: [action.path, ...plan.retainedEvidencePaths].sort()
    }),
    rehashPlan(plan, {
      actions: [{ ...action, path: "evidence" }]
    }),
    rehashPlan(plan, {
      actions: [
        {
          type: "remove-package-file",
          path: "customer/data.txt",
          beforeDigest: digest("customer-data"),
          afterDigest: null,
          mode: "100644",
          requiresHumanApproval: true
        }
      ],
      retainedEvidencePaths: []
    }),
    rehashPlan(plan, {
      expectedState: {
        ...plan.expectedState,
        status: "ambiguous"
      },
      expectedStateDigest: digest({
        ...plan.expectedState,
        status: "ambiguous"
      })
    }),
    rehashPlan(plan, {
      migrationPath: [],
      migrationSteps: [],
      irreversibleSteps: []
    }),
    rehashPlan(plan, {
      retainedEvidencePaths: retainedWithoutOperation,
      expectedResultState: resultWithoutOperationEvidence,
      expectedResultStateDigest: digest(resultWithoutOperationEvidence)
    }),
    rehashPlan(plan, {
      releaseManifest: customerManifest,
      releaseManifestDigest: digest(customerManifest),
      expectedResultState: customerResultState,
      expectedResultStateDigest: digest(customerResultState),
      actions: [
        {
          type: "write-package-file",
          path: customerFile.path,
          beforeDigest: null,
          afterDigest: customerFile.digest,
          mode: customerFile.mode,
          requiresHumanApproval: true
        }
      ]
    }),
    rehashPlan(plan, {
      expectedJournalSequence: MAX_INSTALLATION_RECEIPTS
    })
  ];
  for (const malformed of malformedPlans) {
    const adapter = new FakeAdapter(fixture.state, resultState);
    await assert.rejects(
      applyInstallationPlan({
        plan: malformed,
        authorization: authorization(malformed),
        adapter
      }),
      /actions|action digest|action type|result head|canonical ustar|retained evidence|journal is at capacity|state, inventory/
    );
    assert.equal(adapter.verifiedChangeIds.length, 0);
    assert.equal(adapter.applyCalls, 0);
  }
});

test("trusted live validation binds fresh target state without mutation", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  const adapter = new FakeAdapter(fixture.state, resultState);
  const evidence = await validateLiveInstallationPlan({
    plan,
    authorization: authorization(plan),
    adapter
  });
  assert.equal(evidence.mode, "live-read-only");
  assert.equal(evidence.planDigest, plan.planDigest);
  assert.equal(evidence.observedStateDigest, plan.expectedStateDigest);
  assert.equal(validateDocument("PackagingDocument", evidence).valid, true);
  assert.equal(adapter.applyCalls, 0);

  const stale = new FakeAdapter(
    { ...fixture.state, journalSequence: 1 },
    resultState
  );
  await assert.rejects(
    validateLiveInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter: stale
    }),
    /stale target state/
  );
  assert.equal(stale.applyCalls, 0);

  const expiring = new FakeAdapter(fixture.state, resultState);
  expiring.advanceTimeAfterObserve = authorization(plan).expiresAt;
  await assert.rejects(
    validateLiveInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter: expiring
    }),
    /not current/
  );
  assert.equal(expiring.applyCalls, 0);

  const untrusted = new FakeAdapter(fixture.state, resultState);
  untrusted.validationValid = false;
  await assert.rejects(
    validateLiveInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter: untrusted
    }),
    /validation signature/
  );
  assert.equal(untrusted.applyCalls, 0);
});

test("apply performs one effect, converges by idempotency, and never retries lost acknowledgement", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  const adapter = new FakeAdapter(fixture.state, resultState);
  const applied = await applyInstallationPlan({
    plan,
    authorization: authorization(plan),
    adapter
  });
  assert.equal(adapter.applyCalls, 1);
  assert.deepEqual(adapter.appliedAuthorizationChecks, [
    "2026-08-28T10:30:00Z"
  ]);
  adapter.receiptValid = false;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    /receipt signature/
  );
  adapter.receiptValid = true;
  const repeated = await applyInstallationPlan({
    plan,
    authorization: authorization(plan),
    adapter
  });
  assert.deepEqual(repeated, applied);
  assert.equal(adapter.applyCalls, 1);
  adapter.currentTime = "2026-08-29T10:30:00Z";
  assert.deepEqual(
    await applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter
    }),
    applied
  );
  adapter.currentTime = "2026-08-28T10:30:00Z";
  assert.deepEqual(
    await reconcileInstallation({ plan, receipt: applied, adapter }),
    applied
  );
  await assert.rejects(
    reconcileInstallation({
      plan: {
        ...plan,
        migrationManifestDigest: digest("substituted-migration"),
        migrationSteps: []
      },
      receipt: applied,
      adapter
    }),
    /plan integrity/
  );
  const changedActionPayload = {
    ...plan,
    actions: [
      {
        ...plan.actions[0]!,
        path: "different.txt"
      }
    ]
  };
  const { planDigest: _changedDigest, ...unsignedChangedAction } =
    changedActionPayload;
  await assert.rejects(
    reconcileInstallation({
      plan: {
        ...unsignedChangedAction,
        planDigest: digest(unsignedChangedAction)
      },
      receipt: applied,
      adapter
    }),
    /plan integrity/
  );

  const failing = new FakeAdapter(fixture.state, resultState);
  failing.failApply = true;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter: failing
    }),
    /lost acknowledgement/
  );
  assert.equal(failing.applyCalls, 1);

  const unpersisted = new FakeAdapter(fixture.state, resultState);
  unpersisted.persistReceipt = false;
  await assert.rejects(
    applyInstallationPlan({
      plan,
      authorization: authorization(plan),
      adapter: unpersisted
    }),
    /persistence is unproven/
  );
  assert.equal(unpersisted.applyCalls, 1);
  await assert.rejects(
    reconcileInstallation({
      plan,
      receipt: receipt(plan),
      adapter: unpersisted
    }),
    /persistence is unproven/
  );
});

test("apply snapshots accessor-backed plan and authorization inputs once", async () => {
  const fixture = example();
  const { plan, resultState } = planEnabled();
  let planReads = 0;
  const accessorPlan = {
    ...plan,
    get actions(): InstallationPlan["actions"] {
      planReads += 1;
      return planReads === 1
        ? plan.actions
        : [
            {
              type: "write-package-file",
              path: "evil.txt",
              beforeDigest: null,
              afterDigest: digest("evil"),
              mode: "100644",
              requiresHumanApproval: true
            }
          ];
    }
  };
  const validAuthorization = authorization(plan);
  let authorizationReads = 0;
  const accessorAuthorization = {
    ...validAuthorization,
    get humanChangeId(): string {
      authorizationReads += 1;
      return authorizationReads === 1
        ? validAuthorization.humanChangeId
        : "UNVERIFIED-CHANGE";
    }
  };
  const adapter = new FakeAdapter(fixture.state, resultState);
  await applyInstallationPlan({
    plan: accessorPlan,
    authorization: accessorAuthorization,
    adapter
  });
  assert.equal(planReads, 1);
  assert.equal(authorizationReads, 1);
  assert.deepEqual(adapter.verifiedChangeIds, ["CHANGE-1", "CHANGE-1"]);
  assert.deepEqual(adapter.appliedChangeIds, ["CHANGE-1"]);
  assert.deepEqual(adapter.appliedPaths, [["payload/example.txt"]]);

  const signedReceipt = receipt(plan);
  let receiptReads = 0;
  const accessorReceipt = {
    ...signedReceipt,
    get resultStateDigest(): InstallationReceipt["resultStateDigest"] {
      receiptReads += 1;
      return receiptReads === 1
        ? signedReceipt.resultStateDigest
        : digest("unverified-result-state");
    }
  };
  const cached = new FakeAdapter(resultState, resultState);
  cached.existing = accessorReceipt;
  await applyInstallationPlan({
    plan,
    authorization: validAuthorization,
    adapter: cached
  });
  assert.equal(receiptReads, 1);
  assert.equal(cached.applyCalls, 0);
});

test("destructive removal requires a separate explicit authorization bit", async () => {
  const fixture = example();
  const installedState: InstallationState = {
    ...fixture.state,
    packageVersion: "0.1.0",
    files: fixture.manifest.files
  };
  const config = rebindConfig(fixture.config, installedState, fixture.manifest, {
    operation: "uninstall",
    packageVersion: null,
    apply: { enabled: true, humanChangeId: "CHANGE-DELETE" }
  });

  const result = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: fixture.migrations,
    currentState: installedState,
    backupEvidence: backupFor(installedState),
    receipts: []
  });
  const adapter = new FakeAdapter(installedState, result.expectedResultState);
  await assert.rejects(
    applyInstallationPlan({
      plan: result.plan,
      authorization: authorization(result.plan, false),
      adapter
    }),
    /destructive/
  );
  assert.equal(adapter.applyCalls, 0);
});

test("uninstall requires a known installed version and matching manifest", () => {
  const fixture = example();
  const unknownState: InstallationState = {
    ...fixture.state,
    packageVersion: "9.9.9",
    files: fixture.manifest.files
  };
  const unknownConfig = rebindConfig(
    fixture.config,
    unknownState,
    fixture.manifest,
    { operation: "uninstall", packageVersion: null }
  );
  assert.throws(
    () =>
      planInstallation({
        config: unknownConfig,
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: unknownState,
        backupEvidence: backupFor(unknownState),
        receipts: []
      }),
    /installed version/
  );

  const installedState: InstallationState = {
    ...fixture.state,
    packageVersion: "0.1.0",
    files: fixture.manifest.files
  };
  const mismatchedManifest = historicalManifest(fixture.manifest);
  const mismatchedConfig = rebindConfig(
    fixture.config,
    installedState,
    mismatchedManifest,
    { operation: "uninstall", packageVersion: null }
  );
  assert.throws(
    () =>
      planInstallation({
        config: mismatchedConfig,
        releaseManifest: mismatchedManifest,
        migrationManifest: fixture.migrations,
        currentState: installedState,
        backupEvidence: backupFor(installedState),
        receipts: []
      }),
    /uninstall manifest/
  );
  const customerFile = {
    path: "customer-owned.txt",
    type: "file" as const,
    mode: "100644" as const,
    size: 8,
    digest: digest("customer")
  };
  const customerState: InstallationState = {
    ...installedState,
    files: [customerFile]
  };
  const customerConfig = rebindConfig(
    fixture.config,
    customerState,
    fixture.manifest,
    { operation: "uninstall", packageVersion: null }
  );
  assert.throws(
    () =>
      planInstallation({
        config: customerConfig,
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: customerState,
        backupEvidence: backupFor(customerState),
        receipts: []
      }),
    /uninstall inventory/
  );
});

test("planner prevents package actions from changing retained evidence", () => {
  const fixture = example();
  const installedState: InstallationState = {
    ...fixture.state,
    packageVersion: "0.1.0",
    files: fixture.manifest.files,
    evidencePaths: [
      ...fixture.state.evidencePaths,
      fixture.manifest.files[0]!.path
    ].sort()
  };
  const config = rebindConfig(
    fixture.config,
    installedState,
    fixture.manifest,
    { operation: "uninstall", packageVersion: null }
  );
  assert.throws(
    () =>
      planInstallation({
        config,
        releaseManifest: fixture.manifest,
        migrationManifest: fixture.migrations,
        currentState: installedState,
        backupEvidence: backupFor(installedState),
        receipts: []
      }),
    /retained evidence/
  );

  for (const actionPath of [
    "evidence",
    "evidence/backups/pre-install.json/child"
  ]) {
    const conflictingManifest: ReleaseManifest = {
      ...fixture.manifest,
      files: [
        {
          ...fixture.manifest.files[0]!,
          path: actionPath
        }
      ]
    };
    const conflictingConfig = rebindConfig(
      fixture.config,
      fixture.state,
      conflictingManifest
    );
    assert.throws(
      () =>
        planInstallation({
          config: conflictingConfig,
          releaseManifest: conflictingManifest,
          migrationManifest: fixture.migrations,
          currentState: fixture.state,
          backupEvidence: backupFor(fixture.state),
          receipts: []
        }),
      /overlap retained evidence/
    );
  }
});

test("irreversible migration requires a separate explicit authorization bit", async () => {
  const fixture = example();
  const original = fixture.migrations.steps[0]!;
  const irreversible = {
    ...original,
    irreversible: true,
    rollback: {
      supported: false,
      humanApprovalRequired: true as const
    }
  };
  const { checksum: _checksum, ...unsigned } = irreversible;
  const migrations: MigrationManifest = {
    ...fixture.migrations,
    steps: [
      {
        ...irreversible,
        checksum: migrationStepChecksum(unsigned)
      }
    ]
  };
  const backup = backupFor(fixture.state);
  const config = {
    ...rebindConfig(fixture.config, fixture.state, fixture.manifest, {
      apply: { enabled: true, humanChangeId: "CHANGE-IRREVERSIBLE" }
    }),
    migrationManifestDigest: digest(migrations)
  };
  const result = planInstallation({
    config,
    releaseManifest: fixture.manifest,
    migrationManifest: migrations,
    currentState: fixture.state,
    backupEvidence: backup,
    receipts: []
  });
  assert.deepEqual(result.plan.irreversibleSteps, [
    "package-0-0-0-to-0-1-0"
  ]);
  const adapter = new FakeAdapter(fixture.state, result.expectedResultState);
  await assert.rejects(
    applyInstallationPlan({
      plan: result.plan,
      authorization: authorization(result.plan, false, false),
      adapter
    }),
    /irreversible/
  );
  assert.equal(adapter.applyCalls, 0);
  await applyInstallationPlan({
    plan: result.plan,
    authorization: authorization(result.plan, false, true),
    adapter
  });
  assert.equal(adapter.applyCalls, 1);
});

function tarFixture(): {
  readonly file: ReleaseFile & { readonly oid: string; readonly content: Buffer };
  readonly manifest: ReleaseManifest;
} {
  const content = Buffer.from("safe\n");
  const file = {
    path: "safe.txt",
    type: "file" as const,
    mode: "100644" as const,
    size: content.byteLength,
    digest: `sha256:${createHash("sha256").update(content).digest("hex")}` as const,
    oid: "a".repeat(40),
    content
  };
  return {
    file,
    manifest: {
      apiVersion: "agentic-framework.github.com/v1alpha1",
      kind: "ReleaseManifest",
      schemaVersion: "1.0.0",
      packageName: "agentic-framework",
      packageVersion: "0.1.0",
      source: {
        server: "github.com",
        repository: "example-organization/hyperfinite",
        baseSha: "b".repeat(40),
        headSha: "a".repeat(40),
        sourceDateEpoch: 0
      },
      dependencyLockDigest: digest("lock"),
      licenseDigest: digest("license"),
      noticesDigest: digest("notices"),
      files: [
        {
          path: file.path,
          type: file.type,
          mode: file.mode,
          size: file.size,
          digest: file.digest
        }
      ]
    }
  };
}

function recalculateTarChecksum(archive: Buffer): void {
  archive.fill(0x20, 148, 156);
  const sum = archive
    .subarray(0, 512)
    .reduce((total, byte) => total + byte, 0);
  archive.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

test("release paths enforce canonical UTF-8 ustar boundaries before packaging", () => {
  const ascii100 = "a".repeat(100);
  const ascii101 = "a".repeat(101);
  const multibyte100 = "é".repeat(50);
  const multibyte101 = `${multibyte100}a`;
  const splittableLong = `${"p".repeat(120)}/${"n".repeat(100)}`;
  const unsplittableLong = `dir/${"n".repeat(101)}`;
  const prefix155 = `${"p".repeat(147)}/n`;
  const prefix156 = `${"p".repeat(148)}/n`;
  const multibytePrefix155 = `${"é".repeat(73)}a/n`;
  const multibytePrefix156 = `${"é".repeat(74)}/n`;
  const overall224 = `${"p".repeat(123)}/${"n".repeat(100)}`;

  for (const releasePath of [
    ascii100,
    multibyte100,
    splittableLong,
    prefix155,
    multibytePrefix155,
    overall224,
    "café.txt"
  ]) {
    assert.doesNotThrow(() => assertReleasePath(releasePath), releasePath);
  }
  for (const releasePath of [
    ascii101,
    multibyte101,
    unsplittableLong,
    prefix156,
    multibytePrefix156,
    `${overall224}x`,
    "cafe\u0301.txt",
    "control/\u001f.txt",
    "line\u2028separator.txt",
    "paragraph\u2029separator.txt",
    "payload/.git/config"
  ]) {
    assert.throws(
      () => assertReleasePath(releasePath),
      /canonical|denied|ustar/,
      releasePath
    );
  }
  assert.equal(
    Buffer.byteLength(
      splitCanonicalUstarPath(`payload/${prefix155}`).prefix,
      "utf8"
    ),
    155
  );
  assert.equal(
    Buffer.byteLength(
      splitCanonicalUstarPath(`payload/${multibytePrefix155}`).prefix,
      "utf8"
    ),
    155
  );
  assert.throws(
    () => splitCanonicalUstarPath(`payload/${prefix156}`),
    /canonical ustar|PackagingDocument validation/
  );
  assert.throws(
    () => splitCanonicalUstarPath(`payload/${multibytePrefix156}`),
    /canonical ustar/
  );

  const fixture = tarFixture();
  const unicodeFile = {
    ...fixture.file,
    path: multibyte100
  };
  const unicodeManifest: ReleaseManifest = {
    ...fixture.manifest,
    files: [{ ...fixture.manifest.files[0]!, path: multibyte100 }]
  };
  const unicodeArchive = createDeterministicTar([unicodeFile]);
  verifyDeterministicTar(unicodeArchive, unicodeManifest);
  const maximumLengthFile = {
    ...fixture.file,
    path: overall224
  };
  verifyDeterministicTar(
    createDeterministicTar([maximumLengthFile]),
    {
      ...fixture.manifest,
      files: [{ ...fixture.manifest.files[0]!, path: overall224 }]
    }
  );

  const semanticallyInvalidManifest: ReleaseManifest = {
    ...fixture.manifest,
    files: [{ ...fixture.manifest.files[0]!, path: ascii101 }]
  };
  assert.equal(
    validateDocument(
      "PackagingDocument",
      semanticallyInvalidManifest
    ).valid,
    false
  );
  assert.equal(
    validateDocument("PackagingDocument", {
      ...fixture.manifest,
      files: [
        {
          ...fixture.manifest.files[0]!,
          path: "cafe\u0301.txt"
        }
      ]
    }).valid,
    false
  );
  for (const validReleasePath of [
    ascii100,
    multibyte100,
    splittableLong,
    prefix155,
    multibytePrefix155,
    overall224,
    "\uFEFFunsplit.txt"
  ]) {
    assert.equal(
      validateDocument("PackagingDocument", {
        ...fixture.manifest,
        files: [
          {
            ...fixture.manifest.files[0]!,
            path: validReleasePath
          }
        ]
      }).valid,
      true,
      validReleasePath
    );
  }
  for (const invalidReleasePath of [
    ascii101,
    multibyte101,
    unsplittableLong,
    prefix156,
    multibytePrefix156,
    "cafe\u0301.txt",
    "line\u2028separator.txt",
    "paragraph\u2029separator.txt"
  ]) {
    assert.equal(
      validateDocument("PackagingDocument", {
        ...fixture.manifest,
        files: [
          {
            ...fixture.manifest.files[0]!,
            path: invalidReleasePath
          }
        ]
      }).valid,
      false,
      invalidReleasePath
    );
  }
  assert.throws(
    () =>
      createDeterministicTar([
        {
          ...fixture.file,
          path: ascii101
        }
      ]),
    /canonical ustar/
  );
  const installation = example();
  for (const lineSeparatorPath of [
    "line\u2028separator.txt",
    "paragraph\u2029separator.txt"
  ]) {
    assert.throws(
      () =>
        createDeterministicTar([
          {
            ...fixture.file,
            path: lineSeparatorPath
          }
        ]),
      /canonical/
    );
    const lineSeparatorManifest: ReleaseManifest = {
      ...installation.manifest,
      files: [
        {
          ...installation.manifest.files[0]!,
          path: lineSeparatorPath
        }
      ]
    };
    assert.throws(
      () =>
        planInstallation({
          config: {
            ...installation.config,
            releaseManifestDigest: digest(lineSeparatorManifest)
          },
          releaseManifest: lineSeparatorManifest,
          migrationManifest: installation.migrations,
          currentState: installation.state,
          backupEvidence: installation.backup,
          receipts: []
        }),
      /release path|schema validation|PackagingDocument validation/
    );
  }
  assert.throws(
    () =>
      planInstallation({
        config: {
          ...installation.config,
          releaseManifestDigest: digest(semanticallyInvalidManifest)
        },
        releaseManifest: semanticallyInvalidManifest,
        migrationManifest: installation.migrations,
        currentState: installation.state,
        backupEvidence: installation.backup,
        receipts: []
      }),
    /canonical ustar|PackagingDocument validation/
  );

  const noncanonicalFile = {
    ...fixture.file,
    path: "dir/sub/file.txt"
  };
  const noncanonicalManifest: ReleaseManifest = {
    ...fixture.manifest,
    files: [
      {
        ...fixture.manifest.files[0]!,
        path: noncanonicalFile.path
      }
    ]
  };
  const noncanonicalSplit = createDeterministicTar([noncanonicalFile]);
  noncanonicalSplit.fill(0, 0, 100);
  noncanonicalSplit.fill(0, 345, 500);
  noncanonicalSplit.write("sub/file.txt", 0, 100, "utf8");
  noncanonicalSplit.write("payload/dir", 345, 155, "utf8");
  recalculateTarChecksum(noncanonicalSplit);
  assert.throws(
    () => verifyDeterministicTar(noncanonicalSplit, noncanonicalManifest),
    /canonical ustar/
  );
});

test("release paths reject unpaired surrogates before archive bytes", () => {
  const fixture = tarFixture();
  const validArchive = createDeterministicTar([fixture.file]);
  const splitName = `${"p".repeat(110)}/split-name\uD800`;
  const splitPrefix = `${"p".repeat(109)}\uD800/split-prefix.txt`;
  const malformedPaths = [
    "trailing-high\uD800",
    "\uDC00leading-low.txt",
    "interior-high\uD800x.txt",
    "interior-low\uDC00x.txt",
    splitName,
    splitPrefix
  ];

  for (const releasePath of malformedPaths) {
    const file = { ...fixture.file, path: releasePath };
    const manifest: ReleaseManifest = {
      ...fixture.manifest,
      files: [{ ...fixture.manifest.files[0]!, path: releasePath }]
    };
    assert.throws(
      () => assertReleasePath(releasePath),
      /canonical/,
      releasePath
    );
    assert.throws(
      () => splitCanonicalUstarPath(`payload/${releasePath}`),
      /canonical/,
      releasePath
    );
    assert.equal(
      validateDocument("PackagingDocument", manifest).valid,
      false,
      releasePath
    );
    assert.throws(
      () => createDeterministicTar([file]),
      /canonical/,
      releasePath
    );
    assert.throws(
      () => verifyDeterministicTar(validArchive, manifest),
      /PackagingDocument validation|canonical/,
      releasePath
    );
  }

  const astralPath = `${"p".repeat(110)}/valid-\uD83D\uDE80.txt`;
  const astralFile = { ...fixture.file, path: astralPath };
  const astralManifest: ReleaseManifest = {
    ...fixture.manifest,
    files: [{ ...fixture.manifest.files[0]!, path: astralPath }]
  };
  assert.doesNotThrow(() => assertReleasePath(astralPath));
  assert.equal(
    validateDocument("PackagingDocument", astralManifest).valid,
    true
  );
  const astralArchive = createDeterministicTar([astralFile]);
  verifyDeterministicTar(astralArchive, astralManifest);

  const aliasFiles = [
    { ...fixture.file, path: "x\uD800" },
    { ...fixture.file, path: "x\uFFFD" }
  ];
  assert.notEqual(aliasFiles[0]!.path, aliasFiles[1]!.path);
  assert.ok(
    Buffer.from(aliasFiles[0]!.path, "utf8").equals(
      Buffer.from(aliasFiles[1]!.path, "utf8")
    )
  );
  let aliasArchive: Buffer | undefined;
  assert.throws(
    () => {
      aliasArchive = createDeterministicTar(aliasFiles);
    },
    /canonical/
  );
  assert.equal(aliasArchive, undefined);
});

test("deterministic tar preserves literal BOM code points in every ustar field", () => {
  const fixture = tarFixture();
  const paths = [
    "\uFEFFunsplit.txt",
    `\uFEFF${"p".repeat(110)}/split-prefix.txt`,
    `${"p".repeat(110)}/\uFEFFsplit-name.txt`
  ];
  for (const releasePath of paths) {
    const file = {
      ...fixture.file,
      path: releasePath
    };
    const manifest: ReleaseManifest = {
      ...fixture.manifest,
      files: [{ ...fixture.manifest.files[0]!, path: releasePath }]
    };
    const archive = createDeterministicTar([file]);
    verifyDeterministicTar(archive, manifest);
  }

  const splitNamePath = `${"p".repeat(110)}/\uFEFFsplit-name.txt`;
  const splitNameFile = { ...fixture.file, path: splitNamePath };
  const splitNameManifest: ReleaseManifest = {
    ...fixture.manifest,
    files: [{ ...fixture.manifest.files[0]!, path: splitNamePath }]
  };
  const missingBom = createDeterministicTar([splitNameFile]);
  const nameField = missingBom.subarray(0, 100);
  const encodedName = Buffer.from("\uFEFFsplit-name.txt", "utf8");
  nameField.copyWithin(0, 3, encodedName.byteLength);
  nameField.fill(0, encodedName.byteLength - 3);
  recalculateTarChecksum(missingBom);
  assert.throws(
    () => verifyDeterministicTar(missingBom, splitNameManifest),
    /canonical ustar|closed manifest/
  );

  const injectedBom = createDeterministicTar([splitNameFile]);
  const prefixField = injectedBom.subarray(345, 500);
  const prefixLength = prefixField.indexOf(0);
  assert.ok(prefixLength > 0);
  prefixField.copyWithin(3, 0, prefixLength);
  Buffer.from("\uFEFF", "utf8").copy(prefixField, 0);
  recalculateTarChecksum(injectedBom);
  assert.throws(
    () => verifyDeterministicTar(injectedBom, splitNameManifest),
    /outside payload|canonical ustar|closed manifest/
  );
});

test("deterministic tar rejects traversal, links, mode drift, tampering, and unexpected files", () => {
  const fixture = tarFixture();
  const first = createDeterministicTar([fixture.file]);
  const second = createDeterministicTar([structuredClone(fixture.file)]);
  assert.ok(first.equals(second));
  verifyDeterministicTar(first, fixture.manifest);

  const substitutedFiles = [
    {
      ...fixture.manifest.files[0]!,
      digest: digest("substituted")
    }
  ];
  Object.defineProperty(substitutedFiles, "map", {
    value: () => fixture.manifest.files,
    enumerable: false
  });
  assert.throws(
    () =>
      verifyDeterministicTar(first, {
        ...fixture.manifest,
        files: substitutedFiles
      }),
    /closed manifest/
  );

  const tampered = Buffer.from(first);
  tampered[512] = 0x58;
  assert.throws(() => verifyDeterministicTar(tampered, fixture.manifest), /differ/);

  const traversal = Buffer.from(first);
  traversal.fill(0, 0, 100);
  traversal.write("payload/../escape", 0, "ascii");
  recalculateTarChecksum(traversal);
  assert.throws(() => verifyDeterministicTar(traversal, fixture.manifest), /denied/);

  const link = Buffer.from(first);
  link.write("2", 156, "ascii");
  recalculateTarChecksum(link);
  assert.throws(() => verifyDeterministicTar(link, fixture.manifest), /entry type/);

  const mode = Buffer.from(first);
  mode.write("0000777\0", 100, 8, "ascii");
  recalculateTarChecksum(mode);
  assert.throws(() => verifyDeterministicTar(mode, fixture.manifest), /mode/);

  const uname = Buffer.from(first);
  uname.write("attacker", 265, "ascii");
  recalculateTarChecksum(uname);
  assert.throws(
    () => verifyDeterministicTar(uname, fixture.manifest),
    /canonical ustar/
  );

  const surplusEndBlocks = Buffer.concat([first, Buffer.alloc(512)]);
  assert.throws(
    () => verifyDeterministicTar(surplusEndBlocks, fixture.manifest),
    /end marker/
  );

  const extra = {
    ...fixture.file,
    path: "unexpected.txt"
  };
  assert.throws(
    () => verifyDeterministicTar(createDeterministicTar([fixture.file, extra]), fixture.manifest),
    /closed manifest/
  );
  const duplicate = {
    ...fixture.file,
    content: Buffer.from("different\n"),
    size: Buffer.byteLength("different\n"),
    digest:
      `sha256:${createHash("sha256").update("different\n").digest("hex")}` as const
  };
  assert.throws(
    () => createDeterministicTar([fixture.file, duplicate]),
    /strictly sorted and unique/
  );
  const sharedLargeContent = Buffer.alloc(8_388_608);
  const largeDigest =
    `sha256:${createHash("sha256").update(sharedLargeContent).digest("hex")}` as const;
  const largeFiles = Array.from({ length: 9 }, (_, index) => ({
    ...fixture.file,
    path: `large-${index}.bin`,
    size: sharedLargeContent.byteLength,
    digest: largeDigest,
    content: sharedLargeContent
  }));
  assert.throws(
    () => createDeterministicTar(largeFiles),
    /archive exceeds/
  );
});

function run(cwd: string, executable: string, args: readonly string[]): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-28T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-28T10:00:00Z"
    },
    shell: false
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * Adds a Git blob at an exact path directly through the index
 * (`hash-object`/`update-index --cacheinfo`) rather than through the
 * working tree. Some paths this module needs to test (e.g. two paths that
 * only differ by letter case) collide on the host's own filesystem, which
 * would silently overwrite one path with the other's content if written
 * through the working tree; the index can still hold both as distinct
 * tracked blobs.
 */
function addBlobAtPath(root: string, relativePath: string, content: string): void {
  const blobId = spawnSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: root,
    input: content,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-28T10:00:00Z",
      GIT_COMMITTER_DATE: "2026-08-28T10:00:00Z"
    },
    shell: false
  });
  assert.equal(blobId.status, 0, blobId.stderr);
  run(root, "git", [
    "update-index",
    "--add",
    "--cacheinfo",
    `100644,${blobId.stdout.trim()},${relativePath}`
  ]);
}

function releaseRepository(): {
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "release-source-"));
  run(root, "git", ["init", "--quiet"]);
  run(root, "git", ["config", "user.name", "Release Test"]);
  run(root, "git", ["config", "user.email", "release@example.invalid"]);
  run(root, "git", [
    "remote",
    "add",
    "origin",
    "https://github.com/example-organization/hyperfinite.git"
  ]);
  writeFileSync(root + "/package.json", '{"name":"agentic-framework","version":"0.1.0"}\n');
  writeFileSync(
    root + "/package-lock.json",
    '{"name":"agentic-framework","version":"0.1.0","lockfileVersion":3,"packages":{"":{"name":"agentic-framework","version":"0.1.0"},"node_modules/example":{"version":"1.2.3","license":"MIT","integrity":"sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA="}}}\n'
  );
  writeFileSync(root + "/LICENSE", readFileSync(path.join(ROOT, "LICENSE")));
  writeFileSync(
    root + "/THIRD_PARTY_NOTICES.md",
    readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"))
  );
  mkdirSync(path.join(root, "nested"));
  writeFileSync(path.join(root, "nested/example.txt"), "nested release file\n");
  run(root, "git", ["add", "."]);
  run(root, "git", ["commit", "--quiet", "-m", "base"]);
  const baseSha = run(root, "git", ["rev-parse", "HEAD"]);
  run(root, "git", ["update-ref", "refs/remotes/origin/main", baseSha]);
  writeFileSync(root + "/README.md", "deterministic release\n");
  run(root, "git", ["add", "README.md"]);
  run(root, "git", ["commit", "--quiet", "-m", "release"]);
  return { root, baseSha, headSha: run(root, "git", ["rev-parse", "HEAD"]) };
}

test("release bundle reproduces byte-for-byte and verifies exact source evidence", () => {
  const repository = releaseRepository();
  const parent = mkdtempSync(path.join(tmpdir(), "release-output-"));
  const firstRoot = path.join(parent, "first");
  const secondRoot = path.join(parent, "second");
  const first = buildReleaseBundle({
    repositoryRoot: repository.root,
    outputRoot: firstRoot,
    baseSha: repository.baseSha,
    headSha: repository.headSha,
    packageVersion: "0.1.0"
  });
  const second = buildReleaseBundle({
    repositoryRoot: repository.root,
    outputRoot: secondRoot,
    baseSha: repository.baseSha,
    headSha: repository.headSha,
    packageVersion: "0.1.0"
  });
  assert.deepEqual(
    { ...first, outputRoot: "" },
    { ...second, outputRoot: "" }
  );
  assert.deepEqual(readdirSync(firstRoot).sort(), readdirSync(secondRoot).sort());
  for (const name of readdirSync(firstRoot)) {
    assert.ok(
      readFileSync(path.join(firstRoot, name)).equals(
        readFileSync(path.join(secondRoot, name))
      ),
      name
    );
  }
  const sbom = validateSpdxDocument(
    JSON.parse(readFileSync(path.join(firstRoot, "sbom.spdx.json"), "utf8"))
  );
  assert.ok(
    sbom.packages.every(
      (entry) =>
        entry.copyrightText === "NOASSERTION" &&
        (entry.checksums === undefined || entry.checksums.length > 0)
    )
  );
  assert.deepEqual(
    verifyReleaseBundle({
      repositoryRoot: repository.root,
      bundleRoot: firstRoot,
      baseSha: repository.baseSha,
      headSha: repository.headSha,
      packageVersion: "0.1.0",
      requireTrustedAttestation: false
    }),
    first
  );
  const manifest = JSON.parse(
    readFileSync(path.join(firstRoot, "release-manifest.json"), "utf8")
  ) as ReleaseManifest;
  assert.equal(manifest.source.server, "github.com");
  run(repository.root, "git", [
    "remote",
    "set-url",
    "origin",
    "https://tenant.ghe.com/example-organization/hyperfinite.git"
  ]);
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: firstRoot,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /source or version binding mismatch/u
  );
  run(repository.root, "git", [
    "remote",
    "set-url",
    "origin",
    "https://github.com/example-organization/hyperfinite.git"
  ]);
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: firstRoot,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: true
      }),
    /unsigned/
  );
  rmSync(repository.root, { recursive: true });
  rmSync(parent, { recursive: true });
});

test("release build and verify reject a portable-extraction path collision anywhere in the tree", () => {
  // Building a genuinely clean, real-file working tree containing two
  // distinct Git paths that collide under case-fold or NFC normalization
  // is not reliably constructible on every host: on a case- and Unicode-
  // normalizing-insensitive filesystem (e.g. this host's APFS volume),
  // writing the colliding path either overwrites the original file's bytes
  // (breaking the fixture) or leaves `git status` reporting the path as
  // modified no matter which of the two writes "wins" on disk -- an
  // orthogonal, legitimate clean-worktree gate (assertExactHead) that
  // build/verify always check first would then mask the collision check
  // this test targets. listGitTree reads the exact committed tree directly
  // from the object database (`git ls-tree`), independent of on-disk
  // working-tree state, so this exercises the exact shared function both
  // buildReleaseBundle and buildCustomerStarterBundle call.
  const repository = releaseRepository();
  addBlobAtPath(repository.root, "readme.md", "duplicate\n");
  run(repository.root, "git", ["commit", "--quiet", "-m", "collide"]);
  const headSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => listGitTree(repository.root, headSha),
    /portable-extraction path collision/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("release tree listing enforces an ASCII-only path policy instead of an unverified Unicode case-fold", () => {
  // String.prototype.toLowerCase() is not a verified implementation of
  // full Unicode case folding: Greek "Σ"/"σ"/final "ς" all fold to the
  // same identity under full case folding, but toLowerCase() never maps
  // "ς" (already lowercase) to "σ", so a bare toLowerCase() comparison
  // would silently miss this real collision. Rather than ship that
  // unverified partial case-fold, every path is required to be ASCII.
  //
  // verifyReleaseBundle is not separately exercised here: it shares the
  // exact same listGitTree-based tree-derivation call this test proves
  // rejects a non-ASCII path, but it also independently checks (before
  // reaching that derivation) that the bundle directory's on-disk manifest
  // is bound to the exact requested headSha and has the exact expected
  // file shape -- gates a synthetic fixture that is *only* trying to
  // reproduce the ASCII violation cannot simultaneously satisfy without
  // reproducing a full, real prior build at that exact (non-ASCII) head,
  // which is precisely the buildReleaseBundle call already covered below.
  const sigma = "nested/\u03c3.md"; // σ (regular lowercase sigma)
  const repository = releaseRepository();
  writeFileSync(path.join(repository.root, sigma), "sigma\n");
  run(repository.root, "git", ["add", sigma]);
  run(repository.root, "git", ["commit", "--quiet", "-m", "add non-ascii path"]);
  const headSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => listGitTree(repository.root, headSha),
    /must be ASCII for portable-extraction/
  );
  // Use a canonicalized mkdtemp root and a *child* path within it as the
  // actual outputRoot, matching every other buildReleaseBundle/
  // buildCustomerStarterBundle output-path fixture in this suite -- never
  // the raw mkdtemp path itself. This test previously passed the raw
  // mkdtempSync(...) result directly (after deleting it) as outputRoot;
  // when TMPDIR is unset, os.tmpdir() falls back to the literal "/tmp",
  // and on hosts where "/tmp" is itself a symlink (e.g. macOS's
  // "/tmp -> /private/tmp"), outputRoot's own parent directory was then
  // that symlink, so safeOutputPath's unrelated "parent must be a
  // canonical non-symbolic-link directory" check threw first and this
  // test never reached the ASCII assertion it exists to prove -- a
  // host/environment-dependent failure, not a real regression in the
  // ASCII policy itself. realpath-ing the mkdtemp root here (defensively,
  // in case tmpdir() itself returns a non-canonical path on some host)
  // and always using a not-yet-created child directory as outputRoot
  // means outputRoot's parent is always the real, non-symlink directory
  // mkdtempSync just created, regardless of whether TMPDIR is set or
  // "/tmp" happens to be a symlink on the host running this test.
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "release-ascii-")));
  const outputRoot = path.join(parent, "output");
  assert.throws(
    () =>
      buildReleaseBundle({
        repositoryRoot: repository.root,
        outputRoot,
        baseSha: repository.baseSha,
        headSha,
        packageVersion: "0.1.0"
      }),
    /must be ASCII for portable-extraction/
  );
  rmSync(repository.root, { recursive: true, force: true });
  rmSync(parent, { recursive: true, force: true });
});

test("safeOutputPath/assertSafeOutputRoot reject a group- or other-writable output parent directory", () => {
  // TOCTOU hardening: a shared, group- or other-writable parent directory
  // (the classic world-writable "/tmp" scenario) lets a different identity
  // sharing the host race a symlink swap, or pre-position content, between
  // this check and the eventual write. Requiring the parent be privately
  // owned and free of group/other write bits closes that class of attack
  // regardless of whether the parent also happens to be a symlink.
  const parent = mkdtempSync(path.join(tmpdir(), "release-writable-parent-"));
  chmodSync(parent, 0o777);
  const outputRoot = path.join(parent, "output");
  assert.throws(() => safeOutputPath(outputRoot), /must not be group- or other-writable/);
  assert.throws(() => assertSafeOutputRoot(outputRoot), /must not be group- or other-writable/);
  chmodSync(parent, 0o700);
  rmSync(parent, { recursive: true, force: true });
});

test("canonicalDirectory rejects a group- or other-writable directory (the repositoryRoot/bundleRoot read path)", () => {
  // The same TOCTOU class applies to *reading* a directory back (a verify
  // bundleRoot, or the source repositoryRoot itself) under a shared
  // writable parent: canonicalDirectory is the one function both build
  // and verify use for these, so hardening it here protects both.
  const directory = mkdtempSync(path.join(tmpdir(), "release-writable-dir-"));
  // mkdtempSync's default 0o700 mode has no group/other write bit, so a
  // directory an owner merely made group/world *readable+executable*
  // (0o755, common for real repository checkouts) is unaffected --
  // only an actual write bit for group or other is rejected.
  chmodSync(directory, 0o755);
  assert.doesNotThrow(() => canonicalDirectory(directory, "test directory"));
  chmodSync(directory, 0o777);
  assert.throws(
    () => canonicalDirectory(directory, "test directory"),
    /must not be group- or other-writable/
  );
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

test("assertSafeOutputRoot refuses to create the output directory through a pre-positioned symlink at the exact target path", () => {
  // mkdirSync with recursive:false is exclusive: it throws EEXIST if
  // anything -- file, directory, or symlink -- already exists at the
  // exact target path, so a symlink an attacker pre-positioned at the
  // expected output path (pointing anywhere, e.g. outside the intended
  // private parent) before the real build ever runs cannot silently be
  // followed and written through.
  const parent = mkdtempSync(path.join(tmpdir(), "release-symlink-swap-"));
  const decoyTarget = path.join(parent, "decoy");
  mkdirSync(decoyTarget);
  const outputRoot = path.join(parent, "output");
  symlinkSync(decoyTarget, outputRoot);
  assert.throws(() => assertSafeOutputRoot(outputRoot));
  assert.ok(readdirSync(decoyTarget).length === 0, "the pre-positioned symlink's target must be untouched");
  rmSync(parent, { recursive: true, force: true });
});

test("release tree listing rejects a final-sigma/regular-sigma pair a bare toLowerCase() would not unify", () => {
  // Demonstrates the exact gap a bare toLowerCase() comparison has: these
  // two distinct Greek letters are both already "lowercase" under
  // toLowerCase() (which would leave "\u03c2" alone and never rewrite it
  // to "\u03c3"), so they would never be flagged as colliding by
  // toLowerCase() alone despite folding to the same identity under real
  // Unicode case folding. The ASCII-only policy rejects both regardless,
  // closing the gap without needing a verified case-fold table.
  const repository = releaseRepository();
  addBlobAtPath(repository.root, "docs/\u03c3.md", "regular sigma\n"); // σ
  addBlobAtPath(repository.root, "docs/\u03c2.md", "final sigma\n"); // ς
  run(repository.root, "git", ["commit", "--quiet", "-m", "add sigma variants"]);
  const headSha = run(repository.root, "git", ["rev-parse", "HEAD"]);
  assert.throws(
    () => listGitTree(repository.root, headSha),
    /must be ASCII for portable-extraction/
  );
  rmSync(repository.root, { recursive: true, force: true });
});

test("release verification rejects tampering, unexpected files, symlinks, and stale source", () => {
  const repository = releaseRepository();
  const parent = mkdtempSync(path.join(tmpdir(), "release-adversarial-"));
  const pristine = path.join(parent, "pristine");
  buildReleaseBundle({
    repositoryRoot: repository.root,
    outputRoot: pristine,
    baseSha: repository.baseSha,
    headSha: repository.headSha,
    packageVersion: "0.1.0"
  });

  const tampered = path.join(parent, "tampered");
  cpSync(pristine, tampered, { recursive: true });
  writeFileSync(path.join(tampered, "agentic-framework.tar"), "tampered");
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: tampered,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /checksum/
  );

  const unexpected = path.join(parent, "unexpected");
  cpSync(pristine, unexpected, { recursive: true });
  writeFileSync(path.join(unexpected, "extra.txt"), "extra");
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: unexpected,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /unexpected/
  );

  const linked = path.join(parent, "linked");
  cpSync(pristine, linked, { recursive: true });
  rmSync(path.join(linked, "attestation.json"));
  symlinkSync(path.join(pristine, "attestation.json"), path.join(linked, "attestation.json"));
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: linked,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /regular file/
  );

  writeFileSync(path.join(repository.root, "README.md"), "dirty\n");
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: pristine,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /clean/
  );
  rmSync(repository.root, { recursive: true });
  rmSync(parent, { recursive: true });
});

test("release builder rejects source links and executable or evidence output mode drift", () => {
  const repository = releaseRepository();
  const parent = mkdtempSync(path.join(tmpdir(), "release-links-"));
  const linkedSource = path.join(parent, "linked-source");
  symlinkSync(repository.root, linkedSource);
  assert.throws(() =>
    buildReleaseBundle({
      repositoryRoot: linkedSource,
      outputRoot: path.join(parent, "output"),
      baseSha: repository.baseSha,
      headSha: repository.headSha,
      packageVersion: "0.1.0"
    })
  );
  const inRepositoryOutput = path.join(repository.root, "release-output");
  assert.throws(
    () =>
      buildReleaseBundle({
        repositoryRoot: repository.root,
        outputRoot: inRepositoryOutput,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0"
      }),
    /outside the source repository/
  );
  assert.throws(() => lstatSync(inRepositoryOutput), { code: "ENOENT" });
  assert.throws(
    () =>
      buildReleaseBundle({
        repositoryRoot: path.join(repository.root, "nested"),
        outputRoot: path.join(repository.root, "ignored-output"),
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0"
      }),
    /Git top-level/
  );
  const linkedRoot = path.join(parent, "linked-worktree");
  run(repository.root, "git", [
    "worktree",
    "add",
    "--quiet",
    "-b",
    "release-linked-test",
    linkedRoot,
    repository.headSha
  ]);
  const metadataOutput = path.join(
    realpathSync(path.join(repository.root, ".git")),
    "release-output"
  );
  assert.throws(
    () =>
      buildReleaseBundle({
        repositoryRoot: linkedRoot,
        outputRoot: metadataOutput,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0"
      }),
    /Git metadata/
  );
  assert.equal(existsSync(metadataOutput), false);
  run(repository.root, "git", [
    "worktree",
    "remove",
    "--force",
    linkedRoot
  ]);

  const output = path.join(parent, "valid");
  buildReleaseBundle({
    repositoryRoot: repository.root,
    outputRoot: output,
    baseSha: repository.baseSha,
    headSha: repository.headSha,
    packageVersion: "0.1.0"
  });

  chmodSync(path.join(output, "attestation.json"), 0o644);
  assert.equal(lstatSync(path.join(output, "attestation.json")).mode & 0o777, 0o644);
  assert.throws(
    () =>
      verifyReleaseBundle({
        repositoryRoot: repository.root,
        bundleRoot: output,
        baseSha: repository.baseSha,
        headSha: repository.headSha,
        packageVersion: "0.1.0",
        requireTrustedAttestation: false
      }),
    /regular file/
  );
  rmSync(repository.root, { recursive: true });
  rmSync(parent, { recursive: true });
});

test("release builder ignores Git replacement objects", () => {
  const releaseSupportSource = readFileSync(
    path.join(ROOT, "src/release-support.ts"),
    "utf8"
  );
  assert.ok(releaseSupportSource.includes('GIT_NO_LAZY_FETCH: "1"'));
  assert.ok(releaseSupportSource.includes('"core.fsmonitor=false"'));
  const repository = releaseRepository();
  const parent = mkdtempSync(path.join(tmpdir(), "release-replacements-"));
  const packageOid = run(repository.root, "git", [
    "rev-parse",
    `${repository.headSha}:package.json`
  ]);
  const replacementPath = path.join(repository.root, "replacement-package.json");
  writeFileSync(
    replacementPath,
    '{"name":"agentic-framework","version":"9.9.9"}\n'
  );
  const replacementOid = run(repository.root, "git", [
    "hash-object",
    "-w",
    replacementPath
  ]);
  rmSync(replacementPath);
  run(repository.root, "git", ["replace", packageOid, replacementOid]);
  const tree = run(repository.root, "git", ["write-tree"]);
  const alternateCommit = spawnSync("git", ["commit-tree", tree], {
    cwd: repository.root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2030-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z"
    },
    input: "alternate replacement commit\n",
    shell: false
  });

  test("release builder disables repository fsmonitor programs", () => {
    const repository = releaseRepository();
    const parent = mkdtempSync(path.join(tmpdir(), "release-fsmonitor-"));
    const marker = path.join(parent, "fsmonitor-ran");
    const hook = path.join(parent, "fsmonitor.sh");
    writeFileSync(
      hook,
      `#!/bin/sh\nprintf ran > '${marker}'\nprintf '2\\n'\n`,
      { mode: 0o755 }
    );
    run(repository.root, "git", ["config", "core.fsmonitor", hook]);
    buildReleaseBundle({
      repositoryRoot: repository.root,
      outputRoot: path.join(parent, "bundle"),
      baseSha: repository.baseSha,
      headSha: repository.headSha,
      packageVersion: "0.1.0"
    });
    assert.throws(() => lstatSync(marker), { code: "ENOENT" });
    rmSync(repository.root, { recursive: true });
    rmSync(parent, { recursive: true });
  });
  assert.equal(alternateCommit.status, 0, alternateCommit.stderr);
  run(repository.root, "git", [
    "replace",
    repository.headSha,
    alternateCommit.stdout.trim()
  ]);
  const outputRoot = path.join(parent, "bundle");
  buildReleaseBundle({
    repositoryRoot: repository.root,
    outputRoot,
    baseSha: repository.baseSha,
    headSha: repository.headSha,
    packageVersion: "0.1.0"
  });
  const manifest = JSON.parse(
    readFileSync(path.join(outputRoot, "release-manifest.json"), "utf8")
  ) as ReleaseManifest;
  const packaged = manifest.files.find((file) => file.path === "package.json");
  assert.equal(
    packaged?.digest,
    `sha256:${createHash("sha256")
      .update('{"name":"agentic-framework","version":"0.1.0"}\n')
      .digest("hex")}`
  );
  rmSync(repository.root, { recursive: true });
  rmSync(parent, { recursive: true });
});

test("release CLI rejects trusted-attestation claims during build", () => {
  const repository = releaseRepository();
  const parent = mkdtempSync(path.join(tmpdir(), "release-cli-flags-"));
  const result = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "dist/scripts/release-local.js"),
      "build",
      "--base-sha",
      repository.baseSha,
      "--head-sha",
      repository.headSha,
      "--version",
      "0.1.0",
      "--output",
      path.join(parent, "bundle"),
      "--require-trusted-attestation"
    ],
    {
      cwd: repository.root,
      encoding: "utf8",
      shell: false
    }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unknown release argument/);
  rmSync(repository.root, { recursive: true });
  rmSync(parent, { recursive: true });
});

test("packaging schemas are closed and readiness remains a non-authoritative no-go", () => {
  const fixture = example();
  for (const document of [
    fixture.config,
    fixture.state,
    fixture.manifest,
    fixture.migrations,
    fixture.backup,
    json("config/v1alpha1/compatibility.json"),
    json("config/v1alpha1/open-source-readiness.json")
  ]) {
    assert.equal(validateDocument("PackagingDocument", document).valid, true);
    assert.equal(
      validateDocument("PackagingDocument", {
        ...(document as Readonly<Record<string, unknown>>),
        unexpected: true
      }).valid,
      false
    );
  }
  for (const deniedPath of [
    ".",
    "..",
    ".git",
    "evidence/.",
    "evidence/..",
    "evidence//bad",
    "evidence/"
  ]) {
    assert.equal(
      validateDocument("PackagingDocument", {
        ...fixture.state,
        evidencePaths: [deniedPath]
      }).valid,
      false,
      deniedPath
    );
  }
  const tooLongReleasePath = `${"a".repeat(221)}.txt`;
  assert.equal(tooLongReleasePath.length, 225);
  assert.equal(
    validateDocument("PackagingDocument", {
      ...fixture.manifest,
      files: [
        {
          ...fixture.manifest.files[0]!,
          path: tooLongReleasePath
        }
      ]
    }).valid,
    false
  );
  assert.throws(
    () =>
      validateSpdxDocument({
        spdxVersion: "SPDX-2.3",
        dataLicense: "CC0-1.0",
        SPDXID: "SPDXRef-DOCUMENT",
        name: "invalid",
        documentNamespace: "https://example.invalid/spdx",
        creationInfo: {
          created: "2026-08-28T10:00:00Z",
          creators: ["Tool: agentic-framework-release-tool"]
        },
        packages: [
          {
            SPDXID: "SPDXRef-Package-1",
            name: "invalid",
            versionInfo: "1.0.0",
            downloadLocation: "NOASSERTION",
            filesAnalyzed: false,
            licenseConcluded: "NOASSERTION",
            licenseDeclared: "definitely not SPDX",
            copyrightText: "NOASSERTION"
          }
        ]
      }),
    /SPDX package shape/
  );
  let licenseReads = 0;
  const accessorSpdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "snapshot",
    documentNamespace: "https://example.invalid/spdx/snapshot",
    creationInfo: {
      created: "2026-08-28T10:00:00Z",
      creators: ["Tool: agentic-framework-release-tool"]
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-1",
        name: "snapshot",
        versionInfo: "1.0.0",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        get licenseDeclared(): string {
          licenseReads += 1;
          return licenseReads === 1 ? "MIT" : "definitely not SPDX";
        },
        copyrightText: "NOASSERTION"
      }
    ]
  };
  const snapshottedSpdx = validateSpdxDocument(accessorSpdx);
  assert.equal(snapshottedSpdx.packages[0]?.licenseDeclared, "MIT");
  assert.equal(licenseReads, 1);
  const assessment = validateOpenSourceAssessment(
    json("config/v1alpha1/open-source-readiness.json"),
    "0.1.0"
  );
  assert.equal(assessment.decision, "not-ready");
  assert.equal(assessment.authoritative, false);
  assert.equal(assessment.categories.length, 9);
  assert.deepEqual(assessment.prohibitedDecisions, [
    "license-change",
    "publication",
    "repository-visibility-change",
    "release"
  ]);
  let readinessReads = 0;
  const readinessAccessor = {
    ...json<Record<string, unknown>>(
      "config/v1alpha1/open-source-readiness.json"
    ),
    get decision(): string {
      readinessReads += 1;
      return readinessReads === 1 ? "not-ready" : "ready";
    }
  };
  const snapshottedReadiness = validateOpenSourceAssessment(
    readinessAccessor,
    "0.1.0"
  );
  assert.equal(snapshottedReadiness.decision, "not-ready");
  assert.equal(readinessReads, 1);
});

test("installer CLI rejects Git metadata and raw traversal output paths", () => {
  for (const output of [
    ".git/copilot-installer-output",
    "examples/../.git/copilot-installer-output"
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "dist/scripts/installer.js"),
        "plan",
        "--output",
        output
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: false
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /canonical repository-relative path/);
    assert.equal(
      existsSync(path.join(ROOT, ".git/copilot-installer-output")),
      false
    );
  }

  const separateRoot = mkdtempSync(
    path.join(tmpdir(), "installer-separate-git-")
  );
  const worktree = path.join(separateRoot, "worktree");
  const metadata = path.join(worktree, "metadata");
  mkdirSync(worktree);
  run(worktree, "git", [
    "init",
    "--quiet",
    `--separate-git-dir=${metadata}`,
    "."
  ]);
  mkdirSync(path.join(worktree, "examples"), { recursive: true });
  cpSync(
    path.join(ROOT, "examples/customer-installation"),
    path.join(worktree, "examples/customer-installation"),
    { recursive: true }
  );
  mkdirSync(path.join(worktree, "config/v1alpha1"), { recursive: true });
  copyFileSync(
    path.join(ROOT, "config/v1alpha1/migrations.json"),
    path.join(worktree, "config/v1alpha1/migrations.json")
  );
  const separateResult = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "dist/scripts/installer.js"),
      "plan",
      "--output",
      "metadata/poison"
    ],
    {
      cwd: worktree,
      encoding: "utf8",
      shell: false
    }
  );
  assert.notEqual(separateResult.status, 0);
  assert.match(separateResult.stderr, /cannot enter Git metadata/);
  assert.equal(existsSync(path.join(metadata, "poison")), false);
  rmSync(separateRoot, { recursive: true });
});

test("installer names offline validation explicitly and bounds receipt files", () => {
  const ambiguous = spawnSync(
    process.execPath,
    [path.join(ROOT, "dist/scripts/installer.js"), "validate"],
    {
      cwd: ROOT,
      encoding: "utf8",
      shell: false
    }
  );
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /validate is ambiguous.*offline-validate/);

  const offline = spawnSync(
    process.execPath,
    [path.join(ROOT, "dist/scripts/installer.js"), "offline-validate"],
    {
      cwd: ROOT,
      encoding: "utf8",
      shell: false
    }
  );
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(
    (JSON.parse(offline.stdout) as { readonly mode: string }).mode,
    "offline-validate"
  );

  const relativeReceiptsPath =
    `.installer-oversized-receipts-${process.pid}.json`;
  const receiptsPath = path.join(ROOT, relativeReceiptsPath);
  try {
    writeFileSync(
      receiptsPath,
      JSON.stringify(new Array(MAX_INSTALLATION_RECEIPTS + 1).fill(null)),
      "utf8"
    );
    const oversized = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "dist/scripts/installer.js"),
        "plan",
        "--receipts",
        relativeReceiptsPath
      ],
      {
        cwd: ROOT,
        encoding: "utf8",
        shell: false
      }
    );
    assert.notEqual(oversized.status, 0);
    assert.match(oversized.stderr, /closed receipt bound/);
    assert.doesNotMatch(oversized.stderr, /non-receipt/);
  } finally {
    rmSync(receiptsPath, { force: true });
  }
});

test("internal release-support helpers are not part of the public API surface", () => {
  const publicApiKeys = new Set(Object.keys(agenticFramework));
  const internalReleaseSupportNames = [
    "readGitTree",
    "sha256Bytes",
    "sha256Hex",
    "gitText",
    "assertSupportedGitVersion",
    "assertGitTopLevel",
    "assertOutsideRepositoryMetadata",
    "githubRepositoryFromRemote",
    "assertExactHead",
    "packageVersionFrom",
    "requiredFile",
    "canonicalFile",
    "canonicalDirectory",
    "safeOutputPath",
    "assertSafeOutputRoot",
    "writeExclusive",
    "createChecksums",
    "assertStrictlySortedPaths",
    "assertPackagingKind",
    "assertNoPortablePathCollisions",
    "MAX_ARCHIVE_BYTES",
    "MAX_FILE_BYTES",
    "MAX_FILES",
    "EXPECTED_LICENSE_DIGEST",
    "EXPECTED_NOTICES_DIGEST",
    "UTF8_DECODER"
  ];
  for (const name of internalReleaseSupportNames) {
    assert.ok(
      !publicApiKeys.has(name),
      `src/release-support.ts helper "${name}" must not leak through src/index.js`
    );
  }
  assert.ok(publicApiKeys.has("createDeterministicTar"));
  assert.ok(publicApiKeys.has("verifyDeterministicTar"));
  assert.ok(publicApiKeys.has("validateSpdxDocument"));
  assert.ok(publicApiKeys.has("buildReleaseBundle"));
  assert.ok(publicApiKeys.has("verifyReleaseBundle"));
  assert.ok(publicApiKeys.has("validateOpenSourceAssessment"));
  const indexSource = readFileSync(path.join(ROOT, "src/index.ts"), "utf8");
  assert.doesNotMatch(indexSource, /release-support/);
  assert.match(indexSource, /export \* from "\.\/release\.js";/);
});
