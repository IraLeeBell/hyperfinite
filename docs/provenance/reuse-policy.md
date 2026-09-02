# Third-party reuse and provenance policy

## Status and scope

This policy is **current for repository contributions**. It is not legal advice
or an outbound license decision.

## Default

Create original structure, terminology, prose, schemas, prompts, workflows, and code. Use external work only for factual citation and conceptual learning unless a stricter review path is completed.

## Classifications

| Classification | Meaning | Default disposition |
|---|---|---|
| Factual citation | A sourced fact about a reference | Allowed with immutable evidence |
| Conceptual influence | An independently re-authored idea | Allowed with inventory record and clear non-adoption |
| Adapted | Source expression modified for local use | Blocked until asset-level and human approval |
| Verbatim | Source expression copied | Exceptional; blocked until qualified review |
| None | Reviewed but not used | Record why if material to a decision |

The machine inventory uses `conceptual`, `adapted`, `verbatim`, and `none`; factual citation is recorded as a material-claim influence.

## Required provenance

Every record must identify:

- repository/site, source path, canonical URL, tag, full commit SHA, commit/blob URL, and retrieval time;
- SPDX expression or `NOASSERTION`, license URL/scope, notice duties, copyright holder;
- trademark observations;
- classification, concept/material used, local destination, and modifications;
- review owner, approval state, update policy, and removal/replacement plan;
- legal, trademark, and security review state;
- source hash or immutable review link;
- material claims and line-pinned evidence.

Adapted or verbatim entries missing any disposition fail validation.

## Citation standard

- Material repository facts use `blob/<full-40-character-sha>/path#Lx-Ly` links.
- Repository identity and history may use `commit/<full-40-character-sha>` links.
- Use canonical HTTPS inline Markdown links or autolinks for citations. GitHub citation links and images must not have Markdown titles. Reference-style links and raw HTML link/image tags are unsupported, and HTML comments are not citation evidence.
- GitHub owner, repository, route, and ref segments must be literal. Percent encoding is allowed only in the file path after the ref, must decode exactly once, and must not encode path separators. A decoded literal `%` is allowed when it does not begin another percent escape. Markdown delimiter-sensitive filename characters (`[`, `]`, `(`, and `)`) must be percent-encoded.
- Branches, tags, `HEAD`, short SHAs, raw default-branch URLs, and search results are not evidence.
- Cite the smallest useful line range and every source needed for a synthesis.
- License and notice claims link to the pinned text.
- Unsupported negative findings use the exact phrase `Not evidenced at pinned revision`; they do not claim proof of absence.
- Mutable website observations are dated and cannot support an architecture or license conclusion unless corroborated by commit-pinned source.
- Citations support upstream facts only. Local decisions and terminology remain original.

## Prohibited without approval

- wholesale copying or close paraphrase;
- template, prompt, schema, workflow, rubric, persona, taxonomy, or generated-file transplantation;
- moving branch/tag/`HEAD` links as provenance;
- assuming a root license covers embedded assets, catalog items, plugins, dependencies, sites, or marks;
- using access to an unlicensed/private repository as permission;
- compatibility, endorsement, or trademark claims;
- silent model fallback when deterministic validation fails;
- publication or packaging before open-source-readiness approval.

## Review path for adaptation

1. Identify the exact source file and immutable revision.
2. Determine asset-level license, notices, ownership, marks, patents, and upstream provenance.
3. Record local destination and a modification history.
4. Assess outbound-license and dependency compatibility.
5. Define update and removal/replacement plans.
6. Obtain code owner, security, and qualified legal/OSPO approval as applicable.
7. Preserve exact required notices separately from dependency/SBOM attribution.
8. Add similarity and provenance checks before release.

Verbatim reuse requires a written rationale showing why independent implementation is insufficient.

## Update policy

References do not float. A human-approved update resolves a new full SHA, reruns research for changed material, updates claims/license evidence, and records the prior pin. Automated dependency tooling must not rewrite research pins.

## Release

No automation may change repository visibility, license, package publication,
contributor terms, or release channel. A release candidate requires license,
SBOM, notices, attribution, secret, trademark, provenance, and similarity review
plus the approvals defined by repository governance.

## Repository license exception

The existing MIT `LICENSE` is preserved. This policy does not narrow, supersede,
or reinterpret that file.
