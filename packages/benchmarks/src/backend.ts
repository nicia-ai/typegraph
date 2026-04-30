import { createRequire } from "node:module";

import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres, { type Sql } from "postgres";
import { createStore } from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/postgres";
import {
  createSqliteBackend,
  createSqliteTables,
  generateSqliteDDL,
} from "@nicia-ai/typegraph/sqlite";

import {
  DEFAULT_POSTGRES_URL,
  type PerfBackend,
  type PostgresDriver,
} from "./config";
import { perfGraph, perfIndexes, type PerfStore } from "./graph";

type BackendResources = Readonly<{
  store: PerfStore;
  close: () => Promise<void>;
  /**
   * True when the backend can evaluate `similarTo()` predicates:
   * `sqlite-vec` is loaded on SQLite, or `pgvector` is available on
   * PostgreSQL. The query-builder vector path uses this.
   */
  hasVectorPredicate: boolean;
  /** True when `store.search.hybrid(...)` works. */
  hasHybridFacade: boolean;
}>;

function getPostgresUrl(): string {
  return process.env.POSTGRES_URL ?? DEFAULT_POSTGRES_URL;
}

/**
 * Attempt to load `sqlite-vec` into a better-sqlite3 connection. Returns
 * true on success. When sqlite-vec is missing (e.g. CI without the
 * optional dep) we quietly skip vector measurements rather than fail.
 */
const sqliteVecRequire = createRequire(import.meta.url);

function loadSqliteVec(sqlite: Database.Database): boolean {
  try {
    const sqliteVec = sqliteVecRequire("sqlite-vec") as {
      load: (db: Database.Database) => void;
    };
    sqliteVec.load(sqlite);
    return true;
  } catch {
    return false;
  }
}

const POSTGRES_RESET_DDL = `
  DROP TABLE IF EXISTS typegraph_node_embeddings CASCADE;
  DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
  DROP TABLE IF EXISTS typegraph_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
`;

async function resetPostgresTablesViaPool(pool: Pool): Promise<void> {
  await pool.query(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({}, { indexes: perfIndexes });
  await pool.query(generatePostgresMigrationSQL(tables));
}

async function resetPostgresTablesViaSql(sql: Sql): Promise<void> {
  await sql.unsafe(POSTGRES_RESET_DDL);
  const tables = createPostgresTables({}, { indexes: perfIndexes });
  await sql.unsafe(generatePostgresMigrationSQL(tables));
}

export async function createBackendResources(
  backend: PerfBackend,
  postgresDriver: PostgresDriver = "pg",
): Promise<BackendResources> {
  if (backend === "sqlite") {
    const tables = createSqliteTables({}, { indexes: perfIndexes });
    const sqlite = new Database(":memory:");
    const hasVectorEmbeddings = loadSqliteVec(sqlite);

    for (const statement of generateSqliteDDL(tables)) {
      sqlite.exec(statement);
    }
    const db = drizzleSqlite(sqlite);
    const sqliteBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      tables,
      hasVectorEmbeddings,
    });
    return {
      store: createStore(perfGraph, sqliteBackend, {
        queryDefaults: { traversalExpansion: "none" },
      }),
      close: async () => {
        sqliteBackend.close();
        sqlite.close();
      },
      hasVectorPredicate: sqliteBackend.upsertEmbedding !== undefined,
      hasHybridFacade: sqliteBackend.vectorSearch !== undefined,
    };
  }

  if (postgresDriver === "pg") {
    const pool = new Pool({
      connectionString: getPostgresUrl(),
    });
    const drizzleDb = drizzleNodePostgres(pool);

    try {
      await resetPostgresTablesViaPool(pool);
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

    const tables = createPostgresTables({}, { indexes: perfIndexes });
    const postgresBackend = createPostgresBackend(drizzleDb, { tables });
    return {
      store: createStore(perfGraph, postgresBackend, {
        queryDefaults: { traversalExpansion: "none" },
      }),
      close: async () => {
        await postgresBackend.close();
        await pool.end();
      },
      // The migration enables the pgvector extension, so vector predicates
      // and the hybrid facade are available on Postgres.
      hasVectorPredicate: true,
      hasHybridFacade: true,
    };
  }

  // postgres-js driver
  const sql = postgres(getPostgresUrl(), {
    max: 10,
    onnotice: () => {
      // Suppress NOTICE spam from IF NOT EXISTS DDL so the perf output
      // stays readable.
    },
  });
  const drizzleDb = drizzlePostgresJs(sql);

  try {
    await resetPostgresTablesViaSql(sql);
  } catch (error) {
    await sql.end().catch(() => {
      // Best effort cleanup after connection/init failures.
    });
    throw new Error(
      `Failed to initialize PostgreSQL perf backend (postgres-js driver) at ${getPostgresUrl()}. ` +
        "Ensure POSTGRES_URL points to a reachable database.",
      { cause: error },
    );
  }

  const tables = createPostgresTables({}, { indexes: perfIndexes });
  const postgresBackend = createPostgresBackend(drizzleDb, { tables });
  return {
    store: createStore(perfGraph, postgresBackend, {
      queryDefaults: { traversalExpansion: "none" },
    }),
    close: async () => {
      await postgresBackend.close();
      await sql.end();
    },
    hasVectorPredicate: true,
    hasHybridFacade: true,
  };
}
