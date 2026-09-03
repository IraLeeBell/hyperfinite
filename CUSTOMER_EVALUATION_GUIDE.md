# Hyperfinite customer evaluation guide

This guide is the shortest supported path from a clean copy of Hyperfinite to a
customer-owned GitHub Enterprise Cloud evaluation. It stops at every point where
an authorized human must approve or perform an administrative action.
The supported artifact is reviewed repository source in a customer-owned Git
repository, obtained as a verified customer-starter archive or a reviewed
file-only copy. It is not an npm package, SDK, packaged CLI, hosted service, or
deployable service.

Use these companion documents:

- [Customer FAQ](CUSTOMER_FAQ.md) for executive, security, technical, and
  operational questions.
- [Approval ticket templates](docs/runbooks/customer-approval-tickets.md) for
  copy-ready IT, security, identity, billing, legal, and operations requests.
- [Customer administrator runbook](docs/runbooks/customer-administrator.md) for
  installation, rollback, recovery, and evidence retention.
- [Project setup runbook](docs/runbooks/github-project-setup.md) for the four
  demonstration Projects.
- [Runtime activation runbook](docs/runbooks/copilot-runtime-activation.md) for
  the disabled-by-default Agentic Workflow runtime.

## Evaluation outcome

A successful evaluation demonstrates that Hyperfinite can coordinate one
synthetic, bounded workflow in the customer's own GitHub Enterprise Cloud
environment while:

1. keeping lifecycle, policy, target, credential, and effect authority in
   deterministic code;
2. keeping models advisory and target-free;
3. using a customer-owned, least-privilege GitHub App;
4. producing current-head, comment-only review evidence;
5. stopping at Human Review; and
6. preserving enough evidence to reproduce, pause, recover, or remove the
   evaluation safely.

The customer decides whether to proceed beyond evaluation after reviewing the
evidence, residual risk, operating model, cost, support, and change controls.

## Roles required

| Role | Minimum responsibility |
|---|---|
| Executive sponsor | Own the evaluation outcome, scope, and stop/go decision |
| Evaluation lead | Coordinate tickets, owners, timeline, evidence, and feedback |
| GitHub organization owner | Approve App installation, Projects, Actions, rulesets, and repository settings |
| Repository administrator | Configure CODEOWNERS, required checks, variables, environments, and branch rules |
| Security architect | Review trust boundaries, permissions, OIDC, key custody, logging, and incident controls |
| Cloud/platform engineer | Deploy the independent trust services and durable stores |
| Identity/key owner | Configure OIDC audiences, App credentials, signing keys, rotation, and revocation |
| Billing owner | Approve Copilot/model entitlement, budget ceilings, alerts, and shutdown authority |
| Legal/privacy reviewer | Review data handling, licensing, retention, and evaluation terms |
| Operator | Run validation, dry runs, canary, monitoring, recovery, and evidence capture |
| Independent reviewer | Review the exact current head and canary evidence |

One person may hold multiple roles if the customer's separation-of-duty policy
allows it. The requester must not self-approve a gate that requires independent
review.

## Phase 0: establish a customer-owned copy

1. Create a new private repository in the customer organization with `main` as
   the default branch. Current release, handoff, Work Accord, and ruleset
   contracts bind `refs/heads/main`.
2. Populate it from either a verified
   [customer-starter archive](docs/release/customer-starter-preflight.md) or a
   reviewed file-only copy of one exact Hyperfinite head. Do not carry source
   pull-request, issue, or commit history, and do not use an npm registry
   install or a source-history fork as the customer distribution.
3. Leave `example-organization` fixtures synthetic. Put live customer identities
   only in protected customer configuration and generated target manifests
   outside the repository.
4. Install the supported toolchain and locked dependencies:

   ```bash
   npm ci --ignore-scripts --no-audit --no-fund
   ```

5. Replace the source maintainer in [`.github/CODEOWNERS`](.github/CODEOWNERS)
   before the initial customer commit:

   ```bash
   npm run customer:configure -- \
     --codeowner @YOUR-ORG/hyperfinite-maintainers
   ```

   The command derives the customer repository from `origin`, requires a team
   to belong to that repository owner, and rewrites every rule. A user-owned
   repository may supply one customer maintainer instead.
6. Run:

   ```bash
   npm run validate:customer-readiness
   npm run typecheck
   npm run build
   npm test
   ```

7. Create the initial customer import commit.
8. Run `npm run customer:repin`. Review the generated changes to exactly:

   ```text
   config/v1alpha1/customer-starter-selection.json
   config/v1alpha1/customer-starter-demo-portfolio-selection.json
   ```

   When the copy came from a customer-starter archive, the command also removes
   exclusion entries for source-only files that are not present in the copied
   tree. It never adds a path or widens an included prefix.

9. Commit those two repinned selections, push `main`, and refresh the remote
   tracking ref:

   ```bash
   git push -u origin main
   git fetch origin main
   ```

10. Run the complete matrix in Phase 2.

`validate:customer-readiness` scans every tracked or newly added repository file
for source-organization bindings, private network
links, live Project node IDs, and source issue/PR history references.

## Phase 1: open and approve the customer tickets

Copy the applicable templates from
[customer approval tickets](docs/runbooks/customer-approval-tickets.md). At
minimum, track:

1. evaluation/change approval;
2. GitHub organization administration;
3. security architecture and threat review;
4. cloud platform and durable-store deployment;
5. OIDC, GitHub App, and signing-key custody;
6. model entitlement, billing, budgets, and alerts;
7. legal/privacy/data-retention review; and
8. operations, incident response, rollback, and support.

