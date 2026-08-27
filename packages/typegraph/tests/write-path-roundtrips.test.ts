/**
 * Write-path round-trip reductions.
 *
 * 1. CASCADE BATCHING — a node delete whose delete behavior removes N
 *    connected edges must issue one batched edge-delete statement (per
 *    bind-budget chunk), not N per-edge statements. Counted through a
 *    spying overlay that follows the write transaction, alongside the
 *    behavioral semantics (edges tombstoned vs removed) and recorded-time
 *    capture (every cascaded edge's pre-image survives).
 *
 * 2. SINGLE VALIDATION — getOrCreate variants validate props up front to
 *    compute the constraint key; the create leg must reuse that validated
 *    object instead of re-running the full Zod parse. Counted through a
 *    schema-level refinement that increments per parse.
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
import {
  deriveBackend,
  type ExactBackendOverlay,
} from "../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";

// ============================================================
// Call-counting overlay (follows the write transaction)
// ============================================================

type CallCounts = Record<string, number>;

const COUNTED_METHODS = [
  "deleteEdge",
  "deleteEdgesBatch",
  "getEdge",
  "getEdges",
  "getNode",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
] as const;

function withCallCounts(backend: GraphBackend): {
  backend: GraphBackend;
  counts: CallCounts;
} {
  const counts: CallCounts = {};
  for (const name of COUNTED_METHODS) counts[name] = 0;

  function wrapMethods<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    // Built from a name list rather than written as a literal, so the overlay
    // carries an assertion: `ExactBackendOverlay<T, Partial<T>>` reduces to
    // `Partial<T>` only once `T` is resolved, and the checker cannot verify
    // that against an unresolved type parameter.
    const overrides: Record<string, unknown> = {};
    for (const name of COUNTED_METHODS) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      overrides[name] = (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    return deriveBackend<T, Partial<T>>(
      target,
      overrides as ExactBackendOverlay<T, Partial<T>>,
    );
  }

  const counted: GraphBackend = deriveBackend(wrapMethods(backend), {
    transaction: (fn, options) =>
      backend.transaction((target) => fn(wrapMethods(target)), options),
  });
  return { backend: counted, counts };
}

// ============================================================
// Cascade batching
// ============================================================

const EDGE_COUNT = 25;

const Hub = defineNode("Hub", {
  schema: z.object({ name: z.string() }),
});
const Spoke = defineNode("Spoke", {
  schema: z.object({ name: z.string() }),
});
const links = defineEdge("links", { schema: z.object({}) });

function buildCascadeGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: {
      Hub: { type: Hub, onDelete: "cascade" },
      Spoke: { type: Spoke },
    },
    edges: {
      links: { type: links, from: [Hub], to: [Spoke] },
    },
  });
}

async function seedHubAndSpokes(
  store: Awaited<
    ReturnType<
      typeof createStoreWithSchema<ReturnType<typeof buildCascadeGraph>>
    >
  >[0],
) {
  const hub = await store.nodes.Hub.create({ name: "hub" }, { id: "hub" });
  for (let index = 0; index < EDGE_COUNT; index++) {
    const spoke = await store.nodes.Spoke.create(
      { name: `spoke-${index}` },
      { id: `spoke-${index}` },
    );
    await store.edges.links.create(hub, spoke, {});
  }
  return hub;
}

describe("cascade edge deletion batches", () => {
  it("portable node bulkDelete rolls back earlier ids when restrict refuses", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("restricted_atomic_node_batch_delete"),
        backend,
      );
      const hub = await store.nodes.Hub.create({ name: "hub" });
      const connected = await store.nodes.Spoke.create({ name: "connected" });
      const isolated = await store.nodes.Spoke.create({ name: "isolated" });
      await store.edges.links.create(hub, connected, {});

      await expect(
        store.nodes.Spoke.bulkDelete([isolated.id, connected.id]),
      ).rejects.toBeInstanceOf(RestrictedDeleteError);
      await expect(
        store.nodes.Spoke.getById(isolated.id),
      ).resolves.toBeDefined();
      await expect(
        store.nodes.Spoke.getById(connected.id),
      ).resolves.toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("direct bulkDelete resolves and retires N edges with two batch calls", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, counts } = withCallCounts(rawBackend);
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("direct_edge_batch_delete"),
        backend,
      );
      const hub = await seedHubAndSpokes(store);
      const edges = await store.edges.links.findFrom(hub);

      for (const name of COUNTED_METHODS) counts[name] = 0;
      await store.edges.links.bulkDelete(edges.map((edge) => edge.id));

      expect(counts["getEdges"]).toBe(1);
      expect(counts["getEdge"]).toBe(0);
      expect(counts["deleteEdgesBatch"]).toBe(1);
      expect(counts["deleteEdge"]).toBe(0);
      expect(await store.edges.links.findFrom(hub)).toHaveLength(0);
    } finally {
      await rawBackend.close();
    }
  });

  it("soft delete removes N edges with one batched statement", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, counts } = withCallCounts(rawBackend);
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("cascade_soft"),
        backend,
      );
      const hub = await seedHubAndSpokes(store);

      await store.nodes.Hub.delete(hub.id);

      expect(counts["deleteEdgesBatch"]).toBe(1);
      expect(counts["deleteEdge"]).toBe(0);
      const remaining = await store.edges.links.findFrom(hub);
      expect(remaining).toHaveLength(0);
      // Tombstoned, not removed: the spokes themselves survive.
      expect(await store.nodes.Spoke.getById("spoke-0" as never)).toBeDefined();
    } finally {
      await rawBackend.close();
    }
  });

  it("hard delete removes N edges with one batched statement", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, counts } = withCallCounts(rawBackend);
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("cascade_hard"),
        backend,
      );
      const hub = await seedHubAndSpokes(store);

      await store.nodes.Hub.hardDelete(hub.id);

      expect(counts["hardDeleteEdgesBatch"]).toBe(1);
      expect(counts["hardDeleteEdge"]).toBe(0);
      expect(await store.edges.links.findFrom(hub)).toHaveLength(0);
    } finally {
      await rawBackend.close();
    }
  });

  it("captures every cascaded edge pre-image under recorded history", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("cascade_recorded"),
        backend,
        { history: true },
      );
      const hub = await seedHubAndSpokes(store);
      const beforeDelete = await store.recordedNow();
      if (beforeDelete === undefined) {
        throw new Error("recordedNow() must resolve with history enabled");
      }

      await store.nodes.Hub.delete(hub.id);

      // The batched cascade must not skip capture: as-of a recorded
      // instant before the delete, every edge is still visible.
      // (Recorded views expose query-shaped reads, not findFrom.)
      const view = store.asOfRecorded(beforeDelete);
      const edgesBefore = await view
        .query()
        .from("Hub", "h")
        .traverse("links", "e")
        .to("Spoke", "s")
        .select((ctx) => ({ id: ctx.s.id }))
        .execute();
      expect(edgesBefore).toHaveLength(EDGE_COUNT);
      // And after: none.
      expect(await store.edges.links.findFrom(hub)).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });
});

// ============================================================
// Delete gate and transaction recheck
// ============================================================

describe("delete round trips", () => {
  // The in-transaction recheck read these paths used to make is GONE: the
  // DELETE / UPDATE statements now carry the expected kind in their own WHERE
  // (see UpdateEdgeParams.kind), so the write is its own recheck and a second
  // `getEdge` would re-derive a verdict the statement already enforces. The
  // gate outside the transaction stays — it is what keeps an absent or
  // wrong-kind edge from opening an empty transaction and from firing hooks —
  // so each path is one read plus one write instead of two reads plus one.
  it("edge delete and hard delete gate once; the write carries its own kind predicate", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, counts } = withCallCounts(rawBackend);
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("delete_rt_edges"),
        backend,
      );
      const hub = await store.nodes.Hub.create({ name: "hub" }, { id: "hub" });
      const spoke = await store.nodes.Spoke.create(
        { name: "spoke" },
        { id: "spoke" },
      );
      const soft = await store.edges.links.create(hub, spoke, {});
      const hard = await store.edges.links.create(hub, spoke, {});

      counts["getEdge"] = 0;
      await store.edges.links.delete(soft.id);
      expect(counts["getEdge"]).toBe(1);
      expect(counts["deleteEdge"]).toBe(1);

      counts["getEdge"] = 0;
      await store.edges.links.hardDelete(hard.id);
      expect(counts["getEdge"]).toBe(1);
      expect(counts["hardDeleteEdge"]).toBe(1);

      expect(await store.edges.links.findFrom(hub)).toHaveLength(0);

      // Absent/tombstoned: the gate alone decides, still one read.
      counts["getEdge"] = 0;
      await store.edges.links.delete(soft.id);
      expect(counts["getEdge"]).toBe(1);
      expect(counts["deleteEdge"]).toBe(1);
    } finally {
      await rawBackend.close();
    }
  });

  it("node hard delete reads once; soft delete keeps its consumed preflight", async () => {
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      const { backend, counts } = withCallCounts(rawBackend);
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("delete_rt_nodes"),
        backend,
      );
      await store.nodes.Spoke.create({ name: "a" }, { id: "a" });
      await store.nodes.Spoke.create({ name: "b" }, { id: "b" });

      counts["getNode"] = 0;
      await store.nodes.Spoke.hardDelete("a" as never);
      expect(counts["getNode"]).toBe(1);
      expect(await store.nodes.Spoke.getById("a" as never)).toBeUndefined();

      // Soft delete's pipeline consumes the pre-image (uniqueness keys),
      // so its in-transaction preflight is deliberate: gate + preflight.
      counts["getNode"] = 0;
      await store.nodes.Spoke.delete("b" as never);
      expect(counts["getNode"]).toBe(2);
      expect(await store.nodes.Spoke.getById("b" as never)).toBeUndefined();
    } finally {
      await rawBackend.close();
    }
  });

  it("a stale gate read degrades to a guarded no-op, recorded history intact", async () => {
    // Simulates the race the transaction recheck must absorb: the gate
    // sees a live row, but the row is tombstoned before the write
    // transaction runs. The tombstone UPDATE's `deleted_at IS NULL`
    // guard makes it a 0-row no-op, and the recorded-capture touch of
    // the unchanged row must not corrupt history.
    const { backend: rawBackend } = createLocalSqliteBackend();
    try {
      let staleEdgeRow: unknown;
      let serveStaleGate = false;
      const lying: GraphBackend = deriveBackend(rawBackend, {
        getEdge: async (graphId: string, id: string) => {
          const row = await rawBackend.getEdge(graphId, id);
          if (serveStaleGate) return staleEdgeRow as never;
          staleEdgeRow = row;
          return row;
        },
      });
      const [store] = await createStoreWithSchema(
        buildCascadeGraph("delete_rt_race"),
        lying,
        { history: true },
      );
      const hub = await store.nodes.Hub.create({ name: "hub" }, { id: "hub" });
      const spoke = await store.nodes.Spoke.create({ name: "s" }, { id: "s" });
      const edge = await store.edges.links.create(hub, spoke, {});
      const beforeDelete = await store.recordedNow();
      if (beforeDelete === undefined) throw new Error("recordedNow required");

      // Prime the stale copy (live row), tombstone for real, then replay
      // the delete against the stale gate.
      await rawBackend.getEdge(store.graphId, edge.id);
      await store.edges.links.delete(edge.id);
      serveStaleGate = true;
      await store.edges.links.delete(edge.id);
      serveStaleGate = false;

      expect(await store.edges.links.findFrom(hub)).toHaveLength(0);
      // Recorded history: visible before the delete, exactly gone after —
      // the spurious touch closed nothing twice and resurrected nothing.
      const view = store.asOfRecorded(beforeDelete);
      const edgesBefore = await view
        .query()
        .from("Hub", "h")
        .traverse("links", "e")
        .to("Spoke", "s")
        .select((ctx) => ({ id: ctx.s.id }))
        .execute();
      expect(edgesBefore).toHaveLength(1);
      const nowRecorded = await store.recordedNow();
      if (nowRecorded === undefined) throw new Error("recordedNow required");
      const edgesAfter = await store
        .asOfRecorded(nowRecorded)
        .query()
        .from("Hub", "h")
        .traverse("links", "e")
        .to("Spoke", "s")
        .select((ctx) => ({ id: ctx.s.id }))
        .execute();
      expect(edgesAfter).toHaveLength(0);
    } finally {
      await rawBackend.close();
    }
  });
});

// ============================================================
// getOrCreate single validation
// ============================================================

function buildCountingGraph(graphId: string) {
  let parseCount = 0;
  const Account = defineNode("Account", {
    schema: z
      .object({ email: z.string(), name: z.string() })
      .superRefine(() => {
        parseCount += 1;
      }),
  });
  const graph = defineGraph({
    id: graphId,
    nodes: {
      Account: {
        type: Account,
        unique: [
          {
            name: "account_email",
            fields: ["email"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });
  return { graph, parses: () => parseCount, reset: () => (parseCount = 0) };
}

describe("getOrCreate validates props once", () => {
  it("getOrCreateByConstraint parses once on the create leg", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const { graph, parses, reset } = buildCountingGraph("goc_single");
      const [store] = await createStoreWithSchema(graph, backend);
      reset();

      const { action } = await store.nodes.Account.getOrCreateByConstraint(
        "account_email",
        { email: "a@example.com", name: "Alice" },
      );
      expect(action).toBe("created");
      expect(parses()).toBe(1);

      // Found leg: also exactly one parse (for the key computation).
      reset();
      const found = await store.nodes.Account.getOrCreateByConstraint(
        "account_email",
        { email: "a@example.com", name: "Alice" },
      );
      expect(found.action).toBe("found");
      expect(parses()).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it("bulkGetOrCreateByConstraint parses once per item", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const { graph, parses, reset } = buildCountingGraph("goc_bulk");
      const [store] = await createStoreWithSchema(graph, backend);
      reset();

      const results = await store.nodes.Account.bulkGetOrCreateByConstraint(
        "account_email",
        [
          { props: { email: "a@example.com", name: "A" } },
          { props: { email: "b@example.com", name: "B" } },
          { props: { email: "c@example.com", name: "C" } },
        ],
      );
      expect(results.map((entry) => entry.action)).toEqual([
        "created",
        "created",
        "created",
      ]);
      expect(parses()).toBe(3);
    } finally {
      await backend.close();
    }
  });
});
