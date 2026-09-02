import type { WorkAccord } from "./types.js";

function list(items: readonly string[]): string {
  return items.length === 0 ? "- None" : items.map((item) => `- ${item}`).join("\n");
}

export function renderWorkAccordMarkdown(accord: WorkAccord): string {
  return [
    `# Work Accord ${accord.identity.id}`,
    "",
    "> Human-readable binding view only. This Markdown grants no authority; the validated machine document, Trusted Binding, current policy, and human evidence control execution.",
    "",
    `- **Schema:** \`${accord.apiVersion}\``,
    `- **Revision:** ${accord.identity.revision}`,
    `- **Created:** ${accord.identity.createdAt} by \`${accord.identity.createdBy}\``,
    `- **Repository ID:** \`${accord.binding.repositoryId}\``,
    `- **Work item:** \`${accord.binding.workItemNodeId}\``,
    `- **Source digest:** \`${accord.binding.sourceDigest}\``,
    `- **Policy digest:** \`${accord.binding.policyDigest}\``,
    `- **Lifecycle graph digest:** \`${accord.binding.lifecycleGraphDigest}\``,
    `- **Current head:** ${accord.binding.currentHead === null ? "Not bound" : `\`${accord.binding.currentHead}\``}`,
    "",
    "## Objective",
    "",
    accord.objective.outcome,
    "",
    "### In scope",
    "",
    list(accord.objective.inScope),
    "",
    "### Out of scope",
    "",
    list(accord.objective.outOfScope),
    "",
    "## Policy",
    "",
    `- **Domain Pack:** \`${accord.policy.domainPack}\``,
    `- **Depth:** \`${accord.policy.depthProfile}\``,
    `- **Risk:** \`${accord.policy.riskClass}\``,
    `- **Privacy:** \`${accord.policy.privacyClass}\``,
    `- **Secret access:** denied`,
    "",
    "### Phase contracts",
    "",
    ...Object.entries(accord.policy.phaseContracts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([phase, binding]) =>
          `- **${phase}:** \`${binding.reference}\` (\`${binding.digest}\`)`
      ),
    "",
    "### Requested capabilities",
    "",
    list(accord.policy.requestedCapabilities),
    "",
    "### Prohibited effects",
    "",
    list(accord.policy.prohibitedEffects),
    "",
    "## Budget",
    "",
    `Calls ${accord.budget.maxCalls}; tokens ${accord.budget.maxTokens}; cost units ${accord.budget.maxCostUnits}; retries ${accord.budget.maxRetries}; loops ${accord.budget.maxLoops}; parallelism ${accord.budget.maxParallel}; expires ${accord.budget.expiresAt}.`,
    "",
    "## Deliverables",
    "",
    list(accord.deliverables),
    "",
    "## Required evidence",
    "",
    list(accord.evidence.required),
    "",
    "## Human gates",
    "",
    list(accord.humanGates),
    ""
  ].join("\n");
}
