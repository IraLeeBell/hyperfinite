# GitHub control-plane adapter

## Status

The local adapter foundation is **current**. It defines strict contracts, verifies webhook provenance, resolves Trusted Binding through fresh reads, produces target-bound Effect Plans from target-free safe output, and supplies fail-closed Single Writer orchestration over an injected GitHub API.

It does not install a GitHub App, hold a private key, mint a live token, create or migrate a Project, run a daemon, invoke a model, or mutate a production system. Those actions require a separately reviewed deployment and explicit human administration.

The authoritative repository separately contains an upstream-only issue-taxonomy
reconciler. It is not a model route or Control Kernel effect: reviewed
configuration fixes the one repository numeric/full-name identity, three label
definitions, historical issue numbers, title prefixes, and execution bounds.
The workflow runs only from the exact default-branch revision after a merge or
from `issues.opened`, fresh-reads every issue before mutation, removes only
conflicting taxonomy labels, preserves unrelated labels, and requires exact
readback. Unknown titles, wrong repository/event/ref identities, malformed API
responses, drift, pagination overflow, and partial readback fail closed.

## Versioned contracts

The adapter adds closed JSON Schemas for:

- declarative `GitHubProjectSchema` documents containing logical owner, Project, field, option, and projection names but no live IDs;
- fresh Project API snapshots and validated `GitHubProjectBinding` manifests containing the resolved installation, owner, Project, field, and option IDs;
- target-free `GitHubSafeOutput`; and
- deterministic `GitHubEffectPlan` documents; and
- App-attributed, cryptographically authenticated, append-only
  `GitHubEffectEvidence` envelopes.

Every contract uses the retained
`agentic-framework.github.com/v1alpha1` technical compatibility identity,
rejects unknown properties, and participates in the same strict AJV validation
boundary as the kernel contracts. Hyperfinite does not introduce a second API
epoch. Project export/import binds a live manifest to the declarative schema
digest. Project migration hooks double-run migrations and compare canonical
digests before returning a dry-run result.

## Project validation and setup

`config/v1alpha1/github-project.json` is a reusable logical schema.
`config/v1alpha1/demo-projects/*/project-schema.json` adds exactly four
Foundation-bound demo schemas. Each declares fifteen Project fields, separates
the human-editable Requested Stage Agent input from fourteen trusted
projections, preserves the core Stage options, derives Journey Stage options
from identity reservations, requires an explicit supported display color on
every single-select option, records projection sources, and writes Kernel Stage
last. Live snapshots and bindings retain exact option names, colors,
descriptions, and node IDs. Color is not consumed by projection or effect
translation.
`planProjectSetup()` compares one schema to a supplied fresh Project snapshot
and either:

1. emits a fully validated binding manifest; or
2. emits human-admin actions for missing Projects, fields, or options and
   reconciliation actions for incompatible name, order, color, description, or
   type drift.

`validateDemoProjectSchemaCatalog()` and `planDemoProjectCatalogSetup()` apply
the same checks in canonical Foundation order. Catalog export/import binds the
Foundation catalog digest and each optional live binding to its exact schema.
The declarative `OWNER` value is a template: a dry-run plan may reflect the
owner from its supplied authenticated snapshot, but no effect consumes that
reflection as target authority.
The planner never executes an action. Project creation, schema changes,
migration, App installation, rulesets, visibility, teams, billing, and
enterprise policy remain outside the adapter.

`createDemoProjectTargetManifest()` derives a target-manifest proposal from four
fresh, empty, private customer Project snapshots in catalog order. An
independent human confirms its digest. Each target entry binds its exact
Project-schema digest. `planVerifiedDemoProjectBootstrap()`
requires that exact digest plus the reviewed owner, repository, Project
numbers/node IDs/titles/view IDs, repository link, zero-item precondition, fresh
observations, and declarative schemas. It emits a content-digested plan only.
`reconcileVerifiedDemoProjectBootstrap()` requires the confirmed plan digest and
compares descriptions, READMEs, every field/option name, color, description, and
node identity, synthetic issues, and visibly prefixed draft items after apply.
Unknown fields, duplicate identities, or target drift block rather than delete
or substitute.

