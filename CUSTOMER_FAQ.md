# Hyperfinite customer FAQ

This FAQ answers common executive, governance, security, technical, operational,
and evaluation questions. Start with the
[customer evaluation guide](CUSTOMER_EVALUATION_GUIDE.md) for the implementation
sequence and the
[approval ticket templates](docs/runbooks/customer-approval-tickets.md) for
copy-ready customer requests.
The supported customer artifact is reviewed source in a new customer-owned Git
repository, not an npm package, SDK, packaged CLI, hosted service, or deployable
service. See the [distribution boundary](docs/architecture/distribution-boundary.md).

## Executive and business questions

### 1. What is Hyperfinite?

Hyperfinite is a GitHub-native control plane for model-assisted work. It lets
models propose bounded artifacts while deterministic code and authorized humans
retain authority over identity, policy, lifecycle transitions, capabilities,
targets, credentials, retries, effects, and evidence.

It is domain-neutral: the included demonstrations cover app modernization,
feature delivery, security remediation, and adaptive delivery, but the control
model is designed around contracts rather than one business process.

### 2. How can this framework help?

It can make model-assisted work more reviewable and governable. Instead of
giving a model broad credentials and asking it to decide what to change,
Hyperfinite binds an authorized work item to explicit policy, budgets, logical
slots, current GitHub facts, and human gates.

This can reduce target confusion, uncontrolled retries, permission sprawl,
untraceable decisions, and automation that advances without current evidence.

### 3. What business problem does it address?

Organizations often want the speed of model-assisted work without turning a
probabilistic model into an authorization system. Hyperfinite separates
advisory computation from mechanical authority so teams can evaluate automation
with explicit scope, evidence, cost limits, and stop conditions.

### 4. What does a successful customer evaluation prove?

It proves that one customer-owned, synthetic workflow can be configured in the
customer's GitHub Enterprise Cloud environment, reach Human Review, and preserve
the required current-head, policy, budget, target, and effect evidence.

It also demonstrates that the evaluation can be paused, recovered, or removed
without relying on model judgment.

### 5. What does an evaluation not prove?

An evaluation does not decide enterprise-wide adoption, operating scale,
business continuity targets, support obligations, data classifications, or
acceptable residual risk. Those are customer decisions informed by the
evaluation evidence.

### 6. Who should sponsor the evaluation?

An executive or senior engineering/platform leader should own the outcome and
stop/go decision. A named evaluation lead should coordinate the technical,
security, GitHub administration, billing, legal/privacy, operations, and
feedback workstreams.

### 7. Which teams need to participate?

Typical participants are engineering leadership, a GitHub organization owner,
repository administrators, security architecture, cloud/platform engineering,
identity/key management, billing/procurement, legal/privacy, operations, and an
independent code reviewer.

Smaller organizations may combine roles when policy permits, but required
independent review must remain independent.

### 8. How long should an evaluation take?

The repository-only validation can usually be completed quickly on a supported
toolchain. Calendar time is primarily determined by customer tickets, App and
OIDC approval, trust-service deployment, Project configuration, security review,
and operator scheduling.

Use the phases in `CUSTOMER_EVALUATION_GUIDE.md` to estimate work in the
customer's change-management process.

### 9. What is the smallest useful evaluation scope?

Use one private customer-owned sandbox repository, the four synthetic Projects,
one approved user cohort, a fixed model budget, and one bounded canary that
stops at Human Review. Do not begin with customer production data or a
multi-repository rollout.

### 10. How should we measure value?

Agree on measures before activation: cycle time to a reviewable artifact,
operator effort, policy violations prevented, recovery behavior, evidence
quality, review usefulness, budget predictability, and user feedback.

Do not use model output volume alone as a success measure.

## Scope and platform questions

### 11. Is GitHub Enterprise Cloud required?

Yes. The documented customer path targets GitHub Enterprise Cloud. GitHub
Enterprise Server is not included in the current compatibility matrix because
its API, App, Actions, Copilot, and Projects behavior can differ.

### 12. Which GitHub features are used?

The framework uses repositories, Issues, pull requests, checks, reviews,
Actions, GitHub Apps, organization Projects, rulesets/CODEOWNERS, and optionally
Copilot Agentic Workflows. Customer security features such as CodeQL,
Dependency Review, Dependabot, and secret scanning are part of the recommended
control set.

### 13. Does Hyperfinite create GitHub Projects automatically?

No. The repository generates deterministic plans and readbacks, but an
authorized human administrator creates or changes Projects. This prevents a
planner or model from choosing a customer target.

### 14. Why are there four Projects?

