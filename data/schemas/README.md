# Vendored CommonGrants schema bundle

A copy of the published CommonGrants JSON Schema bundle, vendored so the pipeline
validates with no network access.

| | |
| --- | --- |
| Version | `@common-grants/core` v0.4.0 |
| Source | [HHS/simpler-grants-protocol](https://github.com/HHS/simpler-grants-protocol) at tag `@common-grants/core@0.4.0`, path `website/public/schemas/yaml/` |
| Published at | <https://commongrants.org/schemas/yaml/> |
| Vendored | 2026-08-14; verified byte-identical to the published bundle on 2026-08-17 |

Only the subset reachable from `AwardBase.yaml` is here: 38 of the 373 files
published upstream, following every `$ref` transitively.

## Checking whether this copy is stale

commongrants.org serves the current bundle rather than a versioned one, so there
is no URL that pins v0.4.0. Validation here runs against this frozen copy, which
means it keeps passing even if the published schemas have moved on. Checking for
that is a deliberate step:

```bash
for f in data/schemas/*.yaml; do
  n=$(basename "$f")
  curl -sf "https://commongrants.org/schemas/yaml/$n" -o /tmp/live.yaml || { echo "fetch failed: $n"; continue; }
  cmp -s /tmp/live.yaml "$f" || echo "differs from published: $n"
done
```

Silence means this copy still matches what is published. Otherwise re-copy each
file it names and update the version and dates above. If a schema starts
referencing a file that is not vendored yet, the build fails naming the file it
could not read.
