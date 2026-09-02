# ADR 0008: Security evidence is closed, deterministic, and durably claimed

- **Status:** Accepted
- **Date:** 2026-08-28

## Context

Operational security needs useful audit and cost signals without leaking secrets
or creating unbounded metric cardinality. Process-local replay sets do not stop a
valid operation grant from being reused by another worker. A privileged review
workflow must not check out untrusted pull-request code.

## Decision

Trusted adapters emit closed `AuditEvent`, `MetricRecord`, and
`BudgetDecisionEvidence` contracts. Audit records contain fixed enums, reason
codes, digests, counters, and a hash-chain predecessor, not raw prompts,
credentials, repository names, actor names, paths, or arbitrary labels. Metrics
are deterministically derived and label only fixed component and outcome enums.
Diagnostic values pass through bounded deterministic redaction before logging.
Canonical budget decisions retain their authority, budget, usage, reservation,
and nullable predecessor digests, closed projected usage, reason, status, and
times so redaction does not destroy forensic or causal evidence.
Audit creation, serialization, and metric derivation likewise canonicalize each
untrusted event once and use only that stable snapshot for validation, chain
checks, bytes, and counters. Canonical timestamps use UTC `Z` form with at most
three fractional-second digits, matching `Date.parse()` millisecond ordering and
bounding every timestamp to 24 characters.

Run-budget admission takes one canonical snapshot, then projects attempts,
fanout, concurrency, tokens, tool calls, effects, wall-clock age, and expiry from
that snapshot only. Malformed time, invalid arithmetic, accessors that cannot
produce canonical data, and overflow fail before evidence emission. Expiry or an
exhausted ceiling produces durable refusal evidence; limits are never raised or
inferred.

Every repository package operation requires an injected durable grant store. The
packager first presents an unpredictable challenge and validates a signed current
store head. It then presents a distinct claim challenge, expected predecessor,
and expected sequence to the atomic claim. The store returns a signed,
hash-chained `DomainOperationGrantClaim` whose `casResult` is exactly `appended`.
The packager validates both challenges, predecessor/sequence transition,
configured store identity, exact grant/request/run bindings, time ordering, head,
and signature before ref mutation. Package receipt time is read only after the
claim and cannot predate it. Replay, conflict, stale cached evidence, store
unavailability, or malformed evidence fails closed.
Every returned store head and claim is canonicalized once immediately after its
await; schema, signature, and binding checks use only that immutable snapshot.
The authenticated store-head state is exact: genesis is sequence zero with a
null head, and every positive sequence has a non-null digest.

Automated pull-request review uses trusted workflow code to compare the exact
base and redeemed head SHAs, bound the result, recheck both live identities, and
write one `review-target/evidence.json`. Before inference it copies the bounded
trusted reviewer profile and the two required skills into memory, removes every
entry from `GITHUB_WORKSPACE`, then recreates exactly that trusted profile, those
skills, and the evidence file under their supported repository-level discovery
paths. It removes duplicate activation `.github` material, `base`, and rendered
prompt source/import metadata from `/tmp/gh-aw`. Pinned v0.86.2 still adds the
workspace and `/tmp/gh-aw` as two Copilot roots, but explicit `bash: false`,
`edit: false`,
`cli-proxy: false`, bare mode, and command-line write/shell denials remove
all-path, shell, edit, ambient-instruction, and CLI-proxy authority. The source
pins Copilot CLI `1.0.79` for both review and threat-detection jobs; compilation
must pass that exact version to both installers without a compatibility-matrix
environment and both generated invocations carry `--no-auto-update`. The probe
executes `--no-auto-update --version` under the same isolated home used by the
reviewer and rejects any effective app other than `1.0.79`, including a cached
newer app. The exact reviewer profile exposes only read, search, and staged
safe-output tools; command-line write/shell denials are defense in depth, so the
boundary does not depend on precedence over gh-aw's generated write permission.
The workspace contains no repository source, `.git`, credential, or unrelated
file.
The unavoidable trusted control root contains the pinned action, harness, and
tool executables/scripts plus the rendered prompt, model/firewall metadata,
safe-output/MCP configuration, and bounded runtime logs/usage needed by the
pinned harness. The generated validator pins the exact post-guard setup-step
sequence so compiler drift cannot silently widen this residual surface. The
runtime probe hashes the official CLI archive and extracted executable and a
stable path/type/size/content manifest of the complete gh-aw setup JS directory,
including all harness siblings; it mechanically compares its permission flags
to the generated command before launch. The child environment is reconstructed
from a fixed allowlist with isolated `HOME`, `XDG_CONFIG_HOME`, and `TMPDIR`;
module-loader and process-injection hooks such as `NODE_PATH`, `NODE_OPTIONS`,
`LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are not inherited. A separate live denial challenge
keeps a random high-entropy, mode-`000` sentinel outside both added roots for the
entire launch, requests its exact content and a harmless shell-created marker,
then scans captured output and generated workspace/control logs for the secret
and checks the marker path. Before accepting the result, the probe requires the
sentinel path and open descriptor to retain the same device/inode, regular-file
type, mode `000`, and byte length, then restores descriptor access and compares
the complete content digest. Deletion, truncation, same-length rewrite, inode
replacement, mode change, and symlink swap fail with one secret-free error.
Cleanup uses the still-open descriptor to zero the original inode, removes any
replacement path without following a symlink, and preserves an earlier launch
error. An unexpected cleanup absence is a failure when no earlier error exists.
The sentinel is overwritten and removed in `finally`.
The model's response is not authority or proof that a tool call occurred; the
challenge proves only those external negative observations under this exact
fixture. Separately, the evidence fixture binds a random 160-bit `headSha` that
does not appear in prompt, environment, or arguments; the reviewer must return
that value under a distinct `evidenceHeadSha` result key. A constant version
string or fabricated digest cannot satisfy this read proof. The model has no
GitHub read tool and
cannot select a repository, pull request, or ref. The privileged workflow never
checks out or executes pull-request content. Domain reviewer artifacts remain
structured JSON fields rather than sentinel-delimited text.

## Consequences

- Deployments need an independently operated OIDC-authenticated redeemer,
  evidence signer, durable conditional ledger, operation-grant claim store,
  credential broker, and serialized Single Writer.
- Logs and metrics are useful for operations but do not become authorization.
- A failed claim or uncertain budget accounting can reduce availability but
  cannot produce a success-shaped fallback.
- Existing generated workflow locks must be regenerated only with pinned
  `github/gh-aw v0.86.2`.

## Rejected alternatives

- Process-local replay sets: rejected because restarts and parallel workers bypass
  them.
- Raw diagnostic payloads or repository/actor metric labels: rejected because
  they leak data and create unbounded cardinality.
- Delimiter-based reviewer framing: rejected because untrusted content can copy
  the delimiter.
- Privileged checkout of a pull-request head: rejected because repository content
  can influence checkout and later execution surfaces.
