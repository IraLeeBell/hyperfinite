#!/usr/bin/env node

import process from "node:process";

import {
  canonicalJson,
  digest,
  type Digest,
  type TrustedExecutionDeliveryRequest
} from "../src/index.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function positiveInteger(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function sha256Digest(name: string): Digest {
  const value = required(name);
  const normalized = value.startsWith("sha256:") ? value : `sha256:${value}`;
  if (!/^sha256:[0-9a-f]{64}$/u.test(normalized)) {
    throw new TypeError(`${name} must be a SHA-256 digest`);
  }
  return normalized as Digest;
}

const serviceUrl = new URL(required("AGENTIC_EXECUTION_DELIVERY_URL"));
if (
  serviceUrl.protocol !== "https:" ||
  serviceUrl.username.length !== 0 ||
  serviceUrl.password.length !== 0 ||
  serviceUrl.hash.length !== 0
) {
  throw new TypeError("AGENTIC_EXECUTION_DELIVERY_URL must use HTTPS");
}
const oidcUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
oidcUrl.searchParams.set(
  "audience",
  required("AGENTIC_EXECUTION_DELIVERY_AUDIENCE")
);
const oidcResponse = await fetch(oidcUrl, {
  headers: {
    authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}`
  }
});
if (!oidcResponse.ok) {
  throw new TypeError(`OIDC token request failed with ${oidcResponse.status}`);
}
const oidcValue = (await oidcResponse.json()) as { readonly value?: unknown };
if (typeof oidcValue.value !== "string" || oidcValue.value.length === 0) {
  throw new TypeError("OIDC token response is missing its value");
}

const request: TrustedExecutionDeliveryRequest = {
  schemaVersion: "1.0.0",
  repositoryId: positiveInteger("GITHUB_REPOSITORY_ID"),
  repositoryFullName: required("GITHUB_REPOSITORY"),
  workflowRef: required("GITHUB_WORKFLOW_REF"),
  workflowSha: required("GITHUB_WORKFLOW_SHA"),
  runId: positiveInteger("GITHUB_RUN_ID"),
  runAttempt: positiveInteger("GITHUB_RUN_ATTEMPT"),
  artifactId: positiveInteger("TRUSTED_EXECUTION_ARTIFACT_ID"),
  artifactName: required("TRUSTED_EXECUTION_ARTIFACT_NAME"),
  artifactArchiveDigest: sha256Digest("TRUSTED_EXECUTION_ARTIFACT_DIGEST"),
  bundleDigest: sha256Digest("TRUSTED_EXECUTION_BUNDLE_DIGEST")
};
const requestDigest = digest(request);
const response = await fetch(serviceUrl, {
  method: "POST",
  headers: {
    authorization: `Bearer ${oidcValue.value}`,
    "content-type": "application/json"
  },
  body: canonicalJson(request)
});
if (!response.ok) {
  throw new TypeError(`trusted delivery service failed with ${response.status}`);
}
const receipt = (await response.json()) as {
  readonly status?: unknown;
  readonly requestDigest?: unknown;
};
if (receipt.status !== "delivered" || receipt.requestDigest !== requestDigest) {
  throw new TypeError("trusted delivery service returned an invalid delivery receipt");
}
