# Support

Customer evaluation teams must define named support owners, coverage hours,
response expectations, and escalation channels before activation. Use
repository issues for reproducible defects, documentation gaps, and feature
feedback that contain no secrets or private customer data.

Include the affected contract version, exact customer commit SHA, demonstration
and stage, stable refusal code, expected and observed behavior, business impact,
and redacted evidence digests.

For packaging defects, also include the package/contract version, exact
release-manifest and plan digests, operation, stable refusal, and redacted
receipt-chain position. Do not attach customer identifiers, installation IDs,
credentials, private release artifacts, or raw administrator exports.

For suspected vulnerabilities, follow [SECURITY.md](SECURITY.md). For an active
incident, follow [the incident-response runbook](docs/runbooks/incident-response.md)
instead of opening a public issue.

## Evaluation escalation

| Severity | Example | Immediate action |
|---|---|---|
| Critical | Credential exposure, unauthorized mutation, evidence forgery, or customer-data disclosure | Disable activation and writers, revoke credentials, preserve evidence, invoke the customer incident process |
| High | Wrong target, ambiguous effect, missing required control, or irreconcilable state | Pause the affected route, retain evidence, and escalate to security and platform owners |
| Medium | Reproducible functional defect with no privileged effect | Keep the affected workflow disabled and file a redacted issue |
| Low | Documentation, usability, or feature feedback | File a customer-safe issue with desired outcome |

Repository maintainers do not receive customer credentials or private evidence.
Use the customer's approved secure channel when a security or legal reviewer
needs protected material.

Use the `Customer evaluation feedback` issue form for customer-safe defects,
documentation gaps, operator observations, business outcomes, and feature
requests.
