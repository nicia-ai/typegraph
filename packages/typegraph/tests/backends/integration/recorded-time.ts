import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type AnyEdgeType,
  asRecordedInstant,
  type CompiledRowsSql,
  type CompiledStatementSql,
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type EdgeCollection,
  embedding,
  exists,
  type NodeCollection,
  type NodeId,
  type NodeType,
  param as parameter,
  type RecordedInstant,
  searchable,
  type StoreSearch,
} from "../../../src";
import {
  type GraphBackend,
  rowPropsToJsonText,
  type TransactionBackend,
} from "../../../src/backend/types";
import {
  type ReadCoordinate,
  RECORDED_MAX,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../../../src/interchange";
import { compileQuery } from "../../../src/query/compiler/index";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql, type SqlFragment } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import {
  CURRENT_ONLY_READ_NAMES,
  EDGE_BATCH_READ_NAMES,
} from "../../../src/store/collection-surface";
import { toCanonicalRecordedBoundary } from "../../../src/store/recorded-capture";
import { STORE_RUNTIME } from "../../../src/store/runtime-port";
import { TRANSACTION_RUNTIME } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { type HistoryIntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type ClockRow = Readonly<{ recorded_at: unknown }>;
type CountRow = Readonly<{ count: unknown }>;
type RecordedToRow = Readonly<{ recorded_to: unknown }>;
type RecordedFromRow = Readonly<{ recorded_from: unknown }>;
type RecordedOpRow = Readonly<{ op: string }>;
type RecordedSqlStore = Readonly<{
  graphId: string;
  [STORE_RUNTIME]: Readonly<{ backend: GraphBackend }>;
}>;
type RuntimeTarget = Readonly<Record<string, unknown>>;

type RecordedContractCase = Readonly<{
  surface: string;
  invoke: () => unknown;
  message: string;
}>;

function getRuntimeProperty(target: object, property: PropertyKey): unknown {
  return Reflect.get(target, property) as unknown;
}

const CascadePerson = defineNode("CascadePerson", {
  schema: z.object({ name: z.string() }),
});

const cascadeKnows = defineEdge("cascadeKnows", {
  schema: z.object({ since: z.string() }),
});

const cascadeGraph = defineGraph({
  id: "recorded_cascade_delete",
  nodes: {
    CascadePerson: { type: CascadePerson, onDelete: "cascade" },
  },
  edges: {
    cascadeKnows: {
      type: cascadeKnows,
      from: [CascadePerson],
      to: [CascadePerson],
    },
  },
});

// Fields named after SQL DML/DDL keywords. They compile into the query as
// JSON-path string literals (json_extract(props, '$.comment') /
// props->>'comment'), so a read/write classifier that sniffed the SQL text
// would wrongly reject reads of these fields under history capture.
const KeywordFieldNode = defineNode("KeywordFieldNode", {
  schema: z.object({
    comment: z.string(),
    update: z.string(),
  }),
});

const keywordFieldGraph = defineGraph({
  id: "recorded_keyword_fields",
  nodes: { KeywordFieldNode: { type: KeywordFieldNode } },
  edges: {},
});

// A dedicated graph for the clock-concurrency case so its recorded clock starts
// fresh (undefined high-water mark) regardless of what other suite tests
// committed to the shared backend.
const ClockItem = defineNode("ClockItem", {
  schema: z.object({ label: z.string() }),
});

const clockParityGraph = defineGraph({
  id: "recorded_clock_parity",
  nodes: { ClockItem: { type: ClockItem } },
  edges: {},
});

const AtomicPerson = defineNode("AtomicPerson", {
  schema: z.object({ email: z.email() }),
});

const createAtomicityGraph = defineGraph({
  id: "recorded_create_atomicity",
  nodes: {
    AtomicPerson: {
      type: AtomicPerson,
      unique: [
        {
          name: "email_unique",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

const RecursiveArticle = defineNode("RecursiveArticle", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: searchable({ language: "english" }),
    embedding: embedding(4).optional(),
  }),
});

const references = defineEdge("references", {
  schema: z.object({}),
});

const recursiveIndexGuardGraph = defineGraph({
  id: "recorded_recursive_index_guard",
  nodes: {
    RecursiveArticle: { type: RecursiveArticle },
  },
  edges: {
    references: {
      type: references,
      from: [RecursiveArticle],
      to: [RecursiveArticle],
      cardinality: "many",
    },
  },
});

const RemovalPerson = defineNode("RemovalPerson", {
  schema: z.object({ name: z.string() }),
});

const removalGraph = defineGraph({
  id: "recorded_kind_removal",
  nodes: { RemovalPerson: { type: RemovalPerson } },
  edges: {},
});

const BatchEdgePerson = defineNode("BatchEdgePerson", {
  schema: z.object({ name: z.string() }),
});

const batchEdgeKnows = defineEdge("batchEdgeKnows", {
  schema: z.object({ since: z.string() }),
});

const batchEdgeIdentityGraphA = defineGraph({
  id: "recorded_batch_edge_identity_a",
  nodes: { BatchEdgePerson: { type: BatchEdgePerson } },
  edges: {
    batchEdgeKnows: {
      type: batchEdgeKnows,
      from: [BatchEdgePerson],
      to: [BatchEdgePerson],
      cardinality: "many",
    },
  },
});

const batchEdgeIdentityGraphB = defineGraph({
  id: "recorded_batch_edge_identity_b",
  nodes: { BatchEdgePerson: { type: BatchEdgePerson } },
  edges: {
    batchEdgeKnows: {
      type: batchEdgeKnows,
      from: [BatchEdgePerson],
      to: [BatchEdgePerson],
      cardinality: "many",
    },
  },
});

function seq(count: number): number[] {
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(index);
  return values;
}

async function createHistoryStore(
  context: IntegrationTestContext,
): Promise<HistoryIntegrationStore> {
  return context.createHistoryStore(integrationTestGraph);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function dropRecordedRelations(backend: GraphBackend): Promise<void> {
  if (backend.executeDdl === undefined) {
    throw new Error("Integration backend should support executeDdl");
  }
  const schema = createSqlSchema(backend.tableNames);
  await backend.executeDdl(
    `DROP TABLE ${quoteIdentifier(schema.tables.recordedEdges)}`,
  );
  await backend.executeDdl(
    `DROP TABLE ${quoteIdentifier(schema.tables.recordedNodes)}`,
  );
  await backend.executeDdl(
    `DROP TABLE ${quoteIdentifier(schema.tables.recordedClock)}`,
  );
}

async function expectMissingRecordedRelations(
  fn: () => Promise<unknown>,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ConfigurationError);
  expect((thrown as Error).message).toContain(
    "history: true requires the recorded-time relations to exist",
  );
}

function assertWithinBindLimit(
  backend: Pick<GraphBackend, "compileSql">,
  query: SqlFragment,
  maxParams: number,
): void {
  const compiled = backend.compileSql?.(query);
  if (compiled !== undefined && compiled.params.length > maxParams) {
    throw new Error(
      `Test bind limit exceeded: ${compiled.params.length} > ${maxParams}`,
    );
  }
}

function withTransactionBindLimit(
  target: TransactionBackend,
  maxParams: number,
): TransactionBackend {
  const executeStatement = target.executeStatement;
  const executeRaw = target.executeRaw;
  return {
    ...target,
    capabilities: { ...target.capabilities, maxBindParameters: maxParams },
    async execute<T>(query: CompiledRowsSql) {
      assertWithinBindLimit(target, query, maxParams);
      return target.execute<T>(query);
    },
    ...(executeRaw === undefined ?
      {}
    : {
        async executeRaw<T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> {
          if (params.length > maxParams) {
            throw new Error(
              `Test bind limit exceeded: ${params.length} > ${maxParams}`,
            );
          }
          return executeRaw<T>(sqlText, params);
        },
      }),
    ...(executeStatement === undefined ?
      {}
    : {
        async executeStatement(query: CompiledStatementSql): Promise<void> {
          assertWithinBindLimit(target, query, maxParams);
          await executeStatement(query);
        },
      }),
  };
}

function withBindLimit(backend: GraphBackend, maxParams: number): GraphBackend {
  const executeStatement = backend.executeStatement;
  const executeRaw = backend.executeRaw;
  return {
    ...backend,
    // Advertise the simulated ceiling so recorded reads/writes chunk to it the
    // same way they chunk to a real engine's `maxBindParameters`; the execution
    // guards below then prove no top-level or transaction-scoped statement
    // actually exceeds it.
    capabilities: { ...backend.capabilities, maxBindParameters: maxParams },
    async execute<T>(query: CompiledRowsSql) {
      assertWithinBindLimit(backend, query, maxParams);
      return backend.execute<T>(query);
    },
    ...(executeRaw === undefined ?
      {}
    : {
        async executeRaw<T>(
          sqlText: string,
          params: readonly unknown[],
        ): Promise<readonly T[]> {
          if (params.length > maxParams) {
            throw new Error(
              `Test bind limit exceeded: ${params.length} > ${maxParams}`,
            );
          }
          return executeRaw<T>(sqlText, params);
        },
      }),
    ...(executeStatement === undefined ?
      {}
    : {
        async executeStatement(query: CompiledStatementSql): Promise<void> {
          assertWithinBindLimit(backend, query, maxParams);
          await executeStatement(query);
        },
      }),
    async transaction(fn, options) {
      return backend.transaction(
        (target) => fn(withTransactionBindLimit(target, maxParams)),
        options,
      );
    },
  };
}

function hideInsertBatchHelpers(
  target: TransactionBackend,
): TransactionBackend {
  const {
    insertEdgeNoReturn: _insertEdgeNoReturn,
    insertEdgesBatch: _insertEdgesBatch,
    insertEdgesBatchReturning: _insertEdgesBatchReturning,
    insertNodeNoReturn: _insertNodeNoReturn,
    insertNodesBatch: _insertNodesBatch,
    insertNodesBatchReturning: _insertNodesBatchReturning,
    ...rest
  } = target;
  return rest;
}

function withoutTransactionInsertBatchHelpers(
  backend: GraphBackend,
): GraphBackend {
  return {
    ...backend,
    async transaction(fn, options) {
      return backend.transaction(
        (target) => fn(hideInsertBatchHelpers(target)),
        options,
      );
    },
  };
}

// Strips the batch edge-read helper from the transaction target so recorded
// edge capture must fall back to per-id `getEdge` when reading after-images —
// the path a minimal custom backend that implements only `getEdge` would hit.
function withoutTransactionGetEdges(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    async transaction(fn, options) {
      return backend.transaction((target) => {
        const { getEdges: _getEdges, ...rest } = target;
        return fn(rest);
      }, options);
    },
  };
}

function rejectUniqueFinalization(): Promise<never> {
  return Promise.reject(new Error("forced unique finalization failure"));
}

function withFailingUniqueFinalization(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    insertUnique(): Promise<void> {
      return rejectUniqueFinalization();
    },
    async transaction(fn, options) {
      return backend.transaction((target) => {
        const failingTarget: TransactionBackend = {
          ...target,
          insertUnique(): Promise<void> {
            return rejectUniqueFinalization();
          },
        };
        return fn(failingTarget);
      }, options);
    },
  };
}

function requireBackendHelper<T>(helper: T | undefined, name: string): T {
  if (helper === undefined) {
    throw new Error(`Expected ${name} to be available for this test backend.`);
  }
  return helper;
}

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

async function rawHelperOutcome<T>(
  name: string,
  helper: T | undefined,
  invoke: (helper: T) => Promise<unknown>,
): Promise<string> {
  if (helper === undefined) return `${name} unavailable`;
  try {
    await invoke(helper);
    return `${name} resolved`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function readRecordedClock(
  store: RecordedSqlStore,
): Promise<RecordedInstant> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_at
      FROM ${schema.recordedClockTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Recorded clock row was not written");
  }
  // The clock high-water mark is a genuine recorded instant (the same source
  // store.recordedNow() reads), so branding it is correct, not a cast-to-silence.
  return asRecordedInstant(toCanonicalRecordedBoundary(row.recorded_at));
}

async function countRecordedNodeRows(
  store: RecordedSqlStore,
  nodeId: string,
  kind = "Person",
): Promise<number> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${nodeId}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function countOpenRecordedNodeRowsByKind(
  store: RecordedSqlStore,
  kind: string,
): Promise<number> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND recorded_to = ${RECORDED_MAX}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function countRecordedEdgeRows(
  store: RecordedSqlStore,
  edgeId: string,
  kind = "knows",
): Promise<number> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedEdgesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${edgeId}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function countRecordedClockRows(
  store: RecordedSqlStore,
): Promise<number> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedClockTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function readRecordedNodeClosedAt(
  store: RecordedSqlStore,
  kind: string,
  nodeId: string,
): Promise<string> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<RecordedToRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_to
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${nodeId}
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No recorded node row for ${nodeId}`);
  return toCanonicalRecordedBoundary(row.recorded_to);
}

async function readRecordedEdgeClosedAt(
  store: RecordedSqlStore,
  kind: string,
  edgeId: string,
): Promise<string> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<RecordedToRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_to
      FROM ${schema.recordedEdgesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${edgeId}
    `),
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`No recorded edge row for ${edgeId}`);
  return toCanonicalRecordedBoundary(row.recorded_to);
}

