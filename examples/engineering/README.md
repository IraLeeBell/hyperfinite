# Hermetic engineering slice

This example exercises the complete engineering control path without network
access, paid inference, credentials, or live GitHub mutation. The test harness
uses an isolated local Git repository plus in-memory model, signer, redeemer,
evidence, GitHub, and clock services.

Activation, framing, and planning gate evidence is issued before orchestration
from simulated GitHub approval events and fresh repository permission evidence.
After COMMENT review the first invocation stops at a signed
`awaiting-human-merge` checkpoint. Only then does the fake emit an independent
exact-head approval and a later human merge event for a separate resume
invocation. Caller-selected actors, bots, requesters, stale heads, weak roles,
missing approvals, and out-of-order merge events are rejected.

Run the demonstration:

```sh
npm test -- --test-name-pattern="engineering slice"
```

The only executor-writable location is `examples/engineering/workspace/**`.
The fake GitHub service records typed branch, commit, draft pull request,
COMMENT-only review, Project, Issue, delivery, and operations effects. It then
simulates observation of an independent human merge; no automation API exposes
approve, dismiss, auto-merge, or merge operations.

Failure and recovery coverage includes binding substitution, stale gates and
heads, non-success threat evidence, effect replay/CAS conflicts, partial write
reconciliation, path traversal, case collisions, symlinks, unexpected files,
mode/rename/copy/submodule/binary changes, patch limits, command injection,
timeouts, nonzero commands, output limits, credential stripping, signed
plan/grant substitution, pre-inference grant rejection, and restart recovery
from authenticated awaiting-human, pre-release, and closure checkpoints for Project,
Issue, delivery, and operations effects. Hostile Git hooks, aliases, credential
helpers, fsmonitor, replacement refs, global/system config, templates, and Git
pathspec magic are ignored or refused; staged and indexed paths must equal the
exact authorized literal targets. Cost fixtures cover provider failure, unknown
usage holds, lost settlement and release acknowledgements, and prove that a
15-unit reservation with 3 units consumed releases exactly 12 units once.
The final Kernel completion transition also carries a stable trusted transition
key, so a lost acknowledgement can be resumed without a second transition.

The compiled execution workflow exposes only `stage_implementation_patch`; it
does not contain gh-aw's default `create_issue` output. A signed target-free
planning context reaches the model, while the exact path-bearing grant moves in
a separate run/attempt-bound artifact to the credential-free trusted bridge.
The bridge requires both detector outputs to report exact success and the actual
authenticated applied Kernel result. It persists one signed execution bundle
containing the authorization, Kernel result, current policy digests,
exact-success threat evidence, and complete signed patch content with
base/tree/patch, plan, grant, model-output, threat-evidence, and Kernel-proof
digests. A separate trusted consumer round-trips and revalidates that bundle
before an operation-scoped delivery port can act.

Live deployment remains disabled by default. Human administrators must deploy
and configure the GitHub App, OIDC redeemer, signer, append-only evidence
store, serialized writer, Project schema, rulesets, and billing controls before
any production mutation is possible. The App permission
`pull_requests: write` is platform-broad; repository rulesets and independent
human review remain mandatory because the framework does not authorize approve
or merge effects.
