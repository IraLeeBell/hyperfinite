# Portfolio observability

Portfolio simulation emits closed `AuditEvent@1.0.0` records and fixed-label
`MetricRecord@1.0.0` metrics for:

- stage start, completion, refusal, and block;
- full trusted binding and lifecycle transition digests;
- run and attempt identity;
- artifact, model, tool, token, cost, and retry counters;
- projection and draft pull-request/current-head evidence;
- human action, reconciliation, and recovery.

Resource accounting assigns each value once: signed fake-provider usage owns
model calls, tokens, and duration; signed command evidence owns tool calls;
cost evidence owns cost units. Budget and provider summary events carry
digests without duplicating counters. `agentic_cost_units_total` is the fixed
cost metric.

Records contain bounded counters and cryptographic digests. They do not contain
raw prompts, responses, identities, repository or target names, paths,
credentials, URLs, or secrets. Metric labels remain limited to component and
outcome.

The NDJSON chain is contiguous and content-addressed. A sink must reject a
broken predecessor, invalid reason code, malformed counter, unreviewed label,
or redaction failure. Unknown provider usage remains held; it is never reported
as zero-cost success.

Operational logs are evidence aids, not authority. Correlate them with the
trusted binding, activation lease, Kernel receipt, signed review bundle,
current head, projection receipt, and Single Writer evidence.
