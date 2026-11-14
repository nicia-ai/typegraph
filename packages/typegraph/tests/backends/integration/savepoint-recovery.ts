/**
 * A refusal TypeGraph recovers through a savepoint leaves the enclosing
 * transaction committable.
 *
 * Some writes can only learn that they lost from the database itself: a fused
 * write program whose deliberate aborting statement reports a lost unique key,
 * or an imported edge whose durable match identity is arbitrated by a unique
 * index. On PostgreSQL that failed statement aborts the transaction, so
 * TypeGraph isolates it behind a savepoint, rolls back to it, and raises the
 * typed refusal. The transaction must then commit everything written outside
 * the savepoint, on every driver — including drivers that track the first
 * failed statement of a transaction and rethrow it at commit unless it was
 * issued inside one of their own savepoint scopes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  UniquenessError,
} from "../../../src";
import { statementExecutionVerdict } from "../../../src/backend/capabilities/resolve";
import {
  deriveBackend,
  projectBackendWithout,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend } from "../../../src/backend/types";
import { type GraphData, importGraph } from "../../../src/interchange";
import { runRecordedTransactionSavepoint } from "../../../src/store/recorded-capture";
import { transactionBackend } from "../../../src/store/runtime-port";
import { type IntegrationTestContext } from "./test-context";

const SavepointStamp = defineNode("SavepointStamp", {
  schema: z.object({ label: z.string() }),
});
/** Unconstrained, so writing one asserts transaction health only. */
const SavepointNote = defineNode("SavepointNote", {
  schema: z.object({ body: z.string() }),
});

