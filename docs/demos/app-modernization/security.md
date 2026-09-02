# App Modernization security boundary

The pack fails closed on missing, skipped, or reordered stages; generic-agent,
capability, workflow, or cross-demo substitution; stale predecessor evidence;
duplicate identities; repository substitution; arbitrary clone/fetch/remote or
submodule requests; prompt injection; malformed or oversized artifacts; path
traversal, links, case collisions, binary/mode changes, and unexpected diffs.

Network, external MCP, secrets, credentials, package installation, lifecycle
scripts, model-selected commands, and arbitrary URLs are denied. The exact
logical slot map and command catalog are trusted inputs, not model output.

Implementation is draft-only. Automated verification is exact-head and
`COMMENT`-only. It cannot approve, request changes as authority, dismiss, mark
ready, merge, deploy, publish, or reconfigure Projects, Apps, credentials,
rulesets, billing, teams, or visibility. Human review and merge remain
independent gates.
