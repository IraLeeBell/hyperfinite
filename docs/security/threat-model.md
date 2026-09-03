# Threat model

## Status

**Current for the governed architecture.** The
repository composes the deterministic kernel, offline adapter,
disabled-by-default Agentic Workflows, exact-slot worktree executor, signed
cost/effect evidence, comment-only review, independent human-merge observation,
closed audit/metric/budget evidence, durable operation-grant claim boundary, and
delivery closure in network-free tests. Live App installation, trust services,
billing, durable service deployment, Project/rulesets, and repository
protections remain human-administrator work.

## Scope

The target system is a GitHub-native control plane coordinating model-assisted work across Issues, Projects, pull requests, Actions, Agentic Workflows, and future Domain Packs. It excludes external publication, deployment, production mutation, CRM/ERP, payment, and customer communication.

## Security objectives

- Preserve human control over activation, administration, review, approval, merge, release, and licensing.
- Prevent untrusted content or models from selecting targets, authority, transitions, capabilities, retries, or effects.
- Bind all evidence to immutable identities, contract revisions, and current SHAs.
- Make every privileged effect attributable, replay-resistant, least-privileged, and reconstructable.
- Fail closed on ambiguity, stale state, unavailable detection, or partial failure.

## Assets

- repository contents and protected branches;
- issues, sub-issues, dependency graph, Projects, pull requests, reviews, and checks;
- Work Accords, Phase Contracts, policy, Capability Registry, Domain Packs, and Depth Profiles;
- GitHub App keys, installation tokens, model/provider credentials, secrets, and budgets;
- evidence receipts, logs, attestations, and provenance records;
- human identities, team membership, repository roles, and approval history;
- confidential source, customer, employee, operational, and prompt data.

## Actors

- authorized requester, reviewer, maintainer, repository administrator, organization/enterprise owner, and legal/OSPO owner;
- GitHub App and bounded Actions jobs;
- model provider and model-driven worker;
- third-party capability, MCP server, network service, dependency, and action;
- malicious outsider, compromised contributor, compromised maintainer, malicious insider, and supply-chain attacker;
- accidental operator or automation error.

## Trust boundaries

| Boundary | Risk |
|---|---|
| GitHub event to trusted adapter | Forgery, replay, wrong installation/repository, stale payload |
| Untrusted content to model | Prompt injection, data/instruction confusion, exfiltration |
| Model output to adapter | Target injection, invalid schema, hidden effect requests |
| Kernel to capability | Permission expansion, confused deputy, budget bypass |
| Trusted job to GitHub API | Over-scoped token, TOCTOU, partial mutation |
| Parallel workers to fan-in | Nondeterminism, collision, poisoned artifact |
| GitHub evidence to receipt chain | Edited/deleted comments, stale review/check |
| Dependency/action/MCP/network boundary | Compromise, egress, unreviewed updates |
| Release governance | License, trademark, privacy, secret, or provenance failure |
| Package to customer target | Wrong tenant/repository/ref/head, privilege collapse, migration replay, destructive uninstall |
| Source tree to release bundle | Traversal, links, type/mode drift, dependency or attestation substitution |

## Assumptions

- GitHub platform identity and API responses are authoritative after successful authenticated reads.
- Protected default-branch policy is configured by humans; the framework cannot guarantee controls that administrators decline to enable.
- Actions runners and model providers are not trusted with durable authority.
- A human approval is evidence only after current authorization and exact-head validation.
- Private repository visibility does not resolve license grants or provenance.

## Threats and misuse cases

### T01 Prompt injection and instruction/data confusion

Issue bodies, comments, diffs, repository files, web results, and MCP output can instruct a model to ignore policy, leak data, alter targets, or invoke tools.

### T02 Confused deputy and target injection

A model or untrusted artifact can redirect a valid credential toward another repository object, branch, Project field, or external destination.

### T03 Over-scoped or long-lived credentials

A PAT, broad App token, inherited workflow token, or credential exposed to a model could perform unrelated mutations.

### T04 Replay, duplicate delivery, and reordering

At-least-once webhook/workflow behavior can repeat effects or apply an older event after newer state.

### T05 Race and stale-state decisions

Issue state, contract revision, Project schema, base branch, PR head, checks, permissions, or reviews can change between evaluation and effect.

### T06 Forged or stale human approval

An `APPROVED` review may be from the requester, bot, user without current permission/team eligibility, or a previous head SHA.

### T07 Self-approval, self-merge, or policy bypass

Automation may acquire review/merge/bypass permission, weaken rules, or satisfy its own gate.

### T08 Threat-detection fail-open

A job can complete successfully while semantic detection returned warning, malformed output, skipped execution, timeout, or cancellation.

### T09 Tool, shell, MCP, and network abuse

A capability may execute an undeclared command, contact an unapproved endpoint, invoke an unsafe MCP tool, or exploit setup processes outside an egress control.

### T10 Secret and confidential-data exfiltration

Prompts, logs, artifacts, patches, model context, or network calls may expose tokens or protected data.

### T11 Artifact and evidence poisoning

Generated patches, reports, checks, comments, logs, or provenance can be fabricated, altered, truncated, or associated with the wrong subject.

### T12 Workflow, policy, or supply-chain tampering

An attacker can alter workflow source/lock artifacts, Actions, packages, model configuration, registry entries, or compiled policy.

### T13 Cross-domain privilege escalation

A Domain Pack or lower-risk Depth Profile may broaden capabilities, effects, data access, or gates.

### T14 Unbounded cost or denial of service

Recursive agents, retry storms, decomposition, oversized inputs, concurrency, or malicious events can exhaust budgets and runners.

### T15 Unsafe partial failure and recovery

One of several GitHub mutations may succeed, and automatic retry may duplicate or corrupt state.

### T16 Audit gap or non-reproducible decision

Missing raw inputs, model/provider identity, contract digest, policy version, current SHA, or effect receipt can prevent incident reconstruction.

### T17 License, trademark, privacy, or publication violation

Automation may copy uncleared material, change license/visibility, publish externally, or process data beyond approved purpose/retention.

### T18 Model collusion and weak independence

Multiple roles using the same model/context can present correlated output as independent review.

### T19 Executable-ref, authorization, and budget replay

A manual dispatch can select attacker-controlled workflow code; a caller can
forge an unkeyed authorization digest; or a valid signed state/lease can be
reused across sequential or concurrent runs without consuming its budget.

### T20 Project-read authority and state-pagination race

A guard can silently lack Projects v2 authority, expose that authority to the
model, or select a state marker while the comment set, ETag, or pull-request head
changes.

### T21 Domain evidence, privacy, and authority laundering

Marketing content can launder mutable research, unsupported claims, copied
rights, personal targeting data, or advisory model review into apparent
brand/legal readiness. Business Operations content can launder repository
permission, role aliases, fabricated consensus, invalid process graphs,
unverified baselines, or simulation steps into apparent policy or operational
authority. Caller mutation after validation, a substituted pack, phase, rubric,
schema, or capability can bypass
the intended review, while replayed grants, self-asserted roles, pre-issued
approvals, prompt-injected generated artifacts reaching a second model, or
unavailable classification can create false readiness.
Duplicate profile IDs can also make trusted profile selection depend on array
order. Phrase deny lists can miss semantically equivalent live commands such as
`kubectl apply` or authority claims such as “brand approved” and “legally
cleared.” The runtime therefore rejects non-canonical profile cardinality and
requires signed, independent, exact-artifact semantic policy evidence rather
than accepting phrase matches or model self-attestation.

