# ADR 0007: Domain Packs are policy-subordinate repository specializations

- **Status:** Accepted
- **Date:** 2026-08-27

## Context

Marketing and Business Operations need different artifacts, evidence rules,
roles, and review gates. Encoding those differences as model-selected runtime
roles or broad tools would let an untrusted model change authority and expose
publication or production systems.

## Decision

Domain profile selection is trusted configuration. Each pack is a closed
definition with immutable runtime invariants, exact logical slots and repository
paths, typed proposal artifacts, narrower capabilities, zero tool/network/MCP/
secret authority, bounded limits, explicit incompatible roles, and signed
current human gates. Models emit target-free registered capability outputs only.
The profile catalog contains every supported profile exactly once in canonical
order. Artifact semantics are not authorized by a denylist or model judgment:
an independent trusted service must sign a fresh exact-artifact assessment with
status `success`, bound to the compiled prohibited-effects policy, before review,
packaging, COMMENT, or human approval can proceed.
Trusted code compiles every Phase Contract and binds the definition, profile,
policies, schemas, templates, rubric, source evidence, dependency digests,
canonical repository numeric/node/full identity, repository-root identity,
work item, exact default/proposal refs, base/head, actors, lease, cumulative usage, exact-success threat evidence,
receipts, and artifact set in an applied Kernel authorization.
GitHub work-item node IDs are bounded opaque identities whose exact bytes and
case are preserved; they are not repository slugs.

Validated authority inputs are structured-cloned and recursively frozen; their
canonical digests are rechecked at every boundary. Every model call and
repository effect requires a separately signed, atomically redeemed operation
grant bound to the complete canonical request. For packaging, the purpose-scoped
operation grant is authenticated repeatedly by the trusted adapter, and the
subsequent signed claim/rights authority guard binds the exact guard-free request
and the grant digest, signature, nonce, run identity, and expiry. Repository
packaging also atomically claims the grant in an injected durable cross-process
store and binds its closed, signed, hash-chained claim evidence into the package
receipt. Authoritative DLP runs before context, packaging, and COMMENT review.
Marketing claims, sources, and rights
resolve to signed, current, exact-scope evidence and are re-resolved before
approval, merge observation, and closure. Their digests and minimum expiry bind
each later human and ledger record. Reviewer invocation additionally
requires independent exact-payload prompt-threat evidence. Candidate artifact
content remains a structured JSON field rather than delimiter-framed text.
Business Operations
uses pairwise separation for all eleven authority roles.
Approvals require independently signed actor authorization and are valid only
after signed package and COMMENT receipts and a later signed human-wait checkpoint
exist.
Every package, COMMENT, merge observation, and closure receipt is authenticated,
not future-dated, within its grant/evidence expiry, and causally ordered after its
exact operation grant and all predecessor evidence.

Provider admission reserves the conservative input-token upper bound and maximum
output before each call. Only authenticated, request-bound provider usage can
settle that reservation; exceptions, cancellation, or missing or invalid usage
hold the full reservation and stop the run. Repository packaging uses a
production trusted adapter with an isolated temporary index, exact path/mode/blob
and complete authenticated base-to-final tree/diff checks, deterministic commit
construction, and an atomic default-base verification plus expected-head
`update-ref --no-deref` compare-and-swap on an exact non-default proposal ref.
The packager canonicalizes, clones, and freezes the full request before any
await, pins the canonical repository root identity, device, and inode, and
rechecks both immediately before object creation and ref CAS. It signs and
verifies the complete intended receipt before mutation; signer failure causes
zero ref effect. Successful CAS is followed by an exact direct-ref readback,
and ambiguous post-attempt errors reconcile without a second mutation. Only the
exact intended default/proposal state returns the one prepared receipt; old
state rejects and divergent or unreadable state remains typed ambiguous. Both
success and old-state classification require one atomic verify-only ref
transaction so separate observations cannot manufacture a valid pair.
The proposal head must equal the authenticated default base; accumulated proposal
history is rejected because no prior-artifact manifest authority exists. Symbolic
refs and refs outside the approved namespace are rejected. Claim and
rights evidence also carries a signed monotonic authority revision/head; trusted
authority CAS guards both package-ref advancement and closure append. Ambient
staged or committed content, hooks, inherited configuration,
replacement refs, stale evidence, and concurrent head changes cannot enter or
advance the authorized package.

Every nonzero-cost model capability must obtain a positive atomic cost
reservation before invocation; zero is accepted only when both the registry and
compiled capability authoritatively declare zero cost.

Marketing requires separate brand and legal evidence. Business Operations
requires exact `control-owner`, `implementer`, `verifier`, and
`policy-authority` control roles with quorum four. Both stop
automated effects at a draft repository package and can close only after
COMMENT review, an explicit human wait, and a fresh signed observation that an
independent human merged the exact proposal artifact set. The pack has no merge
mutation authority. Merging proposal artifacts never means publication, policy
enactment, implementation, go-live, or achieved outcomes.

## Consequences

- A pack cannot broaden enterprise, Accord, Phase Contract, registry, Kernel,
  adapter, or Single Writer policy.
- Adding or changing a slot requires coordinated schema, definition, policy,
  security, test, and documentation review.
- External publication and business-operation integrations require a future
  architecture decision and cannot be added as a pack convenience.
- Useful model output may be rejected when evidence, privacy, role, graph,
  dependency, or size rules are incomplete.
- Receipt and artifact retention are bounded to 90 days; gate evidence is
  current for at most five minutes.

## Rejected alternatives

- Model-selected domain roles or paths: rejected as confused-deputy authority.
- Publication or business-system adapters behind human confirmation: rejected
  because they expand this delivery's effect and credential surface.
- Treating COMMENT review as approval: rejected because model review is not
  independent human authority.
