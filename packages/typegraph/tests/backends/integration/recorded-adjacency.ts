/* eslint-disable unicorn/no-null -- null explicitly requests an unbounded valid-time start. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CompiledRowsSql,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedAdjacencyEntry,
  type RecordedAdjacencyOptions,
  type RecordedAdjacencyPage,
  type RecordedStoreView,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", { schema: z.object({ label: z.string() }) });
const Group = defineNode("Group", { schema: z.object({ label: z.string() }) });
const links = defineEdge("links", { schema: z.object({ label: z.string() }) });
const other = defineEdge("other", { schema: z.object({}) });
const graph = defineGraph({
  id: "recorded_adjacency",
  nodes: { Item: { type: Item }, Group: { type: Group } },
  edges: {
    links: { type: links, from: [Item, Group], to: [Item, Group] },
    other: { type: other, from: [Item], to: [Item] },
  },
});

async function collect(
  view: RecordedStoreView<typeof graph>,
  root: Parameters<typeof view.adjacency>[0],
  options?: RecordedAdjacencyOptions<"links" | "other">,
  onPage?: (
    page: RecordedAdjacencyPage<RecordedAdjacencyEntry<typeof graph>>,
  ) => void,
) {
  const entries: RecordedAdjacencyEntry<typeof graph>[] = [];
  let after: string | undefined;
  let pages = 0;
  do {
    const page = await view.adjacency(root, {
      ...options,
      limit: 1,
      ...(after === undefined ? {} : { after }),
    });
    onPage?.(page);
    expect(page.data.length).toBeLessThanOrEqual(1);
    expect(page.hasNextPage).toBe(page.nextCursor !== undefined);
    entries.push(...page.data);
    after = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(100);
  } while (after !== undefined);
  return entries;
}

async function projectAdjacency<T>(
  projection: (entry: RecordedAdjacencyEntry<typeof graph>) => T,
  view: RecordedStoreView<typeof graph>,
  root: Parameters<typeof view.adjacency>[0],
  options?: RecordedAdjacencyOptions<"links" | "other">,
): Promise<readonly T[]> {
  const entries = await collect(view, root, options);
  return entries.map((entry) => projection(entry));
}

export function registerRecordedAdjacencyIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("recorded adjacency", () => {
    it("pages pinned edge pairs through versions, parallel edges, self-loops, cycles and cross-kind ids", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { label: "root" },
        { id: "same" },
      );
      const peer = await store.nodes.Item.create(
        { label: "peer" },
        { id: "peer" },
      );
      const group = await store.nodes.Group.create(
        { label: "group" },
        { id: "same" },
      );
      const first = await store.edges.links.create(
        root,
        peer,
        { label: "original" },
        { id: "a" },
      );
      await store.edges.links.update(first.id, { label: "pinned" });
      await store.edges.links.create(
        root,
        peer,
        { label: "parallel" },
        { id: "b" },
      );
      await store.edges.links.create(
        group,
        root,
        { label: "incoming" },
        { id: "c" },
      );
      await store.edges.links.create(
        root,
        root,
        { label: "loop" },
        { id: "d" },
      );
      await store.edges.links.create(
        peer,
        root,
        { label: "cycle" },
        { id: "e" },
      );
      await store.edges.other.create(root, peer, {}, { id: "z" });
      const anchor = requireDefined(await store.recordedNow());
      const view = store.asOfRecorded(anchor);
      const beforePages: RecordedAdjacencyPage<
        RecordedAdjacencyEntry<typeof graph>
      >[] = [];
      await collect(view, root, undefined, (page) => {
        beforePages.push(page);
      });
      const firstPage = await view.adjacency(root, { limit: 1 });
      await store.edges.links.delete(first.id);
      await store.nodes.Item.update(peer.id, { label: "changed" });
      await store.edges.links.create(
        root,
        peer,
        { label: "later" },
        { id: "aa" },
      );
      await store.edges.links.create(
        root,
        peer,
        { label: "later before ids" },
        { id: "0-later" },
      );
      expect(await view.adjacency(root, { limit: 1 })).toEqual(firstPage);
      const afterPages: RecordedAdjacencyPage<
        RecordedAdjacencyEntry<typeof graph>
      >[] = [];
      const entries = await collect(view, root, undefined, (page) => {
        afterPages.push(page);
      });
      expect(afterPages).toEqual(beforePages);
      expect(
        entries.map(({ edge, neighbor }) => [
          edge.kind,
          edge.id,
          neighbor.kind,
          neighbor.id,
        ]),
      ).toEqual([
        ["links", "a", "Item", "peer"],
        ["links", "b", "Item", "peer"],
        ["links", "d", "Item", "same"],
        ["other", "z", "Item", "peer"],
        ["links", "c", "Group", "same"],
        ["links", "e", "Item", "peer"],
      ]);
      expect(entries[0]?.edge).toMatchObject({ label: "pinned" });
      // Continue a cursor minted before those writes; it must reconstruct the
      // same suffix, even when its first candidate was an invisible version.
      const suffix = await view.adjacency(root, {
        limit: 100,
        after: requireDefined(firstPage.nextCursor),
      });
      expect([...firstPage.data, ...suffix.data]).toEqual(entries);
      expect(
        await projectAdjacency(({ edge }) => edge.id, view, root, {
          direction: "in",
          edgeKinds: ["links"],
        }),
      ).toEqual(["c", "d", "e"]);
      expect(
        await collect(view, root, { direction: "out", edgeKinds: [] }),
      ).toEqual([]);
      const current = store.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      expect(
        await projectAdjacency(({ edge }) => edge.id, current, root, {
          direction: "out",
          edgeKinds: ["links"],
        }),
      ).toEqual(["b", "d", "aa", "0-later"]);
    });

    it("pins valid-time modes and rejects mismatched or retired cursors", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { label: "root" },
        { id: "root", validFrom: null },
      );
      const peer = await store.nodes.Item.create(
        { label: "peer" },
        { id: "peer", validFrom: null },
      );
      const edge = await store.edges.links.create(
        root,
        peer,
        { label: "early" },
        {
          id: "a",
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      await store.edges.links.update(
        edge.id,
        { label: "late" },
        { validTo: "2020-03-01T00:00:00.000Z" },
      );
      await store.edges.links.create(
        root,
        peer,
        { label: "any" },
        { id: "b", validFrom: null },
      );
      const anchor = requireDefined(await store.recordedNow());
      const view = store.asOf("2020-06-01T00:00:00.000Z").asOfRecorded(anchor);
      expect(
        await projectAdjacency(({ edge: value }) => value.id, view, root),
      ).toEqual(["b"]);
      const page = await view.adjacency(root, {
        limit: 1,
        edgeKinds: ["links", "other"],
      });
      const cursor = requireDefined(page.nextCursor);
      // Filter order/duplication is immaterial, while every read dimension is bound.
      await expect(
        view.adjacency(root, {
          after: cursor,
          edgeKinds: ["other", "links", "links"],
        }),
      ).resolves.toBeDefined();
      for (const read of [
        () => view.adjacency(peer, { after: cursor }),
        () => view.adjacency(root, { after: cursor, direction: "out" }),
        () => view.adjacency(root, { after: cursor, edgeKinds: ["links"] }),
        () => store.asOfRecorded(anchor).adjacency(root, { after: cursor }),
        () =>
          store
            .asOf("2020-07-01T00:00:00.000Z")
            .asOfRecorded(anchor)
            .adjacency(root, { after: cursor }),
      ])
        await expect(read()).rejects.toMatchObject({
          details: { code: "RECORDED_ADJACENCY_CURSOR_MISMATCH" },
        });
      await expect(view.adjacency(root, { limit: 0 })).rejects.toThrow(
        "between 1 and 1000",
      );
      await expect(
        view.adjacency(root, { after: "garbage" }),
      ).rejects.toThrow();
      await store.nodes.Item.update(root.id, { label: "new revision" });
      await expect(
        store
          .asOf("2020-06-01T00:00:00.000Z")
          .asOfRecorded(requireDefined(await store.recordedNow()))
          .adjacency(root, { after: cursor }),
      ).rejects.toMatchObject({
        details: { code: "RECORDED_ADJACENCY_CURSOR_MISMATCH" },
      });
      await store.clear();
      await expect(
        view.adjacency(root, { after: cursor }),
      ).rejects.toMatchObject({
        details: { code: "RECORDED_ADJACENCY_CURSOR_MISMATCH" },
      });
    });

    it("checks both endpoint versions and preserves ended and tombstone modes", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { label: "root" },
        { id: "résumé", validFrom: null },
      );
      const peer = await store.nodes.Item.create(
        { label: "peer" },
        { validFrom: null },
      );
      const { edge, latin } = await store.transaction(async (tx) => {
        const edge = await tx.edges.links.create(
          root,
          peer,
          { label: "visible" },
          { id: "é-edge", validFrom: null },
        );
        const latin = await tx.edges.links.create(
          root,
          peer,
          { label: "also visible" },
          { id: "Z-edge", validFrom: null },
        );
        return { edge, latin };
      });
      const pinned = requireDefined(await store.recordedNow());
      await store.nodes.Item.update(
        peer.id,
        { label: "ended" },
        { validTo: "2020-01-01T00:00:00.000Z" },
      );
      const ended = requireDefined(await store.recordedNow());
      expect(await collect(store.asOfRecorded(ended), root)).toEqual([]);
      expect(
        await projectAdjacency(
          ({ edge: value }) => value.id,
          store.asOfRecorded(pinned),
          root,
        ),
      ).toEqual([latin.id, edge.id]);
      expect(
        await projectAdjacency(
          ({ edge: value }) => value.id,
          store.view({ mode: "includeEnded" }).asOfRecorded(ended),
          root,
        ),
      ).toEqual([latin.id, edge.id]);
      await store.transaction(async (tx) => {
        await tx.edges.links.delete(edge.id);
        await tx.edges.links.delete(latin.id);
      });
      await store.nodes.Item.delete(peer.id);
      const deleted = requireDefined(await store.recordedNow());
      expect(
        await collect(
          store.view({ mode: "includeEnded" }).asOfRecorded(deleted),
          root,
        ),
      ).toEqual([]);
      expect(
        await projectAdjacency(
          ({ edge: value }) => value.id,
          store.view({ mode: "includeTombstones" }).asOfRecorded(deleted),
          root,
        ),
      ).toEqual([latin.id, edge.id]);
      // Missing and not-yet-visible roots cannot expose an incident edge.
      expect(
        await collect(store.asOfRecorded(deleted), {
          ...root,
          id: "missing" as typeof root.id,
        }),
      ).toEqual([]);
    });

    it("bounds historical candidates and statement work despite invisible history and unrelated growth", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create({ label: "root" });
      const peer = await store.nodes.Item.create({ label: "peer" });
      const edge = await store.edges.links.create(root, peer, { label: "v0" });
      for (let index = 1; index <= 8; index += 1)
        await store.edges.links.update(edge.id, { label: `v${index}` });
      const reads: { sql: string; rows: number; query: CompiledRowsSql }[] = [];
      const base = context.getBackend();
      const observed = createStore(
        graph,
        deriveBackend(base, {
          async execute<T>(query: CompiledRowsSql) {
            const rows = await base.execute<T>(query);
            reads.push({
              sql: requireDefined(base.compileSql)(query).sql,
              rows: rows.length,
              query,
            });
            return rows;
          },
        }),
        { history: true },
      );
      const view = observed.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      await observed.revisionOriginNow();
      async function measure() {
        reads.length = 0;
        const page = await view.adjacency(root, { limit: 2, direction: "out" });
        const candidateCalls = reads.filter((read) =>
          read.sql.includes("adjacency_visible"),
        );
        expect(candidateCalls).toHaveLength(1);
        expect(candidateCalls[0]?.rows).toBe(3);
        expect(page.data.length).toBeLessThanOrEqual(1);
        expect(page.hasNextPage).toBe(true);
        expect(reads.length).toBeLessThanOrEqual(4);
        return reads.length;
      }
      const before = await measure();
      for (let index = 0; index < 20; index += 1) {
        const unrelated = await store.nodes.Item.create({
          label: `unrelated-${index}`,
        });
        await store.edges.links.create(unrelated, peer, { label: "unrelated" });
      }
      expect(await measure()).toBeLessThanOrEqual(before);
      const candidate = requireDefined(
        reads.find((read) => read.sql.includes("adjacency_visible")),
      );
      const explain =
        base.dialect === "sqlite" ?
          "EXPLAIN QUERY PLAN "
        : "EXPLAIN (ANALYZE, FORMAT JSON) ";
      const plan = await base.execute(
        asCompiledRowsSql(sql`${sql.raw(explain)}${candidate.query}`),
      );
      expect(
        JSON.stringify(plan, (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      ).toContain("adjacency_from_idx");
      expect(
        await projectAdjacency(({ edge: value }) => value.label, view, root),
      ).toEqual(["v8"]);
    });
  });
}
