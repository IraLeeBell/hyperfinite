# Runtime

Runtime documentation covers the disabled-by-default model boundary and the
deterministic services around it:

- [Copilot runtime architecture](copilot-runtime.md): pre-activation,
  redemption, workflow bindings, staged output, threat detection, review
  isolation, and execution delivery.
- [Autonomous demo runtime](demo-runtime.md): reconstruction, activation,
  dispatch, scheduling, receipts, projection, recovery, and demo evidence.
- [Model, observability, and cost policy](model-observability-and-cost.md):
  provider selection, lineage, budgets, usage, and behavioral evaluation.

The runtime cannot authorize itself. A workflow request is not a Kernel route,
a model result is not an Effect Plan, and an Effect Plan is not a write. Live
execution requires independently deployed identity, reservation, signing,
evidence, credential, and Single Writer services.
