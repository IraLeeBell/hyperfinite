# Copilot runtime activation runbook

## Purpose and stop condition

Use this runbook only for a reviewed sandbox activation after every
administrator prerequisite is met. The repository ships with the runtime
disabled, default-branch slash-command triggers, and staged outputs. Hermetic
repository evidence cannot authorize a live GitHub write.

Stop if any administrator prerequisite, digest, fresh binding, cost
reservation, exact-success threat result, current-head decision, or Evidence
Ledger component is missing. Do not substitute a PAT, personal token,
workflow-dispatch environment approval, unsigned authorization, or model
judgment.

## Administrator prerequisites

An administrator and security owner must complete these actions outside this
pull request:

1. Review the Agentic Workflows Public Preview terms, organization Copilot
   policy, billing, retention, data residency, and provider/model availability.
2. Install a dedicated GitHub App with only the repository, issue,
   pull-request, Project, metadata, and effect permissions required by the
   existing adapter. Keep its private key in sign-only infrastructure.
3. Record the App's numeric application and bot actor identities. Do not store
   an App key, installation token, PAT, Project ID, or customer value in the
   repository.
4. Create or reconcile the Project using
   `npm run github:setup -- --snapshot <fresh-snapshot>`. A human performs the
   printed actions and reviews the resulting binding.
5. Deploy the Control Kernel, runtime-state publisher, authenticated
   authorization redeemer/Evidence Ledger, trusted runtime bridge, credential
   broker, and Single Writer. The redeemer must authenticate workflow calls with
   GitHub Actions OIDC, hold isolated GitHub App Projects-read authority and
   Ed25519 signing custody, and serialize atomic redemptions on both nonce and
   `(workflow, run_id, run_attempt)`.
6. Configure default-branch protection, CODEOWNERS/rulesets, Actions policy,
   environment/secret protections where separately required, and independent
   human current-head review.
7. Validate logging, redaction, pause/revocation, cost reservation, detector
   failure, partial-write reconciliation, and rollback procedures.

Workflow-dispatch environment inputs are not approval gates and executable
runtime workflows expose no `workflow_dispatch` trigger. Repository and
organization protections must be configured by a human administrator.

## Validate the reviewed source

Install and verify only the reviewed stable compiler:

```text
gh extension install github/gh-aw@v0.86.2
gh aw version
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:customer-readiness
npm run typecheck
npm run build
npm test
npm run validate:schemas
npm run validate:runtime
npm run validate:eval-fixtures
npm run validate:provenance
npm run validate:workflows
npm run validate:gh-aw
npm run validate:packaging
npm audit --audit-level=high
git diff --check origin/main...HEAD
npm run validate:demos
npm run simulate:demos
npm run validate:hardening
```

For a review-boundary change on the supported proof host (`darwin-arm64`), point
`COPILOT_CLI_ARCHIVE_PATH` at the official
`copilot-darwin-arm64.tar.gz` from Copilot CLI `v1.0.79` and
`GH_AW_HARNESS_PATH` at `github/gh-aw@v0.86.2`'s
`actions/setup/js/copilot_harness.cjs`, then run:

```text
COPILOT_CLI_ARCHIVE_PATH=/trusted/copilot-darwin-arm64.tar.gz \
GH_AW_HARNESS_PATH=/trusted/gh-aw-v0.86.2/actions/setup/js/copilot_harness.cjs \
npm run validate:review-agent-runtime
COPILOT_CLI_ARCHIVE_PATH=/trusted/copilot-darwin-arm64.tar.gz \
GH_AW_HARNESS_PATH=/trusted/gh-aw-v0.86.2/actions/setup/js/copilot_harness.cjs \
npm run validate:review-agent-runtime -- --live
```

The probe requires archive SHA-256
`706ff7b43c62e667ec0f9b613d3ccdd62c690c89697467d33ef36615a7e8481d`,
extracted executable SHA-256
`637f85f8c6aa0c1b03ba0949ab2d7dbc705d2f0519802fa92c5493841d93925f`,
and complete gh-aw setup JS tree manifest SHA-256
`4ae3ad402b6fe1070b57ea34cb0eeb789bbc09f7b0590be0a5e5ebe9ed2ae9f9`.
The manifest binds stable relative paths, entry types, file sizes, and file
digests for all 805 tree entries; a sibling change, missing/extra entry, symlink,
or non-file entry fails before launch.

