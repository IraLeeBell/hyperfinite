# Repository-only Domain Packs

## Status

Marketing and Business Operations packs are implemented as disabled-by-default,
bounded runtime specializations. They compile below enterprise policy, Work
Accord, Phase Contract, Capability Registry, Control Kernel, trusted adapter, and
Single Writer authority. The implementation is hermetic; no external publishing
or business-system adapter, tool, credential, network destination, or MCP access
exists.

## Trusted selection and output binding

`config/v1alpha1/domain-profiles.json` is the trusted profile catalog. A caller
selects `engineering`, `marketing`, or `business-operations` outside the model.
The catalog is closed and canonical: each supported profile ID must occur exactly
once in the fixed order, so duplicate or missing IDs cannot make selection
order-dependent.
All five Phase Contracts compile against the exact enterprise policy, Work
Accord, pinned Capability Registry, and Domain Pack policy. The compiler rejects
any domain capability or Accord with tools, shell, network, MCP, secrets, or
write access. The resulting authority binds the definition, profile, policy,
phase, bundle schema, slot schema, template, and rubric digests. All validated
definition, profile, policy, schema, template, and rubric values are immutable
trusted snapshots whose canonical digests are rechecked before each boundary.
Every candidate artifact set must also receive a fresh, signed, exact-input
`success` assessment from an independent trusted artifact-policy service. That
assessment binds the artifact-set digest and compiled prohibited-effects digest;
model text, model self-attestation, or phrase matching cannot establish that
artifacts avoid live operations or cannot claim brand, legal, policy, or
production authority.
The model
receives only the registered target-free payload: evidence
digests, exact logical slots, patch ceiling, revision ordinal, prior-output
digest, and review findings.

The Work Accord also fixes the canonical repository numeric ID, node ID, full
name, trusted repository-root identity, work item, `refs/heads/main` default,
and one exact `refs/heads/agentic-domain/...` proposal ref. Requests, operation
grants, readbacks, and receipts bind that complete identity. The work item is a
bounded opaque GitHub node ID; its exact bytes and case are never normalized as a
slug.

Immediately before every model call and repository effect, trusted code
atomically redeems a run-bound unique signed operation grant and rechecks policy,
head, lease, revocation, threat status, and cumulative phase/capability calls,
tokens, cost, retries, loops, deadline, and per-call output-byte ceiling. Calls
receive an abort signal and fail closed on the compiled hard deadline. Each grant
binds the complete canonical request, and the adapter verifies that request
immediately before use. For packaging, the adapter verifies the purpose-scoped
grant signature, signer key, request digest, nonce, run identity, and expiry at
entry, before object construction, before ref CAS, and during reconciliation.
The claims/rights guard is issued after that grant and signs the exact guard-free
request plus the grant digest, signature digest, nonce, run identity, and expiry.
The CAS key binds the Kernel-authorized run identity,
attempt, operation, and sequence. Before repository ref mutation, an injected
durable store signs its current head for an unpredictable challenge, then
atomically claims the exact redemption key against that expected head/sequence
and a distinct claim challenge. The returned closed, signed, hash-chained
evidence attests exact `appended` CAS status. The packager verifies both
challenges, the predecessor/sequence transition, configured store identity, and
exact grant, context, repository, run, time, head, and signature bindings;
replay, conflict, stale evidence, or store failure prevents mutation. An
awaited store head or claim is canonicalized once, and every subsequent schema,
signature, and binding check uses only that immutable snapshot. The package
receipt must carry a canonical digest for the validated grant claim. A store
head is valid only as exact genesis `(sequence=0, head=null)` or non-genesis
`(sequence>0, head=Digest)`. An
authoritative injectable DLP
service scans every source and value before model context, every artifact before
packaging, and the complete reviewer output before COMMENT;
unknown, unavailable, restricted, stale, or wrong-scope results fail closed.
Regex checks remain defense in depth, not a claim of complete DLP. Any upstream
revision invalidates dependent artifacts and the artifact-set digest. The digest
also binds classification, and the trusted local-Git packager measures the exact
base-to-package diff against the effective Work Accord patch ceiling.
The production packager rejects any ambient staged entry, loads the authorized
default base into a temporary index, requires the proposal head to equal that
base, writes only exact authorized `100644` blobs, verifies the complete
base-to-final changed-path set, content digests, aggregate size, and resulting
tree, creates a deterministic single-parent commit, rejects symbolic or
out-of-namespace refs, and atomically verifies the default base while advancing
only the exact proposal ref with no-deref expected-head compare-and-swap. It
canonicalizes, deep-clones, and freezes the complete package request before
validation or an awaited read, rechecks that request digest before CAS, and uses
only the snapshot. The repository root is resolved once to a canonical path;
its repository identity, device, and inode are rechecked before object creation
and ref CAS. Its
environment disables inherited Git
configuration, hooks, credentials, filters, prompts, pathspec expansion, and
replacement refs. Before ref mutation, the packager constructs, signs, and
verifies a receipt payload bound to the intended base, proposal ref, authority
revision, parent, tree, commit, binary-diff digest, and byte count. Signer or
verification failure leaves both refs unchanged. Receipt time is captured after
the durable claim and must not predate its signed claim evidence. After the
atomic transaction or any ambiguous post-attempt error, the adapter
reauthenticates the operation grant and guard and revalidates the signed request,
authority, commit, tree, and diff, then reads
both exact direct refs without retrying the mutation. An unchanged old proposal
ref is a stale rejection, the exact intended base/commit returns the one
prepared receipt as reconciled success only after one locked verify-only
transaction proves both values coexist, and divergent or unreadable state is a
typed ambiguous/partial failure with no completed receipt.

