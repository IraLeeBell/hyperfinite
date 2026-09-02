import type { GitHubApi } from "./github-adapter.js";
import type { TrustedGitHubBinding } from "./github-events.js";
import type { GitHubEffect } from "./github-types.js";

export type GitHubPermissionLevel = "read" | "write";

export interface GitHubPermissionGrant {
  readonly name:
    | "checks"
    | "contents"
    | "issues"
    | "members"
    | "metadata"
    | "organization_projects"
    | "pull_requests";
  readonly level: GitHubPermissionLevel;
  readonly scope: "organization" | "repository";
}

export const GITHUB_PERMISSION_MANIFEST = {
  version: "1.0.0",
  denied: [
    "administration",
    "actions",
    "deployments",
    "organization_administration",
    "repository_hooks",
    "workflows"
  ],
  operations: {
    resolveBinding: [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "issues", level: "read", scope: "repository" },
      { name: "pull_requests", level: "read", scope: "repository" },
      { name: "organization_projects", level: "read", scope: "organization" }
    ],
    authorizeActor: [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "members", level: "read", scope: "organization" },
      { name: "pull_requests", level: "read", scope: "repository" }
    ],
    "issue-comment": [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "issues", level: "write", scope: "repository" }
    ],
    "pull-request-review-comment": [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "pull_requests", level: "write", scope: "repository" }
    ],
    "check-run": [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "checks", level: "write", scope: "repository" },
      { name: "issues", level: "write", scope: "repository" },
      { name: "pull_requests", level: "read", scope: "repository" }
    ],
    "project-field-update": [
      { name: "metadata", level: "read", scope: "repository" },
      { name: "issues", level: "write", scope: "repository" },
      { name: "organization_projects", level: "write", scope: "organization" }
    ]
  }
} as const satisfies {
  readonly version: string;
  readonly denied: readonly string[];
  readonly operations: Readonly<Record<string, readonly GitHubPermissionGrant[]>>;
};

export interface SignedGitHubAppIdentity {
  readonly kind: "signed-github-app-identity";
}

export interface GitHubAppSigner {
  withSignedIdentity<T>(
    request: {
      readonly algorithm: "RS256";
      readonly issuer: string;
      readonly issuedAt: string;
      readonly expiresAt: string;
    },
    operation: (identity: SignedGitHubAppIdentity) => Promise<T>
  ): Promise<T>;
}

export interface MintedInstallationGrant {
  readonly installationId: number;
  readonly repositoryIds: readonly number[];
  readonly permissions: readonly GitHubPermissionGrant[];
  readonly expiresAt: string;
}

export interface InstallationTokenMinter {
  withInstallationClient<T>(
    identity: SignedGitHubAppIdentity,
    request: {
      readonly installationId: number;
      readonly repositoryIds: readonly number[];
      readonly permissions: readonly GitHubPermissionGrant[];
    },
    operation: (
      client: GitHubApi,
      grant: MintedInstallationGrant
    ) => Promise<T>
  ): Promise<T>;
}

export class GitHubCredentialError extends Error {
  constructor(
    readonly code:
      | "TOKEN_INSTALLATION_MISMATCH"
      | "TOKEN_REPOSITORY_SCOPE_MISMATCH"
      | "TOKEN_PERMISSION_MISMATCH"
      | "TOKEN_EXPIRY_INVALID",
    message: string
  ) {
    super(message);
    this.name = "GitHubCredentialError";
  }
}

function permissionKey(permission: GitHubPermissionGrant): string {
  return `${permission.scope}:${permission.name}`;
}

function permissionSatisfies(
  actual: GitHubPermissionGrant,
  expected: GitHubPermissionGrant
): boolean {
  return (
    permissionKey(actual) === permissionKey(expected) &&
    actual.level === expected.level
  );
}

function permissionsForEffect(
  effect: GitHubEffect
): readonly GitHubPermissionGrant[] {
  return GITHUB_PERMISSION_MANIFEST.operations[effect.type];
}

export class GitHubAppCredentialBroker {
  constructor(
    private readonly signer: GitHubAppSigner,
    private readonly minter: InstallationTokenMinter,
    private readonly appClientId: string,
    private readonly now: () => Date = () => new Date()
  ) {
    if (appClientId.length === 0) {
      throw new TypeError("GitHub App client ID is required");
    }
  }

  withClientForEffect<T>(
    binding: TrustedGitHubBinding,
    effect: GitHubEffect,
    operation: (client: GitHubApi) => Promise<T>
  ): Promise<T> {
    const issuedAt = this.now();
    const jwtIssuedAt = new Date(issuedAt.getTime() - 60 * 1000);
    const jwtExpiresAt = new Date(issuedAt.getTime() + 9 * 60 * 1000);
    const requestedPermissions = permissionsForEffect(effect);
    return this.signer.withSignedIdentity(
      {
        algorithm: "RS256",
        issuer: this.appClientId,
        issuedAt: jwtIssuedAt.toISOString(),
        expiresAt: jwtExpiresAt.toISOString()
      },
      (identity) =>
        this.minter.withInstallationClient(
          identity,
          {
            installationId: binding.installation.id,
            repositoryIds: [binding.repository.id],
            permissions: requestedPermissions
          },
          async (client, grant) => {
            if (grant.installationId !== binding.installation.id) {
              throw new GitHubCredentialError(
                "TOKEN_INSTALLATION_MISMATCH",
                "minted token installation does not match Trusted Binding"
              );
            }
            if (
              grant.repositoryIds.length !== 1 ||
              grant.repositoryIds[0] !== binding.repository.id
            ) {
              throw new GitHubCredentialError(
                "TOKEN_REPOSITORY_SCOPE_MISMATCH",
                "minted token is not downscoped to the bound repository"
              );
            }
            const actualByKey = new Map(
              grant.permissions.map((permission) => [
                permissionKey(permission),
                permission
              ])
            );
            const permissionMismatch =
              grant.permissions.length !== requestedPermissions.length ||
              requestedPermissions.some((expected) => {
                const actual = actualByKey.get(permissionKey(expected));
                return actual === undefined || !permissionSatisfies(actual, expected);
              });
            if (permissionMismatch) {
              throw new GitHubCredentialError(
                "TOKEN_PERMISSION_MISMATCH",
                "minted token permissions differ from the operation manifest"
              );
            }
            const expiresAt = new Date(grant.expiresAt);
            const maximum = issuedAt.getTime() + 60 * 60 * 1000;
            if (
              Number.isNaN(expiresAt.getTime()) ||
              expiresAt.getTime() <= issuedAt.getTime() ||
              expiresAt.getTime() > maximum
            ) {
              throw new GitHubCredentialError(
                "TOKEN_EXPIRY_INVALID",
                "minted token must be short-lived and currently valid"
              );
            }
            return operation(client);
          }
        )
    );
  }
}
