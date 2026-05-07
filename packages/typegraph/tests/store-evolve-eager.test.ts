/**
 * Tests for `Store.evolve(extension, { eager: true })`.
 *
 * Eager mode runs `materializeIndexes()` immediately after the
 * schema commit succeeds. Failures throw `EagerMaterializationError`
 * AFTER the new Store is constructed and `ref.current` is updated, so
 * the caller can recover via the ref handle and retry.
 *
 * The schema commit is not rolled back on materialization failure —
 * that's a deliberate design choice (eager is a convenience, not a
 * transaction). The caller decides what to do with the failed indexes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { EagerMaterializationError } from "../src/errors";
import { defineNodeIndex } from "../src/indexes";
import { defineRuntimeExtension } from "../src/runtime";
import type { Store } from "../src/store/store";
import { createStoreWithSchema } from "../src/store/store";
import { type StoreRef } from "../src/store/types";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.email() }),
});

function buildGraphWithIndexes() {
  return defineGraph({
    id: "evolve_eager",
    nodes: { Person: { type: Person } },
    edges: {},
    indexes: [defineNodeIndex(Person, { fields: ["email"] })],
  });
}

function buildGraphWithoutIndexes() {
  return defineGraph({
    id: "evolve_eager_no_indexes",
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

/**
 * Pre-record a status row with a deliberately wrong signature so the
 * next materialize call surfaces signature drift as `failed`. With
 * eager: true on evolve, this becomes EagerMaterializationError.
 */
async function forceSignatureDrift(
  backend: ReturnType<typeof createTestBackend>,
  declared: { name: string; entity: "node" | "edge" | "vector"; kind: string },
  overrides: { signature?: string; graphId?: string } = {},
) {
  await backend.recordIndexMaterialization!({
    indexName: declared.name,
    graphId: overrides.graphId ?? "some_other_graph",
    entity: declared.entity,
    kind: declared.kind,
    signature: overrides.signature ?? "00000000deadbeef",
    schemaVersion: 1,
    attemptedAt: new Date().toISOString(),
    materializedAt: new Date().toISOString(),
    error: undefined,
  });
}

describe("Store.evolve — eager materialization", () => {
  it("eager: true materializes declared indexes after the schema commit", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);

    const ref: StoreRef<Store<typeof graph>> = { current: store };

    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
      { ref, eager: true },
    );

    // The new Store is returned and the ref points to it.
    expect(evolved).toBe(ref.current);
    expect(evolved.registry.hasNodeType("Tag")).toBe(true);

    // A subsequent materialize call sees alreadyMaterialized — proves
    // eager mode actually ran the DDL.
    const second = await evolved.materializeIndexes();
    for (const entry of second.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("eager: true on a graph with no declared indexes is a no-op", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithoutIndexes();
    const [store] = await createStoreWithSchema(graph, backend);

    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
      { eager: true },
    );

    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
    const result = await evolved.materializeIndexes();
    expect(result.results).toEqual([]);
  });

  it("eager accepts an options object — kind filter and stopOnError pass through", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);

    // Filter to just Person — same set as default since the runtime
    // extension adds Tag (no indexes). This proves the options pass
    // through without throwing on a known kind.
    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
      { eager: { kinds: ["Person"], stopOnError: true } },
    );

    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
    const second = await evolved.materializeIndexes();
    for (const entry of second.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("eager: true still materializes when the merge is a no-op (restart-parity contract)", async () => {
    // A second store wraps a database whose schema already includes
    // the runtime kind (e.g. another writer committed it, or this
    // process restarted from a persisted runtimeDocument). Evolving
    // with the same extension produces a no-op merge — but the local
    // database may still have unmaterialized indexes (the prior
    // writer never called materializeIndexes, or a previous attempt
    // failed). The contract of `eager: true` is "schema committed AND
    // indexes materialized" — skipping materialize on the no-op
    // branch would return false success.
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });

    // First writer commits the runtime extension WITHOUT materializing
    // (no eager, no explicit materializeIndexes).
    const [storeA] = await createStoreWithSchema(graph, backend);
    await storeA.evolve(extension);

    // Second writer (fresh store) sees the persisted runtimeDocument
    // via createStoreWithSchema's catch-up. Evolving with the same
    // extension is a no-op merge.
    const [storeB] = await createStoreWithSchema(graph, backend);
    expect(storeB.registry.hasNodeType("Tag")).toBe(true);

    // Eager must materialize even though the merge is a no-op.
    const evolved = await storeB.evolve(extension, { eager: true });
    const result = await evolved.materializeIndexes();
    // After eager, every declared index reports alreadyMaterialized
    // — proving eager actually ran the DDL on the no-op branch.
    expect(result.results.length).toBeGreaterThan(0);
    for (const entry of result.results) {
      expect(entry.status).toBe("alreadyMaterialized");
    }
  });

  it("eager: false (the default) does not materialize", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);

    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
      { eager: false },
    );

    // No prior materialize; first call should report `created` for the
    // Person email index.
    const result = await evolved.materializeIndexes();
    const personEmail = result.results.find((entry) => entry.kind === "Person");
    expect(personEmail?.status).toBe("created");
  });

  it("eager: true throws EagerMaterializationError on per-index failure; ref is updated before throw", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);
    const declared = graph.indexes![0]!;
    await forceSignatureDrift(backend, declared);

    const ref: StoreRef<Store<typeof graph>> = { current: store };
    const caught = await store
      .evolve(
        defineRuntimeExtension({
          nodes: { Tag: { properties: { label: { type: "string" } } } },
        }),
        { ref, eager: true },
      )
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(EagerMaterializationError);
    expect(caught).not.toBe(store);
    const error = caught as EagerMaterializationError;
    expect(error.failedIndexNames).toEqual([declared.name]);
    expect(error.materialization.results).toHaveLength(1);
    expect(error.materialization.results[0]!.status).toBe("failed");

    // ref was updated to the new Store BEFORE the throw — the recovery
    // path is to read ref.current and decide what to do with the failures.
    expect(ref.current).not.toBe(store);
    expect(ref.current.registry.hasNodeType("Tag")).toBe(true);
  });

  it("schema commit is not rolled back when eager materialization fails", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);
    await forceSignatureDrift(backend, graph.indexes![0]!);

    await store
      .evolve(
        defineRuntimeExtension({
          nodes: { Tag: { properties: { label: { type: "string" } } } },
        }),
        { eager: true },
      )
      .catch((error: unknown) => error);

    // A fresh restart sees the runtime kind at version 2 despite the
    // materialization throw — proving the schema commit survived.
    const [restored] = await createStoreWithSchema(graph, backend);
    expect(restored.registry.hasNodeType("Tag")).toBe(true);
    const active = await backend.getActiveSchema(graph.id);
    expect(active?.version).toBe(2);
  });

  it("EagerMaterializationError extends TypeGraphError with code", async () => {
    const backend = createTestBackend();
    const graph = buildGraphWithIndexes();
    const [store] = await createStoreWithSchema(graph, backend);
    await forceSignatureDrift(backend, graph.indexes![0]!);

    const caught = await store
      .evolve(
        defineRuntimeExtension({
          nodes: { Tag: { properties: { label: { type: "string" } } } },
        }),
        { eager: true },
      )
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(EagerMaterializationError);
    expect((caught as EagerMaterializationError).code).toBe(
      "EAGER_MATERIALIZATION_FAILED",
    );
  });
});
