# Test fixtures

Fixtures are closed synthetic inputs for deterministic tests:

- `demos/` contains all four journey, recovery, adversarial, binding, and
  external-call assertion sets.
- `events/` contains normalized event examples.
- `github/` contains synthetic GitHub observations.
- `project-ux/` contains declarative live-snapshot shapes for dry-run planning.
- `provenance/` contains valid and invalid inventory cases.

Fixtures do not attest to live state. Keep credentials, real customer data,
production identifiers, and mutable external references out of this directory.
