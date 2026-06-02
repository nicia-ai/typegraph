/**
 * Type-level tests (tsd) for the cross-backend vector / hybrid search public
 * API: the `embedding()` brand, the `store.search.vector` facade options +
 * hit shape, `store.reembedVectorField`, `migrateLegacyEmbeddings`, the
 * pluggable `VectorStrategy` strategies, `materializeRemovals`'
 * `reclaimedVectorFields`, and the typed `EmbeddingDimensionChangedError`.
 *
 * These complement the runtime tests by pinning the exported TYPE surface a
 * consumer compiles against (return shapes, required vs optional options,
 * callback signatures).
 */
import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  embedding,
  EmbeddingDimensionChangedError,
  type GraphBackend,
  getEmbeddingDimensions,
  libsqlVectorStrategy,
  migrateLegacyEmbeddings,
  type MigrateLegacyEmbeddingsResult,
  type Node,
  pgvectorStrategy,
  type ReclaimedVectorFieldEntry,
  type ReembedVectorFieldResult,
  sqliteVecStrategy,
  type Store,
  type VectorSearchHit,
  type VectorSearchOptions,
  type VectorSlot,
  type VectorStrategy,
} from "..";

const Doc = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(384),
  }),
});

const graph = defineGraph({
  id: "semantic_search_typetest",
  nodes: { Doc: { type: Doc } },
  edges: {},
});

declare const backend: GraphBackend;
const store: Store<typeof graph> = createStore(graph, backend);
const queryEmbedding: number[] = Array.from({ length: 384 }, () => 0.1);

// ============================================================
// embedding() brand
// ============================================================

const embeddingSchema = embedding(384);
expectAssignable<z.ZodType>(embeddingSchema);
expectType<number | undefined>(getEmbeddingDimensions(embeddingSchema));

// ============================================================
// store.search.vector — options + hit shape
// ============================================================

// All of fieldPath / queryEmbedding / limit are required; metric / minScore /
// efSearch are optional.
const vectorOptions: VectorSearchOptions = {
  fieldPath: "embedding",
  queryEmbedding,
  limit: 10,
  metric: "cosine",
  minScore: 0.7,
  efSearch: 240,
};
expectAssignable<VectorSearchOptions>(vectorOptions);

// Missing a required field is a type error.
expectError<VectorSearchOptions>({ fieldPath: "embedding", limit: 10 });
expectError<VectorSearchOptions>({ queryEmbedding, limit: 10 });
expectError<VectorSearchOptions>({ fieldPath: "embedding", queryEmbedding });

declare const vectorHits: Awaited<
  ReturnType<typeof store.search.vector<"Doc">>
>;
const vectorHit = vectorHits[0]!;
expectAssignable<Node<typeof Doc>>(vectorHit.node);
expectType<number>(vectorHit.score);
expectType<number>(vectorHit.rank);
expectAssignable<VectorSearchHit>(vectorHit);

// ============================================================
// store.reembedVectorField — result + embed callback signature
// ============================================================

declare const reembedResult: ReembedVectorFieldResult;
expectType<boolean>(reembedResult.recreated);
expectType<number>(reembedResult.reembedded);

// embed receives a page of base nodes and returns a Map from node id to vector.
const reembed: Promise<ReembedVectorFieldResult> = store.reembedVectorField(
  "Doc",
  "embedding",
  {
    embed: (nodes) => {
      expectAssignable<readonly Node[]>(nodes);
      return new Map(nodes.map((node) => [node.id, queryEmbedding]));
    },
    batchSize: 100,
  },
);
expectAssignable<Promise<ReembedVectorFieldResult>>(reembed);

// ============================================================
// migrateLegacyEmbeddings — result shape + required backend
// ============================================================

const migrate = migrateLegacyEmbeddings({ backend, batchSize: 500 });
expectType<Promise<MigrateLegacyEmbeddingsResult>>(migrate);
expectError(migrateLegacyEmbeddings({}));

declare const migrateResult: MigrateLegacyEmbeddingsResult;
expectType<number>(migrateResult.migrated);
expectAssignable<Readonly<Record<string, number>>>(migrateResult.perField);
expectAssignable<Readonly<Record<string, number>>>(
  migrateResult.skippedDimensionMismatch,
);
expectType<boolean>(migrateResult.legacyTablePresent);

// ============================================================
// Pluggable strategies are VectorStrategy
// ============================================================

expectAssignable<VectorStrategy>(sqliteVecStrategy);
expectAssignable<VectorStrategy>(pgvectorStrategy);
expectAssignable<VectorStrategy>(libsqlVectorStrategy);
expectType<string>(sqliteVecStrategy.tableName("g1", "Doc", "embedding"));
declare const slot: VectorSlot;
expectType<number>(slot.dimensions);

// ============================================================
// materializeRemovals — reclaimedVectorFields
// ============================================================

const removals = store.materializeRemovals();
expectAssignable<Promise<{ reclaimedVectorFields: readonly unknown[] }>>(
  removals,
);
declare const reclaimed: ReclaimedVectorFieldEntry;
expectType<string>(reclaimed.kind);
expectType<string>(reclaimed.fieldPath);
expectAssignable<"reclaimed" | "failed">(reclaimed.status);

// ============================================================
// .similarTo() builder predicate composes in whereNode
// ============================================================

const similarQuery = store
  .query()
  .from("Doc", "d")
  .whereNode("d", (d) =>
    d.embedding
      .similarTo(queryEmbedding, 10, { metric: "cosine", minScore: 0.7 })
      .and(d.title.eq("x")),
  )
  .select((ctx) => ({ title: ctx.d.title }));
expectAssignable<object>(similarQuery);

// ============================================================
// EmbeddingDimensionChangedError is an Error
// ============================================================

declare const dimError: EmbeddingDimensionChangedError;
expectAssignable<Error>(dimError);