async function readRecordedNodeOpenFrom(
  store: RecordedSqlStore,
  kind: string,
  nodeId: string,
): Promise<string> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<RecordedFromRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_from
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${nodeId}
        AND recorded_to = ${RECORDED_MAX}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No open recorded node row for ${nodeId}`);
  }
  return toCanonicalRecordedBoundary(row.recorded_from);
}

async function readRecordedEdgeOpenFrom(
  store: RecordedSqlStore,
  kind: string,
  edgeId: string,
): Promise<string> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<RecordedFromRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_from
      FROM ${schema.recordedEdgesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${edgeId}
        AND recorded_to = ${RECORDED_MAX}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No open recorded edge row for ${edgeId}`);
  }
  return toCanonicalRecordedBoundary(row.recorded_from);
}

async function readRecordedNodeOps(
  store: RecordedSqlStore,
  kind: string,
  nodeId: string,
): Promise<readonly string[]> {
  const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
  const rows = await store[STORE_RUNTIME].backend.execute<RecordedOpRow>(
    asCompiledRowsSql(sql`
      SELECT op
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${nodeId}
      ORDER BY recorded_from
    `),
  );
  return rows.map((row) => row.op);
}

function unsupportedRead(
  store: HistoryIntegrationStore,
  recordedAt: RecordedInstant,
): () => Promise<unknown> {
  const recorded = store.asOfRecorded(recordedAt) as unknown as Readonly<{
    nodes: Readonly<{ Person: Readonly<{ find: () => Promise<unknown> }> }>;
  }>;
  return () => recorded.nodes.Person.find();
}

function invokeRuntimeMethod(
  target: RuntimeTarget,
  method: string,
  args: readonly unknown[] = [],
): unknown {
  const value = target[method];
  if (typeof value !== "function") {
    throw new TypeError(`Expected runtime method ${method} to exist`);
  }
  return Reflect.apply(value, target, args);
}

function executeBatchable(
  value: unknown,
  backend: GraphBackend,
): Promise<unknown> {
  const executeOn = (value as RuntimeTarget)["executeOn"];
  if (typeof executeOn !== "function") {
    throw new TypeError("Expected a BatchableQuery with executeOn");
  }
  return Promise.resolve(Reflect.apply(executeOn, value, [backend]));
}

async function expectAsyncContractRefusal(
  entry: RecordedContractCase,
): Promise<void> {
  await expect(Promise.resolve().then(() => entry.invoke())).rejects.toThrow(
    entry.message,
  );
}

function expectSyncContractRefusal(entry: RecordedContractCase): void {
  expect(() => entry.invoke()).toThrow(entry.message);
}

