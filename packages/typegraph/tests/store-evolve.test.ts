/**
 * Tests for `Store.evolve(...)` and the consumer-composed `StoreRef`
 * pattern.
 *
 * Two acceptance gates:
 *
 * - **Round-trip parity:** for every public Store API path, a kind
 *   added via `evolve()` must produce identical results to the same
 *   kind declared at compile time. The matrix below covers create /
 *   getById / find / count / update / delete plus edge endpoint
 *   resolution — the surfaces most likely to accidentally close over
 *   the pre-evolve registry. Runtime kinds are reached through the
 *   dynamic `getNodeCollection(kind)` accessor since the type system
 *   doesn't see them.
 *
 * - **Concurrent evolve:** two simultaneous `evolve()` calls produce
 *   exactly one winner; the loser surfaces `StaleVersionError` or
 *   `SchemaContentConflictError` depending on which CAS check fired
 *   first.
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
  id: "store_evolve",
  nodes: { Person: { type: Person } },
  edges: {},
});

// Shape returned by the dynamic `getNodeCollection("Tag")` path —
// runtime kinds aren't in the type system so the dynamic collection
// returns the widened `Node<NodeType>`. Hoisted here so the parity
// tests share one cast site.
type RuntimeTag = Readonly<{ kind: string; id: string; label: string }>;

describe("Store.evolve — basic flow", () => {
  it("commits a new schema version and returns a Store carrying the runtime kind", async () => {
    const backend = createTestBackend();
    const [store, init] = await createStoreWithSchema(baseGraph, backend);
    expect(init).toEqual({ status: "initialized", version: 1 });

    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await store.evolve(extension);

    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
    expect(evolved.registry.hasNodeType("Person")).toBe(true);

    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(2);
    expect(active?.schema_doc).toContain('"Tag"');
  });

  it("is idempotent on same-hash re-evolve (returns a fresh Store, no version bump)", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const first = await store.evolve(extension);
    const firstActive = await backend.getActiveSchema(baseGraph.id);

    const second = await first.evolve(extension);
    const secondActive = await backend.getActiveSchema(baseGraph.id);

    expect(secondActive?.version).toBe(firstActive?.version);
    expect(second.registry.hasNodeType("Tag")).toBe(true);
  });

  it("rejects evolve before any schema has been initialized", async () => {
    const backend = createTestBackend();
    // Construct a Store *without* initializing the schema.
    const store = createStore(baseGraph, backend);
    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    await expect(store.evolve(extension)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("rejects same-name runtime kind redefined with a different shape", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const v1 = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await store.evolve(v1);

    // v1 extensions are additive-only — re-declaring Tag with an extra
    // property is a redefinition, not an additive change. Use a new
    // kind name to evolve a kind in v1.
    const v2 = defineRuntimeExtension({
      nodes: {
        Tag: {
          properties: {
            label: { type: "string" },
            color: { type: "string" },
          },
        },
      },
    });
    const caught = await evolved.evolve(v2).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as ConfigurationError).details).toMatchObject({
      code: "RUNTIME_KIND_REDEFINITION",
    });
  });

  it("stale store auto-merges the persisted runtime document before applying", async () => {
    // Two stores against the same backend. Store A is constructed
    // before B evolves. When A later calls evolve, it must catch up
    // to B's persisted runtime document instead of throwing
    // MigrationError on the absent-locally kind.
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    // B evolves with Tag — backend now carries Tag in its
    // runtimeDocument. A's local #graph still has no runtimeDocument.
    await storeB.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );

    // A evolves with a *different* additive extension. The fix must
    // merge B's stored Tag into A's baseline first, so the resulting
    // schema contains both Tag and Category. Without it, ensureSchema
    // would diff the merged-with-Category-only graph against the
    // stored-with-Tag schema and treat Tag as a removed kind.
    const evolved = await storeA.evolve(
      defineRuntimeExtension({
        nodes: { Category: { properties: { name: { type: "string" } } } },
      }),
    );

    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
    expect(evolved.registry.hasNodeType("Category")).toBe(true);
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(3);
  });

  it("re-evolving the same ontology relation is idempotent (no duplicate persisted)", async () => {
    // unionDocuments used to concatenate ontology arrays; re-evolving
    // the same ontology relation appended a duplicate that the next
    // restart's validator rejected with DUPLICATE_ONTOLOGY_RELATION.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const extension = defineRuntimeExtension({
      nodes: {
        Doc: { properties: { title: { type: "string" } } },
        Article: { properties: { title: { type: "string" } } },
      },
      ontology: [{ metaEdge: "subClassOf", from: "Article", to: "Doc" }],
    });

    const first = await store.evolve(extension);
    const firstActive = await backend.getActiveSchema(baseGraph.id);

    // Same extension applied again must be a true no-op — no duplicate
    // ontology relation, no version bump, and the next loader can read
    // the schema back without DUPLICATE_ONTOLOGY_RELATION.
    await first.evolve(extension);
    const secondActive = await backend.getActiveSchema(baseGraph.id);
    expect(secondActive?.version).toBe(firstActive?.version);

    // Restart against the same backend — the loader runs the runtime
    // validator on the persisted document, so any duplicates would
    // surface here.
    const [restored] = await createStoreWithSchema(baseGraph, backend);
    expect(restored.registry.hasNodeType("Doc")).toBe(true);
    expect(restored.registry.hasNodeType("Article")).toBe(true);
  });

  it("additive evolve adds new kinds on top of a previously merged extension", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const withTag = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const withTagAndCategory = await withTag.evolve(
      defineRuntimeExtension({
        nodes: { Category: { properties: { name: { type: "string" } } } },
      }),
    );

    // Both kinds reachable, original Tag preserved through the second
    // evolve, schema version bumped twice.
    expect(withTagAndCategory.registry.hasNodeType("Tag")).toBe(true);
    expect(withTagAndCategory.registry.hasNodeType("Category")).toBe(true);
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(3);
  });
});

describe("Store.evolve — round-trip parity matrix", () => {
  // For each scenario, declare kind X two ways:
  //  (a) inline at compile time on `compileGraph`
  //  (b) added via `evolve()` to a graph that didn't originally know X
  // and assert the same operations produce equal results on both sides.

  it("create + getById return equivalent shapes", async () => {
    const Tag = defineNode("Tag", {
      schema: z.object({ label: z.string() }),
    });
    const compileGraph = defineGraph({
      id: "parity_create",
      nodes: { Person: { type: Person }, Tag: { type: Tag } },
      edges: {},
    });

    const compileBackend = createTestBackend();
    const [compileStore] = await createStoreWithSchema(
      compileGraph,
      compileBackend,
    );
    const compileTag = await compileStore.nodes.Tag.create({ label: "alpha" });
    const compileFetched = await compileStore.nodes.Tag.getById(compileTag.id);

    const runtimeBackend = createTestBackend();
    const baseGraphForRuntime = defineGraph({
      id: "parity_create",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [runtimeStore] = await createStoreWithSchema(
      baseGraphForRuntime,
      runtimeBackend,
    );
    const evolved = await runtimeStore.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const runtimeTagCol = evolved.getNodeCollection("Tag");
    expect(runtimeTagCol).toBeDefined();
    const runtimeTag = (await runtimeTagCol!.create({
      label: "alpha",
    })) as unknown as RuntimeTag;
    const runtimeFetched = (await runtimeTagCol!.getById(
      runtimeTag.id,
    )) as unknown as RuntimeTag | undefined;

    expect(runtimeTag.kind).toBe(compileTag.kind);
    expect(runtimeTag.label).toBe(compileTag.label);
    expect(runtimeFetched?.label).toBe(compileFetched?.label);
  });

  it("find + count + update + delete behave identically", async () => {
    const Tag = defineNode("Tag", {
      schema: z.object({ label: z.string() }),
    });
    const compileGraph = defineGraph({
      id: "parity_lifecycle",
      nodes: { Person: { type: Person }, Tag: { type: Tag } },
      edges: {},
    });

    const compileBackend = createTestBackend();
    const [compileStore] = await createStoreWithSchema(
      compileGraph,
      compileBackend,
    );
    await compileStore.nodes.Tag.create({ label: "a" });
    await compileStore.nodes.Tag.create({ label: "b" });

    const runtimeBackend = createTestBackend();
    const baseGraphForRuntime = defineGraph({
      id: "parity_lifecycle",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [runtimeStore] = await createStoreWithSchema(
      baseGraphForRuntime,
      runtimeBackend,
    );
    const evolved = await runtimeStore.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const runtimeTagCol = evolved.getNodeCollection("Tag")!;
    await runtimeTagCol.create({ label: "a" });
    await runtimeTagCol.create({ label: "b" });

    const compileFound = await compileStore.nodes.Tag.find();
    const runtimeFound =
      (await runtimeTagCol.find()) as unknown as RuntimeTag[];
    expect(runtimeFound.length).toBe(compileFound.length);
    expect(runtimeFound.map((node) => node.label).toSorted()).toEqual(
      compileFound.map((node) => node.label).toSorted(),
    );

    const compileCount = await compileStore.nodes.Tag.count();
    const runtimeCount = await runtimeTagCol.count();
    expect(runtimeCount).toBe(compileCount);

    // update
    const compileUpdated = await compileStore.nodes.Tag.update(
      compileFound[0]!.id,
      { label: "z" },
    );
    const runtimeUpdated = (await runtimeTagCol.update(runtimeFound[0]!.id, {
      label: "z",
    })) as unknown as RuntimeTag;
    expect(runtimeUpdated.label).toBe(compileUpdated.label);

    // delete
    await compileStore.nodes.Tag.delete(compileFound[1]!.id);
    await runtimeTagCol.delete(runtimeFound[1]!.id);
    expect(await runtimeTagCol.count()).toBe(
      await compileStore.nodes.Tag.count(),
    );
  });

  it("traverses compile-time → runtime kinds via a runtime edge end-to-end", async () => {
    // The merged graph claim: a runtime edge between a runtime kind
    // and a compile-time kind is queryable just like a fully
    // compile-time edge would be. Tests the actual data path, not
    // just registry shape.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Person"], properties: {} },
        },
      }),
    );

    const alice = await evolved.nodes.Person.create({ name: "alice" });
    const tagCol = evolved.getNodeCollection("Tag")!;
    const featured = (await tagCol.create({
      label: "featured",
    })) as unknown as RuntimeTag;
    const importantTag = (await tagCol.create({
      label: "important",
    })) as unknown as RuntimeTag;

    const appliesTo = evolved.getEdgeCollection("appliesTo")!;
    await appliesTo.create(
      { kind: "Tag", id: featured.id },
      { kind: "Person", id: alice.id },
      {},
    );
    await appliesTo.create(
      { kind: "Tag", id: importantTag.id },
      { kind: "Person", id: alice.id },
      {},
    );

    // Forward traversal: from a runtime Tag, find all appliesTo edges.
    const fromFeatured = await appliesTo.findFrom({
      kind: "Tag",
      id: featured.id,
    });
    expect(fromFeatured).toHaveLength(1);
    expect(fromFeatured[0]!.toKind).toBe("Person");
    expect(fromFeatured[0]!.toId).toBe(alice.id);

    // Reverse traversal: from a compile-time Person, find all
    // incoming appliesTo edges (originating from runtime Tags).
    const incoming = await appliesTo.findTo({ kind: "Person", id: alice.id });
    expect(incoming).toHaveLength(2);
    const tagIds = incoming.map((edge) => edge.fromId).toSorted();
    expect(tagIds).toEqual([featured.id, importantTag.id].toSorted());
  });

  it("runtime edge endpoints surface correctly through the registry", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineRuntimeExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Person"], properties: {} },
        },
      }),
    );

    const edgeType = evolved.registry.getEdgeType("appliesTo");
    expect(edgeType?.from?.map((node) => node.kind)).toEqual(["Tag"]);
    expect(edgeType?.to?.map((node) => node.kind)).toEqual(["Person"]);

    // Compile-time `Person` is reachable through the merged registry
    // unchanged, and the runtime `Tag` shows up alongside it.
    expect(evolved.registry.getNodeType("Person")?.kind).toBe("Person");
    expect(evolved.registry.getNodeType("Tag")?.kind).toBe("Tag");
  });
});

describe("Store.evolve — concurrency", () => {
  it("two concurrent evolve calls produce one winner and one StaleVersionError", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const tagExtension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const categoryExtension = defineRuntimeExtension({
      nodes: { Category: { properties: { name: { type: "string" } } } },
    });

    // Both calls read the same active version (1) and race to commit
    // version 2. The CAS guard inside `commitSchemaVersion` lets exactly
    // one win.
    const results = await Promise.allSettled([
      store.evolve(tagExtension),
      store.evolve(categoryExtension),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // Both writers picked the same target version (active+1) but with
    // different content hashes. The CAS primitive surfaces the loser as
    // either StaleVersionError (if the winner committed first and
    // advanced the active pointer before the loser's CAS check) or
    // SchemaContentConflictError (if the loser hits the version row
    // first and finds a different hash). Both are valid race losers.
    const reason = rejected[0]!.reason as Error;
    const isExpected =
      reason instanceof StaleVersionError ||
      reason instanceof SchemaContentConflictError;
    expect(isExpected).toBe(true);
  });
});

describe("StoreRef pattern (consumer-composed)", () => {
  // The ref is a consumer pattern, not a library factory. Apps that need
  // many callers to share a stable handle (request handlers, background
  // workers, the agent loop) compose their own ref and pass it to
  // evolve, which re-points it atomically with the schema commit. Apps
  // with a single caller can skip the ref entirely and reassign the
  // store from evolve's return value.
  it("evolve(ext, { ref }) re-points the consumer-composed ref", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const ref: StoreRef<typeof store> = { current: store };

    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await ref.current.evolve(extension, { ref });

    expect(ref.current).toBe(evolved);
    expect(ref.current.registry.hasNodeType("Tag")).toBe(true);
  });

  it("evolve without ref returns the new store; consumer reassigns", async () => {
    const backend = createTestBackend();
    let [store] = await createStoreWithSchema(baseGraph, backend);
    const original = store;

    const extension = defineRuntimeExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    store = await store.evolve(extension);

    expect(store).not.toBe(original);
    expect(store.registry.hasNodeType("Tag")).toBe(true);
    expect(original.registry.hasNodeType("Tag")).toBe(false);
  });
});