### T22 Observability leakage and metric-cardinality exhaustion

Raw prompts, responses, credentials, actor/repository identifiers, paths, or
attacker-selected labels can leak through logs or create unbounded monitoring
cost. Nondeterministic serialization can also make evidence irreproducible.

### T23 Cross-process grant replay

A valid operation grant tracked only in process memory can be reused after a
restart or by another worker, authorizing a duplicate repository effect.

### T24 Installer target, privilege, and migration confusion

An installer can infer a customer target, expose credentials to a model, apply a
stale plan, skip migration edges, downgrade through an irreversible step, replay
a receipt, exhaust memory with an unbounded receipt journal, mistake structural
linkage for authenticated history, accept a self-rehashed noncanonical action
plan, let authorization expire during awaited checks, mislabel offline checking
as live validation, blindly retry a lost acknowledgement, or recursively delete
customer content during uninstall.

### T25 Release archive and attestation confusion

A release archive can traverse paths, follow links, carry unexpected types or
modes, drift from the source/lockfile, bind the wrong base/head/version, or
accept a schema-valid path whose UTF-8 bytes have no canonical ustar name/prefix
split, present unsigned/model-generated evidence as a trusted signature, or
claim a release decision.

### T26 Demo stage identity, overlay, and projection confusion

A noncanonical catalog, reused agent, cross-demo capability/workflow, generic
template fallback, self-declared workflow class, stale stage receipt, or Project
field can be substituted as journey authority. Same-core overlays can falsely
increment Kernel state, while a fabricated or mismatched Kernel receipt can
advance across states. A partial shard can also make validation depend on which
other demo happens to be installed.

### T27 Demo issue-form and Project UX authority confusion

An edited or substituted issue form can claim another demo profile, treat a
repository hint as a target, bypass consent, request an unauthorized depth, or
smuggle oversized content toward inference. A disabled or expired activation
profile, unauthorized submitter, missing fixed budget, unresolved repository
binding, or stale Project binding can be overlooked. Project card movement,
dashboard state, or a free-form clarification heuristic can then be mistaken for
Kernel authority or trigger an untracked recovery issue.

### T28 Hybrid agent selection and live Project bootstrap confusion

An unauthorized actor, bot, issue string, model output, stale Project read, or
wrong-stage option can be treated as permission to choose an agent. A valid
selection can be replayed across projects, items, runs, attempts, generations,
receipt heads, policies, leases, budgets, or pull-request heads, or changed
during inference to retarget an in-flight run. Candidate-catalog or policy drift
can create a confused deputy. Separately, an administrator can apply a Project
plan to a renamed, transferred, public, closed, unlinked, or substituted
Project, infer success from mutation responses, or seed cards that appear to be
runtime evidence.

### T29 Deployment topology, App registration, and administrator plan confusion

A deployment topology, GitHub App registration, or administrator plan
document can omit, duplicate, or add an independent trust-service identity,
durable store, required check, ruleset, environment, or protection scope
while still parsing as a superficially valid document if only per-item shape
is checked. A plan can also declare distinct services or durable stores that
still share one signing key, OIDC audience, backend namespace, or credential
identity, claiming independence that is not structurally enforced. A plan's
retention set can declare a conflicting duplicate window for the same
artifact kind — for example two `signed-evidence` entries with different
retention bounds — that a naive `Set` built only from `artifactKind` values
would treat as ordinary membership and never flag as a conflict. A
permission readback can request or observe a permission on the reviewed
denied list, request an elevated level where only read was needed, request a
downscoped level where write was required, add a permission absent from the
least-privilege plan, or silently omit a required permission so a bound
operation later fails open instead of closed. A readback can also be bound
to the wrong installation target — a different owner, App, installation, or
selected-repository set than a human actually approved — while a mutable
display name coincidentally still matches, or it can be accepted outside any
freshness bound, letting a stale or future-dated observation stand in for a
current one. An administrator readback can report a ruleset that is not
active, carries a bypass actor, or is entirely absent while the comparator
infers success from a partial observation; a ruleset named for the default
branch can have its ref conditions quietly repointed at a different ref
while the ruleset ID is left unchanged; an observed ruleset's `source` or
`target` can silently diverge from the plan while the same rulesetId and
booleans are otherwise reused, letting a repository-owned or
differently-targeted ruleset stand in for an organization-owned or
branch-targeted one; a ruleset can also declare `target: "tag"` while still
being required to satisfy the branch-only pull-request/CODEOWNERS/
current-head-approval controls that GitHub does not expose for a tag
target, making the plan itself unsatisfiable — this contract instead models
branch and tag rulesets as a closed discriminated union, so a tag ruleset is
compared only against the restrict-creation/-update/-deletion controls
GitHub actually exposes for it; an Actions policy readback can allow all
Actions, grant workflows pull-request review approval, disable fork
pull-request approval, or disable SHA pinning without being flagged as
drift; a Project binding's mutation-confirmation requirement or an incident
contact list can be silently substituted without comparison; and an
environment can lack protection rules while still being treated as
reviewed. Because a readback is presented as complete administrator state,
an unplanned extra ruleset, environment, or required check can otherwise be
silently accepted simply because the comparator only walks the planned
side — including an unplanned ruleset that itself carries a bypass actor
the threat model requires to fail closed; this contract therefore also
rejects any observed rulesetId, environmentId, or checkName absent from the
plan. Every document in this contract family (deployment topology, App
registration/readback, administrator plan/readback) carries an explicit
`nonAuthoritative` marker; a readback that silently reports `false` for one
of these fields — understating what it cannot itself apply — is compared
and flagged like any other drift, not merely assumed from the document's
`kind`. A stale plan bound to an already-superseded permission manifest
version could otherwise be compared as if it were current, and a
readback's own self-asserted `driftFound` claim could be trusted as if it
were the actual compliance result instead of a separate, non-authoritative
coherence check. A ruleset's ref condition can use a wildcard or glob
metacharacter that a naive literal-string comparison would misjudge in
either direction — for example an `exclude` pattern intended to remove the
default branch from protection that a literal-string check would never
match, leaving the branch misreported as protected when a live GitHub
ruleset evaluating the same glob would not actually enforce it — so this
contract accepts only literal refs and rejects glob patterns outright
rather than reimplementing GitHub's fnmatch semantics. A readback can also
declare or observe the same rulesetId, environmentId, checkName, or
incident-contact role more than once with conflicting values, so that a
naive `Map` built directly from the collection silently keeps only the
last entry and discards a non-compliant duplicate instead of failing
closed on the conflict. A permission readback can likewise declare the same
(scope, name) permission key twice with a conflicting `read`/`write` level;
because the two observations are distinct objects, a schema `uniqueItems`
constraint alone would not reject them, so this contract also rejects a
duplicated permission key before any per-entry comparison.

### T31 Customer-starter scope, closure, or evidence-leak confusion