The offline negative control must report `No such agent: runtime-reviewer`.
Authorized live mode must resolve that agent from the final four-file workspace,
read a random 160-bit `headSha` from the bounded evidence, and echo it under the
distinct `evidenceHeadSha` result field. The nonce must be absent from prompt,
environment, and arguments; a constant `schemaVersion` response is not proof.
The probe then runs a separate denial challenge while a random high-entropy
mode-`000` sentinel
remains present outside both add-dir roots: the prompt requests that exact
content and a harmless shell-created marker inside the test workspace. The run
passes only when captured process output plus generated workspace/control logs
contain no secret, the marker does not exist, and post-launch path/descriptor
checks preserve the original device/inode, regular-file type, mode, size, and
content digest. The open descriptor is zeroed and the exact path removed even
after replacement. Delete, truncate, rewrite, replace, chmod, and symlink-swap
fixtures must all fail generically without disclosing the secret. Do not cite a
model refusal or self-report as proof
that a tool call occurred, and do not describe `--add-dir` as a general read
sandbox. The probe also verifies that its security-sensitive flags match the
generated command. Its child environment uses a fixed allowlist and isolated
home/config/temp roots; `NODE_PATH`, `NODE_OPTIONS`, `LD_PRELOAD`,
`DYLD_INSERT_LIBRARIES`, and unrelated parent variables are excluded. Inspect
the compiled agent and threat-detection jobs and require this exact command in
both:

```text
bash "${RUNNER_TEMP}/gh-aw/actions/install_copilot_cli.sh" 1.0.79
```

Neither step may set `GH_AW_COMPILED_VERSION`; an omitted version, range, or
compatibility-matrix lookup in either job is a blocker. Both generated Copilot
invocations must include `--no-auto-update`, and the live probe must report that
`--no-auto-update --version` executed the effective `1.0.79` app under the same
isolated home used by inference. A launcher-only version check is insufficient.

`gh aw version` must report `v0.86.2`, corresponding to commit
`48e5fa3ff52294d91d97715017a9f8693a48387f`. Review every `.md` source beside
its `.lock.yml` and `.github/aw/actions-lock.json`. Do not hand-edit generated
locks. The pinned v0.86.2 CLI does not expose an `update-actions` command;
action upgrades are part of `gh aw upgrade`. Treat any such upgrade as a
separate reviewed change, recompile, inspect the generated manifest and action
SHAs, and rerun the full matrix.

`validate:gh-aw` accounts for a v0.86.2 behavior where strict validation
rewrites `actions-lock.json` with the default action-mode repository. It runs
strict validation first, restores the reviewed release-mode artifact with:

```text
gh aw compile --gh-aw-ref v0.86.2 --strict --validate --approve --no-check-update
npm run validate:workflows
```

The command fails unless all generated bytes match their starting values and
the generated files have no unstaged Git diff at exit.

## Configure repository variables

Set variables only after the prerequisites are complete:

