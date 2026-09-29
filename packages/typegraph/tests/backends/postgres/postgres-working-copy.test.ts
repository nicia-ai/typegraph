import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineGraphExtension,
  defineNode,
  embedding,
  searchable,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { CURRENT_BASE_SCHEMA_VERSION } from "../../../src/backend/drizzle/base-schema";
import { generateVectorlessPostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import type {
  TransactionBackend,
  TransactionOptions,
} from "../../../src/backend/types";
import {
  branchDurable,
  computeBaseVersion,
  destroyDurableBranch,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { BranchError } from "../../../src/graph-merge/errors";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBaseVersion, asBranchId } from "../../../src/graph-merge/types";
import { defineNodeIndex } from "../../../src/indexes";
import { graphIdOrderIndexName } from "../../../src/indexes/system";
import {
  createSqlSchema,
  recordedRelation,
} from "../../../src/query/compiler/schema";
import {
  createPgvectorStrategy,
  createPgvectorStrategyForAllocation,
  pgvectorStrategy,
} from "../../../src/query/dialect/vector/pgvector-strategy";
import type { CompiledRowsSql } from "../../../src/query/sql-intent";
import { storeBackend } from "../../../src/store/runtime-port";
import { createStore, createStoreWithSchema } from "../../../src/store/store";
import { sha256Hex } from "../../../src/utils/hash";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

function createLatch(): Readonly<{
  promise: Promise<void>;
  release: () => void;
}> {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = () => {
      resolve();
    };
  });
  function release(): void {
    if (resolvePromise === undefined) {
      throw new Error("Latch resolver was not initialized.");
    }
    resolvePromise();
  }
  return { promise, release };
}

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
        expect(marker.rows).toEqual([{ version: CURRENT_BASE_SCHEMA_VERSION }]);
        // The copy lists graph ids too, so it carries the byte-ordered index on
        // each anchor relation under its own allocated table names.
        const byteOrderIndexes = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND left(indexname, length($1)) = $1 AND indexname LIKE '%graph_id_bytes_idx' ORDER BY indexname",
          [prefix],
        );
        expect(byteOrderIndexes.rows.map((row) => row.indexname)).toEqual(
          [
            graphIdOrderIndexName(names.edges),
            graphIdOrderIndexName(names.nodes),
            graphIdOrderIndexName(names.schemaVersions),
          ].toSorted(),
        );
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
        await expect(
          reopened.store.evolve(
            defineGraphExtension({
              nodes: { Tag: { properties: { label: { type: "string" } } } },
            }),
          ),
        ).rejects.toMatchObject({
          details: { code: "WORKING_COPY_SCHEMA_EVOLUTION_UNSUPPORTED" },
        });
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
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("cleans failed allocation and inventories a live ephemeral allocation", async () => {
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
        expect(await failing.listUnsealedAllocations()).toEqual([]);

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
        const unsealed = await manager.listUnsealedAllocations();
        expect(unsealed).toHaveLength(1);
        expect(unsealed[0]?.state).toBe("ephemeral");
        await copy.nodes.Person.create({ name: "Disposable" });
        await storeBackend(copy).close();
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it.each(["recordedClock", "contributionMaterializations"] as const)(
      "refuses a target backend missing the %s binding before clone writes",
      async (missing) => {
        const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
        try {
          const control = createPostgresBackend(drizzle(pool));
          const [source] = await createStoreWithSchema(graph, control, {
            revisionTracking: true,
          });
          const allocationId = `missing-target-binding-${missing}`;
          let relationPresentAtConnect: boolean | undefined;
          let allocatedNames: PostgresTableNames | undefined;
          const manager = createPostgresWorkingCopyManager<typeof graph>({
            control,
            connect: async (names) => {
              allocatedNames = names;
              const present = await pool.query<{ present: string | null }>(
                "SELECT to_regclass($1)::text AS present",
                [`"${names.nodes}"`],
              );
              relationPresentAtConnect = present.rows[0]?.present !== null;
              const backend = createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              });
              const bound = backend.tableNames;
              if (bound === undefined)
                throw new Error("Bundled PostgreSQL backend has no bindings.");
              const incomplete = Object.fromEntries(
                Object.entries(bound).filter(([key]) => key !== missing),
              ) as typeof bound;
              return deriveBackend(backend, { tableNames: incomplete });
            },
          });
          let created:
            Awaited<ReturnType<typeof manager.durable.create>> | undefined;
          let failure: unknown;
          try {
            created = await manager.durable.create(
              source,
              await computeBaseVersion(source),
              asBranchId(`missing-target-${missing}`),
              allocationId,
            );
          } catch (error) {
            failure = error;
          }
          if (created !== undefined) {
            await created.store.close();
            await manager.abortAllocation(allocationId);
          }
          expect(failure).toBeInstanceOf(BranchError);
          expect(relationPresentAtConnect).toBe(true);
          if (allocatedNames === undefined)
            throw new Error("Allocation did not call connect.");
          const target = await pool.query<{ present: string | null }>(
            "SELECT to_regclass($1)::text AS present",
            [`"${allocatedNames.nodes}"`],
          );
          expect(target.rows[0]?.present).toBeNull();
          expect(await manager.listUnsealedAllocations()).toEqual([]);
          const ledger = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM typegraph_working_copy_allocations WHERE allocation_id = $1",
            [allocationId],
          );
          expect(ledger.rows[0]?.count).toBe("0");
        } finally {
          await pool.end();
        }
      },
      60_000,
    );

    it("refuses an incomplete source binding before connecting an allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const bound = control.tableNames;
        if (bound === undefined)
          throw new Error("Bundled PostgreSQL backend has no bindings.");
        const incomplete = Object.fromEntries(
          Object.entries(bound).filter(
            ([key]) => key !== "contributionMaterializations",
          ),
        ) as typeof bound;
        const sourceBackend = deriveBackend(control, {
          tableNames: incomplete,
        });
        const [source] = await createStoreWithSchema(graph, sourceBackend, {
          revisionTracking: true,
        });
        const allocationId = "missing-source-binding";
        let connected = false;
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) => {
            connected = true;
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            );
          },
        });
        let created:
          Awaited<ReturnType<typeof manager.durable.create>> | undefined;
        let failure: unknown;
        try {
          created = await manager.durable.create(
            source,
            await computeBaseVersion(source),
            asBranchId("missing-source"),
            allocationId,
          );
        } catch (error) {
          failure = error;
        }
        if (created !== undefined) {
          await created.store.close();
          await manager.abortAllocation(allocationId);
        }
        expect(failure).toBeInstanceOf(BranchError);
        expect(connected).toBe(false);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("skips clone statistics refresh unless requested", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control, {
          autoRefreshStatistics: 1,
          revisionTracking: true,
        });
        await source.nodes.Person.create({ name: "Source" });
        const refreshes: string[] = [];
        const connect = (names: PostgresTableNames) =>
          Promise.resolve(
            deriveBackend(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
              {
                refreshStatistics: () => {
                  refreshes.push(names.nodes);
                  return Promise.resolve();
                },
              },
            ),
          );

        const defaultManager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect,
        });
        const defaultCopy = await defaultManager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        expect(refreshes).toEqual([]);
        await storeBackend(defaultCopy).close();

        const refreshingManager = createPostgresWorkingCopyManager<
          typeof graph
        >({
          control,
          connect,
          refreshStatistics: true,
        });
        const refreshingCopy = await refreshingManager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        expect(refreshes).toHaveLength(1);
        await storeBackend(refreshingCopy).close();
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
          sourceTableNames: { nodes: "WcCustomNodes" },
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
          sourceTableNames: { nodes: "WcCustomNodes" },
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
        expect(await staleManager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("allocates vector storage when automatic indexing is opted out", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const VectorNode = defineNode("VectorNode", {
          schema: z.object({ vector: embedding(3, { indexType: "none" }) }),
        });
        const vectorGraph = defineGraph({
          id: "postgres-working-copy-vector-no-index",
          nodes: { VectorNode: { type: VectorNode } },
          edges: {},
        });
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(vectorGraph, control, {
          history: true,
          revisionTracking: true,
        });
        const sourceNode = await source.nodes.VectorNode.create({
          vector: [0.1, 0.2, 0.3],
        });
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control,
          connect: (names, allocation) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
        });
        const copy = await manager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        expect(
          await copy.nodes.VectorNode.getById(sourceNode.id),
        ).toBeDefined();
        await storeBackend(copy).close();
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("clones, reopens and destroys allocation-scoped pgvector sidecars", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const VectorNode = defineNode("VectorNode", {
          schema: z.object({ vector: embedding(3) }),
        });
        const vectorGraph = defineGraph({
          id: "postgres-working-copy-vector-lifecycle",
          nodes: { VectorNode: { type: VectorNode } },
          edges: {},
        });
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(vectorGraph, control, {
          history: true,
          revisionTracking: true,
        });
        const sourceNode = await source.nodes.VectorNode.create({
          vector: [0.1, 0.2, 0.3],
        });
        const sourceStrategy = control.vectorStrategy;
        if (sourceStrategy === undefined)
          throw new Error("Source Postgres backend has no vector strategy.");
        const sourceTable = sourceStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control,
          connect: (names, allocation) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
        });
        const created = await branchDurable(source, manager.durable, {
          id: asBranchId("vector-copy"),
          allocationId: "vector-copy-allocation",
        });
        if (!isOk(created)) throw created.error;
        const { branch, descriptor } = unwrap(created);
        const manifest = await pool.query<{ vector_slots: unknown }>(
          "SELECT vector_slots FROM typegraph_working_copy_allocations WHERE allocation_id = $1",
          ["vector-copy-allocation"],
        );
        const manifestSlots = manifest.rows[0]?.vector_slots;
        expect(Array.isArray(manifestSlots)).toBe(true);
        expect(
          (
            manifestSlots as readonly { ownedTableNames?: readonly string[] }[]
          )[0]?.ownedTableNames,
        ).toEqual([
          (manifestSlots as readonly { tableName: string }[])[0]?.tableName,
        ]);
        const branchBackend = storeBackend(branch.store);
        const branchStrategy = branchBackend.vectorStrategy;
        if (branchStrategy === undefined)
          throw new Error("Branch Postgres backend has no vector strategy.");
        const branchTable = branchStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        expect(branchTable).not.toBe(sourceTable);
        const sourceRows = await pool.query<{
          node_id: string;
          embedding: string;
        }>(
          'SELECT node_id, embedding::text AS embedding FROM "' +
            sourceTable +
            '" WHERE graph_id = $1',
          [vectorGraph.id],
        );
        const branchRows = await pool.query<{
          node_id: string;
          embedding: string;
        }>(
          'SELECT node_id, embedding::text AS embedding FROM "' +
            branchTable +
            '" WHERE graph_id = $1',
          [vectorGraph.id],
        );
        expect(branchRows.rows).toEqual(sourceRows.rows);
        if (branchBackend.upsertEmbedding === undefined)
          throw new Error("Branch backend has no vector upsert operation.");
        await branchBackend.upsertEmbedding({
          graphId: vectorGraph.id,
          nodeKind: "VectorNode",
          nodeId: sourceNode.id,
          fieldPath: "vector",
          embedding: [0.7, 0.8, 0.9],
          dimensions: 3,
          metric: "cosine",
          indexType: "hnsw",
        });
        const isolatedSource = await pool.query<{ embedding: string }>(
          'SELECT embedding::text AS embedding FROM "' +
            sourceTable +
            '" WHERE graph_id = $1 AND node_id = $2',
          [vectorGraph.id, sourceNode.id],
        );
        expect(isolatedSource.rows[0]?.embedding).toContain("0.1");
        await branch.close();
        // Older allocation rows only persisted the primary table name. The
        // parser keeps those rows reopenable and destroyable.
        await pool.query(
          "UPDATE typegraph_working_copy_allocations SET vector_slots = jsonb_set(vector_slots, '{0}', (vector_slots->0) - 'ownedTableNames') WHERE allocation_id = $1",
          ["vector-copy-allocation"],
        );
        const vectorDisabled = createStore(
          vectorGraph,
          createPostgresBackend(drizzle(pool), { vector: false }),
        );
        await expect(
          manager.ephemeral.create(vectorDisabled, asBaseVersion("unused")),
        ).rejects.toThrow(/bundled pgvector strategy/u);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
        const reopened = await reopenDurableBranch(
          vectorGraph,
          descriptor,
          manager.durable,
        );
        expect(isOk(reopened)).toBe(true);
        const reopenedBranch = unwrap(reopened);
        const reopenedStrategy = storeBackend(
          reopenedBranch.store,
        ).vectorStrategy;
        expect(
          reopenedStrategy?.tableName(vectorGraph.id, "VectorNode", "vector"),
        ).toBe(branchTable);
        const isolatedBranch = await pool.query<{ embedding: string }>(
          'SELECT embedding::text AS embedding FROM "' +
            branchTable +
            '" WHERE graph_id = $1 AND node_id = $2',
          [vectorGraph.id, sourceNode.id],
        );
        expect(isolatedBranch.rows[0]?.embedding).toContain("0.7");
        await reopenedBranch.close();
        expect(
          isOk(await destroyDurableBranch(descriptor, manager.durable)),
        ).toBe(true);
        const droppedVector = await pool.query<{ relation: string | null }>(
          "SELECT to_regclass($1)::text AS relation",
          [branchTable],
        );
        expect(droppedVector.rows[0]?.relation).toBeNull();
        const dropSourceStorage = sourceStrategy.buildDropStorage({
          graphId: vectorGraph.id,
          nodeKind: "VectorNode",
          fieldPath: "vector",
          dimensions: 3,
          metric: "cosine",
          indexType: "hnsw",
        });
        for (const ddl of dropSourceStorage) {
          await control.executeDdl?.(ddl);
        }
        const missingSidecar = await branchDurable(source, manager.durable, {
          id: asBranchId("missing-vector-copy"),
          allocationId: "missing-vector-copy-allocation",
        });
        expect(isOk(missingSidecar)).toBe(false);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("keeps simultaneous allocations separate when their short vector hashes collide", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const allocationA = "collision-scope-3615";
      const allocationB = "collision-scope-79660";
      const firstAtConnect = createLatch();
      const releaseFirst = createLatch();
      const VectorNode = defineNode("VectorNode", {
        schema: z.object({ vector: embedding(3) }),
      });
      const vectorGraph = defineGraph({
        id: "postgres-working-copy-vector-collision",
        nodes: { VectorNode: { type: VectorNode } },
        edges: {},
      });
      type Created = Awaited<
        ReturnType<
          PostgresWorkingCopyManager<typeof vectorGraph>["durable"]["create"]
        >
      >;
      let firstCreated: Created | undefined;
      let secondCreated: Created | undefined;
      let firstPromise: Promise<Created> | undefined;
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        expect(
          createPgvectorStrategy(allocationA).tableName(
            vectorGraph.id,
            "VectorNode",
            "vector",
          ),
        ).toBe(
          createPgvectorStrategy(allocationB).tableName(
            vectorGraph.id,
            "VectorNode",
            "vector",
          ),
        );
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(vectorGraph, control, {
          revisionTracking: true,
        });
        await source.nodes.VectorNode.create({ vector: [0.1, 0.2, 0.3] });
        const base = await computeBaseVersion(source);
        let connectionCount = 0;
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control: projectBackendWithout(control, ["executeDdl"]),
          connect: async (names, allocation) => {
            connectionCount += 1;
            if (connectionCount === 1) {
              firstAtConnect.release();
              await releaseFirst.promise;
            }
            return createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
              ...(allocation === undefined ?
                {}
              : { vector: allocation.vectorStrategy }),
            });
          },
        });
        firstPromise = manager.durable.create(
          source,
          base,
          asBranchId("vector-collision-a"),
          allocationA,
        );
        await firstAtConnect.promise;
        await expect(
          manager.durable.create(
            source,
            base,
            asBranchId("vector-collision-duplicate"),
            allocationA,
          ),
        ).rejects.toThrow(/already owned/u);
        const firstClaim = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM typegraph_working_copy_allocations WHERE allocation_id = $1",
          [allocationA],
        );
        expect(firstClaim.rows[0]?.count).toBe(1);
        try {
          secondCreated = await manager.durable.create(
            source,
            base,
            asBranchId("vector-collision-b"),
            allocationB,
          );
        } finally {
          releaseFirst.release();
        }
        firstCreated = await firstPromise;
        const firstStrategy = storeBackend(firstCreated.store).vectorStrategy;
        const secondStrategy = storeBackend(secondCreated.store).vectorStrategy;
        if (firstStrategy === undefined || secondStrategy === undefined) {
          throw new Error("Allocated PostgreSQL copy has no vector strategy.");
        }
        const tableA = firstStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        const tableB = secondStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        expect(tableA).not.toBe(tableB);
        await firstCreated.store.materializeIndexes();
        await secondCreated.store.materializeIndexes();
        const annIndexes = await pool.query<{
          tablename: string;
          indexname: string;
        }>(
          "SELECT tablename, indexname FROM pg_indexes WHERE tablename = ANY($1::text[]) AND indexdef LIKE '%USING hnsw%'",
          [[tableA, tableB]],
        );
        expect(annIndexes.rows).toHaveLength(2);
        expect(new Set(annIndexes.rows.map((row) => row.indexname)).size).toBe(
          2,
        );
        await secondCreated.store.close();
        await manager.durable.abort(secondCreated.descriptor);
        secondCreated = undefined;
        const remaining = await pool.query<{ relation: string | null }>(
          "SELECT to_regclass($1)::text AS relation",
          [tableA],
        );
        expect(remaining.rows[0]?.relation).not.toBeNull();
        const remainingIndex = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexdef LIKE '%USING hnsw%'",
          [tableA],
        );
        expect(remainingIndex.rows).toHaveLength(1);
        const rows = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM "${tableA}" WHERE graph_id = $1`,
          [vectorGraph.id],
        );
        expect(rows.rows[0]?.count).toBe("1");
        await firstCreated.store.close();
        await manager.durable.abort(firstCreated.descriptor);
        firstCreated = undefined;
      } finally {
        releaseFirst.release();
        if (firstPromise !== undefined)
          await Promise.allSettled([firstPromise]);
        await firstCreated?.store.close();
        await secondCreated?.store.close();
        await pool.end();
      }
    }, 60_000);

    it("rolls back its ledger and tables when a vector relation appears after preflight", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const allocationId = "vector-preflight-race";
      const physicalPrefix = `tgw_${await sha256Hex(allocationId, 12)}_`;
      const VectorNode = defineNode("VectorNode", {
        schema: z.object({ vector: embedding(3) }),
      });
      const vectorGraph = defineGraph({
        id: "postgres-working-copy-vector-preflight-race",
        nodes: { VectorNode: { type: VectorNode } },
        edges: {},
      });
      const vectorTable = createPgvectorStrategyForAllocation(
        physicalPrefix,
      ).tableName(vectorGraph.id, "VectorNode", "vector");
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const sourceBackend = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(
          vectorGraph,
          sourceBackend,
          {
            revisionTracking: true,
          },
        );
        let injected = false;
        const control = deriveBackend(sourceBackend, {
          transaction: async <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
            transactionOptions?: TransactionOptions,
          ): Promise<T> =>
            sourceBackend.transaction(async (transaction) => {
              const observed = deriveBackend(transaction, {
                execute: async <T>(
                  query: CompiledRowsSql,
                ): Promise<readonly T[]> => {
                  const result = await transaction.execute<T>(query);
                  const queryText = query.chunks
                    .map((chunk) => (chunk.kind === "text" ? chunk.value : ""))
                    .join("");
                  if (!injected && queryText.includes("c.relname = ANY(")) {
                    injected = true;
                    await pool.query(
                      `CREATE TABLE "${vectorTable}" (sentinel integer)`,
                    );
                  }
                  return result;
                },
              });
              return operation(observed);
            }, transactionOptions),
        });
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control,
          connect: (names, allocation) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
        });
        let failure: unknown;
        let created:
          Awaited<ReturnType<typeof manager.durable.create>> | undefined;
        try {
          created = await manager.durable.create(
            source,
            await computeBaseVersion(source),
            asBranchId("vector-preflight-race"),
            allocationId,
          );
        } catch (error) {
          failure = error;
        }
        if (created !== undefined) {
          await created.store.close();
          await manager.abortAllocation(allocationId);
        }
        expect(injected).toBe(true);
        expect(failure).toBeDefined();
        const ownership = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM typegraph_working_copy_allocations WHERE allocation_id = $1",
          [allocationId],
        );
        expect(ownership.rows[0]?.count).toBe(0);
        const relations = await pool.query<{
          bundled: string | null;
          external: string | null;
        }>(
          "SELECT to_regclass($1)::text AS bundled, to_regclass($2)::text AS external",
          [`${physicalPrefix}nodes`, vectorTable],
        );
        expect(relations.rows[0]?.bundled).toBeNull();
        expect(relations.rows[0]?.external).not.toBeNull();
      } finally {
        await pool.query(`DROP TABLE IF EXISTS "${vectorTable}"`);
        await pool.end();
      }
    }, 60_000);

    it("holds vector sidecars stable across the clone snapshot", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const VectorNode = defineNode("VectorNode", {
          schema: z.object({ vector: embedding(3) }),
        });
        const vectorGraph = defineGraph({
          id: "postgres-working-copy-vector-fence",
          nodes: { VectorNode: { type: VectorNode } },
          edges: {},
        });
        const control = createPostgresBackend(drizzle(pool));
        let blockNextLock = false;
        const lockAcquiredLatch = createLatch();
        const lockReleasedLatch = createLatch();
        const lockAcquired: Promise<void> = lockAcquiredLatch.promise;
        const lockReleased: Promise<void> = lockReleasedLatch.promise;
        const signalLockAcquired: () => void = lockAcquiredLatch.release;
        const signalLockReleased: () => void = lockReleasedLatch.release;
        const sourceBackend = deriveBackend(control, {
          transaction: async <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
            transactionOptions?: TransactionOptions,
          ): Promise<T> =>
            control.transaction(async (transaction) => {
              const observedTransaction = deriveBackend(transaction, {
                execute: async <T>(
                  query: CompiledRowsSql,
                ): Promise<readonly T[]> => {
                  const result = await transaction.execute<T>(query);
                  const queryText = query.chunks
                    .map((chunk) => (chunk.kind === "text" ? chunk.value : ""))
                    .join("");
                  if (blockNextLock && queryText.includes("LOCK TABLE")) {
                    blockNextLock = false;
                    signalLockAcquired();
                    await lockReleased;
                  }
                  return result;
                },
              });
              return operation(observedTransaction);
            }, transactionOptions),
        });
        const [source] = await createStoreWithSchema(
          vectorGraph,
          sourceBackend,
          { history: true, revisionTracking: true },
        );
        const sourceNode = await source.nodes.VectorNode.create({
          vector: [0.1, 0.2, 0.3],
        });
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control,
          connect: (names, allocation) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                ...(allocation === undefined ?
                  {}
                : { vector: allocation.vectorStrategy }),
              }),
            ),
        });
        blockNextLock = true;
        const lockReleaseTimeout = setTimeout(signalLockReleased, 10_000);
        const clonePromise = branchDurable(source, manager.durable, {
          id: asBranchId("vector-fenced-copy"),
          allocationId: "vector-fenced-copy-allocation",
        });
        await lockAcquired;
        const sourceStrategy = control.vectorStrategy;
        if (sourceStrategy === undefined)
          throw new Error("Source Postgres backend has no vector strategy.");
        const slot = {
          graphId: vectorGraph.id,
          nodeKind: "VectorNode",
          nodeId: sourceNode.id,
          fieldPath: "vector",
          embedding: [0.8, 0.9, 1],
          dimensions: 3,
          metric: "cosine",
          indexType: "hnsw",
        } as const;
        if (control.upsertEmbedding === undefined)
          throw new Error(
            "Source Postgres backend has no vector upsert operation.",
          );
        const sourceWrite = control.upsertEmbedding(slot);
        const finishedWhileLocked = await Promise.race([
          sourceWrite.then(() => true),
          new Promise<boolean>((resolve) =>
            setTimeout(() => {
              resolve(false);
            }, 50),
          ),
        ]);
        expect(finishedWhileLocked).toBe(false);
        signalLockReleased();
        const cloned = await clonePromise;
        clearTimeout(lockReleaseTimeout);
        await sourceWrite;
        const { branch, descriptor } = unwrap(cloned);
        const branchBackend = storeBackend(branch.store);
        const branchStrategy = branchBackend.vectorStrategy;
        if (branchStrategy === undefined)
          throw new Error("Branch Postgres backend has no vector strategy.");
        const branchTable = branchStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        const sourceTable = sourceStrategy.tableName(
          vectorGraph.id,
          "VectorNode",
          "vector",
        );
        const branchRows = await pool.query<{ embedding: string }>(
          'SELECT embedding::text AS embedding FROM "' +
            branchTable +
            '" WHERE graph_id = $1 AND node_id = $2',
          [vectorGraph.id, sourceNode.id],
        );
        const sourceRows = await pool.query<{ embedding: string }>(
          'SELECT embedding::text AS embedding FROM "' +
            sourceTable +
            '" WHERE graph_id = $1 AND node_id = $2',
          [vectorGraph.id, sourceNode.id],
        );
        expect(branchRows.rows[0]?.embedding).toContain("0.1");
        expect(sourceRows.rows[0]?.embedding).toContain("0.8");
        await branch.close();
        expect(
          isOk(await destroyDurableBranch(descriptor, manager.durable)),
        ).toBe(true);
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
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses an untracked source that changes and changes back around the clone", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        let restoreSource: (() => Promise<void>) | undefined;
        const sourceBackend = deriveBackend(control, {
          transaction: async <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
            options?: TransactionOptions,
          ): Promise<T> => {
            try {
              return await control.transaction(operation, options);
            } finally {
              const restore = restoreSource;
              restoreSource = undefined;
              await restore?.();
            }
          },
        });
        const [source] = await createStoreWithSchema(graph, sourceBackend);
        const base = await computeBaseVersion(source);
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: async (names) => {
            const transient = await source.nodes.Person.create({
              name: "Between stamp and clone",
            });
            restoreSource = () => source.nodes.Person.hardDelete(transient.id);
            return createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
            });
          },
        });

        await expect(manager.ephemeral.create(source, base)).rejects.toThrow(
          /Source advanced before its working-copy clone snapshot/,
        );
        expect(await computeBaseVersion(source)).toBe(base);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("isolates graph indexes across copies and rebinds them on durable reopen", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const IndexedPerson = defineNode("IndexedPerson", {
          schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
        });
        const logicalNames = [
          'logical "quoted" name',
          "logical-gin-name-with-a-long-descriptive-suffix-for-this-graph",
        ];
        const indexedGraph = defineGraph({
          id: "postgres-working-copy-index-isolation",
          nodes: { IndexedPerson: { type: IndexedPerson } },
          edges: {},
          indexes: [
            defineNodeIndex(IndexedPerson, {
              fields: ["name"],
              name: logicalNames[0],
            }),
            defineNodeIndex(IndexedPerson, {
              fields: ["tags"],
              method: "gin",
              name: logicalNames[1],
            }),
          ],
        });
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(indexedGraph, control, {
          revisionTracking: true,
        });
        await source.nodes.IndexedPerson.create({
          name: "Source",
          tags: ["alpha"],
        });
        const sourceIndexes = await source.materializeIndexes();
        expect(sourceIndexes.results.map((result) => result.status)).toEqual([
          "created",
          "created",
        ]);
        const connectedNames: PostgresTableNames[] = [];
        function manager() {
          return createPostgresWorkingCopyManager<typeof indexedGraph>({
            control,
            connect: (names) => {
              connectedNames.push(names);
              return Promise.resolve(
                createPostgresBackend(drizzle(pool), {
                  // Even a caller-supplied Drizzle schema with logical index
                  // extras cannot replay those global names during bootstrap.
                  tables: createPostgresTables(names, {
                    indexes: indexedGraph.indexes,
                  }),
                }),
              );
            },
          });
        }
        const firstManager = manager();
        const first = unwrap(
          await branchDurable(source, firstManager.durable, {
            id: asBranchId("indexed-copy-one"),
            allocationId: "indexed-allocation-one",
          }),
        );
        const second = unwrap(
          await branchDurable(source, firstManager.durable, {
            id: asBranchId("indexed-copy-two"),
            allocationId: "indexed-allocation-two",
          }),
        );
        const firstNames = connectedNames[0];
        const secondNames = connectedNames[1];
        if (firstNames === undefined || secondNames === undefined)
          throw new Error("Missing indexed copy table bindings.");
        const physical = await pool.query<{
          tablename: string;
          indexname: string;
        }>(
          "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY($1::text[]) AND indexname LIKE 'tgw_%_gix_%' ORDER BY tablename, indexname",
          [[firstNames.nodes, secondNames.nodes]],
        );
        expect(physical.rows).toHaveLength(4);
        expect(new Set(physical.rows.map((row) => row.indexname)).size).toBe(4);
        expect(
          physical.rows.filter((row) => row.tablename === firstNames.nodes),
        ).toHaveLength(2);
        expect(
          physical.rows.filter((row) => row.tablename === secondNames.nodes),
        ).toHaveLength(2);
        expect(
          first.branch.store.graph.indexes?.map((index) => index.name),
        ).toEqual(logicalNames);
        const firstIndexes = await first.branch.store.materializeIndexes();
        expect(
          firstIndexes.results.map((result) => [
            result.indexName,
            result.status,
          ]),
        ).toEqual(logicalNames.map((name) => [name, "alreadyMaterialized"]));
        const statuses = await pool.query<{ index_name: string }>(
          `SELECT index_name FROM "${firstNames.indexMaterializations}" WHERE graph_id = $1 ORDER BY index_name`,
          [indexedGraph.id],
        );
        expect(statuses.rows.map((row) => row.index_name)).toEqual(
          physical.rows
            .filter((row) => row.tablename === firstNames.nodes)
            .map((row) => row.indexname),
        );
        await first.branch.close();
        const freshManager = manager();
        const reopened = unwrap(
          await reopenDurableBranch(
            indexedGraph,
            first.descriptor,
            freshManager.durable,
          ),
        );
        const reopenedIndexes = await reopened.store.materializeIndexes();
        expect(reopenedIndexes.results.map((result) => result.status)).toEqual([
          "alreadyMaterialized",
          "alreadyMaterialized",
        ]);
        const removedName = physical.rows.find(
          (row) => row.tablename === firstNames.nodes,
        )?.indexname;
        if (removedName === undefined)
          throw new Error("Missing physical graph index to repair.");
        await pool.query(`DROP INDEX "${removedName}"`);
        const repairedIndexes = await reopened.store.materializeIndexes();
        expect(
          repairedIndexes.results.map((result) => result.status).toSorted(),
        ).toEqual(["alreadyMaterialized", "created"]);
        const repairedRetry = await reopened.store.materializeIndexes();
        expect(repairedRetry.results.map((result) => result.status)).toEqual([
          "alreadyMaterialized",
          "alreadyMaterialized",
        ]);
        await reopened.close();
        await second.branch.close();
        expect(
          isOk(
            await destroyDurableBranch(first.descriptor, freshManager.durable),
          ),
        ).toBe(true);
        const remaining = await pool.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = $1 AND indexname LIKE 'tgw_%_gix_%'",
          [secondNames.nodes],
        );
        expect(remaining.rows).toHaveLength(2);
        expect(
          isOk(
            await destroyDurableBranch(second.descriptor, firstManager.durable),
          ),
        ).toBe(true);
        const ephemeral = await firstManager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        const ephemeralIndexes = await ephemeral.materializeIndexes();
        expect(ephemeralIndexes.results.map((result) => result.status)).toEqual(
          ["alreadyMaterialized", "alreadyMaterialized"],
        );
        await storeBackend(ephemeral).close();
        expect(await firstManager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 120_000);

    it("removes all owned relations when graph-index materialization fails", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const indexedGraph = defineGraph({
          id: "postgres-working-copy-index-ddl-failure",
          nodes: { Person: { type: Person } },
          edges: {},
          indexes: [defineNodeIndex(Person, { fields: ["name"] })],
        });
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(indexedGraph, control, {
          revisionTracking: true,
        });
        const connectedNames: PostgresTableNames[] = [];
        const manager = createPostgresWorkingCopyManager<typeof indexedGraph>({
          control,
          connect: (names) => {
            connectedNames.push(names);
            const backend = createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
            });
            return Promise.resolve(
              deriveBackend(backend, {
                executeDdl: (statement) =>
                  statement.includes("_gix_") ?
                    Promise.reject(
                      new Error("injected graph-index DDL failure"),
                    )
                  : (backend.executeDdl?.(statement) ?? Promise.resolve()),
              }),
            );
          },
        });
        const outcome = await branchDurable(source, manager.durable, {
          id: asBranchId("failed-indexed-copy"),
          allocationId: "failed-indexed-allocation",
        });
        expect(isOk(outcome)).toBe(false);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
        const names = connectedNames[0];
        if (names === undefined)
          throw new Error("Missing failed allocation names.");
        const remaining = await pool.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          [`"${names.nodes}"`],
        );
        expect(remaining.rows[0]?.present).toBeNull();
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses schema evolution before creating unowned vector storage", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control, {
          revisionTracking: true,
        });
        const connectedNames: PostgresTableNames[] = [];
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
        const copy = await manager.ephemeral.create(
          source,
          await computeBaseVersion(source),
        );
        const names = connectedNames[0];
        if (names === undefined) throw new Error("Missing target names.");
        const before = await pool.query<{ version: number }>(
          `SELECT version FROM "${names.schemaVersions}" WHERE graph_id = $1`,
          [graph.id],
        );
        const abandoned = await manager.listUnsealedAllocations();
        const extension = defineGraphExtension({
          nodes: {
            Document: {
              properties: {
                embedding: {
                  type: "array",
                  items: { type: "number" },
                  embedding: { dimensions: 3 },
                },
              },
            },
          },
        });
        await expect(copy.evolve(extension)).rejects.toMatchObject({
          details: { code: "WORKING_COPY_SCHEMA_EVOLUTION_UNSUPPORTED" },
        });
        expect(await copy.materializeIndexes()).toEqual({ results: [] });
        await expect(
          storeBackend(copy).setActiveVersion({
            graphId: graph.id,
            expected: { kind: "active", version: 1 },
            version: 1,
          }),
        ).rejects.toThrow(/fixed schema/);
        const systemIndexes = await copy.materializeSystemIndexes();
        expect(
          systemIndexes.results.some((entry) => entry.status === "failed"),
        ).toBe(false);
        const after = await pool.query<{ version: number }>(
          `SELECT version FROM "${names.schemaVersions}" WHERE graph_id = $1`,
          [graph.id],
        );
        expect(after.rows).toEqual(before.rows);
        expect(await manager.listUnsealedAllocations()).toEqual(abandoned);
        const vectorMarkers = await pool.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM "${names.contributionMaterializations}" WHERE graph_id = $1 AND owner = 'pgvector'`,
          [graph.id],
        );
        expect(vectorMarkers.rows[0]?.count).toBe(0);
        const vectorTable = pgvectorStrategy.tableName(
          graph.id,
          "Document",
          "embedding",
        );
        const unowned = await pool.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          [`"${vectorTable}"`],
        );
        expect(unowned.rows[0]?.present).toBeNull();
        await storeBackend(copy).close();
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("bounds ledger migration locks and accepts concurrent legacy upgrades", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      const lockClient = await pool.connect();
      try {
        const control = createPostgresBackend(drizzle(pool));
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          cleanupLockTimeoutMs: 75,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        await manager.listUnsealedAllocations();
        await pool.query(
          "INSERT INTO typegraph_working_copy_allocations (allocation_id, physical_prefix, ownership_token, state, history, revision_tracking) VALUES ($1, $2, $3, 'sealed', false, false)",
          ["legacy-ledger-row", "legacy_reserved_prefix_", "legacy-token"],
        );
        await pool.query(
          "ALTER TABLE typegraph_working_copy_allocations DROP COLUMN vector_slots",
        );
        await lockClient.query("BEGIN");
        await lockClient.query(
          "LOCK TABLE typegraph_working_copy_allocations IN ACCESS EXCLUSIVE MODE",
        );
        try {
          let failure: unknown;
          try {
            await manager.listUnsealedAllocations();
          } catch (error) {
            failure = error;
          }
          expect(failure).toMatchObject({ cause: { code: "55P03" } });
        } finally {
          await lockClient.query("ROLLBACK");
        }
        const otherManager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        const inventories = await Promise.all([
          manager.listUnsealedAllocations(),
          otherManager.listUnsealedAllocations(),
        ]);
        expect(inventories).toEqual([[], []]);
        const column = await pool.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass('typegraph_working_copy_allocations') AND attname = 'vector_slots' AND attnum > 0 AND NOT attisdropped) AS present",
        );
        expect(column.rows[0]?.present).toBe(true);
        const legacyRow = await pool.query<{ slots: unknown }>(
          "SELECT vector_slots AS slots FROM typegraph_working_copy_allocations WHERE allocation_id = 'legacy-ledger-row'",
        );
        expect(legacyRow.rows[0]?.slots).toEqual([]);
        await lockClient.query("BEGIN");
        await lockClient.query(
          "LOCK TABLE typegraph_working_copy_allocations IN ACCESS SHARE MODE",
        );
        try {
          await expect(manager.listUnsealedAllocations()).resolves.toEqual([]);
        } finally {
          await lockClient.query("ROLLBACK");
        }
        await pool.query(
          "DELETE FROM typegraph_working_copy_allocations WHERE allocation_id = 'legacy-ledger-row'",
        );
      } finally {
        lockClient.release();
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
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
