# Portfolio setup and live visibility

Repository delivery integrates schemas, trusted registrations, offline
validation, hermetic simulation, and executable hardening evidence only. It did
not create or mutate a live GitHub Project, install an App, request identifiers
or secrets, enable inference, or activate a writer.

The four Projects remain unavailable for runtime use until human administrators
deliberately complete all of the following against an independently validated
merged head:

1. provision or reconcile each Project from a fresh read-only export;
2. create and install the dedicated least-privilege GitHub App;
3. keep the App private key and webhook secret outside the repository;
4. provide the exact repository, Project, item, field, option, and installation
   identifiers through protected deployment configuration;
5. configure billing, Copilot policy, rulesets, required checks, branch
   protections, visibility, serialization, and trust services;
6. validate the current binding and all drift with the offline dry-run tools;
7. independently review the complete setup and security evidence; and
8. activate one sandbox canary and independently observe it reach Human Review
   before considering the Projects visible or usable in sandbox.

Every setup or reconciliation action is human-admin-only. Exact live Project
IDs are confined to a protected customer target manifest whose digest is
independently confirmed; credentials remain absent from repository
configuration. Projects remain
non-authoritative after provisioning: the Kernel and durable receipts lead,
and projection fields converge afterward with Stage written last.

Use `npm run github:setup -- validate`, `plan`, `bootstrap-plan`, and
`bootstrap-readback` for offline evidence. Never use an apply flag; the setup
CLI rejects it. A human-authorized administrator applies only an explicitly
confirmed external plan and retains complete readback.

The exact required-value inventory, kill switch, recovery drill, and canary
criteria are in [activation and readiness](activation-and-readiness.md).
Repository merge alone does not provision a Project or make a demo live.
