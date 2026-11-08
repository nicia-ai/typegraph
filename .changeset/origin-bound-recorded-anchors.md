---
"@nicia-ai/typegraph": minor
---

Bind TypeGraph-owned recorded anchors to their durable graph origin and recording namespace using the `r2:<origin>:<namespace digest>:<revision>:<timestamp>` format. Historical reads, including empty reads and first-page adjacency, refuse retired or foreign origins after a graph reset. Engine-native `e1:` ownership remains separate. Legacy `r1:` strings remain parseable but cannot authorize historical reads; migrate them only with independently retained origin evidence, or discard and resynchronize checkpoints whose origin cannot be proven.

Add `store.resolveRecordedAnchor(wallTime)` for one indexed lookup of the latest retained recorded allocation anchor at or before a canonical UTC timestamp. Equal timestamps choose the greatest revision; future requests return the latest retained cut; absent, cleared, or unlogged cuts return `undefined`. This describes allocation time, not database commit visibility. Base-schema version 7 installs the retained anchor log and its index; coverage starts with captured transactions after installation, without inventing earlier allocation timestamps. Custom backends must declare and honor `recordedAnchorLookup`; engine-native histories refuse this TypeGraph-owned resolver.

Regenerate persisted merge plans and re-baseline branches whose revision fences contain the old anchor format before resuming application. Do not rewrite embedded fence strings or artifact digests with the checkpoint migration helper.

Complete `PostgresTableNames` / `SqliteTableNames` maps must include `recordedAnchors`; partial table-name overrides continue to use defaults. Custom PostgreSQL working-copy connectors must bind this relation to the allocated namespace along with the other graph relations.