A customer-starter selection can silently widen beyond its reviewed
include/exclude prefixes; ship a file whose module import (TypeScript,
`.mjs`/`.cjs`/`.js`, static or dynamic `import`, re-export, or `require`),
JSON Schema `$ref`, Markdown link, or advertised package.json script
target is absent from the bundle; ship a compiled Agentic Workflow lock
without its compiler-owned Markdown source; embed a secret,
non-portable source reference, or customer-identifying pattern that a reviewed
denylist should have caught; or ship two paths that collide once
extracted onto a case-insensitive or Unicode-normalizing filesystem. A
selection's reviewed `sourceHeadSha` being an ancestor of the build head
is not by itself evidence that no matched file was added, removed,
mode-changed, or content-changed since review. An extension profile's
manifest can claim to be the deterministic union of an exact base
profile while actually overlapping, omitting, or substituting base
files, binding to a stale `baseSelectionDigest`, or asserting a base
file set a caller fabricated rather than one the base selection actually
resolves to. The generated preflight report can be mistaken for a
readiness decision, or its embedded open-source-readiness snapshot can
drift from the live, unresolved gate. Separately, a caller able to
construct an arbitrary in-memory `CustomerStarterProfileCatalog` (whether
through a build/verify parameter, or a second exported function accepting
one, however narrowly named or documented) can supply a catalog entry
naming a file absent from the closure at a selection's reviewed
`sourceHeadSha` but present and exempted at the current build head, so
`resolvedClosureDigest` matches at both ends while the file still ships; a
deep import of the compiled package reaching such a function, or reaching
a mutable in-memory catalog object the production engine itself reads,
is exactly as dangerous as a build/verify parameter accepting one
directly, since exported/reachable-and-mutable is the actual authority
boundary, not a function's name or a variable's declared constness. A
module-import-closure module specifier written with a backslash escape
sequence (e.g. `\x2e`, `\u002e`) can decode to a relative path at runtime
without containing a literal `.` character in its raw source form,
evading a closure check that only inspects raw specifier text. Finally, a
build's output directory, or a directory being read back for
verification, sitting under a shared writable parent directory (e.g.
world-writable `/tmp`) is subject to a check-then-use (TOCTOU) window in
which a different identity sharing that host could swap in a symlink or
race a replacement between the safety check and the eventual write/read.
A file-only copy can also retain a source CODEOWNER that is invalid in the
customer organization, or collapse identical `owner/repository` names on
`github.com` and a data-residency `*.ghe.com` host into one provenance identity.
Customer configuration must rewrite every CODEOWNERS rule, and release/starter
provenance must bind both canonical server and repository.
A user-owned destination may retain the same human only when its CODEOWNER
namespace equals the destination repository owner; an unrelated organization
does not receive that exception.

## Abuse cases that must fail closed

- A comment asks the model to change the target repository or mark work completed.
- A bot account posts an activation phrase.
- A bot or unauthorized human edits Requested Stage Agent.
- A discovery option is selected during implementation, or vice versa.
- A Project selection is missing, stale, replayed, cross-project, cross-demo, or
  changed after an exact grant is accepted.
- A model attempts to choose another agent or reinterpret the picklist as
  dispatch authority.
- A live Project bootstrap target differs from the exact reviewed manifest, or
  an apply lacks explicit confirmation and complete readback.
- A synthetic display card is treated as a receipt, approval, gate, or runtime
  state.
- An approved PR receives a new commit.
- A reviewer loses team membership before merge readiness.
- Threat detection emits `warning` while the workflow process exits zero.
- A reusable capability requests a new network destination at runtime.
- A retry occurs after a partial PR/Project mutation.
- A Domain Pack asks to publish to a CMS or update production.
- A repository proposal embeds a live cluster command, paraphrases a production
  mutation, or claims brand/legal/policy approval without a fresh exact-artifact
  trusted policy assessment.
- A profile catalog duplicates one ID, omits another, or changes canonical order.
- A dependency pin or provenance citation moves from its reviewed SHA.
- A writer edits an App-attributed state comment or pushes a current marker out
  of a truncated comment page.
- An Agentic Workflow detector returns `warning` and the platform safe-output job would otherwise continue.
- A manual dispatch or non-default-branch workflow ref attempts execution.
- The same nonce or `(workflow, run_id, run_attempt)` is redeemed twice.
- A lease/state is revoked or its CAS ledger head changes during redemption.
- A run reserves only main-model cost rather than the full 500-credit maximum.
- The redeemer, OIDC identity, isolated Project reader, or authorization
  signature verifier is missing.
- The first or last comment page, ETag, selected state identity/update time, or
  current head changes during repeated reads.
- A forged digest or valid authorization for another route, receipt, head,
  output schema, run attempt, event, or actor reaches the bridge.
- A domain artifact cites evidence outside the trusted immutable catalog, uses
  stale dependency content, aliases required approvers, asserts approval or
  completion, or embeds a publication or live-operation instruction.
- Domain execution lacks an applied Kernel result over all five compiled
  policies, reuses an operation nonce, exceeds cumulative budget, invokes a
  model outside its exact registered schema, or substitutes a definition,
  profile, rubric, schema, template, gate, retention, or prohibited-data rule.
- DLP is unavailable, unknown, restricted, stale, or scoped to different
  sources, values, policy, stage, or artifact set; regex-only screening is not
  accepted as authoritative classification.
- A validated definition, profile, policy, schema, template, or rubric is mutated
  through a retained caller reference, or its canonical digest changes before an
  invocation, gate, bundle validation, or repository effect.
- A reviewer sees generated artifacts without a fresh independently signed threat
  assessment for the exact delimited review payload and artifact bundle, or its
  complete output has not passed exact-output DLP before COMMENT.
- A model substitutes any signed Marketing source field or observation, or places
  unsupported factual, comparative, customer, security, roadmap, or trademark
  content in positioning.
- An operation grant binds a generic context instead of the complete canonical
  invocation, package, COMMENT, approval, merge-observation, or closure request.
- A forged, missing, wrong-key, wrong-purpose, expired, replayed, or substituted
  package operation-grant signature reaches Git, or a valid claims/rights guard
  is reused with a different request, repository, work item, ref, file set,
  nonce, run, or expiry. Entry, pre-object, pre-CAS, and reconciliation checks
  must authenticate both signed records and their exact cross-bindings.
- A package or COMMENT receipt postdates the human-wait checkpoint; a model call
  exceeds its canonical output-byte ceiling or ignores its hard deadline.
- Ambient staged or previously committed proposal content, protected paths,
  hostile Git hooks/configuration, replacement refs, a substituted default base,
  parent, tree, or concurrent ref update enters a domain package; the isolated
  exact-tree packager must authenticate the default ref, require the proposal
  head to equal that base, validate the complete base-to-final artifact diff, or
  reject without overwriting either ref.
- A repository numeric/node/full identity, trusted root, work item, default ref,
  or exact proposal ref is substituted; a symbolic proposal ref dereferences to
  the default branch; or ref CAS omits `--no-deref`.
- A caller mutates package files, digests, grants, or bindings after an awaited
  read; a symlink or directory replacement retargets the canonical repository
  root; or ref mutation occurs before the intended receipt is signed and
  verified. A signer failure causes zero ref effect. An ambiguous CAS or
  post-attempt failure must never trigger a second mutation: exact intended
  refs return the already prepared receipt only after an atomic verify-only
  transaction proves the pair coexists, unchanged old state rejects under the
  same proof, and divergent or unreadable state returns no completed receipt.
- A GitHub work-item node ID is normalized as a lowercase slug, case-folded,
  empty, oversized, or substituted instead of preserving its exact opaque value.