Record ticket IDs in protected customer change-management evidence. Do not put
credentials, private keys, tokens, customer data, or confidential attachments in
repository issues.

## Phase 2: validate the repository package

Run the complete matrix from the exact customer commit:

```bash
npm run validate
npm audit --audit-level=high
npm run canary:synthetic
npm run handoff:administrator
```

The expanded command sequence is:

```bash
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
npm run validate:demos
npm run simulate:demos
npm run validate:hardening
npm run canary:synthetic
```

Retain the exact commit SHA, command versions, exit status, and generated
evidence. A changed head requires a fresh run.

## Phase 3: prepare the four Projects

1. Have an organization owner create four empty private Projects using Board
   layout and the exact titles documented in the
   [Project setup runbook](docs/runbooks/github-project-setup.md).
2. Link the customer evaluation repository to each Project.
3. Export authenticated admin snapshots to a protected administrator workspace
   as:

   ```text
   app-modernization.admin.json
   feature-delivery.admin.json
   security-dependency-remediation.admin.json
   adaptive-delivery.admin.json
   ```

4. Generate a target manifest proposal:

   ```bash
   npm run github:setup -- target-manifest \
     --catalog config/v1alpha1/demo-portfolio/catalog.json \
     --schema-root config/v1alpha1/demo-projects \
     --live path/to/fresh-admin-snapshots \
     --evaluated-at <current-RFC3339-time> \
     --output path/to/customer-project-targets.json
   ```

5. Independently review every owner, repository, Project, and view identity.
   Record the manifest's `contentDigest` as the human-confirmed target digest.
6. Generate a bootstrap plan with
   `--confirmed-target-manifest-digest sha256:<digest>`. The planner refuses a
   substituted manifest.
7. A human Projects administrator applies only the confirmed operations.
8. Export fresh post-apply snapshots and run `bootstrap-readback`.
9. Complete the two API-limited view steps manually for each Project: group the
   `Journey` board by `Journey Stage`, then order columns by the declared journey.

## Phase 4: register the GitHub App and trust services

Use the exact permission plan in
[GitHub App permissions](docs/security/github-app-permissions.md). The App must:

- be customer-owned;
- be installed only on the approved evaluation repositories;
- use no PAT fallback;
- keep its private key and installation tokens outside model jobs;
- mint short-lived, operation-scoped tokens only after deterministic
  authorization; and
- have no permission to approve, dismiss review, merge, administer Actions,
  change visibility, manage billing, or deploy.

Deploy separate identities for webhook verification, runtime-state publication,
OIDC redemption, evidence signing, durable conditional stores, token brokerage,
the Single Writer/reconciler, and the isolated verification runner. Follow the
[deployment prerequisite matrix](docs/runbooks/deployment-prerequisites.md).

## Phase 5: configure repository controls

Before activation:

1. confirm `customer:configure` replaced every CODEOWNERS rule with a valid
   customer user or team that has write access;
2. configure a default-branch ruleset requiring pull requests, code-owner review,
   current-head approval, and required checks;
3. configure selected and SHA-pinned Actions;
4. configure protected environments and repository variables;
5. enable and review the customer's approved GHAS controls;
6. configure bounded model budgets and alert thresholds;
7. configure log, artifact, evidence, and backup retention;
8. configure monitoring and incident routing; and
9. prove the kill switch, key revocation, and disabled restore path.

The exact variable inventory and publishing protocol are in the
[runtime activation runbook](docs/runbooks/copilot-runtime-activation.md).

## Phase 6: run dry checks and the administrator handoff

Keep `AGENTIC_RUNTIME_ENABLED` unset or not equal to `true`.

```bash
npm run canary:synthetic
npm run handoff:administrator
```

The synthetic canary exercises the local contracts and durable adapters without
credentials or network effects. The administrator handoff emits a customer-safe,
synthetic-unconfigured gap report. It does not use or embed observations from the
source organization.

For every real administrative change, create one exact plan, obtain separate
human confirmation of its digest, perform one bounded trusted-adapter attempt,
and complete the authenticated post-apply readback. Never retry an ambiguous
acknowledgement.

## Phase 7: run one bounded customer canary

After every prerequisite is complete and independently reviewed:

1. enable the runtime only for the approved evaluation window;
2. file fresh synthetic sample issues from the copied issue forms;
3. authorize one workflow invocation;
4. observe the item reach Human Review;
5. verify the pull request remains a draft;
6. verify automated review is `COMMENT` only;
7. verify no autonomous approval, merge, deployment, publication, or
   administration occurred;
8. capture current-head, policy, budget, effect, and readback evidence; and
9. disable activation after the evaluation window.

## Phase 8: evaluate, recover, and decide

The evaluation team should review:

- objective outcomes and operator effort;
- security findings and residual risk;
- permission and service boundaries;
- reliability, recovery, and lost-acknowledgement behavior;
- cost and usage reconciliation;
- evidence quality and auditability;
- support and ownership requirements; and
- requested product changes.

Use the [recovery runbook](docs/runbooks/recovery.md) for drift, partial state,
lost acknowledgement, or service failure. Use the uninstall section of the
[customer administrator runbook](docs/runbooks/customer-administrator.md) to
remove package-owned files while retaining required evidence.

The customer sponsor and authorized governance owners make the final stop,
extend, redesign, or adopt decision.
