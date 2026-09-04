# GitHub Project setup and validation

## Safety boundary

The repository setup and display-color commands are offline and dry-run only.
They never authenticate to GitHub, mint a token, create a Project, or perform a
mutation. `--apply` and `--execute` are rejected before any input is loaded.
Every emitted setup or color action has `requiresHumanAdmin: true`.

The repository intentionally does not embed a credentialed full-administration
reader in `github-http.ts`. An authorized human or separately reviewed trusted
reader supplies the closed snapshot, keeping keyring/App credentials outside
the planner and model-facing runtime.

## Semantic single-select palette

GitHub supports the exact option colors `GRAY`, `BLUE`, `GREEN`, `YELLOW`,
`ORANGE`, `RED`, `PINK`, and `PURPLE`. Every single-select option must declare
one of them. Omission is invalid; tooling never substitutes `GRAY`.

| Core Stage | Color |
|---|---|
| Captured | `GRAY` |
| Activation pending | `YELLOW` |
| Framing | `BLUE` |
| Planned | `PURPLE` |
| Executing | `PINK` |
| Verifying | `ORANGE` |
| Human review | `YELLOW` |
| Completed | `GREEN` |
| Paused | `ORANGE` |
| Blocked | `RED` |
| Cancelled | `GRAY` |

| Journey category | Exact Journey Stage options | Color |
|---|---|---|
| Intake/capture | Intake | `GRAY` |
| Discovery, inventory, requirements | Repository discovery; Current-state inventory; Requirements clarification; Codebase discovery; Triage; Context inventory - autonomous; Discovery studio - choose agent | `BLUE` |
| Assessment, synthesis, architecture, design, planning | Modernization assessment; Target architecture; Migration plan; Solution design; Implementation plan; Reproduction and impact analysis; Remediation design; Patch planning; Guided synthesis - autonomous; Implementation plan - deterministic gate | `PURPLE` |
| Implementation/build | Implementation; Build; Patch implementation; Implementation studio - choose agent | `PINK` |
| Test/verification | Verification; Test and verification; Security verification; Test and verification - autonomous | `ORANGE` |
| Human review | Human review | `YELLOW` |
| Completed | Completed | `GREEN` |
| Activation pending | Activation Pending | `YELLOW` |
| Paused | Paused | `ORANGE` |
| Blocked | Blocked | `RED` |
| Cancelled | Cancelled | `GRAY` |

| Field | Option colors |
|---|---|
| Depth Profile | D0 `GRAY`; D1 `BLUE`; D2 `PURPLE`; D3 `PINK` |
| Gate Status | Pending `YELLOW`; Satisfied `GREEN`; Blocked `RED` |
| Attention | None `GRAY`; Human action `YELLOW`; Reconciliation `ORANGE` |
| Stage Interaction | Backend autonomous `BLUE`; User-selectable agent `PURPLE`; Human gate `YELLOW`; Deterministic `GREEN`; Kernel control `ORANGE`; Terminal `GRAY` |
| Requested Stage Agent | Locked/unavailable `GRAY`; discovery candidates `BLUE`; implementation candidates `PURPLE` |
| Agent Selection Status | not-applicable `GRAY`; awaiting-selection `YELLOW`; accepted `GREEN`; invalid `RED`; stale `ORANGE`; reconciliation-required `PURPLE` |

Names and descriptions are the accessible semantic source. Color is only a
redundant visual cue and must never be interpreted as lifecycle, Work Accord,
policy, capability, target, credential, transition, agent-selection, effect,
approval, or merge authority.

## Validate declarative schemas

```bash
npm run github:setup -- validate \
  --schema config/v1alpha1/github-project.json
```

The command validates the closed JSON Schema plus duplicate field, option, and projection rules.
`OWNER` is a schema template value. A dry-run plan resolves it only from the
supplied authenticated snapshot; it never selects an effect target. The
customer bootstrap path separately requires the human-confirmed target-manifest
digest.

Validate the complete four-demo catalog against the Foundation catalog,
identity reservations, core Stage options, fifteen-field Project schema, and
fourteen-field projection
vocabulary:

```bash
npm run github:setup -- validate \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --schema-root config/v1alpha1/demo-projects
```

The catalog is fixed to App Modernization, Feature Delivery, Security and
Dependency Remediation, and Adaptive Delivery in Foundation order. It does not
discover arbitrary directories or accept a form-selected profile.

## Plan against a fresh Project export

An authorized human or separately reviewed read-only tool must produce a JSON snapshot matching `github-project-live.schema.json`.

```bash
npm run github:setup -- plan \
  --schema config/v1alpha1/github-project.json \
  --live path/to/fresh-project-snapshot.json \
  --evaluated-at 2026-08-26T20:10:00.000Z
```