Each Project presents one governed demonstration journey with its own stages and
synthetic items. Keeping the journeys separate makes scope, operator behavior,
and evidence easier to inspect.

### 15. Are GitHub Projects authoritative?

No. Projects are visible projections. Lifecycle authority remains in the
versioned contracts, Control Kernel, trusted adapter, signed receipts, and
current GitHub facts. Moving a card cannot authorize a transition.

### 16. Can we evaluate only one demonstration?

The repository validates the complete four-demo portfolio because cross-demo
isolation is part of the evidence. A customer may choose to activate only one
canary after validating the whole source artifact and documenting that narrower
scope.

### 17. Can Hyperfinite target multiple repositories?

The contracts can represent exact repository identities, but the recommended
first evaluation uses one repository. Any multi-repository extension must bind
each repository independently and must not introduce wildcard App installation,
OIDC, tool, or effect authority.

### 18. Can we use a fork?

Forks require exact base and head repository bindings and additional trust
analysis. Use a new customer-owned repository copy for the first evaluation
rather than a fork that inherits source-network assumptions.

### 19. Why copy the repository without history?

The customer source copy is intended to stand on its own without source issue,
pull request, or commit history. This limits the transfer to reviewed files and
avoids carrying coordination comments, source-tenant identifiers, and obsolete
delivery records.

The customer creates a new initial commit, which becomes the root of its own
evidence chain.

### 20. What must be changed immediately after copying?

Confirm the new Git remote and default branch, run `customer:configure` with a
valid customer code owner, review customer-specific placeholders, and run
`npm run validate:customer-readiness`. Create the initial import commit, run
`npm run customer:repin`, review and commit the two customer-starter selection
changes, then run the full matrix. Keep runtime activation disabled while
configuration and approvals are incomplete.

## Authority and governance questions

### 21. What is the authority order?

The fixed order is lifecycle graph, Work Accord and Phase Contracts, policy
compiler and Capability Registry, Control Kernel, trusted adapter, Single
Writer, and finally model output as untrusted advisory data.

Later layers cannot grant themselves authority held by earlier layers.

### 22. Can a model choose a repository or work item?

No. Repository, issue, pull request, Project item, ref, and SHA identities come
from trusted bindings and current authenticated reads. Model output that carries
target-bearing fields is rejected.

### 23. Can automation approve or merge its own work?

No. Automated review is limited to `COMMENT`. Approval, review dismissal,
ready-for-review changes, merge, and release remain independent human decisions.

### 24. What happens when a required human gate is missing?

The route remains blocked. Missing approval is not converted into a warning,
default, or retry. The evidence identifies the missing gate so an authorized
owner can act.

### 25. Can an administrator bypass the controls?

GitHub administrators may possess platform powers outside the framework.
Customer rulesets should omit automation bypass and customer governance should
monitor administrative changes. Hyperfinite cannot prevent an authorized
platform owner from intentionally weakening external policy.

### 26. How are policy changes governed?

Change the lifecycle, Work Accord, schema, policy, Capability Registry, and
tests together through a reviewed pull request. Re-run exact-head validation and
issue new bindings or generations when a change invalidates prior evidence.

### 27. What is a Work Accord?

A Work Accord is a versioned contract that binds the authorized objective,
scope, repository/work-item identity, risk/depth profile, limits, paths,
capabilities, human gates, and prohibited effects for one work item.

It is evaluated by deterministic code, not interpreted as open-ended model
instructions.

### 28. What is the Control Kernel?

The Control Kernel evaluates current state, policy, evidence, and the lifecycle
graph to decide whether a route is mechanically valid. It produces typed
results and cannot be bypassed by a Project field or model response.

### 29. What is the Single Writer?

The Single Writer is the serialized effect boundary. It revalidates current
bindings, authorization, evidence, idempotency, and expected state immediately
before one bounded GitHub mutation, then performs readback and records evidence.

### 30. What changes require fresh authorization?

A changed head, target, policy, Work Accord, lease, Project binding, App
installation, key, generation, budget, required check, or administrative
precondition requires fresh evidence and, where applicable, a new human
confirmation.

## Security and identity questions

### 31. Why use a GitHub App instead of a PAT?

A GitHub App supports installation-scoped identity, explicit permissions,
short-lived tokens, repository selection, and auditable ownership. PATs are
user-bound, often broader, and are explicitly unsupported as a fallback.

### 32. What permissions does the App need?

Use only the operation-specific union in
`docs/security/github-app-permissions.md`. Typical needs include repository
metadata, Issues, pull requests, checks, organization Projects, and organization
membership reads.

