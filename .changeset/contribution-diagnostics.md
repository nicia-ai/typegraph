---
"@nicia-ai/typegraph": minor
---

Add `store.verifyContributions()`, an owner-agnostic diagnostic that crosses
every durable contribution marker against the physical catalog. Nothing on the
open path probes the catalog — boot and the runtime asserts short-circuit on a
per-instance signature cache and then on the marker row alone — so a database
whose strategy-owned tables were dropped out of band opened completely clean and
failed at the first fulltext or vector read. The diagnostic reports each
problem as `orphaned-marker` (marker records a success, table absent),
`missing-marker` (table present, nothing attests it), `failed-materialization`
(the marker records a failed attempt and no table was produced — marker and
catalog agree, and it is broken anyway), or `stale` (marker recorded at a
different shape), with the `owner` / `logicalName` /
`physicalName` and, for vector slots, the `kind` and `fieldPath` needed to route
to the state-specific repair without reconstructing internal marker strings.
`missing-marker` and `failed-materialization` use the non-destructive forced
ensure; only `orphaned-marker` and `stale` rebuild vector storage with
`store.reembedVectorField`. `lastError` carries the reason the marker recorded,
when it recorded one: `state` says which repair to run, `lastError` says why it
broke. It is read-only (one existence query per contribution table, no DDL, no
writes) and deliberately not a boot step; the fast-path caching stays the
default. Backends that cannot probe their own catalog throw `ConfigurationError`
rather than reporting a clean bill of health.