Exit code `0` means the live Project exactly matches and a binding can be emitted. Exit code `2` means the output contains human-admin setup or reconciliation actions. No action is executed.

For all four demos, place one fresh snapshot named `<demo-project-id>.json` in
one directory and run:

```bash
npm run github:setup -- plan \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --schema-root config/v1alpha1/demo-projects \
  --live path/to/fresh-demo-project-snapshots \
  --evaluated-at 2026-08-29T17:50:00.000Z
```

Synthetic, credential-free examples are in
`tests/fixtures/project-ux/live/`. They are test evidence, not live bindings.

## Reconcile colors on the four existing Projects

Existing display Projects use the dedicated `github:display-colors` boundary.
They are not bootstrap targets and do not become runtime bindings. This path
accepts an exact user- or organization-owned Project that is public or private,
open or closed, and populated, because none of those attributes is changed. It
records and then requires their exact current values.

The separately supplied files
`<demo-project-id>.display.json` must match
`github-project-display-snapshot.schema.json`. Each file contains one fresh
read-only observation: exact owner, linked repository, Project, selected view,
all custom fields in API order, and all single-select options in API order with
node ID, name, color, and description. Installation, credential, item, binding,
and effect data are unknown properties and are rejected. Every time must use
canonical UTC with a `Z` suffix and at most millisecond precision, for example
`2026-09-03T23:54:00.000Z`.

1. **Propose exact targets:** obtain all four fresh snapshots and derive a
   non-authoritative manifest:

   ```bash
   npm run github:display-colors -- target-manifest \
     --snapshots path/to/fresh-display-snapshots \
     --evaluated-at <current-canonical-UTC-time> \
     --output path/to/display-target-manifest.json
   ```

   The proposal copies target identities only from the snapshots, binds the
   current merged schema digest for each demo, and records the view layout and
   API-visible field order as observation. It does not select or authorize a
   target.
2. **Independently confirm the manifest:** a human other than the snapshot
   preparer reviews every owner, repository, Project, view, field, and option
   identity plus visibility, closed state, names, types, order, descriptions,
   and schema digests. Record the manifest `contentDigest` outside repository
   configuration. Title matching alone is never identity.
3. **Plan exact color changes:** obtain fresh snapshots again, then run:

   ```bash
   npm run github:display-colors -- plan \
     --snapshots path/to/fresh-display-snapshots \
     --target-manifest path/to/display-target-manifest.json \
     --confirmed-target-manifest-digest sha256:<confirmed-manifest-digest> \
     --evaluated-at <current-canonical-UTC-time> \
     --output path/to/display-color-plan.json
   ```

   Exit code `2` means exact color actions were emitted. Every action is
   `set-single-select-option-color`, carries exact Project/field/option node IDs,
   before/after colors, `displayOnly: true`, `authoritative: false`, and
   `requiresHumanAdmin: true`. Description drift blocks planning; this contract
   never edits accessible semantics. Any unexpected field, option, ID, order,
   attribute, timestamp, digest, or target substitution fails closed.
4. **Confirm and apply once:** an independent human reviews and records the
   `planDigest`, then one human Project administrator applies exactly that action
   set through an approved GitHub administration surface. Repository tooling has
   no apply/execute verb, credential reader, network client, binding output, or
   effect adapter. Do not retry an ambiguous response.
5. **Fresh readback:** export the same four targets again after the confirmed
   plan time and run:

   ```bash
   npm run github:display-colors -- readback \
     --snapshots path/to/post-apply-display-snapshots \
     --target-manifest path/to/display-target-manifest.json \
     --confirmed-target-manifest-digest sha256:<confirmed-manifest-digest> \
     --input path/to/display-color-plan.json \
     --confirmed-plan-digest sha256:<confirmed-plan-digest> \
     --evaluated-at <current-canonical-UTC-time> \
     --output path/to/display-color-readback.json
   ```

   Success requires `success: true`, zero remaining color drift, and exact
   owner/repository/Project/view, visibility/closed state, custom-field,
   option, description, order, and current schema-digest verification. The
   report explicitly says `runtimeBindingProduced: false`. View layout and
   visible-field order are preserved in manifest, plan, and readback evidence,
   but changes to those observations neither authorize nor block this
   color-only flow.

For a new empty installation, generate and independently confirm a fresh target
manifest before `bootstrap-plan` through the existing `github:setup` path. That
runtime/customer bootstrap path remains stricter: it still requires an
organization owner, private empty Projects, `View 1`, an authenticated
installation wherever a runtime binding may be emitted, and complete activation
and binding checks. The display-only path is a smaller contract for one mutable
attribute, not a downgrade or alternate route around those requirements.

Issue completion is a separate post-merge gate: keep the development issue open
until a human administrator records zero-drift readback for all four existing
Projects. A merged repository change alone does not complete live
reconciliation.

