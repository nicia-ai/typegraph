import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type EdgeId,
  type NodeId,
  type RecordedInstant,
  recordedInstantRevision,
  type TransactionReceipt,
  ValidationError,
} from "../../../src";
import { RECORDED_MAX_REVISION } from "../../../src/core/temporal";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql, type SqlFragment } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { STORE_RUNTIME } from "../../../src/store/runtime-port";
import { recordedRevisionFromDriver } from "../../test-utils";
import {
  type HistoryIntegrationStore,
  type IntegrationStore,
  integrationTestGraph,
} from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type RecordedFromRow = Readonly<{ recorded_from: unknown }>;

type RecordedSqlStore = HistoryIntegrationStore | IntegrationStore;

function missingPersonId(
  id: string,
): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return id as NodeId<typeof integrationTestGraph.nodes.Person.type>;
}

/**
 * Local graph for the full write-surface count test: a uniqueness constraint
 * (for the `getOrCreateByConstraint` variants) and `onDelete: "cascade"` (to
 * pin that cascade-removed edges do not appear in the receipt).
 */
const ReceiptEntity = defineNode("ReceiptEntity", {
  schema: z.object({ name: z.string(), slot: z.string() }),
});

const receiptLinks = defineEdge("receiptLinks", {
  schema: z.object({ label: z.string() }),
});

