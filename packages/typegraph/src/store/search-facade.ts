/**
 * StoreSearch — store.search facade.
 *
 * Groups fulltext, hybrid, and maintenance operations under one
 * namespace so the top-level Store API stays focused on CRUD + graph
 * traversal. The three methods delegate to their respective execution
 * modules; this class exists purely to shape the surface, not to add
 * behavior.
 */
import { type GraphBackend } from "../backend/types";
import { type GraphDef, type NodeKinds } from "../core/define-graph";
import { type NodeRegistration, type NodeType } from "../core/types";
import { type KindRegistry } from "../registry/kind-registry";
import {
  rebuildFulltextIndex,
  type RebuildFulltextOptions,
  type RebuildFulltextResult,
} from "./fulltext-rebuild";
import {
  executeFulltextSearch,
  executeHybridSearch,
  type FulltextSearchHit,
  type FulltextSearchOptions,
  type HybridSearchHit,
  type HybridSearchOptions,
} from "./search";
import { type Node } from "./types";

/**
 * Narrows `Node` to the concrete typed node for a given kind in the graph.
 */
type NodeOfKind<G extends GraphDef, K extends NodeKinds<G>> =
  G["nodes"][K] extends NodeRegistration<infer N extends NodeType> ? Node<N>
  : Node;

type StoreSearchContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  registry: KindRegistry;
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
  async fulltext<K extends NodeKinds<G>>(
    nodeKind: K,
    options: FulltextSearchOptions,
  ): Promise<readonly FulltextSearchHit<NodeOfKind<G, K>>[]> {
    return executeFulltextSearch<NodeOfKind<G, K>>(
      { graphId: this.#context.graphId, backend: this.#context.backend },
      nodeKind,
      options,
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
  async hybrid<K extends NodeKinds<G>>(
    nodeKind: K,
    options: HybridSearchOptions,
  ): Promise<readonly HybridSearchHit<NodeOfKind<G, K>>[]> {
    return executeHybridSearch<NodeOfKind<G, K>>(
      { graphId: this.#context.graphId, backend: this.#context.backend },
      nodeKind,
      options,
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
  async rebuildFulltext<K extends NodeKinds<G>>(
    nodeKind?: K,
    options: RebuildFulltextOptions = {},
  ): Promise<RebuildFulltextResult> {
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
}
