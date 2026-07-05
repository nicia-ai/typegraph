import { type SnbIdPools, type SnbRowSink } from "../dataset/ldbc-csv";
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
 * up-to-10 message list, IS3's full friend list) — the value the row-count
 * parity gate compares across engines for the same sampled id.
 */
export type SnbQueryResult = Readonly<{ rowCount: number }>;

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

export type SnbEngineOptions = Readonly<{
  /** Directory containing `dynamic/` (extracted datagen output or the smoke fixture). */
  datasetRoot: string;
  log: (message: string) => void;
}>;

export type SnbEngineFactory = (
  options: SnbEngineOptions,
) => Promise<SnbEngineHandle>;

/** Re-exported so engine modules have one import source for the row sink shape. */
export type { SnbRowSink };
