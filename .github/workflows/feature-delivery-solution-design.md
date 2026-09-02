---
name: Feature Delivery solution design
description: Stages a target-free solution decision from an authorized default-branch command.
on:
  slash_command:
    name: feature-delivery-solution-design
    events: [issue_comment]
  roles: [admin, maintainer, write]
  reaction: none
  status-comment: false
  permissions:
    contents: read
    issues: read
    pull-requests: read
    id-token: write
  steps:
    - name: Check out the trusted runtime
      if: steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'
      uses: actions/checkout@v7
      with:
        ref: ${{ github.workflow_sha }}
        persist-credentials: false
    - name: Set up the pinned Node runtime
      if: steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'
      uses: actions/setup-node@v7
      with:
        node-version: 24
        cache: npm
    - name: Install locked dependencies
      if: steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'
      run: npm ci --ignore-scripts
    - name: Build the deterministic guard
      if: steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'
      run: npm run build
    - name: Authorize solution design before model execution
      id: trusted_guard
      if: steps.check_command_position.outputs.command_position_ok == 'true' && steps.check_membership.outputs.is_team_member == 'true'
      env:
        GITHUB_TOKEN: ${{ github.token }}
        AGENTIC_RUNTIME_ENABLED: ${{ vars.AGENTIC_RUNTIME_ENABLED }}
        AGENTIC_ALLOWED_ACTOR_IDS: ${{ vars.AGENTIC_ALLOWED_ACTOR_IDS }}
        AGENTIC_APP_ID: ${{ vars.AGENTIC_APP_ID }}
        AGENTIC_APP_ACTOR_ID: ${{ vars.AGENTIC_APP_ACTOR_ID }}
        AGENTIC_PROJECT_NODE_ID: ${{ vars.AGENTIC_PROJECT_NODE_ID }}
        AGENTIC_STATE_SIGNING_KEY_ID: ${{ vars.AGENTIC_STATE_SIGNING_KEY_ID }}
        AGENTIC_STATE_SIGNING_PUBLIC_KEY: ${{ vars.AGENTIC_STATE_SIGNING_PUBLIC_KEY }}
        AGENTIC_REDEEMER_URL: ${{ vars.AGENTIC_REDEEMER_URL }}
        AGENTIC_REDEEMER_AUDIENCE: ${{ vars.AGENTIC_REDEEMER_AUDIENCE }}
        AGENTIC_REDEEMER_SIGNING_KEY_ID: ${{ vars.AGENTIC_REDEEMER_SIGNING_KEY_ID }}
        AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY: ${{ vars.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY }}
        GITHUB_EVENT_ACTION: ${{ github.event.action }}
        WORK_ITEM_NUMBER: ${{ github.event.issue.number }}
        WORK_ITEM_KIND: issue
        RUNTIME_PHASE: framing
        RUNTIME_ROLE: framer
        RUNTIME_DEMO_PROJECT_ID: feature-delivery
        RUNTIME_STAGE_ID: solution-design
        RUNTIME_CAPABILITY: demo.feature-delivery.solution-design@1.0.0
        RUNTIME_WORKFLOW_ID: feature-delivery-solution-design
        WORK_ACCORD_DIGEST: ${{ vars.AGENTIC_WORK_ACCORD_DIGEST }}
        POLICY_DIGEST: ${{ vars.AGENTIC_POLICY_DIGEST }}
        KERNEL_POLICY_DIGEST: ${{ vars.AGENTIC_KERNEL_POLICY_DIGEST }}
        ACTIVATION_LEASE_DIGEST: ${{ vars.AGENTIC_ACTIVATION_LEASE_DIGEST }}
      run: node dist/scripts/runtime-pre-activation.js
jobs:
  pre-activation:
    outputs:
      authorization_digest: ${{ steps.trusted_guard.outputs.authorization_digest }}
      redemption_digest: ${{ steps.trusted_guard.outputs.redemption_digest }}
      authorized_head_sha: ${{ steps.trusted_guard.outputs.authorized_head_sha }}
  agent:
    needs: [pre-activation]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
if: needs.pre_activation.outputs.trusted_guard_result == 'success' && needs.pre_activation.outputs.authorization_digest != '' && needs.pre_activation.outputs.redemption_digest != ''
checkout: false
pre-steps:
  - name: Check out the trusted runtime
    uses: actions/checkout@v7
    with:
      ref: ${{ github.workflow_sha }}
      persist-credentials: false
engine:
  id: copilot
  agent: feature-delivery-solution-design
  max-continuations: 1
  concurrency:
    group: gh-aw-copilot-feature-delivery-solution-design
network: {}
tools:
  github:
    toolsets: [issues]
    allowed:
      - issue_read
    allowed-repos: ["${{ github.repository }}"]
    min-integrity: approved
    github-token: ${{ secrets.GITHUB_TOKEN }}
skills:
  - .github/skills/feature-delivery-solution-design
  - .github/skills/authority-refusal
timeout-minutes: 10
model: gpt-5.4
max-turns: 8
max-ai-credits: 200
max-daily-ai-credits: 1500
concurrency:
  group: agentic-demo-${{ github.repository_id }}-${{ github.event.issue.number }}
  cancel-in-progress: false
  queue: max
safe-outputs:
  staged: true
  github-token: ${{ secrets.GITHUB_TOKEN }}
  mentions: false
  allowed-github-references: []
  max-bot-mentions: 1
  report-failure-as-issue: false
  report-failed-jobs: false
  missing-tool: false
  missing-data: false
  report-incomplete: false
  noop: false
  add-comment:
    max: 1
    target: ${{ github.event.issue.number }}
    target-repo: ${{ github.repository }}
  threat-detection:
    enabled: true
    max-ai-credits: 100
    engine: copilot
---

# Authorized Feature Delivery solution design

Read only issue `${{ github.event.issue.number }}` in the current repository `${{ github.repository }}` and the signed activation context. The trusted pre-activation job redeemed authorization `${{ needs.pre_activation.outputs.authorization_digest }}` with redemption `${{ needs.pre_activation.outputs.redemption_digest }}` for this exact run.

Use `feature-delivery-solution-design` and `authority-refusal`. Produce one target-free design decision traced to every stable acceptance criterion and only the trusted logical slots in the activation context.

Do not choose a repository, path, stage, route, capability, command, credential, retry, effect, approval, or merge. The safe output is staged; trusted code alone may translate exact-success evidence into a bound comment plan.