- A package, COMMENT, merge, or closure receipt predates its exact operation
  grant or predecessor evidence, postdates its expiry, or claims a future trusted
  observation time.
- Provider input exceeds its pre-call byte/token reservation, output exceeds the
  reserved maximum, or a provider throws, times out, underreports, omits, or
  forges usage; the run must hold the full uncertain reservation and perform no
  repository effect.
- A nonzero-cost model capability is admitted with a zero reservation, including
  a repair call after its compiled cost authority is exhausted.
- Business Operations controls collapse owner, operator, verifier, and policy
  authority, substitute arbitrary `role:*` values instead of the exact four
  constants, or use a quorum other than four; final closure reports pre-review
  readiness instead of merged proposal artifacts.
- A claim or asset uses stale, unrelated, invented, wrong-channel,
  wrong-territory, or unresolved rights evidence, including unreviewed
  trademark use.
- Claim or rights evidence expires, is revoked, or changes after packaging but
  approval, merge observation, or closure proceeds without exact re-resolution
  and digest/expiry binding.
- Claim or rights authority revision/head changes or is revoked between
  resolution and package-ref advancement or closure append, without a trusted
  authority CAS holding the exact effect callback.
- Approval precedes the exact package, COMMENT receipt, or signed human-wait
  checkpoint, or its numeric actor authorization lacks current permission,
  required team, exact role, purpose, policy, artifact, or head binding.
- Signed authorization reaches the bridge without the exact applied Kernel
  result, or with a refused/noop/wrong-capability/stale receipt.
- A privileged review workflow checks out or executes pull-request content, reads
  model-selected GitHub content, omits exact base/head comparison, or proceeds
  after a live binding change.
- An implicit gh-aw failure, missing-tool, missing-data, incomplete, or noop
  handler attempts to create an issue outside the staged runtime bridge.
- Automated review attempts `APPROVE`, `REQUEST_CHANGES`, dismissal, or merge
  instead of `COMMENT`.
- A model requests a PAT, App credential, external MCP, network destination, or a target-bearing output.
- A model requests a repository path instead of an approved logical target
  slot, or a patch introduces traversal, links, submodules, renames/copies, case
  collisions, mode/binary changes, or an unexpected file.
- An installer config omits or substitutes enterprise, organization, repository
  numeric/node/full identity, App installation, ref, exact head, state digest,
  receipt CAS head, release digest, or human change record.
- Installer raw input/output paths normalize traversal into Git metadata, or
  schema/planner/apply path rules disagree.
- An apply path exposes App credentials, accepts PAT/model-job fallback, retries
  an ambiguous effect, accepts caller-selected time for authorization freshness,
  re-reads mutable accessor input after validation, conflates release-source and
  customer-target heads, or accepts a receipt without exact persistence and
  result-state reconciliation.
- Safe reconciliation of an already-persisted exact receipt incorrectly requires
  still-current mutation authorization and cannot converge after expiry.
- A repository-file plan omits the expected resulting head or reuses one
  idempotency key for different actions, result state, or evidence paths.
- A migration skips an edge, uses an unknown version/checksum, hides an
  irreversible step, includes a disconnected/beyond-current graph, rolls back
  without explicit support, or accepts an unauthenticated, wrong-target,
  discontinuous, partial, reordered, duplicated, or ambiguous journal.
- A terminal receipt claims a different applied head than the observed target.
- A receipt array is spread, mapped, cloned, or canonicalized before its closed
  aggregate bound is checked, or journal capacity is handled by truncation,
  sequence reset, or genesis reuse without an authenticated checkpoint.
- A receipt container changes length or elements between the structural and
  authentication decision because validation rereads the raw journal instead of
  using one bounded snapshot.
- A Proxy supplies a coercible or stateful non-number `length` that changes
  between the aggregate check and bounded materialization.
- A structural journal validator is presented as signature-, target-, state-,
  or terminal-head-authenticated.
- A self-rehashed plan with duplicate/unsorted actions, invalid create/update/
  delete digest semantics, operation/action mismatch, or inconsistent
  effect/result head reaches an authorization verifier or adapter, or an action
  equals, contains, or is contained by a path still claimed as retained evidence.
- A self-rehashed plan substitutes an arbitrary customer-file action or clears
  evidence by changing action/result summaries without a digest-bound release
  manifest and complete pre/post inventories from which trusted code re-derives
  the canonical transition.
- A plan retains an unrelated configuration digest, omits a migration or
  irreversible flag, replaces the selected release inventory, or omits the
  deterministic current-operation evidence path because apply validation trusts
  self-referential summaries instead of embedded digest-bound contracts.
- A non-recovery plan accepts partial or ambiguous input, or recovery drops
  evidence from its digest-bound last stable state.
- Authorization expires during awaited verification/observation and apply starts
  without an immediate caller recheck and atomic adapter enforcement.
- Offline validation of caller-supplied state is presented as a fresh live
  target observation.
- Journaled recovery incorrectly compares the last stable receipt directly to
  the authenticated partial state instead of binding both states.
- An unbounded numeric version component overflows comparison and reverses
  upgrade/rollback ordering.
- An uninstall infers ownership, recursively deletes a target, removes
  digest-mismatched/customer content, or discards backups, receipts, audit, or
  release evidence.
- A release includes a link, submodule, traversal, duplicate, noncanonical path,
  schema-valid but ustar-unrepresentable UTF-8 path, U+2028/U+2029 line
  separator, noncanonical name/prefix
  split, unexpected file/type/mode/owner/timestamp/padding, oversized entry, dirty
  source, stale head, Git replacement object, dependency/license-expression
  drift, or mismatched attestation subject.
- A partial clone lazy-fetches a missing object while provenance claims no
  network or credential use.
- An unsupported Git version ignores the lazy-fetch control, or repository
  `core.fsmonitor` executes code or conceals dirty source.
- Release output is created inside the source repository and makes the successful
  build unverifiable, a repository subdirectory bypasses output containment, or
  a readiness accessor changes after validation.
- Archive aggregate limits are checked only after multi-gigabyte allocation, or
  SPDX accessors return different license data after validation.
- An exported archive verifier accepts ignored ustar metadata or surplus
  terminator blocks that the deterministic encoder never emits, or accepts
  duplicate/unsorted paths with extractor-dependent results.
- An unsigned local SBOM, provenance file, attestation, model review, or
  release-candidate checklist is treated as a trusted signature, human approval,
  readiness claim, license decision, or publication authority.
- A model substitutes a planning artifact, execution grant, workflow ID, or
  contract revision, or bypasses the signed authorization transfer into the
  post-agent bounded-execution bridge.
- A framing approval is replayed as plan or execution authority, or an approval
  is substituted across artifact, route, snapshot, Accord, lease, actor, or
  head.
- A caller supplies time that would revive expired evidence, or revocation,
  redemption, and threat observations are stale, future-dated, or misordered.
- A delivery caller supplies a freshness window larger than the authenticated
  runtime policy, or presents bundle, authorization, Kernel proof, patch, and
  threat evidence with independently mismatched ages.
- A caller deep-imports a freshness issuer or presents a frozen structural
  lookalike with a no-op checker or substitute clock to bypass concrete adapter
  freshness enforcement.
- A verification artifact supplies shell text, separators, extra argv, inherited
  credentials, or a command that times out, exceeds output, or exits nonzero.
- Multiple effects from one event collide because they omit a trusted logical
  effect ordinal.
