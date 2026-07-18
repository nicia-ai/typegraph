/** Journal modes accepted by local SQLite connections. */
export type LocalSqliteJournalMode =
  "wal" | "delete" | "truncate" | "persist" | "memory" | "off";

/** Synchronous levels accepted by local SQLite connections. */
export type LocalSqliteSynchronousMode = "off" | "normal" | "full" | "extra";

/** Connection pragmas applied when TypeGraph opens a local SQLite database. */
export type LocalSqlitePragmaOptions = Readonly<{
  /** `PRAGMA journal_mode`. Default: `"wal"` (no-op on `":memory:"`). */
  journalMode?: LocalSqliteJournalMode;
  /** `PRAGMA synchronous`. Default: `"normal"`. */
  synchronous?: LocalSqliteSynchronousMode;
  /** `PRAGMA busy_timeout`, in milliseconds. Default: `5000`. */
  busyTimeoutMs?: number;
  /**
   * `PRAGMA cache_size`, expressed as a negative KiB value. Positive values
   * mean pages in SQLite and are rejected to prevent accidental oversizing.
   */
  cacheSizeKib?: number | undefined;
  /** `PRAGMA mmap_size`, in non-negative bytes. */
  mmapSizeBytes?: number | undefined;
  /**
   * `PRAGMA wal_autocheckpoint`, in WAL pages. Use `0` to disable automatic
   * checkpoints and run them explicitly after controlled bulk loads.
   */
  walAutocheckpointPages?: number | undefined;
}>;

/** Defaults for TypeGraph-owned local SQLite connections. */
export const DEFAULT_LOCAL_SQLITE_PRAGMAS: Required<LocalSqlitePragmaOptions> =
  {
    journalMode: "wal",
    synchronous: "normal",
    busyTimeoutMs: 5000,
    cacheSizeKib: undefined,
    mmapSizeBytes: undefined,
    walAutocheckpointPages: undefined,
  };