Administration, Actions administration, deployments, workflow modification,
repository hooks, and organization administration are denied by the plan.

### 33. Where is the App private key stored?

Store it in customer-controlled HSM/KMS/vault custody behind the trusted token
broker. The key must never enter the repository, an Actions model job, a prompt,
an issue, a log, or a generated artifact.

### 34. How is OIDC used?

Actions jobs request OIDC only to call exact customer trust services. Each
service validates a narrow audience and repository/workflow/run subject before
returning a signed authorization or performing its bounded responsibility.

Wildcard repository or workflow subjects are not acceptable.

### 35. What signing keys are required?

Separate keys are used for runtime state, authorization, threat/evidence,
provider usage, budgets, operation grants, and effects as defined by the
deployment design. Public verification keys and key status are retained with
evidence; private material remains in customer custody.

### 36. How are keys rotated?

Publish and review the new public key first, stop old-key signing, retain old
verification keys through the longest evidence lifetime, and revoke affected
authorizations/generations. Existing signed evidence is never re-signed.

### 37. How are secrets kept away from models?

Model jobs receive no App key, installation token, PAT, OIDC token, mutation
tool, or arbitrary secret. Execution also clears common GitHub token environment
variables and uses target-free logical slots.

### 38. How is prompt injection handled?

Repository, issue, diff, and model-visible text are treated as untrusted data.
They cannot expand tools, targets, credentials, policy, or effects. Output must
match closed schemas, pass threat detection, and be translated by trusted code.

### 39. What happens when threat detection is unavailable?

The operation blocks. A timeout, warning, skip, cancellation, malformed result,
stale digest, or missing result cannot be treated as success.

### 40. How does the framework prevent replay?

Runtime authorization binds a one-time nonce and exact workflow run/attempt.
Durable stores use conditional append or compare-and-swap, signed predecessor
heads, operation-specific idempotency keys, and exact target identities.

## Data, privacy, and compliance questions

### 41. What customer data should be used in the first evaluation?

Use synthetic issues, repositories, and artifacts only. Do not begin with
customer confidential source, credentials, personal data, regulated data,
incident payloads, or sensitive logs.

### 42. What data can enter model context?

Only the bounded context authorized for the selected stage should enter model
context. Exact effect targets and credentials stay in trusted boundaries.
Customer policy decides which source classifications and providers are allowed.

### 43. What must never be committed?

Never commit credentials, private keys, tokens, live customer node IDs,
customer-identifying exports, private network links, confidential logs, raw
model responses containing sensitive data, or protected evidence.

### 44. What does `validate:customer-readiness` inspect?

It scans every tracked or newly added file for source organization bindings,
private GitHub or Slack links, live Project node
IDs, and source issue/PR history references. It fails closed with file and
line findings.

It complements, rather than replaces, secret scanning, history scanning,
privacy review, and human inspection.

### 45. Where should live IDs and evidence be stored?

Store them in protected customer administrator workspaces and evidence systems
with access controls, encryption, retention, and audit logging. Repository
fixtures use synthetic identities.

### 46. What logs are safe to retain?

Prefer fixed reason codes, bounded counters, timestamps, and cryptographic
digests. Avoid prompts, responses, repository names, paths, URLs, user-provided
labels, credentials, and raw customer content.

### 47. How should retention be set?

The customer sets retention according to legal, privacy, security, audit, and
recovery needs. Evidence verification keys must remain available for at least as
long as the signed evidence they verify.

### 48. Does a clean scan prove legal or privacy approval?

No. Scans can find known patterns; they cannot establish ownership, licensing,
privacy compliance, acceptable data use, or complete absence of sensitive
information. Authorized reviewers make those decisions.

### 49. How is third-party dependency information handled?

The lockfile records package metadata, and release/customer-starter tooling
generates an SPDX SBOM. Customers should run their approved dependency,
vulnerability, and license review on the exact copied head.

### 50. Can evaluation evidence be shared back?

Only through a customer-approved feedback channel and after redaction. Share
outcomes, reason codes, bounded metrics, and non-sensitive observations rather
than credentials, customer source, internal URLs, identities, or raw logs.

## Technical implementation questions

### 51. What toolchain is required?

Use the exact versions or supported ranges in
`config/v1alpha1/compatibility.json`. The repository currently validates Node.js
24 or 26, npm 11, Git 2.46 or newer, GitHub CLI 2.96.0, the pinned Agentic
Workflow compiler, and the pinned Copilot CLI for the controlled review probe.

### 52. What should we run first?

