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
} from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { raceTimeout, TIMEOUT_SENTINEL } from "../../concurrency-utils";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const disabledGraph = defineGraph({
  id: "identity_enablement_lock",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
});

const enabledGraph = defineGraph({
  id: disabledGraph.id,
  nodes: disabledGraph.nodes,
  edges: disabledGraph.edges,
  identity: { sameIdAcrossKinds: "fold" },
});

let pool: Pool | undefined;

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

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL identity enablement lock",
  () => {
    let writer: PoolClient | undefined;

    beforeEach(async () => {
      await pool!.query(
        `TRUNCATE typegraph_recorded_identity_assertions,
                  typegraph_identity_closure,
                  typegraph_identity_assertions,
                  typegraph_nodes,
                  typegraph_edges,
                  typegraph_node_uniques,
                  typegraph_schema_versions CASCADE`,
      );
      writer = undefined;
    });

    afterEach(async () => {
      if (writer === undefined) return;
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await writer.query("ROLLBACK").catch(() => {});
      writer.release();
    });

    it("waits for an in-flight legacy node write before building closure", async () => {
      const backend = createPostgresBackend(drizzle(pool!));
      await createStoreWithSchema(disabledGraph, backend);

      writer = await pool!.connect();
      await writer.query("BEGIN");
      await writer.query(
        `INSERT INTO typegraph_nodes
           (graph_id, kind, id, props, valid_from, created_at, updated_at)
         VALUES
           ($1, 'Person', 'shared', $2::jsonb, NOW(), NOW(), NOW()),
           ($1, 'Company', 'shared', $3::jsonb, NOW(), NOW(), NOW())`,
        [
          disabledGraph.id,
          JSON.stringify({ name: "Alice" }),
          JSON.stringify({ name: "Alice LLC" }),
        ],
      );

      const pendingEnablement = createStoreWithSchema(enabledGraph, backend);
      expect(await raceTimeout(pendingEnablement, 500)).toBe(TIMEOUT_SENTINEL);

      await writer.query("COMMIT");
      writer.release();
      writer = undefined;

      const [store] = await pendingEnablement;
      expect(
        await store.identity.membersOf({ kind: "Person", id: "shared" }),
      ).toEqual([
        { kind: "Company", id: "shared" },
        { kind: "Person", id: "shared" },
      ]);
    });

    it("serializes clear through the graph identity lock", async () => {
      const backend = createPostgresBackend(drizzle(pool!));
      const [store] = await createStoreWithSchema(enabledGraph, backend);
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "company" },
      );
      await store.identity.assertSame(person, company);

      writer = await pool!.connect();
      await writer.query("BEGIN");
      await writer.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('typegraph:identity'),
           hashtext($1)
         )`,
        [enabledGraph.id],
      );

      const pendingClear = store.clear();
      expect(await raceTimeout(pendingClear, 500)).toBe(TIMEOUT_SENTINEL);

      await writer.query("COMMIT");
      writer.release();
      writer = undefined;
      await pendingClear;

      expect(await store.identity.membersOf(person)).toEqual([]);
    });
  },
);
