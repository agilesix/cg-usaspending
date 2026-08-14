/**
 * Simpler.Grants.gov opportunity lookup, via the CommonGrants SDK and the
 * Grants.gov plugin.
 *
 * The plugin binds its Opportunity schema and its registered search filters, so
 * `customFields.federalOpportunityNumber` comes back typed and validated. That
 * field is the join key: USAspending reports the same value in
 * `funding_opportunity.number`.
 *
 * The CommonGrants search API has no filter for the opportunity number, so each
 * lookup is a free-text search followed by an exact match on the parsed custom
 * field. Text search can return near matches (a number that merely appears in a
 * description, or a sibling number sharing a prefix), so the match is always
 * confirmed against `federalOpportunityNumber` rather than trusted from ranking.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Auth } from "@common-grants/sdk/client";
import plugin from "@common-grants/cg-grants-gov";
import type { Config } from "../config.js";

type Opportunity = z.infer<typeof plugin.schemas.Opportunity.commonSchema>;

/** The subset of an opportunity this script keeps for the join and the output. */
export interface ResolvedOpportunity {
  /** The opportunity's CommonGrants UUID. */
  id: string;
  title: string;
  /** The federal opportunity number that matched, as reported by Simpler.Grants.gov. */
  federalOpportunityNumber: string;
  status?: string;
  agencyCode?: string | null;
  agencyName?: string | null;
}

export interface OpportunityResolver {
  /** Returns the matching opportunity, or null when Simpler.Grants.gov has none. */
  resolve(
    federalOpportunityNumber: string,
  ): Promise<ResolvedOpportunity | null>;
  /** Persists anything the resolver learned during the run. */
  flush(): Promise<void>;
}

// =============================================================================
// Matching
// =============================================================================

/** Compares opportunity numbers the way the two systems disagree in practice:
 * surrounding whitespace and letter case vary, everything else must be equal. */
function sameNumber(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function toResolved(
  opportunity: Opportunity,
  matchedNumber: string,
): ResolvedOpportunity {
  const agency = opportunity.customFields?.agency?.value;
  return {
    id: opportunity.id,
    title: opportunity.title,
    federalOpportunityNumber: matchedNumber,
    status: opportunity.status?.value,
    agencyCode: agency?.code,
    agencyName: agency?.name,
  };
}

// =============================================================================
// Live resolver
// =============================================================================

/** How many search hits to scan for an exact opportunity-number match. */
const SEARCH_PAGE_SIZE = 25;

function createLiveResolver(config: Config): OpportunityResolver {
  if (!config.sggApiKey) {
    throw new Error("SGG_API_KEY is required to look up opportunities");
  }

  const client = plugin.getClient({
    baseUrl: config.sggBaseUrl,
    auth: Auth.apiKey(config.sggApiKey, config.sggAuthHeader),
  });

  return {
    async resolve(federalOpportunityNumber) {
      const result = await client.opportunities.search({
        query: federalOpportunityNumber,
        page: 1,
        pageSize: SEARCH_PAGE_SIZE,
      });

      for (const item of result.items) {
        const reported = item.customFields?.federalOpportunityNumber?.value;
        if (
          typeof reported === "string" &&
          sameNumber(reported, federalOpportunityNumber)
        ) {
          return toResolved(item, reported);
        }
      }
      return null;
    },
    async flush() {},
  };
}

// =============================================================================
// Caching wrapper
// =============================================================================

const CacheFileSchema = z.record(
  z.string(),
  z.union([
    z.object({
      id: z.string(),
      title: z.string(),
      federalOpportunityNumber: z.string(),
      status: z.string().optional(),
      agencyCode: z.string().nullish(),
      agencyName: z.string().nullish(),
    }),
    z.null(),
  ]),
);

type CacheFile = z.infer<typeof CacheFileSchema>;

async function readCache(cachePath: string): Promise<CacheFile> {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return CacheFileSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Wraps a resolver with a file-backed cache, keyed by opportunity number.
 *
 * Misses are cached too. A number that Simpler.Grants.gov does not have (an
 * agency-internal tracking code, for instance) would otherwise cost a search on
 * every run, and the negative result is just as stable as a positive one.
 */
function withCache(
  inner: OpportunityResolver | null,
  cachePath: string,
): OpportunityResolver {
  let cache: CacheFile | undefined;
  let dirty = false;

  return {
    async resolve(federalOpportunityNumber) {
      cache ??= await readCache(cachePath);

      if (federalOpportunityNumber in cache) {
        return cache[federalOpportunityNumber] ?? null;
      }
      if (!inner) {
        throw new Error(
          `No cached lookup for opportunity number "${federalOpportunityNumber}" and no ` +
            `SGG_API_KEY to fetch it. Set SGG_API_KEY, or point DATA_DIR at a directory ` +
            `whose opportunity-cache.json covers every candidate.`,
        );
      }

      const resolved = await inner.resolve(federalOpportunityNumber);
      cache[federalOpportunityNumber] = resolved;
      dirty = true;
      return resolved;
    },

    async flush() {
      if (!dirty || !cache) return;
      await fs.mkdir(path.dirname(cachePath), { recursive: true });
      const ordered = Object.fromEntries(
        Object.entries(cache).sort(([a], [b]) => a.localeCompare(b)),
      );
      await fs.writeFile(
        cachePath,
        `${JSON.stringify(ordered, null, 2)}\n`,
        "utf8",
      );
      dirty = false;
    },
  };
}

/**
 * Builds the resolver for a run.
 *
 * With an API key, lookups hit Simpler.Grants.gov and are cached. Without one,
 * the run proceeds from cache alone and fails on the first uncached number.
 */
export function createOpportunityResolver(config: Config): OpportunityResolver {
  const cachePath = path.join(config.dataDir, "opportunity-cache.json");
  const live = config.sggApiKey ? createLiveResolver(config) : null;
  return withCache(live, cachePath);
}
