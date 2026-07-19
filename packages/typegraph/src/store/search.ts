/**
 * Store-level search helpers.
 *
 * `fulltextSearch` is a thin typed wrapper over `backend.fulltextSearch`.
 * `hybridSearch` runs a vector and a fulltext query in parallel and
 * fuses the two ranked lists with Reciprocal Rank Fusion. RRF is
 * rank-based, so it papers over score-scale differences between
 * pgvector/sqlite-vec (distance-derived) and tsvector/FTS5 (BM25-style).
 */
import {
  type FulltextCapabilities,
  type FulltextQueryMode,
  type GraphBackend,
  type VectorIndexType,
  type VectorMetric,
} from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { resolveDeclaredFulltextLanguage } from "../core/searchable";
import { type NodeType } from "../core/types";
import { ConfigurationError } from "../errors";
import {
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHT,
  type HybridFusionOptions,
} from "../query/ast";
import { type QueryBuilder } from "../query/builder/query-builder";
import { type NodeAccessor } from "../query/builder/types";
import { validateHybridFusionOptions } from "../query/builder/validation";
import { type FulltextStrategy } from "../query/dialect/fulltext-strategy";
import { assertVectorMinScore } from "../query/dialect/vector-strategy";
import { type Predicate } from "../query/predicates";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { type KindRegistry } from "../registry/kind-registry";
import { compareCodePoints } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import { getEmbeddingFields } from "./embedding-sync";
import { rowToNode } from "./row-mappers";
import { type Node } from "./types";

/**
 * A fulltext search hit. `N` defaults to the generic `Node`; the
 * `store.search.fulltext<K>(kind)` facade narrows it to the concrete
 * typed node for that kind so callers get `hit.node.title` without a cast.
 */
export type FulltextSearchHit<N = Node> = Readonly<{
  node: N;
  /** Backend-native relevance score; higher is better. */
  score: number;
  /** 1-based rank within the result set. */
  rank: number;
  /** Highlighted snippet (only present when `includeSnippets: true`). */
  snippet?: string;
}>;

export type VectorSearchHit<N = Node> = Readonly<{
  node: N;
  score: number;
  rank: number;
}>;

/**
 * A hybrid search hit. Both sub-results (`vector`, `fulltext`) carry the
 * same narrowed node type as the top-level `node` for ergonomic access.
 */
export type HybridSearchHit<N = Node> = Readonly<{
  node: N;
  /** Fused RRF score (higher is better). */
  score: number;
  /** 1-based rank in the fused list. */
  rank: number;
  /** Sub-result from the vector half, if it ranked this node. */
  vector?: VectorSearchHit<N>;
  /** Sub-result from the fulltext half, if it ranked this node. */
  fulltext?: FulltextSearchHit<N>;
}>;

/**
 * Scope options shared by every facade search leg.
 *
 * `where` and `includeSubClasses` compile into the search statement's
 * candidate set (a subquery produced by the store's own query compiler), so
 * filtering happens INSIDE the engine's top-k — never by post-filtering a
 * ranked list. `offset` is rank-relative pagination: the engine fetches
 * `limit + offset` ranked candidates and discards the leading page.
 */
export type SearchScopeOptions<N extends NodeType = NodeType> = Readonly<{
  /**
   * Predicate over the node's properties, compiled by the shared query
   * compiler into the candidate subquery. Requires a query-capable store.
   * The facade instantiates `N` to the searched kind's node type, so the
   * accessor is fully typed at the call site; the base instantiation
   * exposes the system accessors (`id`, `kind`) for standalone option
   * values.
   */
  where?: (accessor: NodeAccessor<N>) => Predicate;
  /** Rows to skip after ranking (rank-relative pagination). */
  offset?: number;
  /**
   * Expand the searched kind to include its `subClassOf` descendants.
   * Vector legs search each declaring kind's storage and merge by score;
   * kinds that don't declare the embedding field are skipped (mirroring
   * the query builder). Requires a query-capable store.
   */
  includeSubClasses?: boolean;
}>;

export type FulltextSearchOptions<N extends NodeType = NodeType> =
  SearchScopeOptions<N> &
    Readonly<{
      /** The user-supplied query string. */
      query: string;
      /** Max results. Required. */
      limit: number;
      /** Query parser mode. Default: "websearch". */
      mode?: FulltextQueryMode;
      /**
       * Language override for query parsing. Default: the kind's
       * declared language (the same config rows were indexed with),
       * which keeps the parsed tsquery a plan-time constant on
       * PostgreSQL so the GIN index can serve the match.
       */
      language?: string;
      /** Minimum relevance score to include in results. */
      minScore?: number;
      /** Return a highlighted snippet alongside each hit. */
      includeSnippets?: boolean;
    }>;

export type HybridVectorOptions = Readonly<{
  /** Field path of the embedding column on the node kind. */
  fieldPath: string;
  /** Query embedding to compare against. */
  queryEmbedding: readonly number[];
  /** Distance metric. Default: "cosine". */
  metric?: VectorMetric;
  /** How many candidates to retrieve from the vector side. Default: 4 * limit. */
  k?: number;
  /** Minimum similarity to include (units depend on metric). */
  minScore?: number;
  /**
   * HNSW search frontier for this query (pgvector `hnsw.ef_search`).
   * The vector side over-fetches `k` (default `4 * limit`) candidates;
   * `efSearch` must be `>= k` for the index to surface that many
   * neighbors, and ~2–4× `k` is the high-recall target. Postgres HNSW
   * only — no-op elsewhere. See `VectorSearchOptions.efSearch`.
   */
  efSearch?: number;
}>;