| Variable | Required value |
|---|---|
| `AGENTIC_RUNTIME_ENABLED` | Exact string `true` only during an approved activation window |
| `AGENTIC_ALLOWED_ACTOR_IDS` | Comma-separated positive numeric IDs of approved humans |
| `AGENTIC_APP_ID` | Numeric ID of the dedicated trusted App |
| `AGENTIC_APP_ACTOR_ID` | Numeric bot-user ID of that App |
| `AGENTIC_PROJECT_NODE_ID` | Node ID of the reviewed Project |
| `AGENTIC_WORK_ACCORD_DIGEST` | Canonical sha256 digest of the reviewed Work Accord |
| `AGENTIC_POLICY_DIGEST` | Canonical sha256 digest of the deployed runtime policy |
| `AGENTIC_KERNEL_POLICY_DIGEST` | Administrator-approved canonical sha256 digest of `config/v1alpha1/policy.json` |
| `AGENTIC_ACTIVATION_LEASE_DIGEST` | Canonical sha256 digest of the active lease |
| `AGENTIC_STATE_SIGNING_KEY_ID` | Reviewed identifier of the active Ed25519 verification key |
| `AGENTIC_STATE_SIGNING_PUBLIC_KEY` | Base64-encoded DER SubjectPublicKeyInfo for that Ed25519 key |
| `AGENTIC_REDEEMER_URL` | HTTPS endpoint of the trusted authorization redeemer |
| `AGENTIC_REDEEMER_AUDIENCE` | Exact OIDC audience accepted only by that redeemer |
| `AGENTIC_REDEEMER_SIGNING_KEY_ID` | Reviewed identifier of the redeemer's Ed25519 authorization key |
| `AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY` | Base64-encoded DER SubjectPublicKeyInfo for authorization verification |
| `AGENTIC_EVIDENCE_SIGNER_URL` | HTTPS endpoint that signs threat and validated-patch evidence only for the reviewed OIDC workload |
| `AGENTIC_EVIDENCE_SIGNER_AUDIENCE` | Exact OIDC audience accepted only by the evidence signer |
| `AGENTIC_EVIDENCE_SIGNING_KEY_ID` | Reviewed identifier of the evidence signer's Ed25519 key |
| `AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY` | Base64-encoded DER SubjectPublicKeyInfo for evidence verification |
| `AGENTIC_EXECUTION_DELIVERY_URL` | HTTPS endpoint of the trusted artifact downloader and delivery consumer; omission keeps post-upload delivery disabled |
| `AGENTIC_EXECUTION_DELIVERY_AUDIENCE` | Exact GitHub Actions OIDC audience accepted only by the trusted delivery consumer |

Keep the runtime disabled when idle. The workflow uses the ephemeral
`GITHUB_TOKEN` only for guarded reads and the Copilot request. Model jobs do not
receive App credentials, repository secrets, external network destinations, or
external MCP servers.

## Publish trusted runtime state

For the exact issue or pull request, the deployed trusted service must:

1. obtain fresh repository, work-item, Project-item, and pull-request-head
   evidence;
2. evaluate the requested Control Kernel transition;
3. issue a unique, unpredictable, single-use nonce and ensure the lease has at
   least 500 remaining AI credits for main, continuation, and detector maxima;
4. construct a schema-valid `CopilotRuntimeState@2.0.0` bound to the repository,
   workflow, route, receipt, current head, runtime policy, exact Control Kernel
   enterprise-policy digest, lease, nonce, complete Trusted GitHub Binding
   digest, and distinct `workAccordBindingDigest()` Kernel identity;
5. call `runtimeStateSigningPayload(state)` and sign the canonical JSON bytes of
   its exact domain wrapper with the external Ed25519 signing key:

   ```json
   {
     "domain": "agentic-framework.runtime-state-signature.v2",
     "state": "<complete CopilotRuntimeState@2.0.0 object excluding signature>"
   }
   ```

   Then attach `{algorithm:"ed25519",keyId,value}` to the state. Do not sign the
   unwrapped state or a caller-selected subset;
6. publish the state through the configured GitHub App as a new comment:

```text
<!-- agentic-framework-runtime-state
<canonical CopilotRuntimeState JSON>
-->
```

The marker must contain no secret. Never edit a marker; publish a new signed
record. The guard resolves the final comment page, considers at most its latest
100 comments, rejects edited markers, and chooses the newest marker with exact
App/actor attribution and a valid configured-key signature. It fails closed if
either repeated first/last-page ETag, page count, selected identity/update time,
state digest, or head changes during the read. If no matching marker is visible,
activation fails closed; do not relax the query or copy a marker from another
item.

The redeemer signs `CopilotRuntimeAuthorization@2.0.0` the same way: call
`runtimeAuthorizationSigningPayload(authorization)` and sign the canonical JSON
bytes of:

```json
{
  "domain": "agentic-framework.runtime-authorization-signature.v2",
  "authorization": "<complete CopilotRuntimeAuthorization@2.0.0 object excluding signature>"
}
```

