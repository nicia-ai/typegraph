/**
 * PostgreSQL schema write fence vs. a concurrent schema commit (#365).
 *
 * `lockSchemaVersionForWrite` takes a `FOR SHARE` lock on the graph's active
 * schema row. At `read committed`, a locking read that blocks behind an
 * in-flight schema commit rechecks only the row versions its own statement
 * snapshot saw: once the winner marks the old row inactive, the recheck drops
 * it, and the winner's freshly inserted active row was never in that snapshot.
 * The statement therefore returns no row even though the graph does have an
 * active version — which the fence used to report as `actual: 0`.
 *
 * The last case is the read-path audit that accompanies the fix: the
 * non-locking `getActiveSchema` seam — which `computeBaseVersion` reads through
 * to stamp the active version into a merge base token — must never observe the
 * same "no active schema" transient, because the flip is atomic within the
 * winner's transaction and a non-locking read has no post-wait recheck.
 *
 * Server Postgres only, and not just for the usual `POSTGRES_URL` reason: the
 * anomaly needs a second connection holding an uncommitted flip, which the
 * single-connection PGlite lane cannot provide.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  StaleVersionError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { computeBaseVersion } from "../../../src/graph-merge/base-version";
import {
  computeSchemaHash,
  serializeSchema,
} from "../../../src/schema/serializer";
import { requireDefined } from "../../../src/utils/presence";
import { raceTimeout, TIMEOUT_SENTINEL } from "../../concurrency-utils";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

/** Bound proving an operation is blocked rather than merely slow. */
const BLOCKED_WAIT_MS = 500;

const FENCE_GRAPH_ID = "schema_write_fence_race";
const BASE_VERSION_GRAPH_ID = "schema_write_fence_base_version";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Place = defineNode("Place", {
  schema: z.object({ city: z.string() }),
});

function makeGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

/**
 * A second version of the graph. Only the STORED document differs — the
 * in-memory graph a Store holds is unchanged, which is what makes the base
 * token's version component (rather than its schema hash) the thing under
 * test.
 */
function makeNextGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person }, Place: { type: Place } },
    edges: {},
  });
}

let pool: Pool | undefined;

