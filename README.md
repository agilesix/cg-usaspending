# sgg-usaspending-awards

Standalone script that joins Simpler.Grants.gov opportunities to USAspending
assistance awards and emits every match as a [CommonGrants
`AwardBase`](https://commongrants.org/protocol/models/award/) record.

The join key is the federal funding opportunity number. USAspending reports it on
assistance awards as `funding_opportunity.number`, and the Grants.gov plugin
exposes the same value on an opportunity as
`customFields.federalOpportunityNumber`.

The repo ships with static snapshots of both datasets under `data/`, so the
default run is offline: no API keys, no network. The committed `data/awards.json`
is the reference output, and `pnpm check:reference` rebuilds it offline and
confirms the result is byte for byte identical. Live API access is only needed to
refresh the snapshots.

## Install

```bash
pnpm install
```

## Configuration

Every value has a default. `SGG_API_KEY` is only needed when refreshing the
snapshots against the live APIs.

| Variable                       | Default                                 | Purpose                                                                                         |
| ------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `SGG_API_KEY`                  | (none)                                  | Simpler.Grants.gov API key. Only needed for opportunity numbers not already in the committed cache. |
| `SGG_BASE_URL`                 | `https://api.simpler.grants.gov`        | Simpler.Grants.gov CommonGrants API.                                                            |
| `SGG_AUTH_HEADER`              | `X-API-Key`                             | Header the API key is sent in. Set to `X-Auth` if the key is rejected.                          |
| `USASPENDING_BASE_URL`         | `https://api.usaspending.gov`           | USAspending API. Needs no key.                                                                  |
| `USASPENDING_AGENCIES`         | 7 agencies (see below)                  | Comma-separated toptier awarding agency names.                                                  |
| `USASPENDING_AWARD_TYPE_CODES` | `02,03,04,05`                           | Assistance award types (block, formula, project, cooperative agreement).                        |
| `USASPENDING_START_DATE`       | `2024-10-01`                            | Start of the action-date window.                                                                |
| `USASPENDING_END_DATE`         | `2025-09-30`                            | End of the action-date window.                                                                  |
| `CANDIDATES_PER_AGENCY`        | `15`                                    | Awards pulled per agency, per sort order (two orders are used).                                 |
| `TARGET_AWARD_COUNT`           | unset                                   | Optional cap on emitted awards. Unset emits every joined award.                                 |
| `CONCURRENCY`                  | `8`                                     | Max in-flight requests to USAspending.                                                          |
| `OPPORTUNITY_IDENTIFIERS`      | `omit`                                  | `include` to emit `opportunity.identifiers`, which the current schema rejects. See below.       |
| `REFRESH_CANDIDATES`           | unset                                   | Set to `1` to re-sample USAspending instead of reusing stage 1 output.                          |
| `CG_SCHEMA_DIR`                | `./data/schemas` when present           | Local CommonGrants YAML schema directory. Schemas are fetched from commongrants.org when neither is available. |
| `CG_SCHEMA_BASE_URL`           | `https://commongrants.org/schemas/yaml` | Where to fetch schemas from.                                                                    |
| `DATA_DIR`                     | `./data`                                | Tracked input snapshots: candidates, opportunity cache, vendored schemas.                       |
| `OUT_DIR`                      | `./out`                                 | Output directory.                                                                               |
| `AS_OF`                        | now                                     | Date the run treats as "now" for award status. Pin it to reproduce a snapshot. See below.       |

The default agency list is HHS, Education, EPA, Justice, Interior, NSF, and
Energy. DOT, USDA, and HUD are left out because they report `NOT APPLICABLE` for
the opportunity number on effectively every assistance award, so they only
contribute candidates that get filtered back out.

## Run

```bash
pnpm build:awards
```

That is the whole run: the pipeline reads the committed snapshots, joins,
transforms, validates, and writes `out/awards.json`. No keys, no network.

To refresh the snapshots against the live APIs:

```bash
export SGG_API_KEY="your-api-key"
REFRESH_CANDIDATES=1 pnpm build:awards
```

Re-sampling rewrites `data/usaspending-candidates.json` and adds any new
opportunity-number lookups to `data/opportunity-cache.json`, so a refresh shows
up as a reviewable git diff.

Four commands are available:

- `pnpm fetch:candidates` runs stage 1 only. It samples USAspending and reports
  how many awards carry a usable opportunity number. No API key needed, but it
  goes to the network and rewrites `data/usaspending-candidates.json`, so the
  refreshed snapshot shows up as a git diff the same way `REFRESH_CANDIDATES=1`
  does.
- `pnpm build:awards` runs the full pipeline. It reuses the committed stage 1
  snapshot, resolves opportunity numbers, joins, filters, transforms, and
  validates.
- `pnpm validate:awards` re-validates `out/awards.json`, falling back to the
  committed `data/awards.json`.
- `pnpm check:reference` rebuilds offline with `AS_OF` pinned to the snapshot
  date and compares the result to `data/awards.json`, so the reference output
  cannot drift from what the code and inputs actually produce.

### Award status and `AS_OF`

An award's `status` is derived by comparing its period of performance against a
reference date, which defaults to the moment the run happens. That is what a live
run wants, and it means an unpinned rebuild of a fixed snapshot legitimately
changes over time: every award whose period of performance has since ended moves
from `awarded` to `completed`.

So reproducing `data/awards.json` means pinning the reference date to the day the
snapshot was taken, which is what `AS_OF` is for and what `pnpm check:reference`
does. Refreshing the snapshots means bumping the pinned date in that script
alongside the regenerated data.

Tracked inputs live in `data/`:

| File                          | Contents                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `usaspending-candidates.json` | Raw USAspending award records from stage 1.                                     |
| `opportunity-cache.json`      | Opportunity number to opportunity, including confirmed misses.                  |
| `awards.json`                 | Committed reference output; `pnpm check:reference` proves a rebuild matches it. |
| `schemas/`                    | Vendored CommonGrants v0.4.0 YAML schema bundle, everything `AwardBase` needs.  |

Generated output lands in `out/`:

| File          | Contents                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `awards.json` | The sample of CommonGrants `AwardBase` records.                                                                               |
| `report.json` | Run metadata, the stage-by-stage funnel, which opportunity numbers matched, and any validation failures or known schema gaps. |

Lookups are cached by opportunity number, misses included. A number that
Simpler.Grants.gov does not have is a stable fact, so caching it keeps repeat
runs from re-searching for it. Once the cache covers every candidate, the
pipeline runs without an API key.

## How the pipeline works

**Stage 1, sample USAspending.** The USAspending search endpoint neither filters
on the opportunity number nor returns it as a field. It only appears on the
per-award detail response. So there is no way to query awards by opportunity
number; the script pages through awards and reads each detail record. Awards
whose opportunity number is missing, or is one of the placeholder values
agencies submit in its place (`NOT APPLICABLE`, `N/A`, and similar), are dropped
here.

**Stage 2, resolve against Simpler.Grants.gov.** The CommonGrants search API has
no filter for the opportunity number either, so each distinct number becomes a
free-text search. Text search returns near matches, so a hit only counts when the
opportunity's own `federalOpportunityNumber` equals the number being looked up,
compared case-insensitively after trimming.

**Stage 3, join.** Every award whose opportunity number resolved is emitted. One
opportunity can account for dozens of awards, one per recipient, so awards are
ordered round-robin across opportunity numbers rather than left grouped by
program. That makes the output read across the sample instead of in program-sized
blocks. Set `TARGET_AWARD_COUNT` to cap the output; the round-robin ordering
makes the cap a spread of opportunities rather than the first one or two
programs. `report.json` records `awardsDroppedByCap` so a cap is never silent.

**Stage 4, transform and validate.** Each pair maps to an `AwardBase`, and every
emitted record is validated against the published JSON Schema bundle with Ajv
(draft 2020-12, which the bundle's `unevaluatedProperties` assertions need).
Validation failures are reported and written to `report.json`; they do not stop
the run, so you can inspect what failed.

Records are validated after a JSON round-trip rather than in memory. Date-bearing
fields hold `Date` values until `toJSON` converts them to protocol strings, so
validating the in-memory objects would check a shape no consumer ever sees.

## Fetching strategy

Neither API can be queried by funding opportunity number, so each side is fetched
a different way.

**USAspending is sampled.** The opportunity number appears only on the per-award
detail response, and the search endpoint does not accept it as a filter or return
it as a field. There is no way to ask for awards by opportunity number, so the
script pages through awards and reads each detail record.

**Simpler.Grants.gov is queried once per distinct opportunity number.** Lookups
run four at a time and each returns a page of 25 results, scanned for an exact
match. Results are cached to `opportunity-cache.json`, misses included, so
repeat runs issue no queries at all. On the default sample that is 64 queries
covering 155 awards, since one opportunity accounts for many awards.

Querying per number looks wasteful next to a single bulk export, so the export
was built and measured against the same 155-award candidate set. It pulled
opportunities bounded by close date and agency and matched them locally.

|                                 | per-number queries     | bounded export       |
| ------------------------------- | ---------------------- | -------------------- |
| opportunity numbers matched     | 37 of 64               | 16 of 64             |
| awards emitted                  | 84                     | 37                   |
| requests                        | 64, run four at a time | 43 pages, sequential |
| serialized round-trips          | 16                     | 43                   |
| opportunity records transferred | under 1600             | 4275                 |

The export matched fewer numbers and took longer. Two things account for it.

Recall drops because the export's filters exclude opportunities the per-number
query finds. The numbers it missed were NSF program solicitations such as
`21-552` and `22-541`, which fits those opportunities having no single close
date and therefore falling outside a `closeDateRange` filter.

Latency is higher because an export is not one request. The SDK paginates in a
sequential loop, so 4275 opportunities at 100 per page is 43 round-trips in
series, while 64 queries at four-way concurrency is 16. The export also moves
roughly three times the data to return less of it.

## Layout

```
src/
  index.ts            CLI and stage orchestration
  config.ts           environment configuration
  concurrency.ts      bounded parallel map, shared by both stages
  fetch/
    usaspending.ts    award sampling and detail records
    sgg.ts            opportunity lookup and the lookup cache
  transform/
    join.ts           join on the opportunity number, then order and cap
    award.ts          USAspending award plus opportunity to AwardBase
    award-types.ts    AwardBase model types
    dates.ts          protocol date construction
    ids.ts            deterministic UUIDs
    validate.ts       JSON Schema validation
data/
  usaspending-candidates.json   stage 1 snapshot of USAspending awards
  opportunity-cache.json        Simpler.Grants.gov lookups, misses included
  awards.json                   committed reference output
  schemas/                      vendored CommonGrants YAML schema bundle
```

### Types and dates

`@common-grants/sdk` 0.6 covers opportunities, so it exports nothing for
`AwardBase`, `AwdIds`, `AwdStatus`, `AwdFunding`, `AwdTimeline`, `OppRef`,
`OrgRef`, or the identifier collections. Those are declared in
`transform/award-types.ts`. Every shared field type comes from the SDK, including
`Money`, `Event`, `SingleDateEvent`, `DateRangeEvent`, and `SystemMetadata`.

The SDK's date-bearing types hold `Date` values, not strings. A plain `Date` would
serialize to a full timestamp, which the schema's `format: date` assertion rejects
on a date-only field, so the SDK returns a `Date` subclass whose `toJSON` emits
the protocol's wire format ([#1024](https://github.com/HHS/simpler-grants-protocol/pull/1024)).
That subclass is internal, so the only way to obtain one is to parse through
`ISODateSchema`. `transform/dates.ts` routes all date construction through the
SDK's parsers for that reason, and passes parsed values along untouched, since
`new Date(value)` or `structuredClone` would lose the behavior.

## Field mapping

Most fields come straight from the USAspending award record.

| `AwardBase` field                                                   | Source                                                                                                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `identifiers.systemId`                                              | The award's UUID, under `awd:usaspending:system`                                                                                                                                                 |
| `identifiers["awd:us:fain"]`                                        | `fain`                                                                                                                                                                                           |
| `identifiers.otherIds["awd:usaspending:generated-unique-award-id"]` | `generated_unique_award_id`                                                                                                                                                                      |
| `identifiers.otherIds["awd:usaspending:uri"]`                       | `uri`                                                                                                                                                                                            |
| `status`                                                            | Derived from the period of performance                                                                                                                                                           |
| `funding.awardedAmount`                                             | `total_obligation`                                                                                                                                                                               |
| `funding.disbursedAmount`                                           | `total_outlay`, falling back to `total_account_outlay`                                                                                                                                           |
| `keyDates.awardDate`                                                | `date_signed`                                                                                                                                                                                    |
| `keyDates.periodOfPerformance`                                      | `period_of_performance.start_date` and `.end_date`                                                                                                                                               |
| `opportunity`                                                       | The matched Simpler.Grants.gov opportunity's id and title                                                                                                                                        |
| `opportunity.identifiers`                                           | `opp:us:fon` from the join key, `opp:us:aln` from `cfda_info[0].cfda_number`, and the opportunity's own UUID under `opp:grants.gov:system`. Emitted only when `OPPORTUNITY_IDENTIFIERS=include`. |
| `funders`                                                           | `awarding_agency`, with the subtier agency and any distinct funding agency under `otherOrgs`                                                                                                     |
| `recipientOrganizations`                                            | `recipient`, with UEI and DUNS identifiers and any parent recipient                                                                                                                              |
| `source`                                                            | `https://www.usaspending.gov/award/{generated_unique_award_id}`                                                                                                                                  |

### Opportunity identifiers

`opp:us:fon` and `opp:us:aln` describe the opportunity rather than the award, so
they belong on `opportunity.identifiers`. `OppRef` does not specify an
`identifiers` property yet and closes itself with `unevaluatedProperties: {not:
{}}`, so emitting them is a deliberate schema violation.

`OPPORTUNITY_IDENTIFIERS` picks which shape to produce. The default, `omit`,
leaves them out and every record validates. `include` emits them and the
validator classifies the resulting `/opportunity/identifiers must NOT be valid`
error as a known gap, reported separately from real failures in both the console
output and `report.json`.

Errors elsewhere are unaffected: a malformed `opportunity.id` or a missing
`opportunity.title` is still a failure. Note that nothing inside the
`identifiers` subtree is checked at all while the schema does not describe it, so
the contents of those identifiers are unvalidated in `include` mode.

### Recipient identity

A recipient's `id` is USAspending's own entity UUID. It comes from
`recipient.recipient_hash`, which is a UUID with a one-character level suffix
appended (`-R` for a recipient, `-P` for a parent, `-C` for a child of a parent).
The bare UUID becomes `id` and `identifiers.systemId`, and the full suffixed
string is preserved under `org:usaspending:recipient-hash`, since the suffix
records the entity level and is the form USAspending's own lookups expect.

```json
"primary": {
  "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8",
  "name": "NYS DEPARTMENT OF HEALTH",
  "identifiers": {
    "systemId": {
      "registry": { "code": "org:usaspending:system" },
      "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8"
    },
    "otherIds": {
      "org:usaspending:recipient-hash": {
        "registry": { "code": "org:usaspending:recipient-hash" },
        "id": "78e2168c-91dc-4ee3-f4cb-fb8e0cff6ea8-R"
      }
    },
    "org:us:uei": {
      "registry": { "code": "org:us:uei", "url": "..." },
      "id": "F863WQVMZSK7"
    }
  }
}
```

When a record has no recipient hash the UUID falls back to a UUIDv5 derived from
the UEI, or from the name when there is no UEI, and no `systemId` is emitted.
Claiming one for a UUID this script minted would misstate where it came from.

Four required fields have no USAspending equivalent and are derived. Each
derivation is documented at the code that performs it.

- **`id`, and the UUIDs on agency references.** USAspending has no UUID for an
  award or an agency. These are UUIDv5 values derived from source keys (the
  generated unique award id, the toptier and subtier agency codes), so the same
  source record always yields the same UUID and output stays diffable across runs.
  Recipient UUIDs are not derived; see "Recipient identity" above.
- **`title`.** USAspending assistance awards have no title. Award descriptions of
  150 characters or fewer read as titles and are used directly; longer ones fall
  back to the opportunity title plus the FAIN.
- **`status`.** There is no status field on assistance awards. A period of
  performance that has ended maps to `completed`, anything else to `awarded`.
  Terminated awards are not distinguishable in this data, so `cancelled` is never
  emitted.
- **`createdAt` and `lastModifiedAt`.** These describe the record, which
  USAspending does not timestamp. The award's signing date and the transaction's
  last modified date stand in, and `lastModifiedAt` is floored at `createdAt` so
  the pair stays coherent.

## Coverage limits

The opportunity number became a USAspending data element in DAIMS v2.2 (June
2022), and the validation rule requiring it for grants and cooperative agreements
took effect as a warning on October 1, 2023. Two limits follow from how agencies
actually report it.

Population varies by agency. Across a 250-award sample spanning ten agencies,
about 60% carried a real value. HHS, EPA, DOJ, Interior, Education, and NSF
populate it; DOT, USDA, and HUD reported `NOT APPLICABLE` on every award sampled,
and Energy on most.

Not every populated value is a posted opportunity number. HHS in particular
reports two distinct shapes. NIH (`PAR-21-293`), CDC (`CDC-RFA-CK19-1904`), HRSA
(`HRSA-22-116`), AHRQ (`RFA-HS-23-012`), and the
`HHS-YYYY-<OPDIV>-<PROGRAM>-NNNN` format used by ACF, ACL, and IHS all resolve.
Alongside those is an internal tracking convention (`SM00-PAIMI`,
`EP-U3R-24-001`, `IW-SIW-18-001`) that has no grants.gov counterpart. ASPR, OASH,
and CMS use it exclusively. Those numbers cannot resolve, which is why the
resolver treats a miss as a miss instead of trying to normalize toward a match.

For awards where the number is absent or internal, the assistance listing number
plus the awarding sub-agency is a coarser fallback join. This script does not
implement it.