The four demonstration issue forms are static entry points into a deterministic intake
preflight. The form-to-profile mapping is trusted configuration; issue text,
including the repository hint, remains bounded data. The preflight validates
the exact Foundation catalog/profile relationship, activation status, numeric
submitter authorization, consent, fixed budget, resolved repository binding,
fresh Project binding, depth allowance, and content byte limits before any
credential, reservation, or inference boundary. A successful preflight only
reports readiness for Kernel activation and grants no authority. Missing
information produces one typed, digest-bound blocked artifact; it does not parse
punctuation or create another issue.

Requested Stage Agent observations are normalized at a separate boundary. They
remain data until `resolveStageAgentSelection()` validates the exact Project
item, actor, stage, policy, Work Accord, Phase Contract, capability, lease,
budget, generation, receipt head, and PR head and signs one exact-agent grant.
No raw Project string reaches dispatcher authority.

## Verified events and Trusted Binding

`normalizeGitHubWebhook()` verifies the raw request body with `X-Hub-Signature-256` before parsing or reading GitHub. It supports issue and pull-request events and binds:

- webhook delivery ID, event, action, sender numeric ID, sender node ID, and payload digest;
- installation ID, installation account node ID, selection mode, and repository scope;
- repository numeric ID, repository node ID, owner, name, and full name;
- issue or pull-request number and node ID;
- Project owner, Project, item, schema, complete field/option mapping, and
  binding digest; and
- for pull requests, exact base and head repository numeric/node identities, refs, and SHAs.

The payload is not authority by itself. Every repository, work item, installation scope, Project item, Project field/option mapping, and pull-request head is compared with a fresh API read. Forks are accepted only when payload and fresh state agree on the complete base/head repository identities, refs, and SHAs.

## Authentication boundary

`GitHubAppSigner` and `InstallationTokenMinter` are credential boundary interfaces. The adapter passes a backdated, at-most-ten-minute RS256 App identity request with the configured client ID, then requests one installation grant for exactly one bound repository and one effect permission set. The grant is rejected unless:

- installation ID equals Trusted Binding;
- repository scope contains only the bound repository;
- returned permissions exactly match the requested manifest; and
- expiry is current and no more than one hour away.

No personal access token or `GITHUB_TOKEN` path exists. The credential callback exposes only an authenticated `GitHubApi`; token values and private-key material are absent from adapter, safe-output, and model-facing types.

## Safe output and Effect Plans

`GitHubSafeOutput` permits only summary, findings, open questions, and result data. Repository names, issue numbers, branches, Project IDs, effect names, and arbitrary commands are unknown properties and fail validation.

`translateSafeOutput()` accepts a conventional effect intent selected outside model output. It resolves all target IDs from Trusted Binding and the validated Project binding, then derives the idempotency key from:

- Trusted Binding digest;
- event identity;
- contract revision;
- route ID;
- attempt ordinal; and
- allowlisted effect type.

The current allowlist is issue comments, `COMMENT`-only pull-request reviews and
check runs on an exact pull-request head, and updates to already-bound Project
field values. There are no approval, request-changes, review-dismissal, merge,
ruleset, administration, deployment, visibility, or publication operations.

## Copilot runtime bridge

The Copilot runtime adds a model-facing boundary without changing adapter
authority.
`validateRuntimePreActivation()` binds an explicitly enabled default-branch
slash-command run to stable, unedited, Ed25519-signed App-authored runtime state,
an allowlisted human, exact repository/work-item identities, policy and lease
digests, current head, full cost, and loop limits. An OIDC-authenticated trusted
redeemer then freshly verifies Project membership and revocation, atomically
consumes the signed nonce and run attempt, reserves the full cost with CAS, and
returns a signed authorization. `bindKernelAuthorization()` verifies that
authorization and requires an applied Control Kernel receipt that grants the
exact route and phase capability.

