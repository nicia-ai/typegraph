---
title: Fulltext Search
description: BM25-style fulltext search with hybrid retrieval for RAG applications
---

TypeGraph supports fulltext search directly in your SQLite or PostgreSQL
database — no external search service required. Combine it with semantic
search to get **hybrid retrieval**: the gold-standard pattern for RAG
applications.

## Overview

Vector search is great at finding *semantically* similar content, but it
misses exact matches: proper nouns, SKU numbers, code identifiers, rare
technical terms. Fulltext search handles those. Running both and fusing
the results with Reciprocal Rank Fusion typically beats either approach
alone.

**Key capabilities:**

- Declare `searchable()` string fields in your Zod schema
- Native BM25 ranking (SQLite FTS5) and `ts_rank_cd` (PostgreSQL tsvector)
- Google-style query syntax: quoted phrases, `-excluded`, `OR`
- `n.$fulltext.matches()` predicate composes with metadata filters and graph traversal
- Hybrid search via `$fulltext.matches()` + `.similarTo()` in one query, fused with RRF
- Tunable RRF via `.fuseWith({ k, weights })` on the query builder, or `store.search.hybrid({ fusion })`

## Use Cases

### Hybrid RAG

Combine exact-match retrieval with semantic similarity:

```typescript
const hits = await store.search.hybrid("Document", {
  limit: 10,
  vector: {
    fieldPath: "embedding",
    queryEmbedding: await embed(question),
  },
  fulltext: { query: question },
});

const context = hits.map((h) => h.node.content).join("\n\n");
```

### Multi-tenant fulltext with metadata filters

The most important composition — `$fulltext.matches()` in the same query as
any other predicate:

```typescript
const results = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext.matches("climate change", 20).and(d.tenantId.eq(tenant.id))
  )
  .select((ctx) => ctx.d)
  .execute();
```

### Authorised search via graph traversal

Only return documents the user is allowed to read:

```typescript
const results = await store
  .query()
  .from("User", "u")
  .whereNode("u", (u) => u.id.eq(currentUserId))
  .traverse("canRead", "e")
  .to("Document", "d")
  .whereNode("d", (d) => d.$fulltext.matches(userQuery, 10))
  .select((ctx) => ctx.d)
  .execute();
```

## Schema Design

### Declaring Searchable Fields

Use `searchable()` to mark string fields for fulltext indexing:

```typescript
import { defineNode, searchable } from "@nicia-ai/typegraph";
import { z } from "zod";

const Document = defineNode("Document", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    tenantId: z.string(),
    published: z.boolean(),
  }),
});
```

### How Indexing Works

TypeGraph stores one fulltext row per node. When you create or update a
node, the values of every `searchable()` field are concatenated and
indexed as a single document. This single-document-per-node design lets a
single query find matches that span multiple source fields — a title hit
plus a body hit both contribute to the same score.

- **PostgreSQL**: the `typegraph_node_fulltext` table carries a
  `tsvector` column populated at INSERT time, with a GIN index.
- **SQLite**: the same shape is backed by an FTS5 virtual table with
  BM25 ranking.

Sync is automatic — the fulltext index stays in sync with node data
through every `create`, `update`, `upsert`, and `delete` (soft and hard).

### Searchable Options

```typescript
searchable({
  language: "english",  // Postgres regconfig / SQLite FTS5 tokenizer
})
```

- **`language`**: Postgres uses this as the `regconfig` for stemming
  (`english`, `spanish`, `french`, etc.). SQLite FTS5 tokenizer is fixed
  at table creation time, so the language is stored but treated as
  metadata.

### Adding `searchable()` to an Existing Graph

When you add `searchable()` to a field on a node kind that already has
rows in production, those pre-existing rows are not indexed until you
backfill the index:

```typescript
const stats = await store.search.rebuildFulltext();
console.log(
  `Upserted ${stats.upserted}, cleared ${stats.cleared}, ` +
    `skipped ${stats.skipped} across ${stats.kinds.length} kinds`,
);

if (stats.skippedIds && stats.skippedIds.length > 0) {
  console.warn("Nodes with corrupt props were skipped:", stats.skippedIds);
}

// For systemic corruption, raise the cap to collect the full list:
const forensic = await store.search.rebuildFulltext(undefined, {
  maxSkippedIds: 1_000_000,
});
```

`store.search.rebuildFulltext()` iterates nodes with keyset pagination on `id`
(stable under shared timestamps and light concurrent writes), transacts
per page, and cleans up stale fulltext rows for soft-deleted nodes.
Rebuild is a maintenance operation: concurrent hard-deletes between page
fetches can be missed by a single pass. Run during a maintenance window
for full consistency. Scope to a single kind with
`store.search.rebuildFulltext("Document")` to avoid scanning unrelated
data.

Also useful for:

- Recovering after a `DROP TABLE` / `TRUNCATE` of the fulltext table.
- Re-tokenizing after changing `language` on a `searchable()` field.
- Recovering from bulk inserts that bypassed the store layer.

## Database Setup

### PostgreSQL

No extensions required. The built-in `tsvector` type and GIN indexes
work on every managed Postgres (RDS, Supabase, Neon, Cloud SQL, Aiven).

The fulltext table is created automatically by `bootstrapTables()` or the
migration SQL:

```typescript
import { generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

// Includes the fulltext table, tsvector column, GIN index, and pgvector
const migrationSQL = generatePostgresMigrationSQL();
```

### SQLite

No extensions required. FTS5 is compiled into the standard SQLite
distribution shipped with `better-sqlite3`, `libsql`, `bun:sqlite`, and
most other drivers. The FTS5 virtual table uses the
`porter unicode61 remove_diacritics 2` tokenizer.

## Querying

### `n.$fulltext.matches()` — The Query Predicate

`n.$fulltext.matches(query, k?, options?)` is a node-level fulltext
predicate. It's exposed on every `NodeAccessor`; at runtime it throws a
clear `UnsupportedPredicateError` if the node kind has no `searchable()`
fields, with a suggestion for how to fix the schema.

> **Visible in types, guarded at runtime.** `$fulltext` is present on every
> `NodeAccessor` at the TypeScript level for simplicity — a type-level
> brand would not survive modifiers like `.min(1).optional()`. The runtime
> check is the single source of truth: adding a `searchable()` field is
> what makes `.matches()` actually work. A query that type-checks can still
> throw `UnsupportedPredicateError` the first time it runs if no field
> was declared searchable.

```typescript
store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) => d.$fulltext.matches("climate change"))
  .select((ctx) => ctx.d)
  .execute();
```

It compiles to a JOIN against the fulltext index, adds an ORDER BY on
relevance rank, and applies the top-k limit — all in a single SQL
statement that composes with every other query-builder feature.

**`k` vs `limit`**: `k` (the second positional arg) is the top-k cap
applied **inside the fulltext CTE** — how many candidates to pull from
the index before outer filtering and fusion. It defaults to `50`, which
is fine for single-predicate use. `.limit()` on the query controls the
**final result count**. When feeding into RRF (`store.search.hybrid` or
`.fuseWith()`), pass a larger `k` per predicate (e.g. 200) so there are
enough candidates for the fused ranking to be meaningful.

### Query Modes

```typescript
d.$fulltext.matches("climate -warming", 10, { mode: "websearch" })
//       Google-style: quoted phrases, -excluded terms, OR operator

d.$fulltext.matches("climate change", 10, { mode: "phrase" })
//       Exact phrase match

d.$fulltext.matches("climate change", 10, { mode: "plain" })
//       All terms must appear (implicit AND), no special syntax

d.$fulltext.matches("climate & !warming", 10, { mode: "raw" })
//       Dialect-native syntax (tsquery on Postgres, FTS5 on SQLite)
```

