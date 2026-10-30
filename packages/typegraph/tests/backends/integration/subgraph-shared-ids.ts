/**
 * Subgraph walks over nodes of different kinds that share an id.
 *
 * Node rows are keyed by (kind, id), so `Show:m` and `Clip:m` are two distinct
 * nodes. A subgraph walk must start from the node the caller named, step only
 * along edges whose endpoint is the node it stands on (kind and id), and
 * return exactly the nodes it reached. Its result is keyed by id, so a read
 * whose root and returned nodes would share an id across kinds refuses with
 * `SubgraphAmbiguousNodeIdError` instead of letting one node replace another.
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
  KindNotFoundError,
  type NodeKinds,
  SubgraphAmbiguousNodeIdError,
  type SubgraphOptions,
  type SubgraphResult,
  type SubgraphRoot,
} from "../../../src";
import { collectAllEdges } from "../../test-utils";
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

type SharedIdGraph = typeof sharedIdGraph;
type SharedIdStore = InspectableStore<SharedIdGraph>;
type Root = SubgraphRoot<SharedIdGraph>;
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

function nodeKeys(result: Result): readonly string[] {
  return [...result.nodes.values()]
    .map((node) => `${node.kind}:${node.id}`)
    .toSorted();
}

function edgeKeys(result: Result): readonly string[] {
  return collectAllEdges(result.adjacency)
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

function ambiguousNodeId(
  situation: "result" | "root",
  id: string,
  kinds: readonly string[],
): unknown {
  return expect.objectContaining({
    name: "SubgraphAmbiguousNodeIdError",
    code: "SUBGRAPH_AMBIGUOUS_NODE_ID",
    details: { situation, id, kinds },
  });
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

        for (const root of ["b", { kind: "Show", id: "b" }] as Root[]) {
          const result = await form.read(store, root, LINKED);
          expect(rootKey(result)).toBe("Show:b");
          expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
          expect(edgeKeys(result)).toEqual(["Show:b->Clip:x"]);
        }
      });

      it("walks through a same-id node of another kind to the nodes beyond it", async () => {
        await seedChainThroughSharedId(store);

        const result = await form.read(store, "a" as Root, {
          ...LINKED,
          includeKinds: ["Clip"],
        });
        expect(result.root).toBeUndefined();
        expect(nodeKeys(result)).toEqual(["Clip:m", "Clip:z"]);
        expect(edgeKeys(result)).toEqual([]);
      });

      it("refuses a result that would hold two kinds under one id", async () => {
        await seedChainThroughSharedId(store);

        await expect(form.read(store, "a" as Root, LINKED)).rejects.toThrow(
          SubgraphAmbiguousNodeIdError,
        );
        await expect(
          form.read(store, { kind: "Show", id: "a" } as Root, LINKED),
        ).rejects.toEqual(ambiguousNodeId("result", "m", ["Clip", "Show"]));
      });

      it("refuses a bare root id that two visible kinds hold", async () => {
        await seedSharedRootId(store);

        await expect(form.read(store, "a" as Root, LINKED)).rejects.toEqual(
          ambiguousNodeId("root", "a", ["Clip", "Show"]),
        );
      });

      it("starts from the kind a reference root names", async () => {
        await seedSharedRootId(store);

        const fromShow = await form.read(
          store,
          { kind: "Show", id: "a" } as Root,
          LINKED,
        );
        expect(rootKey(fromShow)).toBe("Show:a");
        expect(nodeKeys(fromShow)).toEqual(["Clip:k", "Show:a"]);

        const fromClip = await form.read(
          store,
          { kind: "Clip", id: "a" } as Root,
          LINKED,
        );
        expect(rootKey(fromClip)).toBe("Clip:a");
        expect(nodeKeys(fromClip)).toEqual(["Clip:a"]);
      });

      it("counts the root against the result when excludeRoot drops it", async () => {
        const showA = await store.nodes.Show.create({}, { id: "a" });
        const clipA = await store.nodes.Clip.create({}, { id: "a" });
        const clipB = await store.nodes.Clip.create({}, { id: "b" });
        await store.edges.linked.create(showA, clipA, {});
        await store.edges.linked.create(showA, clipB, {});
        const root = { kind: "Show", id: "a" } as Root;

        for (const excludeRoot of [false, true]) {
          await expect(
            form.read(store, root, { ...LINKED, excludeRoot }),
          ).rejects.toEqual(ambiguousNodeId("result", "a", ["Clip", "Show"]));
        }
        await expect(
          form.read(store, root, { ...LINKED, includeKinds: ["Clip"] }),
        ).rejects.toEqual(ambiguousNodeId("result", "a", ["Clip", "Show"]));
      });

      it("keys both directions of a step on the node it stands on", async () => {
        await seedUnreachableSharedId(store);
        await seedEdgeIntoSharedId(store);
        const options = { ...LINKED, direction: "both" } as const;

        const result = await form.read(
          store,
          { kind: "Clip", id: "x" } as Root,
          options,
        );
        expect(rootKey(result)).toBe("Clip:x");
        expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
        expect(edgeKeys(result)).toEqual(["Show:b->Clip:x"]);

        await expect(form.read(store, "x" as Root, options)).rejects.toEqual(
          ambiguousNodeId("root", "x", ["Clip", "Show"]),
        );
      });

      it("keys a windowed incoming step on the node it stands on", async () => {
        await seedUnreachableSharedId(store);
        await seedEdgeIntoSharedId(store);

        const result = await form.read(
          store,
          { kind: "Clip", id: "x" } as Root,
          { ...LINKED, edgeWindows: { linked: { direction: "in", limit: 5 } } },
        );
        expect(rootKey(result)).toBe("Clip:x");
        expect(nodeKeys(result)).toEqual(["Clip:x", "Show:b"]);
        expect(edgeKeys(result)).toEqual(["Show:b->Clip:x"]);
      });

      it("returns an empty result for a reference root that is not visible", async () => {
        await seedSharedRootId(store);

        const result = await form.read(
          store,
          { kind: "Clip", id: "k-missing" } as Root,
          LINKED,
        );
        expect(result.root).toBeUndefined();
        expect(result.nodes.size).toBe(0);
        expect(result.adjacency.size).toBe(0);
      });

      it("refuses a reference root of an unregistered kind", async () => {
        await expect(
          form.read(store, { kind: "Episode", id: "a" } as never, LINKED),
        ).rejects.toThrow(KindNotFoundError);
      });

      it("reads a graph whose ids do not repeat across kinds as before", async () => {
        const show = await store.nodes.Show.create({});
        const clip = await store.nodes.Clip.create({});
        const sequel = await store.nodes.Show.create({});
        await store.edges.linked.create(show, clip, {});
        await store.edges.linked.create(clip, sequel, {});

        const result = await form.read(store, show.id, LINKED);
        expect(result.root?.id).toBe(show.id);
        expect([...result.nodes.keys()].toSorted()).toEqual(
          [show.id, clip.id, sequel.id].toSorted(),
        );
        expect(result.adjacency.get(show.id)?.get("linked")?.[0]?.toId).toBe(
          clip.id,
        );
        expect(
          result.reverseAdjacency.get(sequel.id)?.get("linked")?.[0]?.fromId,
        ).toBe(clip.id);

        const withoutRoot = await form.read(store, show.id, {
          ...LINKED,
          excludeRoot: true,
        });
        expect(withoutRoot.root).toBeUndefined();
        expect([...withoutRoot.nodes.keys()].toSorted()).toEqual(
          [clip.id, sequel.id].toSorted(),
        );
      });
    });

    it("keeps every shared-traversal request on the root it named", async () => {
      await seedUnreachableSharedId(store);
      await seedSharedRootId(store);

      const [fromShowA, fromClipA, fromShowB, fromBareB, fromClipX] =
        await store.batchOnce(
          (read) =>
            [
              read.subgraph({ kind: "Show", id: "a" } as Root, LINKED),
              read.subgraph({ kind: "Clip", id: "a" } as Root, LINKED),
              read.subgraph({ kind: "Show", id: "b" } as Root, LINKED),
              read.subgraph("b" as Root, LINKED),
              read.subgraph({ kind: "Clip", id: "x" } as Root, LINKED),
            ] as const,
          { shareSubgraphs: true },
        );
      expect(rootKey(fromShowA)).toBe("Show:a");
      expect(nodeKeys(fromShowA)).toEqual(["Clip:k", "Show:a"]);
      expect(edgeKeys(fromShowA)).toEqual(["Show:a->Clip:k"]);
      expect(rootKey(fromClipA)).toBe("Clip:a");
      expect(nodeKeys(fromClipA)).toEqual(["Clip:a"]);
      expect(nodeKeys(fromShowB)).toEqual(["Clip:x", "Show:b"]);
      expect(nodeKeys(fromBareB)).toEqual(["Clip:x", "Show:b"]);
      expect(rootKey(fromClipX)).toBe("Clip:x");
      expect(nodeKeys(fromClipX)).toEqual(["Clip:x"]);
      expect(edgeKeys(fromClipX)).toEqual([]);
    });

    it("resolves a bare root id at the read's valid-time coordinate", async () => {
      const showA = await store.nodes.Show.create(
        {},
        { id: "a", validFrom: "2020-01-01T00:00:00.000Z" },
      );
      const clipK = await store.nodes.Clip.create(
        {},
        { id: "k", validFrom: "2020-01-01T00:00:00.000Z" },
      );
      await store.edges.linked.create(
        showA,
        clipK,
        {},
        { validFrom: "2020-01-01T00:00:00.000Z" },
      );
      await store.nodes.Clip.create(
        {},
        { id: "a", validFrom: "2024-01-01T00:00:00.000Z" },
      );
      const before = "2022-01-01T00:00:00.000Z";

      const pinned = await store.asOf(before).subgraph("a" as Root, LINKED);
      expect(rootKey(pinned)).toBe("Show:a");
      expect(nodeKeys(pinned)).toEqual(["Clip:k", "Show:a"]);

      const optioned = await store.subgraph("a" as Root, {
        ...LINKED,
        temporalMode: "asOf",
        asOf: before,
      });
      expect(rootKey(optioned)).toBe("Show:a");

      await expect(store.subgraph("a" as Root, LINKED)).rejects.toEqual(
        ambiguousNodeId("root", "a", ["Clip", "Show"]),
      );
    });

    it("resolves a bare root id at the read's recorded coordinate", async () => {
      const historyStore = await context.createHistoryStore(sharedIdGraph);
      const first = await historyStore.transactionWithReceipt(async (tx) => {
        const showA = await tx.nodes.Show.create({}, { id: "a" });
        const clipK = await tx.nodes.Clip.create({}, { id: "k" });
        await tx.edges.linked.create(showA, clipK, {});
      });
      const second = await historyStore.transactionWithReceipt(async (tx) => {
        await tx.nodes.Clip.create({}, { id: "a" });
      });
      const firstRecorded = first.receipt.recorded;
      const secondRecorded = second.receipt.recorded;
      if (firstRecorded === undefined || secondRecorded === undefined) {
        throw new Error("history transactions must record an instant");
      }

      const early = await historyStore
        .asOfRecorded(firstRecorded)
        .subgraph("a" as Root, LINKED);
      expect(rootKey(early)).toBe("Show:a");
      expect(nodeKeys(early)).toEqual(["Clip:k", "Show:a"]);

      await expect(
        historyStore.asOfRecorded(secondRecorded).subgraph("a" as Root, LINKED),
      ).rejects.toEqual(ambiguousNodeId("root", "a", ["Clip", "Show"]));
    });
  });
}
