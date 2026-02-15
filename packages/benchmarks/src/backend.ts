import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createStore } from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  getPostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite";

import { DEFAULT_POSTGRES_URL, type PerfBackend } from "./config";
import { perfGraph, type PerfStore } from "./graph";

type BackendResources = Readonly<{
  store: PerfStore;
  close: () => Promise<void>;
}>;

function getPostgresUrl(): string {
  return process.env.POSTGRES_URL ?? DEFAULT_POSTGRES_URL;
}

async function resetPostgresTables(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
    DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
    DROP TABLE IF EXISTS typegraph_edges CASCADE;
    DROP TABLE IF EXISTS typegraph_nodes CASCADE;
    DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  `);
  await pool.query(getPostgresMigrationSQL());
}

export async function createBackendResources(
  backend: PerfBackend,
): Promise<BackendResources> {
  if (backend === "sqlite") {
    const sqlite = createLocalSqliteBackend();
    return {
      store: createStore(perfGraph, sqlite.backend, {
        queryDefaults: { traversalExpansion: "none" },
      }),
      close: async () => sqlite.backend.close(),
    };
  }

  const pool = new Pool({
    connectionString: getPostgresUrl(),
  });
  const drizzleDb = drizzlePostgres(pool);

  try {
    await resetPostgresTables(pool);
  } catch (error) {
    await pool.end().catch(() => {
      // Best effort cleanup after connection/init failures.
    });
    throw new Error(
      `Failed to initialize PostgreSQL perf backend at ${getPostgresUrl()}. ` +
        "Ensure POSTGRES_URL points to a reachable database.",
      { cause: error },
    );
  }

  const postgresBackend = createPostgresBackend(drizzleDb);
  return {
    store: createStore(perfGraph, postgresBackend, {
      queryDefaults: { traversalExpansion: "none" },
    }),
    close: async () => {
      await postgresBackend.close();
      await pool.end();
    },
  };
}