function requirePool(): Pool {
  return requireDefined(pool, "PostgreSQL pool was not initialized");
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  await candidate.query("SELECT 1");
  await candidate.query(generatePostgresMigrationSQL());
  pool = candidate;
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

/** Locking reads the fence issues against the active schema row. */
function lockingReadCount(statements: readonly string[]): number {
  return statements.filter((statement) => /for share/i.test(statement)).length;
}

/**
 * Holds an uncommitted schema flip to `version` open on its own connection,
 * reproducing the row states a real `commitSchemaVersion` reaches just before
 * it commits: the previously active row already marked inactive, the new
 * active row inserted but not yet visible to anyone else.
 *
 * The statement pair mirrors `commitSchemaVersion`'s fresh-insert path in
 * `operation-backend-core.ts` by hand, because the flip has to stay uncommitted
 * while the loser blocks on it and no seam in `migrateSchema` can hold that
 * position. Keep the two in step: a `commitSchemaVersion` that stopped
 * deactivating the prior row before inserting the new one would no longer
 * produce the row states this suite reasons about.
 */
async function beginHeldSchemaFlip(
  graphId: string,
  version: number,
): Promise<PoolClient> {
  const schemaDocument = serializeSchema(makeNextGraph(graphId), version);
  const client = await requirePool().connect();
  await client.query("BEGIN");
  await client.query(
    `UPDATE typegraph_schema_versions
       SET is_active = FALSE
     WHERE graph_id = $1`,
    [graphId],
  );
  await client.query(
    `INSERT INTO typegraph_schema_versions
       (graph_id, version, schema_hash, schema_doc, created_at, is_active)
     VALUES ($1, $2, $3, $4::jsonb, NOW(), TRUE)`,
    [
      graphId,
      version,
      computeSchemaHash(schemaDocument),
      JSON.stringify(schemaDocument),
    ],
  );
  return client;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL schema write fence under a concurrent schema commit",
  () => {
    let flipHolder: PoolClient | undefined;

    beforeEach(async () => {
      await requirePool().query(
        `TRUNCATE typegraph_revision_origins,
                  typegraph_recorded_clock,
                  typegraph_recorded_nodes,
                  typegraph_recorded_edges,
                  typegraph_recorded_identity_assertions,
                  typegraph_identity_closure,
                  typegraph_identity_assertions,
                  typegraph_nodes,
                  typegraph_edges,
                  typegraph_node_uniques,
                  typegraph_schema_versions CASCADE`,
      );
      flipHolder = undefined;
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      // Only reached when a test failed before committing the held flip; the
      // connection may already be unusable, so the rollback is best-effort.
      if (flipHolder === undefined) return;
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await flipHolder.query("ROLLBACK").catch(() => {});
      flipHolder.release();
      flipHolder = undefined;
    });

    it("reports the winner's committed version as actual, not 0", async () => {
      const graph = makeGraph(FENCE_GRAPH_ID);
      const backend = createPostgresBackend(drizzle(requirePool()));
      const [store] = await createStoreWithSchema(graph, backend);

      flipHolder = await beginHeldSchemaFlip(FENCE_GRAPH_ID, 2);

      // The managed write's fence blocks on the row lock the held flip took
      // over the version-1 row.
      const pendingWrite = store.nodes.Person.create({ name: "Alice" });
      const rejection = pendingWrite.catch((error: unknown) => error);
      expect(await raceTimeout(rejection, BLOCKED_WAIT_MS)).toBe(
        TIMEOUT_SENTINEL,
      );

      await requireDefined(flipHolder).query("COMMIT");
      requireDefined(flipHolder).release();
      flipHolder = undefined;

      const error = await rejection;
      expect(error).toBeInstanceOf(StaleVersionError);
      expect((error as StaleVersionError).details).toMatchObject({
        graphId: FENCE_GRAPH_ID,
        expected: 1,
        actual: 2,
      });

      // The version the fence reported is the one a fresh read sees.
      const active = await backend.getActiveSchema(FENCE_GRAPH_ID);
      expect(requireDefined(active).version).toBe(2);
    });

    /**
     * The empty read must be resolved without waiting on the schema rows a
     * second time. The dropped row keeps the share lock the first read took on
     * it, so a second `FOR SHARE` waits on the row the next schema commit has
     * already taken `FOR UPDATE` while that commit waits on the dropped row in
     * its deactivate-all — a cycle PostgreSQL breaks by killing one of them,
     * and the schema commit waits first and so times out first. Two migrations
     * applied back to back (the second released the instant the first commits,
     * exactly when the fence wakes) is enough to hit it.
     */
    it("resolves the empty locked read without locking the row again", async () => {
      const querySpy = vi.spyOn(requirePool(), "query");
      const backend = createPostgresBackend(drizzle(requirePool()));
      const [store] = await createStoreWithSchema(
        makeGraph(FENCE_GRAPH_ID),
        backend,
      );

      flipHolder = await beginHeldSchemaFlip(FENCE_GRAPH_ID, 2);

      querySpy.mockClear();
      const rejection = store.nodes.Person.create({ name: "Alice" }).catch(
        (error: unknown) => error,
      );
      expect(await raceTimeout(rejection, BLOCKED_WAIT_MS)).toBe(
        TIMEOUT_SENTINEL,
      );

      await requireDefined(flipHolder).query("COMMIT");
      requireDefined(flipHolder).release();
      flipHolder = undefined;

      expect(await rejection).toBeInstanceOf(StaleVersionError);
      const statements = querySpy.mock.calls.flatMap((call) => {
        const query: unknown = call[0];
        if (typeof query === "string") return [query];
        if (
          typeof query === "object" &&
          query !== null &&
          "text" in query &&
          typeof query.text === "string"
        ) {
          return [query.text];
        }
        return [];
      });
      querySpy.mockRestore();
      expect(lockingReadCount(statements)).toBe(1);
    });

    it("still reports actual 0 when the graph genuinely has no active schema", async () => {
      const graph = makeGraph(FENCE_GRAPH_ID);
      const backend = createPostgresBackend(drizzle(requirePool()));
      const [store] = await createStoreWithSchema(graph, backend);

      // Deactivate out of band, committed: the fence's re-read confirms the
      // absence rather than papering over it with a stale version.
      await requirePool().query(
        `UPDATE typegraph_schema_versions
           SET is_active = FALSE
         WHERE graph_id = $1`,
        [FENCE_GRAPH_ID],
      );

      const error = await store.nodes.Person.create({ name: "Alice" }).catch(
        (error_: unknown) => error_,
      );
      expect(error).toBeInstanceOf(StaleVersionError);
      expect((error as StaleVersionError).details).toMatchObject({
        expected: 1,
        actual: 0,
      });
    });

    it("keeps the non-locking active-schema read free of the transient", async () => {
      const graph = makeGraph(BASE_VERSION_GRAPH_ID);
      const backend = createPostgresBackend(drizzle(requirePool()));
      const [store] = await createStoreWithSchema(graph, backend, {
        revisionTracking: true,
      });
      const beforeFlip = await computeBaseVersion(store);

      flipHolder = await beginHeldSchemaFlip(BASE_VERSION_GRAPH_ID, 2);

      // A non-locking read never waits on the held flip's row lock, so it has
      // no post-wait recheck to be fooled by: it reads the last committed
      // state, where version 1 is still active.
      const during = await backend.getActiveSchema(BASE_VERSION_GRAPH_ID);
      expect(requireDefined(during).version).toBe(1);
      expect(await computeBaseVersion(store)).toBe(beforeFlip);

      await requireDefined(flipHolder).query("COMMIT");
      requireDefined(flipHolder).release();
      flipHolder = undefined;

      // Once committed, the newly active version is what the token stamps —
      // the schema hash is unchanged (the Store's in-memory graph never
      // moved), so the version component is the only thing that can differ.
      expect(await computeBaseVersion(store)).not.toBe(beforeFlip);
    });
  },
);
