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
 *   the pre-evolve registry. Graph-extension kinds are reached through the
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
import { embedding } from "../src/core/embedding";
import { defineNode } from "../src/core/node";
import {
  ConfigurationError,
  KindNotFoundError,
  SchemaContentConflictError,
  StaleVersionError,
} from "../src/errors";
import {
  defineGraphExtension,
  GraphExtensionValidationError,
  IncompatibleChangeError,
} from "../src/graph-extension";
import {
  createAdapterStoreWithSchema,
  createStore,
  createStoreWithSchema,
} from "../src/store/store";
import { type StoreRef } from "../src/store/types";
import { requireDefined } from "../src/utils/presence";
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
// graph-extension kinds aren't in the type system so the dynamic collection
// returns the widened `Node<NodeType>`. Hoisted here so the parity
// tests share one cast site.
type ExtensionTag = Readonly<{ kind: string; id: string; label: string }>;

describe("Store.evolve — basic flow", () => {
  it("commits a new schema version and returns a Store carrying the graph-extension kind", async () => {
    const backend = createTestBackend();
    const [store, init] = await createStoreWithSchema(baseGraph, backend);
    expect(init).toMatchObject({ status: "initialized", version: 1 });

    const extension = defineGraphExtension({
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

    const extension = defineGraphExtension({
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
    const extension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    await expect(store.evolve(extension)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("rejects ADD_REQUIRED_PROPERTY on a populated extension kind", async () => {
    // Adding a required property to an extension kind that already
    // has rows is rejected because the existing rows would fail
    // validation. Same kind would have succeeded if Tag were empty
    // (allowed-on-empty classification — see store-evolve-modify
    // tests for the full matrix).
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const v1 = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await store.evolve(v1);
    // Populate Tag so the empty-probe finds rows.
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });

    const v2 = defineGraphExtension({
      nodes: {
        Tag: {
          properties: {
            label: { type: "string" },
            // New REQUIRED property — needs back-fill to validate
            // existing rows. Rejected.
            color: { type: "string" },
          },
        },
      },
    });
    const caught = await evolved.evolve(v2).catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(IncompatibleChangeError);
    const error = caught as IncompatibleChangeError;
    expect(
      error.changes.some(
        (change) =>
          change.kind === "Tag" &&
          change.field === "color" &&
          change.type === "ADD_REQUIRED_PROPERTY",
      ),
    ).toBe(true);
  });

  it("stale store auto-merges the persisted graph-extension document before applying", async () => {
    // Two stores against the same backend. Store A is constructed
    // before B evolves. When A later calls evolve, it must catch up
    // to B's persisted graph-extension document instead of throwing
    // MigrationError on the absent-locally kind.
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    // B evolves with Tag — backend now carries Tag in its
    // extension. A's local #graph still has no extension.
    await storeB.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );

    // A evolves with a *different* additive extension. The fix must
    // merge B's stored Tag into A's baseline first, so the resulting
    // schema contains both Tag and Category. Without it, ensureSchema
    // would diff the merged-with-Category-only graph against the
    // stored-with-Tag schema and treat Tag as a removed kind.
    const evolved = await storeA.evolve(
      defineGraphExtension({
        nodes: { Category: { properties: { name: { type: "string" } } } },
      }),
    );

    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
    expect(evolved.registry.hasNodeType("Category")).toBe(true);
    const active = await backend.getActiveSchema(baseGraph.id);
    expect(active?.version).toBe(3);
  });

  it("does not row-count probe for purely additive extensions", async () => {
    const backend = {
      ...createTestBackend(),
      countNodesByKind: () =>
        Promise.reject(new Error("additive evolve should not count node rows")),
      countEdgesByKind: () =>
        Promise.reject(new Error("additive evolve should not count edge rows")),
    } satisfies ReturnType<typeof createTestBackend>;
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    expect(evolved.registry.hasNodeType("Tag")).toBe(true);
  });

  it("re-evolving the same ontology relation is idempotent (no duplicate persisted)", async () => {
    // unionDocuments used to concatenate ontology arrays; re-evolving
    // the same ontology relation appended a duplicate that the next
    // restart's validator rejected with DUPLICATE_ONTOLOGY_RELATION.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const extension = defineGraphExtension({
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
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const withTagAndCategory = await withTag.evolve(
      defineGraphExtension({
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

    const extensionBackend = createTestBackend();
    const baseGraphForExtension = defineGraph({
      id: "parity_create",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [extensionStore] = await createStoreWithSchema(
      baseGraphForExtension,
      extensionBackend,
    );
    const evolved = await extensionStore.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const extensionTagCol = evolved.getNodeCollection("Tag");
    expect(extensionTagCol).toBeDefined();
    const extensionTag = (await requireDefined(extensionTagCol).create({
      label: "alpha",
    })) as unknown as ExtensionTag;
    const extensionFetched = (await requireDefined(extensionTagCol).getById(
      extensionTag.id,
    )) as unknown as ExtensionTag | undefined;

    expect(extensionTag.kind).toBe(compileTag.kind);
    expect(extensionTag.label).toBe(compileTag.label);
    expect(extensionFetched?.label).toBe(compileFetched?.label);
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

    const extensionBackend = createTestBackend();
    const baseGraphForExtension = defineGraph({
      id: "parity_lifecycle",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [extensionStore] = await createStoreWithSchema(
      baseGraphForExtension,
      extensionBackend,
    );
    const evolved = await extensionStore.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const runtimeTagCol = requireDefined(evolved.getNodeCollection("Tag"));
    await runtimeTagCol.create({ label: "a" });
    await runtimeTagCol.create({ label: "b" });

    const compileFound = await compileStore.nodes.Tag.find();
    const runtimeFound =
      (await runtimeTagCol.find()) as unknown as ExtensionTag[];
    expect(runtimeFound.length).toBe(compileFound.length);
    expect(runtimeFound.map((node) => node.label).toSorted()).toEqual(
      compileFound.map((node) => node.label).toSorted(),
    );

    const compileCount = await compileStore.nodes.Tag.count();
    const runtimeCount = await runtimeTagCol.count();
    expect(runtimeCount).toBe(compileCount);

    // update
    const compileUpdated = await compileStore.nodes.Tag.update(
      requireDefined(compileFound[0]).id,
      { label: "z" },
    );
    const runtimeUpdated = (await runtimeTagCol.update(
      requireDefined(runtimeFound[0]).id,
      {
        label: "z",
      },
    )) as unknown as ExtensionTag;
    expect(runtimeUpdated.label).toBe(compileUpdated.label);

    // delete
    await compileStore.nodes.Tag.delete(requireDefined(compileFound[1]).id);
    await runtimeTagCol.delete(requireDefined(runtimeFound[1]).id);
    expect(await runtimeTagCol.count()).toBe(
      await compileStore.nodes.Tag.count(),
    );
  });

  it("traverses compile-time → graph-extension kinds via a graph-extension edge end-to-end", async () => {
    // The merged graph claim: a graph-extension edge between a graph-extension kind
    // and a compile-time kind is queryable just like a fully
    // compile-time edge would be. Tests the actual data path, not
    // just registry shape.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          appliesTo: { from: ["Tag"], to: ["Person"], properties: {} },
        },
      }),
    );

    const alice = await evolved.nodes.Person.create({ name: "alice" });
    const tagCol = requireDefined(evolved.getNodeCollection("Tag"));
    const featured = (await tagCol.create({
      label: "featured",
    })) as unknown as ExtensionTag;
    const importantTag = (await tagCol.create({
      label: "important",
    })) as unknown as ExtensionTag;

    const appliesTo = requireDefined(evolved.getEdgeCollection("appliesTo"));
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
    expect(requireDefined(fromFeatured[0]).toKind).toBe("Person");
    expect(requireDefined(fromFeatured[0]).toId).toBe(alice.id);

    // Reverse traversal: from a compile-time Person, find all
    // incoming appliesTo edges (originating from runtime Tags).
    const incoming = await appliesTo.findTo({ kind: "Person", id: alice.id });
    expect(incoming).toHaveLength(2);
    const tagIds = incoming.map((edge) => edge.fromId).toSorted();
    expect(tagIds).toEqual([featured.id, importantTag.id].toSorted());
  });

  it("graph-extension edge endpoints surface correctly through the registry", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
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

    const tagExtension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const categoryExtension = defineGraphExtension({
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
    const reason = requireDefined(rejected[0]).reason as Error;
    const isExpected =
      reason instanceof StaleVersionError ||
      reason instanceof SchemaContentConflictError;
    expect(isExpected).toBe(true);
  });

  it("stale store applying an already-persisted extension does not bump the schema version", async () => {
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const [storeB] = await createStoreWithSchema(baseGraph, backend);

    const tagExtension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });

    // B commits the extension first; A is now stale (its #graph
    // doesn't carry Tag, but the persisted schema does).
    const evolvedB = await storeB.evolve(tagExtension);
    const versionAfterB = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;

    // A applies the same extension. Merging onto the caught-up
    // baseline is a structural no-op; the no-op short-circuit must
    // skip the schema commit. Without the fix, A would call
    // `migrateSchema` and bump the version unnecessarily.
    const evolvedA = await storeA.evolve(tagExtension);

    const versionAfterA = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    expect(versionAfterA).toBe(versionAfterB);

    // The returned store reflects the caught-up state — introspect()
    // sees Tag and the version matches the persisted one.
    expect(evolvedA.registry.hasNodeType("Tag")).toBe(true);
    expect(evolvedA.introspect().schemaVersion).toBe(versionAfterB);
    expect(evolvedB.introspect().schemaVersion).toBe(versionAfterB);
  });
});

describe("StoreRef pattern (consumer-composed)", () => {
  // The ref is a consumer pattern, not a library factory. Apps that need
  // many callers to share a stable handle (request handlers, background
  // workers, repeated schema-evolution loops) compose their own ref and
  // pass it to evolve, which re-points it atomically with the schema
  // commit. Apps with a single caller can skip the ref entirely and
  // reassign the store from evolve's return value.
  it("evolve(ext, { ref }) re-points the consumer-composed ref", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const ref: StoreRef<typeof store> = { current: store };

    const extension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await ref.current.evolve(extension, { ref });

    expect(ref.current).toBe(evolved);
    expect(ref.current.registry.hasNodeType("Tag")).toBe(true);
  });

  it("preserves adapter capabilities when re-pointing an AdapterStore ref", async () => {
    const backend = createTestBackend();
    const [store] = await createAdapterStoreWithSchema(baseGraph, backend);
    const ref: StoreRef<typeof store> = { current: store };

    const extension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    const evolved = await ref.current.evolve(extension, { ref });

    expect(ref.current).toBe(evolved);
    expect(ref.current.registry.hasNodeType("Tag")).toBe(true);
    expect(ref.current.withTransaction).toBeTypeOf("function");
    expect(ref.current.backend).toBe(evolved.backend);
  });

  it("does not rewind an AdapterStore ref when evolution fails before replacement", async () => {
    const backend = createTestBackend();
    const [store] = await createAdapterStoreWithSchema(baseGraph, backend);
    const [current] = await createAdapterStoreWithSchema(baseGraph, backend);
    const ref: StoreRef<typeof store> = { current };

    await expect(
      store.deprecateKinds(["MissingKind"], { ref }),
    ).rejects.toBeInstanceOf(KindNotFoundError);

    expect(ref.current).toBe(current);
    expect(ref.current).not.toBe(store);
    expect(ref.current.withTransaction).toBeTypeOf("function");
  });

  it("evolve without ref returns the new store; consumer reassigns", async () => {
    const backend = createTestBackend();
    let [store] = await createStoreWithSchema(baseGraph, backend);
    const original = store;

    const extension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });
    store = await store.evolve(extension);

    expect(store).not.toBe(original);
    expect(store.registry.hasNodeType("Tag")).toBe(true);
    expect(original.registry.hasNodeType("Tag")).toBe(false);
  });
});

describe("Store.evolve — runtime vector index derivation", () => {
  // Graph-extension kinds with `embedding()` modifiers must auto-derive a
  // `VectorIndexDeclaration` and flow it into `graph.indexes` with
  // `origin: "runtime"`, mirroring the compile-time auto-derivation
  // path. Without this, graphs with extensions cannot materialize
  // their own vector indexes.
  it("auto-derives vector indexes from runtime embedding modifiers", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const extension = defineGraphExtension({
      nodes: {
        Paper: {
          properties: {
            title: { type: "string" },
            embedding: {
              type: "array",
              items: { type: "number" },
              embedding: { dimensions: 384 },
            },
          },
        },
      },
    });
    const evolved = await store.evolve(extension);

    const indexes = (evolved.graph as { indexes?: readonly unknown[] }).indexes;
    expect(indexes).toBeDefined();
    type ExtensionVectorIndex = Readonly<{
      entity: string;
      kind: string;
      fieldPath: string;
      dimensions: number;
      origin: string;
    }>;
    const vectorIndexes = (indexes ?? []).filter(
      (entry): entry is ExtensionVectorIndex =>
        (entry as { entity?: string }).entity === "vector",
    );
    const paperIndex = vectorIndexes.find((entry) => entry.kind === "Paper");
    expect(paperIndex).toBeDefined();
    expect(paperIndex?.origin).toBe("runtime");
    expect(paperIndex?.fieldPath).toBe("embedding");
    expect(paperIndex?.dimensions).toBe(384);
  });

  it("preserves compile-time indexes alongside runtime-derived ones", async () => {
    // Compile-time auto-derived embedding stays in graph.indexes as
    // origin: undefined; the runtime-derived one is added with
    // origin: "runtime". Both must coexist.
    const Person = defineNode("Person", {
      schema: z.object({
        name: z.string(),
        embedding: embedding(256),
      }),
    });
    const compileTimeGraph = defineGraph({
      id: "store_evolve_compile_time_vec",
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(compileTimeGraph, backend);

    const extension = defineGraphExtension({
      nodes: {
        Paper: {
          properties: {
            embedding: {
              type: "array",
              items: { type: "number" },
              embedding: { dimensions: 384 },
            },
          },
        },
      },
    });
    const evolved = await store.evolve(extension);

    type IndexEntry = Readonly<{
      entity: string;
      kind: string;
      origin?: string;
    }>;
    const indexes = (
      (evolved.graph as { indexes?: readonly IndexEntry[] }).indexes ?? []
    ).filter((entry) => entry.entity === "vector");
    const personIndex = indexes.find((entry) => entry.kind === "Person");
    const paperIndex = indexes.find((entry) => entry.kind === "Paper");

    expect(personIndex).toBeDefined();
    expect(personIndex?.origin).toBeUndefined();
    expect(paperIndex).toBeDefined();
    expect(paperIndex?.origin).toBe("runtime");
  });
});

describe("Store.evolve — graph-extension-declared relational indexes", () => {
  // Graph-extension documents can carry an `indexes` array (analogue of
  // compile-time `defineGraph({ indexes: [...] })`). Each entry
  // resolves at merge time against graph-extension-or-compile-time kinds and
  // flows into `graph.indexes` as `origin: "runtime"`.
  it("flows a document-declared node index into graph.indexes", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              doi: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        indexes: [
          {
            entity: "node",
            kind: "Paper",
            name: "paper_by_doi",
            fields: ["doi"],
            unique: true,
          },
        ],
      }),
    );

    type IndexEntry = Readonly<{
      entity: string;
      kind: string;
      name: string;
      origin?: string;
      unique?: boolean;
    }>;
    const indexes =
      (evolved.graph as { indexes?: readonly IndexEntry[] }).indexes ?? [];
    const paperIndex = indexes.find((entry) => entry.name === "paper_by_doi");
    expect(paperIndex).toBeDefined();
    expect(paperIndex?.entity).toBe("node");
    expect(paperIndex?.kind).toBe("Paper");
    expect(paperIndex?.origin).toBe("runtime");
    expect(paperIndex?.unique).toBe(true);
  });

  it("flows a document-declared edge index into graph.indexes", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: { properties: { doi: { type: "string" } } },
          Author: { properties: { orcid: { type: "string" } } },
        },
        edges: {
          authoredBy: {
            from: ["Paper"],
            to: ["Author"],
            properties: { contributionType: { type: "string" } },
          },
        },
        indexes: [
          {
            entity: "edge",
            kind: "authoredBy",
            name: "authored_by_contribution",
            fields: ["contributionType"],
            direction: "out",
          },
        ],
      }),
    );

    type IndexEntry = Readonly<{
      entity: string;
      kind: string;
      name: string;
      origin?: string;
      direction?: string;
    }>;
    const indexes =
      (evolved.graph as { indexes?: readonly IndexEntry[] }).indexes ?? [];
    const edgeIndex = indexes.find(
      (entry) => entry.name === "authored_by_contribution",
    );
    expect(edgeIndex).toBeDefined();
    expect(edgeIndex?.entity).toBe("edge");
    expect(edgeIndex?.kind).toBe("authoredBy");
    expect(edgeIndex?.origin).toBe("runtime");
    expect(edgeIndex?.direction).toBe("out");
  });

  it("rejects index referencing a kind not present in document or host graph", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const caught = await store
      .evolve(
        defineGraphExtension({
          nodes: { Paper: { properties: { doi: { type: "string" } } } },
          indexes: [
            {
              entity: "node",
              kind: "Nonexistent",
              fields: ["doi"],
            },
          ],
        }),
      )
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(KindNotFoundError);
    expect((caught as KindNotFoundError).kindName).toBe("Nonexistent");
    expect((caught as KindNotFoundError).entity).toBe("node");
  });

  it("targets a compile-time host kind", async () => {
    // Graph-extension indexes can attach to compile-time kinds — the merge
    // resolves the kind reference against both runtime nodes and
    // compile-time graph.nodes.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const evolved = await store.evolve(
      defineGraphExtension({
        indexes: [
          {
            entity: "node",
            kind: "Person",
            name: "person_by_name",
            fields: ["name"],
          },
        ],
      }),
    );

    type IndexEntry = Readonly<{
      entity: string;
      kind: string;
      name: string;
      origin?: string;
    }>;
    const indexes =
      (evolved.graph as { indexes?: readonly IndexEntry[] }).indexes ?? [];
    const personIndex = indexes.find(
      (entry) => entry.name === "person_by_name",
    );
    expect(personIndex).toBeDefined();
    expect(personIndex?.kind).toBe("Person");
    expect(personIndex?.origin).toBe("runtime");
  });

  it("persists graph-extension indexes through the schema document", async () => {
    // The extension is the source of truth — restart-parity
    // means a fresh Store reading the same backend reconstructs the
    // graph-extension indexes from the persisted document.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    await store.evolve(
      defineGraphExtension({
        nodes: { Paper: { properties: { doi: { type: "string" } } } },
        indexes: [
          {
            entity: "node",
            kind: "Paper",
            name: "paper_by_doi",
            fields: ["doi"],
            unique: true,
          },
        ],
      }),
    );

    // Construct a fresh Store against the same backend; the loader
    // reads the persisted extension and re-derives indexes.
    const [reloaded] = await createStoreWithSchema(baseGraph, backend);
    type IndexEntry = Readonly<{
      entity: string;
      kind: string;
      name: string;
      origin?: string;
    }>;
    const indexes =
      (reloaded.graph as { indexes?: readonly IndexEntry[] }).indexes ?? [];
    const paperIndex = indexes.find((entry) => entry.name === "paper_by_doi");
    expect(paperIndex).toBeDefined();
    expect(paperIndex?.origin).toBe("runtime");
  });

  it("rejects malformed graph-extension index entries at authoring time", () => {
    let caught: unknown;
    try {
      defineGraphExtension({
        nodes: { Paper: { properties: { doi: { type: "string" } } } },
        indexes: [
          // empty fields array
          { entity: "node", kind: "Paper", fields: [] },
        ],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphExtensionValidationError);
    const error = caught as GraphExtensionValidationError;
    const codes = error.details.issues.map((issue) => issue.code);
    expect(codes).toContain("EMPTY_INDEX_FIELDS");
  });

  it("rejects graph-extension indexes without fields at authoring time", () => {
    let caught: unknown;
    try {
      defineGraphExtension({
        nodes: { Paper: { properties: { doi: { type: "string" } } } },
        indexes: [{ entity: "node", kind: "Paper" } as never],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GraphExtensionValidationError);
    const error = caught as GraphExtensionValidationError;
    expect(error.details.issues).toContainEqual(
      expect.objectContaining({
        path: "/indexes/0/fields",
        code: "EMPTY_INDEX_FIELDS",
      }),
    );
  });

  it("rejects duplicate graph-extension index names across separate evolves", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Paper: {
            properties: {
              doi: { type: "string" },
              title: { type: "string" },
            },
          },
        },
        indexes: [
          {
            entity: "node",
            kind: "Paper",
            name: "paper_lookup",
            fields: ["doi"],
          },
        ],
      }),
    );

    await expect(
      evolved.evolve(
        defineGraphExtension({
          indexes: [
            {
              entity: "node",
              kind: "Paper",
              name: "paper_lookup",
              fields: ["title"],
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(GraphExtensionValidationError);
  });
});
