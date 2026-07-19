import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres, { type Sql } from "postgres";
import {
  createStore,
  type GraphBackend,
  resolveGraphVectorSlots,
} from "@nicia-ai/typegraph";
import {
  createPostgresBackend,
  createPostgresTables,
  generatePostgresMigrationSQL,
} from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createSqliteTables } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";

import {
  getPostgresUrl,
  type PerfBackend,
  type PostgresDriver,
  type SqliteStorage,
} from "./config";
import { perfGraph, perfIndexes, type PerfStore } from "./graph";

type BackendResources = Readonly<{
  store: PerfStore;
  /**
   * The raw backend, for benches that need their own store construction
   * (e.g. the vector bench commits a schema version so
   * `materializeIndexes()` works — the sync `createStore` harness path
   * deliberately skips that boot step).
   */
  backend: GraphBackend;
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

// Embeddings live in per-`(graphId, kind, field)` tables (`tg_vec_*`),
// provisioned by the privileged boot step, so a clean reset drops whatever
// this graph materialized in a prior run — there is no single shared
// embeddings table. The durable contribution markers are dropped in lockstep:
// a marker that outlived its dropped `tg_vec_*` table would make the next
// provisioning pass trust it and skip the CREATE.
const POSTGRES_RESET_DDL = `
  DO $$
  DECLARE tbl text;
  BEGIN
    FOR tbl IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec_%'
    LOOP
      EXECUTE format('DROP TABLE IF EXISTS %I CASCADE', tbl);
    END LOOP;
  END $$;
  DROP TABLE IF EXISTS typegraph_node_uniques CASCADE;
  DROP TABLE IF EXISTS typegraph_edges CASCADE;
  DROP TABLE IF EXISTS typegraph_nodes CASCADE;
  DROP TABLE IF EXISTS typegraph_schema_versions CASCADE;
  DROP TABLE IF EXISTS typegraph_node_fulltext CASCADE;
  DROP TABLE IF EXISTS typegraph_index_materializations CASCADE;
  DROP TABLE IF EXISTS typegraph_contribution_materializations CASCADE;
`;

/**
 * The vector counterpart of `ensureRuntimeContributions`: provision every
 * embedding `(kind, field)` slot's per-field table + durable marker — the
 * boot step `createStoreWithSchema` performs, done manually here because the
 * harness deliberately uses the sync `createStore` attach. A no-op per slot
 * on backends without vector support (`ensureVectorSlotContribution` absent,
 * e.g. SQLite without sqlite-vec).
 */
async function materializePerfVectorSlots(
  backend: GraphBackend,
): Promise<void> {
  for (const slot of resolveGraphVectorSlots(perfGraph)) {
    await backend.ensureVectorSlotContribution?.(slot);
  }
}

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
  sqliteStorage: SqliteStorage = "memory",
): Promise<BackendResources> {
  if (backend === "sqlite") {
    const tables = createSqliteTables({}, { indexes: perfIndexes });
    // Route through createLocalSqliteBackend so the suite measures the
    // batteries-included default path — connection pragmas (WAL,
    // synchronous=NORMAL), bind-budget detection, and best-effort
    // sqlite-vec loading included — instead of a hand-assembled variant.
    const tempDir =
      sqliteStorage === "file" ?
        mkdtempSync(join(tmpdir(), "typegraph-perf-"))
      : undefined;
    const { backend: sqliteBackend } = createLocalSqliteBackend({
      tables,
      ...(tempDir === undefined ? {} : { path: join(tempDir, "perf.db") }),
    });
    // #135: the harness builds the schema via raw DDL and uses the sync
    // createStore, so it writes the durable fulltext-materialization
    // marker itself — the boot step createStoreWithSchema performs.
    await sqliteBackend.ensureRuntimeContributions?.(perfGraph.id);
    await materializePerfVectorSlots(sqliteBackend);
    return {
      store: createStore(perfGraph, sqliteBackend, {
        queryDefaults: { traversalExpansion: "none" },
      }),
      backend: sqliteBackend,
      close: async () => {
        await sqliteBackend.close();
        if (tempDir !== undefined) {
          rmSync(tempDir, { recursive: true, force: true });
        }
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
    await postgresBackend.ensureRuntimeContributions?.(perfGraph.id);
    await materializePerfVectorSlots(postgresBackend);
    return {
      store: createStore(perfGraph, postgresBackend, {
        queryDefaults: { traversalExpansion: "none" },
      }),
      backend: postgresBackend,
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
  await postgresBackend.ensureRuntimeContributions?.(perfGraph.id);
  await materializePerfVectorSlots(postgresBackend);
  return {
    store: createStore(perfGraph, postgresBackend, {
      queryDefaults: { traversalExpansion: "none" },
    }),
    backend: postgresBackend,
    close: async () => {
      await postgresBackend.close();
      await sql.end();
    },
    hasVectorPredicate: true,
    hasHybridFacade: true,
  };
}