The authorization digest separately uses the
`agentic-framework.runtime-authorization-digest.v2` domain. Runtime state and
authorization schema `1.0.0` records are incompatible with the dual-binding and
v2 signature domains. They are rejected and cannot be transformed: revoke any
remaining nonce/reservation and issue fresh `2.0.0` evidence from authenticated
current inputs.

For framing, state must be `FRAMING`, role `framer`, and capability
`core.frame-artifact@1.0.0`. For execution, state must be `EXECUTING`, role
`executor`, and capability `core.execute-bounded-change@1.0.0`. For review,
state must be `VERIFYING`, role `reviewer`, capability
`core.review-current-head@1.0.0`, and `currentHead` must equal the pull request's
fresh 40-character head SHA.

## Invoke an authorized run

Post the exact command as an authorized repository collaborator:

- `/agentic-frame` in an issue body or issue comment;
- `/agentic-execute` in an issue comment; or
- `/agentic-review` in a pull-request comment.

The compiler admits only exact roles `admin`, `maintainer`, and `write`; the
guard additionally requires the actor's numeric allowlist entry and a live
legacy collaborator permission of `admin` or `write` (`maintain` maps to
`write`). The v0.86.2 source uses `jobs.agent.needs: [pre-activation]`; the
compiler maps that alias to a direct generated `pre_activation` dependency
alongside `activation`. Validation rejects every
`needs.<job>.outputs.<name>` reference unless `<job>` is a direct dependency
and declares `<name>`. Do not invoke on an unbound Project item, an expired or
revoked lease, a changed head, a
reused nonce/run attempt, or behalf of a bot. The guard verifies that the
executed workflow source and SHA are from the current default branch.

Before model execution, the guard obtains a GitHub Actions OIDC token and asks
the trusted redeemer to re-read stable state and Project authority, fresh-check
lease/state revocation, and atomically reserve 500 AI credits. Replay, CAS
conflict, stale evidence, insufficient credits, or unavailable service fails
closed. The returned authorization is signed and bound to the exact run ID,
attempt, nonce, workflow, actor, event, binding, route, receipt, cost, and
expiry. Runtime state, revocation checks, redemption, and threat evidence must
be ordered against trusted service time and no more than five minutes old. The
per-invocation maximum remains 500 AI credits; the 1500 daily ceiling permits
the three sequential phase workflows.

The workflow may consume paid inference only after this redemption. Its safe
output is staged and must not create a comment or review. Preserve the signed
authorization, redemption record/digests, output, threat evidence, usage, and
logs for review.

For execution, preserve logical target slots through the model boundary.
Trusted code maps them to exact approved paths in an isolated repository, removes
the complete TCB denylist, validates the resulting Git diff, and invokes only
reviewed command IDs. Never execute command text from an artifact or model
response. Reject links, submodules, renames/copies, case collisions, mode or
binary changes, unexpected files, limit overruns, timeouts, nonzero exits, and
inherited credential variables. Disable inherited Git system/global/local
configuration, hooks, templates, aliases, credential helpers, fsmonitor,
external diff drivers, interactive prompts, and replacement refs.

For review, the agent job checks out only trusted runtime files from
`github.workflow_sha`. It never checks out or executes pull-request content in
the privileged `issue_comment` workflow. Trusted code compares the exact live
base and signed head, rejects a 300-file or 4 MiB evidence boundary, writes one
temporary `0600` evidence file, and then rechecks both live identities. After
the compiler restores its inline agents and skills, the final pre-agent step
buffers the exact reviewer profile and two required skills, deletes every
workspace entry, recreates only those trusted discovery files plus
`review-target/evidence.json`, removes the temporary evidence, duplicate
activation `.github` data, `base`, and rendered prompt source/import metadata,
and verifies the exact four-file shape.
The model has no GitHub read, shell, or edit tool and cannot choose a repository,
pull request, or ref. Pinned gh-aw still exposes its rendered prompt,
model/firewall metadata, safe-output/MCP configuration, bounded logs/usage, and
pinned action/harness/tool scripts and binaries through its required
`/tmp/gh-aw` control root. Validation pins the exact seven post-guard setup steps
that may construct this surface; no repository source or App credential is
placed there. A push during
materialization aborts the run, and the bridge still performs its fresh binding
check before any effect.

