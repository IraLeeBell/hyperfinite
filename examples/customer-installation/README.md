# Hermetic customer installation example

This example is synthetic, GHEC-only, disabled by default, and contains no
credential or customer identifier. It exercises deterministic planning without
network access or external mutation:

```bash
npm run installer -- plan
npm run installer -- offline-validate
```

The `example-enterprise/example-organization/example-repository` identity and
numeric/node values are inert placeholders. An administrator must replace every
binding from authenticated GitHub reads, replace the synthetic closed backup
evidence, retain `apply.enabled: false` during planning, review the canonical
plan and precondition digests, and use a separately deployed trusted adapter for
any authorized apply. This CLI cannot apply, install an App, create a Project,
alter a ruleset, enable billing, or mutate GitHub.
`offline-validate` only rechecks these local files. Authenticated live validation
requires the separately deployed read-only trusted adapter API and current
human authorization.