Before provider invocation, the trusted adapter canonicalizes the complete
registered-capability payload, bounds its bytes, uses a conservative input-token
upper estimate, and reserves the remaining authorized output and cost envelope.
Any capability with nonzero registry or compiled cost authority requires a
positive reservation; zero is valid only for authoritatively zero-cost
capabilities.
The provider returns a purpose-scoped signed usage receipt bound to the authority,
grant, admission, request, and response. Invalid, missing, cancelled, timed-out,
or otherwise uncertain usage holds the full reservation and terminates without a
repository effect.

Drafting and review use separate service interfaces. Generated artifacts remain
distinct structured JSON values; no attacker-copyable text delimiter carries a
trust boundary. An independent signed threat assessment must bind the exact
review payload and candidate bundle before review and subsequent effects.
Review is COMMENT-only advice. Signed package and COMMENT
receipts must follow their exact operation grants and predecessor evidence, stay
within trusted current time and expiry, and precede the signed human-wait
checkpoint. The COMMENT request binds the earliest DLP/threat expiry for an
adapter-side pre-write check, and its signed receipt binds the exact repository
identity. Merge and closure grants and receipts continue that authenticated
causal order; future-dated closure guards are rejected before append. Approval evidence is
accepted only with a purpose-scoped signature and a
separately signed current actor authorization that proves numeric user identity,
repository permission, required team, role binding, and every configured role
incompatibility. Both bind the compiled authority, Work Accord, package,
COMMENT receipt, human-wait checkpoint, artifact set, repository, work item,
and the trusted packager's resulting artifact commit head. They must be issued
after the human-wait checkpoint. A fresh, purpose-scoped merge observation from
the independently bound merger must include current permission/team evidence for
the package head. Repository-only closure then requires a new merge-bound CAS
grant plus fresh repository, source, role, authority, and approval checks.
Exact signed claim and rights records are re-resolved before approval collection,
merge observation, closure authorization, and closure append. Their set digests
and earliest expiry bind the human-wait checkpoint, actor authorizations,
approvals, merge observation, and closure evidence; revocation, expiry, or any
record change after packaging blocks later closure.
The resolver additionally signs a monotonic authority revision/head over both
sets. A trusted authority-CAS service compares that exact revision/head while
holding the package-ref or closure-append effect callback, and its signed guard
is bound into the operation request and receipt.

## Marketing profile

The Work Accord scope is exactly `examples/marketing/workspace/`. Its eight
`100644` slots are:

| Slot | Maximum |
|---|---:|
| `initiative-intake.json` | 12 KiB |
| `audience-evidence.json` | 24 KiB |
| `positioning-messaging.json` | 24 KiB |
| `content-plan.json` | 24 KiB |
| `content-drafts.json` | 80 KiB |
| `measurement-plan.json` | 20 KiB |
| `brand-legal-assessment.json` | 20 KiB |
| `launch-readiness-assessment.json` | 12 KiB |

