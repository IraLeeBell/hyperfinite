# Adaptive Delivery operator runbook

1. Validate the exact four-demo portfolio and `AgentParticipationPolicy`.
2. Verify Adaptive Delivery remains `guided` and only `discovery-studio` and
   `implementation-studio` are selectable.
3. Read the exact Project and item twice through the trusted adapter.
4. Treat Requested Stage Agent as untrusted intent and call
   `resolveStageAgentSelection()` with current actor authorization and authority
   evidence.
5. Persist and reread the signed exact-agent grant before dispatch.
6. Require the static workflow's trusted guard to receive the accepted grant
   digest. Never set a dynamic `engine.agent`.
7. Revalidate grant, lease, budget, generation, receipt head, and PR head
   immediately before inference.
8. Stop at Human Review. Automation may only emit COMMENT findings.

On stale, wrong-stage, unauthorized, replayed, or conflicting intent, invoke no
model, set Selection blocked or reconciliation-required through trusted
projection, clear or invalidate the input on stage exit, and require a new
generation when policy changed.
