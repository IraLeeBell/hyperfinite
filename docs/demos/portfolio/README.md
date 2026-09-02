# Portfolio operations

The integrated portfolio validates exactly four demo packs in canonical order,
executes deterministic hermetic journeys, and produces bounded hardening
evidence. Use this reading order:

1. [Architecture](architecture.md)
2. [Operator runbook](operator-runbook.md)
3. [Simulation](simulation.md)
4. [Observability](observability.md)
5. [Project setup and visibility](setup.md)
6. [Activation and readiness](activation-and-readiness.md)

## Current boundary

- Repository and hermetic demos: ready when the exact head passes the complete
  matrix, `validate:demos`, `simulate:demos`, `validate:hardening`, and the
  credentialless `canary:synthetic`.
- Sandbox/runtime: blocked until human administrators configure the Projects,
  deploy independent trust services and the isolated runner, configure protected
  bindings and controls, and observe a canary reach Human Review.
- Broader adoption: a customer governance decision after evaluation evidence.

Projects are non-authoritative projections. Static synthetic display data does
not activate a runtime.
