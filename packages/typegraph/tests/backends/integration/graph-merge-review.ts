import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  type Store,
} from "../../../src";
import { defineGraphExtension } from "../../../src/graph-extension";
import {
  applyMergePlan,
  type CandidateWriteSet,
  CandidateWriteSetError,
  captureCandidateWriteSetTarget,
  ingestionBranch,
  type MergeOptions,
  planCandidateWriteSet,
  planCandidateWriteSetReview,
  planMergeIncremental,
  revalidateCandidateWriteSetReview,
  StaleMergePlanError,
} from "../../../src/graph-merge";
import { captureMergePlanTargetFence } from "../../../src/graph-merge/merge";
import { canonicalMergePlanJson } from "../../../src/graph-merge/plan-canonical";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { importGraph } from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", {
  schema: z.object({
    label: z.string(),
    status: z.enum(["proposed", "accepted", "rejected"]),
    group: z.string(),
  }),
});
const Artifact = defineNode("Artifact", {
  schema: z.object({ content: z.string() }),
});
const Decision = defineNode("Decision", {
  schema: z.object({ approved: z.boolean(), reviewDigest: z.string() }),
});
const evidence = defineEdge("evidence", {
  schema: z.object({ note: z.string() }),
});
const primary = defineEdge("primary", { schema: z.object({}) });
const limited = defineEdge("limited", { schema: z.object({}) });
const paired = defineEdge("paired", { schema: z.object({}) });
const graph = defineGraph({
  id: "durable_merge_review",
  identity: { sameIdAcrossKinds: "fold" },
  indexes: [defineNodeIndex(Item, { name: "item_group", fields: ["group"] })],
  nodes: {
    Item: { type: Item },
    Artifact: { type: Artifact },
    Decision: { type: Decision },
  },
  edges: {
    evidence: { type: evidence, from: [Item, Decision], to: [Artifact] },
    primary: {
      type: primary,
      from: [Item],
      to: [Artifact],
      cardinality: "one",
    },
  },
});
const boundedGraph = defineGraph({
  id: "bounded_candidate_review",
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {},
});
const boundedIdentityGraph = defineGraph({
  id: "bounded_identity_candidate_review",
  identity: { sameIdAcrossKinds: "fold" },
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {},
});
const boundedCardinalityGraph = defineGraph({
  id: "bounded_cardinality_candidate_review",
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {
    limited: {
      type: limited,
      from: [Item],
      to: [Artifact],
      cardinality: "one",
    },
    paired: {
      type: paired,
      from: [Item],
      to: [Artifact],
      cardinality: "unique",
    },
  },
});
const policy = {
  id: "review-policy-v1",
  context: { minimumApprovals: 1 },
} as const;
const validFrom = "2026-01-01T00:00:00.000Z";
type ReviewStore = Store<typeof graph>;

function itemProps(id: string) {
  return { label: id, status: "accepted" as const, group: id };
}

async function candidate(target: ReviewStore): Promise<CandidateWriteSet> {
  return {
    formatVersion: 1,
    sourceId: "review-source",
    target: await captureCandidateWriteSetTarget(target),
    nodes: [
      {
        kind: "Item",
        id: "candidate",
        properties: {
          label: "Reviewed item",
          status: "accepted",
          group: "reviewed",
        },
        validFrom,
      },
    ],
    edges: [],
  };
}

