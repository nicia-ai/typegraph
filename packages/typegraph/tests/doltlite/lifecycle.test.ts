import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import {
  commitDoltlite,
  createDoltliteBackend,
  doltliteWorkingCopyStrategy,
} from "../../src/backend/doltlite";
import { createDoltliteStore } from "../../src/backend/doltlite/store";
import { tables } from "../../src/backend/sqlite";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { isSqliteWriterSlotBusy } from "../../src/utils/sql-errors";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string(), count: z.number() }),
});
const graph = defineGraph({
  id: "doltlite_lifecycle",
  nodes: { Item: { type: Item } },
  edges: {},
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "doltlite-lifecycle-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "graph.db");
}

describe("DoltLite lifecycle", () => {
  it("preserves raw column names and returns undefined from an empty mapped get", async () => {
    const { backend, db } = await createDoltliteBackend({ vector: false });
    cleanups.push(() => backend.close());
    await expect(db.all("PRAGMA busy_timeout")).resolves.toEqual([
      { timeout: 0 },
    ]);
    await expect(db.select().from(tables.nodes).get()).resolves.toBeUndefined();
    await db.transaction(async (tx) => {
      await expect(tx.all("PRAGMA busy_timeout")).resolves.toEqual([
        { timeout: 0 },
      ]);
      await expect(
        tx.select().from(tables.nodes).get(),
      ).resolves.toBeUndefined();
      await tx.transaction(async (nested) => {
        await expect(nested.all("PRAGMA busy_timeout")).resolves.toEqual([
          { timeout: 0 },
        ]);
      });
    });
  });
  it("persists typed history across close/reopen and refuses a native commit inside a store transaction", async () => {
    const filename = await databasePath();
    const store = await createDoltliteStore(graph, {
      path: filename,
      vector: false,
      store: { history: true, revisionTracking: true },
    });
    cleanups.push(() => store.close());
    const item = await store.nodes.Item.create({ name: "Before", count: 0 });
    const instant = await store.recordedNow();
    if (instant === undefined) throw new Error("Expected a recorded instant");
    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Item.update(item.id, { name: "Must roll back" });
        commitDoltlite(store, "must refuse");
      }),
    ).rejects.toMatchObject({
      details: { code: "DOLTLITE_VERSION_CONTROL_IN_TRANSACTION" },
    });
    await store.nodes.Item.update(item.id, { name: "After" });
    expect(commitDoltlite(store, "checkpoint")).toMatch(/^[a-z0-9]+$/i);
    await store.close();
    const reopened = await createDoltliteStore(graph, {
      path: filename,
      vector: false,
      store: { history: true, revisionTracking: true },
    });
    cleanups.push(() => reopened.close());
    await expect(reopened.nodes.Item.getById(item.id)).resolves.toMatchObject({
      name: "After",
    });
    await expect(
      reopened.asOfRecorded(instant).nodes.Item.getById(item.id),
    ).resolves.toMatchObject({ name: "Before" });
  });

  it("refuses a competing typed writer without partial capture and succeeds on a fresh retry", async () => {
    const filename = await databasePath();
    const first = await createDoltliteStore(graph, {
      path: filename,
      vector: false,
      store: { history: true },
    });
    const second = await createDoltliteStore(graph, {
      path: filename,
      vector: false,
      store: { history: true },
    });
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    await first.transaction(async (tx) => {
      await tx.nodes.Item.create({ name: "winner", count: 1 });
      const error: unknown = await second.nodes.Item.create({
        name: "loser",
        count: 2,
      }).catch((error_: unknown) => error_);
      expect(isSqliteWriterSlotBusy(error)).toBe(true);
    });
    const retried = await second.nodes.Item.create({ name: "retry", count: 3 });
    const rows = await first
      .query()
      .from("Item", "i")
      .select((c) => ({ name: c.i.name }))
      .execute();
    expect(rows.map((row) => row.name).toSorted()).toEqual(["retry", "winner"]);
    await expect(first.nodes.Item.getById(retried.id)).resolves.toMatchObject({
      count: 3,
    });
  });

  it("forks a native branch with history, applies semantic merge, and releases the branch", async () => {
    const filename = await databasePath();
    const { backend, connection } = await createDoltliteBackend({
      path: filename,
      vector: false,
    });
    cleanups.push(() => backend.close());
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
      revisionTracking: true,
    });
    const item = await store.nodes.Item.create({ name: "Base", count: 0 });
    const instant = await store.recordedNow();
    if (instant === undefined) throw new Error("Expected history");
    const fork = unwrap(
      await branch(
        store,
        () => Promise.reject(new Error("Native branch must not clone")),
        undefined,
        doltliteWorkingCopyStrategy<typeof graph>(),
      ),
    );
    cleanups.push(() => fork.close());
    await fork.store.nodes.Item.update(item.id, { name: "Edited" });
    await expect(store.nodes.Item.getById(item.id)).resolves.toMatchObject({
      name: "Base",
    });
    const merged = await merge(store, [fork], {});
    expect(merged).toMatchObject({ success: true });
    await expect(store.nodes.Item.getById(item.id)).resolves.toMatchObject({
      name: "Edited",
    });
    await expect(
      store.asOfRecorded(instant).nodes.Item.getById(item.id),
    ).resolves.toMatchObject({ name: "Base" });
    await fork.close();
    const rows = connection
      .prepare(
        "SELECT name FROM dolt_branches WHERE name LIKE 'typegraph_work_%'",
      )
      .all();
    expect(rows).toEqual([]);
  });
});
