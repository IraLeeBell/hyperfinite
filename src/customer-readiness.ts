export interface CustomerShareabilityFile {
  readonly path: string;
  readonly content: string;
}

export interface CustomerShareabilityFinding {
  readonly ruleId: string;
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

interface CustomerShareabilityRule {
  readonly id: string;
  readonly expression: RegExp;
  readonly reason: string;
}

export interface CustomerShareabilityOptions {
  readonly allowSourceCodeowner?: boolean;
}

function repositoryReference(owner: string, repository: string): RegExp {
  const escaped = `${owner}/${repository}`.replace(
    /[.*+?^${}()|[\]\\]/gu,
    "\\$&"
  );
  return new RegExp(
    `(?:^|[^A-Za-z0-9_.-])(?:github\\.com/)?${escaped}(?![A-Za-z0-9_.-])`,
    "iu"
  );
}

const CUSTOMER_SHAREABILITY_RULES: readonly CustomerShareabilityRule[] =
  Object.freeze([
    {
      id: "source-repository-binding",
      expression: repositoryReference("github", "hyperfinite"),
      reason:
        "source repository identity must be derived or represented by a customer-neutral example"
    },
    {
      id: "source-codeowner",
      expression: new RegExp(
        `${["@", "Ira", "Lee", "Bell"].join("")}(?![A-Za-z0-9-])`,
        "iu"
      ),
      reason: "source code owner must be replaced in customer copies"
    },
    {
      id: "github-private-domain",
      expression: /\bgithub\.(?:net|local)\b/iu,
      reason: "GitHub private network domains must not be distributed"
    },
    {
      id: "private-slack-link",
      expression: /https:\/\/[^/\s]+\.slack\.com\/archives\//iu,
      reason: "private Slack links must not be distributed"
    },
    {
      id: "private-sharepoint-link",
      expression: /https:\/\/github\.sharepoint\.com\//iu,
      reason: "GitHub private SharePoint links must not be distributed"
    },
    {
      id: "source-organization-url",
      expression: new RegExp(
        ["https://github.com/orgs", "github"].join("/"),
        "iu"
      ),
      reason: "source organization URLs must not be distributed"
    },
    {
      id: "source-history-reference",
      expression:
        /\b(?:issue|pull request|PR)\s+#\d+\b|https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(?:issues|pull)\/\d+/iu,
      reason:
        "source issue and pull-request history must not be required by a customer copy"
    },
    {
      id: "live-project-node-id",
      expression: /\bPVT(?:I|F|SSF|V)?_(?!synthetic_)[A-Za-z0-9_-]{4,}\b/u,
      reason: "live GitHub Project node identities must remain external evidence"
    },
    {
      id: "source-owner-node-id",
      expression: new RegExp(
        ["MDEyOk9yZ2FuaX", "phdGlvbjk5MTk="].join(""),
        "u"
      ),
      reason: "source organization node identity must not be distributed"
    },
    {
      id: "source-repository-node-id",
      expression: new RegExp(["R_kgDO", "UEcN5g"].join(""), "u"),
      reason: "source repository node identity must not be distributed"
    }
  ]);

export function auditCustomerShareability(
  files: readonly CustomerShareabilityFile[],
  options: CustomerShareabilityOptions = {}
): readonly CustomerShareabilityFinding[] {
  const findings: CustomerShareabilityFinding[] = [];
  const seenPaths = new Set<string>();
  for (const file of files) {
    if (
      file.path.length === 0 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..") ||
      seenPaths.has(file.path)
    ) {
      throw new TypeError("customer shareability audit requires unique safe paths");
    }
    seenPaths.add(file.path);
    const lines = file.content.split(/\r?\n/u);
    for (const rule of CUSTOMER_SHAREABILITY_RULES) {
      if (
        rule.id === "source-codeowner" &&
        options.allowSourceCodeowner === true &&
        file.path === ".github/CODEOWNERS"
      ) {
        continue;
      }
      for (let index = 0; index < lines.length; index += 1) {
        if (rule.expression.test(lines[index]!)) {
          findings.push({
            ruleId: rule.id,
            path: file.path,
            line: index + 1,
            reason: rule.reason
          });
        }
      }
    }
  }
  return findings.sort((left, right) =>
    left.path === right.path
      ? left.line - right.line || left.ruleId.localeCompare(right.ruleId)
      : left.path.localeCompare(right.path)
  );
}
