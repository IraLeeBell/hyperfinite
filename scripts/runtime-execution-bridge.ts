#!/usr/bin/env node

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createPublicKey, verify as verifyBytes } from "node:crypto";
import path from "node:path";
import process from "node:process";

import {
  assertDocument,
  canonicalJson,
  digest,
  runTrustedExecutionBridge,
  verifyRuntimeAuthorizationSignature,
  type RuntimeAuthorization,
  type TargetFreePatchEnvelope,
  type DetachedSignature,
  type EngineeringThreatEvidence
} from "../src/index.js";
import { loadTrustedDemoRuntimeBindingForSelection } from "./demo-runtime-metadata.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new TypeError(`required environment value ${name} is missing`);
  }
  return value.trim();
}

function decodeJson(value: string, subject: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
  } catch {
    throw new TypeError(`${subject} is not valid base64-encoded JSON`);
  }
}

function trustedHttpsUrl(value: string, subject: string): URL {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      throw new TypeError(`${subject} must be an HTTPS URL without credentials`);
    }
    return url;
  }

  async function oidcToken(audience: string): Promise<string> {
    const requestUrl = trustedHttpsUrl(
      required("ACTIONS_ID_TOKEN_REQUEST_URL"),
      "ACTIONS_ID_TOKEN_REQUEST_URL"
    );
    if (!requestUrl.hostname.endsWith(".actions.githubusercontent.com")) {
      throw new TypeError("OIDC token endpoint is not a GitHub Actions host");
    }
    requestUrl.searchParams.set("audience", audience);
    const response = await fetch(requestUrl, {
      redirect: "error",
      headers: {
        Authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub OIDC request failed with ${response.status}`);
    }
    const body = (await response.json()) as { readonly value?: unknown };
    if (typeof body.value !== "string" || body.value.length === 0) {
      throw new TypeError("GitHub OIDC response omitted the token");
    }
    return body.value;
  }

  async function signEvidence(
    subject: string,
    payload: unknown
  ): Promise<DetachedSignature> {
    const signerUrl = trustedHttpsUrl(
      required("AGENTIC_EVIDENCE_SIGNER_URL"),
      "AGENTIC_EVIDENCE_SIGNER_URL"
    );
    const audience = required("AGENTIC_EVIDENCE_SIGNER_AUDIENCE");
    const response = await fetch(signerUrl, {
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await oidcToken(audience)}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        subject,
        payload,
        run: {
          repository: required("GITHUB_REPOSITORY"),
          runId: required("GITHUB_RUN_ID"),
          runAttempt: required("GITHUB_RUN_ATTEMPT"),
          job: required("GITHUB_JOB")
        }
      })
    });
    if (!response.ok) {
      throw new Error(`trusted evidence signer failed with ${response.status}`);
    }
    const body = (await response.json()) as { readonly signature?: unknown };
    if (
      typeof body.signature !== "object" ||
      body.signature === null ||
      Array.isArray(body.signature)
    ) {
      throw new TypeError("trusted evidence signer omitted its signature");
    }
    return body.signature as DetachedSignature;
  }

  function verifyEvidence(payload: unknown, signature: DetachedSignature): boolean {
    if (
      signature.algorithm !== "ed25519" ||
      signature.keyId !== required("AGENTIC_EVIDENCE_SIGNING_KEY_ID")
    ) {
      return false;
    }
    try {
      return verifyBytes(
        null,
        Buffer.from(canonicalJson(payload)),
        createPublicKey({
          key: Buffer.from(required("AGENTIC_EVIDENCE_SIGNING_PUBLIC_KEY"), "base64"),
          format: "der",
          type: "spki"
        }),
        Buffer.from(signature.value, "base64")
      );
    } catch {
      return false;
  }
}

const agentOutput = JSON.parse(
  await readFile(required("GH_AW_AGENT_OUTPUT"), "utf8")
) as {
  readonly items?: readonly {
    readonly type?: unknown;
    readonly planning_artifact_digest?: unknown;
    readonly execution_grant_digest?: unknown;
    readonly patch_json?: unknown;
  }[];
};
const items = (agentOutput.items ?? []).filter(
  (item) => item.type === "stage_implementation_patch"
);
if (items.length !== 1) {
  throw new TypeError("exactly one target-free implementation patch is required");
}
const item = items[0];
if (
  item === undefined ||
  typeof item.planning_artifact_digest !== "string" ||
  typeof item.execution_grant_digest !== "string" ||
  typeof item.patch_json !== "string"
) {
  throw new TypeError("target-free implementation patch fields are missing");
}
const envelope: TargetFreePatchEnvelope = {
  schemaVersion: "1.0.0",
  planningArtifactDigest:
    item.planning_artifact_digest as TargetFreePatchEnvelope["planningArtifactDigest"],
  executionGrantDigest:
    item.execution_grant_digest as TargetFreePatchEnvelope["executionGrantDigest"],
  patch: JSON.parse(item.patch_json) as TargetFreePatchEnvelope["patch"]
};
const authorizationValue =
  process.env.TRUSTED_EXECUTION_AUTHORIZATION_PATH === undefined
    ? decodeJson(
        required("TRUSTED_EXECUTION_AUTHORIZATION_B64"),
        "execution authorization"
      )
    : (JSON.parse(
        await readFile(required("TRUSTED_EXECUTION_AUTHORIZATION_PATH"), "utf8")
      ) as unknown);
if (
  required("GH_AW_DETECTION_SUCCESS") !== "true" ||
  required("GH_AW_DETECTION_CONCLUSION") !== "success"
) {
  throw new TypeError("exact-success threat detection outputs are required");
}
const authorization = authorizationValue as RuntimeAuthorization;
const kernelResult = JSON.parse(
  await readFile(required("TRUSTED_KERNEL_RESULT_PATH"), "utf8")
) as Parameters<typeof runTrustedExecutionBridge>[0]["kernelResult"];
const runtimePolicy = assertDocument(
  "CopilotRuntimePolicy",
  JSON.parse(
    await readFile("config/v1alpha1/copilot-runtime-policy.json", "utf8")
  ) as unknown
);
const controlPolicy = assertDocument(
  "ControlPolicy",
  JSON.parse(await readFile("config/v1alpha1/policy.json", "utf8")) as unknown
);
const lifecycle = assertDocument(
  "LifecycleGraph",
  JSON.parse(await readFile("config/v1alpha1/lifecycle.json", "utf8")) as unknown
);
const baseRegistry = assertDocument(
  "CapabilityRegistry",
  JSON.parse(
    await readFile("config/v1alpha1/capability-registry.json", "utf8")
  ) as unknown
);
const demoProjectId = (process.env.RUNTIME_DEMO_PROJECT_ID ?? "").trim();
const demoStageId = (process.env.RUNTIME_STAGE_ID ?? "").trim();
if ((demoProjectId.length === 0) !== (demoStageId.length === 0)) {
  throw new TypeError(
    "RUNTIME_DEMO_PROJECT_ID and RUNTIME_STAGE_ID must be supplied together"
  );
}
const trustedDemoBinding =
  demoProjectId.length === 0
    ? undefined
    : await loadTrustedDemoRuntimeBindingForSelection({
        baseRegistry,
        lifecycle,
        demoProjectId,
        stageId: demoStageId,
        phase: authorization.phase,
        role: authorization.role,
        capability: authorization.capability,
        workflowId: authorization.workflowId
      });
const threatPayload = {
  status: "success",
  authorizationDigest: authorization.authorizationDigest,
  modelOutputDigest: digest(envelope),
  kernelReceiptDigest: authorization.kernelReceiptDigest,
  checkedAt: new Date().toISOString(),
  expiresAt: authorization.expiresAt
} as const;
const threatEvidence: EngineeringThreatEvidence = {
  ...threatPayload,
  signature: await signEvidence("engineering-threat-evidence", threatPayload)
};
const handoffPath = path.join(
  required("RUNNER_TEMP"),
  "agentic-execution-bundle.json"
);
const result = await runTrustedExecutionBridge({
  repositoryPath: required("GITHUB_WORKSPACE"),
  authorizationValue,
  authorizationVerifier: {
    verify: (authorization: RuntimeAuthorization) =>
      verifyRuntimeAuthorizationSignature(
        authorization,
        required("AGENTIC_REDEEMER_SIGNING_KEY_ID"),
        required("AGENTIC_REDEEMER_SIGNING_PUBLIC_KEY")
      )
  },
  kernelResult,
  runtimePolicyValue: runtimePolicy,
  controlPolicyValue: controlPolicy,
  envelopeValue: envelope,
  clock: { now: () => new Date().toISOString() },
  threatEvidenceValue: threatEvidence,
  evidenceSigner: {
    sign: (payload) => signEvidence("trusted-validated-patch-artifact", payload)
  },
  evidenceVerifier: { verify: verifyEvidence },
  ...(trustedDemoBinding === undefined ? {} : { trustedDemoBinding }),
  handoff: {
    async persist(bundle) {
      await writeFile(handoffPath, `${canonicalJson(bundle)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return { handoffDigest: digest(bundle) };
    }
  }
});
await appendFile(
  required("GITHUB_OUTPUT"),
  [
    `validated_patch_digest=${result.validatedPatch.patchDigest}`,
    `validated_tree_digest=${result.validatedPatch.treeDigest}`,
    `delivery_handoff_digest=${result.handoff.handoffDigest}`,
    `delivery_handoff_path=${handoffPath}`,
    ""
  ].join("\n")
);