Run the initial content checks:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:customer-readiness
npm run typecheck
npm run build
npm test
```

After the clean initial import commit, run `npm run customer:repin`, review and
commit the two selection files, then run the complete matrix in
`CUSTOMER_EVALUATION_GUIDE.md`.

### 53. Why are generated workflow lock files checked in?

The Markdown workflow sources are reviewed, and the pinned compiler produces
deterministic `.lock.yml` files. Validation recompiles and rejects byte drift so
the executable workflow cannot silently diverge from source.

Never hand-edit a generated lock.

### 54. How do workflows target the customer repository?

Workflow tool and safe-output policies use the trusted
`${{ github.repository }}` context. They do not contain the source repository
name. Runtime state and current API reads still bind the exact numeric/node
repository identity before privileged work.

### 55. How do we generate the Project target manifest?

Export four fresh empty Project admin snapshots and run
`npm run github:setup -- target-manifest` as shown in the evaluation guide. The
tool validates freshness, order, owner/repository consistency, titles,
visibility, linkage, empty state, and initial view shape.

An independent human then confirms the manifest digest used by
`bootstrap-plan`.

### 56. Why is a confirmed target-manifest digest required?

Without it, a caller could substitute a different valid-looking Project
manifest. The digest makes the exact human-reviewed owner, repository, Project,
and view identities an input to the dry-run plan.

### 57. What does the synthetic canary do?

It composes the governed demo journey with durable local adapters, restarts,
faults, backup/restore, budget handling, and target-free evidence under a
credentialless child environment and Node network deny guard.

It performs no live GitHub, App, Project, provider, billing, or administrative
effect.

### 58. What does the administrator handoff do?

It validates the fixed plans and contracts, repeats the synthetic canary,
verifies customer-starter packages, exercises the plan/confirm/readback
protocol, and emits a synthetic-unconfigured list of human gates.

It does not import source-organization observations or apply customer changes.

### 59. How are ambiguous writes handled?

Do not blindly retry. Disable the affected writer, perform stable authenticated
readback, preserve evidence, and reconcile only when exact persisted state proves
the prior or intended outcome. Otherwise remain blocked for human recovery.

### 60. What happens when a service is unavailable?

The dependent route fails closed. There is no local, unsigned, ambient-token,
model-job, alternate-provider, default-store, or success-shaped fallback.

## Operations, support, and decision questions

### 61. What should be monitored?

Monitor service health, latency, error rate, replay rejection, signing failure,
store availability, journal capacity, budget exhaustion, authorization refusal,
effect/readback mismatch, stale bindings, and canary stage.

### 62. What should trigger a pause?

Pause on stale or changed head/target/policy, missing checks, unhealthy trust
services, key or credential concern, unknown provider usage, budget alert,
unexpected Project drift, ambiguous effect, or incomplete evidence.

### 63. What is the kill switch?

Disable new activation, stop the Single Writer, revoke leases,
authorizations/tokens/keys, preserve evidence, and reconcile already-started
provider usage without advancing state. Project card movement is not a kill
switch.

### 64. How do backup and restore work?

Back up the signed evidence chain, store heads and records, Kernel/run state,
bindings, public keys, software/config digests, and retention metadata. Restore
into disabled services and authenticate every sequence, predecessor, signature,
target, generation, and digest before enabling reads.

### 65. How do we roll back?

Rollback is a new human-authorized operation. Use an explicit reversible
migration path, fresh target/head/state evidence, a current backup, a newly
confirmed plan, one bounded apply, and complete readback.

### 66. How do we uninstall?

Use the customer administrator runbook. Removal is limited to exact
package-owned files whose path, digest, mode, and size match the installed
manifest. Preserve customer content, GitHub history, evidence, backups, and
receipt chains.

### 67. What support model is included?

The repository provides documentation, deterministic diagnostics, typed refusal
codes, and evidence expectations. Each customer must define its evaluation
contacts, coverage hours, escalation channel, response expectations, and owners
before activation.

### 68. Is there an SLA?

No customer SLA is defined by the repository. If the customer proceeds beyond
evaluation, its service owners must define availability, recovery, support, and
change-management objectives for the deployed components.

### 69. How should customers provide feedback?

Use a customer-approved issue or feedback channel with no confidential data.
Include the exact copied version/commit, affected stage, expected and observed
behavior, typed reason codes, redacted evidence digests, business impact, and
suggested outcome.

### 70. What is the final adoption decision?

The customer sponsor, security, platform, operations, billing, legal/privacy,
and engineering owners review the evaluation evidence and decide whether to
stop, extend the evaluation, change the architecture, or adopt a governed
operating model.

The framework never makes that decision for them.
