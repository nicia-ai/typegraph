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
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";

// ============================================================
// Call-counting overlay (follows the write transaction)
// ============================================================

type CallCounts = Record<string, number>;

const COUNTED_METHODS = [
  "deleteEdge",
  "deleteEdgesBatch",
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
    const wrapped = { ...target } as Record<string, unknown>;
    for (const name of COUNTED_METHODS) {
      const original = (target as Record<string, unknown>)[name];
      if (typeof original !== "function") continue;
      wrapped[name] = (...args: unknown[]) => {
        counts[name] = (counts[name] ?? 0) + 1;
        return (original as (...a: unknown[]) => unknown).apply(target, args);
      };
    }
    return wrapped as T;
  }

  const outer = wrapMethods(backend);
  const counted: GraphBackend = {
    ...outer,
    transaction: (fn, options) =>
      backend.transaction((target, tx) => fn(wrapMethods(target), tx), options),
  };
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

      expect(counts.deleteEdgesBatch).toBe(1);
      expect(counts.deleteEdge).toBe(0);
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

      expect(counts.hardDeleteEdgesBatch).toBe(1);
      expect(counts.hardDeleteEdge).toBe(0);
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
