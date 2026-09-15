import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  type Store,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { applyMergePlanInTransaction } from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import {
  MergePlanCapabilityError,
  StaleMergePlanError,
} from "../../../src/graph-merge/errors";
import { applyMergePlan, planMerge } from "../../../src/graph-merge/merge";
import { constructMergePlanArtifact } from "../../../src/graph-merge/plan-wire";
import { isErr, isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId, type GraphBranch } from "../../../src/graph-merge/types";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const graph = defineGraph({
  id: "graph_merge_plan_integration",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

type TestStore = Store<typeof graph>;

async function makeBranch(
  context: IntegrationTestContext,
  base: TestStore,
  id: string,
): Promise<GraphBranch<typeof graph>> {
  return unwrap(
    await branch(base, () => context.createIsolatedBackend(), {
      id: asBranchId(id),
    }),
  );
}

export function registerGraphMergePlanIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph merge plan lifecycle", () => {
    it("preserves multi-source evidence through JSON and applies exactly once", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const left = await makeBranch(context, base, "left");
      const right = await makeBranch(context, base, "right");
      await left.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-left" },
      );
      await right.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada-right" },
      );

      const artifact = unwrap(
        await planMerge(base, [left, right], {
          resolve: {
            Person: {
              block: (node) => node.email,
              similarity: { kind: "fulltext", fields: ["name"] },
              threshold: 1,
            },
          },
        }),
      );
      const evidence = requireDefined(
        requireDefined(artifact.review.resolutions[0]).decisiveEdges[0],
      );
      expect(evidence.sources.map((source) => source.kind)).toEqual([
        "block",
        "unique",
      ]);

      // The lifecycle contract specifically requires a JSON serialization boundary.
      // eslint-disable-next-line unicorn/prefer-structured-clone
      const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
      const results = await Promise.all([
        applyMergePlan(base, parsed),
        applyMergePlan(base, parsed),
      ]);
      expect(results.filter((result) => isOk(result))).toHaveLength(1);
      expect(results.filter((result) => isErr(result))).toHaveLength(1);
      expect(
        await base.nodes.Person.getById(asNodeId("ada-left")),
      ).toBeDefined();
    });

    it("preflights every rehashed write before mutating the target", async () => {
      const base = await context.createStore(graph, { revisionTracking: true });
      const source = await makeBranch(context, base, "source");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(base, [source]));
      const { digest: _digest, ...input } = artifact;
      const malformed = await constructMergePlanArtifact({
        ...input,
        writes: {
          ...input.writes,
          edgeDeletes: [{ kind: "MissingEdgeKind", id: "missing" }],
        },
        proposed: {
          ...input.proposed,
          edges: { ...input.proposed.edges, deletions: 1 },
        },
      });

      expect(isErr(await applyMergePlan(base, malformed))).toBe(true);
      expect(await base.nodes.Person.getById(asNodeId("ada"))).toBeUndefined();
    });

    it("applies in a caller-owned transaction and records the merge at its receipt revision", async () => {
      const backend = context.getBackend();
      let nestedTransactions = 0;
      const guardedBackend = deriveBackend(backend, {
        transaction: (fn, options) => {
          nestedTransactions += 1;
          return backend.transaction(fn, options);
        },
      });
      const [target] = await createAdapterStoreWithSchema(
        graph,
        guardedBackend,
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-success");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      nestedTransactions = 0;

      const outcome = await backend.transactionWithNative(
        async (_txBackend, nativeTransaction) =>
          target.withRecordedTransaction(nativeTransaction, async (tx) =>
            applyMergePlanInTransaction(target, tx, artifact),
          ),
      );

      expect(outcome.receipt.writes.nodes).toEqual({ Person: 1 });
      expect(outcome.receipt.writes.total).toBe(1);
      expect(nestedTransactions).toBe(0);
      expect(outcome.receipt.recorded).toBeDefined();
      if (outcome.receipt.recorded === undefined)
        throw new Error(
          "Expected adopted merge to allocate a recorded revision.",
        );
      await expect(
        target
          .asOfRecorded(outcome.receipt.recorded)
          .nodes.Person.getById(asNodeId("ada")),
      ).resolves.toMatchObject({ name: "Ada" });
    });

    it("rolls back merge and caller writes with the caller-owned transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-rollback");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      const rollback = new Error("caller rollback");

      await expect(
        context
          .getBackend()
          .transactionWithNative(async (_txBackend, nativeTransaction) => {
            await target.withRecordedTransaction(
              nativeTransaction,
              async (tx) => {
                await applyMergePlanInTransaction(target, tx, artifact);
                await tx.nodes.Person.create(
                  { name: "Application", email: "app@example.test" },
                  { id: "application" },
                );
              },
            );
            throw rollback;
          }),
      ).rejects.toBe(rollback);

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(
        target.nodes.Person.getById(asNodeId("application")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a merge after a target graph write in the adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-pristine");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const outcome = await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await tx.nodes.Person.create(
                { name: "Application", email: "app@example.test" },
                { id: "application" },
              );
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toMatchObject({
                name: "MergePlanCapabilityError",
                details: { capability: "mergeTransactionPristine" },
              });
            },
          );
          expect(outcome.receipt.writes.total).toBe(1);
        });

      await expect(
        target.nodes.Person.getById(asNodeId("application")),
      ).resolves.toBeDefined();
      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses a stale plan inside an otherwise pristine adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-stale");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));
      await target.nodes.Person.create(
        { name: "Concurrent", email: "concurrent@example.test" },
        { id: "concurrent" },
      );

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(StaleMergePlanError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses a transaction context bound to a different target store", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const [otherTarget] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-owner");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await otherTarget.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(MergePlanCapabilityError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses persisted provenance before writing in an adopted transaction", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-provenance");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(
        await planMerge(target, [source], { persistProvenance: true }),
      );

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          await target.withRecordedTransaction(
            nativeTransaction,
            async (tx) => {
              await expect(
                applyMergePlanInTransaction(target, tx, artifact),
              ).rejects.toBeInstanceOf(MergePlanCapabilityError);
            },
          );
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a retained adopted context after capture has sealed it", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { history: true, revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-sealed");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const { result: applyAfterReturn } =
            await target.withRecordedTransaction(nativeTransaction, (tx) =>
              Promise.resolve(() =>
                applyMergePlanInTransaction(target, tx, artifact),
              ),
            );
          await expect(applyAfterReturn()).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
      await expect(target.recordedNow()).resolves.toBeUndefined();
    });

    it("refuses a retained non-history recorded transaction context", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(
        context,
        target,
        "adopted-non-history-retained",
      );
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const { result: applyAfterReturn } =
            await target.withRecordedTransaction(nativeTransaction, (tx) =>
              Promise.resolve(() =>
                applyMergePlanInTransaction(target, tx, artifact),
              ),
            );
          await expect(applyAfterReturn()).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("refuses an unscoped withTransaction context", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(context, target, "adopted-unscoped");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      await context
        .getBackend()
        .transactionWithNative(async (_txBackend, nativeTransaction) => {
          const tx = target.withTransaction(nativeTransaction);
          await expect(
            applyMergePlanInTransaction(target, tx, artifact),
          ).rejects.toMatchObject({
            name: "MergePlanCapabilityError",
            details: { capability: "mergeTransactionStore" },
          });
        });

      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeUndefined();
    });

    it("accepts an active store-managed transaction callback", async () => {
      const [target] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
        { revisionTracking: true },
      );
      const source = await makeBranch(context, target, "managed-active");
      await source.store.nodes.Person.create(
        { name: "Ada", email: "ada@example.test" },
        { id: "ada" },
      );
      const artifact = unwrap(await planMerge(target, [source]));

      const report = await target.transaction((tx) =>
        applyMergePlanInTransaction(target, tx, artifact),
      );

      expect(report.merged.nodes).toBe(1);
      await expect(
        target.nodes.Person.getById(asNodeId("ada")),
      ).resolves.toBeDefined();
    });
  });
}
