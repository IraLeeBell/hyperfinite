# Security and Dependency Remediation demo

This is a synthetic, repository-only demonstration of a deterministic security
and dependency remediation journey. It is disabled by default and is not a
claim of live or production remediation readiness.

The fictional `mist-lru` `0.4.0` advisory describes a local cache-key separator
collision fixed by length-prefix encoding and synthetic version `0.4.1`.
Reproduction is a pure fixture comparison. It does not install packages, run
lifecycle scripts, clone or fetch, use credentials, contact a network, or
execute a production exploit.

`work-accord.json` and the trusted binding fix the synthetic repository,
advisory, dependency/version, base SHA, four logical target slots, six checks,
and budget. `target-free-patch.json` contains logical slots only. Trusted code
alone maps those slots to paths and may deliver only an open draft pull request.

The signed advisory and scanner records use a throwaway fixture key whose public
half is checked in next to the evidence. They are synthetic test evidence, not
attestations about a real package or repository.