/**
 * Options for the standalone `store.search.vector` path. Mirrors the
 * vector half of `HybridSearchOptions` but flattens it because the
 * standalone path doesn't fuse against fulltext.
 */
export type VectorSearchOptions<N extends NodeType = NodeType> =
  SearchScopeOptions<N> &
    Readonly<{
      /** Field path of the embedding column on the node kind. */
      fieldPath: string;
      /** Query embedding to compare against. */
      queryEmbedding: readonly number[];
      /** Max results. Required. */
      limit: number;
      /** Distance metric. Default: "cosine". */
      metric?: VectorMetric;
      /** Minimum similarity to include (units depend on metric). */
      minScore?: number;
      /**
       * HNSW search frontier for this query (pgvector `hnsw.ef_search`).
       * Sizes the dynamic candidate list the index scan maintains — higher
       * trades latency for recall. The floor for the index to surface
       * `limit` neighbors is `efSearch >= limit`; ~2–4× is the high-recall
       * target on million-scale corpora. Lets a latency-sensitive
       * interactive path and a recall-sensitive batch path share one
       * connection pool, tuning per query rather than per session.
       *
       * Postgres HNSW only: applied transaction-locally via `SET LOCAL`.
       * sqlite-vec has no equivalent frontier knob and ignores it; Postgres
       * backends without transactions (`drizzle-orm/neon-http`) ignore it
       * with a one-time warning. Must be a positive integer; pgvector caps
       * it at 1000.
       */
      efSearch?: number;
    }>;

export type HybridFulltextOptions = Readonly<{
  query: string;
  /** How many candidates to retrieve from the fulltext side. Default: 4 * limit. */
  k?: number;
  mode?: FulltextQueryMode;
  language?: string;
  minScore?: number;
  includeSnippets?: boolean;
}>;

export type HybridSearchOptions<N extends NodeType = NodeType> =
  SearchScopeOptions<N> &
    Readonly<{
      vector: HybridVectorOptions;
      fulltext: HybridFulltextOptions;
      fusion?: HybridFusionOptions;
      /** Final number of fused results to return. Required. */
      limit: number;
    }>;

type StoreSearchContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
  registry: KindRegistry;
  /**
   * Builds a fresh query for candidate compilation (`store.query()`, the
   * same seam collection `find({ where })` uses). Optional so a bare
   * context still supports unscoped searches; `where` /
   * `includeSubClasses` throw without it.
   */
  createQuery?: () => QueryBuilder<GraphDef>;
}>;

/**
 * Internal alias for the candidate query. The compiled query prefixes its
 * output columns with the alias, so the id column is `"_sc_id"`.
 */
const SEARCH_CANDIDATE_ALIAS = "_sc";

/**
 * Compiles the candidate subquery for one kind: the ids of nodes a search
 * statement may rank. Runs the store's own query compiler, so the
 * predicate, valid-time currency, tombstone exclusion, and graph scoping
 * are exactly the semantics of a `current` read — search can never return
 * (or lose top-k slots to) rows a `find()` would not see.
 *
 * Compiled ONLY when a `where` predicate exists: the unfiltered case
 * returns `undefined` so the backend supplies its flat, parameter-bound
 * current-read candidates (same semantics, far cheaper — the compiled
 * query's per-row SQL now() currency checks measurably dominated
 * unfiltered facade searches on SQLite and planned poorly on Postgres).
 */
function buildKindCandidates(
  ctx: StoreSearchContext,
  nodeKind: string,
  where: ((accessor: NodeAccessor<NodeType>) => Predicate) | undefined,
): SqlFragment | undefined {
  if (where === undefined) return undefined;
  if (ctx.createQuery === undefined) {
    throw new ConfigurationError(
      "search with a where predicate requires a query-capable store",
      { capability: "search", graphId: ctx.graphId },
    );
  }
  const chain = ctx
    .createQuery()
    .from(nodeKind, SEARCH_CANDIDATE_ALIAS)
    .whereNode(SEARCH_CANDIDATE_ALIAS, where);
  const compiled = chain
    .select(
      (aliases: Record<string, unknown>) => aliases[SEARCH_CANDIDATE_ALIAS],
    )
    .compile();
  return sql`SELECT ${sql.raw(`"${SEARCH_CANDIDATE_ALIAS}_id"`)} AS node_id FROM (${compiled}) AS tg_search_candidates`;
}

/**
 * The kinds one search call spans: the kind itself, plus its `subClassOf`
 * descendants when requested.
 */
function resolveSearchKinds(
  ctx: StoreSearchContext,
  nodeKind: string,
  includeSubClasses: boolean | undefined,
): readonly string[] {
  if (includeSubClasses !== true) return [nodeKind];
  if (ctx.createQuery === undefined) {
    throw new ConfigurationError(
      "search with includeSubClasses requires a query-capable store",
      { capability: "search", graphId: ctx.graphId },
    );
  }
  return ctx.registry.expandSubClasses(nodeKind);
}

function assertSearchOffset(offset: number | undefined, label: string): void {
  if (offset === undefined) return;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(
      `${label} must be a non-negative integer, got: ${offset}`,
    );
  }
}

/**
 * The language a fulltext query should be parsed with for one kind: the
 * caller's explicit override, else the kind's DECLARED language (the one
 * its rows were written with). Passing the declared language keeps the
 * tsquery CONSTANT, so PostgreSQL's GIN index on `tsv` can serve the
 * match — the per-row `websearch_to_tsquery("language", ...)` fallback
 * (used only when the kind declares no searchable fields) forces a scan.
 */