`bridgeRuntimeOutput()` accepts only a closed, target-free
`GitHubSafeOutput`. It rejects an invalid signature, changed authorization or
redemption digest, replayed/substituted run/attempt/nonce, unbound route or
receipt, any Trusted Binding whose full digest differs from authorization, any
threat status other than exact `success`, mismatched input/output digests, and
stale or expired evidence. It returns an issue comment or `COMMENT`-only
pull-request review Effect Plan through
`translateSafeOutput()`; it does not mint credentials or mutate GitHub.

Agentic Workflow safe outputs remain staged because the platform's warning
state is not the framework's semantic write gate. A deployment must pass the
bridge's Effect Plan to the same Single Writer and authenticated evidence chain
described below. The model job never receives the App signer, installation
token, or writer.

## Hermetic engineering delivery

`EngineeringGitHubAdapter` is the typed in-memory boundary used by the hermetic
end-to-end harness. It retains one canonical Issue/Project binding and
adds an optional pull-request binding only through a receipt-backed CAS. Its
closed effect union covers branch creation, commit creation, draft-only pull
request creation, binding, `COMMENT` review, Project convergence, Issue closure,
delivery evidence, and operations handoff. Every effect has a trusted ordinal, type, workflow identity,
and contract revision in signed evidence;
the idempotency key does not reuse a workflow run attempt as the logical effect
subkey.

The adapter validates exact base/head refs and SHAs, patch/tree digests, work
identity, current head, draft metadata, signed authorization, and exact-success
threat evidence before asking an operation-scoped broker for a GitHub client.
Commit delivery receives the signed patch bundle rather than digest-only
metadata. The delivery client applies it to the exact parent tree and returns a
typed observation containing the fresh commit/tree/blob identities and
canonical content and patch digests. Every other effect likewise returns a
typed target-specific observation; a wrong-target, stale, or stable no-op
observation cannot complete an effect.
Authorization is reissued and revalidated immediately before each write. It
fresh-reads before mutation, reads after write, and records signed
pending/rejected/completed/partial evidence through conditional append.
Definitive pre-write rejections are retryable; any failure after a write attempt
remains partial and requires deterministic reconciliation. It exposes no
approve, request-changes, dismiss, auto-merge, merge, ruleset, deployment,
release, or publication operation. `pull_requests: write` remains a
platform-broad deployment permission, so human-admin rulesets and independent
human merge are mandatory.

This boundary demonstrates deterministic semantics only. The production App,
credential broker, signer, conditional evidence store, durable operation-grant
claim store, serialization, and API transport remain undeployed.

Provider attempts bind projected cumulative calls, tokens, and cost. Trusted
code performs its final mutable head read, then fresh-reads the signed
nonrevoked lease and validates the attempt, grant, phase, capability, expiry,
and cumulative ceilings immediately before inference. Awaiting-human,
pre-release, closure, settlement, and release evidence is durable until its
explicit signed expiry rather than the short freshness window used for mutable
authorization. Resume still fresh-reads policy, lease, head, approval, and merge
state before any later effect.

