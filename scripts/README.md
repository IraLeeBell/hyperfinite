# Tooling

Scripts are deterministic repository tools invoked through `npm run` from a
reviewed repository checkout or customer-owned copy. They are not an installed
or general-purpose CLI, and the private package has no `bin` entry. None of
them grants live authority.

`reconcile-issue-taxonomy.ts` is the narrow exception that performs
repository-local display metadata writes. It is optionless, receives only the
ephemeral Actions installation token, validates the exact event and repository,
and is not included in customer-starter profiles.

## Validation and simulation

| Command | Purpose |
|---|---|
| `npm run validate` | Run the complete repository validation, workflow, packaging, demo, simulation, and hardening matrix |
| `npm run validate:customer-readiness` | Scan every repository file for source-specific, private, or non-portable material |
| `npm run validate:technical-identity` | Verify Hyperfinite product wording and classify the retained package/API/publisher/domain compatibility identity |
| `npm run validate:schemas` | Validate closed schemas, configuration, examples, and hardening metadata |
| `npm run validate:runtime` | Validate runtime policy and exact core/demo bindings |
| `npm run validate:eval-fixtures` | Validate behavioral evaluation fixtures |
| `npm run validate:provenance` | Validate source inventory and reuse evidence |
| `npm run validate:workflows` | Validate workflow source/lock structure and policy parity |
| `npm run validate:gh-aw` | Recompile with pinned gh-aw and reject generated drift |
| `npm run validate:packaging` | Validate packaging, release, and installation contracts |
| `npm run validate:demos` | Validate the exact four-demo portfolio and hybrid bindings |
| `npm run simulate:demos` | Run deterministic all-demo hermetic simulation |
| `npm run validate:hardening` | Execute the closed adversarial/fault matrix and emit canonical evidence |
| `npm run demo:authority` | Run the five-minute synthetic offline authority-boundary walkthrough |
| `npm run demo:authority:recording` | Regenerate the walkthrough's static transcript and self-hosted GIF from the same canonical result |
| `npm run canary:synthetic` | Run the credentialless restart-safe synthetic Human Review canary |
| `npm run handoff:administrator` | Emit the canonical pre-App plan/readback and synthetic-unconfigured customer gap report |
| `npm run validate:review-agent-runtime` | Run the separately controlled review-runtime probe |

The authoritative technical-identity command and the
`validate:technical-identity:core` / `validate:technical-identity:demo`
customer-starter commands use separate fixed entrypoints. A caller cannot select
a weaker inventory scope with an argument or mutable repository marker.

## Planning tools

- `npm run customer:configure -- --codeowner @<owner>/<team>` rewrites every
  CODEOWNERS rule for the customer repository derived from `origin`. A
  user-owned repository may provide `@<user>`.
- `npm run customer:repin` rebinds the two customer-starter selection documents
  to the clean initial commit of a copied customer repository. It changes only
  those two files; a human reviews and commits the result before validation.
- `npm run github:setup -- target-manifest|validate|plan|export|import|bootstrap-plan|bootstrap-readback`
  validates declarative Project schemas, derives a customer target-manifest
  proposal from fresh snapshots, and emits human-admin dry-run actions. A
  bootstrap plan requires the separately confirmed target-manifest digest. The
  repository command cannot apply changes.
- `npm run github:display-colors -- target-manifest|plan|readback` is the
  separate display-only path for existing populated Projects. It accepts no
  installation or credential data, requires independent manifest and plan
  digest confirmation, emits only exact human-admin option-color actions, and
  never produces a runtime binding or effect.
- `npm run installer -- plan|offline-validate` validates target-bound customer
  installation plans. It cannot perform a live apply.
- After `npm run build`, `gh repo view IraLeeBell/hyperfinite` can pipe the
  exact closed fields documented in the
  [repository metadata checklist](../docs/release/repository-metadata-checklist.md)
  to `node dist/scripts/plan-repository-metadata.js`. The optionless planner is
  upstream-only, reads no credential, performs no network request or mutation,
  and cannot apply About metadata.
- `npm run release:local -- build <required flags>` and
  `npm run release:local -- verify <required flags>` produce and verify
  deterministic unsigned local evidence. Use the complete commands in
  [Deterministic local release evidence](../docs/release/local-release-evidence.md).
  The tool cannot sign, publish, approve, or release.
- `npm run eval:behavioral -- --responses-dir=<reviewed-records>` scores supplied
  records and never starts paid inference.
- `npm run handoff:administrator` is optionless and repository-only. It composes
  the existing contracts and readbacks and runs no administrative apply.

Live/apply/execute flags are rejected where the repository does not implement
that authority. Never add a success-shaped fallback for a missing credential,
service, store, runner, check, or evidence record.
