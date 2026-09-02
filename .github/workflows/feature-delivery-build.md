---
name: Feature Delivery build
description: Stages a target-free bounded patch from an authorized Feature Delivery command.
on:
  slash_command:
    name: feature-delivery-build
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
    - name: Authorize Feature Delivery build before model execution
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
        RUNTIME_PHASE: execution
        RUNTIME_ROLE: executor
        RUNTIME_DEMO_PROJECT_ID: feature-delivery
        RUNTIME_STAGE_ID: build
        RUNTIME_CAPABILITY: demo.feature-delivery.build@1.0.0
        RUNTIME_WORKFLOW_ID: feature-delivery-build
        WORK_ACCORD_DIGEST: ${{ vars.AGENTIC_WORK_ACCORD_DIGEST }}
        POLICY_DIGEST: ${{ vars.AGENTIC_POLICY_DIGEST }}
        KERNEL_POLICY_DIGEST: ${{ vars.AGENTIC_KERNEL_POLICY_DIGEST }}
        ACTIVATION_LEASE_DIGEST: ${{ vars.AGENTIC_ACTIVATION_LEASE_DIGEST }}
      run: node dist/scripts/runtime-pre-activation.js
    - name: Seal the trusted execution authorization for the post-agent bridge
      if: steps.trusted_guard.outcome == 'success' && steps.trusted_guard.outputs.trusted_execution_authorization_b64 != ''
      env:
        TRUSTED_EXECUTION_AUTHORIZATION_B64: ${{ steps.trusted_guard.outputs.trusted_execution_authorization_b64 }}
        TRUSTED_EXECUTION_KERNEL_RESULT_B64: ${{ steps.trusted_guard.outputs.trusted_execution_kernel_result_b64 }}
      run: |
        mkdir -p "${RUNNER_TEMP}/agentic-execution-authorization"
        printf '%s' "${TRUSTED_EXECUTION_AUTHORIZATION_B64}" | base64 --decode > "${RUNNER_TEMP}/agentic-execution-authorization/authorization.json"
        printf '%s' "${TRUSTED_EXECUTION_KERNEL_RESULT_B64}" | base64 --decode > "${RUNNER_TEMP}/agentic-execution-authorization/kernel-result.json"
        chmod 600 "${RUNNER_TEMP}/agentic-execution-authorization/authorization.json"
        chmod 600 "${RUNNER_TEMP}/agentic-execution-authorization/kernel-result.json"
    - name: Transfer the trusted execution authorization
      if: steps.trusted_guard.outcome == 'success' && steps.trusted_guard.outputs.trusted_execution_authorization_b64 != ''
      uses: actions/upload-artifact@v7
      with:
        name: feature-delivery-build-authorization-${{ github.run_id }}-${{ github.run_attempt }}
        path: ${{ runner.temp }}/agentic-execution-authorization
        if-no-files-found: error
        retention-days: 1
jobs:
  pre-activation:
    outputs:
      authorization_digest: ${{ steps.trusted_guard.outputs.authorization_digest }}
      redemption_digest: ${{ steps.trusted_guard.outputs.redemption_digest }}
      authorized_head_sha: ${{ steps.trusted_guard.outputs.authorized_head_sha }}
      trusted_execution_authorization_b64: ${{ steps.trusted_guard.outputs.trusted_execution_authorization_b64 }}
      trusted_execution_kernel_result_b64: ${{ steps.trusted_guard.outputs.trusted_execution_kernel_result_b64 }}
      model_execution_context_json: ${{ steps.trusted_guard.outputs.model_execution_context_json }}
  agent:
    needs: [pre-activation]
permissions:
  contents: read
  issues: read
  pull-requests: read
  copilot-requests: write
env:
  GITHUB_TOKEN: ""
  GH_TOKEN: ""
  GH_AW_GITHUB_TOKEN: ""
  GH_AW_GITHUB_MCP_SERVER_TOKEN: ""
  GITHUB_MCP_SERVER_TOKEN: ""
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
  agent: feature-delivery-build
  max-continuations: 1
  concurrency:
    group: gh-aw-copilot-feature-delivery-build
network: {}
tools:
  github: false
