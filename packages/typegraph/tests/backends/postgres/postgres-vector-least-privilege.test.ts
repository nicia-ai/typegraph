/**
 * Regression test for the prod failure that drove the marker-based vector
 * gate: a least-privilege Postgres role (USAGE on schema `public`, full DML,
 * but NO `CREATE`) must be able to run every runtime vector op — because the
 * privileged migrator (`createStoreWithSchema`) provisions each per-`(kind,
 * field)` embedding table + durable marker up front, and the runtime hot path
 * only ASSERTS the marker (a SELECT) instead of issuing `CREATE TABLE`.
 *
 * Before the fix, `upsertEmbedding`/`vectorSearch` lazily ran
 * `CREATE TABLE IF NOT EXISTS` on the request connection, which a USAGE-only
 * role rejects with `permission denied for schema public` (SQLSTATE 42501) —
 * even when the table already exists, because Postgres runs the schema
 * aclcheck before the `IF NOT EXISTS` short-circuit.
 *
 * Skipped unless `POSTGRES_URL` is set (or `scripts/test-postgres.sh`).
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  defineGraph,
  defineNode,
  embedding,
  pgvectorStrategy,
  StoreNotInitializedError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const LEAST_PRIV_ROLE = "tg_vec_lp_runtime";
const LEAST_PRIV_PASSWORD = "lp_runtime_pw";

const Document = defineNode("Doc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(4),
  }),
});

const VecGraph = defineGraph({
  // Distinct graph id so this file runs alongside the other postgres suites.
  id: "pg_vector_least_privilege",
  nodes: { Doc: { type: Document } },
  edges: {},
});

const PER_FIELD_TABLE = pgvectorStrategy.tableName(
  VecGraph.id,
  "Doc",
  "embedding",
);
const CONTRIB_MAT_TABLE = "typegraph_contribution_materializations";

let ownerPool: Pool | undefined;
let leastPrivPool: Pool | undefined;
let postgresAvailable = false;

/** A Pool authenticating as the USAGE-only role against the same database. */
function leastPrivConnection(): Pool {
  const url = new URL(TEST_DATABASE_URL);
  return new Pool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: LEAST_PRIV_ROLE,
    password: LEAST_PRIV_PASSWORD,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  try {
    ownerPool = new Pool({ connectionString: TEST_DATABASE_URL });
    await ownerPool.query("SELECT 1");
    // Base typegraph_* tables for the shared test database.
    await ownerPool.query(generatePostgresMigrationSQL());

    // (Re)create the least-privilege runtime role: USAGE + full DML, but no
    // CREATE on schema public — the exact prod `nicia_app` shape.
    await ownerPool.query(`DROP OWNED BY ${LEAST_PRIV_ROLE}`).catch(() => {
      // The role may not exist yet (first run) — nothing to drop.
    });
    await ownerPool.query(`DROP ROLE IF EXISTS ${LEAST_PRIV_ROLE}`);
    await ownerPool.query(
      `CREATE ROLE ${LEAST_PRIV_ROLE} LOGIN PASSWORD '${LEAST_PRIV_PASSWORD}'`,
    );
    await ownerPool.query(`GRANT USAGE ON SCHEMA public TO ${LEAST_PRIV_ROLE}`);
    await ownerPool.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${LEAST_PRIV_ROLE}`,
    );
    // DML on tables the owner creates later (the per-field vector table).
    await ownerPool.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${LEAST_PRIV_ROLE}`,
    );
    // The crux: deny DDL. (Legacy databases grant CREATE to PUBLIC.)
    await ownerPool.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await ownerPool.query(
      `REVOKE CREATE ON SCHEMA public FROM ${LEAST_PRIV_ROLE}`,
    );

    leastPrivPool = leastPrivConnection();
    await leastPrivPool.query("SELECT 1");
    postgresAvailable = true;
  } catch {
    postgresAvailable = false;
  }
});

