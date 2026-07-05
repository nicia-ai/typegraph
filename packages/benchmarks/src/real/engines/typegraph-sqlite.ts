/**
 * TypeGraph/SQLite (better-sqlite3) engine driver — the embedded pairing
 * against LadybugDB. Loads via `bulkInsert`, then runs the documented
 * production path (`refreshStatistics` + `materializeIndexes`) before any
 * query is measured (docs/design/benchmark-program-plan.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreWithSchema } from "@nicia-ai/typegraph";
import { createSqliteTables } from "@nicia-ai/typegraph/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

import { snbGraph, snbIndexes } from "../schema/snb-graph";
import { createSnbQueries } from "./typegraph-queries";
import { loadSnbDataset } from "./typegraph-load";
import { type SnbEngineFactory, type SnbEngineHandle } from "./types";

export const createTypegraphSqliteEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const tempDir = mkdtempSync(join(tmpdir(), "typegraph-bench-snb-sqlite-"));

  try {
    const tables = createSqliteTables({}, { indexes: snbIndexes });
    const { backend } = createLocalSqliteBackend({
      tables,
      path: join(tempDir, "snb.db"),
    });
    // createStoreWithSchema (not the sync createStore) is the documented
    // production boot path: it runs DDL/bootstrap and durably materializes
    // runtime contributions, which materializeIndexes() below requires.
    const [store] = await createStoreWithSchema(snbGraph, backend, {
      queryDefaults: { traversalExpansion: "none" },
    });

    return {
      name: "typegraph-sqlite",
      fairness:
        "in-process better-sqlite3, file-backed (WAL, synchronous=NORMAL — " +
        "createLocalSqliteBackend's documented default); indexes materialized " +
        "and statistics refreshed after bulk load, matching the documented " +
        "production path.",
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
