/**
 * Runtime validation against the canonical CommonGrants JSON Schema bundle.
 *
 * The published schemas are one YAML file per model, cross-referenced by
 * filename (`$ref: Money.yaml`). This module walks those references from a root
 * schema, loads every file reachable from it, and compiles the result with Ajv
 * (draft 2020-12, which the bundle's `unevaluatedProperties` assertions need).
 *
 * Schemas come from a local directory when `CG_SCHEMA_DIR` is set, falling back
 * to the vendored bundle in `data/schemas/` when present, and to commongrants.org
 * otherwise.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import addFormatsExport from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import YAML from "yaml";

// ajv-formats ships as CommonJS: `module.exports` is the plugin function and it
// also carries a `default` alias. Node's ESM interop can hand back either one.
const addFormats =
  (addFormatsExport as unknown as { default?: FormatsPlugin }).default ??
  (addFormatsExport as unknown as FormatsPlugin);
import type { Config } from "../config.js";

type JsonSchema = Record<string, unknown>;

/** Collects every `Foo.yaml` reference in a schema, at any depth. */
function collectRefs(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node)) {
    if (
      key === "$ref" &&
      typeof value === "string" &&
      value.endsWith(".yaml")
    ) {
      into.add(value);
    } else {
      collectRefs(value, into);
    }
  }
}

function createReader(config: Config): (name: string) => Promise<string> {
  const dir = config.schemaDir;
  if (dir) {
    return async (name) => fs.readFile(path.join(dir, name), "utf8");
  }
  return async (name) => {
    const url = `${config.schemaBaseUrl.replace(/\/$/, "")}/${name}`;
    const response = await fetch(url, {
      headers: { Accept: "text/yaml, application/yaml, */*" },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to fetch schema ${url}: ${response.status} ${response.statusText}`,
      );
    }
    return response.text();
  };
}

/** Loads a root schema and everything it references, keyed by filename. */
async function loadSchemaBundle(
  config: Config,
  rootName: string,
): Promise<Map<string, JsonSchema>> {
  const read = createReader(config);
  const bundle = new Map<string, JsonSchema>();
  const queue = [rootName];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (bundle.has(name)) continue;

    const parsed = YAML.parse(await read(name)) as JsonSchema | null;
    if (!parsed) throw new Error(`Schema ${name} is empty`);
    bundle.set(name, parsed);

    const refs = new Set<string>();
    collectRefs(parsed, refs);
    for (const ref of refs) if (!bundle.has(ref)) queue.push(ref);
  }

  return bundle;
}

export interface ValidationFailure {
  /** Index of the record in the validated array. */
  index: number;
  /** The record's award id, for cross-referencing the output file. */
  id: string | undefined;
  errors: string[];
}

export interface ValidationOutcome {
  /** Errors the record should not have. */
  errors: string[];
  /** Errors attributable to a documented gap in the published schema. */
  knownGaps: string[];
}

export interface Validator {
  /** Validates one record, splitting real errors from known schema gaps. */
  validate(record: unknown): ValidationOutcome;
}

export interface ValidationSummary {
  /** Records with errors that need attention. */
  failures: ValidationFailure[];
  /** Records whose only errors come from a known schema gap. */
  knownGaps: ValidationFailure[];
}

export interface ValidatorOptions {
  /**
   * Instance paths whose errors are expected, because the published schema does
   * not describe the shape yet. An error at one of these paths, or beneath one,
   * is reported as a known gap instead of a failure.
   */
  knownGapPaths?: readonly string[];
}

function isKnownGap(
  instancePath: string,
  knownGapPaths: readonly string[],
): boolean {
  return knownGapPaths.some(
    (prefix) =>
      instancePath === prefix || instancePath.startsWith(`${prefix}/`),
  );
}

/** Compiles a validator for a CommonGrants model (e.g. `AwardBase`). */
export async function createValidator(
  config: Config,
  model = "AwardBase",
  options: ValidatorOptions = {},
): Promise<Validator> {
  const knownGapPaths = options.knownGapPaths ?? [];
  const rootName = `${model}.yaml`;
  const bundle = await loadSchemaBundle(config, rootName);

  // `strict: false` because the bundle carries annotation keywords Ajv would
  // otherwise flag (descriptions alongside `$ref`, for instance).
  const ajv = new Ajv2020({
    strict: false,
    allErrors: true,
    validateFormats: true,
  });
  addFormats(ajv);

  for (const [name, schema] of bundle) {
    if (name === rootName) continue;
    ajv.addSchema(schema, name);
  }

  const validateFn = ajv.compile(bundle.get(rootName) as JsonSchema);

  return {
    validate(record) {
      if (validateFn(record)) return { errors: [], knownGaps: [] };

      const outcome: ValidationOutcome = { errors: [], knownGaps: [] };
      for (const error of validateFn.errors ?? ([] as ErrorObject[])) {
        const location = error.instancePath || "(root)";
        const message = `${location} ${error.message ?? "is invalid"}`;
        if (isKnownGap(error.instancePath, knownGapPaths))
          outcome.knownGaps.push(message);
        else outcome.errors.push(message);
      }
      return outcome;
    },
  };
}

/** Validates an array of records, splitting failures from known schema gaps. */
export function validateAll(
  validator: Validator,
  records: readonly unknown[],
): ValidationSummary {
  const summary: ValidationSummary = { failures: [], knownGaps: [] };

  records.forEach((record, index) => {
    const { errors, knownGaps } = validator.validate(record);
    const id = (record as { id?: unknown } | null)?.id;
    const identity = { index, id: typeof id === "string" ? id : undefined };

    if (errors.length > 0) summary.failures.push({ ...identity, errors });
    if (knownGaps.length > 0)
      summary.knownGaps.push({ ...identity, errors: knownGaps });
  });

  return summary;
}