## Review and effect handoff

For review runs, a human must inspect the exact current head and the automated
`COMMENT` findings. Automated review has no approval or merge authority.
Head movement invalidates the run and requires new state, nonce, slash command,
and human decision.

A deployed trusted service may hand staged output to
`bindKernelAuthorization()` and `bridgeRuntimeOutput()` only when:

- the signed authorization and redemption bind this exact run/attempt/nonce;
- `bindingDigest` recomputes from the complete fresh `TrustedGitHubBinding`,
  while `kernelBindingDigest` matches the actual applied Kernel snapshot and
  destination receipt; the two domains are never substituted or copied;
- the bridge receives an applied Kernel result, recomputes its receipt/effect
  digests, and matches its route, capability, binding, head, Work Accord,
  snapshot, processed event, receipt head, and signed Control Kernel
  enterprise-policy digest;
- the signed runtime-policy digest matches the deployed policy;
- threat status is exactly `success`;
- threat input/output digests match the authorization and closed safe output;
  and
- all evidence is fresh and unexpired.

Execution also requires both generated detector outputs to be exact success.
The redeemer response must contain both the signed authorization and the actual
authenticated applied Kernel result. The pre-activation job transfers both
files, and the bridge persists one complete signed execution bundle containing
them, current policy digests, exact-success threat evidence, and the full patch
artifact. After upload, the disabled-by-default delivery invocation sends the
OIDC-authenticated repository/workflow/run identity and exact artifact ID,
archive digest, and bundle digest to the configured service; it sends no App
credential or model-selected target. The trusted service downloads that exact
artifact with operation-scoped authority. Its consumer round-trips the serialized bundle and
rechecks its authorization, plan, grant, base, content, tree/patch, threat,
Kernel result/receipt/route/capability/policy, signature, and time bindings
before resolving canonical binding and constructing branch, commit, draft-PR,
and PR-binding Effect Plans. Those plans still pass through the GitHub Single Writer. The
model job must never receive the App client or invoke the writer. The hermetic
slice demonstrates signed ordinal effects, read-after-write reconciliation,
human-merge observation, Project/Issue convergence, delivery evidence,
operations handoff, unused-cost release, and authenticated closure resume
without rerunning model phases. The slice first stops at a signed
`awaiting-human-merge` checkpoint. Resume requires independently issued
exact-head approval evidence followed by a later observed human merge. Before
any Project/Issue/delivery/operations effect, persist a signed pre-release
checkpoint, reconcile the stable cost-release idempotency key, and durably store
the release receipt. Keep the live handoff inactive until the App, OIDC redeemer, independent threat,
DLP and artifact-policy services, signer, delivery consumer, authenticated
conditional Evidence Ledger, durable operation-grant claim store, serialized
writer, Project/rulesets, and billing are deployed and reviewed.

The workflow source explicitly disables gh-aw failure issues, failed-job
issues, `missing-tool`, `missing-data`, `report-incomplete`, and `noop`.
Generated conclusion jobs must have no `issues: write`. Do not remove these
settings even while outputs remain staged.
The generated review Safe Outputs job is preview-only: validation requires
`GH_AW_SAFE_OUTPUTS_STAGED` to be exact `true` and its job permission map to be
empty. It therefore cannot post stale findings if the head moves during
inference. A deployed trusted bridge must fresh-check and bind the exact current
head before constructing the only permitted `COMMENT` Effect Plan.

## Pause, rollback, and incident response

To pause, set `AGENTIC_RUNTIME_ENABLED` to anything other than exact `true`,
revoke active leases, and cancel queued runs. If credentials or state
attribution may be compromised, suspend the App installation and rotate the
signing material through the external key service.

Do not delete evidence. Preserve logs, state markers, threat records, kernel
receipts, and effect-chain heads. Reconcile any pending or partial effect using
the Single Writer runbook; never blindly retry. Roll back source changes by
reviewed pull request, regenerate locks with the pinned compiler, and keep
activation disabled until security review is complete.