The execution bridge persists one closed, signed bundle containing the runtime
authorization, actual applied Kernel result, current runtime and Control Policy
digests, exact-success threat evidence, and the full-content signed patch
artifact. The artifact binds the exact Work Accord revision, plan, grant, base
SHA, resulting tree, model output, threat evidence, and Kernel proof.
The post-upload workflow step is disabled unless both the trusted delivery URL
and OIDC audience are configured. It sends no patch or App credential; it sends
the authenticated repository/workflow/run identity plus the exact artifact ID,
archive digest, and bundle digest. `consumeTrustedExecutionArtifact()` requires
the trusted service to download the raw ZIP bytes, recomputes the archive
SHA-256, extracts exactly one bounded canonical bundle file with ZIP length/CRC
validation, validates the runtime policy before artifact use, derives the sole
freshness window from its authenticated `limits.maxEvidenceAgeMs`, and binds its embedded runtime
authorization to the OIDC workflow identity, and then
`consumeTrustedExecutionBundle()` and `consumeTrustedPatchArtifact()` revalidate
every inner binding and the independent ages of the authorization, applied
Kernel proof, threat evidence, patch artifact, signed patch bundle, and outer
bundle immediately before delivery. Legacy caller-supplied freshness limits and
adapter/delivery clocks are rejected. The consumer issues one opaque,
module-private capability registered in a runtime identity set; no public or
deep-import API can mint it, and structural lookalikes, no-op checkers, and
substitute clocks fail the adapter guard. The capability binds the policy
digest, authorization/redemption and run identity, Kernel receipt, validated
policy limit, trusted clock, and full runtime-evidence freshness check.
`EngineeringDraftPullRequestDeliveryPort` passes that same
context through every concrete branch, signed-patch commit, draft pull-request,
and binding effect. The adapter rechecks it immediately before mutation and
uses it for delivery authorization, threat, patch-bundle, and persisted-effect
evidence; no downstream caller can enlarge the window or substitute a clock.
Completion requires a canonical binding-store readback equal to the exact CAS
rebind; an observation that did not persist the binding fails. A
copied receipt digest without the authenticated applied result never authorizes
delivery.

Before credentials are requested, the Single Writer requires exact equality for
every concrete Effect Plan target: repository numeric/node/name identity,
issue/PR kind, number and node ID, pull-request base/head repository/ref/SHA,
review event, review/check head SHA, and Project owner/project/item/field/option identity. The
same comparison runs again against fresh state immediately before mutation.
Project write permission is therefore requested only after the effect matches
the reviewed Project binding and its complete field/option mapping.

## Single Writer and replay

`GitHubSingleWriter` performs the following sequence:

1. validate the Effect Plan, Trusted Binding digest, and every concrete target;
2. require an evidence signer, verifier, expected numeric App/bot identity, and
   authenticated conditional evidence store;
3. obtain a short-lived, downscoped installation client;
4. fresh-read binding, Work Accord digest, receipt head, Project schema digest, and pull-request base/head;
5. verify the complete oldest-to-newest evidence chain and its authoritative head;
6. conditionally append and uniquely re-read a pending claim bound to a caller-supplied
   claimant nonce and operation digest;
7. repeat the fresh-state checks immediately before mutation;
8. compare the current Project field value when applicable;
9. conditionally append the write-attempt transition;
10. execute one allowlisted effect;
11. read after write and compare the canonical effect digest; and
12. conditionally append the completed transition.

Every evidence read verifies the closed schema, exact configured numeric App and
bot author identities, cryptographic signature, immutable plan and binding
identity, state invariants, prior authenticated digest, monotonic sequence, and
the store's authoritative head. Every transition is a new signed record appended
against the exact authenticated head; records are never updated in place.
Missing authentication or conditional-append support fails before token minting.
A changed head is re-read and never permits a new effect in the conflicted
invocation. A conflict after an effect may have occurred is partial unless the
conflict-reported and freshly read authenticated heads prove the exact signed
completed transition. Identical claim or attempt payloads never authorize a CAS
loser to mutate.

Completed evidence makes duplicate delivery a no-op only when its effect digest
exactly matches the planned effect. Multiple records at one sequence, rollback,
reordering, stale state, another claimant's pending record, or an unresolved
pending claim fail closed. An ambiguous claim acknowledgement is accepted only
when two authenticated reads prove one stable head with the exact claimant and
operation digests. The claim is passed through the same
completed/partial/pending/retryable state machine. Exact completed evidence
replays, partial evidence fails, and an unresolved owned pending or retryable
claim returns
`CLAIM_RECONCILIATION_REQUIRED`; an ambiguous claim-create invocation never
proceeds directly to mutation. Ambiguous write acknowledgements are reconciled
by reading the intended effect before any retry. Definite retryable rejections retain the owned claim, write-attempt count, and
the complete server-provided retry delay for a fresh invocation. Every persisted
evidence state authenticates its timestamps, retry deadline, attempts, error
classification, target binding, and prior version before state handling.
The writer enforces `updatedAt + retryAfterMs`, reports in-policy delays with
`RETRY_NOT_BEFORE`, and does not remint a token for an immediate same-writer
retry. A server deadline beyond automatic policy is never shortened; it returns
`EXTERNAL_RETRY_WINDOW` and requires a fresh invocation after the full deadline.
Ambiguous or unobserved outcomes become partial and are never blindly retried. A
recovered pending claim with a prior write attempt and no matching observation
also becomes partial rather than risking a duplicate mutation.