const stampGraph = defineGraph({
  id: "savepoint_recovery_stamps",
  nodes: {
    SavepointStamp: {
      type: SavepointStamp,
      unique: [
        {
          name: "savepoint_stamp_label",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    SavepointNote: { type: SavepointNote },
  },
  edges: {},
});

const SavepointPerson = defineNode("SavepointPerson", {
  schema: z.object({ name: z.string() }),
});
const savepointKnows = defineEdge("savepointKnows", {
  schema: z.object({ label: z.string() }),
});

const identityGraph = defineGraph({
  id: "savepoint_recovery_edge_identity",
  nodes: { SavepointPerson: { type: SavepointPerson } },
  edges: {
    savepointKnows: {
      type: savepointKnows,
      from: [SavepointPerson],
      to: [SavepointPerson],
      matchIdentity: { name: "savepoint-knows-label", fields: ["label"] },
    },
  },
});

/**
 * Hides every application-side owner read of a durable edge identity, so the
 * database's unique index is what refuses a duplicate and the import has to
 * recover that failed statement through its per-row savepoint.
 */
function backendWithBlindEdgeIdentityProbes(
  backend: GraphBackend,
): GraphBackend {
  return deriveBackend(
    projectBackendWithout(projectGraphBackend(backend), [
      "insertEdgesDurableBatchReturning",
    ]),
    {
      findEdgesByHeterogeneousEndpointSet: () => Promise.resolve([]),
      transaction: (run, options) =>
        backend.transaction(
          (target) =>
            run(
              deriveBackend(
                projectBackendWithout(target, [
                  "insertEdgesDurableBatchReturning",
                ]),
                {
                  findEdgesByHeterogeneousEndpointSet: () =>
                    Promise.resolve([]),
                },
              ),
            ),
          options,
        ),
    },
  );
}

function edgeIdentityDocument(edges: GraphData["edges"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: {
      type: "typegraph-export",
      graphId: identityGraph.id,
      schemaVersion: 1,
    },
    nodes: [],
    edges,
  };
}

function knowsEdge(id: string, label: string): GraphData["edges"][number] {
  return {
    kind: "savepointKnows",
    id,
    from: { kind: "SavepointPerson", id: "owner" },
    to: { kind: "SavepointPerson", id: "target" },
    properties: { label },
  };
}

export function registerSavepointRecoveryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a refusal recovered through a savepoint", () => {
    it.each(
      [false, true].flatMap((history) =>
        [false, true].map((priorWrite) => ({ history, priorWrite })),
      ),
    )(
      "restores session state while retaining earlier writes (history: $history, prior write: $priorWrite)",
      async ({ history, priorWrite }) => {
        const options = { revisionTracking: true };
        const store =
          history ?
            await context.createHistoryStore(stampGraph, options)
          : await context.createStore(stampGraph, options);
        const statements = statementExecutionVerdict(context.getBackend());
        if (!statements.supported)
          throw new Error("Fixture requires statement execution");
        const revision = await store.revisionNow();
        const { receipt } = await store.transactionWithReceipt(async (tx) => {
          if (priorWrite)
            await tx.nodes.SavepointNote.create({ body: "survivor" });
          await runRecordedTransactionSavepoint(
            transactionBackend(tx),
            statements,
            "test_outer_rollback",
            async () => {
              await tx.nodes.SavepointNote.create({ body: "rolled back" });
              await runRecordedTransactionSavepoint(
                transactionBackend(tx),
                statements,
                "test_inner_release",
                async () => {
                  await tx.nodes.SavepointNote.bulkCreate([
                    { props: { body: "also rolled back" } },
                  ]);
                  return { action: "release", value: undefined };
                },
              );
              return {
                action: "rollback",
                value: undefined,
                cause: new Error("refused"),
              };
            },
          );
        });
        expect(await store.nodes.SavepointNote.find()).toHaveLength(
          priorWrite ? 1 : 0,
        );
        expect(receipt.recorded === undefined).toBe(!history || !priorWrite);
        expect((await store.revisionNow()) === revision).toBe(!priorWrite);
      },
    );

    it("publishes adopted success hooks only after the enclosing savepoint releases", async () => {
      const backend = context.getBackend();
      const ended: string[] = [];
      const [store] = await createAdapterStoreWithSchema(stampGraph, backend, {
        hooks: {
          onOperationEnd: (operation) => {
            ended.push(operation.id);
          },
          onBulkOperationEnd: () => {
            ended.push("bulk");
          },
        },
      });
      const statements = statementExecutionVerdict(backend);
      if (!statements.supported)
        throw new Error("Fixture requires statement execution");
      await backend.transactionWithNative(async (_target, native) => {
        await store.withRecordedTransaction(native, async (tx) => {
          await tx.nodes.SavepointNote.create(
            { body: "before" },
            { id: "before" },
          );
          expect(ended).toEqual(["before"]);
          await runRecordedTransactionSavepoint(
            transactionBackend(tx),
            statements,
            "test_hooks_outer",
            async () => {
              await tx.nodes.SavepointNote.create(
                { body: "released" },
                { id: "released" },
              );
              await runRecordedTransactionSavepoint(
                transactionBackend(tx),
                statements,
                "test_hooks_inner",
                async () => {
                  await tx.nodes.SavepointNote.updateWhere({
                    all: true,
                    patch: { body: "rolled back" },
                  });
                  return {
                    action: "rollback",
                    value: undefined,
                    cause: new Error("refused"),
                  };
                },
              );
              await tx.nodes.SavepointNote.updateWhere({
                all: true,
                patch: { body: "released bulk" },
              });
              expect(ended).toEqual(["before"]);
              return { action: "release", value: undefined };
            },
          );
          expect(ended).toEqual(["before", "released", "bulk"]);
          await tx.nodes.SavepointNote.create(
            { body: "after" },
            { id: "after" },
          );
          expect(ended).toEqual(["before", "released", "bulk", "after"]);
        });
      });
      expect(await store.nodes.SavepointNote.find()).toHaveLength(3);
    });

    it("lets a caller transaction commit after bulkReplaceById loses a unique key", async () => {
      const store = await context.createStore(stampGraph);
      const first = await store.nodes.SavepointStamp.create({ label: "one" });
      const second = await store.nodes.SavepointStamp.create({ label: "two" });
      await store.nodes.SavepointStamp.create({ label: "taken" });

      await store.transaction(async (tx) => {
        await tx.nodes.SavepointNote.create(
          { body: "written before the refusal" },
          { id: "savepoint-note-before" },
        );
        await expect(
          tx.nodes.SavepointStamp.bulkReplaceById([
            { id: second.id, props: { label: "taken" } },
            { id: first.id, props: { label: "renamed" } },
          ]),
        ).rejects.toThrow(UniquenessError);
        await tx.nodes.SavepointNote.create(
          { body: "written after the refusal" },
          { id: "savepoint-note-after" },
        );
      });

      const notes = await store.nodes.SavepointNote.find();
      expect(notes.map((note) => note.body).toSorted()).toEqual([
        "written after the refusal",
        "written before the refusal",
      ]);
      const stamps = await store.nodes.SavepointStamp.find();
      expect(stamps.map((stamp) => stamp.label).toSorted()).toEqual([
        "one",
        "taken",
        "two",
      ]);
    });

    it("commits a history-capturing import whose deferred edge row loses its durable identity", async () => {
      const [setupStore] = await createStoreWithSchema(
        identityGraph,
        context.getBackend(),
      );
      const owner = await setupStore.nodes.SavepointPerson.create(
        { name: "Owner" },
        { id: "owner" },
      );
      const target = await setupStore.nodes.SavepointPerson.create(
        { name: "Target" },
        { id: "target" },
      );
      await setupStore.edges.savepointKnows.create(owner, target, {
        label: "taken",
      });

      const [historyStore] = await createStoreWithSchema(
        identityGraph,
        backendWithBlindEdgeIdentityProbes(context.getBackend()),
        { history: true },
      );
      // Two rows sharing an id are deferred to the per-row path, where each
      // create runs inside its own savepoint. The first is refused for its
      // oversized identity key; the second reaches the database, whose unique
      // index refuses its already-owned label inside that savepoint.
      const result = await importGraph(
        historyStore,
        edgeIdentityDocument([
          knowsEdge("savepoint-unrelated", "other"),
          knowsEdge("savepoint-conflict", "x".repeat(3000)),
          knowsEdge("savepoint-conflict", "taken"),
        ]),
        { onConflict: "error", batchSize: 100, refreshStatistics: false },
      );

      expect(result.edges.created).toBe(1);
      expect(result.errors).toHaveLength(2);
      await expect(
        historyStore.edges.savepointKnows.getById(
          asEdgeId("savepoint-unrelated"),
        ),
      ).resolves.toMatchObject({ label: "other" });
      await expect(
        historyStore.edges.savepointKnows.getById(
          asEdgeId("savepoint-conflict"),
        ),
      ).resolves.toBeUndefined();
    });
  });
}