## Generate and confirm the exact customer target manifest

Create four empty private Projects with these exact titles:

1. `App Modernization - Hyperfinite`
2. `Feature Delivery - Hyperfinite`
3. `Security Dependency Remediation - Hyperfinite`
4. `Adaptive Delivery - Hyperfinite`

Link the customer evaluation repository to each Project. Place complete,
authenticated, fresh snapshots at `<demo-project-id>.admin.json`, then generate
a target-manifest proposal:

```bash
npm run github:setup -- target-manifest \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --schema-root config/v1alpha1/demo-projects \
  --live path/to/fresh-admin-snapshots \
  --evaluated-at <current-RFC3339-time> \
  --output path/to/customer-project-targets.json
```

The generator requires all four snapshots in catalog order, one shared
organization and repository, private/open Projects, repository linkage, zero
items, and one `View 1` Board view per Project. It copies exact identities from
the supplied snapshots but grants no authority.

An independent human must review every owner, repository, Project, and view
identity and record the manifest's `contentDigest`. The planner refuses any
manifest that differs from this separately confirmed digest.

## Plan the exact customer bootstrap

Use the confirmed target manifest and run:

```bash
npm run github:setup -- bootstrap-plan \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --target-manifest path/to/customer-project-targets.json \
  --confirmed-target-manifest-digest sha256:<explicitly-confirmed-target-digest> \
  --schema-root config/v1alpha1/demo-projects \
  --live path/to/fresh-admin-snapshots \
  --issue-bindings path/to/reviewed-scenario-and-dogfood-issue-ids.json \
  --evaluated-at <current-RFC3339-time> \
  --output path/to/reviewed-bootstrap-plan.json
```

The issue-binding file supplies one exact scenario issue node ID per demo and
any explicitly reviewed additional tracking issues; title matching is not
identity. The output contains the exact four Project node IDs, complete
descriptions, READMEs, field/option operations, exact issue IDs, synthetic seed
blueprints, API-limited manual view steps, and one plan digest. It performs no
mutation. Store the plan outside
the repository, review its digest, and obtain explicit human confirmation.
Immediately before apply, reread all targets and require the same preconditions.
`initialItemCount: 0` is a one-time pre-apply manifest condition. Post-apply
readback instead requires the exact confirmed scenario, dogfood, and synthetic
draft content node IDs.
Apply only the confirmed operations; never delete unexpected fields, options,
views, or items and never retry an ambiguous response without stable readback.

After apply, export complete snapshots including every item and run:

```bash
npm run github:setup -- bootstrap-readback \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --target-manifest path/to/customer-project-targets.json \
  --schema-root config/v1alpha1/demo-projects \
  --live path/to/post-apply-admin-snapshots \
  --input path/to/reviewed-bootstrap-plan.json \
  --confirmed-plan-digest sha256:<explicitly-confirmed-digest> \
  --evaluated-at <current-RFC3339-time> \
  --output path/to/bootstrap-reconciliation.json
```

Readback must match descriptions, Project READMEs, all fifteen fields and exact
option attributes, one matching synthetic scenario issue, every confirmed
additional issue content ID, every visibly prefixed draft item, the `Journey`
view name, and its exact API-visible card fields. A mutation response alone is
not success.

## Export or import a reviewed configuration

```bash
npm run github:setup -- export \
  --schema config/v1alpha1/github-project.json \
  --binding path/to/reviewed-binding.json \
  --output path/to/project-configuration.json

npm run github:setup -- import \
  --input path/to/project-configuration.json
```

Export refuses a binding whose schema digest does not match. Import validates the schema, binding, closed representation, and digest relationship.

Catalog export/import uses one file while preserving the exact Foundation order:

```bash
npm run github:setup -- export \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --schema-root config/v1alpha1/demo-projects \
  --binding path/to/reviewed-demo-bindings \
  --output path/to/demo-project-configuration.json

npm run github:setup -- import \
  --catalog config/v1alpha1/demo-portfolio/catalog.json \
  --input path/to/demo-project-configuration.json
```

The binding directory uses `<demo-project-id>.json`. Omitting `--binding`
exports explicit `null` binding slots for human review; it does not infer or
create IDs.

## Issue intake

The four demonstration issue forms under `.github/ISSUE_TEMPLATE/` accept only desired
outcome, repository hint, constraints, acceptance criteria/evidence, requested
depth, and explicit fixed-budget consent. The form file has a static trusted
binding to one demo profile. User text cannot select a profile, repository,
Project, capability, stage, route, credential, transition, or effect.

Before any credential request, budget reservation, or inference, trusted code
must call the deterministic intake validator with:

