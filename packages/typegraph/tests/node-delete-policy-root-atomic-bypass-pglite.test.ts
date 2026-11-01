/**
 * `nodeDeleteRequiresPortablePath` — proof that a stated
 * {@link NodeDeletePolicy}, or a public `delete(id, { expect })` plan, routes
 * `executeNodeDelete` around the fused atomic delete command, on the ONE
 * backend configuration where that command is actually reachable.
 *
 * `resolveAtomicNodeDeleteBatchExecutor` only ever resolves a `deleteNodes`
 * executor against a backend whose execution capabilities advertise
 * `atomicBatch: "root"` — which PGlite does at the root, but a
 * `store.transaction` session never does (its transaction-scoped backend
 * registers `replaceNodes` / `mutateNodes` / `mutateEdges` only). SQLite never
 * advertises `atomicBatch` at all. So the routing decision this predicate
 * makes is unreachable from `tests/node-delete-policy-consumed-edges.test.ts`
 * (SQLite) AND from merge apply's transaction-scoped
 * `transactionDeleteNodeWithPolicy` calls — the ONLY way to exercise it, in a
 * test or otherwise, is `StoreRuntime.deleteNodeWithPolicy` called directly
 * against a PGlite ROOT backend, exactly as this file does. The public
 * `store.nodes.<Kind>.delete` runs against that same root backend, so the
 * `expect` cases below reach the decision through the collection itself.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { withAtomicMutationProgramDispatchObserver } from "../src/backend/capabilities/atomic-mutation-program";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { NodeDeletePlanMismatchError } from "../src/errors";
import { createStoreWithSchema } from "../src/store";
import { STORE_RUNTIME } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";

// Deliberately atomic-eligible: `onDelete: "restrict"`, no uniques, no
// identity, no searchable/embedding fields (see
// `resolveAtomicNodeDeleteBatchExecutor`'s eligibility gates) — a plain
// `RestrictNode` delete with no policy WOULD take the fused path.
const Target = defineNode("Target", { schema: z.object({}) });
const RestrictNode = defineNode("RestrictNode", { schema: z.object({}) });
const link = defineEdge("link", { schema: z.object({}) });

const graph = defineGraph({
  id: "node-delete-policy-root-atomic-bypass",
  nodes: {
    Target: { type: Target },
    RestrictNode: { type: RestrictNode, onDelete: "restrict" },
  },
  edges: {
    link: { type: link, from: [RestrictNode], to: [Target] },
  },
});

describe("NodeDeletePolicy bypasses the fused atomic delete on a root backend", () => {
  it("honors enforceDeleteBehavior:false via the portable path even though the fused delete is eligible", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const target = await store.nodes.Target.create({});
      const restrictNode = await store.nodes.RestrictNode.create({});
      const edge = await store.edges.link.create(restrictNode, target, {});

      const dispatched: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        () =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(
            backend,
            { kind: "RestrictNode", id: restrictNode.id },
            { enforceDeleteBehavior: false },
          ),
      );

      // The fused `deleteNodes` command was never dispatched: the policy
      // forced the portable path even though the fused command was eligible.
      expect(dispatched).not.toContain("deleteNodes");
      await expect(
        store.nodes.RestrictNode.getById(restrictNode.id),
      ).resolves.toBeUndefined();
      // Enforcement fully skipped: the edge is neither an obstacle nor
      // removed.
      await expect(store.edges.link.getById(edge.id)).resolves.toBeDefined();
    } finally {
      await local.backend.close();
    }
  });

  it("honors a non-empty consumedEdgeIds via the portable path even though the fused delete is eligible", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const target = await store.nodes.Target.create({});
      const restrictNode = await store.nodes.RestrictNode.create({});
      const edge = await store.edges.link.create(restrictNode, target, {});

      const dispatched: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        () =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(
            backend,
            { kind: "RestrictNode", id: restrictNode.id },
            {
              enforceDeleteBehavior: true,
              consumedEdgeIds: new Set([edge.id]),
            },
          ),
      );

      expect(dispatched).not.toContain("deleteNodes");
      await expect(
        store.nodes.RestrictNode.getById(restrictNode.id),
      ).resolves.toBeUndefined();
      // Consumed, not this delete's to remove: survives untouched.
      await expect(store.edges.link.getById(edge.id)).resolves.toBeDefined();
    } finally {
      await local.backend.close();
    }
  });

  it("without a policy the SAME shape takes the fused path", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const restrictNode = await store.nodes.RestrictNode.create({});

      const dispatched: string[] = [];
      await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        () =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(backend, {
            kind: "RestrictNode",
            id: restrictNode.id,
          }),
      );

      // Confirms the eligibility premise: this exact node shape, with no
      // policy at all, IS reachable through the fused command — so the two
      // cases above are genuinely exercising a bypass, not an executor that
      // was never eligible in the first place.
      expect(dispatched).toContain("deleteNodes");
    } finally {
      await local.backend.close();
    }
  });
});

describe("A delete expect plan bypasses the fused atomic delete on a root backend", () => {
  it("compares the plan on the portable path, deleting on a match and refusing a mismatch, though the fused delete is eligible", async () => {
    const local = await createLocalPgliteBackend({ vector: false });
    const backend = createPostgresBackend(local.db, { vector: false });
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const unguarded = await store.nodes.RestrictNode.create({});
      const matched = await store.nodes.RestrictNode.create({});
      const mismatched = await store.nodes.RestrictNode.create({});
      const matchedPlan = requireDefined(
        await store.nodes.RestrictNode.planDelete(matched.id),
      );
      expect(matchedPlan).toEqual({ cascadedParts: [], removedEdgeIds: [] });

      const dispatched: string[] = [];
      const refusal = await withAtomicMutationProgramDispatchObserver(
        backend,
        (variant) => dispatched.push(variant),
        async () => {
          await store.nodes.RestrictNode.delete(unguarded.id);
          // The premise: the public delete of this shape IS fused.
          expect(dispatched).toEqual(["deleteNodes"]);
          await store.nodes.RestrictNode.delete(matched.id, {
            expect: matchedPlan,
          });
          try {
            await store.nodes.RestrictNode.delete(mismatched.id, {
              expect: { cascadedParts: [], removedEdgeIds: ["stale-edge"] },
            });
          } catch (error) {
            return error;
          }
          return;
        },
      );

      // MUTATION CHECK: drop the `expect` arm of
      // `nodeDeleteRequiresPortablePath`
      // (src/store/operations/node-write-pipeline.ts) and both guarded
      // deletes take the fused command, which compares nothing, so the
      // mismatched node is deleted — verified and reverted.
      expect(dispatched).toEqual(["deleteNodes"]);
      expect(refusal).toBeInstanceOf(NodeDeletePlanMismatchError);
      expect((refusal as NodeDeletePlanMismatchError).details).toMatchObject({
        situation: "changed",
        droppedEdgeIds: ["stale-edge"],
      });
      await expect(
        store.nodes.RestrictNode.getById(matched.id),
      ).resolves.toBeUndefined();
      await expect(
        store.nodes.RestrictNode.getById(mismatched.id),
      ).resolves.toBeDefined();
    } finally {
      await local.backend.close();
    }
  });
});
