---
"@nicia-ai/typegraph": minor
---

Remove the `typegraph-cloud` source type from the interchange
`GraphDataSourceSchema`.

TypeGraph Cloud is not a publicly available product, so the `typegraph-cloud`
variant has been dropped from the graph-data source discriminated union, and the
corresponding interchange documentation has been removed. `GraphDataSource` now
accepts only `typegraph-export` and `external`.

**Breaking:** importing data whose `source.type` is `"typegraph-cloud"` now
fails schema validation. Re-tag such payloads as `"external"` before importing.
