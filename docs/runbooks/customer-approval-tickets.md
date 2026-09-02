# Customer approval ticket templates

Copy these templates into the customer's approved ticketing system. Replace
every angle-bracket placeholder. Do not paste credentials, private keys, tokens,
customer source, prompts, model responses, or confidential logs into tickets.

## 1. Evaluation and change approval

**Title:** Approve bounded Hyperfinite evaluation in GitHub Enterprise Cloud

**Business purpose**

Evaluate whether Hyperfinite can coordinate bounded, model-assisted software work
while deterministic controls retain authority over lifecycle, policy, targets,
credentials, effects, and evidence.

**Scope**

- Organization: `<customer-organization>`
- Repository: `<owner>/<repository>`
- Evaluation dates: `<start>` through `<end>`
- Demonstrations: `<selected demos>`
- Maximum users: `<number>`
- Maximum model budget: `<amount and unit>`

**Requested decision**

Approve a time-bounded evaluation that stops at Human Review. No autonomous
approval, merge, deployment, publication, billing change, organization
administration, or repository visibility change is in scope.

**Required approvers**

`<executive sponsor>`, `<evaluation lead>`, `<GitHub organization owner>`,
`<security owner>`, `<billing owner>`, and `<change manager>`.

**Backout**

Disable runtime activation, stop the Single Writer, revoke leases/tokens/keys,
retain evidence, and follow `docs/runbooks/recovery.md`.

## 2. GitHub organization administration

**Title:** Configure GitHub controls for Hyperfinite evaluation

**Requested changes**

1. Create four private Projects using the required titles and Board layout.
2. Link `<owner>/<repository>` to each Project.
3. Create or confirm `<owner>/<repository>` default-branch rules.
4. Run `npm run customer:configure -- --codeowner
   @<organization>/<team>` and confirm that team has repository write access.
5. Require pull requests, code-owner review, current-head approval, and the
   approved check set.
6. Configure selected/SHA-pinned Actions with no automation bypass.
7. Create the protected environment `<environment>`.
8. Configure approved repository variables only after service deployment.

**Evidence**

Attach protected exports of Project identities, rulesets, required checks,
Actions policy, environment protection, and CODEOWNERS resolution. Record only
digests or redacted summaries in repository issues.

**Acceptance**

`npm run github:setup -- bootstrap-readback` reports all API-supported
postconditions met, and a human verifies view grouping and column order.

## 3. Security architecture review

**Title:** Security review for Hyperfinite customer evaluation

**Review scope**

- deterministic authority model;
- model isolation and target-free output;
- GitHub App permissions and token brokerage;
- OIDC subjects and audiences;
- signing-key custody and rotation;
- conditional evidence and grant stores;
- Single Writer serialization;
- threat/DLP/evidence validation;
- logging, retention, recovery, and incident response; and
- software supply chain and pinned Actions.

**Required evidence**

`docs/security/threat-model.md`, `docs/security/control-matrix.md`,
`docs/security/github-app-permissions.md`, complete validation results, App
permission export, OIDC policy, key registry, service inventory, recovery drill,
and open security findings.

**Acceptance**

Document approved residual risks, required compensating controls, expiration
date, named security owner, and conditions that require re-review.

## 4. GitHub App, OIDC, and key custody

**Title:** Create customer-owned Hyperfinite GitHub App and workload identities

**Requested configuration**

- App owner: `<customer organization>`
- Installation scope: `<approved repositories only>`
- Permission source:
  `examples/pre-app/github-app-registration-plan.json`
- Webhook endpoint: `<customer endpoint>`
- OIDC audiences: `<one exact audience per service>`
- Key store: `<customer HSM/KMS/vault>`
- Rotation cadence: `<cadence>`
- Emergency revocation owner: `<role and contact>`

**Controls**

No PAT fallback, no model-visible credential, no shared signing identity, no
wildcard repository/workflow subject, and no write token before deterministic
authorization.

**Acceptance**

Fresh readback matches the approved App/installation identity and permission
plan; rotation and revocation are demonstrated without exposing key material.

## 5. Cloud platform and durable services

**Title:** Deploy Hyperfinite trust services and durable stores

**Services**

Deploy separate identities for webhook verification, runtime-state publication,
authorization redemption, evidence signing, durable-store brokerage, GitHub
token brokerage, Single Writer/reconciliation, installation/release adaptation,
and the isolated verification runner.

**Stores**

Provide isolated conditional stores for evidence, operation grants, receipt
journal, and runtime state, with compare-and-swap, idempotency, replay refusal,
backup, restore, and bounded capacity.

**Network**

Deny by default. Permit only exact service dependencies and `api.github.com`
where the reviewed topology requires it.

**Acceptance**

Health, latency, error, replay rejection, signing failure, store availability,
journal capacity, and budget signals are monitored. Backup/restore and disabled
recovery drills pass.

## 6. Model entitlement, billing, and budgets

**Title:** Approve bounded inference budget for Hyperfinite evaluation

**Requested limits**

- Provider/entitlement: `<approved service>`
- Evaluation budget: `<amount>`
- Per-invocation ceiling: `<amount>`
- Daily ceiling: `<amount>`
- Alert thresholds: `<thresholds>`
- Shutdown owner: `<name or role>`

**Controls**

Reserve the conservative maximum before provider start, authenticate usage,
settle known usage after failures, retain holds for unknown usage, and never
raise limits automatically.

**Acceptance**

Billing owner confirms entitlement, ceilings, alerts, reconciliation source, and
kill-switch authority.

## 7. Legal, privacy, and data governance

**Title:** Review Hyperfinite evaluation terms and data handling

**Questions**

- Is the MIT license acceptable for the customer's copy and intended use?
- What repository, issue, pull-request, and model data may be processed?
- Which data classifications are prohibited?
- Where are prompts, responses, logs, artifacts, backups, and evidence stored?
- What retention, deletion, residency, and access rules apply?
- Are subprocessors or model-provider terms acceptable?
- May evaluation evidence be shared back, and through which approved channel?

**Acceptance**

Record allowed data classes, prohibited data, retention, residency, approved
feedback path, and named legal/privacy owners.

## 8. Operations, monitoring, incident response, and support

**Title:** Establish Hyperfinite evaluation operations

**Requested decisions**

- primary and secondary operators;
- on-call or business-hours coverage;
- dashboards and alert routes;
- pause, rollback, and kill-switch thresholds;
- evidence retention and backup ownership;
- incident severity and escalation process;
- support intake and response expectations; and
- evaluation feedback cadence.

**Acceptance**

Run one tabletop incident and one disabled restore. Confirm operators can disable
activation, stop writers, revoke credentials, preserve evidence, and reconcile
ambiguous state without blind retry.

## 9. Final canary authorization

**Title:** Authorize one Hyperfinite customer canary

**Preconditions**

- all prerequisite tickets approved;
- exact repository head independently reviewed;
- Projects and App readbacks current;
- trust services healthy;
- rulesets, CODEOWNERS, checks, Actions, environments, GHAS, monitoring, and
  budgets verified;
- synthetic canary passed; and
- rollback owner available.

**Authorized action**

Enable one time-bounded synthetic canary that may create only a draft pull
request, produce current-head `COMMENT` review evidence, and stop at Human Review.

**Explicitly excluded**

Approval, merge, deployment, publication, repository/organization
administration, billing changes, visibility changes, and customer-data use.

**Evidence**

Record the exact head, plan and confirmation digests, run/attempt IDs, policy and
binding digests, budget reservation/settlement, draft PR identity, review
evidence, post-run readback, and disablement time.
