---
"@nicia-ai/typegraph": minor
---

Add cursor-paginated recorded-time adjacency returning incident edge/neighbor pairs. Pages bound historical candidates and endpoint reads, preserve parallel edges and self-loops, and bind continuations to the graph origin and both temporal coordinates. Pages may be empty while returning a continuation cursor. Add endpoint paging indexes with base-schema version 6 adoption for existing databases.

Use `candidateLimit` to bound selected-kind historical rows per page; superseded and deleted versions can produce empty pages with a continuation. Cursor scope mismatches throw `ValidationError` for `after`. Discard recorded anchors and views after `clear()`.

Upgrade note: base-schema version 6 builds two seven-column recorded-edge indexes inline during privileged open, including with `systemIndexes: "skip"`. On large PostgreSQL histories, prebuild the endpoint indexes concurrently outside a transaction before upgrading; see the backend setup guide for exact definitions and validity checks.

Custom system-index provisioners must pass an explicit `dialect` to `generateSystemIndexDDL` for declarations with `binaryOrderColumns`; omission now throws `ConfigurationError` with code `SYSTEM_INDEX_DIALECT_REQUIRED`. Existing plain-index calls remain supported.
