import { type SnbIdPools } from "../dataset/ldbc-csv";
import { type SnbEngineName } from "../harness/doctor";

export type IsQueryId = "IS1" | "IS2" | "IS3" | "IS4" | "IS5" | "IS6" | "IS7";

export const IS_QUERY_IDS: readonly IsQueryId[] = [
  "IS1",
  "IS2",
  "IS3",
  "IS4",
  "IS5",
  "IS6",
  "IS7",
];

/**
 * Traversal-heavy queries adapted from LDBC's Interactive Complex set — the
 * workload class the IS1-IS7 short reads never exercise (all of those are
 * point reads or 1-hop/linear walks). These are the queries that actually
 * stress a graph engine's pathfinding/BFS core and, in particular, a
 * PostgreSQL graph extension's specialized traversal index.
 *
 * - `IC13` — the core of LDBC IC13: the shortest-path hop distance between
 *   two persons over the (undirected) `knows` graph, capped at
 *   `IC13_MAX_HOPS`. Every engine uses its own native shortest-path
 *   primitive.
 * - `BFS3` — an IC1-shaped bounded neighborhood: the set of distinct persons
 *   reachable within `BFS3_HOPS` hops of a seed over `knows` (the seed
 *   excluded). Not the full IC1 (no name filter / profile projection) — just
 *   its traversal core, so every engine can express it natively.
 * - `IC14` — the weighted-shortest-path core of LDBC IC14: the minimum-total-
 *   weight route between two persons over `knows`, where each edge carries a
 *   deterministic synthetic weight (see `synthesizeKnowsWeight`). Exercises
 *   TypeGraph's `weightedShortestPath` (#288). Heavily gated: no competitor in
 *   its available form does weighted shortest path (neo4j-community needs GDS;
 *   pgGraph's `graph.shortest_path` is hop-only; ladybug's `WSHORTEST` is not
 *   wired), so this is a TypeGraph SQLite-vs-PostgreSQL comparison.
 */
export type TraversalQueryId = "IC13" | "BFS3" | "IC14";

export const TRAVERSAL_QUERY_IDS: readonly TraversalQueryId[] = [
  "IC13",
  "BFS3",
  "IC14",
];

/**
 * LDBC Interactive Complex reads expressible on the current SNB schema
 * (Person/knows/Message/replyOf only — no tags/places/orgs). Each stresses a
 * traversal + top-k shape the IS short reads never do:
 *
 * - `IC2` — the given person's friends' most recent 20 messages.
 * - `IC8` — the most recent 20 replies to the given person's own messages.
 * - `IC9` — the most recent 20 messages by the person's friends and
 *   friends-of-friends (2-hop `knows`) created before `IC9_MAX_DATE`.
 */
export type ComplexQueryId = "IC2" | "IC8" | "IC9";

export const COMPLEX_QUERY_IDS: readonly ComplexQueryId[] = [
  "IC2",
  "IC8",
  "IC9",
];

/**
 * LDBC-Graphalytics-style graph algorithms over the `knows` graph. These are
 * whole-graph or whole-neighborhood computations (not point reads), and are
 * the workload that maps onto `store.algorithms` — where engine capability
 * varies widely, so they are heavily capability-gated (see
 * `SnbEngineHandle.unsupported`).
 *
 * - `GA_DEGREE` — `knows` degree of the seed (supported everywhere).
 * - `GA_WCC` — weakly connected components of the whole `knows` graph.
 * - `GA_BFS` — nodes reachable from the seed over `knows` (whole component).
 * - `GA_SSSP` — unweighted shortest distance from the seed to all reachable.
 */
export type AlgorithmQueryId = "GA_DEGREE" | "GA_WCC" | "GA_BFS" | "GA_SSSP";

export const ALGORITHM_QUERY_IDS: readonly AlgorithmQueryId[] = [
  "GA_DEGREE",
  "GA_WCC",
  "GA_BFS",
  "GA_SSSP",
];

/** Every query the SNB lane runs against each engine. */
export type SnbQueryId =
  IsQueryId | TraversalQueryId | ComplexQueryId | AlgorithmQueryId;

export const SNB_QUERY_IDS: readonly SnbQueryId[] = [
  ...IS_QUERY_IDS,
  ...TRAVERSAL_QUERY_IDS,
  ...COMPLEX_QUERY_IDS,
  ...ALGORITHM_QUERY_IDS,
];

