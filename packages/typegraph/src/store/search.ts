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
  type VectorMetric,
} from "../backend/types";
import { ConfigurationError } from "../errors";
import {
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHT,
  type HybridFusionOptions,
} from "../query/ast";
import { validateHybridFusionOptions } from "../query/builder/validation";
import { type FulltextStrategy } from "../query/dialect/fulltext-strategy";
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

export type FulltextSearchOptions = Readonly<{
  /** The user-supplied query string. */
  query: string;
  /** Max results. Required. */
  limit: number;
  /** Query parser mode. Default: "websearch". */
  mode?: FulltextQueryMode;
  /**
   * Language override for query parsing. Default: per-row language as
   * stored at insert time.
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

export type HybridSearchOptions = Readonly<{
  vector: HybridVectorOptions;
  fulltext: HybridFulltextOptions;
  fusion?: HybridFusionOptions;
  /** Final number of fused results to return. Required. */
  limit: number;
}>;

type StoreSearchContext = Readonly<{
  graphId: string;
  backend: GraphBackend;
}>;

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
  validateFulltextCallOptions(backend, {
    mode: options.mode,
    includeSnippets: options.includeSnippets,
    language: options.language,
  });

  const params: Parameters<NonNullable<GraphBackend["fulltextSearch"]>>[0] = {
    graphId,
    nodeKind,
    query: options.query,
    limit: options.limit,
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
    ...(options.includeSnippets === undefined ?
      {}
    : { includeSnippets: options.includeSnippets }),
  };

  const rows = await backend.fulltextSearch(params);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.nodeId);
  const nodeMap = await fetchNodesByIds(backend, graphId, nodeKind, ids);

  const hits: FulltextSearchHit<N>[] = [];
  let rank = 1;
  for (const row of rows) {
    const node = nodeMap.get(row.nodeId);
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

  validateFulltextCallOptions(backend, {
    mode: options.fulltext.mode,
    includeSnippets: options.fulltext.includeSnippets,
    language: options.fulltext.language,
  });

  const fusionK = options.fusion?.k ?? DEFAULT_RRF_K;
  const vectorWeight = options.fusion?.weights?.vector ?? DEFAULT_RRF_WEIGHT;
  const fulltextWeight =
    options.fusion?.weights?.fulltext ?? DEFAULT_RRF_WEIGHT;
  const overFetchMultiplier = 4;
  const vectorK = options.vector.k ?? options.limit * overFetchMultiplier;
  const fulltextK = options.fulltext.k ?? options.limit * overFetchMultiplier;

  const vectorPromise = backend.vectorSearch({
    graphId,
    nodeKind,
    fieldPath: options.vector.fieldPath,
    queryEmbedding: options.vector.queryEmbedding,
    metric: options.vector.metric ?? "cosine",
    limit: vectorK,
    ...(options.vector.minScore === undefined ?
      {}
    : { minScore: options.vector.minScore }),
  });

  const fulltextPromise = backend.fulltextSearch({
    graphId,
    nodeKind,
    query: options.fulltext.query,
    limit: fulltextK,
    ...(options.fulltext.mode ? { mode: options.fulltext.mode } : {}),
    ...(options.fulltext.language ?
      { language: options.fulltext.language }
    : {}),
    ...(options.fulltext.minScore === undefined ?
      {}
    : { minScore: options.fulltext.minScore }),
    ...(options.fulltext.includeSnippets === undefined ?
      {}
    : { includeSnippets: options.fulltext.includeSnippets }),
  });

  const [vectorRows, fulltextRows] = await Promise.all([
    vectorPromise,
    fulltextPromise,
  ]);

  // RRF fusion. The classic formula is score = Σ_src 1 / (k + rank_src).
  // Per-source weights extend it to a weighted sum.
  interface FusedEntry {
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
    const entry = fused.get(row.nodeId) ?? {
      nodeId: row.nodeId,
      fusedScore: 0,
    };
    entry.fusedScore += contribution;
    entry.vectorRank = rank;
    entry.vectorScore = row.score;
    fused.set(row.nodeId, entry);
  }

  for (const [index, row] of fulltextRows.entries()) {
    const rank = index + 1;
    const contribution = fulltextWeight / (fusionK + rank);
    const entry = fused.get(row.nodeId) ?? {
      nodeId: row.nodeId,
      fusedScore: 0,
    };
    entry.fusedScore += contribution;
    entry.fulltextRank = rank;
    entry.fulltextScore = row.score;
    if (row.snippet !== undefined) {
      entry.fulltextSnippet = row.snippet;
    }
    fused.set(row.nodeId, entry);
  }

  const ranked = [...fused.values()]
    .toSorted(
      (a, b) => b.fusedScore - a.fusedScore || a.nodeId.localeCompare(b.nodeId),
    )
    .slice(0, options.limit);

  const ids = ranked.map((entry) => entry.nodeId);
  const nodeMap = await fetchNodesByIds(backend, graphId, nodeKind, ids);

  const hits: HybridSearchHit<N>[] = [];
  let rank = 1;
  for (const entry of ranked) {
    const node = nodeMap.get(entry.nodeId);
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
      // `getNodes` returns rows regardless of deleted_at. If the fulltext
      // or embedding index has drifted (a stale row for a soft-deleted
      // node), skip it here so search never resurrects tombstones.
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