function effectiveFulltextLanguage(
  ctx: StoreSearchContext,
  nodeKind: string,
  override: string | undefined,
): string | undefined {
  if (override !== undefined) return override;
  const nodeType = ctx.registry.getNodeType(nodeKind);
  if (nodeType === undefined) return undefined;
  return resolveDeclaredFulltextLanguage(nodeType.schema);
}

/** A ranked row tagged with the kind whose search leg produced it. */
type RankedSourceRow = Readonly<{
  kind: string;
  nodeId: string;
  score: number;
  snippet?: string;
}>;

/** Node ids are unique per kind, not globally — key hydration by both. */
function searchNodeKey(kind: string, nodeId: string): string {
  return `${kind}\u0000${nodeId}`;
}

/**
 * Whether higher scores rank first for a metric. Cosine scores are
 * similarities (`1 - distance`); l2 / inner_product scores are the raw
 * distance expression, where lower is better (matching each strategy's
 * `ORDER BY distance ASC`).
 */
function scoreDescending(metric: VectorMetric): boolean {
  return metric === "cosine";
}

/**
 * Hydrates ranked rows spanning multiple kinds. One batched fetch per
 * kind, results keyed by {@link searchNodeKey}.
 */
async function fetchNodesForRows(
  backend: GraphBackend,
  graphId: string,
  rows: readonly RankedSourceRow[],
): Promise<Map<string, Node>> {
  const idsByKind = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = idsByKind.get(row.kind) ?? new Set<string>();
    ids.add(row.nodeId);
    idsByKind.set(row.kind, ids);
  }
  const map = new Map<string, Node>();
  await Promise.all(
    [...idsByKind].map(async ([kind, ids]) => {
      const kindMap = await fetchNodesByIds(backend, graphId, kind, [...ids]);
      for (const [id, node] of kindMap) {
        map.set(searchNodeKey(kind, id), node);
      }
    }),
  );
  return map;
}

/**
 * Resolved storage identity of one embedding field on a concrete node
 * kind — the `(dimensions, metric, indexType)` the backend needs (in
 * addition to the runtime `metric` override) to address the field's
 * typed per-`(kind, field)` storage slot during search.
 */
type ResolvedSearchSlot = Readonly<{
  dimensions: number;
  metric: VectorMetric;
  indexType: VectorIndexType;
}>;

/**
 * Resolves the `(dimensions, metric, indexType)` for a node kind's
 * embedding field from the registered node schema's `embedding()`
 * declaration. Throws a `ConfigurationError` when the kind has no such
 * embedding field so the caller gets a clear boundary error instead of a
 * downstream missing-table failure.
 */
function tryResolveSearchSlot(
  ctx: StoreSearchContext,
  nodeKind: string,
  fieldPath: string,
): ResolvedSearchSlot | undefined {
  const nodeType = ctx.registry.getNodeType(nodeKind);
  if (nodeType === undefined) return undefined;
  const fields = getEmbeddingFields(nodeType.schema);
  const field = fields.find((entry) => entry.fieldPath === fieldPath);
  if (field === undefined) return undefined;
  return {
    dimensions: field.dimensions,
    metric: field.metric,
    indexType: field.indexType,
  };
}

function resolveSearchSlot(
  ctx: StoreSearchContext,
  nodeKind: string,
  fieldPath: string,
): ResolvedSearchSlot {
  const slot = tryResolveSearchSlot(ctx, nodeKind, fieldPath);
  if (slot !== undefined) return slot;
  throw new ConfigurationError(
    `Node kind "${nodeKind}" has no embedding field "${fieldPath}". ` +
      `Declare it with embedding(dimensions) on the node schema.`,
    { capability: "vector", graphId: ctx.graphId },
  );
}

export async function executeFulltextSearch<N = Node>(
  ctx: StoreSearchContext,
  nodeKind: string,
  options: FulltextSearchOptions,
): Promise<readonly FulltextSearchHit<N>[]> {
  const { backend, graphId } = ctx;
  if (!backend.fulltextSearch) {
    throw new ConfigurationError("Backend does not support fulltext search", {
      backend: backend.dialect,
      capability: "fulltext",
    });
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError(
      `fulltextSearch.limit must be a positive integer, got: ${options.limit}`,
    );
  }
  assertSearchOffset(options.offset, "fulltextSearch.offset");
  validateFulltextCallOptions(backend, {
    mode: options.mode,
    includeSnippets: options.includeSnippets,
    language: options.language,
  });

  const kinds = resolveSearchKinds(ctx, nodeKind, options.includeSubClasses);
  const offset = options.offset ?? 0;
  const singleKind = kinds.length === 1;

  const perKindRows = await Promise.all(
    kinds.map(async (kind): Promise<readonly RankedSourceRow[]> => {
      const candidates = buildKindCandidates(ctx, kind, options.where);
      const language = effectiveFulltextLanguage(ctx, kind, options.language);
      const rows = await requireDefined(backend.fulltextSearch)({
        graphId,
        nodeKind: kind,
        query: options.query,
        // A single kind pushes the page into SQL; multiple kinds fetch
        // each kind's full page-covering prefix and re-slice after merge.
        limit: singleKind ? options.limit : options.limit + offset,
        ...(singleKind && offset > 0 ? { offset } : {}),
        ...(candidates === undefined ? {} : { candidates }),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(language === undefined ? {} : { language }),
        ...(options.minScore === undefined ?
          {}
        : { minScore: options.minScore }),
        ...(options.includeSnippets === undefined ?
          {}
        : { includeSnippets: options.includeSnippets }),
      });
      return rows.map((row) => ({
        kind,
        nodeId: row.nodeId,
        score: row.score,
        ...(row.snippet === undefined ? {} : { snippet: row.snippet }),
      }));
    }),
  );

  const merged =
    singleKind ?
      requireDefined(perKindRows[0])
    : perKindRows
        .flat()
        .toSorted(
          (a, b) =>
            b.score - a.score ||
            compareCodePoints(a.kind, b.kind) ||
            compareCodePoints(a.nodeId, b.nodeId),
        )
        .slice(offset, offset + options.limit);
  if (merged.length === 0) return [];

  const nodeMap = await fetchNodesForRows(backend, graphId, merged);

  const hits: FulltextSearchHit<N>[] = [];
  let rank = 1;
  for (const row of merged) {
    const node = nodeMap.get(searchNodeKey(row.kind, row.nodeId));
    if (!node) continue;
    hits.push({
      node: node as N,
      score: row.score,
      rank,
      ...(row.snippet === undefined ? {} : { snippet: row.snippet }),
    });
    rank += 1;
  }
  return hits;
}

