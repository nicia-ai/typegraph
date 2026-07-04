/**
 * StoreSearch — store.search facade.
 *
 * Groups fulltext, vector, hybrid, and maintenance operations under one
 * namespace so the top-level Store API stays focused on CRUD + graph
 * traversal. The methods delegate to their respective execution
 * modules; this class exists to shape the surface and to gate kind
 * names through the registry — the kind argument is `string` so
 * graph-extension kinds (added via `store.evolve()`) work without a
 * type cast, with a runtime guard rejecting misspellings at the call
 * site.
 */
import { type GraphBackend } from "../backend/types";
import { type GraphDef, type NodeKinds } from "../core/define-graph";
import { type NodeRegistration, type NodeType } from "../core/types";
import { KindNotFoundError } from "../errors";
import { type QueryBuilder } from "../query/builder/query-builder";
import { type KindRegistry } from "../registry/kind-registry";
import {
  rebuildFulltextIndex,
  type RebuildFulltextOptions,
  type RebuildFulltextResult,
} from "./fulltext-rebuild";
import {
  executeFulltextSearch,
  executeHybridSearch,
  executeVectorSearch,
  type FulltextSearchHit,
  type FulltextSearchOptions,
  type HybridSearchHit,
  type HybridSearchOptions,
  type VectorSearchHit,
  type VectorSearchOptions,
} from "./search";
import { type Node } from "./types";

/**
 * Resolves the hit's `node` type. Compile-time kinds keep their
 * narrowed `Node<N>`; kinds outside `G` (added via graph extension through
 * `store.evolve()`, or string variables the type system can't see)
 * widen to the base `Node` so callers don't need a cast.
 *
 * This is the same shape as `getNodeCollection` — the dynamic form
 * works for any registered kind, and the type narrows when (and only
 * when) the literal is statically known.
 */
type ResolveNode<G extends GraphDef, K extends string> =
  K extends NodeKinds<G> ?
    G["nodes"][K] extends NodeRegistration<infer N extends NodeType> ?
      Node<N>
    : Node
  : Node;

/**
 * The registered `NodeType` behind a kind literal — the accessor-level
 * companion of {@link ResolveNode}, used to type `where` predicates.
 * Falls back to the base `NodeType` for dynamic (string) kinds.
 */
type ResolveNodeType<G extends GraphDef, K extends string> =
  K extends NodeKinds<G> ?
    G["nodes"][K] extends NodeRegistration<infer N extends NodeType> ?
      N
    : NodeType
  : NodeType;

type StoreSearchContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  registry: KindRegistry;
  createQuery?: () => QueryBuilder<GraphDef>;
}>;

/**
 * Search-related operations exposed via `store.search`.
 *
 * @example
 * ```typescript
 * // Fulltext only
 * const hits = await store.search.fulltext("Document", {
 *   query: "climate change",
 *   limit: 10,
 *   includeSnippets: true,
 * });
 *
 * // Vector only — for extension kinds with embedding() modifiers,
 * // the auto-derived index serves this query.
 * const nearest = await store.search.vector("Document", {
 *   fieldPath: "embedding",
 *   queryEmbedding: vec,
 *   limit: 10,
 * });
 *
 * // Hybrid: vector + fulltext, fused with RRF
 * const ranked = await store.search.hybrid("Document", {
 *   limit: 10,
 *   vector: { fieldPath: "embedding", queryEmbedding: vec },
 *   fulltext: { query: "climate change" },
 * });
 *
 * // Rebuild after backfill / schema change
 * const stats = await store.search.rebuildFulltext();
 * ```
 *
 * Extension kinds added via `store.evolve(...)` work with all four
 * methods without a type cast — the kind argument is `string` and a
 * registry check rejects misspellings at the call site.
 */
export class StoreSearch<G extends GraphDef> {
  readonly #context: StoreSearchContext;

  constructor(context: StoreSearchContext) {
    this.#context = context;
  }

