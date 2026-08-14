/**
 * CLI entry point.
 *
 *   pnpm fetch:candidates   Stage 1 only. Samples USAspending assistance awards
 *                           and reports how many carry a usable funding
 *                           opportunity number. Needs no API key, and rewrites
 *                           the tracked data/usaspending-candidates.json.
 *
 *   pnpm build:awards       Full pipeline. Reuses stage 1 output when present,
 *                           resolves each opportunity number against
 *                           Simpler.Grants.gov, joins, filters, transforms to
 *                           CommonGrants AwardBase, and validates.
 *
 *   pnpm validate:awards    Re-validates out/awards.json, falling back to the
 *                           committed data/awards.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "./config.js";
import {
  collectCandidates,
  CandidateSetSchema,
  type CandidateSet,
} from "./fetch/usaspending.js";
import { createOpportunityResolver } from "./fetch/sgg.js";
import { joinAwardsToOpportunities } from "./transform/join.js";
import { toAwardBase } from "./transform/award.js";
import {
  createValidator,
  validateAll,
  type ValidationFailure,
} from "./transform/validate.js";
import type { AwardBase } from "./transform/award-types.js";

const CANDIDATES_FILE = "usaspending-candidates.json";
const AWARDS_FILE = "awards.json";
const REPORT_FILE = "report.json";

/** `OppRef` has no `identifiers` property yet, so errors here are expected when
 * opportunity identifiers are emitted. */
const OPPORTUNITY_IDENTIFIERS_PATH = "/opportunity/identifiers";

/**
 * Builds a validator that tolerates the documented gaps the records exercise.
 *
 * The gap paths come from the records themselves rather than from config, so
 * `validate` on an existing file does not need to be told which mode produced it.
 */
function validatorFor(config: Config, records: readonly unknown[]) {
  const emitsOpportunityIdentifiers = records.some(
    (record) =>
      (record as { opportunity?: { identifiers?: unknown } } | null)
        ?.opportunity?.identifiers !== undefined,
  );

  return createValidator(config, "AwardBase", {
    knownGapPaths: emitsOpportunityIdentifiers
      ? [OPPORTUNITY_IDENTIFIERS_PATH]
      : [],
  });
}

function printFailures(
  label: string,
  failures: ValidationFailure[],
  limit = Infinity,
): void {
  console.log(`  ${label}`);
  for (const failure of failures.slice(0, limit)) {
    console.log(`    [${failure.index}] ${failure.id ?? "(no id)"}`);
    for (const message of failure.errors.slice(0, 5))
      console.log(`      ${message}`);
  }
}

/**
 * Round-trips records through JSON to get the exact representation that lands on
 * disk.
 *
 * Date-bearing fields hold `Date` values in memory and only become protocol
 * strings through `toJSON`, so validating the in-memory objects would check a
 * shape no consumer ever sees. Validating the serialized form checks what is
 * actually written.
 */
function toWire<T>(records: readonly T[]): unknown[] {
  return JSON.parse(JSON.stringify(records)) as unknown[];
}

async function writeJson(
  dir: string,
  name: string,
  value: unknown,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, name);
  await fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return target;
}

