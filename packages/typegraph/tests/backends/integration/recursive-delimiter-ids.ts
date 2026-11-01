/**
 * Recursive walks over node ids that hold the characters a dialect's path
 * encoding is built from.
 *
 * SQLite tracks a recursive walk's path as one delimited string, so an id
 * holding the delimiter (`|`), the escape character (`%`) or a literal escape
 * sequence (`%7C`) must neither read as a revisit of another node nor come
 * back split in `path` output. PostgreSQL tracks a native array, so the same
 * cases certify that both backends agree.
 *
 * Chain (every node a Clip):
 *
 *   a|b → b → %7C → | → % → %25 → <U+001F> → a|b
 *
 * Each id after the root is a substring or an unescaped spelling of an earlier
 * token, so a delimiter-unaware cycle check stops the walk early. The last
 * edge closes a real cycle, which must still stop the walk.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "../../../src";
import type { InspectableStore, IntegrationTestContext } from "./test-context";

const CHAIN_IDS = ["a|b", "b", "%7C", "|", "%", "%25", "\u001F"] as const;
const ROOT_ID = CHAIN_IDS[0];

// A Show whose id spells `prefix|` followed by Clip:child's kind-qualified
// token, so a delimiter-unaware path holding the Show's token already holds
// Clip:child's.
const COMPOSITE_SHOW_ID = "prefix|Clip\u001Fchild";
const COMPOSITE_CHILD_ID = "child";

const Media = defineNode("Media", { schema: z.object({}) });
const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({}) });
const linked = defineEdge("linked", { schema: z.object({}) });

const delimiterIdGraph = defineGraph({
  id: "recursive_delimiter_ids",
  nodes: {
    Media: { type: Media },
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    linked: {
      type: linked,
      from: [Media, Show, Clip],
      to: [Media, Show, Clip],
    },
  },
  ontology: [subClassOf(Show, Media), subClassOf(Clip, Media)],
});

type DelimiterIdStore = InspectableStore<typeof delimiterIdGraph>;

async function seedChain(store: DelimiterIdStore): Promise<void> {
  const clips = [];
  for (const id of CHAIN_IDS) {
    clips.push(await store.nodes.Clip.create({}, { id }));
  }
  for (const [index, clip] of clips.entries()) {
    const next = clips[(index + 1) % clips.length];
    if (next === undefined) throw new Error("Chain has no next node");
    await store.edges.linked.create(clip, next, {});
  }
}

/** The rows a walk from the root returns: one per chain node after it. */
function expectedChainRows(): readonly Readonly<{
  id: string;
  depth: number;
  path: readonly string[];
}>[] {
  return CHAIN_IDS.slice(1).map((id, index) => ({
    id,
    depth: index + 1,
    path: CHAIN_IDS.slice(0, index + 2),
  }));
}

function byDepth<T extends Readonly<{ depth: number }>>(
  rows: readonly T[],
): readonly T[] {
  return rows.toSorted((left, right) => left.depth - right.depth);
}

export function registerRecursiveDelimiterIdIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Recursive walks over ids holding path-encoding characters", () => {
    let store: DelimiterIdStore;

    beforeEach(async () => {
      store = await context.createStore(delimiterIdGraph);
    });

    it("walks a single-kind chain without false cycles, stops at the true one, and returns ids verbatim", async () => {
      await seedChain(store);

      const query = store
        .query()
        .from("Clip", "start")
        .whereNode("start", (clip) => clip.id.eq(ROOT_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 20, depth: true, path: true })
        .to("Clip", "clip")
        .select((row) => ({
          id: row.clip.id,
          depth: row.clip_depth,
          path: row.clip_path,
        }));

      expect(byDepth(await query.execute())).toEqual(expectedChainRows());
      expect(byDepth(await query.prepare().execute({}))).toEqual(
        expectedChainRows(),
      );
    });

    it("walks the same chain with kind-qualified tokens", async () => {
      await seedChain(store);

      const rows = await store
        .query()
        .from("Clip", "start")
        .whereNode("start", (clip) => clip.id.eq(ROOT_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 20, depth: true, path: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          id: row.media.id,
          depth: row.media_depth,
          path: row.media_path,
        }))
        .execute();

      expect(byDepth(rows)).toEqual(expectedChainRows());
    });

    it("reaches a node whose kind-qualified token is spelled inside the root's id", async () => {
      const show = await store.nodes.Show.create({}, { id: COMPOSITE_SHOW_ID });
      const child = await store.nodes.Clip.create(
        {},
        { id: COMPOSITE_CHILD_ID },
      );
      await store.edges.linked.create(show, child, {});

      const rows = await store
        .query()
        .from("Show", "show")
        .whereNode("show", (node) => node.id.eq(COMPOSITE_SHOW_ID))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ maxHops: 4, path: true })
        .to("Media", "media", { includeSubClasses: true })
        .select((row) => ({
          kind: row.media.kind,
          id: row.media.id,
          path: row.media_path,
        }))
        .execute();

      expect(rows).toEqual([
        {
          kind: Clip.kind,
          id: COMPOSITE_CHILD_ID,
          path: [COMPOSITE_SHOW_ID, COMPOSITE_CHILD_ID],
        },
      ]);
    });

    it("returns an empty id as one path element, the root's zero-hop row included", async () => {
      const root = await store.nodes.Clip.create({}, { id: "" });
      const next = await store.nodes.Clip.create({}, { id: "x" });
      await store.edges.linked.create(root, next, {});

      const rows = await store
        .query()
        .from("Clip", "start")
        .whereNode("start", (clip) => clip.id.eq(""))
        .traverse("linked", "link", { expand: "none" })
        .recursive({ minHops: 0, maxHops: 2, depth: true, path: true })
        .to("Clip", "clip")
        .select((row) => ({ depth: row.clip_depth, path: row.clip_path }))
        .execute();

      expect(byDepth(rows)).toEqual([
        { depth: 0, path: [""] },
        { depth: 1, path: ["", "x"] },
      ]);
    });

    it("reaches every chain node through store.subgraph", async () => {
      await seedChain(store);

      const result = await store.subgraph(
        { kind: "Clip", id: asNodeId<typeof Clip>(ROOT_ID) },
        { edges: ["linked"], maxDepth: 20 },
      );

      expect(result.nodes.map((node) => node.id).toSorted()).toEqual(
        [...CHAIN_IDS].toSorted(),
      );
    });
  });
}
