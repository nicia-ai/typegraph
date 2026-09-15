import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../src/backend/derive-backend";
import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { defineGraphExtension } from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "schema-refresh",
  nodes: { Person: { type: Person } },
  edges: {},
});
const extension = defineGraphExtension({
  nodes: { Tag: { properties: { label: { type: "string" } } } },
});

describe("schema planning snapshots and refresh", () => {
  it("returns a matching cached version without SQL and reloads a newer version", async () => {
    const backend = createTestBackend();
    const read = vi.fn(backend.getActiveSchema);
    const observed = deriveBackend(backend, { getActiveSchema: read });
    const [store] = await createStoreWithSchema(graph, observed);
    const ref = { current: store };
    read.mockClear();
    expect(await store.refreshSchema({ ref, expectedVersion: 1 })).toBe(store);
    expect(read).not.toHaveBeenCalled();
    await store.evolve(extension);
    read.mockClear();
    const refreshed = await store.refreshSchema({ ref, expectedVersion: 2 });
    expect(read).toHaveBeenCalledTimes(1);
    expect(ref.current).toBe(refreshed);
    expect(refreshed.registry.hasNodeType("Tag")).toBe(true);
    expect(store.registry.hasNodeType("Tag")).toBe(false);
  });

  it("refuses an expected version that is not visible without publishing the ref", async () => {
    const [store] = await createStoreWithSchema(graph, createTestBackend());
    const ref = { current: store };
    await expect(
      store.refreshSchema({ ref, expectedVersion: 2 }),
    ).rejects.toMatchObject({
      details: { code: "SCHEMA_REFRESH_VERSION_UNAVAILABLE" },
    });
    expect(ref.current).toBe(store);
  });

  it("plans once from the database, reuses an explicit cached snapshot, and refreshes stale plans", async () => {
    const backend = createTestBackend();
    const read = vi.fn(backend.getActiveSchema);
    const observed = deriveBackend(backend, { getActiveSchema: read });
    const [store] = await createStoreWithSchema(graph, observed);
    await expect(
      store.planEvolution(extension, { source: "cached" }),
    ).rejects.toMatchObject({
      details: { code: "EVOLUTION_SNAPSHOT_REQUIRED" },
    });
    expect(await store.planEvolution(extension)).toMatchObject({
      status: "change",
      baselineVersion: 1,
    });
    await store.evolve(extension);
    read.mockClear();
    expect(
      await store.planEvolution(extension, { source: "cached" }),
    ).toMatchObject({ status: "change", baselineVersion: 1 });
    expect(read).not.toHaveBeenCalled();
    expect(await store.planEvolution(extension)).toMatchObject({
      status: "noop",
      baselineVersion: 2,
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
