/**
 * Cross-backend integration tests for recorded-time history capture (F1a).
 *
 * Runs against every backend via `createIntegrationTestSuite`. History is a
 * store-creation opt-in, so each test builds its own history-enabled store
 * over the shared (fresh-per-test) backend.
 */
import { describe, expect, it } from "vitest";

import { createStore } from "../../../src";
import { importGraph } from "../../../src/interchange";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

// A fresh history-enabled store over the per-test backend. Capture is a
// backend-level flag the store opt-in flips, so reusing the backend is
// correct and isolated (the outer beforeEach hands out a new backend).
function historyStore(
  context: IntegrationTestContext,
): ReturnType<typeof createStore<typeof integrationTestGraph>> {
  return createStore(integrationTestGraph, context.getStore().backend, {
    history: true,
  });
}

export function registerHistoryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recorded-time history (F1a)", () => {
    it("creates write no history rows", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      await store.edges.worksAt.create(alice, acme, { role: "Engineer" });

      expect(await store.nodes.Person.history(alice.id)).toEqual([]);
      expect(await store.nodes.Company.history(acme.id)).toEqual([]);
    });

    it("records exactly one history row per node update with the pre-image", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 30 });

      await store.nodes.Person.update(alice.id, { age: 31 });

      const history = await store.nodes.Person.history(alice.id);
      expect(history).toHaveLength(1);
      const [entry] = history;
      expect(entry?.op).toBe("update");
      // The captured image is the PRE-update version.
      expect(entry?.image.age).toBe(30);
      expect(entry?.image.name).toBe("Alice");
      expect(entry?.image.meta.version).toBe(1);
      expect(typeof entry?.recordedFrom).toBe("string");
      expect(typeof entry?.recordedTo).toBe("string");
      expect(typeof entry?.txId).toBe("string");
      expect(entry?.schemaVersion).toBeGreaterThanOrEqual(1);
      expect(entry?.meta).toBeUndefined();
    });

    it("orders history newest-first across multiple updates", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });
      await store.nodes.Person.update(alice.id, { age: 2 });
      await store.nodes.Person.update(alice.id, { age: 3 });
      await store.nodes.Person.update(alice.id, { age: 4 });

      const history = await store.nodes.Person.history(alice.id);
      expect(history).toHaveLength(3);
      // Newest transition first; captured ages descend 3, 2, 1.
      expect(history.map((entry) => entry.image.age)).toEqual([3, 2, 1]);
      expect(history.every((entry) => entry.op === "update")).toBe(true);
      // recorded_to is non-increasing (newest first).
      for (let index = 1; index < history.length; index += 1) {
        expect(
          history[index - 1]!.recordedTo >= history[index]!.recordedTo,
        ).toBe(true);
      }
    });

    it("captures soft delete with op `delete`", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      await store.nodes.Person.delete(alice.id);

      const history = await store.nodes.Person.history(alice.id);
      expect(history).toHaveLength(1);
      expect(history[0]?.op).toBe("delete");
      // Pre-delete image is live (deleted_at undefined).
      expect(history[0]?.image.meta.deletedAt).toBeUndefined();
    });

    it("captures upsert-revive as op `restore`", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 30,
      });
      await store.nodes.Person.delete(alice.id);
      // Upsert onto the tombstoned id resurrects it (clearDeleted) → restore.
      await store.nodes.Person.upsertById(alice.id, { name: "Alice", age: 40 });

      const history = await store.nodes.Person.history(alice.id);
      const ops = history.map((entry) => entry.op);
      expect(ops).toContain("delete");
      expect(ops).toContain("restore");
      // The restore captured the tombstoned pre-image.
      const restore = history.find((entry) => entry.op === "restore");
      expect(restore?.image.meta.deletedAt).toBeDefined();
    });

    it("captures edge update and delete", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const acme = await store.nodes.Company.create({ name: "Acme" });
      const edge = await store.edges.worksAt.create(alice, acme, {
        role: "Engineer",
        salary: 100,
      });

      await store.edges.worksAt.update(edge.id, { salary: 200 });
      await store.edges.worksAt.delete(edge.id);

      const history = await store.edges.worksAt.history(edge.id);
      expect(history).toHaveLength(2);
      expect(history.map((entry) => entry.op)).toEqual(["delete", "update"]);
      // Newest first: delete captured salary 200; update captured 100.
      expect(history[0]?.image.salary).toBe(200);
      expect(history[1]?.image.salary).toBe(100);
    });

    it("hard delete preserves prior history and captures the final image", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });
      await store.nodes.Person.update(alice.id, { age: 2 });
      await store.nodes.Person.hardDelete(alice.id);

      // Current row is gone, but history survives — including the final image.
      expect(await store.nodes.Person.getById(alice.id)).toBeUndefined();
      const history = await store.nodes.Person.history(alice.id);
      const ops = history.map((entry) => entry.op);
      expect(ops).toContain("update");
      expect(ops).toContain("hardDelete");
      const hardDelete = history.find((entry) => entry.op === "hardDelete");
      expect(hardDelete?.image.age).toBe(2);
    });

    it("captures cascaded edges on hard delete with op `hardDelete`", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const edge = await store.edges.knows.create(alice, bob, {
        since: "2020",
      });

      // Person.onDelete defaults to restrict; remove the edge first via the
      // edge cascade by hard-deleting an endpoint after disconnecting.
      await store.edges.knows.delete(edge.id);
      await store.nodes.Person.hardDelete(alice.id);

      const edgeHistory = await store.edges.knows.history(edge.id);
      // The soft delete recorded `delete`; the cascade hard-delete recorded
      // `hardDelete` for the (tombstoned) edge.
      const ops = edgeHistory.map((entry) => entry.op);
      expect(ops).toContain("delete");
      expect(ops).toContain("hardDelete");
    });

    it("groups a transaction's captures under one tx_id and stamps meta", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 1 });

      await store.transaction(
        async (tx) => {
          await tx.nodes.Person.update(alice.id, { age: 2 });
          await tx.nodes.Person.update(bob.id, { age: 2 });
        },
        { meta: { actor: "tester", reason: "bump" } },
      );

      const aliceHistory = await store.nodes.Person.history(alice.id);
      const bobHistory = await store.nodes.Person.history(bob.id);
      expect(aliceHistory).toHaveLength(1);
      expect(bobHistory).toHaveLength(1);
      // Same transaction → same tx_id.
      expect(aliceHistory[0]?.txId).toBe(bobHistory[0]?.txId);
      // meta propagated to both captures.
      expect(aliceHistory[0]?.meta).toEqual({
        actor: "tester",
        reason: "bump",
      });
      expect(bobHistory[0]?.meta).toEqual({ actor: "tester", reason: "bump" });
    });

    it("writes no history when a transaction rolls back", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });

      await expect(
        store.transaction(async (tx) => {
          await tx.nodes.Person.update(alice.id, { age: 2 });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      // The mutation rolled back, so its history row must not exist.
      expect(await store.nodes.Person.history(alice.id)).toEqual([]);
      // And the current row is unchanged.
      const current = await store.nodes.Person.getById(alice.id);
      expect(current?.age).toBe(1);
    });

    it("captures updates made through the interchange import path", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });

      await importGraph(
        store,
        {
          formatVersion: "1.0",
          exportedAt: new Date(0).toISOString(),
          source: { type: "external" },
          nodes: [
            {
              kind: "Person",
              id: alice.id,
              properties: { name: "Alice", age: 99 },
            },
          ],
          edges: [],
        },
        {
          onConflict: "update",
          onUnknownProperty: "strip",
          validateReferences: false,
          batchSize: 100,
        },
      );

      const history = await store.nodes.Person.history(alice.id);
      expect(history).toHaveLength(1);
      expect(history[0]?.op).toBe("update");
      expect(history[0]?.image.age).toBe(1);
      const current = await store.nodes.Person.getById(alice.id);
      expect(current?.age).toBe(99);
    });

    it("prune drops only rows whose currency ended before the cutoff", async () => {
      const store = historyStore(context);
      const alice = await store.nodes.Person.create({ name: "Alice", age: 1 });
      await store.nodes.Person.update(alice.id, { age: 2 });
      await store.nodes.Person.update(alice.id, { age: 3 });

      const before = await store.nodes.Person.history(alice.id);
      expect(before.length).toBeGreaterThanOrEqual(2);

      // Cutoff at the newest recorded_to: rows strictly before it are dropped,
      // rows at/after it survive.
      const cutoff = before[0]!.recordedTo;
      await store.history.prune({ before: cutoff });

      const after = await store.nodes.Person.history(alice.id);
      expect(after.every((entry) => entry.recordedTo >= cutoff)).toBe(true);

      // A far-future cutoff drops everything.
      await store.history.prune({ before: "9999-12-31T23:59:59.999Z" });
      expect(await store.nodes.Person.history(alice.id)).toEqual([]);
    });

    it("declares the history capability", () => {
      const backend = context.getStore().backend;
      expect(backend.capabilities.history).toBe(
        backend.capabilities.transactions ? "atomic" : "best-effort",
      );
    });
  });
}