export function registerRecordedTimeIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recorded-time StoreView", () => {
    it("allocates distinct, both-observable recorded instants for same-millisecond commits", async () => {
      // The monotonic same-ms collision guard diverges by backend (Postgres
      // pg_advisory_xact_lock vs SQLite seed-UPSERT). Running it in the shared
      // suite exercises BOTH serialization paths — the SQLite-only unit test in
      // recorded-clock.test.ts cannot reach the Postgres path (AGENTS.md parity
      // rule #2). A dedicated graph keeps the clock's high-water mark fresh.
      const [store] = await createStoreWithSchema(
        clockParityGraph,
        context.getStore().backend,
        { history: true },
      );

      // Fake only Date (so async scheduling / driver timers are unaffected) and
      // pin the wall clock so both commits land in the same wall millisecond.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));

        const first = await store.nodes.ClockItem.create(
          { label: "first" },
          { id: "first" },
        );
        const firstCommit = requireRecordedInstant(
          await store.recordedNow(),
          "expected first clock commit instant",
        );
        const second = await store.nodes.ClockItem.create(
          { label: "second" },
          { id: "second" },
        );
        const secondCommit = requireRecordedInstant(
          await store.recordedNow(),
          "expected second clock commit instant",
        );

        // Same physical wall instant, distinct logical revisions.
        expect(firstCommit).toBe(
          "r1:0000000000000001:2026-06-01T12:00:00.000Z",
        );
        expect(secondCommit).toBe(
          "r1:0000000000000002:2026-06-01T12:00:00.000Z",
        );

        // Both instants are observable and isolate their own commit.
        const atFirst = store.asOfRecorded(firstCommit);
        const firstAtFirst = await atFirst.nodes.ClockItem.getById(first.id);
        const secondAtFirst = await atFirst.nodes.ClockItem.getById(second.id);
        expect(firstAtFirst?.label).toBe("first");
        expect(secondAtFirst).toBeUndefined();

        const atSecond = store.asOfRecorded(secondCommit);
        const firstAtSecond = await atSecond.nodes.ClockItem.getById(first.id);
        const secondAtSecond = await atSecond.nodes.ClockItem.getById(
          second.id,
        );
        expect(firstAtSecond?.label).toBe("first");
        expect(secondAtSecond?.label).toBe("second");
      } finally {
        vi.useRealTimers();
      }
    });

    it("rolls back live and recorded rows when create finalization fails", async () => {
      const failingBackend = withFailingUniqueFinalization(
        context.getStore().backend,
      );
      const [store] = await createStoreWithSchema(
        createAtomicityGraph,
        failingBackend,
        { history: true },
      );
      const failedId = "failed-create" as NodeId<typeof AtomicPerson>;

      await expect(
        store.nodes.AtomicPerson.create(
          { email: "failed@example.com" },
          { id: failedId },
        ),
      ).rejects.toThrow("forced unique finalization failure");

      await expect(
        store.nodes.AtomicPerson.getById(failedId),
      ).resolves.toBeUndefined();
      await expect(store.recordedNow()).resolves.toBeUndefined();
    });

    it("reconstructs point reads and queries at committed recorded instants", async () => {
      const store = await createHistoryStore(context);

      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);
      await store.nodes.Person.update(alice.id, { name: "Alicia" });
      const recordedAtUpdate = await readRecordedClock(store);

      expect(recordedAtCreate < recordedAtUpdate).toBe(true);

      const atCreate = store.asOfRecorded(recordedAtCreate);
      const atUpdate = store.asOfRecorded(recordedAtUpdate);

      const aliceAtCreate = await atCreate.nodes.Person.getById(alice.id);
      const aliceAtUpdate = await atUpdate.nodes.Person.getById(alice.id);
      expect(aliceAtCreate?.name).toBe("Alice");
      expect(aliceAtUpdate?.name).toBe("Alicia");

      const ordered = await atUpdate.nodes.Person.getByIds([
        alice.id,
        "missing-person" as never,
        alice.id,
      ]);
      expect(ordered.map((node) => node?.name)).toEqual([
        "Alicia",
        undefined,
        "Alicia",
      ]);

      const namesAtCreate = await atCreate
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name)
        .execute();
      expect(namesAtCreate).toEqual(["Alice"]);
    });

    it("reconstructs edge point reads and hard-delete transitions", async () => {
      const store = await createHistoryStore(context);

      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const recordedAtCreate = await readRecordedClock(store);
      await store.edges.knows.update(edge.id, { since: "2021" });
      const recordedAtUpdate = await readRecordedClock(store);

      const edgeAtCreate = await store
        .asOfRecorded(recordedAtCreate)
        .edges.knows.getById(edge.id);
      const edgeAtUpdate = await store
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getById(edge.id);
      expect(edgeAtCreate?.since).toBe("2020");
      expect(edgeAtUpdate?.since).toBe("2021");

      const ordered = await store
        .asOfRecorded(recordedAtUpdate)
        .edges.knows.getByIds([edge.id, "missing-edge" as never, edge.id]);
      expect(ordered.map((found) => found?.since)).toEqual([
        "2021",
        undefined,
        "2021",
      ]);

      await store.edges.knows.hardDelete(edge.id);
      const recordedAtDelete = await readRecordedClock(store);
      expect(
        await store.asOfRecorded(recordedAtDelete).edges.knows.getById(edge.id),
      ).toBeUndefined();
      expect(await countRecordedEdgeRows(store, edge.id)).toBe(2);
    });

    it("scans complete recorded node and edge snapshots in bounded id order", async () => {
      const store = await createHistoryStore(context);
      const charlie = await store.nodes.Person.create(
        { name: "Charlie", age: 32 },
        { id: "scan-person-c" },
      );
      const alice = await store.nodes.Person.create(
        { name: "Alice", age: 30 },
        { id: "scan-person-a" },
      );
      const bob = await store.nodes.Person.create(
        { name: "Bob", age: 31 },
        { id: "scan-person-b" },
      );
      const laterEdge = await store.edges.knows.create(
        charlie,
        alice,
        { since: "2021" },
        { id: "scan-edge-b" },
      );
      const firstEdge = await store.edges.knows.create(
        alice,
        bob,
        { since: "2020" },
        { id: "scan-edge-a" },
      );
      const recordedAtSnapshot = await readRecordedClock(store);

      await store.nodes.Person.update(bob.id, { name: "Bobby" });
      await store.nodes.Person.create(
        { name: "Dana", age: 33 },
        { id: "scan-person-d" },
      );
      await store.edges.knows.create(
        bob,
        charlie,
        { since: "2022" },
        { id: "scan-edge-c" },
      );

      const recorded = store.asOfRecorded(recordedAtSnapshot);
      const firstNodePage = await recorded.nodes.Person.scan({ limit: 2 });
      expect(firstNodePage.data.map((node) => [node.id, node.name])).toEqual([
        [alice.id, "Alice"],
        [bob.id, "Bob"],
      ]);
      expect(firstNodePage.hasNextPage).toBe(true);
      expect(firstNodePage.nextCursor).toBeDefined();

      const secondNodePage = await recorded.nodes.Person.scan({
        limit: 2,
        after: requireDefined(firstNodePage.nextCursor),
      });
      expect(secondNodePage.data.map((node) => node.id)).toEqual([charlie.id]);
      expect(secondNodePage.hasNextPage).toBe(false);
      expect(secondNodePage.nextCursor).toBeUndefined();

      const firstEdgePage = await recorded.edges.knows.scan({ limit: 1 });
      expect(firstEdgePage.data.map((edge) => edge.id)).toEqual([firstEdge.id]);
      expect(firstEdgePage.hasNextPage).toBe(true);

      const secondEdgePage = await recorded.edges.knows.scan({
        limit: 1,
        after: requireDefined(firstEdgePage.nextCursor),
      });
      expect(secondEdgePage.data.map((edge) => edge.id)).toEqual([
        laterEdge.id,
      ]);
      expect(secondEdgePage.hasNextPage).toBe(false);

      await expect(
        recorded.edges.knows.scan({
          limit: 1,
          after: requireDefined(firstNodePage.nextCursor),
        }),
      ).rejects.toThrow("cursor does not match");
      await expect(recorded.nodes.Person.scan({ limit: 1001 })).rejects.toThrow(
        "between 1 and 1000",
      );
    });

    it("supports chained valid-time and recorded-time coordinates", async () => {
      const store = await createHistoryStore(context);

      const validFrom = "2026-01-01T00:00:00.000Z";
      const beforeValid = "2025-12-31T23:59:59.000Z";
      const alice = await store.nodes.Person.create(
        { name: "Alice", age: 30 },
        { validFrom },
      );
      const recordedAtCreate = await readRecordedClock(store);

      const beforeValidView = store
        .asOf(beforeValid)
        .asOfRecorded(recordedAtCreate);
      expect(
        await beforeValidView.nodes.Person.getById(alice.id),
      ).toBeUndefined();

      const validView = store.asOf(validFrom).asOfRecorded(recordedAtCreate);
      const validPerson = await validView.nodes.Person.getById(alice.id);
      expect(validPerson?.name).toBe("Alice");
    });

    it("pins current-mode valid-time to the recorded instant, not the wall clock", async () => {
      const store = await createHistoryStore(context);

      // Fake only Date (driver timers still run normally): Alice is
      // valid-current when recorded, then the JS wall clock advances past her
      // validity window before the read. A current-mode view pinned to the
      // recorded instant must reconstruct her as she was *then* — filtering
      // valid-time against either JS Date or DB NOW() would drop her.
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2000-06-01T12:00:00.000Z"));

        const validFrom = "2000-01-01T00:00:00.000Z";
        const validTo = "2000-06-01T12:00:01.000Z";
        const alice = await store.nodes.Person.create(
          { name: "Alice", age: 30 },
          { validFrom, validTo },
        );
        const recordedAtCreate = await readRecordedClock(store);

        // Precondition: Alice was genuinely valid-current at the recorded instant.
        expect(recordedInstantWallTime(recordedAtCreate) < validTo).toBe(true);

        vi.setSystemTime(new Date("2000-06-01T12:00:02.000Z"));

        const currentRecorded = store
          .view({ mode: "current" })
          .asOfRecorded(recordedAtCreate);
        const reconstructed = await currentRecorded.nodes.Person.getById(
          alice.id,
        );
        expect(reconstructed?.name).toBe("Alice");

        // The diagonal store.asOfRecorded(rt) already pinned valid-time to rt;
        // current-mode + asOfRecorded must now agree with it.
        const diagonal = await store
          .asOfRecorded(recordedAtCreate)
          .nodes.Person.getById(alice.id);
        expect(diagonal?.name).toBe("Alice");
      } finally {
        vi.useRealTimers();
      }
    });

    it("reconstructs every supported read surface from the same recorded-time coordinate", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const recordedAtCreate = await readRecordedClock(store);

      await store.nodes.Person.update(bob.id, { name: "Bobby" });
      await store.edges.knows.update(edge.id, { since: "2021" });
      const carol = await store.nodes.Person.create({
        name: "Carol",
        age: 32,
      });
      const recordedAtLater = await readRecordedClock(store);

      const recorded = store.asOfRecorded(recordedAtCreate);
      const cases = [
        {
          surface: "nodes.getById",
          read: async () => {
            const node = await recorded.nodes.Person.getById(bob.id);
            return node?.name;
          },
          expected: "Bob",
        },
        {
          surface: "nodes.getByIds",
          read: async () => {
            const nodes = await recorded.nodes.Person.getByIds([
              alice.id,
              bob.id,
              carol.id,
            ]);
            return nodes.map((node) => node?.name);
          },
          expected: ["Alice", "Bob", undefined],
        },
        {
          surface: "edges.getById",
          read: async () => {
            const found = await recorded.edges.knows.getById(edge.id);
            return found?.since;
          },
          expected: "2020",
        },
        {
          surface: "edges.getByIds",
          read: async () => {
            const found = await recorded.edges.knows.getByIds([edge.id]);
            return found.map((edge) => edge?.since);
          },
          expected: ["2020"],
        },
        {
          surface: "query",
          read: async () => {
            const names = await recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person.name)
              .execute();
            return names.toSorted();
          },
          expected: ["Alice", "Bob"],
        },
        {
          surface: "subgraph",
          read: async () => {
            const subgraph = await recorded.subgraph(alice.id, {
              edges: ["knows"],
            });
            return [...subgraph.nodes.values()]
              .map((node) => (node as { name: string }).name)
              .toSorted();
          },
          expected: ["Alice", "Bob"],
        },
        {
          surface: "reachable",
          read: async () => {
            const reached = await recorded.reachable(alice.id, {
              edges: ["knows"],
            });
            return reached.map((node) => node.id).toSorted();
          },
          expected: [alice.id, bob.id].toSorted(),
        },
        {
          surface: "canReach",
          read: async () =>
            recorded.canReach(alice.id, bob.id, { edges: ["knows"] }),
          expected: true,
        },
        {
          surface: "shortestPath",
          read: async () => {
            const path = await recorded.shortestPath(alice.id, bob.id, {
              edges: ["knows"],
            });
            return path?.depth;
          },
          expected: 1,
        },
        {
          surface: "degree",
          read: async () => recorded.degree(alice.id, { edges: ["knows"] }),
          expected: 1,
        },
      ] as const satisfies readonly {
        surface: string;
        read: () => Promise<unknown>;
        expected: unknown;
      }[];

      for (const entry of cases) {
        await expect(entry.read()).resolves.toEqual(entry.expected);
      }

      const later = store.asOfRecorded(recordedAtLater);
      await expect(later.nodes.Person.getById(bob.id)).resolves.toMatchObject({
        name: "Bobby",
      });
      await expect(later.edges.knows.getById(edge.id)).resolves.toMatchObject({
        since: "2021",
      });
    });

    it("reconstructs subgraph and graph algorithms at recorded instants", async () => {
      const store = await createHistoryStore(context);
      const a = await store.nodes.Person.create({ name: "A", age: 1 });
      const b = await store.nodes.Person.create({ name: "B", age: 2 });
      const c = await store.nodes.Person.create({ name: "C", age: 3 });
      await store.edges.knows.create(a, b, { since: "1" });
      await store.edges.knows.create(b, c, { since: "1" });
      const beforeShortcut = await readRecordedClock(store);

      // Add a direct A->C edge, shortening the A..C path from two hops to one.
      await store.edges.knows.create(a, c, { since: "2" });
      const afterShortcut = await readRecordedClock(store);

      // Earlier instant: the recursive CTE / algorithm SQL must reconstruct the
      // two-hop topology from the recorded relation.
      const early = store.asOfRecorded(beforeShortcut);
      const reached = await early.reachable(a.id, { edges: ["knows"] });
      expect(reached.map((node) => node.id).toSorted()).toEqual(
        [a.id, b.id, c.id].toSorted(),
      );
      expect(await early.canReach(a.id, c.id, { edges: ["knows"] })).toBe(true);
      const earlyPath = await early.shortestPath(a.id, c.id, {
        edges: ["knows"],
      });
      expect(earlyPath?.depth).toBe(2);
      expect(await early.degree(b.id, { edges: ["knows"] })).toBe(2);
      const earlyComponents = await early.algorithms.weaklyConnectedComponents({
        edges: ["knows"],
      });
      expect(earlyComponents).toHaveLength(3);
      expect(earlyComponents.every((membership) => membership.size === 3)).toBe(
        true,
      );
      const earlyRanks = await early.algorithms.personalizedPageRank({
        edges: ["knows"],
        seeds: [{ id: a.id, kind: "Person" }],
      });
      expect(earlyRanks).toHaveLength(3);
      expect(
        earlyRanks.reduce((total, row) => total + row.score, 0),
      ).toBeCloseTo(1, 10);

      const earlySubgraph = await early.subgraph(a.id, {
        edges: ["knows"],
      });
      const earlyNames = [...earlySubgraph.nodes.values()]
        .map((node) => (node as { name: string }).name)
        .toSorted();
      expect(earlyNames).toEqual(["A", "B", "C"]);

      // Later instant: the shortcut collapses the path to a single hop.
      const late = store.asOfRecorded(afterShortcut);
      const latePath = await late.shortestPath(a.id, c.id, {
        edges: ["knows"],
      });
      expect(latePath?.depth).toBe(1);
      expect(
        await late.degree(a.id, { edges: ["knows"], direction: "out" }),
      ).toBe(2);
      const lateRanks = await late.personalizedPageRank({
        edges: ["knows"],
        seeds: [{ id: a.id, kind: "Person" }],
      });
      expect(lateRanks).toHaveLength(3);
      expect(lateRanks.find((row) => row.id === c.id)?.score).not.toBeCloseTo(
        earlyRanks.find((row) => row.id === c.id)?.score ?? 0,
        6,
      );

      // History is immutable: the earlier instant still sees the two-hop path.
      const replayedPath = await store
        .asOfRecorded(beforeShortcut)
        .shortestPath(a.id, c.id, { edges: ["knows"] });
      expect(replayedPath?.depth).toBe(2);
    });

    it("reconstructs weighted shortest paths at recorded instants", async () => {
      const store = await createHistoryStore(context);
      const a = await store.nodes.Person.create({ name: "WA", age: 1 });
      const b = await store.nodes.Person.create({ name: "WB", age: 2 });
      const c = await store.nodes.Person.create({ name: "WC", age: 3 });
      await store.edges.knows.create(a, b, { weight: 5 });
      const beforeDetour = await readRecordedClock(store);

      // A cheaper two-hop detour appears later; the weight audit and the
      // relaxation rounds must both read the recorded relation at the pin.
      await store.edges.knows.create(a, c, { weight: 1 });
      await store.edges.knows.create(c, b, { weight: 1 });
      const afterDetour = await readRecordedClock(store);

      const early = await store
        .asOfRecorded(beforeDetour)
        .weightedShortestPath(a.id, b.id, {
          edges: ["knows"],
          weightProperty: "weight",
        });
      expect(early?.totalWeight).toBe(5);
      expect(early?.depth).toBe(1);

      const late = await store
        .asOfRecorded(afterDetour)
        .weightedShortestPath(a.id, b.id, {
          edges: ["knows"],
          weightProperty: "weight",
        });
      expect(late?.totalWeight).toBe(2);
      expect(late?.nodes.map((node) => node.id)).toEqual([a.id, c.id, b.id]);

      // History is immutable: replaying the earlier pin still sees weight 5.
      const replayed = await store
        .asOfRecorded(beforeDetour)
        .weightedShortestPath(a.id, b.id, {
          edges: ["knows"],
          weightProperty: "weight",
        });
      expect(replayed?.totalWeight).toBe(5);
    });

    it("reconstructs label propagation at recorded instants", async () => {
      const store = await createHistoryStore(context);
      const [alpha, beta, gamma] = await Promise.all([
        store.nodes.Person.create(
          { name: "Recorded label A", age: 1 },
          { id: "recorded-label-a" },
        ),
        store.nodes.Person.create(
          { name: "Recorded label B", age: 2 },
          { id: "recorded-label-b" },
        ),
        store.nodes.Person.create(
          { name: "Recorded label C", age: 3 },
          { id: "recorded-label-c" },
        ),
      ]);
      await Promise.all([
        store.edges.knows.create(alpha, beta, { since: "1" }),
        store.edges.knows.create(beta, gamma, { since: "1" }),
        store.edges.knows.create(gamma, alpha, { since: "1" }),
      ]);
      const beforeExpansion = await readRecordedClock(store);
      const delta = await store.nodes.Person.create(
        { name: "Recorded label D", age: 4 },
        { id: "recorded-label-d" },
      );
      await Promise.all([
        store.edges.knows.create(delta, alpha, { since: "2" }),
        store.edges.knows.create(delta, beta, { since: "2" }),
        store.edges.knows.create(delta, gamma, { since: "2" }),
      ]);
      const afterExpansion = await readRecordedClock(store);

      const earlyView = store.asOfRecorded(beforeExpansion);
      const early = await earlyView.algorithms.labelPropagation({
        edges: ["knows"],
      });
      const late = await store
        .asOfRecorded(afterExpansion)
        .labelPropagation({ edges: ["knows"] });

      expect(early.map((row) => row.id)).toEqual([alpha.id, beta.id, gamma.id]);
      expect(early.every((row) => row.labelId === alpha.id)).toBe(true);
      expect(late.map((row) => row.id)).toEqual([
        alpha.id,
        beta.id,
        gamma.id,
        delta.id,
      ]);
      expect(late.every((row) => row.labelId === alpha.id)).toBe(true);
    });

    it("rejects the recorded-time open sentinel in internal algorithm options", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const invalidCoordinate: ReadCoordinate = {
        valid: { mode: "asOf", asOf: "2026-01-01T00:00:00.000Z" },
        recorded: { asOf: RECORDED_MAX as RecordedInstant },
      };

      await expect(
        store[STORE_RUNTIME].algorithmsAtCoordinate(invalidCoordinate).degree(
          alice.id,
          {
            edges: ["knows"],
            recordedAsOf: RECORDED_MAX as RecordedInstant,
          } as never,
        ),
      ).rejects.toThrow("canonical versioned recorded instant");
    });

    it("enforces the public recorded-coordinate boundary across every live read seam", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const recordedAt = await readRecordedClock(store);
      const recordedOptions = { recordedAsOf: recordedAt };
      const person = store.nodes.Person as unknown as RuntimeTarget;
      const knows = store.edges.knows as unknown as RuntimeTarget;
      const storeRuntime = store as unknown as RuntimeTarget;
      const algorithms = store.algorithms as unknown as RuntimeTarget;

      const asyncLeaks: readonly RecordedContractCase[] = [
        {
          surface: "node getById",
          invoke: () =>
            invokeRuntimeMethod(person, "getById", [alice.id, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "node getByIds",
          invoke: () =>
            invokeRuntimeMethod(person, "getByIds", [
              [alice.id],
              recordedOptions,
            ]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "node find",
          invoke: () =>
            invokeRuntimeMethod(person, "find", [undefined, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "node count",
          invoke: () => invokeRuntimeMethod(person, "count", [recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge getById",
          invoke: () =>
            invokeRuntimeMethod(knows, "getById", [edge.id, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge getByIds",
          invoke: () =>
            invokeRuntimeMethod(knows, "getByIds", [
              [edge.id],
              recordedOptions,
            ]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge find",
          invoke: () =>
            invokeRuntimeMethod(knows, "find", [undefined, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge count",
          invoke: () =>
            invokeRuntimeMethod(knows, "count", [undefined, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge findFrom",
          invoke: () =>
            invokeRuntimeMethod(knows, "findFrom", [alice, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge findTo",
          invoke: () =>
            invokeRuntimeMethod(knows, "findTo", [bob, recordedOptions]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge findByEndpoints",
          invoke: () =>
            invokeRuntimeMethod(knows, "findByEndpoints", [
              alice,
              bob,
              undefined,
              recordedOptions,
            ]),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge batchFindFrom",
          invoke: async () =>
            executeBatchable(
              invokeRuntimeMethod(knows, "batchFindFrom", [
                alice,
                recordedOptions,
              ]),
              store[STORE_RUNTIME].backend,
            ),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge batchFindTo",
          invoke: async () =>
            executeBatchable(
              invokeRuntimeMethod(knows, "batchFindTo", [bob, recordedOptions]),
              store[STORE_RUNTIME].backend,
            ),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "edge batchFindByEndpoints",
          invoke: async () =>
            executeBatchable(
              invokeRuntimeMethod(knows, "batchFindByEndpoints", [
                alice,
                bob,
                undefined,
                recordedOptions,
              ]),
              store[STORE_RUNTIME].backend,
            ),
          message: "Broad collection reads cannot honor recorded-time",
        },
        {
          surface: "subgraph",
          invoke: () =>
            invokeRuntimeMethod(storeRuntime, "subgraph", [
              alice.id,
              { edges: ["knows"], recordedAsOf: recordedAt },
            ]),
          message: "recordedAsOf is only available through",
        },
      ];

      for (const entry of asyncLeaks) {
        await expectAsyncContractRefusal(entry);
      }

      const algorithmOptions = { edges: ["knows"], recordedAsOf: recordedAt };
      const algorithmLeaks: readonly RecordedContractCase[] = [
        {
          surface: "shortestPath",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "shortestPath", [
              alice.id,
              bob.id,
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "weightedShortestPath",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "weightedShortestPath", [
              alice.id,
              bob.id,
              { ...algorithmOptions, weightProperty: "weight" },
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "reachable",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "reachable", [
              alice.id,
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "canReach",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "canReach", [
              alice.id,
              bob.id,
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "neighbors",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "neighbors", [
              alice.id,
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "degree",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "degree", [
              alice.id,
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "weaklyConnectedComponents",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "weaklyConnectedComponents", [
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "labelPropagation",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "labelPropagation", [
              algorithmOptions,
            ]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "pageRank",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "pageRank", [algorithmOptions]),
          message: "recordedAsOf is only available through",
        },
        {
          surface: "personalizedPageRank",
          invoke: () =>
            invokeRuntimeMethod(algorithms, "personalizedPageRank", [
              {
                ...algorithmOptions,
                seeds: [{ id: alice.id, kind: "Person" }],
              },
            ]),
          message: "recordedAsOf is only available through",
        },
      ];

      for (const entry of algorithmLeaks) {
        expectSyncContractRefusal(entry);
      }
    });

    it("collapses create-then-hard-delete in one transaction to zero recorded rows", async () => {
      const store = await createHistoryStore(context);
      const transientId = "transient-person";

      await store.transaction(async (tx) => {
        const transient = await tx.nodes.Person.create(
          { name: "Transient", age: 1 },
          { id: transientId },
        );
        await tx.nodes.Person.update(transient.id, { name: "Changed" });
        await tx.nodes.Person.hardDelete(transient.id);
      });
      const recordedAtCommit = await readRecordedClock(store);

      expect(
        await store
          .asOfRecorded(recordedAtCommit)
          .nodes.Person.getById(transientId as never),
      ).toBeUndefined();
      expect(await countRecordedNodeRows(store, transientId)).toBe(0);
    });

    it("keeps create-then-soft-delete as a tombstone visible only when requested", async () => {
      const store = await createHistoryStore(context);
      const tombstoneId = "soft-deleted-person";

      await store.transaction(async (tx) => {
        const person = await tx.nodes.Person.create(
          { name: "Soft Deleted", age: 1 },
          { id: tombstoneId },
        );
        await tx.nodes.Person.delete(person.id);
      });
      const recordedAtCommit = await readRecordedClock(store);

      const defaultRead = await store
        .asOfRecorded(recordedAtCommit)
        .nodes.Person.getById(tombstoneId as never);
      expect(defaultRead).toBeUndefined();

      const tombstone = await store
        .view({ mode: "includeTombstones" })
        .asOfRecorded(recordedAtCommit)
        .nodes.Person.getById(tombstoneId as never);
      expect(tombstone?.name).toBe("Soft Deleted");
      expect(tombstone?.meta.deletedAt).toBeDefined();
      expect(await countRecordedNodeRows(store, tombstoneId)).toBe(1);
    });

    it("clears live and recorded rows when history capture is enabled", async () => {
      const store = await createHistoryStore(context);

      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);
      expect(
        await store
          .asOfRecorded(recordedAtCreate)
          .nodes.Person.getById(alice.id),
      ).toBeDefined();

      await store.clear();

      expect(await countRecordedNodeRows(store, alice.id)).toBe(0);
      expect(await countRecordedClockRows(store)).toBe(0);

      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const recordedAtAfterClear = await readRecordedClock(store);
      const bobAfterClear = await store
        .asOfRecorded(recordedAtAfterClear)
        .nodes.Person.getById(bob.id);
      expect(bobAfterClear?.name).toBe("Bob");
    });

    it("clear tolerates legacy databases missing recorded-history tables", async () => {
      const baseBackend = context.getStore().backend;
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        baseBackend,
        { history: true },
      );
      await store.nodes.Person.create({ name: "Alice", age: 30 });

      try {
        await dropRecordedRelations(baseBackend);

        await expect(store.clear()).resolves.toBeUndefined();
      } finally {
        await baseBackend.bootstrapTables?.();
      }
    });

    it("surfaces missing recorded-history tables as typed recorded-read errors", async () => {
      const baseBackend = context.getStore().backend;
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        baseBackend,
        { history: true },
      );
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);
      const recorded = store.asOfRecorded(recordedAtCreate);

      try {
        await dropRecordedRelations(baseBackend);

        await expectMissingRecordedRelations(() => store.recordedNow());
        await expectMissingRecordedRelations(() =>
          recorded.nodes.Person.getById(alice.id),
        );
        await expectMissingRecordedRelations(() =>
          recorded
            .query()
            .from("Person", "person")
            .select((ctx) => ctx.person.id)
            .execute(),
        );
        await expectMissingRecordedRelations(() =>
          store.batch(
            recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person),
            recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person.id),
          ),
        );
        await expectMissingRecordedRelations(() =>
          store.batch(
            recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person.id),
            recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person.name),
          ),
        );
        await expectMissingRecordedRelations(() => {
          const left = recorded
            .query()
            .from("Person", "person")
            .select((ctx) => ctx.person.id);
          const right = recorded
            .query()
            .from("Person", "person")
            .select((ctx) => ctx.person.id);
          return store.batch(
            left.union(right),
            recorded
              .query()
              .from("Person", "person")
              .select((ctx) => ctx.person.id),
          );
        });
        await expectMissingRecordedRelations(() =>
          recorded.subgraph(alice.id, { edges: ["knows"], maxDepth: 1 }),
        );
        await expectMissingRecordedRelations(() =>
          recorded.degree(alice, { edges: ["knows"] }),
        );
      } finally {
        await baseBackend.bootstrapTables?.();
      }
    });

    it("preserves recorded query coordinates through store.batch", async () => {
      const store = await createHistoryStore(context);
      const originalName = "Batch Recorded Alice";
      const updatedName = "Batch Recorded Alicia";
      const alice = await store.nodes.Person.create({
        name: originalName,
        age: 30,
      });
      const recordedAtCreate = await readRecordedClock(store);
      await store.nodes.Person.update(alice.id, { name: updatedName });
      const recorded = store.asOfRecorded(recordedAtCreate);

      const [recordedNames, liveNames] = await store.batch(
        recorded
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.name.eq(originalName))
          .select((ctx) => ctx.person.name),
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.name.eq(updatedName))
          .select((ctx) => ctx.person.name),
      );

      expect(recordedNames).toEqual([originalName]);
      expect(liveNames).toEqual([updatedName]);
    });

    it("refuses broad collection reads on the recorded view runtime surface", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);

      await expect(unsupportedRead(store, recordedAtCreate)).rejects.toThrow(
        "RecordedStoreView",
      );
    });

    it("refuses recorded batch endpoint reads synchronously", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);
      const recordedKnows = store.asOfRecorded(recordedAtCreate).edges.knows;
      const batchReads = recordedKnows as unknown as Readonly<{
        batchFindFrom: (from: unknown) => unknown;
      }>;
      let thrown: unknown;

      try {
        batchReads.batchFindFrom(alice);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ConfigurationError);
      const message = (thrown as ConfigurationError).message;
      expect(message).toContain("store.batch");
      expect(message).not.toContain("perform writes on the live Store");
    });

    it("refuses recorded queries that depend on current-only indexes", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Article.create({
        title: "Climate report",
        body: "Climate observations from the recorded-time suite.",
        category: "science",
        published: true,
      });
      const recordedAtCreate = await readRecordedClock(store);
      const recorded = store.asOfRecorded(recordedAtCreate);

      await expect(
        recorded
          .query()
          .from("Article", "article")
          .whereNode("article", (article) =>
            article.$fulltext.matches("climate", 10),
          )
          .select((ctx) => ctx.article.id)
          .execute(),
      ).rejects.toThrow("Recorded-time queries cannot use vector or fulltext");

      if (store[STORE_RUNTIME].backend.capabilities.vector?.supported !== true)
        return;

      await expect(
        recorded
          .query()
          .from("Article", "article")
          .whereNode("article", (article) =>
            article.embedding.similarTo([1, 0, 0, 0], 10),
          )
          .select((ctx) => ctx.article.id)
          .execute(),
      ).rejects.toThrow("Recorded-time queries cannot use vector or fulltext");
    });

    it("refuses recorded recursive queries that depend on current-only indexes", async () => {
      const [store] = await createStoreWithSchema(
        recursiveIndexGuardGraph,
        context.getStore().backend,
        { history: true },
      );
      const climate = await store.nodes.RecursiveArticle.create({
        title: "Climate report",
        body: "Climate observations from the recorded-time suite.",
      });
      const source = await store.nodes.RecursiveArticle.create({
        title: "Source report",
        body: "Reference material for climate observations.",
      });
      await store.edges.references.create(climate, source, {});
      const recordedAtCreate = await readRecordedClock(store);
      const recorded = store.asOfRecorded(recordedAtCreate);

      await expect(
        recorded
          .query()
          .from("RecursiveArticle", "article")
          .whereNode("article", (article) =>
            article.$fulltext.matches("climate", 10),
          )
          .traverse("references", "reference")
          .recursive({ maxHops: 2 })
          .to("RecursiveArticle", "related")
          .select((ctx) => ctx.related.id)
          .execute(),
      ).rejects.toThrow("Recorded-time queries cannot use vector or fulltext");

      if (store[STORE_RUNTIME].backend.capabilities.vector?.supported !== true)
        return;

      await expect(
        recorded
          .query()
          .from("RecursiveArticle", "article")
          .whereNode("article", (article) =>
            article.embedding.similarTo([1, 0, 0, 0], 10),
          )
          .traverse("references", "reference")
          .recursive({ maxHops: 2 })
          .to("RecursiveArticle", "related")
          .select((ctx) => ctx.related.id)
          .execute(),
      ).rejects.toThrow("Recorded-time queries cannot use vector or fulltext");
    });

    it("refuses set operations that mix recorded and live query operands", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);

      const recordedQuery = store
        .asOfRecorded(recordedAtCreate)
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name);
      const liveQuery = store
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name);

      await expect(recordedQuery.union(liveQuery).execute()).rejects.toThrow(
        "Cannot combine queries with different recorded-time coordinates",
      );
    });

    it("pins EXISTS subqueries to the recorded coordinate instead of reading live tables", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtAlice = await readRecordedClock(store);
      const bob = await store.nodes.Person.create({ name: "Bob", age: 40 });
      const recordedAtBob = await readRecordedClock(store);

      // Subquery built from the LIVE store — it carries no recorded pin. The
      // enclosing recorded query must propagate its coordinate into it so the
      // subquery reads the recorded relation, not the live tables.
      const liveBobSubquery = store
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq("Bob"))
        .select((ctx) => ctx.q.id)
        .toAst();

      // At recordedAtAlice, Bob did not yet exist, so EXISTS(Bob) is false and
      // no Person row should match — even though Bob exists in the live tables.
      const atAlice = await store
        .asOfRecorded(recordedAtAlice)
        .query()
        .from("Person", "p")
        .whereNode("p", () => exists(liveBobSubquery))
        .select((ctx) => ctx.p.id)
        .execute();
      expect(atAlice).toEqual([]);

      // At recordedAtBob, Bob exists, so EXISTS(Bob) is true and every Person
      // recorded as of that instant matches.
      const atBob = await store
        .asOfRecorded(recordedAtBob)
        .query()
        .from("Person", "p")
        .whereNode("p", () => exists(liveBobSubquery))
        .select((ctx) => ctx.p.id)
        .execute();
      expect(atBob.toSorted()).toEqual([alice.id, bob.id].toSorted());
    });

    it("rejects a subquery pinned to a different recorded coordinate", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtAlice = await readRecordedClock(store);
      await store.nodes.Person.create({ name: "Bob", age: 40 });
      const recordedAtBob = await readRecordedClock(store);

      const subqueryAtBob = store
        .asOfRecorded(recordedAtBob)
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq("Bob"))
        .select((ctx) => ctx.q.id)
        .toAst();

      await expect(
        store
          .asOfRecorded(recordedAtAlice)
          .query()
          .from("Person", "p")
          .whereNode("p", () => exists(subqueryAtBob))
          .select((ctx) => ctx.p.id)
          .execute(),
      ).rejects.toThrow("different recorded-time coordinate");
    });

    it("rejects a recorded subquery nested in a live outer query", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtAlice = await readRecordedClock(store);

      // Subquery pinned to a recorded instant, embedded in a LIVE outer query.
      // Honoring it silently would read the recorded relation in the subquery
      // while the outer reads live tables — the cross-axis lie the set-operation
      // guard also rejects. It must refuse, not quietly mix axes.
      const recordedSubquery = store
        .asOfRecorded(recordedAtAlice)
        .query()
        .from("Person", "q")
        .whereNode("q", (q) => q.name.eq("Alice"))
        .select((ctx) => ctx.q.id)
        .toAst();

      await expect(
        store
          .query()
          .from("Person", "p")
          .whereNode("p", () => exists(recordedSubquery))
          .select((ctx) => ctx.p.id)
          .execute(),
      ).rejects.toThrow("recorded-time subquery");
    });

    it("reads at the recorded high-water mark identically to the live store", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      await store.nodes.Person.update(alice.id, { name: "Alicia" });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 40 });
      // Soft-deleted: hidden in current state, so a recorded read at `now`
      // (diagonal valid = asOf(now)) must hide it too.
      await store.nodes.Person.delete(bob.id);

      const now = requireRecordedInstant(
        await store.recordedNow(),
        "expected recorded high-water mark",
      );
      const recorded = store.asOfRecorded(now);

      const aliceRecorded = await recorded.nodes.Person.getById(alice.id);
      const aliceLive = await store.nodes.Person.getById(alice.id);
      expect(aliceRecorded?.name).toBe(aliceLive?.name);
      expect(await recorded.nodes.Person.getById(bob.id)).toBeUndefined();

      const recordedRows = await recorded
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name)
        .execute();
      const liveRows = await store
        .query()
        .from("Person", "person")
        .select((ctx) => ctx.person.name)
        .execute();
      const recordedNames = recordedRows.toSorted();
      expect(recordedNames).toEqual(liveRows.toSorted());
      expect(recordedNames).toEqual(["Alicia"]);
    });

    it("shows a node before its soft-delete instant and hides it after", async () => {
      const store = await createHistoryStore(context);
      const carol = await store.nodes.Person.create({ name: "Carol", age: 22 });
      const beforeDelete = await readRecordedClock(store);
      await store.nodes.Person.delete(carol.id);
      const afterDelete = await readRecordedClock(store);
      expect(beforeDelete < afterDelete).toBe(true);

      // Visible at the instant before the delete committed.
      const beforeImage = await store
        .asOfRecorded(beforeDelete)
        .nodes.Person.getById(carol.id);
      expect(beforeImage?.name).toBe("Carol");

      // Hidden at/after the delete instant under the default (diagonal) read,
      // but the tombstone is still reconstructable with includeTombstones.
      expect(
        await store.asOfRecorded(afterDelete).nodes.Person.getById(carol.id),
      ).toBeUndefined();
      const tombstone = await store
        .view({ mode: "includeTombstones" })
        .asOfRecorded(afterDelete)
        .nodes.Person.getById(carol.id);
      expect(tombstone?.name).toBe("Carol");
    });

    it("reverses a soft-delete across recorded instants: present, hidden, then present again", async () => {
      const store = await createHistoryStore(context);
      const dave = await store.nodes.Person.create({ name: "Dave", age: 40 });
      const beforeDelete = await readRecordedClock(store);

      await store.nodes.Person.delete(dave.id);
      const afterDelete = await readRecordedClock(store);

      // upsertById resurrects a soft-deleted node (it clears deleted_at), and
      // the restore is captured as its own recorded transition.
      await store.nodes.Person.upsertById(dave.id, { name: "Dave", age: 41 });
      const afterRestore = await readRecordedClock(store);

      expect(beforeDelete < afterDelete).toBe(true);
      expect(afterDelete < afterRestore).toBe(true);

      // Present before the delete instant...
      const beforeImage = await store
        .asOfRecorded(beforeDelete)
        .nodes.Person.getById(dave.id);
      expect(beforeImage?.age).toBe(40);
      // ...hidden at the delete instant (the diagonal read excludes the
      // tombstone)...
      expect(
        await store.asOfRecorded(afterDelete).nodes.Person.getById(dave.id),
      ).toBeUndefined();
      // ...and present again with the restored value after the restore instant,
      // matching the live read.
      const restoredImage = await store
        .asOfRecorded(afterRestore)
        .nodes.Person.getById(dave.id);
      expect(restoredImage?.age).toBe(41);
      const liveImage = await store.nodes.Person.getById(dave.id);
      expect(liveImage?.age).toBe(41);
    });

    it("leaves the valid-time window untouched across a recorded-capturing write", async () => {
      const store = await createHistoryStore(context);
      const validFrom = "2020-01-01T00:00:00.000Z";
      const validTo = "2099-01-01T00:00:00.000Z";

      const node = await store.nodes.Person.create(
        { name: "Vera", age: 30 },
        { validFrom, validTo },
      );
      const recordedAtCreate = await readRecordedClock(store);

      // A prop-only update captures a new recorded version but must not perturb
      // the domain (valid-time) window. (validFrom/validTo bracket the ~now
      // recorded instants, so the diagonal read sees the node at both.)
      await store.nodes.Person.update(node.id, { name: "Veronica" });
      const recordedAtUpdate = await readRecordedClock(store);

      const atCreate = await store
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getById(node.id);
      expect(atCreate?.name).toBe("Vera");
      expect(atCreate?.meta.validFrom).toBe(validFrom);
      expect(atCreate?.meta.validTo).toBe(validTo);

      const atUpdate = await store
        .asOfRecorded(recordedAtUpdate)
        .nodes.Person.getById(node.id);
      // Props advanced, but the valid window is byte-identical to create.
      expect(atUpdate?.name).toBe("Veronica");
      expect(atUpdate?.meta.validFrom).toBe(validFrom);
      expect(atUpdate?.meta.validTo).toBe(validTo);
    });

    it("refuses endpoint reads and refuses search on the recorded view surface", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      await store.edges.knows.create(alice, bob, { since: "2020" });
      const recordedAt = await readRecordedClock(store);

      const recorded = store.asOfRecorded(recordedAt) as unknown as Readonly<{
        edges: Readonly<{
          knows: Readonly<{
            findFrom: (from: unknown) => Promise<unknown>;
            findTo: (to: unknown) => Promise<unknown>;
            findByEndpoints: (from: unknown, to: unknown) => Promise<unknown>;
          }>;
        }>;
        search: Readonly<{
          fulltext: (...args: unknown[]) => Promise<unknown>;
        }>;
      }>;

      await expect(recorded.edges.knows.findFrom(alice)).rejects.toThrow(
        "RecordedStoreView",
      );
      await expect(recorded.edges.knows.findTo(bob)).rejects.toThrow(
        "RecordedStoreView",
      );
      await expect(
        recorded.edges.knows.findByEndpoints(alice, bob),
      ).rejects.toThrow("RecordedStoreView");
      // Search is on the recorded surface only as a refusing backstop: a JS
      // caller reaching past the types gets a facade whose methods reject with a
      // clear recorded-unsupported error, never a live hit against the
      // current-state index.
      await expect(recorded.search.fulltext("Person", {})).rejects.toThrow(
        "RecordedStoreView",
      );
    });

    it("refuses every unsupported recorded view collection and search method at runtime", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      await store.edges.knows.create(alice, bob, { since: "2020" });
      const recordedAt = await readRecordedClock(store);
      const recorded = store.asOfRecorded(recordedAt) as unknown as Readonly<{
        nodes: Readonly<{ Person: RuntimeTarget }>;
        edges: Readonly<{ knows: RuntimeTarget }>;
        search: RuntimeTarget;
      }>;

      const nodeUnsupportedMethods = [
        "find",
        "count",
        ...CURRENT_ONLY_READ_NAMES,
        "create",
        "createFromRecord",
        "update",
        "delete",
        "hardDelete",
        "upsertById",
        "upsertByIdFromRecord",
        "bulkCreate",
        "bulkUpsertById",
        "bulkInsert",
        "bulkDelete",
        "getOrCreateByConstraint",
        "bulkGetOrCreateByConstraint",
      ] as const satisfies readonly (keyof NodeCollection<NodeType>)[];

      const edgeUnsupportedMethods = [
        "find",
        "count",
        "findFrom",
        "findTo",
        "findByEndpoints",
        "create",
        "update",
        "delete",
        "hardDelete",
        "bulkCreate",
        "bulkUpsertById",
        "bulkInsert",
        "bulkDelete",
        "getOrCreateByEndpoints",
        "bulkGetOrCreateByEndpoints",
      ] as const satisfies readonly (keyof EdgeCollection<
        AnyEdgeType,
        NodeType,
        NodeType
      >)[];

      const searchUnsupportedMethods = [
        "fulltext",
        "vector",
        "hybrid",
        "rebuildFulltext",
      ] as const satisfies readonly (keyof StoreSearch<
        typeof integrationTestGraph
      >)[];
      const futureSearchUnsupportedMethods = ["futureSearchMethod"] as const;

      for (const method of nodeUnsupportedMethods) {
        await expectAsyncContractRefusal({
          surface: `recorded node ${method}`,
          invoke: () => invokeRuntimeMethod(recorded.nodes.Person, method),
          message: "RecordedStoreView",
        });
      }

      for (const method of edgeUnsupportedMethods) {
        await expectAsyncContractRefusal({
          surface: `recorded edge ${method}`,
          invoke: () => invokeRuntimeMethod(recorded.edges.knows, method),
          message: "RecordedStoreView",
        });
      }

      for (const method of EDGE_BATCH_READ_NAMES) {
        expectSyncContractRefusal({
          surface: `recorded edge ${method}`,
          invoke: () => invokeRuntimeMethod(recorded.edges.knows, method),
          message: "store.batch",
        });
      }

      for (const method of searchUnsupportedMethods) {
        expect(method in recorded.search).toBe(true);
        await expectAsyncContractRefusal({
          surface: `recorded search ${method}`,
          invoke: () => invokeRuntimeMethod(recorded.search, method),
          message: "RecordedStoreView",
        });
      }

      for (const method of futureSearchUnsupportedMethods) {
        expect(method in recorded.search).toBe(true);
        await expectAsyncContractRefusal({
          surface: `recorded future search ${method}`,
          invoke: () => invokeRuntimeMethod(recorded.search, method),
          message: "RecordedStoreView",
        });
      }
    });

    it("persists the net op transition, collapsing create-then-update", async () => {
      const store = await createHistoryStore(context);
      const personId = "op-person";

      // create + update in one transaction is a single observable transition:
      // the net op is `create`, not the last raw operation (`update`).
      await store.transaction(async (tx) => {
        const person = await tx.nodes.Person.create(
          { name: "Pat", age: 1 },
          { id: personId },
        );
        await tx.nodes.Person.update(person.id, { name: "Patricia" });
      });
      expect(await readRecordedNodeOps(store, "Person", personId)).toEqual([
        "create",
      ]);

      // A later soft-delete closes the create row and opens a `delete` row.
      await store.nodes.Person.delete(personId as never);
      expect(await readRecordedNodeOps(store, "Person", personId)).toEqual([
        "create",
        "delete",
      ]);
    });

    it("compiles current-mode reads against the live tables only", async () => {
      const store = await createHistoryStore(context);
      const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
      const compileSql = requireBackendHelper(
        store[STORE_RUNTIME].backend.compileSql,
        "compileSql",
      );

      // The recorded axis must never leak into a current-mode read: capture is
      // an opt-in side write, and `current` compilation stays byte-for-byte the
      // live path. Assert the compiled SQL targets the live nodes table and
      // references none of the recorded relations.
      const ast = store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) => person.name.eq("Alice"))
        .select((ctx) => ctx.person.id)
        .toAst();
      const compiled = compileQuery(ast, store.graphId, {
        dialect: store[STORE_RUNTIME].backend.dialect,
        schema,
      });
      const { sql: text } = compileSql(compiled);

      expect(text).toContain(schema.tables.nodes);
      expect(text).not.toContain(schema.tables.recordedNodes);
      expect(text).not.toContain(schema.tables.recordedEdges);
      expect(text).not.toContain(schema.tables.recordedClock);
    });

    it("executes prepared query reads when history capture is enabled", async () => {
      const store = await createHistoryStore(context);
      await store.nodes.Person.create({ name: "Alice", age: 30 });

      const prepared = store
        .query()
        .from("Person", "person")
        .whereNode("person", (person) =>
          person.name.contains(parameter("needle")),
        )
        .select((ctx) => ctx.person.name)
        .prepare();

      await expect(prepared.execute({ needle: "lic" })).resolves.toEqual([
        "Alice",
      ]);
    });

    it("executes prepared reads over fields named like SqlFragment keywords under history", async () => {
      const [store] = await createStoreWithSchema(
        keywordFieldGraph,
        context.getStore().backend,
        { history: true },
      );
      await store.nodes.KeywordFieldNode.create({
        comment: "needs review",
        update: "pending",
      });

      // Both the WHERE and SELECT embed the keyword field names as JSON-path
      // literals, so the prepared executeRaw fast path carries SQL text
      // containing "comment"/"update". It must run as the read it is.
      const prepared = store
        .query()
        .from("KeywordFieldNode", "note")
        .whereNode("note", (note) => note.comment.contains(parameter("needle")))
        .select((ctx) => ctx.note.update)
        .prepare();

      await expect(prepared.execute({ needle: "review" })).resolves.toEqual([
        "pending",
      ]);
    });

    it("does not expose arbitrary raw SQL on the public transaction backend", async () => {
      const store = await createHistoryStore(context);

      await store.transaction((tx) => {
        expect("executeRaw" in tx.backend).toBe(false);
        expect(Object.hasOwn(tx.backend, "executeRaw")).toBe(false);
        return Promise.resolve();
      });
    });

    it("refuses raw transaction SqlFragment when history capture is enabled", async () => {
      const store = await createHistoryStore(context);

      await store.transaction(async (tx) => {
        expect(() => getRuntimeProperty(tx, "sql")).toThrow(
          "tx.sql is not available when history capture is enabled",
        );
        // Enumeration / inspection must fail loud too, not silently resolve to
        // an empty object that reads as "no raw handle".
        expect(() => ({
          ...(getRuntimeProperty(tx, "sql") as object),
        })).toThrow("tx.sql is not available when history capture is enabled");
        expect(() =>
          Object.keys(getRuntimeProperty(tx, "sql") as object),
        ).toThrow("tx.sql is not available when history capture is enabled");
        expect(
          () => "insert" in (getRuntimeProperty(tx, "sql") as object),
        ).toThrow("tx.sql is not available when history capture is enabled");
        await tx.nodes.Person.create({ name: "Guarded", age: 1 });
      });
    });

    it("refuses backend.executeStatement on the history-wrapped backend", async () => {
      const store = await createHistoryStore(context);
      const executeStatement = requireBackendHelper(
        store[STORE_RUNTIME].backend.executeStatement,
        "backend.executeStatement",
      );

      await expect(
        executeStatement(asCompiledStatementSql(sql`SELECT 1`)),
      ).rejects.toThrow(
        "backend.executeStatement is not available when history capture is enabled",
      );
    });

    it("refuses backend raw DDL on the history-wrapped backend", async () => {
      const store = await createHistoryStore(context);
      await expect(
        rawHelperOutcome(
          "backend.executeDdl",
          store[STORE_RUNTIME].backend.executeDdl,
          (run) => run("SELECT 1"),
        ),
      ).resolves.toMatch(/backend\.executeDdl (is not available|unavailable)/);
    });

    it("does not expose an adapter-native handle on the portable backend transaction", async () => {
      const store = await createHistoryStore(context);

      await store[STORE_RUNTIME].backend.transaction((target) => {
        expect(target.dialect).toBe(store[STORE_RUNTIME].backend.dialect);
        return Promise.resolve(undefined);
      });
    });

    it("refuses transaction backend raw write helpers when history capture is enabled", async () => {
      const store = await createHistoryStore(context);

      await store.transaction(async (tx) => {
        const transactionBackend = tx[TRANSACTION_RUNTIME].backend;
        const executeStatement = requireBackendHelper(
          transactionBackend.executeStatement,
          "tx.backend.executeStatement",
        );
        const executeDdlOutcome = rawHelperOutcome(
          "tx.backend.executeDdl",
          transactionBackend.executeDdl,
          (run) => run("SELECT 1"),
        );

        await expect(
          executeStatement(asCompiledStatementSql(sql`SELECT 1`)),
        ).rejects.toThrow(
          "tx.backend.executeStatement is not available when history capture is enabled",
        );
        await expect(executeDdlOutcome).resolves.toMatch(
          /tx\.backend\.executeDdl (is not available|unavailable)/,
        );
        await tx.nodes.Person.create({ name: "Guarded", age: 1 });
      });
    });

    it("refuses context-returning external transactions when history capture is enabled", async () => {
      const store = await createHistoryStore(context);

      expect(() =>
        invokeRuntimeMethod(
          store as unknown as RuntimeTarget,
          "withTransaction",
          [{}],
        ),
      ).toThrow("withTransaction() has no recorded-time capture flush point");
    });

    it("chunks recorded point reads and writes beyond SQLite bind limits", async () => {
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        withBindLimit(context.getStore().backend, 900),
        { history: true },
      );
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });
      const bulkPeople = await store.nodes.Person.bulkCreate(
        seq(200).map((index) => ({
          id: `recorded-bulk-${index}`,
          props: { name: `Bulk ${index}`, age: index },
        })),
      );
      const recordedAtCreate = await readRecordedClock(store);

      const repeatedNodeIds = Array.from(
        { length: 1005 },
        () => alice.id,
      ) as unknown as readonly never[];
      const repeatedEdgeIds = Array.from(
        { length: 1005 },
        () => edge.id,
      ) as unknown as readonly never[];

      const nodes = await store
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getByIds(repeatedNodeIds);
      const edges = await store
        .asOfRecorded(recordedAtCreate)
        .edges.knows.getByIds(repeatedEdgeIds);
      const bulkNodes = await store
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getByIds(bulkPeople.map((person) => person.id));

      expect(bulkPeople).toHaveLength(200);
      expect(nodes).toHaveLength(1005);
      expect(nodes.every((node) => node?.name === "Alice")).toBe(true);
      expect(edges).toHaveLength(1005);
      expect(edges.every((found) => found?.since === "2020")).toBe(true);
      expect(bulkNodes).toHaveLength(200);
      expect(
        bulkNodes.every((node) => node?.name.startsWith("Bulk ") === true),
      ).toBe(true);
    });

    it("fails loud when a recorded read matches overlapping intervals", async () => {
      const baseBackend = context.getStore().backend;
      const store = await createHistoryStore(context);
      if (baseBackend.executeStatement === undefined) {
        throw new Error("Integration backend should support executeStatement");
      }

      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const recordedAtCreate = await readRecordedClock(store);
      const schema = createSqlSchema(baseBackend.tableNames);

      await baseBackend.executeStatement(
        asCompiledStatementSql(sql`
          INSERT INTO ${schema.recordedNodesTable} (
            history_id,
            graph_id,
            kind,
            id,
            props,
            version,
            valid_from,
            valid_to,
            created_at,
            updated_at,
            deleted_at,
            recorded_from,
            recorded_to,
            op,
            schema_version,
            tx_id,
            meta
          )
          SELECT
            ${`duplicate-${alice.id}`},
            graph_id,
            kind,
            id,
            props,
            version,
            valid_from,
            valid_to,
            created_at,
            updated_at,
            deleted_at,
            recorded_from,
            recorded_to,
            op,
            schema_version,
            tx_id,
            meta
          FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${store.graphId}
            AND kind = ${"Person"}
            AND id = ${alice.id}
          LIMIT 1
        `),
      );

      await expect(
        store.asOfRecorded(recordedAtCreate).nodes.Person.getById(alice.id),
      ).rejects.toMatchObject({
        details: {
          code: "RECORDED_RELATION_INVARIANT_VIOLATION",
          entity: "node",
          kind: "Person",
          id: alice.id,
        },
      });
      await expect(
        store.asOfRecorded(recordedAtCreate).nodes.Person.scan(),
      ).rejects.toMatchObject({
        details: {
          code: "RECORDED_RELATION_INVARIANT_VIOLATION",
          entity: "node",
          kind: "Person",
          id: alice.id,
        },
      });
    });

    it("captures collection-level edge bulk create and bulk delete", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const carol = await store.nodes.Person.create({ name: "Carol", age: 32 });

      const created = await store.edges.knows.bulkCreate([
        {
          id: "bulk-edge-a",
          from: alice,
          to: bob,
          props: { since: "2020" },
        },
        {
          id: "bulk-edge-b",
          from: bob,
          to: carol,
          props: { since: "2021" },
        },
      ]);
      const edgeIds = created.map((edge) => edge.id);
      const recordedAtCreate = await readRecordedClock(store);

      const createdAtCheckpoint = await store
        .asOfRecorded(recordedAtCreate)
        .edges.knows.getByIds(edgeIds);
      expect(createdAtCheckpoint.map((edge) => edge?.since)).toEqual([
        "2020",
        "2021",
      ]);

      await store.edges.knows.bulkDelete(edgeIds);
      const recordedAtDelete = await readRecordedClock(store);

      const defaultAtDelete = await store
        .asOfRecorded(recordedAtDelete)
        .edges.knows.getByIds(edgeIds);
      expect(defaultAtDelete).toEqual([undefined, undefined]);

      const tombstonesAtDelete = await store
        .view({ mode: "includeTombstones" })
        .asOfRecorded(recordedAtDelete)
        .edges.knows.getByIds(edgeIds);
      expect(tombstonesAtDelete.map((edge) => edge?.since)).toEqual([
        "2020",
        "2021",
      ]);
      await expect(
        countRecordedEdgeRows(store, requireDefined(edgeIds[0])),
      ).resolves.toBe(2);
      await expect(
        countRecordedEdgeRows(store, requireDefined(edgeIds[1])),
      ).resolves.toBe(2);
    });

    it("captures direct backend batch writes when transaction targets omit batch helpers", async () => {
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        withoutTransactionInsertBatchHelpers(context.getStore().backend),
        { history: true },
      );
      const insertNodesBatch = requireBackendHelper(
        store[STORE_RUNTIME].backend.insertNodesBatch,
        "backend.insertNodesBatch",
      );
      const insertNodesBatchReturning = requireBackendHelper(
        store[STORE_RUNTIME].backend.insertNodesBatchReturning,
        "backend.insertNodesBatchReturning",
      );
      const insertEdgesBatch = requireBackendHelper(
        store[STORE_RUNTIME].backend.insertEdgesBatch,
        "backend.insertEdgesBatch",
      );
      const insertEdgesBatchReturning = requireBackendHelper(
        store[STORE_RUNTIME].backend.insertEdgesBatchReturning,
        "backend.insertEdgesBatchReturning",
      );

      const nodeIds = ["outer-batch-a", "outer-batch-b"];
      await insertNodesBatch(
        nodeIds.map((id, index) => ({
          graphId: store.graphId,
          kind: "Person",
          id,
          props: { name: `Outer Batch ${index}`, age: index },
        })),
      );
      const returnedRows = await insertNodesBatchReturning([
        {
          graphId: store.graphId,
          kind: "Person",
          id: "outer-returning-c",
          props: { name: "Outer Returning", age: 3 },
        },
      ]);
      await insertEdgesBatch([
        {
          graphId: store.graphId,
          id: "outer-edge-a",
          kind: "knows",
          fromKind: "Person",
          fromId: "outer-batch-a",
          toKind: "Person",
          toId: "outer-batch-b",
          props: { since: "2020" },
        },
      ]);
      const returnedEdges = await insertEdgesBatchReturning([
        {
          graphId: store.graphId,
          id: "outer-edge-b",
          kind: "knows",
          fromKind: "Person",
          fromId: "outer-batch-b",
          toKind: "Person",
          toId: "outer-returning-c",
          props: { since: "2021" },
        },
      ]);
      const recordedAt = await readRecordedClock(store);

      expect(returnedRows.map((row) => row.id)).toEqual(["outer-returning-c"]);
      expect(returnedEdges.map((row) => row.id)).toEqual(["outer-edge-b"]);
      const recordedNodes = await store
        .asOfRecorded(recordedAt)
        .nodes.Person.getByIds([
          ...nodeIds,
          "outer-returning-c",
        ] as unknown as readonly never[]);
      expect(recordedNodes.map((node) => node?.name)).toEqual([
        "Outer Batch 0",
        "Outer Batch 1",
        "Outer Returning",
      ]);
      const recordedEdges = await store
        .asOfRecorded(recordedAt)
        .edges.knows.getByIds([
          "outer-edge-a",
          "outer-edge-b",
        ] as unknown as readonly never[]);
      expect(recordedEdges.map((edge) => edge?.since)).toEqual([
        "2020",
        "2021",
      ]);
    });

    it("captures direct backend batch-returning node writes by kind and id", async () => {
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        context.getStore().backend,
        { history: true },
      );
      const insertNodesBatchReturning = requireBackendHelper(
        store[STORE_RUNTIME].backend.insertNodesBatchReturning,
        "backend.insertNodesBatchReturning",
      );
      const sharedId = "outer-returning-shared-cross-kind";

      const returnedRows = await insertNodesBatchReturning([
        {
          graphId: store.graphId,
          kind: "Person",
          id: sharedId,
          props: { name: "Shared Person", age: 41 },
        },
        {
          graphId: store.graphId,
          kind: "Company",
          id: sharedId,
          props: { name: "Shared Company", industry: "Research" },
        },
      ]);
      const recordedAt = await readRecordedClock(store);
      const recorded = store.asOfRecorded(recordedAt);

      expect(
        returnedRows.map((row) => `${row.kind}:${row.id}`).toSorted(),
      ).toEqual([`Company:${sharedId}`, `Person:${sharedId}`]);
      await expect(
        recorded.nodes.Person.getById(sharedId as never),
      ).resolves.toMatchObject({ kind: "Person", name: "Shared Person" });
      await expect(
        recorded.nodes.Company.getById(sharedId as never),
      ).resolves.toMatchObject({
        kind: "Company",
        name: "Shared Company",
        industry: "Research",
      });
    });

    it("captures direct backend batch-returning edge writes by graph and id", async () => {
      const baseBackend = context.getStore().backend;
      const [storeA] = await createStoreWithSchema(
        batchEdgeIdentityGraphA,
        baseBackend,
        { history: true },
      );
      const [storeB] = await createStoreWithSchema(
        batchEdgeIdentityGraphB,
        baseBackend,
        { history: true },
      );
      const insertNodesBatchReturning = requireBackendHelper(
        storeA[STORE_RUNTIME].backend.insertNodesBatchReturning,
        "backend.insertNodesBatchReturning",
      );
      const insertEdgesBatchReturning = requireBackendHelper(
        storeA[STORE_RUNTIME].backend.insertEdgesBatchReturning,
        "backend.insertEdgesBatchReturning",
      );
      const sharedEdgeId = "outer-returning-shared-cross-graph-edge";

      await insertNodesBatchReturning([
        {
          graphId: storeA.graphId,
          kind: "BatchEdgePerson",
          id: "graph-a-from",
          props: { name: "Graph A From" },
        },
        {
          graphId: storeA.graphId,
          kind: "BatchEdgePerson",
          id: "graph-a-to",
          props: { name: "Graph A To" },
        },
        {
          graphId: storeB.graphId,
          kind: "BatchEdgePerson",
          id: "graph-b-from",
          props: { name: "Graph B From" },
        },
        {
          graphId: storeB.graphId,
          kind: "BatchEdgePerson",
          id: "graph-b-to",
          props: { name: "Graph B To" },
        },
      ]);

      const returnedEdges = await insertEdgesBatchReturning([
        {
          graphId: storeA.graphId,
          id: sharedEdgeId,
          kind: "batchEdgeKnows",
          fromKind: "BatchEdgePerson",
          fromId: "graph-a-from",
          toKind: "BatchEdgePerson",
          toId: "graph-a-to",
          props: { since: "graph-a" },
        },
        {
          graphId: storeB.graphId,
          id: sharedEdgeId,
          kind: "batchEdgeKnows",
          fromKind: "BatchEdgePerson",
          fromId: "graph-b-from",
          toKind: "BatchEdgePerson",
          toId: "graph-b-to",
          props: { since: "graph-b" },
        },
      ]);

      expect(
        returnedEdges
          .map(
            (edge) =>
              `${edge.graph_id}:${edge.id}:${rowPropsToJsonText(edge.props)}`,
          )
          .toSorted(),
      ).toEqual([
        `${storeA.graphId}:${sharedEdgeId}:{"since":"graph-a"}`,
        `${storeB.graphId}:${sharedEdgeId}:{"since":"graph-b"}`,
      ]);

      const recordedAtA = requireRecordedInstant(
        await storeA.recordedNow(),
        "expected graph A batch-edge recorded instant",
      );
      const recordedAtB = requireRecordedInstant(
        await storeB.recordedNow(),
        "expected graph B batch-edge recorded instant",
      );

      await expect(
        storeA
          .asOfRecorded(recordedAtA)
          .edges.batchEdgeKnows.getById(sharedEdgeId as never),
      ).resolves.toMatchObject({ since: "graph-a" });
      await expect(
        storeB
          .asOfRecorded(recordedAtB)
          .edges.batchEdgeKnows.getById(sharedEdgeId as never),
      ).resolves.toMatchObject({ since: "graph-b" });
    });

    it("fails loud before flushing history with a non-finite bind-parameter budget", async () => {
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        withBindLimit(context.getStore().backend, Number.NaN),
        { history: true },
      );

      await expect(
        store.nodes.Person.create(
          { name: "Invalid Budget", age: 1 },
          { id: "invalid-bind-budget" },
        ),
      ).rejects.toThrow(/maxBindParameters must be a positive integer/u);
      await expect(
        store.nodes.Person.getById("invalid-bind-budget" as never),
      ).resolves.toBeUndefined();
    });

    it("captures edges via the per-id getEdge fallback when getEdges is absent", async () => {
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        withoutTransactionGetEdges(context.getStore().backend),
        { history: true },
      );
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2019",
      });
      await store.edges.knows.update(edge.id, { since: "2020" });

      // Reconstruction proves the edge after-images were read through the
      // per-id getEdge fallback in flushEdges, not the batched getEdges helper.
      const recordedAt = requireRecordedInstant(
        await store.recordedNow(),
        "expected per-id edge fallback recorded instant",
      );
      const reconstructed = await store
        .asOfRecorded(recordedAt)
        .edges.knows.getByIds([edge.id]);
      expect(reconstructed.map((found) => found?.since)).toEqual(["2020"]);
    });

    it("captures recorded history for a bulk importGraph at one shared instant", async () => {
      const store = await createHistoryStore(context);
      const data: GraphData = {
        formatVersion: "1.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "external", description: "import-capture test" },
        nodes: [
          {
            kind: "Person",
            id: "import-alice",
            properties: { name: "Alice", age: 30 },
          },
          {
            kind: "Person",
            id: "import-bob",
            properties: { name: "Bob", age: 31 },
          },
        ],
        edges: [
          {
            kind: "knows",
            id: "import-knows",
            from: { kind: "Person", id: "import-alice" },
            to: { kind: "Person", id: "import-bob" },
            properties: { since: "2020" },
          },
        ],
      };

      // importGraph bypasses the collection execute* helpers — it calls backend
      // insert methods directly inside one backend.transaction. Capture must
      // still record every imported entity (the write-funnel claim), and a
      // single transaction yields a single shared recorded instant.
      const result = await importGraph(
        store,
        data,
        ImportOptionsSchema.parse({ onConflict: "error" }),
      );
      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(2);
      expect(result.edges.created).toBe(1);

      const recordedInstant = requireRecordedInstant(
        await store.recordedNow(),
        "expected importGraph recorded instant",
      );

      const schema = createSqlSchema(store[STORE_RUNTIME].backend.tableNames);
      const nodeFroms = await store[
        STORE_RUNTIME
      ].backend.execute<RecordedFromRow>(
        asCompiledRowsSql(sql`
          SELECT recorded_from FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${store.graphId}
        `),
      );
      const edgeFroms = await store[
        STORE_RUNTIME
      ].backend.execute<RecordedFromRow>(
        asCompiledRowsSql(sql`
          SELECT recorded_from FROM ${schema.recordedEdgesTable}
          WHERE graph_id = ${store.graphId}
        `),
      );
      const instants = new Set(
        [...nodeFroms, ...edgeFroms].map((row) =>
          toCanonicalRecordedBoundary(row.recorded_from),
        ),
      );
      expect(instants).toEqual(new Set([recordedInstant]));

      const recorded = store.asOfRecorded(recordedInstant);
      const people = await recorded.nodes.Person.getByIds([
        "import-alice",
        "import-bob",
      ] as unknown as readonly never[]);
      expect(people.map((node) => node?.name)).toEqual(["Alice", "Bob"]);
      const edges = await recorded.edges.knows.getByIds([
        "import-knows",
      ] as unknown as readonly never[]);
      expect(edges.map((edge) => edge?.since)).toEqual(["2020"]);
    });

    it("direct backend hard-delete closes connected recorded edges", async () => {
      const store = await createHistoryStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 31 });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });

      await store[STORE_RUNTIME].backend.hardDeleteNode({
        graphId: store.graphId,
        kind: "Person",
        id: alice.id,
      });
      const recordedAtDelete = requireRecordedInstant(
        await store.recordedNow(),
        "expected direct hard-delete recorded instant",
      );

      expect(
        await store.asOfRecorded(recordedAtDelete).edges.knows.getById(edge.id),
      ).toBeUndefined();
      expect(await countRecordedEdgeRows(store, edge.id)).toBe(1);
      expect(await readRecordedEdgeClosedAt(store, "knows", edge.id)).not.toBe(
        RECORDED_MAX,
      );
    });

    it("captures cascade hard-delete edges and node at one recorded instant", async () => {
      const [store] = await createStoreWithSchema(
        cascadeGraph,
        context.getStore().backend,
        { history: true },
      );
      const parent = await store.nodes.CascadePerson.create({ name: "Parent" });
      const child = await store.nodes.CascadePerson.create({ name: "Child" });
      const edge = await store.edges.cascadeKnows.create(parent, child, {
        since: "2020",
      });

      await store.nodes.CascadePerson.hardDelete(parent.id);
      const recordedAfterHardDelete = requireRecordedInstant(
        await store.recordedNow(),
        "expected cascade hard-delete recorded instant",
      );

      expect(
        await store
          .asOfRecorded(recordedAfterHardDelete)
          .nodes.CascadePerson.getById(parent.id),
      ).toBeUndefined();
      expect(
        await countRecordedNodeRows(store, parent.id, "CascadePerson"),
      ).toBe(1);
      expect(await countRecordedEdgeRows(store, edge.id, "cascadeKnows")).toBe(
        1,
      );
      const nodeClosedAt = await readRecordedNodeClosedAt(
        store,
        "CascadePerson",
        parent.id,
      );
      const edgeClosedAt = await readRecordedEdgeClosedAt(
        store,
        "cascadeKnows",
        edge.id,
      );
      expect(nodeClosedAt).not.toBe(RECORDED_MAX);
      expect(edgeClosedAt).toBe(nodeClosedAt);
    });

    it("captures cascade soft-delete edges and node at one recorded instant", async () => {
      const [store] = await createStoreWithSchema(
        cascadeGraph,
        context.getStore().backend,
        { history: true },
      );
      const parent = await store.nodes.CascadePerson.create({ name: "Parent" });
      const child = await store.nodes.CascadePerson.create({ name: "Child" });
      const edge = await store.edges.cascadeKnows.create(parent, child, {
        since: "2020",
      });

      await store.nodes.CascadePerson.delete(parent.id);

      // The soft-delete cascade runs in a single transaction, so the parent
      // tombstone and the cascaded edge tombstone share one recorded commit
      // instant — not one instant per sub-write (which is what an un-wrapped
      // cascade of autocommit writes would produce).
      const nodeTombstoneFrom = await readRecordedNodeOpenFrom(
        store,
        "CascadePerson",
        parent.id,
      );
      const edgeTombstoneFrom = await readRecordedEdgeOpenFrom(
        store,
        "cascadeKnows",
        edge.id,
      );
      expect(nodeTombstoneFrom).not.toBe(RECORDED_MAX);
      expect(edgeTombstoneFrom).toBe(nodeTombstoneFrom);

      // The diagonal recorded read at that instant shows the node already gone.
      const recordedAfterSoftDelete = requireRecordedInstant(
        await store.recordedNow(),
        "expected cascade soft-delete recorded instant",
      );
      expect(
        await store
          .asOfRecorded(recordedAfterSoftDelete)
          .nodes.CascadePerson.getById(parent.id),
      ).toBeUndefined();
    });

    it("closes recorded intervals for edges attached to a removed extension node kind", async () => {
      const [store] = await createStoreWithSchema(
        removalGraph,
        context.getStore().backend,
        { history: true },
      );
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: {
            RemovalTag: { properties: { label: { type: "string" } } },
          },
          edges: {
            removalLink: {
              from: ["RemovalPerson", "RemovalTag"],
              to: ["RemovalPerson"],
              properties: {},
            },
          },
        }),
      );
      const dynamicNodes = evolved.nodes as unknown as Readonly<{
        RemovalTag: {
          create: (
            props: Readonly<{ label: string }>,
          ) => Promise<Readonly<{ id: string; kind: string }>>;
        };
      }>;
      const dynamicEdges = evolved.edges as unknown as Readonly<{
        removalLink: {
          create: (
            from: Readonly<{ id: string; kind: string }>,
            to: Readonly<{ id: string; kind: string }>,
            props: Record<string, never>,
          ) => Promise<Readonly<{ id: string }>>;
        };
      }>;
      const person = await evolved.nodes.RemovalPerson.create({
        name: "Person",
      });
      const tag = await dynamicNodes.RemovalTag.create({ label: "tag" });
      const edge = await dynamicEdges.removalLink.create(tag, person, {});

      expect(await countOpenRecordedNodeRowsByKind(evolved, "RemovalTag")).toBe(
        1,
      );
      expect(
        await readRecordedEdgeClosedAt(evolved, "removalLink", edge.id),
      ).toBe(RECORDED_MAX);

      const removed = await evolved.removeKinds(["RemovalTag"]);
      await removed.materializeRemovals();

      expect(await countOpenRecordedNodeRowsByKind(removed, "RemovalTag")).toBe(
        0,
      );
      expect(
        await readRecordedEdgeClosedAt(removed, "removalLink", edge.id),
      ).not.toBe(RECORDED_MAX);
      expect(removed.registry.hasEdgeType("removalLink")).toBe(true);
    });

    it("fails loud when the recorded clock contains an invalid anchor", async () => {
      const baseBackend = context.getStore().backend;
      const [store] = await createStoreWithSchema(
        integrationTestGraph,
        baseBackend,
        { history: true },
      );
      if (baseBackend.executeStatement === undefined) {
        throw new Error("Integration backend should support executeStatement");
      }
      const schema = createSqlSchema(baseBackend.tableNames);
      const corruptClock = sql`INSERT INTO ${schema.recordedClockTable} (graph_id, recorded_at) VALUES (${store.graphId}, ${"not-a-date"})`;
      const corruptionOutcome = await baseBackend
        .executeStatement(asCompiledStatementSql(corruptClock))
        .then(
          () => "clock corruption inserted",
          (error: unknown) =>
            error instanceof Error ? error.message : String(error),
        );
      const observed =
        corruptionOutcome === "clock corruption inserted" ?
          await store.nodes.Person.create({ name: "Alice", age: 30 }).then(
            () => "recorded write resolved",
            (error: unknown) =>
              error instanceof Error ? error.message : String(error),
          )
        : corruptionOutcome;

      expect(observed).toMatch(
        /Recorded clock row contained an invalid recorded instant/i,
      );
    });

    it("captures large multi-entity transactions across batch chunk boundaries", async () => {
      const store = await createHistoryStore(context);
      // 130 nodes / 129 edges in one transaction crosses the internal
      // node (60) and edge (50) insert-chunk boundaries several times, so the
      // batched flush must span multiple multi-row statements per relation.
      const indices = seq(130);
      const ids = indices.map((index) => `bulk-${index}`);
      // Branded ids for the typed point-read / mutation surface; `ids` stays a
      // plain string[] for the raw SQL count helpers.
      const nodeIds = ids as unknown as readonly never[];

      const edgeIds = await store.transaction(async (tx) => {
        const people = [];
        for (const index of indices) {
          people.push(
            await tx.nodes.Person.create(
              { name: `Name-${index}`, age: index },
              { id: requireDefined(ids[index]) },
            ),
          );
        }
        // Chain edges only among the nodes that survive (index >= 30), so the
        // delete targets below stay edge-free and don't trip the `knows`
        // restrict-on-delete policy. 99 edges still cross the edge chunk size.
        const created: string[] = [];
        for (let index = 30; index < people.length - 1; index += 1) {
          const edge = await tx.edges.knows.create(
            requireDefined(people[index]),
            requireDefined(people[index + 1]),
            { since: `link-${index}` },
          );
          created.push(edge.id);
        }
        return created;
      });
      const recordedAtCreate = await readRecordedClock(store);

      // Every node and edge — including those past the chunk boundary —
      // reconstructs at the create instant.
      const createdNodes = await store
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getByIds(nodeIds);
      expect(createdNodes.map((node) => node?.name)).toEqual(
        indices.map((index) => `Name-${index}`),
      );
      const createdEdges = await store
        .asOfRecorded(recordedAtCreate)
        .edges.knows.getByIds(edgeIds as unknown as readonly never[]);
      expect(createdEdges.every((edge) => edge?.since !== undefined)).toBe(
        true,
      );
      expect(createdEdges).toHaveLength(99);

      // A second transaction mixes update / soft-delete / hard-delete so one
      // batched flush must classify each operation independently.
      await store.transaction(async (tx) => {
        for (let index = 0; index < 10; index += 1) {
          await tx.nodes.Person.update(requireDefined(nodeIds[index]), {
            name: `Updated-${index}`,
          });
        }
        for (let index = 10; index < 20; index += 1) {
          await tx.nodes.Person.delete(requireDefined(nodeIds[index]));
        }
        for (let index = 20; index < 30; index += 1) {
          await tx.nodes.Person.hardDelete(requireDefined(nodeIds[index]));
        }
      });
      const recordedAtChange = await readRecordedClock(store);
      expect(recordedAtCreate < recordedAtChange).toBe(true);

      // History at the create instant is untouched by the later transaction.
      const historical = await store
        .asOfRecorded(recordedAtCreate)
        .nodes.Person.getByIds(nodeIds);
      expect(historical.map((node) => node?.name)).toEqual(
        indices.map((index) => `Name-${index}`),
      );

      // The change instant reflects updates and hides both delete kinds.
      const changed = await store
        .asOfRecorded(recordedAtChange)
        .nodes.Person.getByIds(nodeIds);
      expect(changed[0]?.name).toBe("Updated-0");
      expect(changed[9]?.name).toBe("Updated-9");
      expect(changed[10]).toBeUndefined(); // soft-deleted
      expect(changed[20]).toBeUndefined(); // hard-deleted
      expect(changed[30]?.name).toBe("Name-30"); // untouched

      // Soft delete leaves a tombstone; hard delete only closes the create row.
      const tombstone = await store
        .view({ mode: "includeTombstones" })
        .asOfRecorded(recordedAtChange)
        .nodes.Person.getById(requireDefined(nodeIds[10]));
      expect(tombstone?.name).toBe("Name-10");
      expect(await countRecordedNodeRows(store, requireDefined(ids[10]))).toBe(
        2,
      );
      expect(await countRecordedNodeRows(store, requireDefined(ids[20]))).toBe(
        1,
      );
    });

    it("recordedNow() anchors a recorded read deterministically", async () => {
      const store = await createHistoryStore(context);

      // Nothing captured yet.
      expect(await store.recordedNow()).toBeUndefined();

      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });
      const afterCreate = requireRecordedInstant(
        await store.recordedNow(),
        "expected recorded instant after create",
      );
      await store.nodes.Person.update(alice.id, { name: "Alicia" });
      const afterUpdate = requireRecordedInstant(
        await store.recordedNow(),
        "expected recorded instant after update",
      );

      expect(afterCreate < afterUpdate).toBe(true); // monotonic high-water

      // Each anchor reconstructs exactly the state committed up to it — no sleep
      // or wall-clock guessing.
      const atCreate = await store
        .asOfRecorded(afterCreate)
        .nodes.Person.getById(alice.id);
      const atUpdate = await store
        .asOfRecorded(afterUpdate)
        .nodes.Person.getById(alice.id);
      expect(atCreate?.name).toBe("Alice");
      expect(atUpdate?.name).toBe("Alicia");
    });
  });
}