- Completion is requested before independent human merge observation, Project
  convergence, Issue closure, delivery evidence, operations handoff, or final
  signed cost release.
- A phase settlement or retry releases cost twice, drops already consumed
  provider usage, or releases more than the authoritative remaining balance.
- A provider call throws or its settlement acknowledgement is lost; authoritative
  usage must still settle, while unknown usage remains reserved.
- A cost hold with no proven settlement is released because no durable attempt or
  usage evidence is found; absence of evidence must not return budget.
- A cost release trusts a caller-supplied open-hold list, or races a concurrent
  hold in another store, instead of deriving open holds from the cost ledger's
  durable compare-and-swap lineage.
- `expectedOpenHoldDigests` names a hold the cost ledger never wrote.
- A model reports cost or tokens that disagree with authenticated provider usage;
  the authoritative usage must settle before the artifact is rejected.
- A validated patch digest survives while its content is discarded, substituted,
  or detached from its plan, grant, threat result, Kernel receipt, base, or tree.
- Commit completion reports a constant, parent/no-op, wrong-tree, wrong-blob,
  wrong-mode, wrong-content, or wrong parent-to-commit patch observation instead
  of fresh evidence derived from the signed patch bundle.
- A copied Kernel receipt digest is presented without the authenticated applied
  Kernel result, or the result proves refused/noop/stale/wrong route, capability,
  binding, policy, receipt head, or effect plan.
- Local/global Git configuration, hooks, templates, credential helpers, fsmonitor,
  aliases, replacement refs, or pathspec magic influence trusted worktree
  validation, or the staged/indexed set differs from exact approved targets.
- A caller replays persisted effect evidence under another workflow, revision,
  effect type, or logical ordinal.
- Orchestration fabricates human approval/merge, merge precedes exact-head
  approval, or closure continues without the signed awaiting-human checkpoint.
- Cost release fails or loses its acknowledgement without a discoverable signed
  pre-release checkpoint and stable ledger reconciliation key.
- A lease is revoked between provider calls but later inference still occurs.
- A long human wait incorrectly expires immutable signed checkpoint or settlement
  history before its explicit expiry, or resume trusts that history without
  freshly checking mutable policy, lease, head, approval, and merge state.
- A provider call starts after cumulative calls, tokens, or cost reaches the
  lease boundary, or expiry/revocation occurs during the final awaited state
  read.
- A typed effect reports a wrong target, stale postcondition, or stable no-op as
  completed.
- Draft pull-request replay confuses GitHub's mutable live base-tip SHA with the
  immutable creation-time base evidence, or permits repository, node, number,
  base ref/repository, head ref/repository/SHA, draft, or open-state substitution.
- A completed-effect base-tip exception leaks into active verification, review,
  approval, merge observation, closure, pre-effect delivery, or pending-effect
  reconciliation and authorizes new work without exact bound-base revalidation.
- Completed draft-PR replay validates only the PR and misses fresh repository
  node/full-name, Issue number/node, Project owner/node/item, or canonical
  binding-digest substitution in the surrounding aggregate.
- Audit output contains raw secrets or high-cardinality identities, accepts a
  broken predecessor chain, recursively accepts malformed `usage`/`labels`, or
  accepts anonymous scalar/array diagnostics, or emits metrics with
  caller-controlled labels.
- A budget decision permits invalid arithmetic, exact-expiry execution, elapsed
  wall-clock exhaustion, or attempts, fanout, concurrency, tokens, tools, or
  effects beyond the reviewed ceiling.
- A package effect relies on process-local replay memory, accepts a claim from
  the wrong store, reuses a cached challenge response, skips authenticated
  predecessor/sequence CAS, or proceeds without a closed signed `appended` claim
  for the exact grant, redemption key, request, repository identity, run,
  sequence, and expiry, or emits a package receipt that predates the claim.
- A demo catalog is reordered, a stage/runtime identity is reused, a generic
  runtime template satisfies a stage binding, or one demo substitutes another
  demo's profile, capability, workflow, artifact, receipt, or run state.
- A workflow selects its own validation class, a trusted binding lacks a source,
  a source lacks exactly one trusted binding, or a partial per-demo shard is
  accepted because another demo supplies the missing identity.
- A runtime script omits the exact validated catalog/profile/stage binding,
  substitutes another demo's opaque handle, or falls back to a generic/core
  registration for a reserved demo capability.
- A review materializer carries only pull-request diff data while omitting the
  pack's complete fixed command, regression, lock, threat, DLP, scanner,
  unchanged-alert, draft-only, or current-head evidence.
- A privileged bridge process executes model-generated source or tests with
  access to its OIDC, signer, workspace, credentials, or network context.
- A COMMENT writer relies on an earlier head read instead of rechecking the
  exact pull-request head immediately before the trusted mutation boundary.
- A COMMENT adapter accepts a precondition read but does not atomically bind
  the complete execution-state and expected-head digest to the mutation.
- A same-core stage receipt changes Kernel state/version/authority/head, a
  cross-core stage receipt omits or mismatches the exact applied Kernel result,
  or Project Stage/Journey Stage/Target Repository drives advancement.
- A pack human-review predicate is absent from the Kernel's closed requirement
  vocabulary, causing completion to bypass the exact reconstructed journey or
  report success without an applied Kernel result.
- An issue form or edited issue body selects a demo profile, repository,
  Project, capability, stage, route, credential, transition, effect, or budget.
- Missing consent, disabled or expired activation, an unauthorized submitter,
  unresolved/substituted repository binding, stale Project binding, disallowed
  depth, malformed/oversized text, or absent fixed budget reaches credentials,
  reservation, or inference.
- Free-form punctuation or model prose decides that information is missing, or
  recovery automatically creates another issue instead of retaining one typed,
  digest-bound blocked artifact/evidence reference.
- A deployment topology, App registration, or administrator plan document
  omits, duplicates, or adds a required trust-service identity, durable
  store, budget, monitoring signal, retention window, protection scope,
  ruleset, environment, or required check, or assigns every service or every
  durable store the same signing key, OIDC audience, namespace, or
  credential identity while still claiming independence.
- A deployment topology plan declares a conflicting duplicate retention
  window for the same artifact kind, relying on naive `Set` membership over
  `artifactKind` values alone to hide the conflict.
- A permission readback requests or reports a denied permission name, an
  elevated *or* downscoped level relative to what was planned, a permission
  absent from the least-privilege plan, or silently omits a permission the
  plan requires; or a readback is bound to a different owner, App,
  installation, or selected-repository set than a separately human-approved
  target binding records.
- A permission readback declares the same (scope, name) permission key
  twice with a conflicting `read`/`write` level, relying on the two
  observations being distinct objects to defeat a naive per-key `Map`
  lookup.
- A plan, target binding, or readback observation is accepted outside a
  caller-supplied freshness window — a future-dated observation, an
  observation older than the maximum permitted age, or comparison against an
  expired target-binding approval.
- An administrator readback reports a ruleset that is not active or carries
  a bypass actor, a ruleset whose ref conditions or resolved protected refs
  no longer match what was planned (including a default-branch-named
  ruleset quietly repointed at a different ref), a ruleset whose observed
  `source` or `target` silently diverges from the plan while the same
  rulesetId and booleans are reused, a tag ruleset required to satisfy
  impossible branch-only pull-request/CODEOWNERS/current-head controls
  instead of the restrict-creation/-update/-deletion controls GitHub
  actually exposes for a tag target, an Actions policy that allows all
  Actions or grants workflow pull-request review approval, a disabled
  fork-pull-request-approval or SHA-pinning requirement, a GHAS control that
  is disabled, a Project binding whose mutation-confirmation requirement has
  silently changed, a substituted or missing incident contact, or an
  environment with no protection rules, while the comparator is expected to
  still infer a passing state.