export async function executeVectorSearch<N = Node>(
  ctx: StoreSearchContext,
  nodeKind: string,
  options: VectorSearchOptions,
): Promise<readonly VectorSearchHit<N>[]> {
  const { backend, graphId } = ctx;
  if (!backend.vectorSearch) {
    throw new ConfigurationError("Backend does not support vector search", {
      backend: backend.dialect,
      capability: "vector",
    });
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError(
      `vectorSearch.limit must be a positive integer, got: ${options.limit}`,
    );
  }
  assertEfSearch(options.efSearch, "vectorSearch.efSearch");
  assertSearchOffset(options.offset, "vectorSearch.offset");

  const searchKinds = resolveVectorSearchKinds(
    ctx,
    nodeKind,
    options.fieldPath,
    options.includeSubClasses,
    "vectorSearch",
  );
  for (const { slot } of searchKinds) {
    assertVectorQueryCompatible(
      backend,
      slot,
      { metric: options.metric, queryEmbedding: options.queryEmbedding },
      "vectorSearch",
    );
    assertMinScore(
      options.minScore,
      options.metric ?? slot.metric,
      "vectorSearch.minScore",
    );
  }
  const offset = options.offset ?? 0;
  const singleKind = searchKinds.length === 1;
  const metric = options.metric ?? requireDefined(searchKinds[0]).slot.metric;

  const perKindRows = await Promise.all(
    searchKinds.map(
      async ({ kind, slot }): Promise<readonly RankedSourceRow[]> => {
        const candidates = buildKindCandidates(ctx, kind, options.where);
        const rows = await requireDefined(backend.vectorSearch)({
          graphId,
          nodeKind: kind,
          fieldPath: options.fieldPath,
          queryEmbedding: options.queryEmbedding,
          // Default to the field's DECLARED metric (the metric its index was
          // built for); only an explicit caller override changes it.
          // Defaulting to cosine here would mis-rank l2 / inner_product
          // fields and bypass their ANN index.
          metric,
          dimensions: slot.dimensions,
          indexType: slot.indexType,
          // A single kind pushes the page into SQL; multiple kinds fetch
          // each kind's full page-covering prefix and re-slice after merge.
          limit: singleKind ? options.limit : options.limit + offset,
          ...(singleKind && offset > 0 ? { offset } : {}),
          ...(candidates === undefined ? {} : { candidates }),
          ...(options.minScore === undefined ?
            {}
          : { minScore: options.minScore }),
          ...(options.efSearch === undefined ?
            {}
          : { efSearch: options.efSearch }),
        });
        return rows.map((row) => ({
          kind,
          nodeId: row.nodeId,
          score: row.score,
        }));
      },
    ),
  );

  const merged =
    singleKind ?
      requireDefined(perKindRows[0])
    : mergeVectorRows(perKindRows, metric).slice(
        offset,
        offset + options.limit,
      );
  if (merged.length === 0) return [];

  const nodeMap = await fetchNodesForRows(backend, graphId, merged);

  const hits: VectorSearchHit<N>[] = [];
  let rank = 1;
  for (const row of merged) {
    const node = nodeMap.get(searchNodeKey(row.kind, row.nodeId));
    if (!node) continue;
    hits.push({ node: node as N, score: row.score, rank });
    rank += 1;
  }
  return hits;
}

/** One vector-search target: a kind and its resolved embedding slot. */
type VectorSearchKind = Readonly<{ kind: string; slot: ResolvedSearchSlot }>;

/**
 * Resolves the kinds a vector search spans, keeping only kinds that
 * declare the embedding field (mirroring the query builder, which skips
 * non-declaring kinds instead of referencing a table that was never
 * created). Enforces one shared declared metric across the expansion:
 * scores from different metrics cannot be merged into one ranking, and a
 * per-call metric override cannot bridge the gap either (each kind's
 * storage is built for — and validated against — its declared metric), so
 * mixed declared metrics are unsupported for cross-kind ranking.
 */
function resolveVectorSearchKinds(
  ctx: StoreSearchContext,
  nodeKind: string,
  fieldPath: string,
  includeSubClasses: boolean | undefined,
  label: string,
): readonly VectorSearchKind[] {
  const kinds = resolveSearchKinds(ctx, nodeKind, includeSubClasses);
  const resolved: VectorSearchKind[] = [];
  for (const kind of kinds) {
    const slot = tryResolveSearchSlot(ctx, kind, fieldPath);
    if (slot !== undefined) resolved.push({ kind, slot });
  }
  // No declaring kind: surface the standard configuration error for the
  // requested kind.
  if (resolved.length === 0) resolveSearchSlot(ctx, nodeKind, fieldPath);
  const metrics = new Set(resolved.map(({ slot }) => slot.metric));
  if (metrics.size > 1) {
    throw new ConfigurationError(
      `${label}: kinds expanded from "${nodeKind}" declare different ` +
        `metrics for "${fieldPath}" (${[...metrics].join(", ")}). ` +
        `Cross-kind vector ranking requires one shared declared metric — ` +
        `search the kinds separately.`,
      { capability: "vector", graphId: ctx.graphId },
    );
  }
  return resolved;
}

