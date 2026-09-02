export const DEMO_PORTFOLIO_EVIDENCE_CLASSES = [
  "repository-issue-project-binding",
  "work-accord-profile",
  "artifacts",
  "receipts",
  "approvals",
  "budgets",
  "agent-bindings",
  "allowed-path-grants"
] as const;

export type DemoPortfolioEvidenceClass =
  (typeof DEMO_PORTFOLIO_EVIDENCE_CLASSES)[number];
