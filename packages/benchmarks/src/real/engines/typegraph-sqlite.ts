/**
 * TypeGraph/SQLite (better-sqlite3) engine driver — the embedded pairing
 * against LadybugDB. Loads via `bulkInsert`, then runs the documented
 * production path (`refreshStatistics` + `materializeIndexes`) before any
 * query is measured (docs/design/benchmark-program-plan.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

import { snbGraph, snbIndexes } from "../schema/snb-graph";
import { createSnbQueries } from "./typegraph-queries";
import { loadSnbDataset } from "./typegraph-load";
import { type SnbEngineFactory, type SnbEngineHandle } from "./types";

const MIN_OS_RESERVE_BYTES = 2 * 1024 ** 3;
const OS_RESERVE_FRACTION = 0.2;

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
    const tables = createSqliteTables({}, { indexes: snbIndexes });
    const { backend } = createLocalSqliteBackend({
      tables,
      path: join(tempDir, "snb.db"),
      pragmas: { cacheSizeKib: resolveSqliteCacheSizeKib(totalmem()) },
    });
    // createStoreWithSchema (not the sync createStore) is the documented
    // production boot path: it runs DDL/bootstrap and durably materializes
    // runtime contributions, which materializeIndexes() below requires.
    // Auto-refresh-after-bulk would otherwise re-run refreshStatistics()
    // on every large bulkInsert() call during the load below (each of our
    // batches already exceeds the default row threshold on its own) — pure
    // redundant work, since load() already calls refreshStatistics() itself
    // exactly once after the whole dataset is in.
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
        "working set outgrows it); indexes materialized and statistics " +
        "refreshed after bulk load, matching the documented production path.",
      async load() {
        const pools = await loadSnbDataset(
          store,
          options.datasetRoot,
          options.log,
        );
        await store.refreshStatistics();
        await store.materializeIndexes();
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
