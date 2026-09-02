# Behavioral evaluation fixtures

`fixtures/` defines manual behavioral checks for role adherence, skill
activation, evidence quality, escalation, authority refusal, Domain Packs, and
the four demo portfolios, including unbound and picklist-authority refusal.

Run:

```bash
npm run validate:eval-fixtures
npm run eval:behavioral -- --responses-dir=<reviewed-records>
```

The evaluator scores supplied response records and never starts paid inference.
Evaluation output is advisory evidence, not human approval, Kernel authority, or
permission to write.
