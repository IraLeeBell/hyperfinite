#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

import schema from "../schemas/v1alpha1/behavioral-eval-fixture.schema.json" with { type: "json" };
import recordSchema from "../schemas/v1alpha1/behavioral-eval-record.schema.json" with { type: "json" };

const directory = path.resolve("tests/evals/fixtures");
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate: ValidateFunction = ajv.compile(schema);
ajv.compile(recordSchema);
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".json"))
  .sort();
const errors: string[] = [];
const identities = new Set<string>();

for (const file of files) {
  const value = JSON.parse(
    await readFile(path.join(directory, file), "utf8")
  ) as unknown;
  if (!validate(value)) {
    errors.push(
      ...((validate.errors ?? []) as readonly ErrorObject[]).map(
        (error) => `${file}${error.instancePath}: ${error.message ?? "invalid"}`
      )
    );
    continue;
  }
  const id = (value as { readonly id: string }).id;
  if (identities.has(id)) errors.push(`duplicate fixture id ${id}`);
  identities.add(id);
}

const required = [
  "role-adherence",
  "skill-activation",
  "evidence-quality",
  "authority-refusal",
  "escalation"
];
for (const id of required) {
  if (!identities.has(id)) errors.push(`missing required behavioral fixture ${id}`);
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(`Validated ${files.length} behavioral evaluation fixtures.`);
}
