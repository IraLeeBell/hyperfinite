# Synthetic display-color target proposal

`target-manifest.example.json` is generated from the four synthetic snapshots in
`tests/fixtures/project-display-colors/live-shaped/`. It demonstrates the closed
user-owned, public, populated Project shape and contains no live target,
credential, installation, customer, or runtime-binding data.

Regenerate it after building:

```bash
node dist/scripts/github-project-display-colors.js target-manifest \
  --snapshots tests/fixtures/project-display-colors/live-shaped \
  --evaluated-at 2026-09-03T23:54:00.000Z | jq . \
  > examples/project-display-colors/target-manifest.example.json
```

The example is non-authoritative. A live operator must derive a new manifest
from separately supplied fresh read-only snapshots and obtain an independent
human confirmation of its canonical `contentDigest`.