/**
 * Merges per-kind ranked rows into one globally ordered list.
 *
 * Applied even to a single kind's rows, whose SQL already ordered them. The
 * vector source SQL breaks a score tie arbitrarily (no `node_id` tiebreak — a
 * second sort key would cost pgvector its ordered index scan), so trusting its
 * arrival order would make the rank a source of nondeterminism. The
 * single-statement hybrid path re-ranks the very same rows with
 * `ROW_NUMBER() OVER (ORDER BY score …, node_id)`; this is that window, in JS.
 * Ranks feed the fusion, so the two paths must assign them identically.
 */
function mergeVectorRows(
  perKindRows: readonly (readonly RankedSourceRow[])[],
  metric: VectorMetric,
): readonly RankedSourceRow[] {
  const descending = scoreDescending(metric);
  return perKindRows
    .flat()
    .toSorted(
      (a, b) =>
        (descending ? b.score - a.score : a.score - b.score) ||
        compareCodePoints(a.kind, b.kind) ||
        compareCodePoints(a.nodeId, b.nodeId),
    );
}

/** {@link mergeVectorRows} for the fulltext leg, whose score always descends. */
function mergeFulltextRows(
  perKindRows: readonly (readonly RankedSourceRow[])[],
): readonly RankedSourceRow[] {
  return perKindRows
    .flat()
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        compareCodePoints(a.kind, b.kind) ||
        compareCodePoints(a.nodeId, b.nodeId),
    );
}

