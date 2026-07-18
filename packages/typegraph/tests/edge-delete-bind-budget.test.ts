/**
 * Full-chunk edge soft/hard delete against the bind budget.
 *
 * `deleteEdgesBatch` / `hardDeleteEdgesBatch` chunk their id lists on the
 * connection's bound-parameter budget so a single UPDATE/DELETE never exceeds
 * it. A cascade node delete routes EVERY connected edge through those batch
 * members, so an off-by-one at a chunk boundary would strand edges past the
 * first chunk.
 *
 * The budget is pinned deliberately small via a capability override. It MUST
 * be passed at backend CONSTRUCTION — chunk sizes are frozen there
 * (computeSqliteBatchChunkSizes), so patching `backend.capabilities`
 * afterwards is a no-op that would make every case fit one chunk and pass
 * vacuously. Each edge count is placed exactly on a chunk boundary (one full
 * chunk, one under, one over, and an exact multiple) so a boundary regression
 * has nowhere to hide.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createInitializedStore } from "./test-utils";

const GRAPH_ID = "edge_delete_bind_budget";

// A tiny per-statement bind budget: a handful of connected edges then spans
// several delete chunks.
const MAX_BIND_PARAMETERS = 5;

// Mirrors the chunk math in operation-backend-core.ts:
//   getEdgesChunkSize  = maxBind - 1              (the graph_id bind)
//   soft-delete chunk  = getEdgesChunkSize - 1    (+ the deleted_at bind)
//   hard-delete chunk  = getEdgesChunkSize        (no extra bind)
const SOFT_DELETE_CHUNK = MAX_BIND_PARAMETERS - 2;
const HARD_DELETE_CHUNK = MAX_BIND_PARAMETERS - 1;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person, onDelete: "cascade" } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const openBackends: GraphBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((backend) => backend.close()));
});

/**
 * A store on a backend whose bound-parameter budget is fixed at construction
 * — the only way to make the chunk math observable (see the file header).
 */
async function createBudgetedStore() {
  const { backend } = createLocalSqliteBackend({
    capabilities: { maxBindParameters: MAX_BIND_PARAMETERS },
  });
  openBackends.push(backend);
  const store = await createInitializedStore(graph, backend);
  return { backend, store };
}

type BudgetedStore = Awaited<ReturnType<typeof createBudgetedStore>>["store"];

/**
 * Creates one hub with `edgeCount` outgoing `knows` edges to fresh targets.
 * Returns the hub and every edge id so the delete can be checked exhaustively.
 */
async function seedHub(
  store: BudgetedStore,
  hubKey: string,
  edgeCount: number,
) {
  const hub = await store.nodes.Person.create(
    { name: hubKey },
    { id: `${hubKey}-hub` },
  );
  const edgeIds: string[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const target = await store.nodes.Person.create(
      { name: `${hubKey}-target-${index}` },
      { id: `${hubKey}-target-${index}` },
    );
    const edge = await store.edges.knows.create(hub, target, {});
    edgeIds.push(edge.id);
  }
  return { hubId: hub.id, edgeIds };
}

/**
 * Asserts the cascade removed every connected edge — none stranded at a chunk
 * boundary. `findEdgesConnectedTo` (which filters `deleted_at IS NULL`) must be
 * empty, and each edge id must be individually non-live (hard: row gone; soft:
 * `deleted_at` set).
 */
async function expectAllEdgesGone(
  backend: GraphBackend,
  hubId: string,
  edgeIds: readonly string[],
): Promise<void> {
  const connected = await backend.findEdgesConnectedTo({
    graphId: GRAPH_ID,
    nodeKind: "Person",
    nodeId: hubId,
  });
  expect(connected, `${edgeIds.length} edges must all be removed`).toHaveLength(
    0,
  );
  // Belt-and-suspenders per edge id: a hard delete removes the row; a soft
  // delete sets deleted_at. Neither may leave the edge live.
  for (const edgeId of edgeIds) {
    const row = await backend.getEdge(GRAPH_ID, edgeId);
    const live = row !== undefined && row.deleted_at === undefined;
    expect(live, `edge ${edgeId} must not survive the cascade`).toBe(false);
  }
}

type ChunkShape = Readonly<{ label: string; edgeCount: number }>;

/** Edge counts placed exactly on the boundaries of a chunk of size `chunk`. */
function boundaryShapes(chunk: number): readonly ChunkShape[] {
  return [
    { label: "exactly one full chunk", edgeCount: chunk },
    { label: "one under a chunk boundary", edgeCount: 2 * chunk - 1 },
    { label: "one over a chunk boundary", edgeCount: 2 * chunk + 1 },
    { label: "an exact multiple of the chunk", edgeCount: 2 * chunk },
  ];
}

describe("cascade edge delete honors the bind budget", () => {
  // A soft node delete tombstones only the node; every connected edge is
  // removed SOLELY through `deleteEdgesBatch` under cascade enforcement. So the
  // end-to-end node cascade isolates the batch member — a chunk-boundary bug
  // strands edges observably.
  describe("soft cascade node delete (routes through deleteEdgesBatch)", () => {
    for (const shape of boundaryShapes(SOFT_DELETE_CHUNK)) {
      it(`removes all edges — ${shape.label} (${shape.edgeCount} edges, chunk ${SOFT_DELETE_CHUNK})`, async () => {
        const { backend, store } = await createBudgetedStore();
        const { hubId, edgeIds } = await seedHub(
          store,
          `soft-${shape.edgeCount}`,
          shape.edgeCount,
        );

        await store.nodes.Person.delete(hubId);

        await expectAllEdgesGone(backend, hubId, edgeIds);
      });
    }
  });

  // A NODE hard delete also removes connected edges through `hardDeleteNode`'s
  // single by-node cascade, which would mask a `hardDeleteEdgesBatch`
  // chunk-boundary bug. To stay discriminating we drive the batch member
  // directly — the exact call `enforceNodeDeleteBehavior` makes for a
  // `cascade` / `disconnect` HARD delete.
  describe("hardDeleteEdgesBatch (driven directly)", () => {
    for (const shape of boundaryShapes(HARD_DELETE_CHUNK)) {
      it(`removes all edges — ${shape.label} (${shape.edgeCount} edges, chunk ${HARD_DELETE_CHUNK})`, async () => {
        const { backend, store } = await createBudgetedStore();
        const { hubId, edgeIds } = await seedHub(
          store,
          `hard-${shape.edgeCount}`,
          shape.edgeCount,
        );

        const hardDeleteEdgesBatch = backend.hardDeleteEdgesBatch;
        if (hardDeleteEdgesBatch === undefined) {
          throw new Error("backend must expose hardDeleteEdgesBatch");
        }
        await hardDeleteEdgesBatch({
          graphId: GRAPH_ID,
          ids: [...edgeIds],
        });

        await expectAllEdgesGone(backend, hubId, edgeIds);
      });
    }
  });
});
