# Source map

The TypeScript source is organized by trust boundary rather than by product UI.

| Area | Key modules |
|---|---|
| Canonical data and validation | `canonical.ts`, `strict-json.ts`, `validation.ts`, `types.ts` |
| Lifecycle and authority | `lifecycle.ts`, `policy.ts`, `registry.ts`, `authorization.ts`, `kernel.ts`, `receipts.ts`, `migrations.ts` |
| GitHub binding and effects | `github-events.ts`, `github-projects.ts`, `github-safe-output.ts`, `github-adapter.ts`, `github-auth.ts`, `github-http.ts` |
| Runtime | `copilot-runtime.ts`, `runtime-workflow-validation.ts`, `execution-bridge.ts`, `execution-delivery.ts` |
| Autonomous demos | `demo-portfolio.ts`, `demo-portfolio-validation.ts`, `demo-activation.ts`, `demo-runtime-state.ts`, `demo-dispatcher.ts`, `demo-scheduler.ts`, `demo-runtime.ts`, `demo-projection.ts`, `demo-review-evidence.ts`, `demo-observability.ts` |
| Bounded engineering | `bounded-worktree.ts`, `engineering-slice.ts` |
| Domain Packs | `domain-packs.ts`, `domain-artifact-schemas.ts`, `domain-git-packager.ts` |
| Packaging, release, identity compatibility, and customer sharing | `packaging.ts`, `packaging-types.ts`, `technical-identity.ts`, `release.ts`, `release-support.ts`, `release-path.ts`, `customer-starter.ts`, `customer-starter-authoring.ts`, `customer-repository-config.ts`, `customer-readiness.ts` |
| Pre-App deployment/App/administrator contracts | `deployment-topology.ts`, `app-registration-plan.ts`, `administrator-plan.ts`, `administrator-handoff.ts`, `freshness.ts` |
| Observability | `events.ts`, `observability.ts` |
| Public exports | `index.ts` |

## Design constraints

- Pure authority evaluation receives explicit inputs and performs no network,
  environment, credential, clock, or filesystem reads.
- Model output remains closed-schema and target-free.
- Target resolution and credentials occur only after deterministic authorization.
- The Single Writer rechecks complete fresh state before every effect.
- Ambiguous outcomes reconcile from stable exact readback or remain blocked.
- No PAT, model-job credential, approval, merge, deployment, or publication
  fallback exists.

Before changing authority-bearing code, read the matching architecture page,
schema, security control, and deterministic tests.