Domain repository packaging additionally requires a
`DomainOperationGrantStore` implemented by a separate trusted service. Its atomic
cross-process claim follows an authenticated head read, distinct unpredictable
head and claim challenges, and expected-head/sequence compare-and-swap. It
returns a signed, hash-chained `DomainOperationGrantClaim` with exact `appended`
status; the local packager validates the challenges and transition and binds its
digest into the package receipt before ref mutation. There is no process-local
replay fallback.

Draft pull-request completion separates immutable creation evidence from mutable
fresh state. The signed effect and completed observation retain the exact
creation-time base SHA. Replay requires the same repository, pull-request node
and number, base repository/ref, head repository/ref/SHA, draft/open state, and
canonical binding. Its fresh aggregate also revalidates repository numeric,
node, and full-name identity; Issue number/node; Project owner/node/item; and
the current one-revision PR-bound canonical binding digest. Only the PR base-tip SHA may advance. Initial
creation still requires the authenticated default-branch SHA before mutation;
changing the base repository/ref or any head identity is never treated as a
base-tip advance. This exception exists only while re-observing an already
completed draft-PR effect. Active verification, COMMENT review, human approval,
merge observation, closure, pre-effect delivery, and pending-effect
reconciliation require the live base SHA to equal the bound creation SHA.

The exported concurrency key is exact to repository numeric ID and work-item node ID. A deployment must use it with cancellation disabled. GitHub does not provide a universal atomic compare-and-swap for these writes, so a small platform-side race remains and is handled by duplicate-claim detection and reconciliation rather than optimistic success.

## HTTP operations

`GitHubHttpOperations` uses an injected authenticated transport and always sends:

- `Accept: application/vnd.github+json`;
- `User-Agent: agentic-framework-github-adapter/1.0`; and
- `X-GitHub-Api-Version: 2026-03-10`.

It implements exact repository, issue, pull-request, comment, check-run, collaborator, organization membership, team membership, review, Project item, and Project field operations. GraphQL responses with HTTP 200 and a non-empty `errors` array are failures. Error types distinguish forbidden, missing, gone, invalid, rate-limited, server, timeout, GraphQL, and malformed responses.

Rate limits are recognized on HTTP 429 and on HTTP 403 when GitHub supplies a
valid `Retry-After`, an exhausted primary-limit/reset pair, or the documented
primary/secondary rate-limit response text. Server deadlines are preserved
without truncation; delays outside automatic policy defer closed rather than
retrying early. Malformed or overflowing headers fail closed and do not turn an
ordinary authorization failure into a retry.

## Residual boundaries

- GitHub comment records can be edited or deleted by privileged humans. Signatures detect edits, while deleted or rolled-back tails are detected only when the deployment's authenticated conditional store preserves an authoritative head outside the mutable comment sequence.
- Project field mutations lack a universal atomic compare-and-swap. The adapter fresh-reads immediately before mutation and verifies after mutation.
- A deployment must implement evidence signing and verification with secure key custody, preserve the authenticated conditional head, implement token signing/minting with secure sign-only key storage, and serialize by the exported concurrency key. The framework does not supply or expose those keys.
- Human administrators must create/install the App, configure permissions and webhook secrets, create or migrate the Project, and review every reported drift action.
