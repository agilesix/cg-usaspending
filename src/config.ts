/**
 * Runtime configuration, read from the environment with sensible defaults.
 *
 * Every value has a default except `SGG_API_KEY`, which the caller must supply
 * to resolve funding opportunity numbers against Simpler.Grants.gov.
 */

import fs from "node:fs";
import path from "node:path";

/** Awarding agencies to sample USAspending candidates from.
 *
 * These are the toptier agency names USAspending recognizes. The default list is
 * limited to agencies that actually populate `funding_opportunity_number` with a
 * posted opportunity number; DOT, USDA, and HUD report `NOT APPLICABLE` on
 * effectively every assistance award and would only add candidates that get
 * filtered out.
 */
const DEFAULT_AGENCIES = [
  "Department of Health and Human Services",
  "Department of Education",
  "Environmental Protection Agency",
  "Department of Justice",
  "Department of the Interior",
  "National Science Foundation",
  "Department of Energy",
];

/** USAspending assistance award type codes.
 *
 * 02 = block grant, 03 = formula grant, 04 = project grant, 05 = cooperative
 * agreement. These are the four types the GSDM requires a funding opportunity
 * number for.
 */
const DEFAULT_AWARD_TYPE_CODES = ["02", "03", "04", "05"];

export interface Config {
  /** Base URL of the Simpler.Grants.gov CommonGrants API. */
  sggBaseUrl: string;
  /** Simpler.Grants.gov API key. Undefined means opportunity lookups must come from cache. */
  sggApiKey: string | undefined;
  /** Header the API key is sent in. */
  sggAuthHeader: string;
  /** Base URL of the USAspending API. */
  usaSpendingBaseUrl: string;
  /** Toptier awarding agency names to sample from. */
  agencies: string[];
  /** USAspending assistance award type codes to include. */
  awardTypeCodes: string[];
  /** Action-date window for the USAspending award search. */
  timePeriod: { startDate: string; endDate: string };
  /** Awards to pull per agency, per sort order. */
  candidatesPerAgency: number;
  /** Optional cap on how many joined awards to emit. Undefined emits all of them. */
  targetAwardCount: number | undefined;
  /** Max concurrent HTTP requests per upstream API. */
  concurrency: number;
  /**
   * Whether to emit opportunity-scoped identifiers on `opportunity.identifiers`.
   *
   * `opp:us:fon` and `opp:us:aln` describe the opportunity, not the award, so
   * that is where they belong. `OppRef` does not specify an `identifiers`
   * property yet, and it closes itself with `unevaluatedProperties: {not: {}}`,
   * so emitting them fails validation on purpose. Set to `include` to produce
   * the shape the protocol is expected to grow into; the validator reports the
   * resulting error as a known gap rather than a failure.
   */
  opportunityIdentifiers: "include" | "omit";
  /** Local directory holding the CommonGrants YAML schema bundle, if available. */
  schemaDir: string | undefined;
  /** Base URL to fetch the schema bundle from when no local directory is set. */
  schemaBaseUrl: string;
  /** Directory holding the tracked input snapshots (candidates, opportunity cache, schemas). */
  dataDir: string;
  /** Directory for generated output. */
  outDir: string;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

/** Reads an optional positive integer. Unset means no value, not zero. */
function optionalInt(name: string): number | undefined {
  return process.env[name] ? int(name, 0) : undefined;
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0)
    throw new Error(`${name} was set but contained no values`);
  return items;
}

function opportunityIdentifiersMode(): "include" | "omit" {
  const raw = process.env.OPPORTUNITY_IDENTIFIERS ?? "omit";
  if (raw !== "include" && raw !== "omit") {
    throw new Error(
      `OPPORTUNITY_IDENTIFIERS must be "include" or "omit", got "${raw}"`,
    );
  }
  return raw;
}

export function loadConfig(): Config {
  const root = process.cwd();
  const dataDir = process.env.DATA_DIR ?? path.join(root, "data");
  const vendoredSchemas = path.join(dataDir, "schemas");
  return {
    sggBaseUrl: process.env.SGG_BASE_URL ?? "https://api.simpler.grants.gov",
    sggApiKey: process.env.SGG_API_KEY,
    sggAuthHeader: process.env.SGG_AUTH_HEADER ?? "X-API-Key",
    usaSpendingBaseUrl:
      process.env.USASPENDING_BASE_URL ?? "https://api.usaspending.gov",
    agencies: list("USASPENDING_AGENCIES", DEFAULT_AGENCIES),
    awardTypeCodes: list(
      "USASPENDING_AWARD_TYPE_CODES",
      DEFAULT_AWARD_TYPE_CODES,
    ),
    timePeriod: {
      startDate: process.env.USASPENDING_START_DATE ?? "2024-10-01",
      endDate: process.env.USASPENDING_END_DATE ?? "2025-09-30",
    },
    candidatesPerAgency: int("CANDIDATES_PER_AGENCY", 15),
    targetAwardCount: optionalInt("TARGET_AWARD_COUNT"),
    concurrency: int("CONCURRENCY", 8),
    opportunityIdentifiers: opportunityIdentifiersMode(),
    schemaDir:
      process.env.CG_SCHEMA_DIR ??
      (fs.existsSync(vendoredSchemas) ? vendoredSchemas : undefined),
    schemaBaseUrl:
      process.env.CG_SCHEMA_BASE_URL ?? "https://commongrants.org/schemas/yaml",
    dataDir,
    outDir: process.env.OUT_DIR ?? path.join(root, "out"),
  };
}