afterAll(async () => {
  if (leastPrivPool) await leastPrivPool.end();
  if (ownerPool && postgresAvailable) {
    // Restore PUBLIC's CREATE so we don't leave the shared test database
    // more restrictive than other suites expect, then drop the role.
    await ownerPool.query(`GRANT CREATE ON SCHEMA public TO PUBLIC`);
    await ownerPool.query(`DROP OWNED BY ${LEAST_PRIV_ROLE}`).catch(() => {
      // The role may not exist yet (first run) — nothing to drop.
    });
    await ownerPool.query(`DROP ROLE IF EXISTS ${LEAST_PRIV_ROLE}`);
  }
  if (ownerPool) await ownerPool.end();
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL vector ops under a least-privilege (USAGE-only) role",
  () => {
    const transientPools: Pool[] = [];

    function ownerBackend(): ReturnType<typeof createPostgresBackend> {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL });
      transientPools.push(pool);
      return createPostgresBackend(drizzle(pool));
    }

    function runtimeBackend(): ReturnType<typeof createPostgresBackend> {
      const pool = leastPrivConnection();
      transientPools.push(pool);
      return createPostgresBackend(drizzle(pool));
    }

    beforeEach(async () => {
      if (!postgresAvailable || !ownerPool) return;
      // Start each test genuinely un-provisioned for this graph.
      await ownerPool.query(`DROP TABLE IF EXISTS "${PER_FIELD_TABLE}"`);
      await ownerPool.query(
        `DELETE FROM ${CONTRIB_MAT_TABLE} WHERE graph_id = $1`,
        [VecGraph.id],
      );
      await ownerPool.query(`DELETE FROM typegraph_nodes WHERE graph_id = $1`, [
        VecGraph.id,
      ]);
    });

    afterEach(async () => {
      while (transientPools.length > 0) {
        const pool = requireDefined(transientPools.pop());
        await pool.end();
      }
    });

    it("the runtime role genuinely lacks CREATE on schema public (control)", async () => {
      await expect(
        requireDefined(leastPrivPool).query(
          `CREATE TABLE tg_lp_probe (id text)`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("owner provisions; the USAGE-only role then upserts + searches with zero DDL", async () => {
      // Privileged migrator (owner) creates the per-field table + marker.
      await createStoreWithSchema(VecGraph, ownerBackend());

      // The per-field vector table now exists, owned by the migrator.
      const tableExists = await requireDefined(ownerPool).query<{
        exists: boolean;
      }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_tables
           WHERE schemaname = 'public' AND tablename = $1
         ) AS exists`,
        [PER_FIELD_TABLE],
      );
      expect(tableExists.rows[0]?.exists).toBe(true);

      // Runtime attaches as the least-privilege role and verifies markers
      // (SELECT-only) — exercising the createVerifiedStore vector gate.
      const [store] = await createVerifiedStore(VecGraph, runtimeBackend());

      // The write that reproduced `permission denied for schema public`
      // before the fix now succeeds: assert marker (SELECT) + INSERT (DML).
      const near = await store.nodes.Doc.create({
        title: "near",
        embedding: [1, 0, 0, 0],
      });
      await store.nodes.Doc.create({ title: "far", embedding: [0, 0, 0, 1] });

      const hits = await store.search.vector("Doc", {
        fieldPath: "embedding",
        queryEmbedding: [1, 0, 0, 0],
        limit: 2,
        metric: "cosine",
      });
      expect(hits.map((hit) => hit.node.id)).toContain(near.id);
      expect(hits[0]?.node.title).toBe("near");
    });

    it("an un-provisioned slot makes the runtime role throw StoreNotInitializedError, not a DDL permission error", async () => {
      // No owner provisioning this time. The hot path asserts the (missing)
      // durable marker via SELECT and refuses loudly — it must NOT attempt
      // CREATE TABLE and surface a raw 42501.
      const store = createStore(VecGraph, runtimeBackend());

      const error = await store.nodes.Doc.create({
        title: "x",
        embedding: [1, 0, 0, 0],
      }).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(StoreNotInitializedError);
      expect((error as StoreNotInitializedError).code).toBe(
        "STORE_NOT_INITIALIZED",
      );
    });
  },
);