  /**
   * Runs a fulltext search against nodes of the given kind.
   *
   * Requires fields on the node schema declared with `searchable()`.
   * The search hits the backend's fulltext index (tsvector + GIN on
   * Postgres, FTS5 on SQLite — or whatever strategy the backend is
   * configured with) and resolves the matching node IDs back to typed
   * `Node` objects.
   */
  async fulltext<K extends string>(
    nodeKind: K,
    options: FulltextSearchOptions<ResolveNodeType<G, K>>,
  ): Promise<readonly FulltextSearchHit<ResolveNode<G, K>>[]> {
    this.#assertKindRegistered(nodeKind);
    return executeFulltextSearch<ResolveNode<G, K>>(
      this.#context,
      nodeKind,
      // Contravariance: the narrowed accessor callback is intentionally
      // wider than the base instantiation the core helpers take.
      options as unknown as FulltextSearchOptions,
    );
  }

  /**
   * Runs a vector similarity search against nodes of the given kind.
   *
   * Requires a field on the node schema declared with `embedding()`,
   * either at compile time or via a graph extension (the auto-derived
   * `VectorIndexDeclaration` flows through `materializeIndexes()` on
   * the same path either way).
   *
   * Pure vector — no fulltext leg, no fusion. For combined
   * vector+fulltext ranking, use `hybrid`.
   */
  async vector<K extends string>(
    nodeKind: K,
    options: VectorSearchOptions<ResolveNodeType<G, K>>,
  ): Promise<readonly VectorSearchHit<ResolveNode<G, K>>[]> {
    this.#assertKindRegistered(nodeKind);
    return executeVectorSearch<ResolveNode<G, K>>(
      this.#context,
      nodeKind,
      // Contravariance: the narrowed accessor callback is intentionally
      // wider than the base instantiation the core helpers take.
      options as unknown as VectorSearchOptions,
    );
  }

  /**
   * Runs a vector + fulltext hybrid search and fuses the results with
   * Reciprocal Rank Fusion.
   *
   * RRF is rank-based, so it composes well across heterogeneous score
   * scales (cosine similarity vs ts_rank_cd vs FTS5 BM25). Default
   * over-fetch is 4× `limit` from each source — tune via `vector.k` /
   * `fulltext.k` for higher-recall corpora.
   */
  async hybrid<K extends string>(
    nodeKind: K,
    options: HybridSearchOptions<ResolveNodeType<G, K>>,
  ): Promise<readonly HybridSearchHit<ResolveNode<G, K>>[]> {
    this.#assertKindRegistered(nodeKind);
    return executeHybridSearch<ResolveNode<G, K>>(
      this.#context,
      nodeKind,
      // Contravariance: the narrowed accessor callback is intentionally
      // wider than the base instantiation the core helpers take.
      options as unknown as HybridSearchOptions,
    );
  }

  /**
   * Rebuilds the fulltext index from existing node data.
   *
   * Use when:
   * - A node kind gained a `searchable()` field after data was already
   *   written and existing rows were never indexed.
   * - The fulltext table was dropped / truncated.
   * - `language` was changed on a `searchable()` field.
   *
   * Iterates nodes with keyset pagination (stable under shared
   * timestamps and light concurrent writes), transacts per page, skips
   * kinds with no searchable fields, and cleans up stale rows for
   * soft-deleted nodes. Corrupt or non-object `props` are counted in
   * `skipped` with their node IDs surfaced via `skippedIds` so operators
   * can investigate. Concurrent hard-deletes between page fetches can
   * be missed by a single pass — run during a maintenance window for
   * full consistency.
   */
  async rebuildFulltext<K extends string>(
    nodeKind?: K,
    options: RebuildFulltextOptions = {},
  ): Promise<RebuildFulltextResult> {
    if (nodeKind !== undefined) this.#assertKindRegistered(nodeKind);
    return rebuildFulltextIndex(
      {
        graphId: this.#context.graphId,
        backend: this.#context.backend,
        registry: this.#context.registry,
      },
      nodeKind,
      options,
    );
  }

  #assertKindRegistered(kind: string): void {
    if (this.#context.registry.hasNodeType(kind)) return;
    throw new KindNotFoundError(kind, "node", {
      graphId: this.#context.graphId,
      suggestion:
        "Compile-time kinds come from defineGraph; extension kinds appear after store.evolve() returns. Check store.introspect() for the registered set.",
    });
  }
}