**When to use each:**

| Mode | Best For | Example |
|------|----------|---------|
| `websearch` (default) | User-facing search boxes | `"climate change" -hoax OR warming` |
| `phrase` | Proper nouns, exact quotes | `"New York Times"` |
| `plain` | Programmatic queries | `climate change` |
| `raw` | Advanced users who know the dialect syntax | `climate<->change` |

### Composing with Filters

Fulltext is just another predicate — combine with `.and()`:

```typescript
store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext
      .matches("machine learning", 20, { mode: "websearch" })
      .and(d.published.eq(true))
      .and(d.publishedAt.gte("2024-01-01"))
      .and(d.tenantId.eq(tenant))
  )
  .select((ctx) => ctx.d)
  .execute();
```

### Composing with Graph Traversal

`$fulltext.matches()` works inside any traversal:

```typescript
// Find documents matching "climate" that were written by someone I follow
const results = await store
  .query()
  .from("Person", "me")
  .whereNode("me", (p) => p.id.eq(currentUserId))
  .traverse("follows", "f")
  .to("Person", "author")
  .traverse("authored", "a", { direction: "in" })
  .to("Document", "d")
  .whereNode("d", (d) => d.$fulltext.matches("climate", 10))
  .select((ctx) => ({
    title: ctx.d.title,
    author: ctx.author.name,
  }))
  .execute();
```

### Hybrid Search (Query Builder)

Use `$fulltext.matches()` and `.similarTo()` in the same query and
TypeGraph automatically fuses the two signals with Reciprocal Rank Fusion
at the SQL layer:

```typescript
const results = await store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext
      .matches("renewable energy", 50)
      .and(d.embedding.similarTo(queryVector, 50))
      .and(d.tenantId.eq(tenant))
  )
  .select((ctx) => ctx.d)
  .limit(10)
  .execute();
```

The compiled SQL builds two CTEs (one for the vector side, one for the
fulltext side), orders each by relevance, and the outer query sorts by
`1/(60 + rank_vector) + 1/(60 + rank_fulltext)`. One round-trip, fully
composable with any other predicate.

### Tuning RRF

Defaults (k=60, equal weights) suit most workloads. Bias toward fulltext
for exact-match queries, toward vectors for conceptual queries:

```typescript
store
  .query()
  .from("Document", "d")
  .whereNode("d", (d) =>
    d.$fulltext
      .matches("renewable energy", 50)
      .and(d.embedding.similarTo(queryVector, 50))
      .and(d.tenantId.eq(tenant))
  )
  .fuseWith({ k: 60, weights: { vector: 1.0, fulltext: 1.5 } })
  .limit(10)
  .execute();
```

`.fuseWith()` throws at compile time if the query lacks either a
`.similarTo()` or a `$fulltext.matches()`. Validation rejects non-finite
or negative `k`/weights. The same shape is accepted by
`store.search.hybrid({ fusion })` and validated by the same function on
both paths.

### Hybrid Search (Store API)

For tunable RRF parameters, use `store.search.hybrid()`:

```typescript
const results = await store.search.hybrid("Document", {
  limit: 10,
  vector: {
    fieldPath: "embedding",
    queryEmbedding: await embed(question),
    metric: "cosine",
    k: 50,          // Candidates to retrieve from vector
  },
  fulltext: {
    query: question,
    k: 50,          // Candidates to retrieve from fulltext
    includeSnippets: true,
  },
  fusion: {
    method: "rrf",
    k: 60,          // RRF constant (classic default)
    weights: {
      vector: 1.0,
      fulltext: 1.5,  // Weight fulltext higher for exact-match workloads
    },
  },
});
```

Each hit carries sub-scores from both halves so you can debug ranking:

