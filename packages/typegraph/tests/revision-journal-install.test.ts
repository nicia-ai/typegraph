import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { computeBaseVersion } from "../src/graph-merge/base-version";
import { cloneWorkingCopyStrategy } from "../src/graph-merge/working-copy";
import { installRevisionChangesJournal } from "../src/schema";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "revision-journal-install",
  nodes: { Item: { type: Item } },
  edges: {},
});

const backends: ReturnType<typeof createLocalSqliteBackend>["backend"][] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends.splice(0)) await backend.close();
});

describe("revision journal installation", () => {
  it("keeps runtime lineage DML-only and fails closed until the owner installs the journal", async () => {
    const { backend } = createLocalSqliteBackend();
    backends.push(backend);
    await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
      revisionJournal: false,
    });
    const store = createStore(graph, backend, { revisionTracking: true });

    await expect(store.lineageRevisionNow()).rejects.toMatchObject({
      details: { code: "REVISION_JOURNAL_NOT_READY" },
    });
    await expect(backend.revisionChangesJournalReady?.()).resolves.toBe(false);

    const install = vi.spyOn(backend, "ensureRevisionChangesJournal");
    await installRevisionChangesJournal(backend);
    await installRevisionChangesJournal(backend);
    expect(install).toHaveBeenCalledTimes(1);
    await expect(backend.revisionChangesJournalReady?.()).resolves.toBe(true);
    await expect(store.lineageRevisionNow()).resolves.toBeDefined();

    const nodeTable = backend.tableNames?.nodes;
    if (nodeTable === undefined) throw new Error("Expected node table name");
    await backend.executeDdl?.(
      `DROP TRIGGER "tg_rc_${nodeTable.slice(0, 38)}_node_insert"`,
    );
    await expect(store.lineageRevisionNow()).rejects.toMatchObject({
      details: { code: "REVISION_JOURNAL_NOT_READY" },
    });
  });

  it("allows a short-lived clone to opt out of journal-backed lineage", async () => {
    const { backend: baseBackend } = createLocalSqliteBackend();
    const { backend: cloneBackend } = createLocalSqliteBackend();
    backends.push(baseBackend, cloneBackend);
    const [baseStore] = await createStoreWithSchema(graph, baseBackend, {
      revisionTracking: true,
      revisionJournal: false,
    });
    const install = vi.spyOn(cloneBackend, "ensureRevisionChangesJournal");
    const readiness = vi.spyOn(cloneBackend, "revisionChangesJournalReady");
    const strategy = cloneWorkingCopyStrategy<typeof graph>(
      () => Promise.resolve(cloneBackend),
      { revisionJournal: false },
    );
    const clone = await strategy.create(
      baseStore,
      await computeBaseVersion(baseStore),
    );

    expect(clone.revisionTrackingEnabled).toBe(true);
    expect(install).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
    await expect(clone.lineageRevisionNow()).resolves.toBeUndefined();
    expect(readiness).not.toHaveBeenCalled();
  });
});
