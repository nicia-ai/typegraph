import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, embedding, searchable } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import type {
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import {
  branchDurable,
  computeBaseVersion,
  createPostgresWorkingCopyManager,
  destroyDurableBranch,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBaseVersion, asBranchId } from "../../../src/graph-merge/types";
import { defineNodeIndex } from "../../../src/indexes";
import {
  createSqlSchema,
  recordedRelation,
} from "../../../src/query/compiler/schema";
import { storeBackend } from "../../../src/store/runtime-port";
import { createStore, createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: searchable({ language: "english" }) }),
});
const graph = defineGraph({
  id: "postgres-working-copy-test",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy lifecycle",
  () => {
    it("allocates, reopens, attests, closes and destroys a durable table copy", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      const connectedNames: PostgresTableNames[] = [];
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control, {
          history: true,
          revisionTracking: true,
        });
        const person = await source.nodes.Person.create({ name: "Source" });
        const otherGraph = defineGraph({
          id: "postgres-working-copy-other-graph",
          nodes: { Person: { type: Person } },
          edges: {},
        });
        const [otherStore] = await createStoreWithSchema(otherGraph, control);
        await otherStore.nodes.Person.create({ name: "Other graph" });
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) => {
            connectedNames.push(names);
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            );
          },
        });
        const result = await branchDurable(source, manager.durable, {
          id: asBranchId("copy-one"),
          allocationId: "copy-allocation-one",
        });
        expect(isOk(result)).toBe(true);
        const { branch, descriptor } = unwrap(result);
        expect(connectedNames).toHaveLength(1);
        const names = connectedNames[0];
        if (names === undefined)
          throw new Error("Missing allocated table names.");
        const prefix = names.nodes.slice(0, -"nodes".length);
        const inventory = await pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, length($1)) = $1 ORDER BY tablename",
          [prefix],
        );
        expect(inventory.rows.map((row) => row.tablename).toSorted()).toEqual(
          Object.values(names).toSorted(),
        );
        const targetNodes = await pool.query<{ graph_id: string }>(
          `SELECT graph_id FROM "${names.nodes}"`,
        );
        expect(targetNodes.rows).toEqual([{ graph_id: graph.id }]);
        const marker = await pool.query<{ version: number }>(
          `SELECT version FROM "${names.baseSchemaVersions}"`,
        );
        expect(marker.rows).toEqual([{ version: 4 }]);
        const fulltext = await pool.query<{ graph_id: string }>(
          `SELECT graph_id FROM "${names.fulltext}"`,
        );
        expect(fulltext.rows).toEqual([{ graph_id: graph.id }]);
        const copiedPerson = await branch.store.nodes.Person.getById(person.id);
        expect(copiedPerson?.name).toBe("Source");
        await branch.store.nodes.Person.update(person.id, { name: "Copy" });
        const unchangedSource = await source.nodes.Person.getById(person.id);
        expect(unchangedSource?.name).toBe("Source");
        await branch.close();

        const reopenedResult = await reopenDurableBranch(
          graph,
          descriptor,
          manager.durable,
        );
        expect(isOk(reopenedResult)).toBe(true);
        const reopened = unwrap(reopenedResult);
        const reopenedPerson = await reopened.store.nodes.Person.getById(
          person.id,
        );
        expect(reopenedPerson?.name).toBe("Copy");
        await reopened.close();

        const tampered = {
          ...descriptor,
          base: "wrong-base" as typeof descriptor.base,
        };
        expect(
          isOk(await reopenDurableBranch(graph, tampered, manager.durable)),
        ).toBe(false);
        expect(
          isOk(await destroyDurableBranch(tampered, manager.durable)),
        ).toBe(false);
        expect(
          isOk(await destroyDurableBranch(descriptor, manager.durable)),
        ).toBe(true);
        const gone = await pool.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          [`"${names.nodes}"`],
        );
        expect(gone.rows[0]?.present).toBeNull();
        expect(
          isOk(await reopenDurableBranch(graph, descriptor, manager.durable)),
        ).toBe(false);
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("cleans failed allocation and discovers crashed ephemeral allocations", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control, {
          revisionTracking: true,
        });
        const failing = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: () => Promise.reject(new Error("connection failed")),
        });
        const failed = await branchDurable(source, failing.durable, {
          id: asBranchId("failed-copy"),
          allocationId: "failed-allocation",
        });
        expect(isOk(failed)).toBe(false);
        expect(await failing.listAbandoned()).toEqual([]);

        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        const copy = await manager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        const abandoned = await manager.listAbandoned();
        expect(abandoned).toHaveLength(1);
        expect(abandoned[0]?.state).toBe("ephemeral");
        await copy.nodes.Person.create({ name: "Disposable" });
        await storeBackend(copy).close();
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("supports custom quoted source names and refuses a stale source", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const sourceTables = createPostgresTables({ nodes: "WcCustomNodes" });
        await pool.query(generateVectorlessPostgresMigrationSQL(sourceTables));
        const sourceBackend = createPostgresBackend(drizzle(pool), {
          tables: sourceTables,
        });
        const customGraph = defineGraph({
          id: "postgres-working-copy-custom-source",
          nodes: { Person: { type: Person } },
          edges: {},
        });
        const [source] = await createStoreWithSchema(
          customGraph,
          sourceBackend,
          { revisionTracking: true },
        );
        const person = await source.nodes.Person.create({ name: "Before" });
        const manager = createPostgresWorkingCopyManager<typeof customGraph>({
          control: sourceBackend,
          sourceTables,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        const copy = await manager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        const copiedPerson = await copy.nodes.Person.getById(person.id);
        expect(copiedPerson?.name).toBe("Before");
        await storeBackend(copy).close();

        const staleManager = createPostgresWorkingCopyManager<
          typeof customGraph
        >({
          control: sourceBackend,
          sourceTables,
          connect: async (names) => {
            await source.nodes.Person.update(person.id, {
              name: "Changed during allocation",
            });
            return createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
            });
          },
        });
        const stale = await branchDurable(source, staleManager.durable, {
          id: asBranchId("stale-copy"),
          allocationId: "stale-allocation",
        });
        expect(isOk(stale)).toBe(false);
        expect(await staleManager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses graph-scoped vector storage before allocating tables", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const VectorNode = defineNode("VectorNode", {
          schema: z.object({ vector: embedding(3) }),
        });
        const vectorGraph = defineGraph({
          id: "postgres-working-copy-vector-refusal",
          nodes: { VectorNode: { type: VectorNode } },
          edges: {},
        });
        const control = createPostgresBackend(drizzle(pool));
        const source = createStore(vectorGraph, control);
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        await expect(
          manager.ephemeral.create(source, asBaseVersion("unused")),
        ).rejects.toThrow(/vector tables/);
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses a source write committed after the SQL clone snapshot", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        let writeAfterClone = false;
        const sourceBackend = deriveBackend(control, {
          transaction: async <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> => {
            const result = await control.transaction(operation, options);
            if (writeAfterClone) {
              writeAfterClone = false;
              await source.nodes.Person.create({ name: "Concurrent write" });
            }
            return result;
          },
        });
        const [source] = await createStoreWithSchema(graph, sourceBackend, {
          revisionTracking: true,
        });
        await source.nodes.Person.create({ name: "At fork" });
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        const base = await computeBaseVersion(source);
        writeAfterClone = true;
        await expect(manager.ephemeral.create(source, base)).rejects.toThrow(
          /Source advanced/,
        );
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses graph-declared indexes before allocating tables", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const indexedGraph = defineGraph({
          id: "postgres-working-copy-index-refusal",
          nodes: { Person: { type: Person } },
          edges: {},
          indexes: [defineNodeIndex(Person, { fields: ["name"] })],
        });
        const control = createPostgresBackend(drizzle(pool));
        const source = createStore(indexedGraph, control);
        const manager = createPostgresWorkingCopyManager<typeof indexedGraph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        await expect(
          manager.ephemeral.create(source, asBaseVersion("unused")),
        ).rejects.toThrow(/index names/);
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses an external recorded-read relation before allocating tables", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const source = createStore(graph, control, {
          recordedRead: recordedRelation({ schema: createSqlSchema() }),
        });
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        await expect(
          manager.ephemeral.create(source, asBaseVersion("unused")),
        ).rejects.toThrow(/external recorded-read relation/);
        expect(await manager.listAbandoned()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