const receiptSurfaceGraph = defineGraph({
  id: "receipt_surface",
  nodes: {
    ReceiptEntity: {
      type: ReceiptEntity,
      onDelete: "cascade",
      unique: [
        {
          name: "entity_slot",
          fields: ["slot"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    receiptLinks: {
      type: receiptLinks,
      from: [ReceiptEntity],
      to: [ReceiptEntity],
      cardinality: "many",
    },
  },
});

function entityId(id: string): NodeId<typeof ReceiptEntity> {
  return id as NodeId<typeof ReceiptEntity>;
}

function linkId(id: string): EdgeId<typeof receiptLinks> {
  return id as EdgeId<typeof receiptLinks>;
}

function requireRecordedInstant(
  instant: RecordedInstant | undefined,
  message: string,
): RecordedInstant {
  expect(instant).toBeDefined();
  if (instant === undefined) throw new Error(message);
  return instant;
}

/** A promise plus its resolver, for holding a `measure` scope open. */
function createDeferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFunction) => {
    resolve = resolveFunction;
  });
  return { promise, resolve };
}

async function createHistoryStore(
  context: IntegrationTestContext,
): Promise<HistoryIntegrationStore> {
  return context.createHistoryStore(integrationTestGraph);
}

async function readOpenRecordedFrom(
  store: RecordedSqlStore,
  table: SqlFragment,
  kind: string,
  id: string,
): Promise<number> {
  const backend = store[STORE_RUNTIME].backend;
  const rows = await backend.execute<RecordedFromRow>(
    asCompiledRowsSql(sql`
      SELECT recorded_from
      FROM ${table}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${id}
        AND recorded_to = ${RECORDED_MAX_REVISION}
    `),
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No open recorded row for ${kind}:${id}`);
  }
  return recordedRevisionFromDriver(row.recorded_from);
}

async function readOpenRecordedNodeFrom(
  store: RecordedSqlStore,
  kind: string,
  id: string,
): Promise<number> {
  return readOpenRecordedFrom(
    store,
    createSqlSchema(store[STORE_RUNTIME].backend.tableNames).recordedNodesTable,
    kind,
    id,
  );
}

async function readOpenRecordedEdgeFrom(
  store: RecordedSqlStore,
  kind: string,
  id: string,
): Promise<number> {
  return readOpenRecordedFrom(
    store,
    createSqlSchema(store[STORE_RUNTIME].backend.tableNames).recordedEdgesTable,
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

      const outcome = await store.transactionWithReceipt(async (tx) => {
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
      });

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

      const outcome = await store.transactionWithReceipt(async (tx) =>
        tx.edges.knows.getOrCreateByEndpoints(alice, bob, { since: "2020" }),
      );

      expect(outcome.result.action).toBe("found");
      expect(outcome.receipt.writes.nodes).toEqual({});
      expect(outcome.receipt.writes.edges).toEqual({ knows: 1 });
      expect(outcome.receipt.writes.total).toBe(1);
    });

    it("counts every write method on the collection surface", async () => {
      const [store] = await createStoreWithSchema(
        receiptSurfaceGraph,
        context.getStore().backend,
      );

      const outcome = await store.transactionWithReceipt(async (tx) => {
        const nodes = tx.nodes.ReceiptEntity;
        const nodeA = await nodes.create({ name: "a", slot: "a" });
        const nodeB = await nodes.createFromRecord({ name: "b", slot: "b" });
        await nodes.update(nodeA.id, { name: "a2" });
        await nodes.upsertById("u1", { name: "u1", slot: "u1" });
        const nodeU2 = await nodes.upsertByIdFromRecord("u2", {
          name: "u2",
          slot: "u2",
        });
        const [nodeC, nodeD] = await nodes.bulkCreate([
          { props: { name: "c", slot: "c" } },
          { props: { name: "d", slot: "d" } },
        ]);
        if (nodeC === undefined || nodeD === undefined) {
          throw new Error("bulkCreate did not return the created nodes");
        }
        await nodes.bulkUpsertById([
          { id: "u1", props: { name: "u1b", slot: "u1" } },
          { id: "u3", props: { name: "u3", slot: "u3" } },
        ]);
        await nodes.bulkInsert([
          { props: { name: "n5", slot: "n5" }, id: "n5" },
          { props: { name: "n6", slot: "n6" }, id: "n6" },
        ]);
        await nodes.getOrCreateByConstraint("entity_slot", {
          name: "g",
          slot: "g",
        });
        // The one method whose bulk input is the SECOND argument.
        await nodes.bulkGetOrCreateByConstraint("entity_slot", [
          { props: { name: "h", slot: "h" } },
          { props: { name: "a-again", slot: "a" } },
        ]);
        await nodes.delete(nodeU2.id);
        await nodes.hardDelete(entityId("u3"));
        await nodes.bulkDelete([entityId("n5"), entityId("n6")]);

        const edges = tx.edges.receiptLinks;
        const edge1 = await edges.create(nodeA, nodeB, { label: "e1" });
        await edges.update(edge1.id, { label: "e1b" });
        await edges.getOrCreateByEndpoints(nodeA, nodeC, { label: "e2" });
        const [edge3, edge4] = await edges.bulkCreate([
          { from: nodeA, to: nodeD, props: { label: "e3" } },
          { from: nodeB, to: nodeC, props: { label: "e4" } },
        ]);
        if (edge3 === undefined || edge4 === undefined) {
          throw new Error("bulkCreate did not return the created edges");
        }
        await edges.bulkUpsertById([
          {
            id: linkId("be1"),
            from: nodeA,
            to: nodeB,
            props: { label: "be1" },
          },
          {
            id: linkId("be2"),
            from: nodeC,
            to: nodeD,
            props: { label: "be2" },
          },
        ]);
        await edges.bulkInsert([
          { from: nodeD, to: nodeA, props: { label: "e5" } },
          { from: nodeD, to: nodeB, props: { label: "e6" } },
        ]);
        await edges.bulkGetOrCreateByEndpoints([
          { from: nodeB, to: nodeD, props: { label: "e7" } },
          { from: nodeC, to: nodeA, props: { label: "e8" } },
        ]);
        await edges.delete(edge1.id);
        await edges.hardDelete(edge3.id);
        await edges.bulkDelete([edge4.id, linkId("be1")]);
      });

      // Node intents: create 1 + createFromRecord 1 + update 1 + upsertById 1
      // + upsertByIdFromRecord 1 + bulkCreate 2 + bulkUpsertById 2
      // + bulkInsert 2 + getOrCreateByConstraint 1
      // + bulkGetOrCreateByConstraint 2 + delete 1 + hardDelete 1
      // + bulkDelete 2 = 18.
      expect(outcome.receipt.writes.nodes).toEqual({ ReceiptEntity: 18 });
      // Edge intents: create 1 + update 1 + getOrCreateByEndpoints 1
      // + bulkCreate 2 + bulkUpsertById 2 + bulkInsert 2
      // + bulkGetOrCreateByEndpoints 2 + delete 1 + hardDelete 1
      // + bulkDelete 2 = 15.
      expect(outcome.receipt.writes.edges).toEqual({ receiptLinks: 15 });
      expect(outcome.receipt.writes.total).toBe(33);
    });

    it("does not count cascade-removed edges", async () => {
      const [store] = await createStoreWithSchema(
        receiptSurfaceGraph,
        context.getStore().backend,
      );
      const source = await store.transaction(async (tx) => {
        const source = await tx.nodes.ReceiptEntity.create({
          name: "src",
          slot: "cascade-src",
        });
        const target = await tx.nodes.ReceiptEntity.create({
          name: "dst",
          slot: "cascade-dst",
        });
        await tx.edges.receiptLinks.create(source, target, {
          label: "doomed",
        });
        return source;
      });

      const outcome = await store.transactionWithReceipt(async (tx) =>
        tx.nodes.ReceiptEntity.delete(source.id),
      );

      // The cascade removes the connected edge through the backend, not the
      // edge-collection surface — the receipt reports the node intent only.
      expect(outcome.receipt.writes.nodes).toEqual({ ReceiptEntity: 1 });
      expect(outcome.receipt.writes.edges).toEqual({});
      expect(outcome.receipt.writes.total).toBe(1);
      await expect(store.edges.receiptLinks.findFrom(source)).resolves.toEqual(
        [],
      );
    });

    it("counts writes made through tx.getNodeCollection", async () => {
      const store = context.getStore();

      const outcome = await store.transactionWithReceipt(async (tx) => {
        const people = tx.getNodeCollection("Person");
        if (people === undefined) {
          throw new Error("Person collection missing from transaction");
        }
        await people.createFromRecord({ name: "Dynamic" });
      });

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.total).toBe(1);
    });

    it("does not count a caught rejected write method", async () => {
      const store = context.getStore();

      const outcome = await store.transactionWithReceipt(async (tx) => {
        try {
          await tx.nodes.Person.update(missingPersonId("missing"), {
            name: "Missing",
          });
        } catch {
          // The rejected write intent contributes 0; the transaction continues.
        }
        await tx.nodes.Person.create({ name: "Committed" });
      });

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.edges).toEqual({});
      expect(outcome.receipt.writes.total).toBe(1);
    });

    it("rejects without an observable receipt when a write escapes uncaught", async () => {
      const store = context.getStore();

      await expect(
        store.transactionWithReceipt(async (tx) =>
          tx.nodes.Person.update(missingPersonId("missing"), {
            name: "Missing",
          }),
        ),
      ).rejects.toThrow();
    });

    it("does not expose a receipt for rolled-back transactions", async () => {
      const store = context.getStore();

      await expect(
        store.transactionWithReceipt(async (tx) => {
          await tx.nodes.Person.create(
            { name: "Rollback" },
            { id: "rollback-person" },
          );
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      await expect(
        store.nodes.Person.getById(missingPersonId("rollback-person")),
      ).resolves.toBeUndefined();
    });

    it("rethrows the callback's exact error instance and rolls back every write", async () => {
      const store = context.getStore();
      const before = await store.nodes.Person.count();
      const sentinel = new Error("explicit rollback sentinel");

      const rejection = await store
        .transactionWithReceipt(async (tx) => {
          await tx.nodes.Person.create(
            { name: "Doomed" },
            { id: "rollback-explicit" },
          );
          throw sentinel;
        })
        .then(
          () => {
            throw new Error("expected the throwing callback to reject");
          },
          (error: unknown) => error,
        );

      // The receipt path rethrows the ORIGINAL instance: it neither wraps the
      // error nor resolves with a (partial) receipt for a rolled-back
      // transaction. `.then(resolve → throw, reject → return)` also asserts the
      // call rejected rather than returning an outcome.
      expect(rejection).toBe(sentinel);

      // The in-flight write rolled back — nothing persisted, count unchanged.
      await expect(
        store.nodes.Person.getById(missingPersonId("rollback-explicit")),
      ).resolves.toBeUndefined();
      expect(await store.nodes.Person.count()).toBe(before);
    });

    it("rolls back on a data-integrity failure and rethrows it unchanged", async () => {
      const store = context.getStore();
      const before = await store.nodes.Person.count();

      let captured: unknown;
      const rejection = await store
        .transactionWithReceipt(async (tx) => {
          await tx.nodes.Person.create(
            { name: "First" },
            { id: "rollback-dup" },
          );
          // A second explicit-id collision is a data-integrity failure raised
          // INSIDE the write, not a synthetic `throw` in the callback body.
          try {
            await tx.nodes.Person.create(
              { name: "Second" },
              { id: "rollback-dup" },
            );
          } catch (error) {
            captured = error;
            throw error;
          }
        })
        .then(
          () => {
            throw new Error(
              "expected the duplicate id to reject the transaction",
            );
          },
          (error: unknown) => error,
        );

      expect(captured).toBeInstanceOf(ValidationError);
      // The data-integrity rejection surfaces unchanged (same instance) — the
      // receipt path does not re-wrap a backend/store write failure either.
      expect(rejection).toBe(captured);

      // Both the first (committed-in-tx) and the failing second write rolled
      // back, so the shared id never materializes and the count is unchanged.
      await expect(
        store.nodes.Person.getById(missingPersonId("rollback-dup")),
      ).resolves.toBeUndefined();
      expect(await store.nodes.Person.count()).toBe(before);
    });

    it("returns the recorded anchor for a mixed node and edge transaction", async () => {
      const store = await createHistoryStore(context);

      const outcome = await store.transactionWithReceipt(async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        const bob = await tx.nodes.Person.create({ name: "Bob" });
        const edge = await tx.edges.knows.create(alice, bob, {
          since: "2020",
        });
        return { alice, edge };
      });

      const recorded = requireRecordedInstant(
        outcome.receipt.recorded,
        "expected a recorded receipt anchor",
      );
      await expect(
        readOpenRecordedNodeFrom(store, "Person", outcome.result.alice.id),
      ).resolves.toBe(recordedInstantRevision(recorded));
      await expect(
        readOpenRecordedEdgeFrom(store, "knows", outcome.result.edge.id),
      ).resolves.toBe(recordedInstantRevision(recorded));
    });

    it("returns the recorded anchor for an edge-only transaction", async () => {
      const store = await createHistoryStore(context);
      const { alice, bob } = await store.transaction(async (tx) => {
        const alice = await tx.nodes.Person.create({ name: "Alice" });
        const bob = await tx.nodes.Person.create({ name: "Bob" });
        return { alice, bob };
      });

      const outcome = await store.transactionWithReceipt(async (tx) =>
        tx.edges.knows.create(alice, bob, { since: "2020" }),
      );

      const recorded = requireRecordedInstant(
        outcome.receipt.recorded,
        "expected edge-only recorded receipt anchor",
      );
      expect(outcome.receipt.writes.nodes).toEqual({});
      expect(outcome.receipt.writes.edges).toEqual({ knows: 1 });
      await expect(
        readOpenRecordedEdgeFrom(store, "knows", outcome.result.id),
      ).resolves.toBe(recordedInstantRevision(recorded));
    });

    it("leaves recorded undefined without history and for read-only transactions", async () => {
      const historyStore = await createHistoryStore(context);
      const readOnlyOutcome = await historyStore.transactionWithReceipt(
        async (tx) => tx.nodes.Person.count(),
      );
      expect(readOnlyOutcome.result).toBe(0);
      expect(readOnlyOutcome.receipt.writes.total).toBe(0);
      expect(readOnlyOutcome.receipt.recorded).toBeUndefined();

      const liveOutcome = await context
        .getStore()
        .transactionWithReceipt(async (tx) =>
          tx.nodes.Person.create({ name: "Live" }),
        );
      expect(liveOutcome.receipt.recorded).toBeUndefined();
    });

    it("returns strictly increasing recorded anchors for sequential write transactions", async () => {
      const store = await createHistoryStore(context);

      const first = await store.transactionWithReceipt(async (tx) =>
        tx.nodes.Person.create({ name: "First" }),
      );
      const second = await store.transactionWithReceipt(async (tx) =>
        tx.nodes.Person.create({ name: "Second" }),
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

    describe("scoped measurement (tx.measure)", () => {
      it("attributes writes by scoped context, counting them in the scope and the outer receipt", async () => {
        const store = context.getStore();

        const outcome = await store.transactionWithReceipt(async (tx) => {
          const projected = await tx.measure(async (scoped) => {
            await scoped.nodes.Person.create({ name: "Projected" });
          });
          // The surrounding bookkeeping write goes through the OUTER tx, so it
          // is not attributed to the scope.
          await tx.nodes.Company.create({ name: "Bookkeeping" });

          expect(projected.receipt.writes.nodes).toEqual({ Person: 1 });
          expect(projected.receipt.writes.total).toBe(1);
          // A measured sub-receipt never carries the recorded instant.
          expect(projected.receipt.recorded).toBeUndefined();
          return projected;
        });

        // The scoped write still counts in the outer receipt — it happened in
        // the transaction — alongside the bookkeeping write.
        expect(outcome.receipt.writes.nodes).toEqual({
          Person: 1,
          Company: 1,
        });
        expect(outcome.receipt.writes.total).toBe(2);
        expect(outcome.result.receipt.writes.total).toBe(1);
      });

      it("counts a write through the outer tx during a scope in the outer receipt only", async () => {
        const store = context.getStore();

        const outcome = await store.transactionWithReceipt(async (tx) => {
          const measured = await tx.measure(async (scoped) => {
            await scoped.nodes.Person.create({ name: "Scoped" });
            // Written through the OUTER tx while the scope is open: attribution
            // is by context, not by timing, so this must not enter the scope.
            await tx.nodes.Person.create({ name: "OuterDuringScope" });
          });
          expect(measured.receipt.writes.total).toBe(1);
          return measured;
        });

        expect(outcome.receipt.writes.total).toBe(2);
      });

      it("does not leak a concurrent write into an overlapping empty scope", async () => {
        const store = context.getStore();

        // An empty scope held open (awaiting a barrier) while a *sibling* scope
        // writes. A resolution-time model would leak the sibling's write into
        // this open scope; context attribution keeps it at zero. Only one scope
        // writes, so there is no concurrent write on the shared connection.
        const released = createDeferred();
        const outcome = await store.transactionWithReceipt(async (tx) => {
          const emptyScope = tx.measure(async () => {
            await released.promise;
          });
          const writer = await tx.measure(async (scoped) => {
            await scoped.nodes.Person.create({ name: "Writer" });
          });
          released.resolve();
          const empty = await emptyScope;

          expect(writer.receipt.writes.total).toBe(1);
          expect(empty.receipt.writes.total).toBe(0);
          return { writer, empty };
        });

        expect(outcome.receipt.writes.total).toBe(1);
      });

      it("chains a nested scope through its ancestor and the outer receipt", async () => {
        const store = context.getStore();

        let inner: TransactionReceipt | undefined;
        const outcome = await store.transactionWithReceipt(async (tx) => {
          return tx.measure(async (outerScope) => {
            await outerScope.nodes.Person.create({ name: "Outer-A" });
            const innerMeasured = await outerScope.measure(
              async (innerScope) => {
                await innerScope.nodes.Person.create({ name: "Inner-B" });
              },
            );
            inner = innerMeasured.receipt;
            await outerScope.nodes.Person.create({ name: "Outer-C" });
          });
        });

        // Inner scope counts only its own write; the enclosing scope counts all
        // three (the nested write chains up through its ancestor).
        expect(inner?.writes.total).toBe(1);
        expect(outcome.result.receipt.writes.total).toBe(3);
        expect(outcome.receipt.writes.total).toBe(3);
      });

      it("propagates a rejected measured callback while the outer receipt still counts its writes", async () => {
        const store = context.getStore();

        const outcome = await store.transactionWithReceipt(async (tx) => {
          await tx.nodes.Person.create({ name: "Before" });
          await expect(
            tx.measure(async (scoped) => {
              // Resolves through the scoped context (so it counts in the outer
              // receipt), then the scope throws.
              await scoped.nodes.Person.create({ name: "Measured" });
              throw new Error("projector failed");
            }),
          ).rejects.toThrow("projector failed");
          await tx.nodes.Person.create({ name: "After" });
        });

        // All three writes committed in the transaction, so all three count in
        // the outer receipt even though the measured scope rejected.
        expect(outcome.receipt.writes.nodes).toEqual({ Person: 3 });
        expect(outcome.receipt.writes.total).toBe(3);
      });

      it("attributes writes made through the scoped getNodeCollection", async () => {
        const store = context.getStore();

        const outcome = await store.transactionWithReceipt(async (tx) => {
          const measured = await tx.measure(async (scoped) => {
            // Dynamic-kind access must resolve against the scope-wrapped map, so
            // the write is attributed like `scoped.nodes.Person`.
            const people = scoped.getNodeCollection("Person");
            if (people === undefined) {
              throw new Error("Person collection missing from scoped context");
            }
            await people.createFromRecord({ name: "Dynamic" });
          });
          expect(measured.receipt.writes.nodes).toEqual({ Person: 1 });
          expect(measured.receipt.writes.total).toBe(1);
          return measured;
        });

        expect(outcome.receipt.writes.total).toBe(1);
      });

      it("counts bulk methods inside a scope by input length", async () => {
        const store = context.getStore();

        const outcome = await store.transactionWithReceipt(async (tx) =>
          tx.measure(async (scoped) => {
            await scoped.nodes.Person.bulkCreate([
              { props: { name: "a" } },
              { props: { name: "b" } },
              { props: { name: "c" } },
            ]);
            await scoped.nodes.Person.bulkCreate([]);
          }),
        );

        expect(outcome.result.receipt.writes.nodes).toEqual({ Person: 3 });
        expect(outcome.result.receipt.writes.total).toBe(3);
      });

      it("leaves a measured sub-receipt's recorded undefined on a history store", async () => {
        const store = await createHistoryStore(context);

        const outcome = await store.transactionWithReceipt(async (tx) => {
          const projected = await tx.measure(async (scoped) =>
            scoped.nodes.Person.create({ name: "Measured" }),
          );
          expect(projected.receipt.recorded).toBeUndefined();
          return projected;
        });

        // The outer transaction still allocates and surfaces the anchor.
        expect(outcome.receipt.recorded).toBeDefined();
      });
    });
  });
}
