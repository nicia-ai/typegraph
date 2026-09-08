/**
 * `NodeDeletePolicy.consumedEdgeIds` — the generic restrict/cascade narrowing
 * seam a future composition cascade (`planCompositionCascade`, a later slice)
 * plans against.
 *
 * No producer populates `consumedEdgeIds` with real composition-edge ids yet
 * (that lands with the registry's composition-edge owner), so these tests
 * drive the seam directly through the internal runtime port — the same port
 * merge apply now uses (`deleteNodeWithPolicy`) — with hand-picked edge ids
 * standing in for a future cascade's plan. They prove two things: the seam
 * narrows exactly the edges it is told to, and today's behavior (an empty or
 * absent `consumedEdgeIds`) is byte-identical to before this field existed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  RestrictedDeleteError,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { STORE_RUNTIME } from "../src/store/runtime-port";

const Target = defineNode("Target", { schema: z.object({}) });
const RestrictNode = defineNode("RestrictNode", { schema: z.object({}) });
const CascadeNode = defineNode("CascadeNode", { schema: z.object({}) });
const link = defineEdge("link", { schema: z.object({}) });

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      Target: { type: Target },
      RestrictNode: { type: RestrictNode, onDelete: "restrict" },
      CascadeNode: { type: CascadeNode, onDelete: "cascade" },
    },
    edges: {
      link: {
        type: link,
        from: [RestrictNode, CascadeNode],
        to: [Target],
      },
    },
  });
}

describe("NodeDeletePolicy.consumedEdgeIds", () => {
  it("excludes a fully-consumed edge from the restrict count, allowing the delete", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildGraph("consumed_restrict_narrows_to_zero"),
        backend,
      );
      const target = await store.nodes.Target.create({});
      const restrictNode = await store.nodes.RestrictNode.create({});
      const edge = await store.edges.link.create(restrictNode, target, {});

      await backend.transaction((tx) =>
        store[STORE_RUNTIME].deleteNodeWithPolicy(
          tx,
          { kind: "RestrictNode", id: restrictNode.id },
          {
            enforceDeleteBehavior: true,
            consumedEdgeIds: new Set([edge.id]),
          },
        ),
      );

      await expect(
        store.nodes.RestrictNode.getById(restrictNode.id),
      ).resolves.toBeUndefined();
      // The consumed edge is excluded from THIS delete's restrict/cascade
      // consideration entirely — it is neither an obstacle nor something this
      // delete removes. It survives untouched, for whichever caller planned
      // its consumption to delete it itself.
      await expect(store.edges.link.getById(edge.id)).resolves.toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("still counts an unconsumed edge against restrict even when a sibling edge is consumed", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildGraph("consumed_restrict_leaves_unconsumed_blocking"),
        backend,
      );
      const consumedTarget = await store.nodes.Target.create({});
      const unconsumedTarget = await store.nodes.Target.create({});
      const restrictNode = await store.nodes.RestrictNode.create({});
      const consumedEdge = await store.edges.link.create(
        restrictNode,
        consumedTarget,
        {},
      );
      await store.edges.link.create(restrictNode, unconsumedTarget, {});

      await expect(
        backend.transaction((tx) =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(
            tx,
            { kind: "RestrictNode", id: restrictNode.id },
            {
              enforceDeleteBehavior: true,
              consumedEdgeIds: new Set([consumedEdge.id]),
            },
          ),
        ),
      ).rejects.toMatchObject({
        details: expect.objectContaining({ edgeCount: 1 }) as unknown,
      });
      // Refused: the node survives, live.
      await expect(
        store.nodes.RestrictNode.getById(restrictNode.id),
      ).resolves.toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("cascade removes only the unconsumed edge, leaving the consumed one for its own owner", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildGraph("consumed_cascade_removes_only_unconsumed"),
        backend,
      );
      const consumedTarget = await store.nodes.Target.create({});
      const unconsumedTarget = await store.nodes.Target.create({});
      const cascadeNode = await store.nodes.CascadeNode.create({});
      const consumedEdge = await store.edges.link.create(
        cascadeNode,
        consumedTarget,
        {},
      );
      const unconsumedEdge = await store.edges.link.create(
        cascadeNode,
        unconsumedTarget,
        {},
      );

      await backend.transaction((tx) =>
        store[STORE_RUNTIME].deleteNodeWithPolicy(
          tx,
          { kind: "CascadeNode", id: cascadeNode.id },
          {
            enforceDeleteBehavior: true,
            consumedEdgeIds: new Set([consumedEdge.id]),
          },
        ),
      );

      await expect(
        store.nodes.CascadeNode.getById(cascadeNode.id),
      ).resolves.toBeUndefined();
      await expect(
        store.edges.link.getById(unconsumedEdge.id),
      ).resolves.toBeUndefined();
      await expect(
        store.edges.link.getById(consumedEdge.id),
      ).resolves.toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("an absent consumedEdgeIds is byte-identical to today's plain restrict refusal", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildGraph("absent_consumed_edge_ids_matches_today"),
        backend,
      );
      const target = await store.nodes.Target.create({});
      const restrictNode = await store.nodes.RestrictNode.create({});
      await store.edges.link.create(restrictNode, target, {});

      await expect(
        backend.transaction((tx) =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(
            tx,
            { kind: "RestrictNode", id: restrictNode.id },
            { enforceDeleteBehavior: true },
          ),
        ),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);
      await expect(
        backend.transaction((tx) =>
          store[STORE_RUNTIME].deleteNodeWithPolicy(tx, {
            kind: "RestrictNode",
            id: restrictNode.id,
          }),
        ),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);
    } finally {
      await backend.close();
    }
  });
});
