## Purpose

Relates to #

## Decisions and ADRs

## Scope

## Non-goals

## Changes

## Acceptance evidence

## Verification

```text
npm ci --ignore-scripts --no-audit --no-fund
npm run validate:customer-readiness
npm run typecheck
npm run build
npm test
npm run validate:schemas
npm run validate:runtime
npm run validate:eval-fixtures
npm run validate:provenance
npm run validate:workflows
npm run validate:gh-aw
npm run validate:packaging
npm audit --audit-level=high
git diff --check origin/main...HEAD
npm run validate:demos
npm run simulate:demos
npm run validate:hardening
```

## Security review

## Privacy and data considerations

## Licensing and provenance

## Operational considerations

## Customer rollout and support impact

## Required customer tickets or approvals

## Cost impact

## Residual risk

## Rollback

## Human review required

- [ ] Independent human review is complete.
- [ ] The author will not approve or merge this pull request.
- [ ] Any license, visibility, publication, or privileged-configuration change has separate written approval.
