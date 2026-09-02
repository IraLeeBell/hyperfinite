#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction
} from "ajv/dist/2020.js";

import recordSchema from "../schemas/v1alpha1/behavioral-eval-record.schema.json" with { type: "json" };

interface EvaluationRecord {
  readonly fixtureId: string;
  readonly evaluator: "independent-human" | "independent-model";
  readonly subjectModel: string;
  readonly evaluatorModel: string | null;
  readonly criteria: readonly {
    readonly criterion: string;
    readonly passed: boolean;
    readonly evidence: string;
  }[];
  readonly forbiddenAssessed: readonly string[];
  readonly forbiddenObserved: readonly string[];
}

interface EvaluationFixture {
  readonly id: string;
  readonly criteria: readonly string[];
  readonly forbidden: readonly string[];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const actual = [...new Set(left)].sort();
  const expected = [...new Set(right)].sort();
  return (
    actual.length === left.length &&
    expected.length === right.length &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

const argument = process.argv.find((value) => value.startsWith("--responses-dir="));
if (argument === undefined) {
  throw new TypeError(
    "manual behavioral evaluation requires --responses-dir=<reviewed-response-records>; this command never starts paid inference"
  );
}
const directory = path.resolve(argument.slice("--responses-dir=".length));
const fixtureDirectory = path.resolve("tests/evals/fixtures");
const files = (await readdir(directory))
  .filter((file) => file.endsWith(".json"))
  .sort();
if (files.length === 0) {
  throw new TypeError("no reviewed behavioral response records were supplied");
}
const fixtures = new Map(
  await Promise.all(
    (await readdir(fixtureDirectory))
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const fixture = JSON.parse(
          await readFile(path.join(fixtureDirectory, file), "utf8")
        ) as EvaluationFixture;
        return [fixture.id, fixture] as const;
      })
  )
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate: ValidateFunction = ajv.compile(recordSchema);

let failed = 0;
const evaluated = new Set<string>();
for (const file of files) {
  const value = JSON.parse(
    await readFile(path.join(directory, file), "utf8")
  ) as unknown;
  if (!validate(value)) {
    for (const error of (validate.errors ?? []) as readonly ErrorObject[]) {
      console.error(
        `FAIL ${file}${error.instancePath}: ${error.message ?? "invalid"}`
      );
    }
    failed += 1;
    continue;
  }
  const record = value as EvaluationRecord;
  const fixture = fixtures.get(record.fixtureId);
  if (fixture === undefined) {
    console.error(`FAIL ${file}: unknown fixture ${record.fixtureId}`);
    failed += 1;
    continue;
  }
  if (evaluated.has(record.fixtureId)) {
    console.error(`FAIL ${file}: duplicate fixture record ${record.fixtureId}`);
    failed += 1;
    continue;
  }
  evaluated.add(record.fixtureId);
  if (
    record.evaluator === "independent-model" &&
    record.evaluatorModel === record.subjectModel
  ) {
    throw new TypeError(`${file} is not an independent model evaluation`);
  }
  const criteriaMatch = sameSet(
    record.criteria.map((criterion) => criterion.criterion),
    fixture.criteria
  );
  const forbiddenMatch = sameSet(record.forbiddenAssessed, fixture.forbidden);
  const observedDeclared = record.forbiddenObserved.every((item) =>
    fixture.forbidden.includes(item)
  );
  const passed =
    criteriaMatch &&
    forbiddenMatch &&
    observedDeclared &&
    record.criteria.length > 0 &&
    record.criteria.every(
      (criterion) => criterion.passed && criterion.evidence.trim().length > 0
    ) &&
    record.forbiddenObserved.length === 0;
  if (!passed) failed += 1;
  console.log(`${passed ? "PASS" : "FAIL"} ${record.fixtureId} (${record.evaluator})`);
}
for (const fixtureId of fixtures.keys()) {
  if (!evaluated.has(fixtureId)) {
    console.error(`FAIL missing reviewed response for ${fixtureId}`);
    failed += 1;
  }
}
if (failed > 0) process.exitCode = 1;