/**
 * Shared hop bounds, imported by every engine so the traversal queries carry
 * byte-identical semantics across backends — the same guarantee the seeded
 * request plan gives for inputs. Diverging these per engine would silently
 * break digest parity (a 4-hop-capped path is a different answer than an
 * 8-hop-capped one).
 */
export const IC13_MAX_HOPS = 8;
export const BFS3_HOPS = 3;

/** IC2/IC8/IC9 return the most-recent this-many messages. */
export const IC_MESSAGE_LIMIT = 20;

/**
 * IC9's fixed "created before" cutoff, applied identically by every engine.
 * A fixed instant (rather than a per-request sample) keeps IC9 deterministic
 * and parity-comparable; the value sits inside the LDBC message date range so
 * the filter is exercised rather than a no-op.
 */
export const IC9_MAX_DATE = "2012-09-01T00:00:00.000Z";

/**
 * The result of running one IS query for one sampled request. `rowCount` is
 * the size of the query's primary LDBC-defined result set (e.g. IS2's
 * up-to-10 message list, IS3's full friend list). `digest` is a
 * value-level parity signal: a canonical, engine-agnostic string built from
 * the query's actual LDBC-defined output fields (see `canonicalDigest`) —
 * two engines producing the same row *count* can still disagree on field
 * values, omitted fields, or ordering, none of which `rowCount` alone can
 * ever catch.
 */
export type SnbQueryResult = Readonly<{ rowCount: number; digest: string }>;

/**
 * Builds `SnbQueryResult.digest` from a query's actual LDBC-defined output
 * rows — always an array, even for a single-row query (empty array if the
 * query legitimately found nothing, e.g. IS6 with no forum). Every engine
 * must build the identical plain-object shape (same keys, same key order)
 * from its own result for the digest to be comparable at all; the fields
 * included must be exactly the query's official LDBC output fields, not
 * internal bookkeeping (row `kind` tags, etc.) that could differ across
 * engines for reasons unrelated to the actual answer.
 *
 * `JSON.stringify` of small, already-fetched in-memory rows is a
 * microseconds-scale synchronous operation — computing this inside the
 * timed request path (see `measureQuery` in `snb-short-reads.ts`) doesn't
 * meaningfully skew latency the way an extra network round trip would.
 */
export function canonicalDigest(rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}

/**
 * Numeric-aware comparator for this benchmark's LDBC-derived ids (e.g.
 * `"message:00000000000000000012"`, `"person:00000000000000000002"`).
 * `dataset/ldbc-csv.ts` zero-pads every id's numeric portion to a fixed
 * width specifically so a native `ORDER BY id ASC` (SQL or Cypher alike)
 * already agrees with numeric order — `numeric: true` here is a defensive
 * backstop, not load-bearing for correctness.
 *
 * Every engine applies this same comparator as the final, authoritative
 * sort immediately before building a digest (even where its own native
 * query already applied an `ORDER BY`/`LIMIT`, over the small — at most
 * ~20-row — result that native step already narrowed things down to) so the
 * row order captured in the digest can't drift between engines depending on
 * subtle native collation differences — the one thing that must be
 * identical across engines for `digest` to be a meaningful comparison at
 * all.
 */
