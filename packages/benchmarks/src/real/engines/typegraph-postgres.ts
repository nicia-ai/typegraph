/**
 * TypeGraph/PostgreSQL (node-postgres) engine driver — the server pairing
 * against Neo4j. Launches its own throwaway Postgres container the same way
 * the Neo4j driver does (imperative docker run + tmpfs + harness-allocated
 * port), so neither side of the server pairing depends on an ambient daemon
 * (docs/design/benchmark-program-plan.md).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { createStoreWithSchema } from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";

import { startPostgresContainer } from "../harness/postgres-container";
import { snbGraph, snbIndexes } from "../schema/snb-graph";
import { createSnbQueries } from "./typegraph-queries";
import { loadSnbDataset } from "./typegraph-load";
import { type SnbEngineFactory, type SnbEngineHandle } from "./types";

export const createTypegraphPostgresEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const container = await startPostgresContainer();
  const pool = new Pool({ connectionString: container.connectionString });

  // Anything below can throw (migration SQL, schema bootstrap) after the
  // container is already running; without this, a failure here would leak
  // a docker container the caller never gets a handle to close().
  try {
    const drizzleDb = drizzle(pool);

    // Domain-table DDL (typegraph_nodes/typegraph_edges/...) is a separate
    // concern from schema-versioning bootstrap: createPostgresBackend doesn't
    // create tables itself (unlike createLocalSqliteBackend), so the
    // migration SQL still has to run explicitly before createStoreWithSchema
    // materializes the runtime-contribution markers materializeIndexes() needs.
    const tables = createPostgresTables({}, { indexes: snbIndexes });
    await pool.query(generatePostgresMigrationSQL(tables));
    const backend = createPostgresBackend(drizzleDb, { tables });
    const [store] = await createStoreWithSchema(snbGraph, backend, {
      queryDefaults: { traversalExpansion: "none" },
    });

    return {
      name: "typegraph-postgres",
      fairness:
        `imperative docker Postgres container (${container.durabilityLabel}), ` +
        "node-postgres over localhost TCP; indexes materialized and statistics " +
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
        await pool.end();
        await container.close();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    await container.close();
    throw error;
  }
};
