# Authoritative repository metadata readiness checklist

This checklist applies only to maintainers of the public
`IraLeeBell/hyperfinite` repository. It is not a customer-starter configuration
step. Repository About fields live outside Git validation and remain explicit
human-maintained readiness surfaces.

## Reviewed desired state

| Field | Exact value |
|---|---|
| Description | `GitHub-native control plane that keeps model output advisory and execution authority deterministic.` |
| Homepage | Unset (the repository has no maintained canonical public homepage) |
| Topics | `agentic-ai`, `agentic-workflows`, `ai-governance`, `deterministic-systems`, `github-actions`, `human-in-the-loop`, `llm-security`, `policy-as-code` |

The state is display and discovery data only. It grants no lifecycle,
repository, target, Project, capability, credential, transition, release, or
effect authority and does not claim that live trust services, a hosted product,
an SDK, a CLI, or customer administration are included.

## Pre-apply plan and confirmation

1. Confirm the metadata contract pull request is merged and use an exact,
   reviewed `main` checkout. Merge authorizes the desired state but does not
   apply it.
2. Authenticate `gh` interactively as a human repository administrator. Do not
   use a PAT, an Actions `GITHUB_TOKEN`, a model job, or exposed GitHub App
   credentials.
3. Build the read-only planner:

   ```bash
   npm run build
   ```

4. Perform the exact authenticated read and pipe only its closed fields to the
   planner:

   ```bash
   gh repo view IraLeeBell/hyperfinite \
     --json id,nameWithOwner,description,homepageUrl,repositoryTopics,viewerCanAdminister,viewerPermission |
     node dist/scripts/plan-repository-metadata.js
   ```

5. Confirm the output repository is exactly `IraLeeBell/hyperfinite` with node
   ID `R_kgDOUMHgnA`, `adminEligible` is `true`, both digests are present, and
   every replace/add/remove operation matches the reviewed table above. Stop on
   malformed input, identity mismatch, unexpected fields, unknown desired
   values, or `blocked-insufficient-admin`.
6. Record the human confirmation of the displayed `contractDigest` and
   `readbackDigest` in the protected maintainer evidence for the change. The
   planner itself performs no mutation.

## Human-admin application

After confirming the fresh plan, use the GitHub repository About/Settings UI to
replace the description, clear the website field, and replace the topic set
with exactly the reviewed values. This is the only application step. Do not add
a merge workflow or credential fallback.

If the pre-read is already `in-sync`, perform no write and continue to
readback. If the UI reports an ambiguous or failed update, do not claim success
or blindly retry; obtain a fresh read and recompute the complete plan.

## Post-apply readback and drift handling

1. Rerun the exact `gh repo view ... | node
   dist/scripts/plan-repository-metadata.js` command.
2. Inspect the direct `gh repo view` values as well as the plan. Acceptance
   requires the exact description, an empty/unset homepage, the complete
   eight-topic set with no extras, `status: "in-sync"`, and
   `drift.found: false`.
3. Treat missing, stale, partial, wrong-repository, non-admin, or drifted output
   as a blocker. A matching description alone is not acceptance.
4. For unintended future drift, fresh-read, confirm the existing contract, and
   restore the exact state through the same human-admin process. For an
   intentional wording, topic, homepage, or repository identity change, first
   merge a new pull request updating the contract, schema, ADR/security
   boundary, checklist, and deterministic tests.

No repository snapshot or issue state is changed by this checklist. The live
About readback remains external, drift-prone evidence.
