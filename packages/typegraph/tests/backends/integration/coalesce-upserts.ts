import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  asCompiledRowsSql,
  createStoreWithSchema,
  type EdgeId,
  type NodeId,
} from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

type CountRow = Readonly<{ cnt: number }>;

/**
 * Creates a fresh store on the shared backend with
 * `coalesceUnchangedUpserts` enabled, plus any extra options.
 */
async function createCoalesceStore(
  context: IntegrationTestContext,
  extra?: Readonly<{ history?: true; revisionTracking?: true }>,
): Promise<IntegrationStore> {
  const [store] = await createStoreWithSchema(
    integrationTestGraph,
    context.getStore().backend,
    { coalesceUnchangedUpserts: true, ...extra },
  );
  return store;
}

function personId(id: string): NodeId<typeof integrationTestGraph.nodes.Person.type> {
  return id as NodeId<typeof integrationTestGraph.nodes.Person.type>;
}

function knowsId(id: string): EdgeId<typeof integrationTestGraph.edges.knows.type> {
  return id as EdgeId<typeof integrationTestGraph.edges.knows.type>;
}

/**
 * Total recorded history rows (open and closed) captured for a node id — the
 * count the issue predicts grows by one per re-delivery on the write path and
 * stays flat when coalesced.
 */
async function countRecordedNodeRows(
  store: IntegrationStore,
  kind: string,
  id: string,
): Promise<number> {
  const table = createSqlSchema(store.backend.tableNames).recordedNodesTable;
  const rows = await store.backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS cnt
      FROM ${table}
      WHERE graph_id = ${store.graphId}
        AND kind = ${kind}
        AND id = ${id}
    `),
  );
  return Number(rows[0]?.cnt ?? 0);
}

export function registerCoalesceUpsertIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("coalesceUnchangedUpserts", () => {
    it("coalesces a value-identical upsert: no write, returns the existing node", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p1", {
        name: "Alice",
        age: 30,
      });
      expect(created.meta.version).toBe(1);

      const replayed = await store.nodes.Person.upsertById("p1", {
        name: "Alice",
        age: 30,
      });

      // No write happened: the returned node is the existing row, its version
      // and updatedAt unchanged.
      expect(replayed.meta.version).toBe(1);
      expect(replayed.meta.updatedAt).toBe(created.meta.updatedAt);
      expect(replayed.meta.validFrom).toBe(created.meta.validFrom);
    });

    it("coalesces regardless of prop key order (canonical comparison)", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p-order", {
        name: "Zoe",
        age: 20,
        email: "zoe@example.com",
      });

      const replayed = await store.nodes.Person.upsertByIdFromRecord("p-order", {
        email: "zoe@example.com",
        age: 20,
        name: "Zoe",
      });

      expect(replayed.meta.version).toBe(created.meta.version);
      expect(replayed.meta.updatedAt).toBe(created.meta.updatedAt);
    });

    it("writes when a prop changes", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p2", {
        name: "Bob",
        age: 40,
      });

      const changed = await store.nodes.Person.upsertById("p2", {
        name: "Bob",
        age: 41,
      });

      expect(changed.meta.version).toBe(created.meta.version + 1);
      const age = (changed as { age?: number }).age;
      expect(age).toBe(41);
    });

    it("resurrects a soft-deleted row rather than coalescing", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p3", {
        name: "Carol",
        age: 33,
      });
      await store.nodes.Person.delete(personId("p3"));

      // The upsert props equal the pre-delete stored props, but a soft-deleted
      // row must resurrect — a real write — never coalesce.
      const resurrected = await store.nodes.Person.upsertById("p3", {
        name: "Carol",
        age: 33,
      });

      expect(resurrected.meta.deletedAt).toBeUndefined();
      expect(resurrected.meta.version).toBeGreaterThan(created.meta.version);
      await expect(
        store.nodes.Person.getById(personId("p3")),
      ).resolves.toBeDefined();
    });

    it("writes when an explicit validFrom / validTo override is passed", async () => {
      const store = await createCoalesceStore(context);

      const created = await store.nodes.Person.upsertById("p4", {
        name: "Dana",
        age: 25,
      });

      const overridden = await store.nodes.Person.upsertById(
        "p4",
        { name: "Dana", age: 25 },
        { validFrom: "2020-01-01T00:00:00.000Z" },
      );

      expect(overridden.meta.version).toBe(created.meta.version + 1);
    });

    it("with the flag OFF, an identical re-upsert still writes (default behavior)", async () => {
      const store = context.getStore();

      const created = await store.nodes.Person.upsertById("p5", {
        name: "Erin",
        age: 50,
      });
      const replayed = await store.nodes.Person.upsertById("p5", {
        name: "Erin",
        age: 50,
      });

      expect(replayed.meta.version).toBe(created.meta.version + 1);
    });

    it("coalesces per-item in a mixed bulk batch, preserving input order", async () => {
      const store = await createCoalesceStore(context);

      await store.nodes.Person.upsertById("b-same", { name: "Same", age: 1 });
      await store.nodes.Person.upsertById("b-change", {
        name: "Change",
        age: 2,
      });

      const results = await store.nodes.Person.bulkUpsertById([
        { id: "b-same", props: { name: "Same", age: 1 } }, // coalesced
        { id: "b-change", props: { name: "Change", age: 3 } }, // written
        { id: "b-new", props: { name: "New", age: 4 } }, // created
      ]);

      expect(results).toHaveLength(3);
      expect(results[0]?.id).toBe("b-same");
      expect(results[0]?.meta.version).toBe(1); // untouched
      expect(results[1]?.id).toBe("b-change");
      expect(results[1]?.meta.version).toBe(2); // real update
      expect((results[1] as { age?: number }).age).toBe(3);
      expect(results[2]?.id).toBe("b-new");
      expect(results[2]?.meta.version).toBe(1); // created
    });

    it("coalesces edge bulkUpsertById symmetrically", async () => {
      const store = await createCoalesceStore(context);

      const [alice, bob] = await store.nodes.Person.bulkCreate([
        { props: { name: "Alice" }, id: "e-alice" },
        { props: { name: "Bob" }, id: "e-bob" },
      ]);
      if (alice === undefined || bob === undefined) {
        throw new Error("expected both people to be created");
      }

      await store.edges.knows.bulkUpsertById([
        { id: knowsId("edge-1"), from: alice, to: bob, props: { since: "2020" } },
      ]);

      const results = await store.edges.knows.bulkUpsertById([
        { id: knowsId("edge-1"), from: alice, to: bob, props: { since: "2020" } }, // coalesced
        { id: knowsId("edge-2"), from: bob, to: alice, props: { since: "2021" } }, // created
      ]);

      const first = await store.edges.knows.getById(knowsId("edge-1"));
      // The coalesced edge kept its original creation timestamp.
      expect(results[0]?.id).toBe("edge-1");
      expect(results[0]?.meta.updatedAt).toBe(first?.meta.updatedAt);
      expect(results[1]?.id).toBe("edge-2");
    });

    it("writes an edge when its props change", async () => {
      const store = await createCoalesceStore(context);
      const [alice, bob] = await store.nodes.Person.bulkCreate([
        { props: { name: "A" }, id: "ec-a" },
        { props: { name: "B" }, id: "ec-b" },
      ]);
      if (alice === undefined || bob === undefined) {
        throw new Error("expected both people");
      }

      await store.edges.knows.bulkUpsertById([
        { id: knowsId("ec-edge"), from: alice, to: bob, props: { since: "2020" } },
      ]);
      const before = await store.edges.knows.getById(knowsId("ec-edge"));

      await store.edges.knows.bulkUpsertById([
        { id: knowsId("ec-edge"), from: alice, to: bob, props: { since: "2099" } },
      ]);
      const after = await store.edges.knows.getById(knowsId("ec-edge"));

      expect((after as { since?: string }).since).toBe("2099");
      expect(after?.meta.updatedAt).not.toBe(before?.meta.updatedAt);
    });

    describe("with history capture", () => {
      it("creates no recorded row and does not advance recordedNow on a coalesced replay", async () => {
        const store = await createCoalesceStore(context, { history: true });

        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 60 });
        const afterFirst = await store.recordedNow();
        const rowsAfterFirst = await countRecordedNodeRows(store, "Person", "h1");
        expect(afterFirst).toBeDefined();

        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 60 });
        const afterReplay = await store.recordedNow();
        const rowsAfterReplay = await countRecordedNodeRows(
          store,
          "Person",
          "h1",
        );

        // No capture: the recorded clock and the row count are unchanged.
        expect(afterReplay).toBe(afterFirst);
        expect(rowsAfterReplay).toBe(rowsAfterFirst);

        // A real change resumes capture.
        await store.nodes.Person.upsertById("h1", { name: "Faye", age: 61 });
        const afterChange = await store.recordedNow();
        const rowsAfterChange = await countRecordedNodeRows(
          store,
          "Person",
          "h1",
        );
        expect(afterChange !== undefined && afterFirst !== undefined).toBe(true);
        expect(afterChange! > afterFirst!).toBe(true);
        expect(rowsAfterChange).toBeGreaterThan(rowsAfterReplay);
      });
    });

    describe("with revision tracking", () => {
      it("does not advance the revision anchor on a coalesced replay", async () => {
        const store = await createCoalesceStore(context, {
          revisionTracking: true,
        });

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 70 });
        const afterFirst = await store.revisionNow();

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 70 });
        const afterReplay = await store.revisionNow();
        expect(afterReplay).toBe(afterFirst);

        await store.nodes.Person.upsertById("r1", { name: "Gwen", age: 71 });
        const afterChange = await store.revisionNow();
        expect(afterChange).not.toBe(afterFirst);
      });
    });

    describe("transaction receipt shape (issue #256)", () => {
      it("first delivery captures; identical replay counts one write but records nothing", async () => {
        const store = await createCoalesceStore(context, { history: true });

        const first = await store.transactionWithReceipt(async (tx) =>
          tx.nodes.Person.upsertById("rcpt", { name: "Ivy", age: 80 }),
        );
        expect(first.receipt.writes.total).toBe(1);
        expect(first.receipt.recorded).toBeDefined();

        const replay = await store.transactionWithReceipt(async (tx) =>
          tx.nodes.Person.upsertById("rcpt", { name: "Ivy", age: 80 }),
        );
        // The write intent still completed (dropped-change detection intact),
        // but nothing was captured — the same two-signal shape as a no-op
        // delete, which at-least-once consumers already handle.
        expect(replay.receipt.writes.total).toBe(1);
        expect(replay.receipt.recorded).toBeUndefined();
      });
    });
  });
}
