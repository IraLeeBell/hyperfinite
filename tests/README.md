# Tests and evidence

The test suite exercises positive paths and fail-closed behavior against actual
deterministic boundaries.

| Area | Representative files |
|---|---|
| Lifecycle, policy, and Kernel | `control-kernel.test.ts` |
| GitHub binding, credentials, and Single Writer | `github-adapter.test.ts` |
| Runtime authorization and bridge | `copilot-runtime.test.ts` |
| Demo contracts and runtime | `demo-portfolio.test.ts`, `demo-runtime.test.ts`, `demo-integration.test.ts` |
| Demo packs | `app-modernization-demo.test.ts`, `feature-delivery-demo.test.ts`, `security-dependency-remediation-demo.test.ts`, `adaptive-delivery-demo.test.ts` |
| Hybrid selection and exact Project bootstrap | `hybrid-agent-selection.test.ts`, `github-project-bootstrap.test.ts` |
| Bounded execution and end-to-end engineering | `bounded-worktree.test.ts`, `engineering-slice.test.ts` |
| Domain Packs | `domain-packs.test.ts` |
| Packaging and release | `packaging.test.ts` |
| Administrator handoff and exact apply/readback gate | `administrator-handoff.test.ts`, `administrator-handoff-live-snapshot.test.ts`, `pre-app-api-surface.test.ts` |
| Project UX | `project-ux.test.ts` |
| Upstream issue taxonomy | `issue-taxonomy.test.ts` |
| Security, observability, and hardening | `security-regression.test.ts`, `observability.test.ts`, `portfolio-hardening.test.ts` |

`fixtures/` contains closed synthetic events, GitHub observations, Project
snapshots, demo evidence, and provenance cases. `evals/fixtures/` contains
manual behavioral evaluation definitions, not trusted approval or live model
results.

`validate:hardening` runs the named compiled tests, rejects failures, errors,
skips, todos, missing or duplicate testcase identities, runs the real simulator
twice, and content-binds its evidence to the compiled test files. Closed
external-call assertion fixtures are deliberately labeled as fixture evidence,
not telemetry.

Run `npm test` for the full suite. Use targeted Node test-name patterns during
development, but run the complete repository matrix before merge.

The administrator handoff tests cover exact target/current/desired plans,
separate digest confirmation, fresh pre-apply reads, one-attempt post-readback,
ambiguous acknowledgement refusal, customer-export separation, and distinct
repository, synthetic, and App-backed readiness evidence.
