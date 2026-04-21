import { expectAssignable, expectError } from "tsd";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  type FulltextSearchHit,
  type FulltextSearchOptions,
  type HybridSearchHit,
  type HybridSearchOptions,
  type Node,
  searchable,
  type SearchableMetadata,
  type Store,
} from "..";

// ============================================================
// searchable() schema — runtime values type as string
// ============================================================

const titleSchema = searchable();
expectAssignable<z.ZodString>(titleSchema);

const parsed = titleSchema.parse("hello");
expectAssignable<string>(parsed);

// With explicit language option
const ptSchema = searchable({ language: "portuguese" });
expectAssignable<z.ZodString>(ptSchema);

// The tag carries metadata reachable via the introspection key.
type Tagged = typeof titleSchema;
expectAssignable<{ _searchableField: SearchableMetadata }>(
  titleSchema as Tagged,
);

// searchable().optional() preserves string type
const optionalSchema = searchable().optional();
const optionalParsed = optionalSchema.parse(undefined);
expectAssignable<string | undefined>(optionalParsed);

// searchable().min(1) preserves plain-string inference. The runtime
// metadata walker in `getSearchableMetadata()` still sees this as a
// searchable field, so `$fulltext` works end-to-end even though the
// compile-time type is just `string`. This is why the type-level brand
// was removed — the runtime is the single source of truth.
const refinedSchema = searchable({ language: "english" }).min(1);
const refinedParsed = refinedSchema.parse("hello");
expectAssignable<string>(refinedParsed);

// ============================================================
// Store fulltext / hybrid search — public API typing
// ============================================================

const Article = defineNode("Article", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(1536),
  }),
});

const graph = defineGraph({
  id: "fts_test_graph",
  nodes: { Article: { type: Article } },
  edges: {},
});

declare const store: Store<typeof graph>;

// Typed return — hit.node is narrowed to the Article node type, so
// `hit.node.title` is directly accessible (no cast required).
expectAssignable<Promise<readonly FulltextSearchHit<Node<typeof Article>>[]>>(
  store.search.fulltext("Article", {
    query: "quarterly earnings",
    limit: 10,
  }),
);

// Default FulltextSearchHit (no generic arg) still works for declaration
declare const hit: FulltextSearchHit;
expectAssignable<Node>(hit.node);
expectAssignable<number>(hit.score);
expectAssignable<number>(hit.rank);
expectAssignable<string | undefined>(hit.snippet);

// Query mode union is enforced
const tryMode = (mode: FulltextSearchOptions["mode"]): void => {
  void mode;
};
tryMode("websearch");
tryMode("phrase");
tryMode("plain");
tryMode("raw");
tryMode(undefined);
expectError(tryMode("fuzzy"));

// Hybrid search — typed node narrowing applies to both top-level and
// sub-results (vector, fulltext).
expectAssignable<Promise<readonly HybridSearchHit<Node<typeof Article>>[]>>(
  store.search.hybrid("Article", {
    limit: 10,
    vector: {
      fieldPath: "embedding",
      queryEmbedding: new Array(1536).fill(0),
    },
    fulltext: { query: "earnings" },
    fusion: {
      method: "rrf",
      k: 60,
      weights: { vector: 1, fulltext: 1.5 },
    },
  }),
);

// HybridSearchHit carries sub-scores from each half
declare const hybridHit: HybridSearchHit;
expectAssignable<Node>(hybridHit.node);
expectAssignable<number>(hybridHit.score);
expectAssignable<number>(hybridHit.rank);
expectAssignable<
  Readonly<{ score: number; rank: number; node: Node }> | undefined
>(hybridHit.vector);
expectAssignable<
  | Readonly<{
      score: number;
      rank: number;
      node: Node;
      snippet?: string;
    }>
  | undefined
>(hybridHit.fulltext);

// Hybrid options — the fusion method union rejects unsupported values
const validOptions: HybridSearchOptions = {
  limit: 10,
  vector: { fieldPath: "embedding", queryEmbedding: [] },
  fulltext: { query: "x" },
  fusion: { method: "rrf" },
};
void validOptions;

// ============================================================
// $fulltext.matches() predicate — node-level accessor
// ============================================================
//
// $fulltext is exposed on every NodeAccessor at the type level. A
// runtime check throws if the node kind has no searchable() fields, so
// the API is uniform and refinements like `searchable().min(1)` don't
// make the accessor disappear.
//
// `k` is optional (defaults to 50 for single-predicate use; callers
// should pass a larger value when feeding into RRF fusion).

void store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) => a.$fulltext.matches("climate"));

void store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) => a.$fulltext.matches("climate", 10));

void store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) =>
    a.$fulltext.matches("warming", 10, { mode: "phrase" }),
  );

// Two `$fulltext.matches()` calls in one query type-check because the
// fluent predicate combinator is not branded against repeated fulltext
// use. The invariant "at most one fulltext predicate per query" is
// enforced at compile time by runFulltextPredicatePass, which throws
// UnsupportedPredicateError. This is called out in the fulltext docs
// so users know it surfaces at query build time, not via tsc.
void store
  .query()
  .from("Article", "a")
  .whereNode("a", (a) =>
    a.$fulltext.matches("climate", 20).and(a.$fulltext.matches("warming", 20)),
  );

// Regression: field-level `.matches()` was removed — only $fulltext has it.
expectError(
  store
    .query()
    .from("Article", "a")
    .whereNode("a", (a) => a.title.matches("climate", 10)),
);
