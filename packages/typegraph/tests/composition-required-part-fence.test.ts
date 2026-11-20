/**
 * Every write that decides whether a required composition part keeps a live
 * whole — restoring the part, or separating it from its whole through its
 * composition edge — is a constrained write: fenced where the backend can hold
 * the per-graph write fence, refused where it cannot. The fenced half is
 * proven against a concurrent PostgreSQL connection
 * (`tests/backends/postgres/concurrent-composition-required-part.test.ts`);
 * this file pins the refused half on a backend with no transactions, and that
 * optional parts and unconstrained edges pay nothing for it.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  CompositionExistenceError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type GraphBackend } from "../src/backend/types";
import { createTestBackend, matchingObject } from "./test-utils";

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({ name: z.string() }) });
const Note = defineNode("Note", { schema: z.object({}) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });
const noteOf = defineEdge("noteOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition-required-part-fence",
  nodes: { Show: { type: Show }, Clip: { type: Clip }, Note: { type: Note } },
  edges: {
    clipOf: {
      type: clipOf,
      from: [Clip],
      to: [Show],
      cardinality: "oneActive",
    },
    noteOf: { type: noteOf, from: [Note], to: [Show], cardinality: "one" },
  },
  ontology: [
    partOf(Clip, Show, { via: clipOf, existence: "required" }),
    partOf(Note, Show, { via: noteOf }),
  ],
});

const FENCE_REFUSAL = matchingObject({
  name: "ConfigurationError",
  details: matchingObject({
    code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED",
    constraint: "edgeComposition",
  }),
});

/**
 * A backend with no transactions, seeded through its raw members: every
 * composition attach is itself a constrained write it refuses.
 */
async function withTransactionlessStore(
  run: (
    store: ReturnType<typeof createStore<typeof graph>>,
    backend: GraphBackend,
  ) => Promise<void>,
): Promise<void> {
  const sqlite = new Database(":memory:");
  for (const statement of generateSqliteDDL()) sqlite.exec(statement);
  const backend = createSqliteBackend(drizzle(sqlite), {
    executionProfile: { transactionMode: "none", isSync: true },
  });
  try {
    const seed = (kind: string, id: string, props: Record<string, unknown>) =>
      backend.insertNode({ graphId: graph.id, kind, id, props });
    await seed("Show", "show", {});
    await seed("Clip", "clip", { name: "Clip" });
    await seed("Note", "note", {});
    for (const [kind, id, fromKind, fromId] of [
      ["clipOf", "clip-of", "Clip", "clip"],
      ["noteOf", "note-of", "Note", "note"],
    ] as const) {
      await backend.insertEdge({
        graphId: graph.id,
        kind,
        id,
        fromKind,
        fromId,
        toKind: "Show",
        toId: "show",
        props: {},
      });
    }
    await run(createStore(graph, backend), backend);
  } finally {
    sqlite.close();
  }
}

describe("the required-part composition fence on a backend without transactions", () => {
  it("refuses every detach of a required part's composition edge, and keeps the edge", async () => {
    await withTransactionlessStore(async (store) => {
      const edgeId = asEdgeId<typeof clipOf>("clip-of");
      // MUTATION CHECK: answer `undefined` from
      // `edgeDetachNeedsConstraintFence` (src/store/constraints.ts) — each
      // detach then runs unfenced and is refused only by the part-liveness
      // read, as `CompositionExistenceError`.
      const detaches: readonly (() => Promise<unknown>)[] = [
        () => store.edges.clipOf.delete(edgeId),
        () => store.edges.clipOf.hardDelete(edgeId),
        () => store.edges.clipOf.bulkDelete([edgeId]),
        () =>
          store.edges.clipOf.update(
            edgeId,
            {},
            { validTo: new Date().toISOString() },
          ),
      ];
      for (const detach of detaches) {
        await expect(detach()).rejects.toThrow(FENCE_REFUSAL);
      }
      const edge = await store.edges.clipOf.getById(edgeId);
      expect(edge?.meta.validTo).toBeUndefined();
    });
  });

  it("refuses restoring a tombstoned required part, and leaves it tombstoned", async () => {
    await withTransactionlessStore(async (store, backend) => {
      await backend.deleteNode({ graphId: graph.id, kind: "Clip", id: "clip" });
      // MUTATION CHECK: answer `undefined` from
      // `nodeRestoreNeedsConstraintFence` (src/store/constraints.ts) — every
      // restore then succeeds unfenced, since the edge to the live show
      // survived the tombstone.
      const restores: readonly (() => Promise<unknown>)[] = [
        () => store.nodes.Clip.upsertById("clip", { name: "Back" }),
        () =>
          store.nodes.Clip.bulkUpsertById([
            { id: "clip", props: { name: "Back" } },
          ]),
        () =>
          store.nodes.Clip.bulkReplaceById([
            { id: "clip", props: { name: "Back" } },
          ]),
      ];
      for (const restore of restores) {
        await expect(restore()).rejects.toThrow(FENCE_REFUSAL);
      }
      await expect(
        store.nodes.Clip.getById("clip" as never),
      ).resolves.toBeUndefined();
    });
  });

  it("charges an optional part's detach and restore nothing", async () => {
    await withTransactionlessStore(async (store, backend) => {
      await store.edges.noteOf.delete(asEdgeId<typeof noteOf>("note-of"));
      await backend.deleteNode({ graphId: graph.id, kind: "Note", id: "note" });
      await store.nodes.Note.upsertById("note", {});
      await expect(
        store.nodes.Note.getById("note" as never),
      ).resolves.toBeDefined();
    });
  });
});