- An administrator readback reports an unplanned extra ruleset (including
  one carrying a bypass actor), environment, or required check that is
  never evaluated because the comparator only walks the planned side.
- A deployment topology, App registration/readback, or administrator
  plan/readback document omits its required `nonAuthoritative` marker, or a
  readback silently reports `false` for a field the marker promises is
  always `true` on the plan side, understating what the document cannot
  itself apply.
- A plan is compared against a readback after its bound permission-manifest
  version is superseded, a readback's self-asserted `driftFound` value is
  trusted as the actual compliance result instead of a separate
  non-authoritative coherence check, or a plan/readback/target-binding
  document itself claims it can install, transfer, or authenticate an App,
  apply a ruleset, required check, Actions policy, or GHAS setting, mutate a
  Project, or select a live deployment target.
- A ruleset's ref condition uses a wildcard or glob metacharacter that a
  literal-string comparison would misjudge, or an administrator plan or
  readback declares or observes the same rulesetId, environmentId,
  checkName, or incident-contact role more than once so that a naive `Map`
  lookup silently discards a conflicting duplicate instead of failing
  closed.

## Residual risks

- Administrators can intentionally weaken platform policy outside the framework.
- GitHub, runner, model-provider, or package ecosystem compromise cannot be eliminated.
- Semantic threat detection has false negatives and is defense in depth.
- Human reviewers can make mistakes or collude.
- Comment-based receipt chains may be edited by sufficiently privileged humans.
- External provider privacy and retention guarantees require separate contracts and configuration.
- Agentic Workflows are Public Preview, and warning-level platform threat results
  are not a sufficient privileged-write gate. Platform safe outputs therefore
  remain staged and require a separate exact-`success` trusted bridge.
- Slash-command runs can bypass the platform daily AIC guard. Atomic one-time
  redemption of the complete main/continuation/threat maximum remains mandatory.
- The external redeemer, independent threat/DLP/artifact-policy services, durable
  operation-grant store, and their isolated App/key/CAS infrastructure are
  deployment trust dependencies. The repository defines and tests their
  hermetic interfaces but does not deploy or configure them.
- The checked-in execution workflow validates and uploads a complete signed patch
  artifact, then invokes a disabled-by-default OIDC delivery boundary bound to
  the exact run, attempt, artifact ID, archive digest, and bundle digest. The
  repository includes the revalidating downloader/consumer and concrete
  Kernel-authorized GitHub adapter/Single Writer port. The validated runtime
  policy and trusted consumer clock are carried in one opaque context through
  concrete delivery, with the complete runtime evidence set rechecked before
  each mutation; adapter or delivery callers cannot provide a different clock
  or freshness window. Their live service,
  operation-scoped App broker, and durable stores remain explicit administrator
  deployment dependencies; hermetic semantics do not replace live evidence.
- GitHub's `pull_requests: write` installation permission is broader than the
  framework effect union. Human-configured rulesets and protection from
  automation bypass therefore remain mandatory defense in depth.
- The portfolio hardening gate is hermetic evidence. It does not prove deployed
  service availability, live credential isolation, platform configuration, or
  provider behavior. Those require human-admin sandbox
  provisioning, live fault injection, and an independently observed canary.
- The `DeploymentTopologyPlan`, `GitHubAppRegistrationPlan`,
  `GitHubAppInstallationTargetBinding`, `GitHubAppPermissionReadback`,
  `AdministratorPlan`, and `AdministratorReadback` contracts (ADR 0013) are
  deterministic planning and comparison evidence. They do not deploy the
  eight independent trust services, install or authenticate a GitHub App,
  mint an installation token, or apply a ruleset, required check, Actions
  policy, GHAS setting, or Project binding. An authenticated readback still
  depends on a separately deployed trusted adapter capable of reading live
  GitHub state and a separately human-approved target binding; this
  repository defines and tests the comparison, not that adapter or the
  human approval step itself. The freshness window these comparators
  enforce is only as trustworthy as the caller-supplied `now`; this
  repository never reads a clock, so an untrusted or manipulated caller
  clock remains a deployment-time trust dependency.
- This contract's ruleset ref conditions accept only literal, fully-
  qualified ref names; it does not implement GitHub's fnmatch glob
  semantics. A real ruleset that protects refs via a glob pattern (for
  example every `v*` release tag with one rule) cannot be represented
  faithfully and must be decomposed into separate literal-ref rulesets, or
  a future superseding ADR must introduce and fully test real
  fnmatch-equivalent matching before glob patterns are accepted.

These risks require monitoring, bounded authority, independent human review, incident response, and release-stage reassessment rather than claims of complete prevention.

## Validation strategy

Deterministic negative tests cover warning threat results, output
substitution, signature forgery, nonce/run-attempt replay, concurrent CAS,
revocation, missing redeemer, incomplete cost reservation, default-branch
substitution, single-page and paginated state races, stale heads, unauthorized
pull-request checkout and API-ref drift, absent/refused/noop/wrong-route/wrong-capability Kernel
results, actor/App substitution, comment-only review authority, and repair
exhaustion. The integration suite adds a complete local-git orchestration test
plus canonical
binding substitution, distinct gate, exact-slot/TCB, diff attack, fixed-command,
signed cost release, effect ordinal, current-head, COMMENT-only review,
independent two-invocation merge, authenticated awaiting/pre-release/closure
resume, per-call live lease revocation, provider-ledger recovery, literal
pathspec and exact index validation, hostile Git configuration, complete
serialized execution-bundle/Kernel-proof, mutable-base replay with immutable
pull-request identity substitution, active-phase base-advance rejection, and
complete fresh aggregate substitution, and closure tests. Manual behavioral fixtures cover role
adherence, skill activation, evidence quality, authority refusal, and
escalation. The security suite adds exact artifact-policy schema and binding
mutation tests,
structured reviewer-input ambiguity tests, cross-process grant-store refusal,
audit-chain serialization, deterministic bounded-cardinality metrics, redaction,
and every runaway-budget ceiling. The closed all-demo hardening gate covers the actual Kernel, dispatcher,
scheduler, projector, bridge, writer, provider, persistence, credential,
delivery, recovery, and acknowledgement tests. It also requires two
byte-identical real simulations, an exact zero fixture-declared external-call
assertion set, and per-demo simulator-result binding. These assertions are not
runtime telemetry or an OS-level network sandbox. Deployment must still repeat
credentialed
fault injection for every live write path,
OIDC/redeemer/App/key/store failure, sink availability, provider failure, and
platform drift. A control is not fully deployed until its enforcement,
evidence, deployment, recovery, and security review are complete.
Foundation portfolio tests additionally cover exact catalog order and cardinality,
duplicate JSON keys, missing/unknown versions and digests, immutable snapshots,
global runtime identity injectivity, per-demo shard closure, generic-agent and
cross-demo substitution, model control fields, same-state overlay misuse, and
applied Kernel receipt mismatch. Project UX tests cover the exact fifteen-field
schema, fourteen-field projection, Requested Stage Agent input separation, and
Journey Stage catalogs, static form/profile bindings, content bounds, consent,
submitter, depth, fixed-budget, activation-window, repository/Project freshness,
no-authority success, typed single-field clarification, dry-run catalog planning,
human-admin-only drift, exact-target bootstrap planning/readback, and
export/import substitution. Hybrid-selection tests cover policy intersection,
actor eligibility, fixed and selectable candidates, no fallback, wrong-stage
options, stale heads and generations, exact duplicate idempotency, conflicting
replay, and immutable selected dispatch.

