/**
 * Tests for `store.deprecateKinds(...)` and `store.undeprecateKinds(...)`.
 *
 * Deprecation is a soft signal: the kind set surfaces in
 * `store.deprecatedKinds` for introspection but doesn't gate reads,
 * writes, or queries. Persistence round-trips through the schema
 * document; restart parity verified by re-loading via
 * `createStoreWithSchema`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import {
  ConfigurationError,
  SchemaContentConflictError,
  StaleVersionError,
} from "../src/errors";
import { defineRuntimeExtension } from "../src/runtime";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { type StoreRef } from "../src/store/types";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "deprecate_kinds",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("Store.deprecateKinds — basic flow", () => {
  it("marks a compile-time kind deprecated and bumps schema version", async () => {
    const backend = createTestBackend();
    const [store, init] = await createStoreWithSchema(baseGraph, backend);
    expect(init).toEqual({ status: "initialized", version: 1 });

    expect(store.deprecatedKinds.size).toBe(0);

    const evolved = await store.deprecateKinds(["Person"]);
    expect(evolved.deprecatedKinds.has("Person")).toBe(true);

    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(2);
    expect(active?.schema_doc).toContain('"deprecatedKinds"');
  });

  it("marks runtime kinds deprecated alongside compile-time kinds", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const withTag = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const deprecated = await withTag.deprecateKinds(["Tag"]);

    expect(deprecated.deprecatedKinds.has("Tag")).toBe(true);
    expect(deprecated.deprecatedKinds.has("Person")).toBe(false);
  });

  it("is idempotent on re-deprecating an already-deprecated kind (no version bump)", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const first = await store.deprecateKinds(["Person"]);
    const firstActive = await backend.getActiveSchema(baseGraph.id);

    const second = await first.deprecateKinds(["Person"]);
    const secondActive = await backend.getActiveSchema(baseGraph.id);

    expect(secondActive?.version).toBe(firstActive?.version);
    expect(second.deprecatedKinds.has("Person")).toBe(true);
  });

  it("rejects deprecating an unknown kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const caught = await store
      .deprecateKinds(["NotAKind"])
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details).toMatchObject({
      code: "DEPRECATE_UNKNOWN_KIND",
    });
  });

  it("rejects deprecate before any schema has been initialized", async () => {
    const backend = createTestBackend();
    const store = createStore(baseGraph, backend);
    await expect(store.deprecateKinds(["Person"])).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("does not affect reads or writes on the deprecated kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const deprecated = await store.deprecateKinds(["Person"]);

    const alice = await deprecated.nodes.Person.create({ name: "alice" });
    const fetched = await deprecated.nodes.Person.getById(alice.id);
    expect(fetched?.name).toBe("alice");
    expect(deprecated.deprecatedKinds.has("Person")).toBe(true);
  });
});

describe("Store.undeprecateKinds", () => {
  it("removes a kind from the deprecated set and bumps version", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const deprecated = await store.deprecateKinds(["Person"]);
    expect(deprecated.deprecatedKinds.has("Person")).toBe(true);

    const restored = await deprecated.undeprecateKinds(["Person"]);
    expect(restored.deprecatedKinds.has("Person")).toBe(false);

    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(3);
  });

  it("is a no-op when the kind isn't currently deprecated", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    // Person isn't deprecated; undeprecating is a no-op.
    const same = await store.undeprecateKinds(["Person"]);
    const active = await backend.getActiveSchema(baseGraph.id);

    expect(same.deprecatedKinds.size).toBe(0);
    expect(active?.version).toBe(1);
  });
});

describe("Store.deprecateKinds — concurrency + StoreRef", () => {
  it("two concurrent deprecate calls produce one winner and one race-loser", async () => {
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    const Tag = await storeA.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const [storeBevolved] = await createStoreWithSchema(baseGraph, backend);
    void storeB;

    const results = await Promise.allSettled([
      Tag.deprecateKinds(["Person"]),
      storeBevolved.deprecateKinds(["Tag"]),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = rejected[0]!.reason as Error;
    const isExpected =
      reason instanceof StaleVersionError ||
      reason instanceof SchemaContentConflictError;
    expect(isExpected).toBe(true);
  });

  it("deprecateKinds(names, { ref }) re-points the consumer-composed ref", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const ref: StoreRef<typeof store> = { current: store };

    const evolved = await ref.current.deprecateKinds(["Person"], { ref });

    expect(ref.current).toBe(evolved);
    expect(ref.current.deprecatedKinds.has("Person")).toBe(true);
  });
});

describe("Cross-flow safety: deprecate × evolve", () => {
  // The bug this guards against: a stale store's evolve dropped
  // another writer's deprecation set because evolve's catch-up only
  // merged the runtime document, not the deprecated set. Without the
  // fix, this test would commit a v3 schema with deprecatedKinds
  // empty — silently rolling back B's deprecation.
  it("stale evolve preserves another writer's persisted deprecations", async () => {
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    // B deprecates Person (v2). A is now stale.
    await storeB.deprecateKinds(["Person"]);

    // A evolves with a new Tag kind. The catch-up MUST include B's
    // deprecation set, otherwise the resulting schema would lose the
    // "Person is deprecated" signal.
    const evolved = await storeA.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );

    expect(evolved.deprecatedKinds.has("Person")).toBe(true);
    expect(evolved.registry.hasNodeType("Tag")).toBe(true);

    // Persisted form carries both — verifiable via fresh restart.
    const [restored] = await createStoreWithSchema(baseGraph, backend);
    expect(restored.deprecatedKinds.has("Person")).toBe(true);
    expect(restored.registry.hasNodeType("Tag")).toBe(true);
  });

  it("idempotent deprecate against an already-persisted set still surfaces stored runtime kinds", async () => {
    // Bug guarded: a stale store calling deprecateKinds with a name
    // that's already in the persisted set was returning `this`
    // unchanged, so the caller never saw runtime kinds another writer
    // had added. The fix returns a clone of the caught-up baseline
    // even on the no-op path.
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    // B evolves with Tag and deprecates Person.
    const evolvedB = await storeB.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    await evolvedB.deprecateKinds(["Person"]);

    // A is stale. Calling deprecateKinds(["Person"]) is a no-op
    // against the persisted set — but A must still pick up Tag from
    // B's evolve. Without the catch-up clone, A would return its
    // stale `this` and the caller would never see Tag.
    const result = await storeA.deprecateKinds(["Person"]);

    expect(result.deprecatedKinds.has("Person")).toBe(true);
    expect(result.registry.hasNodeType("Tag")).toBe(true);
    expect(result).not.toBe(storeA);
  });
});

describe("Persistence + restart parity", () => {
  it("deprecation survives a fresh createStoreWithSchema", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    await store.deprecateKinds(["Person"]);

    // Different process / store instance reads the schema back. The
    // loader (`loadAndMergeRuntimeDocument`) applies persisted
    // deprecations to the merged graph.
    const [restored, restoredResult] = await createStoreWithSchema(
      baseGraph,
      backend,
    );
    expect(restoredResult.status).toBe("unchanged");
    expect(restored.deprecatedKinds.has("Person")).toBe(true);
  });

  it("graphs that never deprecated anything hash byte-identically to legacy", async () => {
    // The deprecatedKinds slice must be omitted entirely when empty,
    // so hashing a freshly-defined graph produces no `deprecatedKinds`
    // key in the canonical document.
    const { computeSchemaHash, serializeSchema } =
      await import("../src/schema/serializer");
    const { sortedReplacer } = await import("../src/schema/canonical");

    const serialized = serializeSchema(baseGraph, 1);
    expect("deprecatedKinds" in serialized).toBe(false);
    const canonical = JSON.stringify(serialized, sortedReplacer);
    expect(canonical).not.toContain('"deprecatedKinds"');

    // Sanity: hash is non-empty and stable on this graph.
    const hash = await computeSchemaHash(serialized);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });
});
