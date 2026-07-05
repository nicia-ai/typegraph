import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  asCompiledRowsSql,
  createStoreWithSchema,
  type GraphBackend,
  type NodeId,
  type RecordedInstant,
} from "../../../src";
import { RECORDED_MAX } from "../../../src/core/temporal";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { toCanonicalIso } from "../../../src/store/recorded-capture";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type RecordedFromRow = Readonly<{ recorded_from: unknown }>;

type RecordedSqlStore = Readonly<{
  backend: GraphBackend;
  graphId: string;
}>;

function missingPersonId(
  id: string,
): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return id as NodeId<typeof integrationTestGraph.nodes.Person.type>;
}

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

async function createHistoryStore(
  context: IntegrationTestContext,
): Promise<IntegrationStore> {
  const [store] = await createStoreWithSchema(
    integrationTestGraph,
    context.getStore().backend,
    { history: true },
  );
  return store;
}

async function readOpenRecordedFrom(
  store: RecordedSqlStore,
  table: SQL,
  kind: string,
  id: string,
): Promise<string> {
  const rows = await store.backend.execute<RecordedFromRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_from
      FROM ${table}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${id}
        AND recorded_to = ${RECORDED_MAX}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No open recorded row for ${kind}:${id}`);
  }
  return toCanonicalIso(row.recorded_from);
}

async function readOpenRecordedNodeFrom(
  store: RecordedSqlStore,
  kind: string,
  id: string,
): Promise<string> {
  return readOpenRecordedFrom(
    store,
    createSqlSchema(store.backend.tableNames).recordedNodesTable,
    kind,
    id,
  );
}

async function readOpenRecordedEdgeFrom(
  store: RecordedSqlStore,
  kind: string,
  id: string,
): Promise<string> {
  return readOpenRecordedFrom(
    store,
    createSqlSchema(store.backend.tableNames).recordedEdgesTable,
    kind,
    id,
  );
}

export function registerTransactionReceiptIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("transaction receipts", () => {
    it("counts completed write intents by kind", async () => {
      const store = context.getStore();

      const outcome = await store.transaction(
        async (tx) => {
          const alice = await tx.nodes.Person.create({ name: "Alice" });
          const bob = await tx.nodes.Person.create({ name: "Bob" });
          await tx.nodes.Company.create({ name: "Acme" });
          await tx.nodes.Person.update(alice.id, { age: 31 });
          await tx.nodes.Person.delete(missingPersonId("absent-person"));
          await tx.nodes.Person.bulkCreate([
            { props: { name: "Carol" } },
            { props: { name: "Dana" } },
          ]);
          await tx.nodes.Person.bulkCreate([]);

          await tx.edges.knows.create(alice, bob, { since: "2020" });
          await tx.edges.knows.bulkCreate([
            { from: alice, to: bob, props: { since: "2021" } },
            { from: bob, to: alice, props: { since: "2022" } },
          ]);
          await tx.edges.knows.bulkCreate([]);

          return "done";
        },
        { receipt: true },
      );

      expect(outcome.result).toBe("done");
      expect(outcome.receipt.writes.nodes).toEqual({
        Person: 6,
        Company: 1,
      });
      expect(outcome.receipt.writes.edges).toEqual({ knows: 3 });
      expect(outcome.receipt.writes.total).toBe(10);
      expect(outcome.receipt.recorded).toBeUndefined();
    });

    it("counts getOrCreateByEndpoints on an existing edge as one intent", async () => {
      const store = context.getStore();
      const { alice, bob } = await store.transaction(async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        const bob = await tx.nodes.Person.create({ name: "Bob" });
        await tx.edges.knows.getOrCreateByEndpoints(alice, bob, {
          since: "2020",
        });
        return { alice, bob };
      });

      const outcome = await store.transaction(
        async (tx) =>
          tx.edges.knows.getOrCreateByEndpoints(alice, bob, { since: "2020" }),
        { receipt: true },
      );

      expect(outcome.result.action).toBe("found");
      expect(outcome.receipt.writes.nodes).toEqual({});
      expect(outcome.receipt.writes.edges).toEqual({ knows: 1 });
      expect(outcome.receipt.writes.total).toBe(1);
    });

    it("does not count a caught rejected write method", async () => {
      const store = context.getStore();

      const outcome = await store.transaction(
        async (tx) => {
          try {
            await tx.nodes.Person.update(missingPersonId("missing"), {
              name: "Missing",
            });
          } catch {
            // The rejected write intent contributes 0; the transaction continues.
          }
          await tx.nodes.Person.create({ name: "Committed" });
        },
        { receipt: true },
      );

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.edges).toEqual({});
      expect(outcome.receipt.writes.total).toBe(1);
    });

    it("rejects without an observable receipt when a write escapes uncaught", async () => {
      const store = context.getStore();

      await expect(
        store.transaction(
          async (tx) =>
            tx.nodes.Person.update(missingPersonId("missing"), {
              name: "Missing",
            }),
          { receipt: true },
        ),
      ).rejects.toThrow();
    });

    it("does not expose a receipt for rolled-back transactions", async () => {
      const store = context.getStore();

      await expect(
        store.transaction(
          async (tx) => {
            await tx.nodes.Person.create(
              { name: "Rollback" },
              { id: "rollback-person" },
            );
            throw new Error("rollback");
          },
          { receipt: true },
        ),
      ).rejects.toThrow("rollback");

      await expect(
        store.nodes.Person.getById(missingPersonId("rollback-person")),
      ).resolves.toBeUndefined();
    });

    it("returns the recorded anchor for a mixed node and edge transaction", async () => {
      const store = await createHistoryStore(context);

      const outcome = await store.transaction(
        async (tx) => {
          const alice = await tx.nodes.Person.create({ name: "Alice" });
          const bob = await tx.nodes.Person.create({ name: "Bob" });
          const edge = await tx.edges.knows.create(alice, bob, {
            since: "2020",
          });
          return { alice, edge };
        },
        { receipt: true },
      );

      const recorded = requireRecordedInstant(
        outcome.receipt.recorded,
        "expected a recorded receipt anchor",
      );
      await expect(
        readOpenRecordedNodeFrom(store, "Person", outcome.result.alice.id),
      ).resolves.toBe(recorded);
      await expect(
        readOpenRecordedEdgeFrom(store, "knows", outcome.result.edge.id),
      ).resolves.toBe(recorded);
    });

    it("returns the recorded anchor for an edge-only transaction", async () => {
      const store = await createHistoryStore(context);
      const { alice, bob } = await store.transaction(async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        const bob = await tx.nodes.Person.create({ name: "Bob" });
        return { alice, bob };
      });

      const outcome = await store.transaction(
        async (tx) => tx.edges.knows.create(alice, bob, { since: "2020" }),
        { receipt: true },
      );

      const recorded = requireRecordedInstant(
        outcome.receipt.recorded,
        "expected edge-only recorded receipt anchor",
      );
      expect(outcome.receipt.writes.nodes).toEqual({});
      expect(outcome.receipt.writes.edges).toEqual({ knows: 1 });
      await expect(
        readOpenRecordedEdgeFrom(store, "knows", outcome.result.id),
      ).resolves.toBe(recorded);
    });

    it("leaves recorded undefined without history and for read-only transactions", async () => {
      const historyStore = await createHistoryStore(context);
      const readOnlyOutcome = await historyStore.transaction(
        async (tx) => tx.nodes.Person.count(),
        { receipt: true },
      );
      expect(readOnlyOutcome.result).toBe(0);
      expect(readOnlyOutcome.receipt.writes.total).toBe(0);
      expect(readOnlyOutcome.receipt.recorded).toBeUndefined();

      const liveOutcome = await context
        .getStore()
        .transaction(async (tx) => tx.nodes.Person.create({ name: "Live" }), {
          receipt: true,
        });
      expect(liveOutcome.receipt.recorded).toBeUndefined();
    });

    it("returns strictly increasing recorded anchors for sequential write transactions", async () => {
      const store = await createHistoryStore(context);

      const first = await store.transaction(
        async (tx) => tx.nodes.Person.create({ name: "First" }),
        { receipt: true },
      );
      const second = await store.transaction(
        async (tx) => tx.nodes.Person.create({ name: "Second" }),
        { receipt: true },
      );

      const firstRecorded = requireRecordedInstant(
        first.receipt.recorded,
        "expected first recorded receipt anchor",
      );
      const secondRecorded = requireRecordedInstant(
        second.receipt.recorded,
        "expected second recorded receipt anchor",
      );
      expect(secondRecorded > firstRecorded).toBe(true);
    });
  });
}
