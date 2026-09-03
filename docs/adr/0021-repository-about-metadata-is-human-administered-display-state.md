# ADR 0021: Repository About metadata is human-administered display state

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

The public repository description still characterized Hyperfinite primarily as
an autonomous-team framework, no repository topics were set, and no homepage
was configured. The accepted README instead defines Hyperfinite as a
GitHub-native control plane for governed, model-assisted work: model output is
advisory, deterministic systems bind targets and authorize allowed effects, and
independent humans retain administration, approval, merge, release, and
adoption authority.

GitHub stores the About description, homepage, and topics outside the Git tree.
A pull request can review a desired state but cannot by itself update those
fields. The repository has no configured GitHub Pages site and no separately
maintained canonical public product URL. A repository document URL is not
treated as a project homepage.

The REST operations that update repository settings and replace topics require
repository Administration write permission. GitHub Actions workflow permission
syntax exposes no `administration` permission for the built-in `GITHUB_TOKEN`.
Inventing such a permission would not work. Adding a PAT or exposing GitHub App
installation credentials to a repository or model job would violate the
credential boundary.

## Decision

Add the exact, closed
`config/v1alpha1/repository-metadata.json` contract and adjacent schema. It binds
the immutable numeric and node repository identities, the full repository name,
and this desired display state:

| Field | Desired value |
|---|---|
| Description | `GitHub-native control plane that keeps model output advisory and execution authority deterministic.` |
| Homepage | Unset |
| Topics | `agentic-ai`, `agentic-workflows`, `ai-governance`, `deterministic-systems`, `github-actions`, `human-in-the-loop`, `llm-security`, `policy-as-code` |

The product/display name remains Hyperfinite. The contract's `apiVersion` and
schema URI retain the accepted `agentic-framework/v1alpha1` technical
compatibility identity. The metadata does not imply a hosted control plane,
deployed trust service, published SDK or CLI, bundled administration, or live
effect authority.

`scripts/plan-repository-metadata.ts` is optionless and read-only. It accepts
only the closed JSON shape emitted by the documented exact `gh repo view`
readback, rejects a different repository full name or node ID, normalizes an
empty homepage to unset, and emits deterministic additions, removals, or
replacements. It has no GitHub client, credential reader, network call, or
mutation adapter. The repository-admin contract, schema, and planner remain
outside customer-starter profiles.

Merging the reviewed pull request authorizes only the declared desired state.
It does not apply GitHub metadata. A separately authenticated human repository
administrator must fresh-read, inspect and confirm the plan, apply the exact
state in GitHub repository settings, then fresh-read again. Acceptance requires
both the direct `gh repo view` output and the planner to report the complete
state with no drift. Until that gate completes, the development issue remains
open.

About metadata is display and discovery data only. It grants no lifecycle,
repository, target, Project, capability, credential, transition, release, or
effect authority.

## Consequences

- Desired metadata changes are reviewable in Git history and mechanically
  bounded to one public repository.
- A missing, malformed, wrong-repository, partial, unknown-topic, non-admin, or
  drifted readback fails closed and cannot become acceptance evidence.
- No merge-triggered workflow, unsupported token permission, PAT fallback, App
  credential, model job, ambient repository default, or success-shaped
  application result is introduced.
- GitHub remains able to drift outside the Git tree. The maintainer checklist
  requires an authenticated readback for every relevant readiness review and a
  new reviewed contract change for any intentional desired-state change.
- The homepage remains unset until separately reviewed evidence identifies a
  maintained canonical public URL.

## Rejected alternatives

- Add an Actions workflow with `administration: write`: rejected because that
  permission is unavailable to the built-in workflow token.
- Store or inject a PAT: rejected because repository automation has no PAT
  fallback.
- Expose GitHub App installation credentials to a repository or model job:
  rejected because App credentials remain inside a trusted adapter.
- Treat pull-request merge as proof of live metadata application: rejected
  because About fields are external, mutable state.
- Use the repository walkthrough document as the homepage: rejected because it
  is supporting documentation, not a separately maintained canonical project
  site.

## References

- [Repository metadata architecture](../architecture/repository-metadata.md)
- [Repository metadata readiness checklist](../release/repository-metadata-checklist.md)
- [Product and distribution boundary](../architecture/distribution-boundary.md)
- [Technical identity decision](0019-hyperfinite-retains-agentic-framework-technical-identity.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)
- [GitHub REST: Update a repository](https://docs.github.com/en/rest/repos/repos#update-a-repository)
- [GitHub REST: Replace all repository topics](https://docs.github.com/en/rest/repos/repos#replace-all-repository-topics)
- [GitHub Actions workflow permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions)
