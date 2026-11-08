import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type JsonValue,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import {
  applyMergePlanInTransaction,
  branch,
  captureStoreOperationTarget,
  getStoreOperation,
  operateStore,
  planMerge,
  type StoreOperationApply,
  type StoreOperationRequest,
  type StoreOperationTarget,
} from "../../../src/graph-merge";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "store_operation",
  nodes: {
    Item: {
      type: Item,
      unique: [
        { name: "name", fields: ["name"], scope: "kind", collation: "binary" },
      ],
    },
  },
  edges: {},
});
const commandSchema = z.object({ id: z.string(), name: z.string() }).strict();

function request(
  target: StoreOperationTarget,
  key = "key",
): StoreOperationRequest {
  return {
    target,
    idempotencyKey: key,
    metadata: { caller: "example", version: 1 },
    mutation: { id: "created", name: "created" },
  };
}
const applyCreate: StoreOperationApply<typeof graph> = async (tx, mutation) => {
  const command = commandSchema.parse(mutation);
  const node = await tx.nodes.Item.create(
    { name: command.name },
    { id: command.id },
  );
  return { id: node.id };
};

export function registerStoreOperationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("durable Store operations", () => {
    it("persists exact evidence and replays canonical requests through a fresh Store", async () => {
      const store = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(store));
      const applied = unwrap(await operateStore(store, input, applyCreate));
      expect(applied.outcome).toBe("applied");
      expect(applied.evidence.receipt.writes.nodes["Item"]).toBe(1);
      const recorded = requireDefined(applied.evidence.receipt.recorded);
      expect(
        await store
          .asOfRecorded(recorded)
          .nodes.Item.getById(asNodeId("created")),
      ).toMatchObject({ name: "created" });
      const [reopened] = await createStoreWithSchema(
        graph,
        deriveBackend(context.getBackend(), {}),
        { history: true },
      );
      const replayed = unwrap(
        await operateStore(
          reopened,
          {
            ...input,
            metadata: { version: 1, caller: "example" },
            mutation: { name: "created", id: "created" },
          },
          () => {
            throw new Error("replay invoked mutation");
          },
        ),
      );
      expect(replayed.outcome).toBe("replayed");
      expect(replayed.evidence).toEqual(applied.evidence);
      expect(unwrap(await getStoreOperation(reopened, input))).toEqual(
        applied.evidence,
      );
      expect(await store.recordedNow()).toBe(recorded);
    });

    it("refuses reuse of a caller key with changed mutation or metadata", async () => {
      const store = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(store));
      unwrap(await operateStore(store, input, applyCreate));
      for (const conflicting of [
        { ...input, metadata: { caller: "different" } },
        { ...input, mutation: { id: "other", name: "other" } },
      ]) {
        const result = await operateStore(store, conflicting, () => {
          throw new Error("conflict invoked mutation");
        });
        expect(result).toMatchObject({
          success: false,
          error: { name: "DurableOperationConflictError" },
        });
      }
      expect(await store.nodes.Item.getById(asNodeId("other"))).toBeUndefined();
    });

    it("serializes concurrent identical requests to one mutation", async () => {
      const store = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(store));
      let calls = 0;
      const apply: StoreOperationApply<typeof graph> = async (tx, mutation) => {
        calls += 1;
        return applyCreate(tx, mutation);
      };
      const outcomes = await Promise.all([
        operateStore(store, input, apply),
        operateStore(store, input, apply),
      ]);
      expect(
        outcomes.map((result) => unwrap(result).outcome).toSorted(),
      ).toEqual(["applied", "replayed"]);
      expect(calls).toBe(1);
    });

    it("recovers a committed operation after its response is lost", async () => {
      const backend = context.getBackend();
      let armed = false;
      const [store] = await createStoreWithSchema(
        graph,
        deriveBackend(backend, {
          async transaction(callback, options) {
            const result = await backend.transaction(callback, options);
            if (armed) {
              armed = false;
              throw new Error("lost commit response");
            }
            return result;
          },
        }),
        { history: true },
      );
      const input = request(await captureStoreOperationTarget(store));
      armed = true;
      expect(isErr(await operateStore(store, input, applyCreate))).toBe(true);
      const [reopened] = await createStoreWithSchema(
        graph,
        deriveBackend(backend, {}),
        { history: true },
      );
      const recovered = requireDefined(
        unwrap(await getStoreOperation(reopened, input)),
      );
      expect(recovered.result).toEqual({ id: "created" });
      const replayed = unwrap(
        await operateStore(reopened, input, () => {
          throw new Error("lost response caused duplicate apply");
        }),
      );
      expect(replayed.outcome).toBe("replayed");
      expect(replayed.evidence).toEqual(recovered);
      expect(await reopened.recordedNow()).toBe(recovered.receipt.recorded);
    });

    it("rolls back rows, uniqueness claims, and captured anchors when outcome persistence fails", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(
        graph,
        deriveBackend(backend, {
          transaction(callback, options) {
            return backend.transaction(
              (tx) =>
                callback(
                  deriveBackend(tx, {
                    executeStatement(query) {
                      const text = requireDefined(tx.compileSql)(query).sql;
                      if (
                        text.includes("store_operations") &&
                        text.trimStart().startsWith("INSERT")
                      )
                        throw new Error("evidence write failed");
                      return requireDefined(tx.executeStatement)(query);
                    },
                  }),
                ),
              options,
            );
          },
        }),
        { history: true },
      );
      const input = request(await captureStoreOperationTarget(store));
      const before = await store.recordedNow();
      expect(isErr(await operateStore(store, input, applyCreate))).toBe(true);
      expect(
        await store.nodes.Item.getById(asNodeId("created")),
      ).toBeUndefined();
      expect(await store.recordedNow()).toBe(before);
      const ordinary = await context.createHistoryStore(graph);
      expect(unwrap(await getStoreOperation(ordinary, input))).toBeUndefined();
      const reusable = await ordinary.nodes.Item.create(
        { name: "created" },
        { id: "claims-probe" },
      );
      await ordinary.nodes.Item.delete(reusable.id);
      expect(
        unwrap(await operateStore(ordinary, input, applyCreate)).outcome,
      ).toBe("applied");
    });

    it("retires old requests and evidence at clear instead of replaying into a new origin", async () => {
      const store = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(store));
      unwrap(await operateStore(store, input, applyCreate));
      await store.clear();
      for (const result of [
        await getStoreOperation(store, input),
        await operateStore(store, input, applyCreate),
      ]) {
        expect(result).toMatchObject({
          success: false,
          error: { details: { reason: "origin-mismatch" } },
        });
      }
      const replacement = request(await captureStoreOperationTarget(store));
      expect(replacement.target.origin).not.toBe(input.target.origin);
      expect(
        unwrap(await operateStore(store, replacement, applyCreate)).outcome,
      ).toBe("applied");
    });

    it("refuses undeclared support and invalid result serialization without partial mutation", async () => {
      const store = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(store));
      const backend = context.getBackend();
      const [unsupported] = await createStoreWithSchema(
        graph,
        deriveBackend(backend, {
          capabilities: {
            ...backend.capabilities,
            durableStoreOperations: false,
          },
        }),
        { history: true },
      );
      const refused = await operateStore(unsupported, input, () => {
        throw new Error("unsupported mutation ran");
      });
      expect(isErr(refused)).toBe(true);
      const invalid = await operateStore(store, input, async (tx, mutation) => {
        await applyCreate(tx, mutation);
        return new Date() as unknown as JsonValue;
      });
      expect(isErr(invalid)).toBe(true);
      expect(
        await store.nodes.Item.getById(asNodeId("created")),
      ).toBeUndefined();
      expect(unwrap(await getStoreOperation(store, input))).toBeUndefined();
    });

    it("refuses a transaction session without its own evidence writer before invoking the mutation", async () => {
      const backend = context.getBackend();
      const [store] = await createStoreWithSchema(
        graph,
        deriveBackend(backend, {
          transaction(callback, options) {
            return backend.transaction(
              (tx) => callback(projectBackendWithout(tx, ["executeStatement"])),
              options,
            );
          },
        }),
        { revisionTracking: true },
      );
      const input = request(await captureStoreOperationTarget(store));
      let invoked = false;
      const result = await operateStore(store, input, async (tx, mutation) => {
        invoked = true;
        return applyCreate(tx, mutation);
      });
      expect(result).toMatchObject({
        success: false,
        error: { name: "DurableOperationUnsupportedError" },
      });
      expect(invoked).toBe(false);
      expect(
        await store.nodes.Item.getById(asNodeId("created")),
      ).toBeUndefined();
      expect(unwrap(await getStoreOperation(store, input))).toBeUndefined();
    });

    it("records no-op and history-disabled outcomes without fabricating captured anchors", async () => {
      const history = await context.createHistoryStore(graph);
      const input = request(await captureStoreOperationTarget(history));
      const empty = unwrap(
        await operateStore(history, input, () =>
          Promise.resolve({ read: true }),
        ),
      );
      expect(empty.evidence.receipt.writes.total).toBe(0);
      expect(empty.evidence.receipt.recorded).toBeUndefined();
      expect(await history.recordedNow()).toBeUndefined();
      const live = await context.createStore(graph, { revisionTracking: true });
      const created = unwrap(
        await operateStore(
          live,
          request(await captureStoreOperationTarget(live), "live"),
          applyCreate,
        ),
      );
      expect(created.evidence.receipt.writes.nodes["Item"]).toBe(1);
      expect(created.evidence.receipt.recorded).toBeUndefined();
    });

    it("replays an approved merge before its now-stale revision fence", async () => {
      const store = await context.createHistoryStore(graph);
      const source = unwrap(
        await branch(store, () => context.createIsolatedBackend()),
      );
      try {
        await source.store.nodes.Item.create(
          { name: "created" },
          { id: "created" },
        );
        const plan = unwrap(await planMerge(store, [source]));
        const input: StoreOperationRequest = {
          target: await captureStoreOperationTarget(store),
          idempotencyKey: "merge",
          metadata: {},
          mutation: plan as unknown as JsonValue,
        };
        const applied = unwrap(
          await operateStore(store, input, async (tx) => {
            const report = await applyMergePlanInTransaction(store, tx, plan);
            return { merged: report.merged };
          }),
        );
        await store.nodes.Item.create({ name: "later" });
        const replayed = unwrap(
          await operateStore(store, input, () => {
            throw new Error("stale merge was reapplied");
          }),
        );
        expect(replayed.outcome).toBe("replayed");
        expect(replayed.evidence.receipt).toEqual(applied.evidence.receipt);
      } finally {
        await source.close();
      }
    });
  });
}
