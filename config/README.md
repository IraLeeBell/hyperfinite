# Configuration

`config/v1alpha1/` contains reviewed declarative inputs. Configuration narrows
authority; it does not activate a service or authorize a mutation by itself.

| Path | Contents |
|---|---|
| `lifecycle.json` | Domain-neutral lifecycle graph |
| `policy.json` | Enterprise control ceilings and prohibited effects |
| `capability-registry.json` | Base deny-by-default capability registry |
| `phase-contracts/` | Core active-phase contracts |
| `copilot-runtime-policy.json` | Runtime bindings, limits, and model policy |
| `demo-portfolio/` | Exact catalog, identity reservations, and hardening plan |
| `demo-projects/` | Per-demo profile, journey, capability, binding, activation, projection, artifact, and verification configuration |
| `domain-packs/` | Marketing and Business Operations definitions, policies, contracts, and templates |
| `github-project.json` | Reusable logical Project schema |
| `compatibility.json` | Tested toolchain/platform versions and the fixed Hyperfinite product versus retained technical identity boundary |
| `technical-identity-inventory.json` | Reviewed full-file identity occurrence evidence for the authoritative repository and both customer-starter profiles |
| `migrations.json` | Supported deterministic migration graph |
| `open-source-readiness.json` | Current gated release-readiness decision |
| `issue-taxonomy.json` | Upstream-only repository identity, display labels, historical issue mappings, title prefixes, and reconciliation limits |

## Rules

- Treat identifiers in examples and checked-in demo bindings as synthetic unless
  a trusted adapter reconstructs them from authenticated reads.
- Never add credentials, private keys, tokens, customer data, or production
  identifiers.
- An omitted allowlist means denied.
- Per-demo `capabilities.json` and `runtime-bindings.json` form an inseparable
  validated pair.
- Activation profiles remain disabled until the complete human-admin deployment
  gate is satisfied.
- Project configuration is declarative and dry-run only; Projects remain
  non-authoritative projections.
- Hyperfinite is the product/display name. Lower-case `agentic-framework`
  package, API/schema, publisher, and domain values are the retained
  compatibility identity fixed by `compatibility.json`.

Run `npm run validate:schemas`, `npm run validate:runtime`, and
`npm run validate:demos` after configuration changes. Contract behavior changes
also require the adjacent schema, ADR, security control, and deterministic tests.
