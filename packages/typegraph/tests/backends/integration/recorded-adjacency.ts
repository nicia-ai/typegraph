/* eslint-disable unicorn/no-null -- null explicitly requests an unbounded valid-time start. */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asRecordedInstant,
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
import { decodeCursor } from "../../../src/query/cursor";
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
      candidateLimit: 1,
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
      // Kind order precedes revision order, even when the other kind was captured first.
      await store.edges.other.create(root, peer, {}, { id: "z" });
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
      const anchor = requireDefined(await store.recordedNow());
      const view = store.asOfRecorded(anchor);
      const beforePages: RecordedAdjacencyPage<
        RecordedAdjacencyEntry<typeof graph>
      >[] = [];
      await collect(view, root, undefined, (page) => {
        beforePages.push(page);
      });
      const firstPage = await view.adjacency(root, { candidateLimit: 1 });
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
      expect(await view.adjacency(root, { candidateLimit: 1 })).toEqual(
        firstPage,
      );
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
        candidateLimit: 100,
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
        candidateLimit: 1,
        edgeKinds: ["links", "other"],
      });
      const cursor = requireDefined(page.nextCursor);
      expect(decodeCursor(cursor).cols[0]).toMatch(/^[a-f0-9]{64}$/);
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
          name: "ValidationError",
          details: { issues: [{ path: "after" }] },
        });
      await expect(view.adjacency(root, { candidateLimit: 0 })).rejects.toThrow(
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
        name: "ValidationError",
        details: { issues: [{ path: "after" }] },
      });
      await store.clear();
      await expect(
        view.adjacency(root, { after: cursor }),
      ).rejects.toMatchObject({
        name: "GraphAllocationMismatchError",
        details: { code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" },
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

    it("refuses origin rotation during a first page without calling it a cursor mismatch", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create({ label: "root" });
      const peer = await store.nodes.Item.create({ label: "peer" });
      await store.edges.links.create(root, peer, { label: "edge" });
      const anchor = requireDefined(await store.recordedNow());
      const base = context.getBackend();
      const observed = createStore(
        graph,
        deriveBackend(base, {
          async execute<T>(query: CompiledRowsSql) {
            const rows = await base.execute<T>(query);
            if (
              requireDefined(base.compileSql)(query).sql.includes(
                "adjacency_visible",
              )
            )
              await store.clear();
            return rows;
          },
        }),
        { history: true },
      );
      await expect(
        observed.asOfRecorded(anchor).adjacency(root),
      ).rejects.toMatchObject({
        name: "GraphAllocationMismatchError",
        details: { code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" },
      });
    });

    it("refuses unbound legacy anchors and coordinates owned by another graph", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { label: "original" },
        { id: "root" },
      );
      const anchor = requireDefined(await store.recordedNow());
      const otherGraph = defineGraph({
        id: "recorded_other_origin",
        nodes: graph.nodes,
        edges: graph.edges,
      });
      const otherStore = await context.createHistoryStore(otherGraph);
      await otherStore.nodes.Item.create({ label: "other" }, { id: "root" });
      await expect(
        otherStore.asOfRecorded(anchor).nodes.Item.getById(root.id),
      ).rejects.toMatchObject({
        details: { code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" },
      });
      const legacy = asRecordedInstant(
        anchor.replace(/^r2:[^:]+:[^:]+:/u, "r1:"),
      );
      await expect(
        store.asOfRecorded(legacy).nodes.Item.getById(root.id),
      ).rejects.toMatchObject({ details: { code: "RECORDED_ANCHOR_UNBOUND" } });
    });

    it("rotates allocation ownership without clearing rows or captured history", async () => {
      const store = await context.createHistoryStore(graph);
      const owner = await store.allocationOwner();
      const root = await store.nodes.Item.create(
        { label: "original" },
        { id: "root", validFrom: null },
      );
      const old = requireDefined(await store.recordedNow());
      const next = await store.rotateAllocationOwner(owner);
      expect(next.origin).not.toBe(owner.origin);
      expect(next.namespace).toBe(owner.namespace);
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        label: "original",
      });
      const current = requireDefined(await store.recordedNow());
      expect(
        await store.resolveRecordedInstant("9999-01-01T00:00:00.000Z"),
      ).toBe(current);
      expect(
        await store.asOfRecorded(current).nodes.Item.getById(root.id),
      ).toMatchObject({ label: "original" });
      await expect(
        store.asOfRecorded(old).nodes.Item.getById(root.id),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" });
      await expect(store.rotateAllocationOwner(owner)).rejects.toMatchObject({
        code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH",
      });
      await store.nodes.Item.update(root.id, { label: "updated" });
      expect(
        await store.asOfRecorded(current).nodes.Item.getById(root.id),
      ).toMatchObject({ label: "original" });
    });

    it("refuses retired anchors and preconstructed views on every recorded read surface", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { label: "original" },
        { id: "root", validFrom: null },
      );
      const peer = await store.nodes.Item.create(
        { label: "peer" },
        { id: "peer", validFrom: null },
      );
      await store.edges.links.create(
        root,
        peer,
        { label: "original" },
        { id: "edge", validFrom: null },
      );
      const anchor = requireDefined(await store.recordedNow());
      const oldView = store.asOfRecorded(anchor);
      await store.clear();
      const replacement = await store.nodes.Item.create(
        { label: "replacement" },
        { id: "root", validFrom: null },
      );
      const neighbor = await store.nodes.Item.create(
        { label: "neighbor" },
        { id: "peer", validFrom: null },
      );
      await store.edges.links.create(
        replacement,
        neighbor,
        { label: "replacement" },
        { id: "edge", validFrom: null },
      );
      for (const view of [oldView, store.asOfRecorded(anchor)]) {
        for (const read of [
          () => view.algorithms.weaklyConnectedComponents({ edges: ["links"] }),
          () => view.pageRank({ edges: ["links"] }),
          () => view.labelPropagation({ edges: ["links"] }),
          () => view.reachable(root.id, { edges: ["links"] }),
          () => view.shortestPath(root.id, peer.id, { edges: ["links"] }),
          () => view.subgraph(root, { maxDepth: 1, edges: ["links"] }),
          () => view.nodes.Item.getById(root.id),
          () => view.nodes.Item.getByIds([]),
          () => view.nodes.Item.scan(),
          () =>
            view.edges.links.getById(
              "edge" as Parameters<typeof view.edges.links.getById>[0],
            ),
          () => view.edges.links.scan(),
          () => view.adjacency(root),
          () => view.adjacency(root, { edgeKinds: [] }),
          () =>
            view
              .query()
              .from("Item", "item")
              .select((ctx) => ctx.item.label)
              .execute(),
        ])
          await expect(read()).rejects.toMatchObject({
            details: { code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" },
          });
      }
      expect(
        await store
          .asOfRecorded(requireDefined(await store.recordedNow()))
          .nodes.Item.getById(root.id),
      ).toMatchObject({ label: "replacement" });
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
      for (let index = 0; index < 12; index += 1)
        await store.nodes.Item.update(peer.id, { label: `peer-${index}` });
      const view = observed.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      await observed.allocationOwner().then((owner) => owner.origin);
      async function measure() {
        reads.length = 0;
        const page = await view.adjacency(root, {
          candidateLimit: 2,
          direction: "out",
        });
        const candidateCalls = reads.filter((read) =>
          read.sql.includes("adjacency_visible"),
        );
        expect(candidateCalls).toHaveLength(1);
        expect(candidateCalls[0]?.rows).toBe(3);
        expect(page.data.length).toBeLessThanOrEqual(1);
        expect(page.hasNextPage).toBe(true);
        expect(reads.length).toBeLessThanOrEqual(5);
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
      const filteredView = observed.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      reads.length = 0;
      const empty = await filteredView.adjacency(root, { edgeKinds: [] });
      expect(empty).toEqual({
        data: [],
        hasNextPage: false,
        nextCursor: undefined,
      });
      expect(reads.some((read) => read.sql.includes("adjacency_visible"))).toBe(
        false,
      );
      reads.length = 0;
      expect(
        await filteredView.adjacency(
          { ...root, id: "absent" as typeof root.id },
          { candidateLimit: 1 },
        ),
      ).toEqual(empty);
      expect(reads.some((read) => read.sql.includes("adjacency_visible"))).toBe(
        false,
      );
      await store.edges.other.create(root, peer, {}, { id: "selected" });
      // Excluded incident history cannot consume the selected kind's window.
      const selectedView = observed.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      reads.length = 0;
      const selected = await selectedView.adjacency(root, {
        edgeKinds: ["other"],
        candidateLimit: 1,
        direction: "out",
      });
      expect(selected.data.map((entry) => entry.edge.id)).toEqual(["selected"]);
      expect(selected.hasNextPage).toBe(false);
      expect(
        reads
          .filter((read) => read.sql.includes("adjacency_visible"))
          .map((read) => read.rows),
      ).toEqual([1]);
      reads.length = 0;
      // Include the visible version so PostgreSQL executes the neighbor subplan.
      await view.adjacency(root, {
        candidateLimit: 100,
        direction: "out",
        edgeKinds: ["links"],
      });
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
      async function endpointPlanIsBounded(): Promise<boolean> {
        if (base.dialect === "sqlite") {
          const bytecode = await base.execute<{ opcode: string }>(
            asCompiledRowsSql(sql`EXPLAIN ${candidate.query}`),
          );
          // Candidate cap, EXISTS cap, and latest-version cap each have a counter.
          return (
            bytecode.filter((row) => row.opcode === "DecrJumpZero").length >= 3
          );
        } else {
          const limits: Record<string, unknown>[] = [];
          function visit(value: unknown): void {
            if (Array.isArray(value)) {
              for (const child of value) visit(child);
            } else if (typeof value === "object" && value !== null) {
              const record = value as Record<string, unknown>;
              if (record["Node Type"] === "Limit") limits.push(record);
              for (const child of Object.values(record)) visit(child);
            }
          }
          visit(plan);
          // The peer reconstruction has its own one-row Limit, below the window.
          return limits.some(
            (node) =>
              Number(node["Actual Rows"]) <= 1 &&
              Number(node["Actual Loops"]) > 0,
          );
        }
      }
      expect(await endpointPlanIsBounded()).toBe(true);
      expect(
        await projectAdjacency(({ edge: value }) => value.label, view, root),
      ).toEqual(["v8"]);
    });
  });
}