```typescript
for (const hit of results) {
  console.log(hit.node.title, hit.score);
  console.log("  vector rank:", hit.vector?.rank);
  console.log("  fulltext rank:", hit.fulltext?.rank);
  console.log("  snippet:", hit.fulltext?.snippet);
}
```

### Fulltext-Only Store API

For quick fulltext lookups that don't need the query builder:

```typescript
const hits = await store.search.fulltext("Document", {
  query: "quarterly earnings",
  limit: 10,
  mode: "websearch",
  includeSnippets: true,
});

for (const hit of hits) {
  console.log(hit.node.title, hit.score, hit.snippet);
}
```

#### Options reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `query` | `string` | — *(required)* | User-supplied query string. Parsed according to `mode`. |
| `limit` | `number` | — *(required)* | Max rows to return. Must be a positive integer. |
| `mode` | `"websearch" \| "phrase" \| "plain" \| "raw"` | `"websearch"` | Parser for `query`. See [Query Modes](#query-modes). |
| `language` | `string` | per-row (as indexed) | Override the stemming/tokenization language for this query. Postgres only — SQLite FTS5's tokenizer is fixed at table-create time and a per-query override throws. |
| `minScore` | `number` | *(none)* | Drop hits whose backend-native score is below this threshold. Score units depend on the strategy. |
| `includeSnippets` | `boolean` | `false` | Return a highlighted `<mark>…</mark>` snippet per hit. Noticeably slower than plain search — request only for final-page results. |

Returned hits are `FulltextSearchHit<Node<K>>` with `node`, `score`
(higher = more relevant), `rank` (1-based), and `snippet` (when
requested).

## Reciprocal Rank Fusion

RRF is the de facto standard for combining ranked lists from multiple
retrievers. The formula:

```text
score(doc) = Σ weight_source / (k + rank_source)
```

Where `k` is the RRF constant (classic default: 60), `rank_source` is
the document's 1-based ordinal rank in each source, and `weight_source`
lets you bias toward one retriever.

**Why it works:** RRF is rank-based, not score-based. It doesn't care
that vector distances are in `[0, 2]` while BM25 scores are
unbounded — it only cares about ordinal position. That makes it robust
to heterogeneous score distributions across retrievers.

**Tuning tips:**

- Over-fetch from each side (default: 4× the requested limit). More
  candidates per source = better recall.
- Bump `weights.fulltext` higher when exact matches matter (names, IDs,
  proper nouns). Bump `weights.vector` for conceptual queries.
- Leave `k = 60` alone unless benchmarks show otherwise.

## Best Practices

### All Searchable Fields Share One Index

TypeGraph indexes all `searchable()` fields on a node as one document
(see [How Indexing Works](#how-indexing-works)). There's a single
`n.$fulltext` accessor per node — `searchable()` declarations on
individual fields are what bring it into existence and what determine
which text gets indexed.

### Use `includeSnippets` Sparingly

Highlighting (`ts_headline` on Postgres, `snippet()` on SQLite) is
noticeably slower than plain search. Request it only for final-page
results, not for large over-fetch pools.

### Pair with a Reranker for Top Quality

RRF is a strong baseline, but production RAG systems typically add a
cross-encoder reranker (Cohere Rerank, `bge-reranker`, etc.) as a final
stage. TypeGraph gives you the candidate set — the reranker picks the
winning order:

```typescript
const candidates = await store.search.hybrid("Document", {
  limit: 50,                 // Over-fetch for reranker
  vector: { fieldPath: "embedding", queryEmbedding },
  fulltext: { query },
});

const reranked = await cohere.rerank({
  query,
  documents: candidates.map((c) => c.node.content),
  top_n: 10,
});
```

### Filter Before You Fuse

Applying predicates via `.and()` shrinks the candidate pool before the
fusion ORDER BY, which improves both latency and ranking quality — there
are fewer irrelevant candidates competing for top positions:

```typescript
// Fast: tenant filter applied inside each CTE
.whereNode("d", (d) =>
  d.$fulltext.matches(query, 50)
    .and(d.embedding.similarTo(queryVec, 50))
    .and(d.tenantId.eq(tenant))
)

// Slow: tenant filter applied AFTER fusion
.whereNode("d", (d) =>
  d.$fulltext.matches(query, 5000)
    .and(d.embedding.similarTo(queryVec, 5000))
)
// ...then filter results in JS
```

## Limitations

### One Fulltext Predicate Per Query

A single query can contain at most one `$fulltext.matches()` predicate.
This mirrors the constraint on `.similarTo()` and keeps the RRF fusion
model well-defined. If you need to search multiple terms, combine them
into one query string using websearch mode:

```typescript
// Good
d.$fulltext.matches("climate change OR global warming", 20)

// Rejected (at query-build time, not by the type checker)
d.$fulltext.matches("climate", 10).and(d.$fulltext.matches("warming", 10))
```

This invariant is enforced when the query is compiled
(`UnsupportedPredicateError`), not by TypeScript — so a surprising
second `.matches()` call surfaces as a runtime error the first time
the query runs.

### No `.matches()` Under OR or NOT

Fulltext predicates must appear at top level or inside AND groups. They
rewrite query structure (adding a CTE and ORDER BY) in a way that isn't
compatible with disjunction or negation semantics.

### Tokenizer Is Fixed on SQLite

FTS5 tokenizer options are set at CREATE VIRTUAL TABLE time. TypeGraph
ships with `porter unicode61 remove_diacritics 2` — a solid default for
English and accented Latin-script languages. For CJK or other tokenizers,
create the fulltext table manually with your preferred options.

### No Per-Field Weighting

All searchable fields on a node contribute equally to the combined
document. Postgres `setweight()`-style per-field bias is a planned
extension; today, structure your fields to put the most important text
first or split high-weight content into a dedicated kind. This
limitation applies even when you [swap in a custom
`FulltextStrategy`](#custom-fulltext-strategies) — TypeGraph
concatenates searchable fields into one `content` string before handing
it to the strategy.

## Custom Fulltext Strategies

`createPostgresBackend(db, { fulltext })` and
`createSqliteBackend(db, { fulltext })` accept a `FulltextStrategy`
that owns the **entire** fulltext pipeline — DDL, INSERT/UPSERT
(single + batch), DELETE (single + batch), MATCH condition, rank
expression, and snippet generation. The same strategy flows through
`store.search.fulltext()`, `store.search.hybrid()`,
`$fulltext.matches()` in the query builder,
`store.search.rebuildFulltext()`, and `bootstrapTables()` DDL.

Use this when the built-in `tsvector` isn't the right fit — for
example, BM25 inside Postgres (ParadeDB / `pg_search`), trigram
similarity (`pg_trgm`), or fulltext optimized for CJK languages
(`pgroonga`).

Most SQLite users should leave the default `fts5Strategy` in place.

### Constraints on alternate strategies

Before implementing a strategy, know what the abstraction does **not**
let you change today:

- **Side table is mandatory.** Every strategy writes one row per
  `(graph_id, node_kind, node_id)` to a dedicated fulltext table. A
  strategy cannot skip the side table and index a column on the main
  nodes table directly (e.g. a GIN trigram index on
  `typegraph_nodes.props`). Strategies *can* choose the column layout,
  index type, and any computed projection inside that side table.
- **Content is pre-concatenated.** TypeGraph joins every
  `searchable()` field value with `\n` before the strategy sees it —
  `UpsertFulltextParams.content` is a single string. Per-field
  indexing (`setweight`, per-column BM25 boosts, pgroonga
  per-column weights) is not plumbed through today; a richer
  per-field payload is planned but not yet part of the public
  strategy contract.
- **One language per row.** When a node has multiple `searchable()`
  fields with different `language` values, the first field's
  language wins and is recorded on the row. TypeGraph emits a
  one-time warning per conflicting schema; true multilingual
  indexing needs a dedicated node kind per language.

### Strategy skeleton

The `FulltextStrategy` interface is exported from the package root.
Fields below are the minimum surface; see
`src/query/dialect/fulltext-strategy.ts` in the TypeGraph source for
`tsvectorStrategy` and `fts5Strategy` as full references.

```typescript
import { sql, type SQL } from "drizzle-orm";
import type { FulltextStrategy } from "@nicia-ai/typegraph";

/**
 * Example: a trigram-based strategy on top of pg_trgm. Illustrative —
 * not production code. pg_trgm supports plain-term matching only, so
 * `supportedModes` advertises `"plain"` and rejects everything else at
 * compile time.
 */
export const pgTrgmStrategy: FulltextStrategy = {
  name: "pg_trgm",
  supportedModes: ["plain"],
  supportsSnippets: false,        // no native highlight; emit NULL snippet
  supportsPrefix: false,          // trigram similarity, not prefix
  supportsLanguageOverride: false,
  languages: ["simple"],

  matchCondition(table, query) {
    return sql`${sql.identifier(table)}."content" % ${query}`;
  },

  rankExpression(table, query) {
    return sql`similarity(${sql.identifier(table)}."content", ${query})`;
  },

  snippetExpression() {
    // `supportsSnippets: false` — callers get NULL and skip the field.
    return sql`NULL`;
  },

  generateDdl(table) {
    return [
      `CREATE EXTENSION IF NOT EXISTS pg_trgm;`,
      `CREATE TABLE IF NOT EXISTS "${table}" (
         "graph_id" TEXT NOT NULL,
         "node_kind" TEXT NOT NULL,
         "node_id" TEXT NOT NULL,
         "content" TEXT NOT NULL,
         "language" TEXT NOT NULL,
         "updated_at" TIMESTAMPTZ NOT NULL,
         PRIMARY KEY ("graph_id", "node_kind", "node_id")
       );`,
      `CREATE INDEX IF NOT EXISTS "${table}_trgm_idx"
         ON "${table}" USING GIN ("content" gin_trgm_ops);`,
    ];
  },

  buildUpsert(table, params, timestamp) {
    return [
      sql`
        INSERT INTO ${sql.identifier(table)}
          ("graph_id", "node_kind", "node_id", "content", "language", "updated_at")
        VALUES (${params.graphId}, ${params.nodeKind}, ${params.nodeId},
                ${params.content}, ${params.language}, ${timestamp})
        ON CONFLICT ("graph_id", "node_kind", "node_id")
        DO UPDATE SET
          "content" = EXCLUDED."content",
          "language" = EXCLUDED."language",
          "updated_at" = EXCLUDED."updated_at"
      `,
    ];
  },

  buildBatchUpsert(table, params, timestamp) {
    if (params.rows.length === 0) return [];
    // Dedup last-write-wins by nodeId, then emit a single multi-VALUES INSERT.
    // Postgres ON CONFLICT rejects repeated conflict keys inside one statement.
    // (The shipped helpers in fulltext-strategy.ts show this pattern.)
    return [/* … */];
  },

  buildDelete(table, params) {
    return [
      sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE "graph_id" = ${params.graphId}
          AND "node_kind" = ${params.nodeKind}
          AND "node_id" = ${params.nodeId}
      `,
    ];
  },

  buildBatchDelete(table, params) {
    if (params.nodeIds.length === 0) return [];
    return [/* DELETE … WHERE node_id IN (…) */];
  },
};
```

Wire it in at backend construction:

```typescript
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";

const backend = createPostgresBackend(db, { fulltext: pgTrgmStrategy });
```

Capabilities (`phraseQueries`, `prefixQueries`, `highlighting`,
`languages`) are derived automatically from the strategy, so
`store.search.fulltext({ mode: "websearch" })` now throws
`ConfigurationError` before any SQL is generated — the strategy's
`supportedModes` is the source of truth.

## Troubleshooting

### `Cannot call .$fulltext.matches() on alias "x"`

`$fulltext` is exposed on every node accessor at the type level, but
calling `.matches()` requires the node kind to have at least one
`searchable()` field — otherwise there's no indexed content to search.
The runtime guard throws a clear error pointing at the alias:

```text
Cannot call .$fulltext.matches() on alias "d" — its node kind has no
fields declared with searchable(). Add at least one:
`title: searchable({ language: "english" })`.
```

Fix by adding a searchable field to the schema:

```typescript
// Before:
title: z.string(),

// After:
title: searchable({ language: "english" }),
```

Refinements like `.min(1)` and `.trim()` are preserved — you can write
`searchable({ language: "english" }).min(1)` and the field is still
indexed.

### Empty fulltext results after bulk insert

TypeGraph syncs the fulltext index inline with each node write. If you
bulk-inserted via raw SQL that bypassed the store layer, the fulltext
table won't have entries. Re-run the inserts through
`store.nodes.X.create()` / `.bulkCreate()`, run
`store.search.rebuildFulltext()` to populate the index from existing rows,
or issue `backend.upsertFulltext()` / `backend.upsertFulltextBatch()`
calls directly.

### After adding `searchable()` to existing data

See [Adding `searchable()` to an Existing Graph](#adding-searchable-to-an-existing-graph)
above for the rebuild recipe and the caveats that apply to concurrent
workloads.

### `"Fulltext match predicates cannot be nested under OR or NOT"`

See [No `.matches()` Under OR or NOT](#no-matches-under-or-or-not)
above. Move the `$fulltext.matches()` to the top level or inside an
`.and()`.

### Hybrid results miss obvious matches

Increase the per-source `k` (over-fetch). The default is 4× the final
`limit`, which is tuned for small result pages. Large corpora benefit
from `k: 200` or higher on each side.

### Postgres: `text search configuration "xyz" does not exist`

The `language` you passed to `searchable({ language })` must be an
installed `regconfig` on your Postgres server. Every stock install ships
`simple`, `english`, `french`, `german`, `italian`, `portuguese`,
`russian`, `spanish`, and `swedish`; anything else requires an extension
(`zhparser` for Chinese, `pg_trgm` for trigram-based matching, or a
custom dictionary).

TypeGraph emits a `console.warn` at query time when you pass a language
outside the backend-advertised list, but a typo or missing extension
only fails when Postgres tries to build the `tsvector`. To diagnose:

```sql
SELECT cfgname FROM pg_ts_config;
```

Pick a name from that list, or install the extension that provides the
one you want. If you're running a managed Postgres (RDS, Supabase, Neon,
Cloud SQL, Aiven), check the provider's docs for which language extensions
are enabled — some require a restart or explicit enabling.

### Swapping to a custom fulltext strategy

See [Custom Fulltext Strategies](#custom-fulltext-strategies) for the
full interface, constraints, and a skeleton implementation.

## API Reference

- **Schema**: [`searchable()`](/queries/predicates#searchable)
- **Predicate**: [`n.$fulltext.matches()`](/queries/predicates#searchable)
- **Tunable fusion**: `QueryBuilder.fuseWith({ k, weights })`
- **Rebuild**: `store.search.rebuildFulltext(nodeKind?, { pageSize? })`
- **Store API**: `store.search.fulltext()` and `store.search.hybrid()` —
  see the [Schemas & Stores reference](/schemas-stores).

See also:

- [Semantic Search](/semantic-search) — vector embeddings and
  `.similarTo()`
- [Predicates reference](/queries/predicates) — complete predicate
  catalog
- [Knowledge Graph for RAG](/examples/knowledge-graph-rag) — end-to-end
  example combining fulltext, vector, and graph traversal
