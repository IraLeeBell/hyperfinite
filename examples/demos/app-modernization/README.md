# App Modernization synthetic example

This example demonstrates the disabled-by-default App Modernization contract
without cloning a repository, using credentials, calling a network service, or
mutating GitHub.

The synthetic run follows the exact ten-stage journey. Its first invocation
stops at Human review with a draft-pull-request package and `COMMENT`-only
automated findings. The separate continuation supplies synthetic independent
human approval and later merge observation before Completed. Every external
call assertion fixture contains zero for its exact closed categories; it is not
runtime telemetry.

`target-free-patch.json` contains logical slots only. Trusted configuration maps
those slots to exact paths and runs the fixed offline verification-command
catalog. The model cannot select either surface.