type EdgeDetach = Readonly<{
  name: string;
  run: (
    store: ReturnType<typeof createStore<typeof graph>>,
    edgeId: ReturnType<typeof asEdgeId<typeof clipOf>>,
  ) => Promise<unknown>;
}>;

const SINGLE_EDGE_DETACHES: readonly EdgeDetach[] = [
  { name: "delete", run: (store, edgeId) => store.edges.clipOf.delete(edgeId) },
  {
    name: "hardDelete",
    run: (store, edgeId) => store.edges.clipOf.hardDelete(edgeId),
  },
];

describe("a single edge detach judged against the row the fence holds", () => {
  for (const detach of SINGLE_EDGE_DETACHES) {
    it(`${detach.name} refuses when the part was restored onto a reopened window after the delete read its gate row`, async () => {
      const backend = createTestBackend();
      const edgeId = asEdgeId<typeof clipOf>("clip-of");
      await backend.insertNode({
        graphId: graph.id,
        kind: "Show",
        id: "show",
        props: {},
      });
      await backend.insertNode({
        graphId: graph.id,
        kind: "Clip",
        id: "clip",
        props: { name: "Clip" },
      });
      // An ended attachment of a tombstoned part: detaching it orphans
      // nothing, which is what the gate row read below shows.
      await backend.insertEdge({
        graphId: graph.id,
        kind: "clipOf",
        id: edgeId,
        fromKind: "Clip",
        fromId: "clip",
        toKind: "Show",
        toId: "show",
        props: {},
        validTo: "2020-01-01T00:00:00.000Z",
      });
      await backend.deleteNode({ graphId: graph.id, kind: "Clip", id: "clip" });

      const peer = createStore(graph, backend);
      const interleaved = { done: false };
      // The peer runs to commit inside the detach's lock-free gate read, after
      // that read has answered: SQLite admits one writer at a time, so this
      // is the only point at which a write can land between the gate and
      // the detach's fenced frame.
      const detacher = createStore(
        graph,
        deriveBackend(backend, {
          getEdge: async (graphId, id) => {
            const row = await backend.getEdge(graphId, id);
            if (!interleaved.done && id === edgeId) {
              interleaved.done = true;
              await peer.edges.clipOf.update(
                edgeId,
                {},
                { clearValidTo: true },
              );
              await peer.nodes.Clip.upsertById("clip", { name: "Back" });
            }
            return row;
          },
        }),
      );

      // MUTATION CHECK: return `gate` unconditionally from
      // `readEdgeDetachVerdictRow` (src/store/operations/edge-operations.ts)
      // — the detach then judges the ended gate row, succeeds, and leaves the
      // restored clip with no live whole.
      await expect(detach.run(detacher, edgeId)).rejects.toBeInstanceOf(
        CompositionExistenceError,
      );
      expect(interleaved.done).toBe(true);
      const edge = await peer.edges.clipOf.getById(edgeId);
      expect(edge?.meta.validTo).toBeUndefined();
      expect(await peer.verifyConstraintFences()).toEqual([]);
    });
  }
});
