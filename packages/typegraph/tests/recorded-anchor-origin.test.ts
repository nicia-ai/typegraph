/* eslint-disable unicorn/no-null -- null is the public unbounded validFrom sentinel. */
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  recordedInstantOwner,
  recordedInstantRevision,
} from "../src";
import { createSqliteTables } from "../src/backend/sqlite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ label: z.string() }) });
const graph = defineGraph({
  id: "anchor_namespace",
  nodes: { Item: { type: Item } },
  edges: {},
});

describe("recorded anchor namespace ownership", () => {
  it("rotates a same-name physical fork without clearing rows or history", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "typegraph-allocation-"),
    );
    const sourcePath = path.join(directory, "source.db"),
      forkPath = path.join(directory, "fork.db");
    const handles: ReturnType<typeof createLocalSqliteBackend>[] = [];
    try {
      const sourceHandle = createLocalSqliteBackend({ path: sourcePath });
      handles.push(sourceHandle);
      const [source] = await createStoreWithSchema(
        graph,
        sourceHandle.backend,
        { history: true },
      );
      const owner = await source.allocationOwner();
      expect(await source.recordedNow()).toBeUndefined();
      const node = await source.nodes.Item.create(
        { label: "original" },
        { id: "item", validFrom: null },
      );
      const original = requireDefined(await source.recordedNow());
      expect(recordedInstantOwner(original)).toEqual(owner);
      await sourceHandle.backend.close();
      await copyFile(sourcePath, forkPath);
      const forkHandle = createLocalSqliteBackend({ path: forkPath });
      handles.push(forkHandle);
      const [fork] = await createStoreWithSchema(graph, forkHandle.backend, {
        history: true,
      });
      // A backup retains its identity and can reconstruct the original checkpoint.
      expect(await fork.allocationOwner()).toEqual(owner);
      expect(
        await fork.asOfRecorded(original).nodes.Item.getById(node.id),
      ).toMatchObject({ label: "original" });
      const rotated = await fork.rotateAllocationOwner(owner);
      expect(rotated.origin).not.toBe(owner.origin);
      expect(rotated.namespace).toBe(owner.namespace);
      const forkCut = requireDefined(await fork.recordedNow());
      expect(recordedInstantRevision(forkCut)).toBe(
        recordedInstantRevision(original),
      );
      expect(
        await fork.asOfRecorded(forkCut).nodes.Item.getById(node.id),
      ).toMatchObject({ label: "original" });
      await expect(
        fork.asOfRecorded(original).nodes.Item.getById(node.id),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" });
      await expect(fork.rotateAllocationOwner(owner)).rejects.toMatchObject({
        code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH",
      });
      await fork.nodes.Item.update(node.id, { label: "fork" });
      const reopened = createLocalSqliteBackend({ path: sourcePath });
      handles.push(reopened);
      const [parent] = await createStoreWithSchema(graph, reopened.backend, {
        history: true,
      });
      await parent.nodes.Item.update(node.id, { label: "parent" });
      const parentCut = requireDefined(await parent.recordedNow());
      await expect(
        fork.asOfRecorded(parentCut).nodes.Item.getById(node.id),
      ).rejects.toMatchObject({ code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" });
      expect(await fork.nodes.Item.getById(node.id)).toMatchObject({
        label: "fork",
      });
    } finally {
      for (const handle of handles) await handle.backend.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes physical forks that retain the same raw revision-origin row", async () => {
    const sourceHandle = createLocalSqliteBackend({
      tables: createSqliteTables({ recordedClock: "source_recorded_clock" }),
    });
    const forkHandle = createLocalSqliteBackend({
      tables: createSqliteTables({ recordedClock: "fork_recorded_clock" }),
    });
    try {
      const [source] = await createStoreWithSchema(
        graph,
        sourceHandle.backend,
        { history: true },
      );
      const [fork] = await createStoreWithSchema(graph, forkHandle.backend, {
        history: true,
      });
      await source.nodes.Item.create({ label: "source" }, { id: "item" });
      await fork.nodes.Item.create({ label: "fork" }, { id: "item" });
      const origin = await source
        .allocationOwner()
        .then((owner) => owner.origin);
      // Physical copy strategies preserve this row. Revisions overlap after a fork.
      await requireDefined(forkHandle.backend.executeStatement)(
        asCompiledStatementSql(sql`
          UPDATE ${fork.revisionSchema.revisionOriginsTable}
          SET origin = ${origin} WHERE graph_id = ${graph.id}
        `),
      );
      expect(await fork.allocationOwner().then((owner) => owner.origin)).toBe(
        origin,
      );
      const anchor = requireDefined(await source.recordedNow());
      await expect(
        fork.asOfRecorded(anchor).nodes.Item.getById(asNodeId("item")),
      ).rejects.toMatchObject({
        details: { code: "GRAPH_ALLOCATION_ORIGIN_MISMATCH" },
      });
      const own = requireDefined(await fork.recordedNow());
      expect(
        await fork.asOfRecorded(own).nodes.Item.getById(asNodeId("item")),
      ).toMatchObject({ label: "fork" });
    } finally {
      await sourceHandle.backend.close();
      await forkHandle.backend.close();
    }
  });
});