skills:
  - .github/skills/feature-delivery-build
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
  jobs:
    stage-implementation-patch:
      description: Validate one closed target-free Feature Delivery patch and stage its trusted delivery handoff.
      runs-on: ubuntu-slim
      if: needs.detection.outputs.detection_success == 'true' && needs.detection.outputs.detection_conclusion == 'success'
      permissions:
        contents: read
        id-token: write
      inputs:
        planning_artifact_digest:
          description: Exact planning artifact digest from the signed model context.
          required: true
          type: string
        execution_grant_digest:
          description: Exact execution grant digest from the signed model context.
          required: true
          type: string
        patch_json:
          description: JSON TargetFreePatch@1.0.0 containing logical slots and UTF-8 content only; repository paths are forbidden.
          required: true
          type: string
      steps:
        - name: Retrieve the trusted execution authorization
          uses: actions/download-artifact@v8
          with:
            name: feature-delivery-build-authorization-${{ github.run_id }}-${{ github.run_attempt }}
            path: ${{ runner.temp }}/agentic-execution-authorization
        - name: Check out the trusted runtime and authorized base history
          uses: actions/checkout@v7
          with:
            ref: ${{ github.workflow_sha }}
            fetch-depth: 0
            persist-credentials: false
        - name: Set up the pinned Node runtime
          uses: actions/setup-node@v7
          with:
            node-version: 24
            cache: npm
        - name: Install locked dependencies
          run: npm ci --ignore-scripts
        - name: Build the trusted execution bridge
          run: npm run build
        - name: Validate patch and stage trusted delivery handoff
          id: trusted_execution_bridge
          env:
            TRUSTED_EXECUTION_AUTHORIZATION_PATH: ${{ runner.temp }}/agentic-execution-authorization/authorization.json
            TRUSTED_KERNEL_RESULT_PATH: ${{ runner.temp }}/agentic-execution-authorization/kernel-result.json
            AGENTIC_REDEEMER_SIGNING_KEY_ID: ${{ vars.AGENTIC_REDEEMER_SIGNING_KEY_ID }}
            AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY: ${{ vars.AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY }}
            AGENTIC_EVIDENCE_SIGNER_URL: ${{ vars.AGENTIC_EVIDENCE_SIGNER_URL }}
            AGENTIC_EVIDENCE_SIGNER_AUDIENCE: ${{ vars.AGENTIC_EVIDENCE_SIGNER_AUDIENCE }}
            AGENTIC_EVIDENCE_SIGNING_KEY_ID: ${{ vars.AGENTIC_EVIDENCE_SIGNING_KEY_ID }}
            AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY: ${{ vars.AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY }}
            GH_AW_DETECTION_SUCCESS: ${{ needs.detection.outputs.detection_success }}
            GH_AW_DETECTION_CONCLUSION: ${{ needs.detection.outputs.detection_conclusion }}
            RUNTIME_DEMO_PROJECT_ID: feature-delivery
            RUNTIME_STAGE_ID: build
          run: node dist/scripts/runtime-execution-bridge.js
        - name: Transfer the signed trusted execution bundle
          id: trusted_execution_bundle
          uses: actions/upload-artifact@v7
          with:
            name: feature-delivery-build-bundle-${{ github.run_id }}-${{ github.run_attempt }}
            path: ${{ steps.trusted_execution_bridge.outputs.delivery_handoff_path }}
            if-no-files-found: error
            retention-days: 1
        - name: Invoke the trusted execution delivery service
          if: vars.AGENTIC_EXECUTION_DELIVERY_URL != '' && vars.AGENTIC_EXECUTION_DELIVERY_AUDIENCE != ''
          run: node dist/scripts/runtime-execution-delivery-request.js
          env:
            AGENTIC_EXECUTION_DELIVERY_URL: ${{ vars.AGENTIC_EXECUTION_DELIVERY_URL }}
            AGENTIC_EXECUTION_DELIVERY_AUDIENCE: ${{ vars.AGENTIC_EXECUTION_DELIVERY_AUDIENCE }}
            TRUSTED_EXECUTION_ARTIFACT_ID: ${{ steps.trusted_execution_bundle.outputs.artifact-id }}
            TRUSTED_EXECUTION_ARTIFACT_NAME: feature-delivery-build-bundle-${{ github.run_id }}-${{ github.run_attempt }}
            TRUSTED_EXECUTION_ARTIFACT_DIGEST: ${{ steps.trusted_execution_bundle.outputs.artifact-digest }}
            TRUSTED_EXECUTION_BUNDLE_DIGEST: ${{ steps.trusted_execution_bridge.outputs.delivery_handoff_digest }}
  threat-detection:
    enabled: true
    max-ai-credits: 100
    engine: copilot
---

# Authorized Feature Delivery build

Use only the signed activation context redeemed as `${{ needs.pre_activation.outputs.authorization_digest }}` with redemption `${{ needs.pre_activation.outputs.redemption_digest }}` for this exact run. The signed target-free planning context is `${{ needs.pre_activation.outputs.model_execution_context_json }}`.

Use `feature-delivery-build` and `authority-refusal`. Call `stage_implementation_patch` exactly once with the signed planning and execution-grant digests plus one `TargetFreePatch@1.0.0` JSON value. The patch may contain only the authorized logical slots and UTF-8 content. Trusted code maps slots to exact paths, validates the isolated diff and every fixed command, and may create only a draft pull request.

Do not select or emit repository paths, branches, commits, pull requests, Project items, stages, routes, capabilities, commands, credentials, retries, or effects. Do not use network, MCP, shell, or secrets. Do not approve, mark ready, merge, deploy, publish, or claim completion.
