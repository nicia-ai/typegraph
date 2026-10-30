/**
 * Subgraph walks over nodes of different kinds that share an id.
 *
 * Node rows are keyed by (kind, id), so `Show:m` and `Clip:m` are two distinct
 * nodes. A subgraph walk must start from the node the caller's reference
 * names, step only along edges whose endpoint is the node it stands on (kind
 * and id), and return exactly the nodes it reached: both same-id nodes when it
 * reaches both, each addressable by its own (kind, id).
 *
 * Every case runs through each subgraph read path: the direct read (which
 * takes each backend's own membership strategy), the transaction read, the
 * one-statement `batchOnce` read, and the shared `batchOnce` traversal.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphNodeReference,
  KindNotFoundError,
  type NodeKinds,
  type SubgraphOptions,
  type SubgraphResult,
  ValidationError,
} from "../../../src";
import type { InspectableStore, IntegrationTestContext } from "./test-context";

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({}) });
const linked = defineEdge("linked", { schema: z.object({}) });

const sharedIdGraph = defineGraph({
  id: "subgraph_shared_id_kinds",
  nodes: {
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    linked: { type: linked, from: [Show, Clip], to: [Show, Clip] },
  },
});

/** The same graph under the identity profile that folds same-id nodes. */
const foldedIdGraph = defineGraph({
  id: "subgraph_folded_id_kinds",
  nodes: {
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    linked: { type: linked, from: [Show, Clip], to: [Show, Clip] },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

type SharedIdGraph = typeof sharedIdGraph;
type SharedIdStore = InspectableStore<SharedIdGraph>;
type Root = GraphNodeReference<SharedIdGraph>;
type Options = SubgraphOptions<
  SharedIdGraph,
  "linked",
  NodeKinds<SharedIdGraph>
>;
type Result = SubgraphResult<SharedIdGraph, NodeKinds<SharedIdGraph>, "linked">;

type ReadForm = Readonly<{
  name: string;
  read: (store: SharedIdStore, root: Root, options: Options) => Promise<Result>;
}>;

const READ_FORMS: readonly ReadForm[] = [
  {
    name: "store.subgraph",
    read: (store, root, options) => store.subgraph(root, options),
  },
  {
    name: "transaction subgraph",
    read: (store, root, options) =>
      store.transaction((tx) => tx.subgraph(root, options)),
  },
  {
    name: "batchOnce read.subgraph",
    read: async (store, root, options) => {
      const [result] = await store.batchOnce(
        (read) => [read.subgraph(root, options)] as const,
      );
      return result;
    },
  },
  {
    name: "batchOnce shared traversal",
    read: async (store, root, options) => {
      const [result, repeated] = await store.batchOnce(
        (read) =>
          [read.subgraph(root, options), read.subgraph(root, options)] as const,
        { shareSubgraphs: true },
      );
      if (nodeKeys(repeated).join(",") !== nodeKeys(result).join(",")) {
        throw new Error(
          "Shared requests for one root returned different nodes",
        );
      }
      return result;
    },
  },
];

const LINKED = { edges: ["linked"] } as const satisfies Options;

function ref(kind: "Clip" | "Show", id: string): Root {
  return { kind, id } as Root;
}

function nodeKeys(result: Result): readonly string[] {
  return result.nodes.map((node) => `${node.kind}:${node.id}`);
}

function edgeKeys(edges: Result["edges"]): readonly string[] {
  return edges
    .map(
      (edge) => `${edge.fromKind}:${edge.fromId}->${edge.toKind}:${edge.toId}`,
    )
    .toSorted();
}

function rootKey(result: Result): string | undefined {
  return result.root === undefined ?
      undefined
    : `${result.root.kind}:${result.root.id}`;
}

/** `Show:a → Clip:m → Show:m → Clip:z`: the walk passes through both `m`s. */
async function seedChainThroughSharedId(store: SharedIdStore): Promise<void> {
  const showA = await store.nodes.Show.create({}, { id: "a" });
  const clipM = await store.nodes.Clip.create({}, { id: "m" });
  const showM = await store.nodes.Show.create({}, { id: "m" });
  const clipZ = await store.nodes.Clip.create({}, { id: "z" });
  await store.edges.linked.create(showA, clipM, {});
  await store.edges.linked.create(clipM, showM, {});
  await store.edges.linked.create(showM, clipZ, {});
}

/** `Show:b → Clip:x` and an unconnected `Show:x → Show:y`. */
async function seedUnreachableSharedId(store: SharedIdStore): Promise<void> {
  const showB = await store.nodes.Show.create({}, { id: "b" });
  const clipX = await store.nodes.Clip.create({}, { id: "x" });
  const showX = await store.nodes.Show.create({}, { id: "x" });
  const showY = await store.nodes.Show.create({}, { id: "y" });
  await store.edges.linked.create(showB, clipX, {});
  await store.edges.linked.create(showX, showY, {});
}

/**
 * Adds `Show:w → Show:x` to {@link seedUnreachableSharedId}: an edge INTO the
 * node that shares `Clip:x`'s id, so an incoming step keyed on the id alone
 * would reach `Show:w`.
 */
async function seedEdgeIntoSharedId(store: SharedIdStore): Promise<void> {
  const showW = await store.nodes.Show.create({}, { id: "w" });
  const showX = await store.nodes.Show.getById("x" as never);
  if (showX === undefined) throw new Error("Seed Show:x before this edge");
  await store.edges.linked.create(showW, showX, {});
}

/** `Show:a → Clip:k` and an unconnected `Clip:a`. */
async function seedSharedRootId(store: SharedIdStore): Promise<void> {
  const showA = await store.nodes.Show.create({}, { id: "a" });
  const clipK = await store.nodes.Clip.create({}, { id: "k" });
  await store.nodes.Clip.create({}, { id: "a" });
  await store.edges.linked.create(showA, clipK, {});
}

export function registerSubgraphSharedIdIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Subgraph walks across kinds that share an id", () => {
    let store: SharedIdStore;

    beforeEach(async () => {
      store = await context.createStore(sharedIdGraph);
    });

    describe.each(READ_FORMS)("$name", (form) => {
      it("does not follow the edges of an unreached node that shares an id", async () => {
        await seedUnreachableSharedId(store);

        const result = await form.read(store, ref("Show", "b"), LINKED);
        expect(rootKey(result)).toBe("Show:b");
        expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
        expect(edgeKeys(result.edges)).toEqual(["Show:b->Clip:x"]);
        expect(result.node(ref("Show", "x"))).toBeUndefined();
      });

      it("returns both same-id nodes it reaches, each under its own kind", async () => {
        await seedChainThroughSharedId(store);

        const result = await form.read(store, ref("Show", "a"), LINKED);
        expect(rootKey(result)).toBe("Show:a");
        expect(nodeKeys(result)).toEqual([
          "Clip:m",
          "Clip:z",
          "Show:a",
          "Show:m",
        ]);
        expect(result.node(ref("Clip", "m"))?.kind).toBe("Clip");
        expect(result.node(ref("Show", "m"))?.kind).toBe("Show");
        expect(edgeKeys(result.outgoing(ref("Clip", "m")))).toEqual([
          "Clip:m->Show:m",
        ]);
        expect(edgeKeys(result.outgoing(ref("Show", "m")))).toEqual([
          "Show:m->Clip:z",
        ]);
        expect(edgeKeys(result.incoming(ref("Show", "m"), "linked"))).toEqual([
          "Clip:m->Show:m",
        ]);
      });

      it("walks through a same-id node of another kind to the nodes beyond it", async () => {
        await seedChainThroughSharedId(store);

        const result = await form.read(store, ref("Show", "a"), {
          ...LINKED,
          includeKinds: ["Clip"],
        });
        expect(result.root).toBeUndefined();
        expect(nodeKeys(result)).toEqual(["Clip:m", "Clip:z"]);
        expect(result.edges).toEqual([]);
      });

      it("starts from the kind the root reference names", async () => {
        await seedSharedRootId(store);

        const fromShow = await form.read(store, ref("Show", "a"), LINKED);
        expect(rootKey(fromShow)).toBe("Show:a");
        expect(nodeKeys(fromShow)).toEqual(["Clip:k", "Show:a"]);

        const fromClip = await form.read(store, ref("Clip", "a"), LINKED);
        expect(rootKey(fromClip)).toBe("Clip:a");
        expect(nodeKeys(fromClip)).toEqual(["Clip:a"]);
      });

      it("excludes only the root node when excludeRoot is set", async () => {
        const showA = await store.nodes.Show.create({}, { id: "a" });
        const clipA = await store.nodes.Clip.create({}, { id: "a" });
        const clipB = await store.nodes.Clip.create({}, { id: "b" });
        await store.edges.linked.create(showA, clipA, {});
        await store.edges.linked.create(showA, clipB, {});

        const withRoot = await form.read(store, ref("Show", "a"), LINKED);
        expect(rootKey(withRoot)).toBe("Show:a");
        expect(nodeKeys(withRoot)).toEqual(["Clip:a", "Clip:b", "Show:a"]);

        const withoutRoot = await form.read(store, ref("Show", "a"), {
          ...LINKED,
          excludeRoot: true,
        });
        expect(withoutRoot.root).toBeUndefined();
        expect(nodeKeys(withoutRoot)).toEqual(["Clip:a", "Clip:b"]);
        expect(withoutRoot.edges).toEqual([]);
      });

      it("keys both directions of a step on the node it stands on", async () => {
        await seedUnreachableSharedId(store);
        await seedEdgeIntoSharedId(store);

        const result = await form.read(store, ref("Clip", "x"), {
          ...LINKED,
          direction: "both",
        });
        expect(rootKey(result)).toBe("Clip:x");
        expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
        expect(edgeKeys(result.edges)).toEqual(["Show:b->Clip:x"]);
      });

      it("keys a windowed incoming step on the node it stands on", async () => {
        await seedUnreachableSharedId(store);
        await seedEdgeIntoSharedId(store);

        const result = await form.read(store, ref("Clip", "x"), {
          ...LINKED,
          edgeWindows: { linked: { direction: "in", limit: 5 } },
        });
        expect(rootKey(result)).toBe("Clip:x");
        expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
        expect(edgeKeys(result.edges)).toEqual(["Show:b->Clip:x"]);
      });

      it("returns an empty result for a root reference that is not visible", async () => {
        await seedSharedRootId(store);

        const result = await form.read(store, ref("Clip", "k-missing"), LINKED);
        expect(result.root).toBeUndefined();
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
      });

      it("refuses a root reference of an unregistered kind", async () => {
        await expect(
          form.read(store, { kind: "Episode", id: "a" } as never, LINKED),
        ).rejects.toThrow(KindNotFoundError);
      });

      it("refuses a bare id root", async () => {
        await expect(form.read(store, "a" as never, LINKED)).rejects.toThrow(
          ValidationError,
        );
      });

      it("reads a graph whose ids do not repeat across kinds", async () => {
        const show = await store.nodes.Show.create({});
        const clip = await store.nodes.Clip.create({});
        const sequel = await store.nodes.Show.create({});
        await store.edges.linked.create(show, clip, {});
        await store.edges.linked.create(clip, sequel, {});

        const result = await form.read(store, show, LINKED);
        expect(result.root?.id).toBe(show.id);
        expect(result.nodes.map((node) => node.id).toSorted()).toEqual(
          [show.id, clip.id, sequel.id].toSorted(),
        );
        expect(result.outgoing(show, "linked")[0]?.toId).toBe(clip.id);
        expect(result.incoming(sequel)[0]?.fromId).toBe(clip.id);

        const withoutRoot = await form.read(store, show, {
          ...LINKED,
          excludeRoot: true,
        });
        expect(withoutRoot.root).toBeUndefined();
        expect(withoutRoot.nodes.map((node) => node.id).toSorted()).toEqual(
          [clip.id, sequel.id].toSorted(),
        );
      });
    });

    it("looks up an edge's endpoints directly", async () => {
      await seedChainThroughSharedId(store);

      const result = await store.subgraph(ref("Show", "a"), LINKED);
      const targets = result.edges.map((edge) =>
        result.node({ kind: edge.toKind, id: edge.toId }),
      );
      const sources = result.edges.map((edge) =>
        result.node({ kind: edge.fromKind, id: edge.fromId }),
      );
      expect(targets.map((node) => `${node?.kind}:${node?.id}`)).toEqual(
        result.edges.map((edge) => `${edge.toKind}:${edge.toId}`),
      );
      expect(sources.every((node) => node !== undefined)).toBe(true);
    });

    it("keeps every shared-traversal request on the root it named", async () => {
      await seedUnreachableSharedId(store);
      await seedSharedRootId(store);

      const [fromShowA, fromClipA, fromShowB, fromClipX] =
        await store.batchOnce(
          (read) =>
            [
              read.subgraph(ref("Show", "a"), LINKED),
              read.subgraph(ref("Clip", "a"), LINKED),
              read.subgraph(ref("Show", "b"), LINKED),
              read.subgraph(ref("Clip", "x"), LINKED),
            ] as const,
          { shareSubgraphs: true },
        );
      expect(rootKey(fromShowA)).toBe("Show:a");
      expect(nodeKeys(fromShowA)).toEqual(["Clip:k", "Show:a"]);
      expect(edgeKeys(fromShowA.edges)).toEqual(["Show:a->Clip:k"]);
      expect(rootKey(fromClipA)).toBe("Clip:a");
      expect(nodeKeys(fromClipA)).toEqual(["Clip:a"]);
      expect(nodeKeys(fromShowB)).toEqual(["Clip:x", "Show:b"]);
      expect(rootKey(fromClipX)).toBe("Clip:x");
      expect(nodeKeys(fromClipX)).toEqual(["Clip:x"]);
      expect(fromClipX.edges).toEqual([]);
    });

    it("returns both folded peers on a graph that folds same-id nodes", async () => {
      const folded = await context.createStore(foldedIdGraph);
      const showP = await folded.nodes.Show.create({}, { id: "p" });
      const clipP = await folded.nodes.Clip.create({}, { id: "p" });
      const showQ = await folded.nodes.Show.create({}, { id: "q" });
      await folded.edges.linked.create(showP, showQ, {});
      await folded.edges.linked.create(clipP, showQ, {});

      const result = await folded.subgraph(showP, {
        edges: ["linked"],
        direction: "both",
      });
      expect(result.root?.kind).toBe("Show");
      expect(result.nodes.map((node) => `${node.kind}:${node.id}`)).toEqual([
        "Clip:p",
        "Show:p",
        "Show:q",
      ]);
      expect(result.incoming(showQ).map((edge) => edge.fromKind)).toEqual(
        expect.arrayContaining(["Clip", "Show"]),
      );
    });

    it("reads the nodes visible at the read's valid-time coordinate", async () => {
      const past = "2020-01-01T00:00:00.000Z";
      const later = "2024-01-01T00:00:00.000Z";
      const showA = await store.nodes.Show.create(
        {},
        { id: "a", validFrom: past },
      );
      const clipA = await store.nodes.Clip.create(
        {},
        { id: "a", validFrom: later },
      );
      await store.edges.linked.create(showA, clipA, {}, { validFrom: later });
      const before = "2022-01-01T00:00:00.000Z";

      const pinned = await store.asOf(before).subgraph(showA, LINKED);
      expect(nodeKeys(pinned)).toEqual(["Show:a"]);

      const optioned = await store.subgraph(showA, {
        ...LINKED,
        temporalMode: "asOf",
        asOf: before,
      });
      expect(nodeKeys(optioned)).toEqual(["Show:a"]);

      const current = await store.subgraph(showA, LINKED);
      expect(nodeKeys(current)).toEqual(["Clip:a", "Show:a"]);
    });

    it("reads the nodes visible at the read's recorded coordinate", async () => {
      const historyStore = await context.createHistoryStore(sharedIdGraph);
      const first = await historyStore.transactionWithReceipt(async (tx) => {
        await tx.nodes.Show.create({}, { id: "a" });
      });
      const second = await historyStore.transactionWithReceipt(async (tx) => {
        const showA = await tx.nodes.Show.getById("a" as never);
        if (showA === undefined) throw new Error("Show:a must exist");
        const clipA = await tx.nodes.Clip.create({}, { id: "a" });
        await tx.edges.linked.create(showA, clipA, {});
      });
      const firstRecorded = first.receipt.recorded;
      const secondRecorded = second.receipt.recorded;
      if (firstRecorded === undefined || secondRecorded === undefined) {
        throw new Error("history transactions must record an instant");
      }

      const early = await historyStore
        .asOfRecorded(firstRecorded)
        .subgraph(ref("Show", "a"), LINKED);
      expect(nodeKeys(early)).toEqual(["Show:a"]);

      const late = await historyStore
        .asOfRecorded(secondRecorded)
        .subgraph(ref("Show", "a"), LINKED);
      expect(nodeKeys(late)).toEqual(["Clip:a", "Show:a"]);
    });
  });
}
