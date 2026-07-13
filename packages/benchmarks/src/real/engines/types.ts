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
 * `"message:12"`, `"person:2"`). Official LDBC ids are plain numeric
 * (BIGINT); this benchmark prefixes every id with its kind so a single
 * `Message`/`Person`/`Forum` id column can serve every node kind, but that
 * means a plain lexicographic compare — what every native `ORDER BY id
 * ASC` in this codebase actually does, SQL or Cypher alike — puts
 * `"message:10"` before `"message:2"`, which the LDBC-defined tie-breaks
 * in IS2/IS3/IS7 don't. `numeric: true` makes `Intl` collation treat
 * embedded digit runs as numbers rather than characters, which works
 * correctly across the identical shared prefix on both sides.
 *
 * Every engine applies this same comparator as the final, authoritative
 * sort immediately before building a digest (even where its own native
 * query already applied an `ORDER BY`) so the row order captured in the
 * digest can't drift between engines depending on what their own native
 * ordering happened to do on a tie — the one thing that must be identical
 * across engines for `digest` to be a meaningful comparison at all.
 */
export function compareIdsAscending(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true });
}

/**
 * A message-shaped request input. LDBC's IS4/IS5/IS6/IS7 take a Message id,
 * which is polymorphic (Post or Comment) in this schema. Carrying the kind
 * alongside the id — harvested once from the loader's id pools — lets every
 * engine driver dispatch to the concrete kind directly instead of probing
 * for it per request.
 */
export type MessageRef = Readonly<{ id: string; kind: "Post" | "Comment" }>;

/** One async query function per IS1-IS7, each keyed on the LDBC-defined input id. */
export type SnbQueries = Readonly<{
  IS1: (personId: string) => Promise<SnbQueryResult>;
  IS2: (personId: string) => Promise<SnbQueryResult>;
  IS3: (personId: string) => Promise<SnbQueryResult>;
  IS4: (message: MessageRef) => Promise<SnbQueryResult>;
  IS5: (message: MessageRef) => Promise<SnbQueryResult>;
  IS6: (message: MessageRef) => Promise<SnbQueryResult>;
  IS7: (message: MessageRef) => Promise<SnbQueryResult>;
}>;

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