async function readJson<T>(dir: string, name: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// =============================================================================
// Stage 1: USAspending candidates
// =============================================================================

async function fetchCandidates(config: Config): Promise<CandidateSet> {
  console.log(
    `Sampling USAspending awards across ${config.agencies.length} agencies`,
  );
  console.log(
    `  action dates ${config.timePeriod.startDate} to ${config.timePeriod.endDate}, ` +
      `types ${config.awardTypeCodes.join("/")}`,
  );

  const candidates = await collectCandidates(config);
  const withNumber = candidates.withOpportunityNumber.length;
  const total = candidates.all.length;
  const share = total > 0 ? Math.round((withNumber / total) * 100) : 0;

  console.log(`  fetched ${total} award records`);
  console.log(
    `  ${withNumber} carry a usable funding opportunity number (${share}%)`,
  );
  console.log(
    `  ${candidates.opportunityNumbers.length} distinct opportunity numbers`,
  );

  const target = await writeJson(config.dataDir, CANDIDATES_FILE, candidates);
  console.log(`  wrote ${target}`);
  return candidates;
}

async function loadCandidates(config: Config): Promise<CandidateSet> {
  if (process.env.REFRESH_CANDIDATES === "1") return fetchCandidates(config);

  const snapshotPath = path.join(config.dataDir, CANDIDATES_FILE);
  const raw = await readJson<unknown>(config.dataDir, CANDIDATES_FILE);
  if (raw !== undefined) {
    let cached: CandidateSet;
    try {
      cached = CandidateSetSchema.parse(raw);
    } catch (error) {
      throw new Error(
        `${snapshotPath} does not match the expected shape: ${(error as Error).message}`,
      );
    }
    console.log(
      `Reusing ${snapshotPath} ` +
        `(${cached.withOpportunityNumber.length} candidates, ` +
        `${cached.opportunityNumbers.length} distinct numbers)`,
    );
    console.log("  set REFRESH_CANDIDATES=1 to re-sample USAspending");
    return cached;
  }
  return fetchCandidates(config);
}

// =============================================================================
// Stage 2: join, transform, validate
// =============================================================================

async function build(config: Config): Promise<boolean> {
  const candidates = await loadCandidates(config);

  if (!config.sggApiKey) {
    console.log(
      "\nSGG_API_KEY is not set; opportunity lookups will come from cache only.",
    );
  }

  console.log(
    `\nResolving ${candidates.opportunityNumbers.length} opportunity numbers against ${config.sggBaseUrl}`,
  );
  const resolver = createOpportunityResolver(config);
  const join = await joinAwardsToOpportunities(
    candidates,
    resolver,
    config.targetAwardCount,
  );

  console.log(`  matched:   ${join.matchedNumbers.length} opportunity numbers`);
  console.log(
    `  unmatched: ${join.unmatchedNumbers.length} opportunity numbers`,
  );
  console.log(
    `  ${join.matchedAwardCount} awards joined` +
      (join.selected.length < join.matchedAwardCount
        ? `, ${join.selected.length} emitted (TARGET_AWARD_COUNT=${config.targetAwardCount})`
        : ", all emitted"),
  );

  // The reference date the records are derived against, which AS_OF can pin.
  // Distinct from when the run happened; the report records both.
  const fetchedAt = config.asOf;
  const awards: AwardBase[] = join.selected.map((pair) =>
    toAwardBase(pair.award, pair.opportunity, {
      fetchedAt,
      opportunityIdentifiers: config.opportunityIdentifiers,
    }),
  );

  console.log(`\nValidating ${awards.length} records against AwardBase`);
  const wire = toWire(awards);
  const validator = await validatorFor(config, wire);
  const { failures, knownGaps } = validateAll(validator, wire);

  if (failures.length === 0) console.log("  no unexpected errors");
  else printFailures(`${failures.length} invalid record(s):`, failures, 10);

  if (knownGaps.length > 0) {
    console.log(
      `  ${knownGaps.length} record(s) exercise a known schema gap at ${OPPORTUNITY_IDENTIFIERS_PATH}`,
    );
    console.log(
      "    OppRef has no identifiers property yet; set OPPORTUNITY_IDENTIFIERS=omit to drop them",
    );
  }

  const awardsPath = await writeJson(config.outDir, AWARDS_FILE, awards);
  const reportPath = await writeJson(config.outDir, REPORT_FILE, {
    generatedAt: new Date().toISOString(),
    asOf: fetchedAt.toISOString(),
    source: {
      usaSpending: {
        baseUrl: config.usaSpendingBaseUrl,
        agencies: config.agencies,
        awardTypeCodes: config.awardTypeCodes,
        timePeriod: config.timePeriod,
      },
      simplerGrantsGov: { baseUrl: config.sggBaseUrl },
    },
    options: {
      opportunityIdentifiers: config.opportunityIdentifiers,
      targetAwardCount: config.targetAwardCount ?? null,
    },
    funnel: {
      awardsFetched: candidates.all.length,
      awardsWithOpportunityNumber: candidates.withOpportunityNumber.length,
      distinctOpportunityNumbers: candidates.opportunityNumbers.length,
      matchedOpportunityNumbers: join.matchedNumbers.length,
      awardsJoined: join.matchedAwardCount,
      awardsEmitted: awards.length,
      awardsDroppedByCap: join.matchedAwardCount - awards.length,
    },
    matchedNumbers: join.matchedNumbers,
    unmatchedNumbers: join.unmatchedNumbers,
    validationFailures: failures,
    knownSchemaGaps: knownGaps,
  });

  console.log(`\nWrote ${awardsPath}`);
  console.log(`Wrote ${reportPath}`);
  return failures.length === 0;
}

// =============================================================================
// Standalone validation
// =============================================================================

async function validate(config: Config): Promise<boolean> {
  // Falls back to the committed reference output so a fresh clone can validate
  // before its first build.
  let awards = await readJson<unknown[]>(config.outDir, AWARDS_FILE);
  let source = path.join(config.outDir, AWARDS_FILE);
  if (!awards) {
    awards = await readJson<unknown[]>(config.dataDir, AWARDS_FILE);
    source = path.join(config.dataDir, AWARDS_FILE);
  }
  if (!awards) {
    console.error(
      `No awards to validate at ${path.join(config.outDir, AWARDS_FILE)} or ` +
        `${path.join(config.dataDir, AWARDS_FILE)}; run pnpm build:awards`,
    );
    return false;
  }

  const validator = await validatorFor(config, awards);
  const { failures, knownGaps } = validateAll(validator, awards);

  console.log(
    `Validated ${awards.length} records from ${source} against AwardBase`,
  );
  if (knownGaps.length > 0) {
    printFailures(
      `${knownGaps.length} record(s) exercise a known schema gap:`,
      knownGaps,
      1,
    );
  }
  if (failures.length === 0) {
    console.log("  no unexpected errors");
    return true;
  }
  printFailures(`${failures.length} invalid record(s):`, failures);
  return false;
}

// =============================================================================
// Dispatch
// =============================================================================

async function main(): Promise<boolean> {
  const config = loadConfig();
  const command = process.argv[2] ?? "build";

  switch (command) {
    case "fetch-candidates":
      await fetchCandidates(config);
      return true;
    case "build":
      return build(config);
    case "validate":
      return validate(config);
    default:
      console.error(
        `Unknown command "${command}". Use fetch-candidates, build, or validate.`,
      );
      return false;
  }
}

void main()
  .then((ok) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
