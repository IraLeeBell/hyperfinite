# Engineering thin-slice plan

## Status

**Implemented and retained as the engineering reference slice.** The
deterministic harness uses local Git plus fake model, signer, redeemer, GitHub,
evidence-store, and clock services. It performs no network call, paid inference,
credential use, or live GitHub mutation. Sandbox and production activation
remain disabled until the administrator prerequisites in the runtime runbook
are deployed and reviewed.

## Goal

Demonstrate the complete engineering lifecycle through the GitHub-native trust plane:

1. Bind exactly one Issue and one matching Project item as the canonical work
   identity, then append an optional pull-request binding through a
   receipt-backed compare-and-swap.
2. Validate Work Accord, schema, actor, policy, Activation Lease, signed
   one-time cost reservation, and trusted time. Human gates are pre-issued from
   authenticated GitHub events and fresh permission evidence; the orchestrator
   can read them but cannot mint or rewrite actor claims.
3. Produce typed framing and planning artifacts. Separate `accept-frame` and
   `accept-plan` approvals bind the exact artifact, route, snapshot, Work Accord,
   lease, actor, and expiry; revisions do not consume a future approval.
4. Give the model only approved logical target slots. Trusted code intersects
   their exact paths with the Accord and removes the complete trusted computing
   base before creating a fresh isolated local Git repository with inherited
   configuration, hooks, credentials, and replacement refs disabled.
5. Materialize model content in the worktree and treat the resulting diff as
   untrusted. Validate traversal, real paths, links, submodules, rename/copy,
   case, mode, binary, file/patch/size limits, and unexpected files.
6. Run only reviewed verification command IDs mapped to fixed argv, environment,
   time, resource, and output limits. Model-provided command text is never run.
7. Translate target-free output into ordinal-bound branch, commit, draft pull
   request, and PR-binding effects with exact base SHA, head, tree, patch, work
   item, Accord, lease, and current binding.
8. Require exact-success threat evidence and the actual authenticated applied
   Kernel result before an operation-scoped GitHub client is obtained. Persist
   one complete signed bundle containing the authorization, Kernel result,
   current policy digests, threat evidence, and full patch artifact before
   upload. A disabled-by-default OIDC invocation binds the exact workflow run,
   artifact ID, archive digest, and bundle digest; the trusted service downloads
   and round-trips that artifact through canonical binding resolution and the
   concrete adapter/Single Writer branch, commit, draft-PR, and PR-binding
   effects. Re-read
   before each effect, reconcile after each write,
   and record signed CAS evidence containing exact workflow, revision, effect
   type, and effect ordinal for replay or partial-failure recovery.
9. Emit automated review only as `COMMENT` on the exact current head. Head
   movement invalidates the review; automation cannot approve, dismiss, merge,
   or enable auto-merge.
10. Stop after COMMENT review and persist a signed `awaiting-human-merge`
    checkpoint. A later invocation consumes independently issued exact-head
    approval evidence and a later fresh human-merge observation. It persists a
    signed discoverable pre-release checkpoint, reconciles the stable release
    key and receipt, then persists a closure checkpoint before converging the
    Project, closing the Issue, recording
    delivery evidence, hand off operations measurement, and only then enter
    `COMPLETED`. Every closure effect is
    restart-safe through an exact read-after-write observation and signed CAS
    evidence; the final Kernel transition uses a stable trusted replay key.

## Implemented dependencies

- Control Kernel and closed schemas;
- GitHub adapter and Trusted Binding;
- Copilot and Agentic Workflow runtime;
- Activation Lease, budget, evidence, and delivery boundaries.

## Required scenarios

| Scenario | Expected evidence |
|---|---|
| Happy path | Receipts from activation through completion |
| Invalid actor | Refusal with authorization rule ID |
| Prompt/target injection | Adapter rejection before effect planning |
| Missing, duplicate, swapped, or wrong Project/PR binding | Canonical binding refusal |
| Duplicate event/rerun | Same idempotency key and no duplicate effect |
| Concurrent delivery | Single ordered writer; losing attempt discarded |
| Partial effect | Blocked state and deterministic reconciliation |
| Lost acknowledgement during Project/Issue/delivery/operations closure | Restart reconciles the exact observation without a duplicate write |
| Dependency unresolved | Blocked without model call |
| Budget/lease expiry | Return to activation pending |
| Changed Work Accord | Stale artifacts invalidated |
| Changed PR head | Review/check result invalidated |
| Unauthorized reviewer | Approval rejected despite `APPROVED` state |
| Threat warning/skip/failure | Every write path blocked |
| Human-requested revision | Bounded loop to executing |
| Recovery | Live GitHub evidence reconstructs projection |
| Free-form verification, timeout, or nonzero result | Refusal without command substitution |
| Traversal, link, submodule, rename/copy, case, mode, binary, or unexpected file | Executor refusal |
| Signed plan/grant or workflow identity substitution | Refusal before bounded execution or delivery |
| Lost provider response or settlement acknowledgement | Authoritative usage is settled or its allocation remains held; consumed cost is never released |
| Crash between cost hold and provider begin | Budget remains held and reconciliation-required; absence of attempt evidence never releases it |
| Lost cost-release acknowledgement | Public binding lookup finds the signed pre-release checkpoint; retry reconciles the same release key before any closure effect |
| Missing/out-of-order human approval or merge event | Resume refuses; no release or closure effect occurs |
| Live lease revoked between provider calls | Every later model call remains at zero |
| Restart after merge/cost release | Signed checkpoint resumes only Project, Issue, delivery, operations, and final Kernel convergence |
| Hostile Git config, hook, template, credential helper, fsmonitor, or replace ref | Isolated Git execution ignores it |
| Git pathspec magic, extra index entry, or empty staged diff | Literal-path executor refuses before patch handoff |

## Acceptance

- No model chooses targets, transitions, capabilities, retries, or effects.
- No model or App approves or merges its own PR.
- Current-head verification is repeated before every privileged PR effect.
- App tokens are short lived and operation scoped; no PAT exists.
- Every transition and refusal is reproducible from durable GitHub evidence.
- External publication, deployment, and production mutation remain unavailable.

Run `npm test -- --test-name-pattern="engineering slice"` for the end-to-end
demonstration and `npm test -- --test-name-pattern="bounded worktree"` for the
executor attack matrix. Exact implementation and recovery notes are in
`examples/engineering/README.md`.
