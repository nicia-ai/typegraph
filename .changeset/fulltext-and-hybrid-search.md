---
"@nicia-ai/typegraph": minor
---

Add fulltext search and hybrid (vector + fulltext) retrieval. Declare `searchable()` string fields on any node schema and TypeGraph keeps a native FTS index in sync — `tsvector` + GIN on PostgreSQL, FTS5 on SQLite. Query it through a node-level `n.$fulltext.matches()` predicate that composes with metadata filters, graph traversal, and vector similarity in one SQL statement.

```typescript
import { defineNode, searchable, embedding } from "@nicia-ai/typegraph";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    tenantId: z.string(),
    embedding: embedding(1536),
  }),
});

// Fulltext + metadata filter in a single query
const results = await store.query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext.matches("climate change", 20).and(d.tenantId.eq(tenant)),
  )
  .select((ctx) => ctx.d)
  .execute();

// Hybrid: vector + fulltext fused with Reciprocal Rank Fusion at the SQL layer
const hybrid = await store.query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext.matches("climate", 50)
      .and(d.embedding.similarTo(queryVector, 50))
      .and(d.tenantId.eq(tenant)),
  )
  .select((ctx) => ctx.d)
  .limit(10)
  .execute();

// Store-level helper with tunable RRF weights and snippets
const tuned = await store.search.hybrid("Document", {
  limit: 10,
  vector: { fieldPath: "embedding", queryEmbedding: queryVector },
  fulltext: { query: "climate change", includeSnippets: true },
  fusion: { method: "rrf", k: 60, weights: { vector: 1, fulltext: 1.5 } },
});
```

Query modes cover `websearch` (Google-style syntax — default), `phrase`, `plain`, and `raw` (dialect-native tsquery / FTS5 MATCH). Highlighting via `ts_headline` / `snippet()` is opt-in per query. No extensions required: Postgres uses the built-in `tsvector` + GIN (works on every managed provider); SQLite uses FTS5 which is statically linked into the standard `better-sqlite3` / `libsql` / `bun:sqlite` distributions. See `/fulltext-search` for the full guide.

### Breaking (pre-release)

- Field-level `.matches()` on string accessors has been removed. Use `n.$fulltext.matches(query, k?, options?)` at the node level instead. `$fulltext` is exposed on every `NodeAccessor`; a runtime guard throws a clear error if the node kind has no `searchable()` fields. `k` defaults to 50.
- Store-level search is now grouped under a `store.search` facade: `store.fulltextSearch(...)` → `store.search.fulltext(...)`, `store.hybridSearch(...)` → `store.search.hybrid(...)`, `store.rebuildFulltextIndex(...)` → `store.search.rebuildFulltext(...)`. Rename call sites; behavior is unchanged.
- `FulltextSearchHit`, `VectorSearchHit`, and `HybridSearchHit` are now generic over the node type (`FulltextSearchHit<N = Node>`). `store.search.fulltext("Document", ...)` returns hits with `hit.node` narrowed to the Document node shape — no cast required. Existing callers that used the un-parameterized `Node`-default continue to work.

### Added

