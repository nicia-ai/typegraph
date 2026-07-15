/**
 * TypeGraph/SQLite (better-sqlite3) engine driver — the embedded pairing
 * against LadybugDB. Loads through the trusted initial-import path,
 * checkpoints the WAL, then runs the documented production path (`refreshStatistics` +
 * `materializeIndexes`) before any query is measured
 * (docs/design/benchmark-program-plan.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";

import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

import { assertMessageIndexMaterialized, snbGraph } from "../schema/snb-graph";
import { createSnbQueries } from "./typegraph-queries";
import { loadSnbDataset } from "./typegraph-load";
import { type SnbEngineFactory, type SnbEngineHandle } from "./types";

const MIN_OS_RESERVE_BYTES = 2 * 1024 ** 3;
const OS_RESERVE_FRACTION = 0.2;

/**
 * `PRAGMA wal_autocheckpoint`, in WAL pages. SQLite's own default (1,000
 * pages, ~4MiB) checkpoints WAL back into the main database file often
 * enough for a normal read/write mix, but a large bulk load pays
 * increasingly expensive checkpoints as the file grows over the course of
 * the load — each checkpoint flushes WAL frames into a B-tree that's
 * larger, and less page-cache-resident, than the one before it. A local
 * repro (real bulkCreate() calls, 100K/500K/2M synthetic rows) swept this
 * value and found the win plateaus (then reverses — an oversized WAL has
 * its own costs) around 50,000-100,000 pages, cutting the 2M-row case's
 * wall-clock time by over 50% versus the default.
 */
const WAL_AUTOCHECKPOINT_PAGES = 100_000;

/**
 * Host-aware `PRAGMA cache_size`, mirroring `resolveNeo4jMemorySettings` in
 * neo4j.ts: reserve the larger of 2GiB or 20% of total host memory for the
 * OS/Node process (lower than Neo4j's 4GiB reserve since there's no JVM
 * overhead to account for), then dedicate the rest to SQLite's page cache.
 * SQLite's own built-in default is a tiny 2MiB — fine for the small SF1
 * dataset, but once the database's working set exceeds available cache
 * (SF10: 30-50GB), every candidate row a query touches pays a fresh disk
 * read instead of a cache hit. Runs in-process on the harness host (unlike
 * Neo4j/Postgres, which run in their own Docker containers), so
 * `os.totalmem()` is the right host-memory figure with no Docker
 * indirection needed.
 */
function resolveSqliteCacheSizeKib(totalBytes: number): number {
  const reserve = Math.max(
    MIN_OS_RESERVE_BYTES,
    totalBytes * OS_RESERVE_FRACTION,
  );
  const usable = Math.max(totalBytes - reserve, MIN_OS_RESERVE_BYTES);
  return -Math.floor(usable / 1024);
}

export const createTypegraphSqliteEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const tempDir = mkdtempSync(join(tmpdir(), "typegraph-bench-snb-sqlite-"));

  try {
    // No `indexes` option here — snb-graph.ts's SNB-specific covering
    // index is declared via `defineGraph({ indexes })` instead, so
    // `store.materializeIndexes()` below genuinely defers its creation to
    // after the bulk load, instead of baking it into this eager DDL where
    // every insert would pay its maintenance cost live.
    const tables = createSqliteTables({});
    const { backend, db } = createLocalSqliteBackend({
      tables,
      path: join(tempDir, "snb.db"),
      pragmas: {
        cacheSizeKib: resolveSqliteCacheSizeKib(totalmem()),
        walAutocheckpointPages: WAL_AUTOCHECKPOINT_PAGES,
      },
    });
    // Drizzle attaches the raw better-sqlite3 handle as `$client` at
    // runtime; the published type omits it (see
    // local-pragma-defaults.test.ts for the same escape hatch).
    const sqliteClient = (db as unknown as { $client: Database.Database })
      .$client;
    // createStoreWithSchema (not the sync createStore) is the documented
    // production boot path: it runs DDL/bootstrap and durably materializes
    // runtime contributions, which materializeIndexes() below requires.
    // Keep automatic refresh disabled: the trusted import and the explicit
    // post-load call below each own their statistics boundary.
    const [store] = await createStoreWithSchema(snbGraph, backend, {
      queryDefaults: { traversalExpansion: "none" },
      autoRefreshStatistics: false,
    });

    return {
      name: "typegraph-sqlite",
      fairness:
        "in-process better-sqlite3, file-backed (WAL, synchronous=NORMAL — " +
        "createLocalSqliteBackend's documented default; cache_size sized " +
        "host-aware from total memory, mirroring the Neo4j memory-" +
        "recommendation fix — SQLite's own 2MiB default cache silently " +
        "turns every candidate row past that into a disk read once the " +
        "working set outgrows it; wal_autocheckpoint raised from SQLite's " +
        "~4MiB default — a bulk load otherwise pays increasingly expensive " +
        "checkpoints as the file grows over the course of the load, " +
        "confirmed via a local repro showing >50% wall-clock improvement " +
        "at 2M rows; an explicit final wal_checkpoint(TRUNCATE) after load " +
        "folds the WAL fully back into the main file before any query is " +
        "measured, so query latency never pays a WAL-scan cost the other " +
        "engines don't); indexes materialized and statistics refreshed " +
        "after an atomic trusted initial import, matching the documented " +
        "fresh-database path.",
      async load() {
        const pools = await loadSnbDataset(
          store,
          options.datasetRoot,
          options.log,
        );
        sqliteClient.pragma("wal_checkpoint(TRUNCATE)");
        await store.refreshStatistics();
        assertMessageIndexMaterialized(await store.materializeIndexes());
        return pools;
      },
      queries: createSnbQueries(store),
      async close() {
        await backend.close();
        rmSync(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
};
