# ADR 0022: Project option colors are display-only

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

The four demo Projects use single-select fields to present lifecycle and journey
state, operator attention, gates, stage interaction, and bounded agent-selection
status. Leaving option colors unspecified caused GitHub to display every option
as gray and made independently configured Projects visually inconsistent.

Color is mutable Project metadata. It cannot become a semantic shortcut or enter
the authority chain.

## Decision

Every declarative single-select option must specify one GitHub-supported color:
`GRAY`, `BLUE`, `GREEN`, `YELLOW`, `ORANGE`, `RED`, `PINK`, or `PURPLE`.
The canonical Project-schema generator fixes the complete palette for core Stage,
each exact Journey Stage, Depth Profile, Gate Status, Attention, Stage
Interaction, Requested Stage Agent, and Agent Selection Status. Equivalent
states use the same color in all four demos.

Option names and descriptions remain the accessible semantic source. Color is an
additional display cue only. No lifecycle, Work Accord, policy, capability,
target, credential, transition, agent-selection, effect, approval, or merge
decision may derive meaning or authority from color.

Project live snapshots and validated bindings retain exact option names, colors,
descriptions, and node IDs. Target manifests bind each Project schema digest.
Offline setup, bootstrap, export/import, and readback compare those attributes
exactly. A missing, unsupported, stale, duplicated, or mismatched attribute
fails closed or produces a human-administrator reconciliation action; no path
defaults an omitted color to gray.

Repository tooling remains dry-run and credentialless. It has no apply or execute
verb. A human administrator separately reviews the exact plan, confirms its
targets and digest, applies one change set, and obtains fresh exact readback for
all four Projects.

## Consequences

- Existing Projects require one reviewed human-admin color reconciliation after
  merge.
- Schema, target-manifest, binding, plan, export, and readback digests change
  when an option color changes.
- Color drift blocks a fresh binding but cannot change a projection source,
  dispatch an agent, satisfy a gate, or advance the lifecycle.
- Project option node IDs remain authenticated target bindings, not declarative
  repository values.

## References

- [Autonomous demo portfolio](../architecture/autonomous-demo-portfolio.md)
- [GitHub Project setup](../runbooks/github-project-setup.md)
- [Threat model](../security/threat-model.md)
- [Control matrix](../security/control-matrix.md)
