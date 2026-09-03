# Tooling

Scripts are deterministic repository tools. None of them grants live authority.

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
| `npm run canary:synthetic` | Run the credentialless restart-safe synthetic Human Review canary |
| `npm run handoff:administrator` | Emit the canonical pre-App plan/readback and synthetic-unconfigured customer gap report |
| `npm run validate:review-agent-runtime` | Run the separately controlled review-runtime probe |

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
  CLI cannot apply changes.
- `npm run installer -- plan|offline-validate` validates target-bound customer
  installation plans. It cannot perform a live apply.
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