Evidence records exactly reproduce the signed source digest, content digest,
classification, repository locator, rights basis, bounded retention, observation
time, expiry, and source content. Model inference and counterevidence remain
separate from that authoritative observation. Claims and drafts cite approved
evidence and rights identifiers. Before
packaging, trusted resolvers require signed current evidence authorizing the
exact claim text/type/scope and the exact asset digest, license, internal
repository territory, repository-PR channel, expiry, and trademark status.
Assessment outputs remain
advisory and cannot approve or launch. Separate brand and legal humans are
required; neither may be the requester, automation actor, content author, or the
other approver.

Raw customer/email lists, identifiers, secrets, protected-attribute inference,
transcripts, restricted data, remote embeds, active content, bidi controls, and
unsupported evidence are rejected. Measurement artifacts define metrics only;
they contain no endpoint, identifier, query, or telemetry action.

## Business Operations profile

The Work Accord scope is exactly
`examples/business-operations/workspace/artifacts/`. Its nine `100644` slots are
`problem-framing.json`, `stakeholder-analysis.json`, `process-map.json`,
`decision-memo.json`, `policy-process-design.json`,
`implementation-plan.json`, `runbook.json`, `controls-approvals.json`, and
`outcome-measurement.json`.

Every artifact is evidence-linked and `proposalOnly`. Stakeholders use opaque
roles with unverified authority. Process maps must be acyclic, reachable,
bounded, and explicit about controls and irreversible boundaries. Decision and
policy artifacts retain options, tradeoffs, dissent, reversibility, controls,
and exceptions without claiming approval or effectiveness. Runbooks are
simulation-only. Controls require a quorum of exactly four with distinct owner,
operator, verifier, and policy-authority roles. Measurement definitions require numerator,
denominator, window, privacy floor, approved lineage, an unverified baseline,
and an independent verifier.

The requester, activator, proposer, process owner, control owner, policy
authority, implementer, measurement owner, verifier, reviewer, and merger are
pairwise-distinct authority classes; all 55 incompatibilities are pinned in the
pack definition and runtime invariant. Repository
permission never establishes business authority.

## Limits and effects

Both packs cap tokens at 20,000, duration at 600,000 ms, retry at one,
parallelism at one, recursion at zero, files at the exact slot count, and patch
bytes at 262,144. Although definitions permit at most two repair loops, the
current enterprise, Work Accord, and Domain Pack intersection narrows execution
to one. Limits are never raised to finish.

The maximum demonstrated workflow is a local-git-backed fake draft PR package,
COMMENT review receipt, explicit human wait, externally signed human approvals,
independent signed merge observation, and repository-only proposal closure.
The runtime has no merge mutation method: it can observe that exact proposal
artifacts were merged, but cannot merge them. Final runtime output reports
`proposal-artifacts-merged`; pre-review artifacts alone may report
`ready-for-human-review`. Repository branch/commit/draft-PR,
binding, COMMENT review, Issue/Project, and artifact receipts are the only
permitted effect classes. Marketing publication, scheduling, audience
activation, spend, and telemetry are deferred. Business data access, policy
enactment, implementation, go-live, production runbooks, communications, and
real outcome attestation are deferred.

## Local use

Run `npm test` for both network-free demonstrations and their adversarial
authority, DLP, evidence, approval, replay, schema, and refusal cases. They use
fake model, reviewer, Kernel authorizer, purpose-scoped signer/verifier,
CAS redeemer, DLP and claim/rights resolvers, ledger, clock, and GitHub services
plus isolated local Git repositories. Run
`npm run validate:schemas` to validate the profile catalog, definitions,
policies, Phase Contracts, Work Accords, templates, schemas, and content-addressed
examples. Behavioral fixtures are structural inputs for independent manual
evaluation; no validation command starts paid inference.

Human administrators must still deploy and review the GitHub App, OIDC
redeemer, signer/key custody, append-only ledger, serialized writer, repository
rulesets, billing controls, profile activation, and eligible approval groups.