`tests/deployment-topology.test.ts`, `tests/app-registration-plan.test.ts`,
`tests/administrator-plan.test.ts`, and `tests/pre-app-api-surface.test.ts`
cover exact eight-service/four-store closed coverage, missing
service/store/budget/retention/protection generator refusals,
ingested-document omission and duplication refusals, structural
independence refusals (shared signing key, OIDC audience, store namespace,
or store credential across the closed set; a service's `principalId` or a
store's `kind` not matching its own identifier), a conflicting duplicate
retention window for the same artifact kind (both generator-side and
ingested-document-side, distinct from the omission case above), a narrowed
monitoring-signal set, a journal bound above the 512-entry ceiling,
least-privilege permission-union derivation and denial, an ingested
App-registration plan whose operations/denied-list/union no longer match
the reviewed manifest (including the exact end-to-end attack of removing a
manifest-required permission from `leastPrivilegeUnion` and observing the
correspondingly downscoped readback through the comparator itself),
elevated/downscoped/extra/missing permission readback drift, a duplicated
observed permission key with a conflicting `read`/`write` level, a false
`nonAuthoritative` marker on both the App permission readback and the
administrator readback, target-binding identity mismatch and expiry,
readback-observation staleness and future-dating, stale manifest-version
refusal, ruleset bypass-actor and inactive-enforcement refusal, ruleset
ref-condition/effective-protected-ref drift (including a main-named ruleset
repointed at a different branch), an observed ruleset `source` or `target`
diverging from the plan while the same rulesetId and booleans are reused,
the branch/tag ruleset discriminated union (a tag ruleset satisfying only
the restrict-creation/-update/-deletion controls GitHub exposes for it, and
schema/comparator/validator rejection of an impossible tag ruleset carrying
branch-only pull-request/CODEOWNERS/current-head controls), an unplanned
extra ruleset (including one carrying a bypass actor), environment, or
required check silently accepted because only the planned side was walked,
omitted required-check refusal, exhaustive Actions-policy/GHAS/environment
readback drift, Project-binding mutation-confirmation drift, incident-contact
exact-set drift, `driftFound` coherence-only enforcement, and the intentional
public export of every pre-App contract (including the shared
duplicate-key-detection helper) from `src/index.ts`, literal-ref
enforcement (a wildcard/glob ref rejected on both the plan and readback
side, and the specific case of a wildcard `exclude` that would otherwise
misstate a literal `include` as still protected), and duplicate-key
refusal for rulesetId/environmentId/checkName/incident-contact-role on
both the plan and the readback side (including a duplicated key whose two
entries disagree, proving a naive last-wins `Map` cannot mask the
conflict). `npm run
validate:schemas` additionally validates the six synthetic
`examples/pre-app/` fixtures, including a `GitHubAppInstallationTargetBinding`
and one administrator readback that intentionally drifts from its plan so the
comparator's failure path is exercised outside unit tests.

### T30 Durable store confusion, replay, and silent divergence

A durable store sits underneath every claim, grant, fence, receipt, and evidence
record, so a store that is merely *plausible* rather than exact can corrupt
authority decisions without any policy layer being wrong.

The concrete misuse cases are: a replayed write whose body has been mutated
being accepted as an idempotent repeat; two processes both winning the same
append or the same compare-and-swap and producing a lost update; a caller whose
acknowledgement was lost concluding either success or failure instead of
reconciling; a store file that has been truncated, byte-flipped, or written by a
different format version being read on a best-effort basis; a journal that
silently evicts its oldest entry to stay within a bound and so destroys the
replay evidence it exists to hold; two logically independent stores sharing one
backend namespace, one credential, or one file while the deployment plan asserts
they are independent; and a store reached through an ambient default path, an
environment variable, or a credential fallback rather than an explicitly
injected, plan-derived binding.

A reference implementation adds three further cases. It can drift from the
deployment contract by defining its own parallel store descriptor; it can
quietly become load-bearing by being promoted into the supported public API
without review; and it can report an unknown outcome while leaving its own
transaction open, so a reconciling reader on the same connection observes
uncommitted rows and concludes a durable write happened that did not, while
other writers block and later calls escape the refusal taxonomy.

A related case is evidence that cannot satisfy its own contract: a manifest or
record whose published schema is narrower than the states the store can actually
reach, so valid operation produces invalid evidence.

Control C31 covers these. The substrate stores only exact canonical bytes and
returns them unchanged, so contract semantics stay with the callers that already
re-validate every returned receipt; `existing` requires byte-identical bytes;
writes are transactional and cross-process with the expected-head re-check
inside the transaction; unknown outcomes raise a distinct ambiguity state with a
guaranteed stable reread, and a lock timeout is reported separately because
nothing was written; every read re-derives its digest from stored bytes, and
`integrity_check` plus a `user_version` gate refuse a corrupt or foreign store;
a full journal refuses rather than evicting; the commit path rolls back
best-effort before raising ambiguity so no transaction is left open and
reconciliation reads through fresh handles; produced manifests and records are
tested against their own schemas at the store's true upper bound; identity comes
from a validated `DeploymentTopologyPlan` rather than a second descriptor, with
shared namespaces, shared credentials, and shared files refused; and the
substrate is kept off the public barrel by test.

The complete composition does not add a routing authority. Its closed
port-to-store table is fixed in trusted code, the exact
`DeploymentTopologyPlan` is validated before any file opens, and every clock,
signer, provider observation, budget, genesis value, compatibility list, and
absolute path is injected. Data-bearing topology/path/genesis inputs are
canonical-snapshotted and privately frozen so a caller cannot mutate a plan
after open and have backup evidence describe a topology the files were never
bound to. Restarting after every durable boundary must produce the same
progression and refusals as uninterrupted execution. Backup recovery
requires canonical destinations that cannot alias a live database or sidecar,
one atomically created and inode-rechecked private backup root, a stable signed
writer-disabled generation/checkpoint current under an injected trusted clock
before and after all copies, one signed
set identity over the exact four store-manifest digests and topology, and exact
equality with the fully chain-verified inventory of every restored namespace.
Mixed backup generations, forged recomputed sets, and injected namespaces refuse
before the caller may re-enable anything; deleting disabled stores creates only
empty genesis state and never synthesizes prior evidence. A process already
executing as the same local user remains part of the reference substrate's
trusted-host residual risk.

Residual: this is a nonproduction local store, not the deployed durable service
of prerequisite item 5. Filesystem-level protection of the store path and the
operator response to a capacity or availability refusal remain outside this
repository.

### T32 Engineering cost hold and release confusion

A provider attempt can be durably recorded while the release path omits it from a
caller-local unresolved list, returning budget that a provider may still report
against. A crash can erase that list entirely. A fabricated hold can be supplied
to inflate the released pool if caller input is treated as the held set, while a
hold accepted after release can reopen a closed reservation.

The unsafe common shape is making the open-hold set an argument instead of
ledger-derived state. Control C33 covers this by committing a signed hold in the
`engineering.cost-ledger` namespace before any provider attempt exists, binding
the attempt and settlement to that `holdDigest`, deriving release from durable
cost state, refusing unknown expected hold digests, and keeping a hold without a
proven settlement reserved rather than releasing it from absence of evidence.

### T33 Synthetic canary evidence laundering or ambient-boundary escape

A repository canary can be mistaken for a live sandbox result, or can quietly
read ambient credentials, contact a network service, accept caller-selected
commands or targets, persist private test keys, skip a required fault, hide a
failed/skipped test, emit nondeterministic evidence, or advance beyond Human
Review. Running runtime and durable tests independently without binding their
exact compiled inputs can also present two unrelated successes as one
restart-safe composition claim.

Control C34 fixes one optionless command in trusted code. It validates the
existing deployment topology, runs the closed hardening and durable suites twice
under a fixed credentialless environment and Node network deny guard, requires
every exact named boundary once, pins every compiled evidence input by its exact
reviewed digest, and emits one
target-free byte-identical report signed by deterministic synthetic ephemeral
Ed25519 key material that is never persisted. The report explicitly records
draft-only/COMMENT-only Human Review, prohibited effects as false, and live
activation as not attempted.

Residual: the Node guard is not an OS sandbox, fixture counters are not runtime
telemetry, and the local host plus reviewed test code remain trusted. Live App,
Project, provider, billing, platform, service-health, and administration evidence
remains unavailable and cannot be inferred from this canary.

### T34 Administrator handoff target, confirmation, and acknowledgement confusion

An administrator can apply a valid-looking plan to the wrong owner, repository,
Project item or field, environment, ruleset, App, installation, or billing
account; rely on stale counts/current values; confirm a different digest; widen
desired values after confirmation; retry a mutation after a lost or ambiguous
acknowledgement; accept a partial readback; or treat repository/synthetic
evidence as an App-backed sandbox result. A live API snapshot can also drift
after capture or leak customer repository identifiers into a copied source tree.

Control C35 fixes a target-free 27-control handoff plan and a separate exact
per-operation apply plan. Each control fixes its responsible owner, target source,
state keys/value domains, readback procedure, rollback mode, and prohibited
effects. Every apply plan binds complete applicable immutable identities, counted
sorted current and desired values, an attempt ID/idempotency key, one attempt,
durable claim/receipt requirements, and no ambiguous retry. A separate human
confirmation must bind the canonical plan digest; a fresh pre-readback must still
equal the expected target/count/values; and complete post-readback must bind the
confirmation, pre-readback, attempt, receipt, and desired state. Ambiguity is
reconciliation-required. The repository command creates only a plan-bound
synthetic-unconfigured readback. A customer trusted adapter creates current live
readback outside the repository. Customer-starter profiles contain only
synthetic target examples, and their internal-reference scanner rejects
non-synthetic Project node identities.
Trusted bootstrap requires the customer manifest to match a separately
confirmed digest; recomputing a substituted manifest does not satisfy that gate.

Residual: a compromised administrator, trusted adapter, identity provider, or
platform can still falsify or bypass live controls. This repository implements no
administrative apply, credential custody, production service, billing decision,
or live canary and cannot validate those external systems.

### T35 Issue-taxonomy target and metadata-authority confusion

A metadata workflow can run from unmerged pull-request code, accept an
attacker-selected repository or issue, infer a label from arbitrary issue text,
erase unrelated labels, close an issue, use a broad or fallback credential, or
report success after a partial write. A copied upstream workflow can also mutate
a customer repository unexpectedly, while display labels may be mistaken for
Control Kernel authority.

Control C36 fixes one upstream repository identity, exact historical mappings and
title prefixes, three display-only labels, closed issue/page bounds, and two
events: merged pushes to `main` and future issue openings. The optionless
reconciler fresh-reads exact issue identity, plans all classifications before the
first write, mutates only the three taxonomy labels, preserves unrelated labels,
and verifies readback. Wrong or ambiguous inputs fail closed. The workflow and
contract are excluded from customer-starter selections and no model or PAT is in
the route.

Residual: a compromised runner, administrator, dependency, repository
protection, or GitHub API remains able to alter issue metadata. The labels grant
no lifecycle, target, capability, credential, transition, or effect authority.

### T36 Product and technical identifier epoch confusion

Product-facing text can be mistaken for a package, API, Capability Registry,
format, evidence-marker, or cryptographic identity. A broad rename can silently
change domain separation or make stored evidence unverifiable; a partial rename
can create two incompatible epochs. A model, runtime job, or migration document
that can supply an epoch can redirect validation toward an attacker-selected
identity while appearing to perform a branding update.

Control C37 fixes Hyperfinite as the product name and one retained
`agentic-framework/v1alpha1` technical epoch in closed protected
configuration. Package metadata, schemas, publishers, domains, fixtures, and
generated evidence remain mechanically inventoried, while model/runtime/
migration inputs expose no epoch selector.

Residual: a future intentional identifier migration still requires a new
reviewed contract epoch, migration/evidence design, exact-head regeneration,
and human approval. A compromised protected branch or release tool can still
mislabel artifacts.

### T37 Distribution and deployment boundary confusion

Private package metadata, internal TypeScript exports, repository scripts,
unsigned archives, and implemented service interfaces can be mistaken for a
published SDK, installed CLI, hosted control plane, deployable service, or live
effect path. A consumer could then bypass exact-head repository assumptions,
customer-owned setup, independent trust services, or human administration while
treating unsupported behavior as product-supported.

Control C38 closes one product boundary in protected compatibility
configuration: only authoritative repository clones and customer-starter or
reviewed file-only customer copies are supported. Package metadata remains
private and metadata-only, SDK/bin entry points remain absent, repository
commands are context-bound, and service administration/effects remain external
prerequisites. Deterministic packaging tests and customer-starter extraction
validation detect contradictory distribution claims.

Residual: source is inspectable and can be used outside the supported model.
A future SDK, CLI, hosted, deployable, or production distribution requires a
separate reviewed compatibility, security, release, and support design.

### T38 Repository About metadata drift or authority confusion

The public description, homepage, and topics live outside the Git tree and can
drift from reviewed product wording. Autonomous-team language, a misleading
homepage, or broad topics can imply a hosted product, bundled trust services,
or model authority that Hyperfinite does not provide. A repository or model job
that chooses its own repository, credential, desired state, or success result
could redirect an administrative write or turn an unverified merge into
success-shaped acceptance evidence.

Control C39 fixes one immutable repository identity and exact display state in
a closed upstream-only contract. An optionless read-only planner accepts only
the bounded exact-repository `gh repo view` shape, computes complete drift, and
has no network, credential, or apply path. The built-in Actions token cannot be
granted repository Administration write permission, and no PAT or App
credential fallback is added. A human administrator must confirm a fresh plan,
apply through GitHub settings after merge, and obtain a second exact readback;
only complete zero drift is acceptance.

Residual: a repository administrator or compromised GitHub account/platform can
still alter display metadata after acceptance. Readback is point-in-time,
drift-prone evidence. About fields remain display/discovery only and grant no
lifecycle, repository, target, Project, capability, credential, transition,
release, or effect authority.