export async function executeHybridSearch<N = Node>(
  ctx: StoreSearchContext,
  nodeKind: string,
  options: HybridSearchOptions,
): Promise<readonly HybridSearchHit<N>[]> {
  const { backend, graphId } = ctx;
  if (!backend.vectorSearch) {
    throw new ConfigurationError("Backend does not support vector search", {
      backend: backend.dialect,
      capability: "vector",
    });
  }
  if (!backend.fulltextSearch) {
    throw new ConfigurationError("Backend does not support fulltext search", {
      backend: backend.dialect,
      capability: "fulltext",
    });
  }
  if (!Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError(
      `hybridSearch.limit must be a positive integer, got: ${options.limit}`,
    );
  }

  if (options.fusion !== undefined) {
    validateHybridFusionOptions(options.fusion);
  }
  assertEfSearch(options.vector.efSearch, "hybridSearch.vector.efSearch");

  validateFulltextCallOptions(backend, {
    mode: options.fulltext.mode,
    includeSnippets: options.fulltext.includeSnippets,
    language: options.fulltext.language,
  });

  assertSearchOffset(options.offset, "hybridSearch.offset");

  const fusionK = options.fusion?.k ?? DEFAULT_RRF_K;
  const vectorWeight = options.fusion?.weights?.vector ?? DEFAULT_RRF_WEIGHT;
  const fulltextWeight =
    options.fusion?.weights?.fulltext ?? DEFAULT_RRF_WEIGHT;
  const offset = options.offset ?? 0;
  // Over-fetch covers the requested page: fused top-(limit+offset) needs
  // deep-enough per-source prefixes.
  const overFetchMultiplier = 4;
  const pageLimit = options.limit + offset;
  const vectorK = options.vector.k ?? pageLimit * overFetchMultiplier;
  const fulltextK = options.fulltext.k ?? pageLimit * overFetchMultiplier;

  // The fulltext half spans every expanded kind; the vector half only the
  // kinds that declare the embedding field (mirroring the query builder's
  // treatment of non-declaring kinds).
  const fulltextKinds = resolveSearchKinds(
    ctx,
    nodeKind,
    options.includeSubClasses,
  );
  const vectorKinds = resolveVectorSearchKinds(
    ctx,
    nodeKind,
    options.vector.fieldPath,
    options.includeSubClasses,
    "hybridSearch.vector",
  );
  for (const { slot } of vectorKinds) {
    assertVectorQueryCompatible(
      backend,
      slot,
      {
        metric: options.vector.metric,
        queryEmbedding: options.vector.queryEmbedding,
      },
      "hybridSearch.vector",
    );
    assertMinScore(
      options.vector.minScore,
      options.vector.metric ?? slot.metric,
      "hybridSearch.vector.minScore",
    );
  }
  const vectorMetric =
    options.vector.metric ?? requireDefined(vectorKinds[0]).slot.metric;

  // One candidate subquery per kind, shared by both halves.
  const candidatesByKind = new Map<string, SqlFragment | undefined>();
  for (const kind of fulltextKinds) {
    candidatesByKind.set(kind, buildKindCandidates(ctx, kind, options.where));
  }
  for (const { kind } of vectorKinds) {
    if (!candidatesByKind.has(kind)) {
      candidatesByKind.set(kind, buildKindCandidates(ctx, kind, options.where));
    }
  }

  // Single-statement fast path: one kind, backend support. Both sources,
  // fusion, liveness, and hydration compose into ONE statement (see
  // `buildHybridSearchStatement`) — the multi-statement path below remains
  // for kind expansions and backends without the member.
  if (
    backend.hybridSearch !== undefined &&
    fulltextKinds.length === 1 &&
    vectorKinds.length === 1 &&
    fulltextKinds[0] === requireDefined(vectorKinds[0]).kind
  ) {
    const kind = fulltextKinds[0];
    const { slot } = requireDefined(vectorKinds[0]);
    const candidates = candidatesByKind.get(kind);
    const hybridFulltextLanguage = effectiveFulltextLanguage(
      ctx,
      kind,
      options.fulltext.language,
    );
    const rows = await backend.hybridSearch({
      graphId,
      nodeKind: kind,
      vector: {
        fieldPath: options.vector.fieldPath,
        queryEmbedding: options.vector.queryEmbedding,
        metric: vectorMetric,
        dimensions: slot.dimensions,
        indexType: slot.indexType,
        k: vectorK,
        ...(options.vector.minScore === undefined ?
          {}
        : { minScore: options.vector.minScore }),
        ...(options.vector.efSearch === undefined ?
          {}
        : { efSearch: options.vector.efSearch }),
      },
      fulltext: {
        query: options.fulltext.query,
        k: fulltextK,
        ...(options.fulltext.mode ? { mode: options.fulltext.mode } : {}),
        ...(hybridFulltextLanguage === undefined ?
          {}
        : { language: hybridFulltextLanguage }),
        ...(options.fulltext.minScore === undefined ?
          {}
        : { minScore: options.fulltext.minScore }),
        ...(options.fulltext.includeSnippets === undefined ?
          {}
        : { includeSnippets: options.fulltext.includeSnippets }),
      },
      fusion: { k: fusionK, vectorWeight, fulltextWeight },
      limit: options.limit,
      ...(offset === 0 ? {} : { offset }),
      ...(candidates === undefined ? {} : { candidates }),
    });
    return rows.map((row, index) => {
      const typedNode = rowToNode(row.node) as N;
      return {
        node: typedNode,
        score: row.fusedScore,
        rank: index + 1,
        ...(row.vectorRank !== undefined && row.vectorScore !== undefined ?
          {
            vector: {
              node: typedNode,
              score: row.vectorScore,
              rank: row.vectorRank,
            },
          }
        : {}),
        ...(row.fulltextRank !== undefined && row.fulltextScore !== undefined ?
          {
            fulltext: {
              node: typedNode,
              score: row.fulltextScore,
              rank: row.fulltextRank,
              ...(row.snippet === undefined ? {} : { snippet: row.snippet }),
            },
          }
        : {}),
      };
    });
  }

  const vectorPromise = Promise.all(
    vectorKinds.map(
      async ({ kind, slot }): Promise<readonly RankedSourceRow[]> => {
        const candidates = candidatesByKind.get(kind);
        const rows = await requireDefined(backend.vectorSearch)({
          graphId,
          nodeKind: kind,
          fieldPath: options.vector.fieldPath,
          queryEmbedding: options.vector.queryEmbedding,
          // Default to the field's declared metric (see executeVectorSearch).
          metric: vectorMetric,
          dimensions: slot.dimensions,
          indexType: slot.indexType,
          limit: vectorK,
          ...(candidates === undefined ? {} : { candidates }),
          ...(options.vector.minScore === undefined ?
            {}
          : { minScore: options.vector.minScore }),
          ...(options.vector.efSearch === undefined ?
            {}
          : { efSearch: options.vector.efSearch }),
        });
        return rows.map((row) => ({
          kind,
          nodeId: row.nodeId,
          score: row.score,
        }));
      },
    ),
  ).then((perKind) => mergeVectorRows(perKind, vectorMetric).slice(0, vectorK));

  const fulltextPromise = Promise.all(
    fulltextKinds.map(async (kind): Promise<readonly RankedSourceRow[]> => {
      const candidates = candidatesByKind.get(kind);
      const language = effectiveFulltextLanguage(
        ctx,
        kind,
        options.fulltext.language,
      );
      const rows = await requireDefined(backend.fulltextSearch)({
        graphId,
        nodeKind: kind,
        query: options.fulltext.query,
        limit: fulltextK,
        ...(candidates === undefined ? {} : { candidates }),
        ...(options.fulltext.mode ? { mode: options.fulltext.mode } : {}),
        ...(language === undefined ? {} : { language }),
        ...(options.fulltext.minScore === undefined ?
          {}
        : { minScore: options.fulltext.minScore }),
        ...(options.fulltext.includeSnippets === undefined ?
          {}
        : { includeSnippets: options.fulltext.includeSnippets }),
      });
      return rows.map((row) => ({
        kind,
        nodeId: row.nodeId,
        score: row.score,
        ...(row.snippet === undefined ? {} : { snippet: row.snippet }),
      }));
    }),
  ).then((perKind) => mergeFulltextRows(perKind).slice(0, fulltextK));

  const [vectorRows, fulltextRows] = await Promise.all([
    vectorPromise,
    fulltextPromise,
  ]);

  // RRF fusion. The classic formula is score = Σ_src 1 / (k + rank_src).
  // Per-source weights extend it to a weighted sum.
  interface FusedEntry {
    kind: string;
    nodeId: string;
    fusedScore: number;
    vectorRank?: number;
    vectorScore?: number;
    fulltextRank?: number;
    fulltextScore?: number;
    fulltextSnippet?: string;
  }
  const fused = new Map<string, FusedEntry>();

  for (const [index, row] of vectorRows.entries()) {
    const rank = index + 1;
    const contribution = vectorWeight / (fusionK + rank);
    const key = searchNodeKey(row.kind, row.nodeId);
    const entry = fused.get(key) ?? {
      kind: row.kind,
      nodeId: row.nodeId,
      fusedScore: 0,
    };
    entry.fusedScore += contribution;
    entry.vectorRank = rank;
    entry.vectorScore = row.score;
    fused.set(key, entry);
  }

  for (const [index, row] of fulltextRows.entries()) {
    const rank = index + 1;
    const contribution = fulltextWeight / (fusionK + rank);
    const key = searchNodeKey(row.kind, row.nodeId);
    const entry = fused.get(key) ?? {
      kind: row.kind,
      nodeId: row.nodeId,
      fusedScore: 0,
    };
    entry.fusedScore += contribution;
    entry.fulltextRank = rank;
    entry.fulltextScore = row.score;
    if (row.snippet !== undefined) {
      entry.fulltextSnippet = row.snippet;
    }
    fused.set(key, entry);
  }

  // Code points, not code units: the single-statement path breaks the same tie
  // with `ORDER BY fused_score DESC, node_id` under SQLite's BINARY collation
  // or Postgres's forced `C` collation (see `buildHybridSearchStatement`). A
  // fused-score tie at the page boundary must pick the same winner on both
  // paths, and only code-point order agrees with byte order.
  const ranked = [...fused.values()]
    .toSorted(
      (a, b) =>
        b.fusedScore - a.fusedScore ||
        compareCodePoints(a.kind, b.kind) ||
        compareCodePoints(a.nodeId, b.nodeId),
    )
    .slice(offset, offset + options.limit);

  const nodeMap = await fetchNodesForRows(
    backend,
    graphId,
    ranked.map((entry) => ({
      kind: entry.kind,
      nodeId: entry.nodeId,
      score: entry.fusedScore,
    })),
  );

  const hits: HybridSearchHit<N>[] = [];
  let rank = 1;
  for (const entry of ranked) {
    const node = nodeMap.get(searchNodeKey(entry.kind, entry.nodeId));
    if (!node) continue;
    const typedNode = node as N;
    const hit: HybridSearchHit<N> = {
      node: typedNode,
      score: entry.fusedScore,
      rank,
      ...(entry.vectorRank !== undefined && entry.vectorScore !== undefined ?
        {
          vector: {
            node: typedNode,
            score: entry.vectorScore,
            rank: entry.vectorRank,
          },
        }
      : {}),
      ...((
        entry.fulltextRank !== undefined && entry.fulltextScore !== undefined
      ) ?
        {
          fulltext: {
            node: typedNode,
            score: entry.fulltextScore,
            rank: entry.fulltextRank,
            ...(entry.fulltextSnippet === undefined ?
              {}
            : { snippet: entry.fulltextSnippet }),
          },
        }
      : {}),
    };
    hits.push(hit);
    rank += 1;
  }
  return hits;
}

