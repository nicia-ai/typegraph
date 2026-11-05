import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  disjointWith,
  partOf,
  type Store,
  subClassOf,
} from "../../../src";
import { defineGraphExtension } from "../../../src/graph-extension";
import {
  applyMergePlan,
  CandidatePlanningScopeError,
  type CandidateWriteSet,
  CandidateWriteSetError,
  captureCandidateWriteSetTarget,
  ingestionBranch,
  MERGE_REVIEW_FORMAT_VERSION,
  MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
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
import { candidatePlanningScope } from "../../../src/graph-merge/sparse-candidate-branch";
import { asBranchId } from "../../../src/graph-merge/types";
import { importGraph } from "../../../src/interchange";
import type { CompiledRowsSql } from "../../../src/query/sql-intent";
import { storeBackend } from "../../../src/store/runtime-port";
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
const activeLimited = defineEdge("activeLimited", { schema: z.object({}) });
const identityOwned = defineEdge("identityOwned", {
  schema: z.object({ code: z.string().default("shared") }),
});
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
const boundedActiveCardinalityGraph = defineGraph({
  id: "bounded_active_cardinality_candidate_review",
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {
    activeLimited: {
      type: activeLimited,
      from: [Item],
      to: [Artifact],
      cardinality: "oneActive",
    },
  },
});
const boundedMatchIdentityGraph = defineGraph({
  id: "bounded_match_identity_candidate_review",
  nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
  edges: {
    identityOwned: {
      type: identityOwned,
      from: [Item],
      to: [Artifact],
      matchIdentity: { name: "code", fields: ["code"] },
    },
  },
});
const BaseKind = defineNode("BaseKind", {
  schema: z.object({ label: z.string() }),
});
const SpecificKind = defineNode("SpecificKind", {
  schema: z.object({ label: z.string() }),
});
const ExcludedKind = defineNode("ExcludedKind", {
  schema: z.object({ label: z.string() }),
});
const boundedOntologyGraph = defineGraph({
  id: "bounded_ontology_candidate_review",
  nodes: {
    BaseKind: { type: BaseKind },
    SpecificKind: { type: SpecificKind },
    ExcludedKind: { type: ExcludedKind },
  },
  edges: {},
  ontology: [
    subClassOf(SpecificKind, BaseKind),
    disjointWith(BaseKind, ExcludedKind),
  ],
});
const boundedOntologyIdentityGraph = defineGraph({
  id: "bounded_ontology_identity_candidate_review",
  identity: { sameIdAcrossKinds: "fold" },
  nodes: {
    BaseKind: { type: BaseKind },
    SpecificKind: { type: SpecificKind },
    ExcludedKind: { type: ExcludedKind },
  },
  edges: {},
  ontology: [
    subClassOf(SpecificKind, BaseKind),
    disjointWith(BaseKind, ExcludedKind),
  ],
});
const Peer = defineNode("Peer", { schema: z.object({ label: z.string() }) });
const crossRow = defineEdge("crossRow", { schema: z.object({}) });
const PEER_IDS = ["a", "b", "c", "d"] as const;

/**
 * A graph whose edge constraint reads rows outside a candidate's own scope.
 * `seeded` and `conflicting` close the constraint over a row the sparse base
 * never reads; `clean` does not.
 */
const crossRowCases = [
  {
    name: "target-side cardinality",
    planningScope: { scope: "whole-target", reason: "target-side-cardinality" },
    graph: defineGraph({
      id: "cross_row_target_cardinality",
      nodes: { Peer: { type: Peer } },
      edges: {
        crossRow: {
          type: crossRow,
          from: [Peer],
          to: [Peer],
          targetCardinality: "one",
        },
      },
    }),
    seeded: ["a", "c"],
    conflicting: ["b", "c"],
    clean: ["b", "d"],
  },
  {
    name: "acyclic edge",
    planningScope: { scope: "whole-target", reason: "acyclic-relation" },
    graph: defineGraph({
      id: "cross_row_acyclic",
      nodes: { Peer: { type: Peer } },
      edges: {
        crossRow: { type: crossRow, from: [Peer], to: [Peer], acyclic: true },
      },
    }),
    seeded: ["a", "b"],
    conflicting: ["b", "a"],
    clean: ["b", "c"],
  },
  {
    name: "composition",
    planningScope: { scope: "whole-target", reason: "composition" },
    graph: defineGraph({
      id: "cross_row_composition",
      nodes: { Peer: { type: Peer } },
      edges: {
        crossRow: {
          type: crossRow,
          from: [Peer],
          to: [Peer],
          cardinality: "one",
        },
      },
      ontology: [partOf(Peer, Peer, { via: crossRow, partSide: "from" })],
    }),
    seeded: ["a", "b"],
    conflicting: ["b", "a"],
    clean: ["b", "c"],
  },
] as const;
function crossRowEdge(
  id: string,
  [from, to]: readonly [string, string],
): CandidateWriteSet["edges"][number] {
  return {
    kind: "crossRow",
    id,
    from: { kind: "Peer", id: from },
    to: { kind: "Peer", id: to },
    properties: {},
    validFrom,
  };
}

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
    it.each([
      ["off", "compatible"],
      ["off", "disjoint"],
      ["off", "deleted"],
      ["off", "absent"],
      ["ontology", "compatible"],
      ["ontology", "disjoint"],
      ["ontology", "deleted"],
      ["ontology", "absent"],
    ] as const)(
      "matches full-clone ontology decisions with %s reconciliation and %s peer",
      async (reconcileTypes, peerState) => {
        const prefix = `${reconcileTypes}-${peerState}`;
        const target = await context.createHistoryStore(boundedOntologyGraph);
        if (peerState === "compatible")
          await target.nodes.BaseKind.create(
            { label: prefix },
            { id: prefix, validFrom },
          );
        if (peerState === "disjoint" || peerState === "deleted") {
          const peer = await target.nodes.ExcludedKind.create(
            { label: prefix },
            { id: prefix, validFrom },
          );
          if (peerState === "deleted")
            await target.nodes.ExcludedKind.delete(peer.id);
        }
        const writeSet: CandidateWriteSet = {
          formatVersion: 1,
          sourceId: `ontology-${prefix}`,
          target: await captureCandidateWriteSetTarget(target),
          nodes: [
            {
              kind: "SpecificKind",
              id: prefix,
              properties: { label: `candidate-${prefix}` },
              validFrom,
            },
          ],
          edges: [],
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
          const options = { reconcileTypes };
          const bounded = await planCandidateWriteSet({
            target,
            writeSet,
            makeBackend,
            options,
          });
          const expectedJson =
            imported.success ?
              canonicalMergePlanJson(
                unwrap(
                  await planMergeIncremental({
                    forkPoint: target,
                    target,
                    branches: [full],
                    options,
                  }),
                ),
              )
            : undefined;
          const actualJson =
            isErr(bounded) ? undefined : (
              canonicalMergePlanJson(bounded.data.plan)
            );
          expect(candidatePlanningScope(target)).toEqual({
            scope: "candidate",
          });
          expect(imported.success).toBe(peerState !== "disjoint");
          expect(actualJson).toBe(expectedJson);
        } finally {
          await full.close();
        }
      },
    );
    it("revalidates scoped ontology evidence when a same-id disjoint peer appears", async () => {
      const target = await context.createHistoryStore(boundedOntologyGraph);
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "ontology-reviewed",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "SpecificKind",
            id: "ontology-reviewed",
            properties: { label: "candidate" },
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
      await target.nodes.ExcludedKind.create(
        { label: "late disjoint sibling" },
        { id: "ontology-reviewed", validFrom },
      );
      const revalidated = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(review.baseline.scope).toBe("referenced");
      expect(revalidated.status).toBe("changed");
    });
    it("seeds same-id ontology peers through identity closure", async () => {
      const target = await context.createHistoryStore(
        boundedOntologyIdentityGraph,
      );
      await target.nodes.ExcludedKind.create(
        { label: "disjoint incumbent" },
        { id: "identity-disjoint", validFrom },
      );
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "ontology-identity-disjoint",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "SpecificKind",
            id: "identity-disjoint",
            properties: { label: "candidate" },
            validFrom,
          },
        ],
        edges: [],
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
        const boundedImportErrors =
          isErr(bounded) && bounded.error instanceof CandidateWriteSetError ?
            bounded.error.details["errors"]
          : undefined;
        expect(candidatePlanningScope(target)).toEqual({ scope: "candidate" });
        expect(imported.success).toBe(false);
        expect(boundedImportErrors).toEqual(imported.errors);
      } finally {
        await full.close();
      }
    });
    it("revalidates identity-enabled ontology evidence for a late disjoint peer", async () => {
      const target = await context.createHistoryStore(
        boundedOntologyIdentityGraph,
      );
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "ontology-identity-reviewed",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "SpecificKind",
            id: "identity-reviewed",
            properties: { label: "candidate" },
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
      await target.nodes.ExcludedKind.create(
        { label: "late disjoint sibling" },
        { id: "identity-reviewed", validFrom },
      );
      const revalidated = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(review.baseline.scope).toBe("referenced");
      expect(revalidated.status).toBe("changed");
    });
    it.each([
      ["limited", "occupied"],
      ["limited", "available"],
      ["limited", "deleted"],
      ["paired", "occupied"],
      ["paired", "available"],
      ["paired", "deleted"],
    ] as const)(
      "matches full-clone cardinality decisions for %s with %s peer",
      async (edgeKind, peerState) => {
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
            await target.edges.paired.delete(asEdgeId<typeof paired>(peer.id));
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
            isErr(bounded) ? undefined : (
              canonicalMergePlanJson(bounded.data.plan)
            );
          expect(actualJson).toBe(expectedJson);
        } finally {
          await full.close();
        }
      },
    );
    it.each([
      "occupied",
      "available",
      "ended",
      "deleted",
      "future-open",
    ] as const)(
      "matches full-clone oneActive decisions with a %s peer",
      async (peerState) => {
        const target = await context.createHistoryStore(
          boundedActiveCardinalityGraph,
        );
        const source = await target.nodes.Item.create(itemProps("source"), {
          id: "source",
          validFrom,
        });
        const otherSource = await target.nodes.Item.create(
          itemProps("other-source"),
          { id: "other-source", validFrom },
        );
        const existing = await target.nodes.Artifact.create(
          { content: "existing" },
          { id: "existing", validFrom },
        );
        const proposed = await target.nodes.Artifact.create(
          { content: "proposed" },
          { id: "proposed", validFrom },
        );
        const peer = await target.edges.activeLimited.create(
          peerState === "available" ? otherSource : source,
          existing,
          {},
          {
            id: "existing-edge",
            validFrom:
              peerState === "future-open" ?
                "2099-01-01T00:00:00.000Z"
              : validFrom,
            ...(peerState === "ended" ?
              { validTo: "2026-02-01T00:00:00.000Z" }
            : {}),
          },
        );
        if (peerState === "deleted")
          await target.edges.activeLimited.delete(
            asEdgeId<typeof activeLimited>(peer.id),
          );
        const readActive = target.backend.findActiveEdgesBySourceV1;
        expect(readActive).toBeDefined();
        if (readActive === undefined)
          throw new Error("Bundled backend lacks active source read.");
        const activeRows = await readActive({
          graphId: target.graphId,
          edgeKind: "activeLimited",
          fromKind: "Item",
          fromId: source.id,
        });
        expect(activeRows.map((row) => row.id)).toEqual(
          peerState === "occupied" || peerState === "future-open" ?
            [peer.id]
          : [],
        );
        const writeSet: CandidateWriteSet = {
          formatVersion: 1,
          sourceId: `one-active-${peerState}`,
          target: await captureCandidateWriteSetTarget(target),
          nodes: [],
          edges: [
            {
              kind: "activeLimited",
              id: "candidate-edge",
              from: { kind: "Item", id: source.id },
              to: { kind: "Artifact", id: proposed.id },
              properties: {},
              validFrom,
            },
          ],
        };
        expect(candidatePlanningScope(target)).toEqual({ scope: "candidate" });
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
          const occupied =
            peerState === "occupied" || peerState === "future-open";
          expect(imported.success).toBe(!occupied);
          const importError =
            imported.success ? undefined : imported.errors[0]?.error;
          expect(importError ?? "").toEqual(
            expect.stringContaining(occupied ? "oneActive" : ""),
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
            isErr(bounded) ? undefined : (
              canonicalMergePlanJson(bounded.data.plan)
            );
          expect(actualJson).toBe(expectedJson);
        } finally {
          await full.close();
        }
      },
    );
    it.each(["occupied", "deleted"] as const)(
      "matches full-clone durable matchIdentity planning with a %s owner and schema defaults",
      async (ownerState) => {
        const target = await context.createHistoryStore(
          boundedMatchIdentityGraph,
        );
        const source = await target.nodes.Item.create(
          itemProps("match-source"),
          { id: "match-source", validFrom },
        );
        const peer = await target.nodes.Artifact.create(
          { content: "match-peer" },
          { id: "match-peer", validFrom },
        );
        const owner = await target.edges.identityOwned.create(
          source,
          peer,
          { code: "shared" },
          { id: "durable-owner", validFrom },
        );
        if (ownerState === "deleted")
          await target.edges.identityOwned.delete(
            asEdgeId<typeof identityOwned>(owner.id),
          );

        const writeSet: CandidateWriteSet = {
          formatVersion: 1,
          sourceId: `match-identity-${ownerState}`,
          target: await captureCandidateWriteSetTarget(target),
          nodes: [],
          edges: [
            {
              kind: "identityOwned",
              id: "candidate-owner",
              from: { kind: "Item", id: source.id },
              to: { kind: "Artifact", id: peer.id },
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
              nodes: [],
              edges: writeSet.edges,
            },
            {
              onConflict: "error",
              onUnknownProperty: "allow",
              validateReferences: true,
              refreshStatistics: false,
            },
          );
          expect(imported.success).toBe(ownerState === "deleted");
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
            isErr(bounded) ? undefined : (
              canonicalMergePlanJson(bounded.data.plan)
            );
          expect(actualJson).toBe(expectedJson);
        } finally {
          await full.close();
        }
      },
    );
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
        ).plan;
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
      expect(review.formatVersion).toBe(
        MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
      );
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
    it("refuses to revalidate a candidate-scoped review once the target can no longer be read sparsely", async () => {
      const target = await context.createHistoryStore(
        boundedActiveCardinalityGraph,
      );
      const source = await target.nodes.Item.create(itemProps("source"), {
        id: "source",
        validFrom,
      });
      const proposed = await target.nodes.Artifact.create(
        { content: "proposed" },
        { id: "proposed", validFrom },
      );
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "scope-capability-loss",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [],
        edges: [
          {
            kind: "activeLimited",
            id: "candidate-edge",
            from: { kind: "Item", id: source.id },
            to: { kind: "Artifact", id: proposed.id },
            properties: {},
            validFrom,
          },
        ],
      };
      const args = {
        target,
        writeSet,
        makeBackend,
        policy,
        reviewScope: "candidate" as const,
      };
      const review = unwrap(await planCandidateWriteSetReview(args));
      expect(review.baseline.scope).toBe("referenced");
      const {
        writeSet: _writeSet,
        reviewScope: _reviewScope,
        ...revalidate
      } = args;
      expect(
        unwrap(
          await revalidateCandidateWriteSetReview({ ...revalidate, review }),
        ).status,
      ).toBe("compatible");

      const backend = storeBackend(target);
      const descriptor = Object.getOwnPropertyDescriptor(
        backend,
        "findActiveEdgesBySourceV1",
      );
      expect(descriptor).toBeDefined();
      Reflect.deleteProperty(backend, "findActiveEdgesBySourceV1");
      try {
        expect(candidatePlanningScope(target)).toEqual({
          scope: "whole-target",
          reason: "missing-active-source-read",
        });
        const refused = await revalidateCandidateWriteSetReview({
          ...revalidate,
          review,
        });
        expect(isErr(refused) && refused.error.code).toBe("GRAPH_MERGE_REVIEW");
        expect(isErr(refused) && refused.error.details["reason"]).toBe(
          "candidate-scope-ineligible",
        );
      } finally {
        if (descriptor)
          Object.defineProperty(
            backend,
            "findActiveEdgesBySourceV1",
            descriptor,
          );
      }
      expect(
        unwrap(
          await revalidateCandidateWriteSetReview({ ...revalidate, review }),
        ).status,
      ).toBe("compatible");
    });
    it("preserves whole-target and candidate-scoped approval decisions for an unrelated original row update", async () => {
      const target = await context.createHistoryStore(boundedGraph);
      const candidate = await target.nodes.Item.create(itemProps("candidate"), {
        id: "candidate",
        validFrom,
      });
      const unrelated = await target.nodes.Artifact.create(
        { content: "original" },
        { id: "unrelated", validFrom },
      );
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "review-scope-decision",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "Item",
            id: candidate.id,
            properties: { ...itemProps("candidate"), label: "accepted" },
            validFrom,
          },
        ],
        edges: [],
      };
      const args = { target, writeSet, makeBackend, policy };
      const v1 = unwrap(await planCandidateWriteSetReview(args));
      const v2 = unwrap(
        await planCandidateWriteSetReview({
          ...args,
          reviewScope: "candidate",
        }),
      );
      expect(v1.formatVersion).toBe(MERGE_REVIEW_FORMAT_VERSION);
      expect(v2.formatVersion).toBe(
        MERGE_REVIEW_FORMAT_VERSION_CANDIDATE_SCOPED,
      );
      expect(v2.plan.writes).toEqual(v1.plan.writes);

      await target.nodes.Artifact.update(unrelated.id, { content: "revised" });
      const v1Decision = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review: v1 }),
      );
      const v2Decision = unwrap(
        await revalidateCandidateWriteSetReview({ ...args, review: v2 }),
      );
      expect(v1Decision).toMatchObject({
        status: "changed",
        differences: [
          {
            category: "baseline",
            path: "baseline.rows",
            entity: { role: "node", kind: "Artifact", id: unrelated.id },
          },
        ],
      });
      expect(v2Decision.status).toBe("compatible");
    });
    it("bounds candidate-scoped review reads across unrelated rows and identity assertions", async () => {
      const target = await context.createHistoryStore(boundedIdentityGraph);
      const candidate = await target.nodes.Item.create(itemProps("candidate"), {
        id: "candidate",
        validFrom,
      });
      const writeSet: CandidateWriteSet = {
        formatVersion: 1,
        sourceId: "review-scope-budget",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [
          {
            kind: "Item",
            id: candidate.id,
            properties: { ...itemProps("candidate"), label: "accepted" },
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
      async function measure<T>(run: () => Promise<T>) {
        const backend = context.getBackend();
        const originalExecute = backend.execute;
        const startingFence = await captureMergePlanTargetFence(target);
        let statements = 0;
        let returnedRows = 0;
        const execute = vi
          .spyOn(backend, "execute")
          .mockImplementation(async <TRow>(query: CompiledRowsSql) => {
            const rows = await originalExecute<TRow>(query);
            statements += 1;
            returnedRows += rows.length;
            return rows;
          });
        try {
          const value = await run();
          return { value, statements, returnedRows };
        } finally {
          execute.mockRestore();
          expect(await captureMergePlanTargetFence(target)).toEqual(
            startingFence,
          );
        }
      }
      const before = await measure(() => planCandidateWriteSetReview(args));
      const review = unwrap(before.value);
      expect(review.baseline.scope).toBe("referenced");
      for (let index = 0; index < 12; index += 1) {
        const left = await target.nodes.Item.create(
          itemProps(`left-${index}`),
          {
            id: `left-${index}`,
            validFrom,
          },
        );
        const right = await target.nodes.Item.create(
          itemProps(`right-${index}`),
          { id: `right-${index}`, validFrom },
        );
        await target.identity.assertDifferent(left, right, { validFrom });
      }
      const after = await measure(() => planCandidateWriteSetReview(args));
      unwrap(after.value);
      expect(after.statements).toBeLessThanOrEqual(before.statements);
      expect(after.returnedRows).toBe(before.returnedRows);

      const revalidation = await measure(() =>
        revalidateCandidateWriteSetReview({ ...args, review }),
      );
      expect(unwrap(revalidation.value).status).toBe("compatible");
      expect(revalidation.statements).toBeLessThanOrEqual(after.statements * 2);
      expect(revalidation.returnedRows).toBeLessThanOrEqual(
        after.returnedRows * 2,
      );
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
      unwrap(
        await applyMergePlan(args.target, result.plan, { review: result }),
      );
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
      const fresh = unwrap(await planCandidateWriteSet(args)).plan;
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

  describe("candidate planning on a graph with cross-row constraints", () => {
    async function seededTarget(testCase: (typeof crossRowCases)[number]) {
      const target = await context.createHistoryStore(testCase.graph);
      const seeded = await importGraph(
        target,
        {
          formatVersion: "2.0",
          exportedAt: "1970-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: PEER_IDS.map((id) => ({
            kind: "Peer",
            id,
            properties: { label: id },
            validFrom,
          })),
          edges: [crossRowEdge("seed-edge", testCase.seeded)],
        },
        { onConflict: "error", onUnknownProperty: "error" },
      );
      expect(seeded.success).toBe(true);
      return target;
    }

    async function writeSetOf(
      target: Awaited<ReturnType<typeof seededTarget>>,
      edge: CandidateWriteSet["edges"][number],
    ): Promise<CandidateWriteSet> {
      return {
        formatVersion: 1,
        sourceId: "cross-row-source",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [],
        edges: [edge],
      };
    }

    describe.each(crossRowCases)("$name", (testCase) => {
      it("plans against the whole target instead of the sparse base", async () => {
        const target = await seededTarget(testCase);
        expect(candidatePlanningScope(target)).toEqual(testCase.planningScope);

        const conflicting = await writeSetOf(
          target,
          crossRowEdge("candidate-edge", testCase.conflicting),
        );
        const refused = await planCandidateWriteSet({
          target,
          writeSet: conflicting,
          makeBackend,
        });
        expect(isErr(refused)).toBe(true);

        const clean = await writeSetOf(
          target,
          crossRowEdge("candidate-edge", testCase.clean),
        );
        let stagedIds: readonly string[] = [];
        const { plan: planned, planningScope } = unwrap(
          await planCandidateWriteSet({
            target,
            writeSet: clean,
            makeBackend: async () => {
              const staging = await makeBackend();
              const readStaged = staging.findNodesAcrossKinds;
              if (readStaged === undefined)
                throw new Error("Expected cross-kind read");
              vi.spyOn(staging, "findNodesAcrossKinds").mockImplementation(
                async (query) => {
                  const rows = await readStaged(query);
                  stagedIds = rows.map((row) => row.id);
                  return rows;
                },
              );
              return staging;
            },
          }),
        );
        // A sparse base stages only the rows the candidate touches; the
        // whole-target fallback stages every target row.
        expect(stagedIds.toSorted()).toEqual([...PEER_IDS]);
        expect(planningScope).toEqual(testCase.planningScope);
        const full = unwrap(
          await ingestionBranch(target, makeBackend, {
            id: asBranchId(clean.sourceId),
          }),
        );
        try {
          const imported = await importGraph(
            full,
            {
              formatVersion: "2.0",
              exportedAt: "1970-01-01T00:00:00.000Z",
              source: { type: "external" },
              nodes: clean.nodes,
              edges: clean.edges,
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
          expect(canonicalMergePlanJson(planned)).toBe(
            canonicalMergePlanJson(expected),
          );
        } finally {
          await full.close();
        }
      });

      it("refuses an explicitly requested candidate planning scope before staging", async () => {
        const target = await seededTarget(testCase);
        const writeSet = await writeSetOf(
          target,
          crossRowEdge("candidate-edge", testCase.clean),
        );
        const planBackend = vi.fn(makeBackend);

        const refused = await planCandidateWriteSet({
          target,
          writeSet,
          makeBackend: planBackend,
          planningScope: "candidate",
        });
        if (!isErr(refused))
          throw new Error(
            `expected a candidate planning scope refusal, planned ${JSON.stringify(refused.data.planningScope)}`,
          );
        expect(refused.error).toBeInstanceOf(CandidatePlanningScopeError);
        expect(refused.error.code).toBe("GRAPH_MERGE_CANDIDATE_PLANNING_SCOPE");
        expect(refused.error.details).toEqual({
          planningScope: testCase.planningScope,
        });
        expect(planBackend).not.toHaveBeenCalled();
      });

      it("refuses an explicitly requested candidate review scope and keeps the whole-target review", async () => {
        const target = await seededTarget(testCase);
        const writeSet = await writeSetOf(
          target,
          crossRowEdge("candidate-edge", testCase.clean),
        );
        const planBackend = vi.fn(makeBackend);

        const scoped = await planCandidateWriteSetReview({
          target,
          writeSet,
          makeBackend: planBackend,
          policy,
          reviewScope: "candidate",
        });
        expect(isErr(scoped) && scoped.error.code).toBe("GRAPH_MERGE_REVIEW");
        expect(isErr(scoped) && scoped.error.details).toEqual({
          reason: "candidate-scope-ineligible",
          planningScope: testCase.planningScope,
        });
        expect(planBackend).not.toHaveBeenCalled();

        const whole = unwrap(
          await planCandidateWriteSetReview({
            target,
            writeSet,
            makeBackend,
            policy,
          }),
        );
        expect(whole.formatVersion).toBe(MERGE_REVIEW_FORMAT_VERSION);
      });
    });
  });
}