- the exact form binding and Project schema;
- the validated Foundation catalog and identity reservations;
- a current, enabled activation profile;
- the authorized submitter's immutable numeric ID;
- the resolved repository binding digest;
- a fresh Project binding whose schema and profile digests match; and
- the structured form values within their fixed UTF-8 byte limits.

Success remains `ACTIVATION_PENDING` and grants no authority. Missing consent,
disabled activation, unauthorized submitter, unresolved or substituted
repository binding, stale Project binding, malformed or oversized content,
disallowed depth, missing budget, or an invalid activation window blocks before
all privileged boundaries.

An empty required information field produces exactly one
`DemoMissingInformationRequest` for the first field in fixed form order. The
artifact binds the issue node, form ID, and submission digest. It is evidence
for a human response, not permission to create another issue or infer a request
from punctuation.

## Project views

- **Board:** group by Journey Stage and preserve its declared left-to-right
  order. Place Activation Pending, Paused, Blocked, and Cancelled after the
  normal journey stages. Never treat card movement as a transition.
- **Table:** show all fifteen fields in schema order. Put Stage Interaction,
  Current Stage Agent, Requested Stage Agent, Agent Selection Status, Gate
  Status, Attention, and Run / Attempt beside Journey Stage for operator triage.
- **Roadmap:** the exact vocabulary intentionally has no date or iteration
  authority. Use a read-only roadmap layout only when GitHub can render existing
  item timing; do not add ad hoc date fields or infer schedules. Use the ordered
  board/table when no trusted timing evidence exists.
- **Dashboard/insights:** chart counts by Journey Stage, Gate Status, and
  Attention. Treat charts as display-only summaries; they cannot satisfy gates
  or change Stage.

Stage always comes from the Kernel snapshot and is written last. Journey Stage,
Stage Interaction, Current Stage Agent, and Agent Selection Status come only
from trusted state. Requested Stage Agent is human-editable untrusted intent,
is excluded from the projection mapping, and cannot dispatch directly. Target
Repository comes only from Trusted Binding and is display-only; the repository
hint never feeds it.

GitHub's supported Project API can rename the view and configure visible card
fields after field IDs exist. It does not expose grouping or Journey Stage
column ordering. After applying and reading back the supported view update, use
the UI for each exact Project to:

1. group `Journey` by `Journey Stage`; and
2. order columns according to the matching journey contract.

The supported update renames `View 1` to `Journey` and shows Stage Interaction,
Current Stage Agent, Requested Stage Agent, Agent Selection Status, Gate Status,
Attention, and Run / Attempt. Preserve Board layout and built-in Status. Do not
group the Journey view by Status and do not treat Status as lifecycle authority.

## Operator walkthrough

1. Validate the catalog and forms with `npm run validate:schemas`.
2. For existing display-only color reconciliation, use the exact
   manifest-confirmation-plan-confirmation-human-apply-readback sequence above.
3. For a new customer bootstrap, use only the stricter `github:setup` target
   manifest, bootstrap plan, and bootstrap readback sequence.
4. Export a runtime binding only when the generic plan has no action and contains
   a binding backed by the required installation identity.
5. Submit a synthetic form and run deterministic intake validation. A ready
   result still waits for Kernel activation and separate runtime contracts.
6. Seed only synthetic examples; never copy customer data, credentials, or live
   IDs into the repository.

## Reset and recovery

Reset is projection reconciliation, not evidence deletion:

1. disable activation and all writers;
2. retain issue history, plans, snapshots, binding exports, receipts, blocked
   artifacts, draft pull requests, and audit references;
3. fresh-read each Project and run catalog `plan`;
4. have a human administrator apply the listed reconciliation actions;
5. obtain new snapshots and bindings instead of editing old evidence;
6. increment the separately governed authority generation before any future
   activation; and
7. rerun schema validation, tests, and independent review before re-enabling.

Never delete or rewrite receipt evidence, reset a receipt head, reuse a stale
binding, blindly retry an ambiguous Project change, or automatically create a
recovery issue. If the current Project cannot be proven, leave the item Blocked
with its typed evidence reference.

## Human-admin blockers

Before any live use, a human administrator must:

1. create and install a least-privilege GitHub App;
2. store the App private key in sign-only secure storage and configure a webhook secret;
3. configure exactly the permissions in the permission manifest;
4. create or select the Project and perform every setup-plan action;
5. export a fresh snapshot and retain the validated binding for review;
6. configure per-repository/work-item serialization with cancellation disabled; and
7. independently review rulesets, required checks, visibility, and organization policy.

The adapter cannot perform or approve any of these actions.

Repository integration and hermetic simulation do not make the four demo
Projects visible or usable. That remains blocked through the follow-on live
setup issue and every human-admin prerequisite in
[`docs/demos/portfolio/setup.md`](../demos/portfolio/setup.md). Do not request
live identifiers or secrets before that gate.