/**
 * Validates the optional `efSearch` knob at the API boundary. Rejects
 * non-positive-integer values uniformly across backends — the
 * backend-specific ceiling (pgvector caps `hnsw.ef_search` at 1000) is
 * enforced on the Postgres path, and backends without an HNSW frontier
 * knob treat a valid value as a no-op.
 */
function assertEfSearch(efSearch: number | undefined, label: string): void {
  if (efSearch === undefined) return;
  if (!Number.isInteger(efSearch) || efSearch <= 0) {
    throw new RangeError(
      `${label} must be a positive integer, got: ${efSearch}`,
    );
  }
}

/**
 * Validates the optional `minScore` filter at the API boundary, mirroring the
 * query-compiler vector pass. Rejects non-finite values for any metric and,
 * for cosine (where the score is `1 - distance` similarity), values outside
 * [-1, 1]. Without this a `NaN` minScore compiles to `distance <= (1 - NaN)`,
 * which matches nothing — a silent empty result instead of a clear error.
 */
function assertMinScore(
  minScore: number | undefined,
  metric: VectorMetric,
  label: string,
): void {
  if (minScore === undefined) return;
  assertVectorMinScore(minScore, metric, label);
}

/**
 * Validates a vector search/hybrid call against the field's resolved slot:
 * an explicit `metric` override must match the field's declared metric (its
 * storage / ANN index is built for that metric), the declared metric must be
 * one the backend supports, and the query vector's length must match the
 * field's dimension. Rejects at the API boundary instead of surfacing an
 * opaque engine error from deep in `buildSearch`.
 */
function assertVectorQueryCompatible(
  backend: GraphBackend,
  slot: ResolvedSearchSlot,
  options: {
    metric: VectorMetric | undefined;
    queryEmbedding: readonly number[];
  },
  label: string,
): void {
  if (options.metric !== undefined && options.metric !== slot.metric) {
    throw new ConfigurationError(
      `${label}: metric "${options.metric}" does not match the field's declared metric "${slot.metric}". Vector storage is built for the declared metric — omit metric or pass "${slot.metric}".`,
      { backend: backend.dialect, capability: "vector" },
    );
  }
  const supported = backend.capabilities.vector?.metrics;
  if (supported !== undefined && !supported.includes(slot.metric)) {
    throw new ConfigurationError(
      `${label}: backend "${backend.dialect}" does not support the "${slot.metric}" metric (supported: ${supported.join(", ")}).`,
      { backend: backend.dialect, capability: "vector" },
    );
  }
  if (options.queryEmbedding.length !== slot.dimensions) {
    throw new RangeError(
      `${label}: queryEmbedding has ${options.queryEmbedding.length} dimensions, but "${slot.dimensions}" are declared for this field.`,
    );
  }
}