export function registerGraphMergeReviewIntegrationTests(
  context: IntegrationTestContext,
): void {
  function makeBackend() {
    return context.createIsolatedBackend();
  }
  async function setup() {
    const target = await context.createHistoryStore(graph);
    return { target, writeSet: await candidate(target), makeBackend, policy };
  }
  describe("durable merge review", () => {
    it("matches full-clone cardinality decisions for one and unique", async () => {
      for (const edgeKind of ["limited", "paired"] as const) {
        for (const peerState of ["occupied", "available", "deleted"] as const) {
          const prefix = `${edgeKind}-${peerState}`;
          const target = await context.createHistoryStore(
            boundedCardinalityGraph,
          );
          const source = await target.nodes.Item.create(
            itemProps(`${prefix}-source`),
            {
              id: `${prefix}-source`,
              validFrom,
            },
          );
          const otherSource = await target.nodes.Item.create(
            itemProps(`${prefix}-other-source`),
            { id: `${prefix}-other-source`, validFrom },
          );
          const existing = await target.nodes.Artifact.create(
            { content: "existing" },
            { id: `${prefix}-existing`, validFrom },
          );
          const proposed = await target.nodes.Artifact.create(
            { content: "proposed" },
            { id: `${prefix}-proposed`, validFrom },
          );
          const existingSource =
            edgeKind === "limited" && peerState === "available" ?
              otherSource
            : source;
          const existingTarget =
            edgeKind === "paired" && peerState === "occupied" ?
              proposed
            : existing;
          const peer = await target.edges[edgeKind].create(
            existingSource,
            existingTarget,
            {},
            {
              id: `${prefix}-existing-edge`,
              validFrom,
            },
          );
          if (peerState === "deleted") {
            if (edgeKind === "limited")
              await target.edges.limited.delete(
                asEdgeId<typeof limited>(peer.id),
              );
            else
              await target.edges.paired.delete(
                asEdgeId<typeof paired>(peer.id),
              );
          }
          const writeSet: CandidateWriteSet = {
            formatVersion: 1,
            sourceId: `cardinality-${edgeKind}-${peerState}`,
            target: await captureCandidateWriteSetTarget(target),
            nodes: [],
            edges: [
              {
                kind: edgeKind,
                id: `${prefix}-candidate-edge`,
                from: { kind: "Item", id: source.id },
                to: { kind: "Artifact", id: proposed.id },
                properties: {},
                validFrom,
              },
            ],
          };
          const full = unwrap(
            await ingestionBranch(target, makeBackend, {
              id: asBranchId(writeSet.sourceId),
            }),
          );
          try {
            const imported = await importGraph(
              full,
              {
                formatVersion: "2.0",
                exportedAt: "1970-01-01T00:00:00.000Z",
                source: { type: "external" },
                nodes: writeSet.nodes,
                edges: writeSet.edges,
              },
              {
                onConflict: "update",
                onUnknownProperty: "error",
                validateReferences: true,
                refreshStatistics: false,
              },
            );
            const bounded = await planCandidateWriteSet({
              target,
              writeSet,
              makeBackend,
            });
            const expectedJson =
              imported.success ?
                canonicalMergePlanJson(
                  unwrap(
                    await planMergeIncremental({
                      forkPoint: target,
                      target,
                      branches: [full],
                    }),
                  ),
                )
              : undefined;
            const actualJson =
              isErr(bounded) ? undefined : canonicalMergePlanJson(bounded.data);
            expect(actualJson).toBe(expectedJson);
          } finally {
            await full.close();
          }
        }
      }
    });
    it("matches full-clone planning for an identity class and unrelated ended assertion", async () => {
      const target = await context.createHistoryStore(boundedIdentityGraph);
      const first = await target.nodes.Item.create(itemProps("first"), {
        id: "first",
        validFrom,
      });
      const bridge = await target.nodes.Item.create(itemProps("bridge"), {
        id: "bridge",
        validFrom,
      });
      await target.nodes.Artifact.create(
        { content: "second" },
        { id: "second", validFrom },
      );
      const unrelatedA = await target.nodes.Item.create(
        itemProps("unrelated-a"),
        {
          id: "unrelated-a",
          validFrom,
        },
      );
      const unrelatedB = await target.nodes.Item.create(
        itemProps("unrelated-b"),
        {
          id: "unrelated-b",
          validFrom,
        },
      );
      await target.identity.assertSame(first, bridge);
      const ended = await target.identity.assertSame(unrelatedA, unrelatedB);
      await target.identity.retractAssertion(ended.assertion.id);
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "cross-backend-identity-candidate",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [],
        edges: [],
        identity: {
          profile: "typegraph-identity-v1",
          mode: "state",
          assertions: [
            {
              id: "candidate-same",
              relation: "same",
              a: { kind: "Artifact", id: "second" },
              b: { kind: "Item", id: "bridge" },
              validFrom,
            },
          ],
        },
      };
      const full = unwrap(
        await ingestionBranch(target, makeBackend, {
          id: asBranchId(writeSet.sourceId),
        }),
      );
      try {
        const imported = await importGraph(
          full,
          {
            formatVersion: "2.0",
            exportedAt: "1970-01-01T00:00:00.000Z",
            source: { type: "external" },
            nodes: writeSet.nodes,
            edges: writeSet.edges,
            identity: writeSet.identity,
          },
          {
            onConflict: "update",
            onUnknownProperty: "error",
            validateReferences: true,
            refreshStatistics: false,
          },
        );
        expect(imported.success).toBe(true);
        const expected = unwrap(
          await planMergeIncremental({
            forkPoint: target,
            target,
            branches: [full],
          }),
        );
        const actual = unwrap(
          await planCandidateWriteSet({ target, writeSet, makeBackend }),
        );
        expect(canonicalMergePlanJson(actual)).toBe(
          canonicalMergePlanJson(expected),
        );
      } finally {
        await full.close();
      }
    });
    it("keeps scoped review evidence stable across unrelated target growth", async () => {
      const target = await context.createHistoryStore(boundedGraph);
      const existing = await target.nodes.Item.create(
        { label: "Existing", status: "proposed", group: "one" },
        { id: "existing", validFrom },
      );
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "bounded-source",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "Item",
            id: "existing",
            properties: {
              label: "Updated",
              status: "accepted",
              group: "one",
            },
            validFrom,
          },
        ],
        edges: [],
      };
      const args = {
        target,
        writeSet,
        makeBackend,
        policy,
        reviewScope: "candidate" as const,
      };
      const review = unwrap(await planCandidateWriteSetReview(args));
      expect(review.formatVersion).toBe(2);
      expect(review.baseline.scope).toBe("referenced");
      expect(await target.nodes.Item.getById(existing.id)).toMatchObject({
        label: "Existing",
      });
      await target.nodes.Artifact.create(
        { content: JSON.stringify(review) },
        { id: "unrelated-review", validFrom },
      );
      expect(
        unwrap(await revalidateCandidateWriteSetReview({ ...args, review }))
          .status,
      ).toBe("compatible");
      await target.nodes.Item.update(existing.id, { label: "Changed" });
      expect(
        unwrap(await revalidateCandidateWriteSetReview({ ...args, review }))
          .status,
      ).toBe("changed");
    });
    it("persists immutable review and approval evidence in the target before applying the fresh plan", async () => {
      const args = await setup();
      const proposed = await args.target.nodes.Item.create(
        { label: "Reviewed item", status: "proposed", group: "reviewed" },
        { id: "candidate", validFrom },
      );
      const before = await captureMergePlanTargetFence(args.target);
      const review = unwrap(await planCandidateWriteSetReview(args));
      expect(await captureMergePlanTargetFence(args.target)).toEqual(before);
      expect(await args.target.nodes.Item.getById(proposed.id)).toMatchObject({
        status: "proposed",
      });
      const artifact = await args.target.nodes.Artifact.create(
        { content: JSON.stringify(review) },
        { id: review.digest.value, validFrom },
      );
      await args.target.edges.evidence.create(
        proposed,
        artifact,
        { note: "proposed change" },
        { validFrom },
      );
      const decision = await args.target.nodes.Decision.create(
        { approved: true, reviewDigest: review.digest.value },
        { validFrom },
      );
      await args.target.edges.evidence.create(
        decision,
        artifact,
        { note: "human approval" },
        { validFrom },
      );
      const persisted = requireDefined(
        await args.target.nodes.Artifact.getById(artifact.id),
      );
      const stale = await applyMergePlan(args.target, review.plan);
      expect(isErr(stale) && stale.error).toBeInstanceOf(StaleMergePlanError);
      const beforeRevalidation = await captureMergePlanTargetFence(args.target);
      const result = unwrap(
        await revalidateCandidateWriteSetReview({
          ...args,
          review: JSON.parse(persisted.content) as unknown,
        }),
      );
      expect(result.status).toBe("compatible");
      if (result.status !== "compatible")
        throw new Error("Expected compatible review");
      expect(result.reviewDigest).toEqual(review.digest);
      expect(result.plan.digest).not.toEqual(review.plan.digest);
      expect(result.plan.writes).toEqual(review.plan.writes);
      expect(result.plan.target).toEqual(beforeRevalidation);
      expect(await captureMergePlanTargetFence(args.target)).toEqual(
        beforeRevalidation,
      );
      unwrap(await applyMergePlan(args.target, result.plan));
      expect(await args.target.nodes.Item.getById(proposed.id)).toMatchObject({
        status: "accepted",
      });
      expect(await args.target.nodes.Artifact.getById(artifact.id)).toEqual(
        persisted,
      );
      expect(
        await args.target.nodes.Decision.getById(decision.id),
      ).toMatchObject({ approved: true, reviewDigest: review.digest.value });
      expect(await args.target.edges.evidence.count()).toBe(2);
    });

    it("requires reapproval when an original row changes even if both plans write the same accepted value", async () => {
      const args = await setup();
      const item = await args.target.nodes.Item.create(
        { label: "Reviewed item", status: "proposed", group: "reviewed" },
        { id: "candidate", validFrom },
      );
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.nodes.Item.update(item.id, { status: "rejected" });
      const fresh = unwrap(await planCandidateWriteSet(args));
      expect(fresh.writes).toEqual(review.plan.writes);
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "node", kind: "Item", id: "candidate" },
          },
        ],
      });
      expect(await args.target.nodes.Item.getById(item.id)).toMatchObject({
        status: "rejected",
      });
    });

    it("guards a candidate id that was absent when reviewed", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.nodes.Item.create(
        { label: "Reviewed item", status: "accepted", group: "reviewed" },
        { id: "candidate", validFrom },
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "node", kind: "Item", id: "candidate" },
          },
        ],
      });
    });

    it("requires reapproval when a same-id node joins an implicit identity class without ledger changes", async () => {
      const args = await setup();
      await args.target.nodes.Item.create(
        { label: "Reviewed item", status: "proposed", group: "reviewed" },
        { id: "candidate", validFrom },
      );
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.nodes.Artifact.create(
        { content: "same-id audit evidence" },
        { id: "candidate", validFrom },
      );
      const fresh = unwrap(await planCandidateWriteSetReview(args));
      expect(fresh.plan.writes).toEqual(review.plan.writes);
      expect(fresh.baseline.identityDigest).toBe(
        review.baseline.identityDigest,
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "node", kind: "Artifact", id: "candidate" },
          },
        ],
      });
      expect(
        await args.target.nodes.Item.getById(asNodeId("candidate")),
      ).toMatchObject({ status: "proposed" });
    });

    it("allows unrelated additions of the candidate kind when fresh planning preserves all evidence", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.nodes.Item.create(
        { label: "Audit item", status: "accepted", group: "audit" },
        { id: "audit", validFrom },
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result.status).toBe("compatible");
      if (result.status !== "compatible")
        throw new Error("Expected compatible review");
      expect(result.plan.writes).toEqual(review.plan.writes);
      unwrap(await applyMergePlan(args.target, result.plan));
      expect(await args.target.nodes.Item.count()).toBe(2);
    });

    it("does not exclude an audit addition from candidate resolution", async () => {
      const args = await setup();
      const options = {
        resolve: {
          Item: {
            blockIndex: "item_group",
            similarity: { kind: "custom", score: () => 1 },
            threshold: 1,
          },
        },
      } satisfies MergeOptions<typeof graph>;
      const review = unwrap(
        await planCandidateWriteSetReview({ ...args, options }),
      );
      await args.target.nodes.Item.create(
        { label: "Audit item", status: "accepted", group: "reviewed" },
        { id: "audit", validFrom },
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, options, review }),
      );
      expect(result.status).toBe("changed");
      if (result.status !== "changed")
        throw new Error("Expected changed review");
      expect(result.differences).toContainEqual({
        category: "plan",
        path: "plan.writes",
      });
      expect(result.differences).toContainEqual({
        category: "plan",
        path: "plan.review",
      });
      expect(result.plan?.writes).not.toEqual(review.plan.writes);
      expect(
        await args.target.nodes.Item.getById(asNodeId("candidate")),
      ).toBeUndefined();
    });

    it("detects identity ledger changes without requiring node property changes", async () => {
      const args = await setup();
      const first = await args.target.nodes.Item.create(
        { label: "First", status: "accepted", group: "audit" },
        { id: "first", validFrom },
      );
      const second = await args.target.nodes.Item.create(
        { label: "Second", status: "accepted", group: "audit" },
        { id: "second", validFrom },
      );
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.identity.assertDifferent(first, second, { validFrom });
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          { category: "baseline", path: "baseline.identityDigest" },
        ],
      });
      expect(await args.target.nodes.Item.getById(first.id)).toEqual(first);
      expect(await args.target.nodes.Item.getById(second.id)).toEqual(second);
    });

    it("detects changes to an original edge", async () => {
      const args = await setup();
      const item = await args.target.nodes.Item.create(
        { label: "Original", status: "accepted", group: "audit" },
        { id: "original", validFrom },
      );
      const artifact = await args.target.nodes.Artifact.create(
        { content: "original" },
        { id: "original-artifact", validFrom },
      );
      const edge = await args.target.edges.evidence.create(
        item,
        artifact,
        { note: "original" },
        { id: "original-edge", validFrom },
      );
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.edges.evidence.update(edge.id, { note: "revised" });
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "edge", kind: "evidence", id: "original-edge" },
          },
        ],
      });
    });

    it("includes original tombstones in the review baseline", async () => {
      const args = await setup();
      const item = await args.target.nodes.Item.create(
        { label: "Deleted", status: "rejected", group: "audit" },
        { id: "deleted", validFrom },
      );
      await args.target.nodes.Item.delete(item.id);
      const review = unwrap(await planCandidateWriteSetReview(args));
      const tombstone = requireDefined(
        review.baseline.rows.find(
          (row) =>
            row.role === "node" && row.kind === "Item" && row.id === "deleted",
        ),
      );
      expect(tombstone.digest).toMatch(/^[\da-f]{64}$/u);
      await args.target.nodes.Item.hardDelete(item.id);
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "node", kind: "Item", id: "deleted" },
          },
        ],
      });
    });

    it("refuses approval reuse after schema evolution", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.evolve(
        defineGraphExtension({
          nodes: { Annotation: { properties: { text: { type: "string" } } } },
        }),
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result).toEqual({
        status: "incompatible",
        reviewDigest: review.digest,
        differences: [{ category: "target", path: "target.schema" }],
      });
    });

    it("refuses a review from an independently initialized target", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      const [independent] = await createAdapterStoreWithSchema(
        graph,
        await context.createIsolatedBackend(),
        { history: true },
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({
          ...args,
          target: independent,
          review,
        }),
      );
      expect(result).toEqual({
        status: "incompatible",
        reviewDigest: review.digest,
        differences: [{ category: "target", path: "target.origin" }],
      });
    });

    it("requires explicit reapproval when policy context or merge options change", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      const changedPolicy = unwrap(
        await revalidateCandidateWriteSetReview({
          ...args,
          policy: { ...policy, context: { minimumApprovals: 2 } },
          review,
        }),
      );
      expect(changedPolicy).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [{ category: "policy", path: "policy.policy" }],
      });
      const changedOptions = unwrap(
        await revalidateCandidateWriteSetReview({
          ...args,
          options: { provenance: false },
          review,
        }),
      );
      expect(changedOptions).toEqual({
        status: "changed",
        reviewDigest: review.digest,
        differences: [{ category: "policy", path: "policy.options" }],
      });
      expect(await args.target.nodes.Item.count()).toBe(0);
    });

    it("rechecks cardinality after audit additions without partially writing the candidate", async () => {
      const args = await setup();
      const item = await args.target.nodes.Item.create(
        { label: "Reviewed item", status: "accepted", group: "reviewed" },
        { id: "candidate", validFrom },
      );
      const writeSet: CandidateWriteSet = {
        ...args.writeSet,
        nodes: [
          ...args.writeSet.nodes,
          {
            kind: "Artifact",
            id: "candidate-artifact",
            properties: { content: "reviewed attachment" },
            validFrom,
          },
        ],
        edges: [
          {
            kind: "primary",
            id: "candidate-primary",
            from: { kind: "Item", id: item.id },
            to: { kind: "Artifact", id: "candidate-artifact" },
            properties: {},
            validFrom,
          },
        ],
      };
      const review = unwrap(
        await planCandidateWriteSetReview({ ...args, writeSet }),
      );
      const audit = await args.target.nodes.Artifact.create(
        { content: "audit attachment" },
        { id: "audit-artifact", validFrom },
      );
      await args.target.edges.primary.create(
        item,
        audit,
        {},
        { id: "audit-primary", validFrom },
      );
      const beforeRevalidation = await captureMergePlanTargetFence(args.target);
      const result = await revalidateCandidateWriteSetReview({
        ...args,
        review,
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected cardinality refusal");
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
      expect(result.error.details).toEqual({
        errors: [
          {
            entityType: "edge",
            kind: "primary",
            id: "candidate-primary",
            error:
              'Cardinality violation: "primary" from Item/candidate allows "one" but 1 edge(s) already exist',
          },
        ],
      });
      expect(await captureMergePlanTargetFence(args.target)).toEqual(
        beforeRevalidation,
      );
      expect(
        await args.target.nodes.Artifact.getById(
          asNodeId("candidate-artifact"),
        ),
      ).toBeUndefined();
      expect(await args.target.edges.primary.find()).toEqual([
        expect.objectContaining({ id: "audit-primary" }),
      ]);
      expect(await args.target.nodes.Item.getById(item.id)).toEqual(item);
    });

    it("retains the atomic revision fence after successful revalidation", async () => {
      const args = await setup();
      const review = unwrap(await planCandidateWriteSetReview(args));
      await args.target.nodes.Artifact.create(
        { content: JSON.stringify(review) },
        { validFrom },
      );
      const result = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(result.status).toBe("compatible");
      if (result.status !== "compatible")
        throw new Error("Expected compatible review");
      await args.target.nodes.Artifact.create(
        { content: "intervening write" },
        { validFrom },
      );
      const beforeApply = await captureMergePlanTargetFence(args.target);
      const applied = await applyMergePlan(args.target, result.plan);
      expect(isErr(applied) && applied.error).toBeInstanceOf(
        StaleMergePlanError,
      );
      expect(await captureMergePlanTargetFence(args.target)).toEqual(
        beforeApply,
      );
      expect(
        await args.target.nodes.Item.getById(asNodeId("candidate")),
      ).toBeUndefined();
    });
  });
}
