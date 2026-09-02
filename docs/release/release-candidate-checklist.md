# Release-candidate no-go checklist

Every local bundle contains `release-candidate.json`, bound to the exact package
version, head SHA, archive, release manifest, SBOM, provenance, and attestation
digests. The closed schema requires `decision: no-go`, `authoritative: false`,
and `selfApproved: false`.

The generated checklist enumerates exact-head install/typecheck/build/full-test
and checked-in validators; dependency audit and diff check; CodeQL, Dependency
Review, and secret scanning; independent security/code review; manual live
runtime and administrator probes; release/legal/OSPO/security/product approvals;
residual risks; prerequisites; unsupported environments; rollback limits; and
explicit no-go conditions.

A human release owner may use the generated artifact as an index, but must retain
separate authenticated evidence for each check. Missing, stale, warning, skipped,
unavailable, or failed evidence remains a no-go. The checklist cannot change its
own decision, approve the pull request, mark it ready, sign, publish, install, or
deploy.

