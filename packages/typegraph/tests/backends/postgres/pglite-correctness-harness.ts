/**
 * Shared harness for the PGlite Postgres correctness lane.
 *
 * Boots ONE in-process PGlite engine (Postgres-in-WASM, pgvector loaded) per
 * importing test file and resets state between tests instead of re-booting —
 * the same shared-connection + reset strategy the Docker lane uses
 * (`postgres-backend.test.ts`). A per-test WASM boot would cost ~0.5 s, and the
 * reused adapter + integration suites run ~250 tests; one boot per file plus a
 * truncate keeps the lane inside the default `pnpm test` budget.
 *
 * The engine is owned solely by this harness. `setupSharedPgliteEngine` keeps
 * `createLocalPgliteBackend`'s `{ db, client }` and **discards its managed
 * `backend`** — whose `close()` disposes the engine. `makeBackend()` hands out a
 * plain `createPostgresBackend(db)` whose `close()` is a client no-op
 * (`backend/drizzle/postgres.ts`), so the suites' per-test `backend.close()` can
 * never kill the shared engine. Disposal happens exactly once, in `dispose()`.
 */
import { type PGlite } from "@electric-sql/pglite";
import { getTableName, is, Table } from "drizzle-orm";

import {
  createPostgresBackend,
  tables as defaultTables,
} from "../../../src/backend/postgres";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { type GraphBackend } from "../../../src/backend/types";

/**
 * Every TypeGraph-managed table name, derived from the schema module rather
 * than hand-copied from an older `clearTestData`. Postgres has grown past the
 * original five (it now also owns `index_materializations`,
 * `contribution_materializations`, `kind_removals`, `reconciliation_markers`);
 * deriving the list via `getTableName` over the default tables means a future
 * table can't silently leak across tests.
 */
const MANAGED_TABLE_NAMES: readonly string[] = Object.values(defaultTables)
  .filter((value) => is(value, Table))
  .map((table) => getTableName(table));

/** Single TRUNCATE over every managed table — built once from the static list. */
const TRUNCATE_MANAGED_SQL = `TRUNCATE ${MANAGED_TABLE_NAMES.map(
  (name) => `"${name}"`,
).join(", ")} CASCADE`;

/**
 * A booted PGlite engine shared across one test file, with the reset
 * primitives the reused suites and the vector-paths tests need.
 */
export type SharedPgliteEngine = Readonly<{
  /** Raw PGlite client, for strategy-level SQL driven directly. */
  client: PGlite;
  /**
   * A fresh plain backend over the shared engine. Its `close()` is a client
   * no-op, so the adapter suite's per-test close never disposes the engine.
   */
  makeBackend: () => GraphBackend;
  /** TRUNCATE all managed metadata/data tables — default per-test isolation. */
  resetData: () => Promise<void>;
  /**
   * TRUNCATE the lazily-created per-field vector tables (`tg_vec_*`). Keeps the
   * `vector(N)` column type, so it is row isolation only.
   */
  truncateVectorTables: () => Promise<void>;
  /**
   * DROP the per-field vector tables (`tg_vec_*`). Structural reset for tests
   * that change a field's dimension or reclaim storage, where a leftover
   * `vector(3)` table would reject a later `vector(4)` insert.
   */
  dropVectorTables: () => Promise<void>;
  /** Dispose the underlying PGlite engine. Call once in `afterAll`. */
  dispose: () => Promise<void>;
}>;

/**
 * Boots a shared PGlite engine with pgvector and the schema migrated. Call in
 * `beforeAll`; call the returned `dispose()` in `afterAll`.
 */
export async function setupSharedPgliteEngine(): Promise<SharedPgliteEngine> {
  // Keep only the engine handles; the managed backend (engine-closing) is
  // deliberately discarded — see the module doc comment.
  const { db, client } = await createLocalPgliteBackend();

  return {
    client,
    makeBackend: () => createPostgresBackend(db),
    resetData: async () => {
      await client.exec(TRUNCATE_MANAGED_SQL);
    },
    truncateVectorTables: async () => {
      for (const name of await listVectorTables(client)) {
        await client.exec(`TRUNCATE "${name}" CASCADE`);
      }
    },
    dropVectorTables: async () => {
      for (const name of await listVectorTables(client)) {
        await client.exec(`DROP TABLE IF EXISTS "${name}" CASCADE`);
      }
    },
    dispose: async () => {
      await client.close();
    },
  };
}

/**
 * Names of the strategy-owned per-field vector tables (`tg_vec_*`) currently
 * present. They are materialized lazily, so there is no single shared table to
 * reset.
 */
async function listVectorTables(client: PGlite): Promise<readonly string[]> {
  const result = await client.query<{ tablename: string }>(
    String.raw`SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename LIKE 'tg_vec\_%'`,
  );
  return result.rows.map((row) => row.tablename);
}
