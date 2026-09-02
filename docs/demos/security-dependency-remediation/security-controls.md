# Demo security controls

| Risk | Deterministic control |
|---|---|
| Prompt or target injection | Trusted configuration binds repository, advisory, versions, base, slots, checks, and budget; model control fields fail closed. |
| Unsafe reproduction | Pure fixture comparison only; package install, lifecycle scripts, exploit execution, credentials, shell, network, and MCP are denied. |
| Stage or identity substitution | Exact reserved stage order and globally exclusive agent/capability/workflow identities are validated before inference. |
| Patch escape | Model output contains logical slots only; trusted code maps paths, enforces size, checks the complete diff, and delivers only a draft PR. |
| Stale verification | Regression, dependency/lock, threat, DLP, and signed scanner evidence all bind the exact current head and expire closed. |
| Alert laundering | A synthetic unrelated scanner finding remains explicitly open and unchanged; fixed or dismissal claims are refused. |
| Privilege escalation | Automated verification emits `COMMENT` only. Approval, merge, ready, deployment, publication, dismissal, and administration remain human-only. |
| Duplicate/partial effects | One cross-workflow fence and durable idempotency evidence require observation and reconciliation before retry. |
| Project confusion | Project fields are display-only projections; Stage is written last after Kernel and receipt evidence. |
| Cost or egress | Fixed finite model budget, one global per-item concurrency domain, closed zero-valued external-call assertions, and empty network and secret allowlists. Fixture assertions are not runtime telemetry. |