- `backend.upsertFulltextBatch` + `backend.deleteFulltextBatch` — symmetric batched fulltext primitives. Homogeneous batch shape, duplicate-nodeId dedupe last-write-wins, per-row fallback when unset.
- `store.search.rebuildFulltext(nodeKind?, { pageSize? })` — rebuilds the fulltext index from existing node data using keyset pagination on `id` (stable under shared timestamps and light concurrent writes). Transacts per page; cleans stale rows for soft-deleted nodes; validates `pageSize` as a positive integer; counts corrupt / non-object props as `skipped` and surfaces the offending IDs via `skippedIds` without aborting. Concurrent hard-deletes between pages may be missed — document as maintenance operation.
- Keyset pagination on `findNodesByKind` via `{ orderBy, after }` params. Offset pagination now uses a deterministic tiebreaker (`ORDER BY created_at DESC, id DESC`).
- `QueryBuilder.fuseWith({ k?, weights? })` — tunable RRF on the query-builder path. Flat `HybridFusionOptions` shape, identical to `store.search.hybrid`'s `fusion` option. Throws at compile time if the query lacks either a `.similarTo()` or `n.$fulltext.matches()`.
- `n.$fulltext` — node-level fulltext accessor; `.matches()` against the combined `searchable()` content.
- `FulltextStrategy` — pluggable abstraction (exported from the top-level entry) that owns the **entire** SQL pipeline for a dialect's fulltext support: DDL, upsert (single + batch), delete (single + batch), MATCH condition, rank expression, and snippet expression. Ships `tsvectorStrategy` (Postgres built-in `tsvector`) and `fts5Strategy` (SQLite FTS5); dialect adapters expose `fulltext: FulltextStrategy | undefined`. Alternate Postgres stacks (pg_trgm, ParadeDB / pg_search, pgroonga) choose their own column layout, index type, and projection — TypeGraph's operation layer just delegates to the active strategy.
- Backend-level fulltext strategy override: `createPostgresBackend(db, { fulltext })` and `createSqliteBackend(db, { fulltext })` accept a `FulltextStrategy` that takes precedence over the dialect default. Threaded through to compiler passes, backend-direct search SQL, all write SQL, DDL generation, and capability discovery — so a ParadeDB-backed Postgres `store.search.hybrid()` fuses the same way a tsvector-backed one does, without any call-site changes.
- `FulltextStrategy.supportsPrefix` — strategies declare prefix-query support explicitly, rather than having it inferred from `raw` mode. Keeps capability discovery correct when a strategy supports prefix matching via dedicated syntax without advertising raw-mode pass-through.
- `rebuildFulltext({ maxSkippedIds })` — operators investigating systemic corruption can raise the cap on returned skipped IDs (default: 10,000) to collect the full list.
- Hybrid SQL emitter now uses a deterministic `COALESCE(fulltext.node_id, embeddings.node_id) ASC` tiebreak, matching the JS-side `localeCompare(nodeId)` tiebreak used by `store.search.hybrid`. The two hybrid paths now produce identical top-k under RRF score ties.
- `store.search` facade: new namespace that groups `search.fulltext()`, `search.hybrid()`, and `search.rebuildFulltext()`. Replaces the flat `store.fulltextSearch` / `store.hybridSearch` / `store.rebuildFulltextIndex` methods (see Breaking section above). Lazy-initialized and cached on first access.
- Property names starting with `$` are now reserved in `defineNode()` / `defineEdge()` schemas (matches the `$fulltext` accessor namespace); `ConfigurationError` is raised at graph-definition time instead of silently shadowing user fields at query time.
- `store.search.fulltext` and `store.search.hybrid` validate caller options against the active `FulltextStrategy` (falling back to `BackendCapabilities.fulltext.{phraseQueries, highlighting, languages}` when no strategy is attached): a `mode` outside `strategy.supportedModes` throws, `includeSnippets: true` where the strategy advertises `supportsSnippets: false` throws, and a per-query `language` override on a strategy whose `supportsLanguageOverride` is false (e.g. SQLite FTS5) now throws instead of being silently ignored. Advisory warning for unknown languages on strategies that do honor overrides.
- `$fulltext.matches()` is additionally validated against the dialect strategy's `supportedModes` at compile time.
- One-time `console.warn` when a node kind has multiple `searchable()` fields with conflicting `language` values. The first field's language still wins on the stored row; the warning makes the silent collapse visible so users know to split multilingual content across dedicated node kinds.
- `store.search.hybrid({ fusion })` shares its validator with `QueryBuilder.fuseWith()` — one source of truth for `method`, `k`, and per-source weights, so bad values are rejected on both paths.
- Snippet highlighting uses `<mark>…</mark>` consistently across both shipped strategies (`ts_headline` on Postgres, `snippet()` on SQLite). One stylesheet applies everywhere.
- `FulltextSearchResult.score` is always `number`. The Postgres adapter coerces `numeric`-as-string driver returns at the backend boundary so downstream code never sees a union type.
- Postgres fulltext table schema: `language` is `regconfig` (not `TEXT`) and `tsv` is a `GENERATED ALWAYS AS (to_tsvector("language", "content")) STORED` column. Postgres owns the `content / language → tsv` invariant; the strategy's write SQL no longer has to recompute `tsv` inline. The `content` column is populated verbatim, and the per-query `language` override path still accepts a text parameter (cast to `regconfig` at query time). SQLite's FTS5 virtual table is unchanged.
