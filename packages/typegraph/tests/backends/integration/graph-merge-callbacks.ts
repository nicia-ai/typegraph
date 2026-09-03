import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  recordedInstantRevision,
  type Store,
  type TransactionContext,
} from "../../../src";
import {
  applyMergePlan,
  branch,
  InvalidMergeOptionsError,
  isErr,
  MergeConstraintConflictError,
  MergeError,
  type MergePlanReadContext,
  planMerge,
  StaleMergePlanError,
  unwrap,
} from "../../../src/graph-merge";
import type { IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const Workflow = defineNode("Workflow", {
  schema: z.object({ state: z.enum(["pending", "accepted"]) }),
});
const Acceptance = defineNode("Acceptance", {
  schema: z.object({ key: z.string() }),
});
const accepts = defineEdge("accepts", { schema: z.object({}) });
const graph = defineGraph({
  id: "merge_callbacks",
  nodes: {
    Item: { type: Item },
    Workflow: { type: Workflow },
    Acceptance: {
      type: Acceptance,
      unique: [
        {
          name: "acceptance_key",
          fields: ["key"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: { accepts: { type: accepts, from: [Acceptance], to: [Item] } },
  identity: { sameIdAcrossKinds: "ignore" },
});
const ITEM_ID = asNodeId<typeof Item>("candidate");
const WORKFLOW_ID = asNodeId<typeof Workflow>("workflow");
const ACCEPTANCE_ID = asNodeId<typeof Acceptance>("acceptance");
const ACCEPTS_ID = asEdgeId<typeof accepts>("accepts");
const WORKFLOW_REF = { kind: "Workflow", id: WORKFLOW_ID } as const;
const PEER_WORKFLOW_REF = {
  kind: "Workflow",
  id: asNodeId<typeof Workflow>("workflow-peer"),
} as const;
const VALID_TO = "2099-01-01T00:00:00.000Z";

async function preparePlan(
  context: IntegrationTestContext,
  target: Store<typeof graph>,
) {
  await target.nodes.Workflow.create({ state: "pending" }, { id: WORKFLOW_ID });
  await target.nodes.Workflow.create(
    { state: "pending" },
    { id: PEER_WORKFLOW_REF.id },
  );
  const source = unwrap(
    await branch(target, () => context.createIsolatedBackend()),
  );
  await source.store.nodes.Item.create(
    { name: "Candidate" },
    {
      id: ITEM_ID,
      // Explicit null preserves an open lower bound; omission selects the write time.
      // eslint-disable-next-line unicorn/no-null
      validFrom: null,
      validTo: VALID_TO,
    },
  );
  return unwrap(await planMerge(target, [source]));
}

async function recordAcceptance(
  tx: TransactionContext<typeof graph>,
): Promise<void> {
  const candidate = await tx.nodes.Item.getById(ITEM_ID);
  if (candidate === undefined) throw new Error("Plan writes are not visible");
  await tx.nodes.Workflow.update(WORKFLOW_ID, { state: "accepted" });
  const acceptance = await tx.nodes.Acceptance.create(
    { key: "accepted" },
    { id: ACCEPTANCE_ID },
  );
  await tx.edges.accepts.create(acceptance, candidate, {}, { id: ACCEPTS_ID });
  const identity = await tx.identity.assertSame(
    WORKFLOW_REF,
    PEER_WORKFLOW_REF,
  );
  expect(identity.action).toBe("created");
  expect(await tx.identity.areSame(WORKFLOW_REF, PEER_WORKFLOW_REF)).toBe(true);
}

async function expectUnapplied(target: Store<typeof graph>): Promise<void> {
  expect(await target.nodes.Item.getById(ITEM_ID)).toBeUndefined();
  expect(await target.nodes.Workflow.getById(WORKFLOW_ID)).toMatchObject({
    state: "pending",
  });
  expect(await target.nodes.Acceptance.count()).toBe(0);
  expect(await target.edges.accepts.count()).toBe(0);
  expect(await target.identity.assertionsOf(WORKFLOW_REF)).toEqual([]);
  expect(await target.identity.areSame(WORKFLOW_REF, PEER_WORKFLOW_REF)).toBe(
    false,
  );
}

export function registerGraphMergeCallbackIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("graph merge transactional callbacks", () => {
    it.each([false, true])(
      "commits typed workflow writes with the plan (history: %s)",
      async (history) => {
        const target =
          history ?
            await context.createHistoryStore(graph)
          : await context.createStore(graph, { revisionTracking: true });
        const plan = await preparePlan(context, target);
        const beforeRevision = await target.revisionNow();
        if (beforeRevision === undefined)
          throw new Error("Missing initial revision");
        const beforeApply = vi.fn(
          async (reads: MergePlanReadContext<typeof graph>) => {
            expect(await reads.nodes.Item.getById(ITEM_ID)).toBeUndefined();
            const workflow = await reads.nodes.Workflow.getById(WORKFLOW_ID);
            expect(workflow).toMatchObject({ state: "pending" });
            expect(await reads.edges.accepts.count()).toBe(0);
            if (workflow === undefined) throw new Error("Missing workflow");
            expect(await reads.identity.areSame(workflow, workflow)).toBe(true);
            expect(Object.keys(reads).toSorted()).toEqual([
              "edges",
              "identity",
              "nodes",
            ]);
            expect(Object.keys(reads.nodes.Item).toSorted()).toEqual([
              "bulkFindByConstraint",
              "bulkFindByIndex",
              "count",
              "find",
              "findByConstraint",
              "getById",
              "getByIds",
            ]);
            expect(Object.keys(reads.edges.accepts).toSorted()).toEqual([
              "bulkFindFrom",
              "bulkFindTo",
              "count",
              "find",
              "findByEndpoints",
              "findFrom",
              "findTo",
              "getById",
              "getByIds",
            ]);
            expect(Object.keys(reads.identity).toSorted()).toEqual([
              "areDifferent",
              "areSame",
              "assertionsOf",
              "membersOf",
              "nodesOf",
              "representativeOf",
            ]);
          },
        );
        const result = unwrap(
          await applyMergePlan(target, plan, {
            beforeApply,
            afterApply: async (tx, applied) => {
              expect(applied).toEqual({
                merged: {
                  nodes: 1,
                  edges: 0,
                  identity: { asserted: 0, retracted: 0 },
                },
              });
              expect(applied).not.toHaveProperty("provenance");
              await recordAcceptance(tx);
            },
          }),
        );
        expect(beforeApply).toHaveBeenCalledOnce();
        const afterRevision = await target.revisionNow();
        if (afterRevision === undefined)
          throw new Error("Missing committed revision");
        expect(recordedInstantRevision(afterRevision)).toBe(
          recordedInstantRevision(beforeRevision) + 1,
        );
        expect(result.merged).toEqual({
          nodes: 1,
          edges: 0,
          identity: { asserted: 0, retracted: 0 },
        });
        expect(await target.nodes.Item.getById(ITEM_ID)).toMatchObject({
          meta: { validFrom: undefined, validTo: VALID_TO },
        });
        expect(await target.nodes.Workflow.getById(WORKFLOW_ID)).toMatchObject({
          state: "accepted",
        });
        expect(
          await target.nodes.Acceptance.getById(ACCEPTANCE_ID),
        ).toBeDefined();
        expect(await target.edges.accepts.count()).toBe(1);
      },
    );

    it("records the candidate and callback writes at one revision", async () => {
      const target = await context.createHistoryStore(graph);
      const plan = await preparePlan(context, target);
      const before = await target.recordedNow();
      if (before === undefined)
        throw new Error("Missing initial history revision");
      unwrap(
        await applyMergePlan(target, plan, {
          afterApply: async (tx) => recordAcceptance(tx),
        }),
      );
      const after = await target.recordedNow();
      if (after === undefined)
        throw new Error("Missing merge history revision");
      expect(recordedInstantRevision(after)).toBe(
        recordedInstantRevision(before) + 1,
      );
      const beforeView = target.asOfRecorded(before);
      const afterView = target.asOfRecorded(after);
      expect(await beforeView.nodes.Item.getById(ITEM_ID)).toBeUndefined();
      expect(
        await beforeView.nodes.Acceptance.getById(ACCEPTANCE_ID),
      ).toBeUndefined();
      expect(
        await beforeView.nodes.Workflow.getById(WORKFLOW_ID),
      ).toMatchObject({ state: "pending" });
      expect(await afterView.nodes.Item.getById(ITEM_ID)).toMatchObject({
        meta: { validFrom: undefined, validTo: VALID_TO },
      });
      expect(await afterView.nodes.Workflow.getById(WORKFLOW_ID)).toMatchObject(
        { state: "accepted" },
      );
      expect(
        await afterView.nodes.Acceptance.getById(ACCEPTANCE_ID),
      ).toBeDefined();
      expect(await afterView.edges.accepts.getById(ACCEPTS_ID)).toBeDefined();
      expect(await beforeView.identity.assertionsOf(WORKFLOW_REF)).toEqual([]);
      expect(
        await beforeView.identity.areSame(WORKFLOW_REF, PEER_WORKFLOW_REF),
      ).toBe(false);
      expect(await afterView.identity.assertionsOf(WORKFLOW_REF)).toHaveLength(
        1,
      );
      expect(
        await afterView.identity.areSame(WORKFLOW_REF, PEER_WORKFLOW_REF),
      ).toBe(true);
    });

    it("aborts before plan writes when an invariant rejects", async () => {
      const target = await context.createHistoryStore(graph);
      const plan = await preparePlan(context, target);
      const before = await target.recordedNow();
      const failure = new Error("Application invariant failed");
      const afterApply = vi.fn(() =>
        Promise.reject(new Error("Callback must not run")),
      );
      const result = await applyMergePlan(target, plan, {
        beforeApply: async (reads) => {
          expect(await reads.nodes.Workflow.getById(WORKFLOW_ID)).toBeDefined();
          throw failure;
        },
        afterApply,
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected merge application to fail");
      expect(result.error.cause).toBe(failure);
      expect(afterApply).not.toHaveBeenCalled();
      await expectUnapplied(target);
      expect(await target.recordedNow()).toEqual(before);
      unwrap(await applyMergePlan(target, plan));
    });

    it("checks the revision fence before either callback", async () => {
      const target = await context.createHistoryStore(graph);
      const plan = await preparePlan(context, target);
      await target.nodes.Item.create({ name: "Intervening write" });
      const before = await target.recordedNow();
      const beforeApply = vi.fn(() =>
        Promise.reject(new Error("Callback must not run")),
      );
      const afterApply = vi.fn(async (tx: TransactionContext<typeof graph>) =>
        recordAcceptance(tx),
      );
      const result = await applyMergePlan(target, plan, {
        beforeApply,
        afterApply,
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected stale plan refusal");
      expect(result.error).toBeInstanceOf(StaleMergePlanError);
      expect(beforeApply).not.toHaveBeenCalled();
      expect(afterApply).not.toHaveBeenCalled();
      await expectUnapplied(target);
      expect(await target.recordedNow()).toEqual(before);
    });

    it("rolls back the complete aggregate and history after a post-apply rejection", async () => {
      const target = await context.createHistoryStore(graph);
      const plan = await preparePlan(context, target);
      const before = await target.recordedNow();
      const failure = new Error("Acceptance rejected");
      const result = await applyMergePlan(target, plan, {
        afterApply: async (tx) => {
          await recordAcceptance(tx);
          throw failure;
        },
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected merge application to fail");
      expect(result.error.cause).toBe(failure);
      await expectUnapplied(target);
      expect(await target.recordedNow()).toEqual(before);
      if (before === undefined)
        throw new Error("Missing initial history revision");
      expect(
        await target.asOfRecorded(before).identity.assertionsOf(WORKFLOW_REF),
      ).toEqual([]);
      // Reuse the exact artifact: rollback must restore the revision fence and assertion claim.
      unwrap(
        await applyMergePlan(target, plan, {
          afterApply: async (tx) => recordAcceptance(tx),
        }),
      );
    });

    it.each(["beforeApply", "afterApply"] as const)(
      "refuses an Err returned from %s by a JavaScript caller",
      async (callback) => {
        const target = await context.createHistoryStore(graph);
        const plan = await preparePlan(context, target);
        const before = await target.recordedNow();
        const rejected = {
          success: false,
          error: new MergeError("Application refusal"),
        } as const;
        // A computed property bypasses callback contextual typing, like an untyped JS caller.
        const result = await applyMergePlan(target, plan, {
          [callback]: async (tx: TransactionContext<typeof graph>) => {
            if (callback === "afterApply") await recordAcceptance(tx);
            return rejected;
          },
        });
        expect(isErr(result)).toBe(true);
        if (!isErr(result)) throw new Error("Expected returned result refusal");
        expect(result.error).toBeInstanceOf(InvalidMergeOptionsError);
        expect(result.error.cause).toBe(rejected);
        await expectUnapplied(target);
        expect(await target.recordedNow()).toEqual(before);
      },
    );

    it("preserves typed uniqueness enforcement for callback writes", async () => {
      const target = await context.createHistoryStore(graph);
      const plan = await preparePlan(context, target);
      const before = await target.recordedNow();
      const result = await applyMergePlan(target, plan, {
        afterApply: async (tx) => {
          await recordAcceptance(tx);
          await tx.nodes.Acceptance.create({ key: "accepted" });
        },
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected uniqueness refusal");
      expect(result.error).toBeInstanceOf(MergeConstraintConflictError);
      await expectUnapplied(target);
      expect(await target.recordedNow()).toEqual(before);
    });
  });
}