type FulltextCallOptions = Readonly<{
  mode: FulltextQueryMode | undefined;
  includeSnippets: boolean | undefined;
  language: string | undefined;
}>;

/**
 * Validates caller-supplied fulltext options against the active
 * `FulltextStrategy` (when present) or the declared `FulltextCapabilities`
 * projection (as a fallback). Strategy validation is authoritative:
 * `supportedModes` and `supportsLanguageOverride` reject options that the
 * capabilities projection would silently ignore (e.g. a `language`
 * override on the SQLite FTS5 strategy, whose tokenizer is fixed at
 * table-create time). Mode, snippets, and language are the fields
 * callers commonly get wrong; catching them here turns a downstream SQL
 * error — or worse, silent misbehavior — into a clear
 * `ConfigurationError` at the API boundary.
 */
function validateFulltextCallOptions(
  backend: GraphBackend,
  options: FulltextCallOptions,
): void {
  const strategy = backend.fulltextStrategy;
  const capabilities = backend.capabilities.fulltext;

  if (options.mode !== undefined) {
    validateFulltextMode(backend, strategy, capabilities, options.mode);
  }
  if (options.includeSnippets === true) {
    validateFulltextSnippets(backend, strategy, capabilities);
  }
  if (options.language !== undefined) {
    validateFulltextLanguageOption(
      backend,
      strategy,
      capabilities,
      options.language,
    );
  }
}

function validateFulltextMode(
  backend: GraphBackend,
  strategy: FulltextStrategy | undefined,
  capabilities: FulltextCapabilities | undefined,
  mode: FulltextQueryMode,
): void {
  if (strategy !== undefined) {
    if (strategy.supportedModes.includes(mode)) return;
    throw new ConfigurationError(
      `Backend "${backend.dialect}" fulltext strategy "${strategy.name}" ` +
        `does not support mode "${mode}". Supported modes: ${strategy.supportedModes.join(", ")}`,
      {
        backend: backend.dialect,
        strategy: strategy.name,
        capability: `fulltext.modes.${mode}`,
      },
    );
  }
  if (mode === "phrase" && capabilities && !capabilities.phraseQueries) {
    throw new ConfigurationError(
      `Backend "${backend.dialect}" does not support phrase queries`,
      { backend: backend.dialect, capability: "fulltext.phraseQueries" },
    );
  }
}

function validateFulltextSnippets(
  backend: GraphBackend,
  strategy: FulltextStrategy | undefined,
  capabilities: FulltextCapabilities | undefined,
): void {
  const supportsSnippets =
    strategy === undefined ?
      capabilities?.highlighting !== false
    : strategy.supportsSnippets;
  if (supportsSnippets) return;
  throw new ConfigurationError(
    `Backend "${backend.dialect}" does not support snippet highlighting; ` +
      `drop includeSnippets or switch to a backend where highlighting is supported`,
    { backend: backend.dialect, capability: "fulltext.highlighting" },
  );
}

function validateFulltextLanguageOption(
  backend: GraphBackend,
  strategy: FulltextStrategy | undefined,
  capabilities: FulltextCapabilities | undefined,
  language: string,
): void {
  if (strategy !== undefined && !strategy.supportsLanguageOverride) {
    throw new ConfigurationError(
      `Backend "${backend.dialect}" fulltext strategy "${strategy.name}" ` +
        `does not honor a per-query \`language\` override ` +
        `(its tokenizer is fixed at table-create time). ` +
        `Drop the option, or pick a strategy that advertises \`supportsLanguageOverride: true\`.`,
      {
        backend: backend.dialect,
        strategy: strategy.name,
        capability: "fulltext.languageOverride",
      },
    );
  }
  if (capabilities !== undefined) {
    warnIfLanguageNotAdvertised(backend.dialect, capabilities, language);
  }
}

/**
 * Advisory language check — warn, don't throw. Postgres accepts any
 * installed regconfig at runtime, so a strict list would produce false
 * positives for extension-provided dictionaries.
 */
function warnIfLanguageNotAdvertised(
  dialect: string,
  capabilities: FulltextCapabilities,
  language: string,
): void {
  if (capabilities.languages.length === 0) return;
  if (capabilities.languages.includes(language)) return;
  if (typeof console === "undefined" || typeof console.warn !== "function") {
    return;
  }
  console.warn(
    `[typegraph] fulltext language "${language}" is not in the advertised list ` +
      `for dialect "${dialect}" (${capabilities.languages.join(", ")}). ` +
      `If your backend has this language installed this warning is safe to ignore.`,
  );
}

async function fetchNodesByIds(
  backend: GraphBackend,
  graphId: string,
  nodeKind: string,
  ids: readonly string[],
): Promise<Map<string, Node>> {
  if (ids.length === 0) return new Map();
  const map = new Map<string, Node>();
  if (backend.getNodes) {
    const rows = await backend.getNodes(graphId, nodeKind, ids);
    for (const row of rows) {
      // `getNodes` returns rows regardless of deleted_at. The search SQL
      // already constrains top-k to live nodes; this skip is
      // defense-in-depth for the window between the search statement and
      // this hydration read (they are separate transactions, so a
      // concurrent delete can land in between).
      if (row.deleted_at !== undefined) continue;
      map.set(row.id, rowToNode(row));
    }
    return map;
  }
  // Fallback: fetch one at a time. Slow, but only triggers on backends
  // that haven't implemented the batched accessor.
  for (const id of ids) {
    const row = await backend.getNode(graphId, nodeKind, id);
    if (row && row.deleted_at === undefined) map.set(row.id, rowToNode(row));
  }
  return map;
}

export { type HybridFusionOptions } from "../query/ast";