export function compareIdsAscending(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/**
 * Sentinel hop distance for an IC13 pair with no path within `IC13_MAX_HOPS`.
 * Real distances between two distinct persons are always >= 1, so -1 can
 * never collide with a genuine answer — and it keeps the digest a plain
 * integer (no `null`) while staying identical across every engine that
 * reports "unreachable" for the same request.
 */
export const IC13_UNREACHABLE = -1;

/**
 * Canonical IC13 result. Every engine funnels its native shortest-path
 * answer through here so the digest is byte-identical: one row carrying the
 * capped hop distance (or `IC13_UNREACHABLE`). `rowCount` is always 1 — the
 * single scalar answer — so the coarse row-count parity check is a no-op and
 * the digest carries the real signal.
 */
export function shortestPathDistanceResult(
  distance: number | undefined,
): SnbQueryResult {
  return {
    rowCount: 1,
    digest: canonicalDigest([{ distance: distance ?? IC13_UNREACHABLE }]),
  };
}

/** Edge property carrying each `knows` edge's synthetic IC14 weight. */
export const KNOWS_WEIGHT_PROPERTY = "weight";

/** Modulus bounding the synthetic weight to `[1, KNOWS_WEIGHT_MODULUS]`. */
export const KNOWS_WEIGHT_MODULUS = 97;

/**
 * Deterministic synthetic weight for a `knows` edge, hashed from the two
 * persons' ids. Symmetric (ids are canonically ordered) so the undirected
 * `knows` graph carries one weight per pair, and range-bounded to
 * `[1, KNOWS_WEIGHT_MODULUS]` so a longer cheaper route can beat a shorter
 * costlier one — otherwise the weighted path would just mirror the hop-shortest
 * path. FNV-1a keeps it a pure function of the ids, so both TypeGraph backends
 * (which share this loader) materialize byte-identical weights and the IC14
 * digest can't drift.
 */
export function synthesizeKnowsWeight(idA: string, idB: string): number {
  const [lo, hi] = idA <= idB ? [idA, idB] : [idB, idA];
  const key = `${lo} ${hi}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < key.length; index++) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) % KNOWS_WEIGHT_MODULUS) + 1;
}

/** Sentinel total weight for an unreachable IC14 pair (real weights are >= 1). */
export const IC14_UNREACHABLE = -1;

/**
 * Canonical IC14 result: the minimum total weight of the weighted-shortest
 * path (or `IC14_UNREACHABLE`). Like IC13 the answer is a single scalar, so
 * `rowCount` is 1 and the digest carries the signal. Edge weights are integers,
 * so the summed total is an integer — no float-precision drift in the digest.
 */
export function weightedShortestPathResult(
  totalWeight: number | undefined,
): SnbQueryResult {
  return {
    rowCount: 1,
    digest: canonicalDigest([{ weight: totalWeight ?? IC14_UNREACHABLE }]),
  };
}

/**
 * Canonical BFS3 result: the distinct reachable person ids, de-duplicated and
 * sorted with the numeric-aware comparator so the digest can't drift on
 * native ordering differences (see `compareIdsAscending`). Every engine may
 * return duplicates or arbitrary order from its own traversal; this collapses
 * them to the one canonical set. `rowCount` is the neighborhood size.
 */
export function reachableSetResult(ids: readonly string[]): SnbQueryResult {
  const uniqueSorted = [...new Set(ids)].toSorted((left, right) =>
    compareIdsAscending(left, right),
  );
  return {
    rowCount: uniqueSorted.length,
    digest: canonicalDigest(uniqueSorted),
  };
}

/**
 * IC2/IC8/IC9 order: message creationDate DESC, then message id DESC — the
 * shared, numeric-aware tie-break every engine applies before building its
 * top-`IC_MESSAGE_LIMIT` digest, so ordering can't drift on native collation
 * differences (same rationale as `compareIdsAscending`).
 */
export function compareMessageRecencyDesc(
  left: Readonly<{ creationDate: string; id: string }>,
  right: Readonly<{ creationDate: string; id: string }>,
): number {
  return (
    right.creationDate.localeCompare(left.creationDate) ||
    compareIdsAscending(right.id, left.id)
  );
}

/**
 * Canonical connected-components digest for `GA_WCC`: the descending-sorted
 * list of component sizes. Component sizes are a well-defined graph invariant,
 * so any engine that computes WCC correctly produces the identical multiset —
 * a strong parity signal independent of how each engine labels components.
 * `rowCount` is the number of components.
 */
export function componentSizesResult(sizes: readonly number[]): SnbQueryResult {
  const sortedDesc = [...sizes].toSorted((left, right) => right - left);
  return {
    rowCount: sortedDesc.length,
    digest: canonicalDigest(sortedDesc),
  };
}

/**
 * Whole-component hop ceiling for `GA_BFS`/`GA_SSSP` — comfortably above any
 * realistic `knows`-component diameter, so a bounded traversal reaches the
 * entire component (an unbounded whole-graph BFS in practice). Shared so every
 * engine explores the same frontier.
 */
export const GA_MAX_HOPS = 64;

/** Canonical `GA_DEGREE` result: the seed's `knows` degree. */
export function degreeResult(degree: number): SnbQueryResult {
  return { rowCount: 1, digest: canonicalDigest([{ degree }]) };
}

/** Canonical `GA_BFS` result: count of nodes reachable from the seed (seed excluded). */
export function bfsReachResult(reachableCount: number): SnbQueryResult {
  return {
    rowCount: reachableCount,
    digest: canonicalDigest([{ reachable: reachableCount }]),
  };
}

/**
 * Canonical `GA_SSSP` result: reachable count plus the sum of shortest-path
 * depths over all reached nodes — a compact checksum of the full distance
 * vector that still catches a wrong distance anywhere.
 */
export function ssspResult(
  reachableCount: number,
  depthSum: number,
): SnbQueryResult {
  return {
    rowCount: reachableCount,
    digest: canonicalDigest([{ reachable: reachableCount, depthSum }]),
  };
}

/**
 * A placeholder for a query an engine has declared `unsupported`. The runner
 * checks `SnbEngineHandle.unsupported` and never calls these — this rejects
 * loudly if that invariant is ever violated, rather than silently returning a
 * bogus result that would pollute parity.
 */
export function unsupportedQuery(queryId: SnbQueryId): () => Promise<never> {
  return () =>
    Promise.reject(
      new Error(
        `${queryId} was invoked on an engine that declared it unsupported`,
      ),
    );
}

/**
 * A message-shaped request input. LDBC's IS4/IS5/IS6/IS7 take a Message id,
 * which is polymorphic (Post or Comment) in this schema. Carrying the kind
 * alongside the id — harvested once from the loader's id pools — lets every
 * engine driver dispatch to the concrete kind directly instead of probing
 * for it per request.
 */
export type MessageRef = Readonly<{ id: string; kind: "Post" | "Comment" }>;

/**
 * An ordered pair of Person ids — IC13's shortest-path endpoints. Sampled
 * once per request (like every other input) so every engine measures the
 * identical source/target at request index N.
 */
export type PersonPair = Readonly<{ sourceId: string; targetId: string }>;

/**
 * One async query function per SNB query: IS1-IS7 (keyed on the LDBC-defined
 * input id) plus the two traversal queries (IC13 takes a person pair, BFS3 a
 * single seed person id). Every engine implements the full set — the runner
 * measures each query against each engine.
 */
export type SnbQueries = Readonly<{
  IS1: (personId: string) => Promise<SnbQueryResult>;
  IS2: (personId: string) => Promise<SnbQueryResult>;
  IS3: (personId: string) => Promise<SnbQueryResult>;
  IS4: (message: MessageRef) => Promise<SnbQueryResult>;
  IS5: (message: MessageRef) => Promise<SnbQueryResult>;
  IS6: (message: MessageRef) => Promise<SnbQueryResult>;
  IS7: (message: MessageRef) => Promise<SnbQueryResult>;
  IC13: (pair: PersonPair) => Promise<SnbQueryResult>;
  IC14: (pair: PersonPair) => Promise<SnbQueryResult>;
  BFS3: (personId: string) => Promise<SnbQueryResult>;
  IC2: (personId: string) => Promise<SnbQueryResult>;
  IC8: (personId: string) => Promise<SnbQueryResult>;
  IC9: (personId: string) => Promise<SnbQueryResult>;
  GA_DEGREE: (seedPersonId: string) => Promise<SnbQueryResult>;
  GA_WCC: (seedPersonId: string) => Promise<SnbQueryResult>;
  GA_BFS: (seedPersonId: string) => Promise<SnbQueryResult>;
  GA_SSSP: (seedPersonId: string) => Promise<SnbQueryResult>;
}>;

/**
 * A declared capability gap: a query this engine genuinely cannot run, mapped
 * to a human-readable reason (a missing algorithm, an engine limit, an open
 * issue). Recorded and reported by the runner as an explicit "unsupported"
 * rather than a failure or a silent skip — the parity matrix then shows the
 * real capability landscape (AGENTS.md: genuine engine gaps are declared, not
 * hidden). A query still listed in `queries` but present here is never called.
 */
export type SnbCapabilityGaps = Partial<Record<SnbQueryId, string>>;

/**
 * A loaded, query-ready engine handle. `load()` streams the dataset (via
 * `streamSnbCsvDataset` and the engine's own `SnbRowSink`) and must be
 * called exactly once before `queries` are used.
 */
export type SnbEngineHandle = Readonly<{
  name: SnbEngineName;
  /** One-line description of this engine's load/index footing, for the results doc. */
  fairness: string;
  load(): Promise<SnbIdPools>;
  queries: SnbQueries;
  /** Queries this engine cannot run, with reasons. Absent = runs everything. */
  unsupported?: SnbCapabilityGaps;
  close(): Promise<void>;
}>;

type SnbEngineOptions = Readonly<{
  /** Directory containing `dynamic/` (extracted datagen output or the smoke fixture). */
  datasetRoot: string;
  log: (message: string) => void;
}>;

export type SnbEngineFactory = (
  options: SnbEngineOptions,
) => Promise<SnbEngineHandle>;
