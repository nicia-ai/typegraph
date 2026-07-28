/**
 * `migrateSchema` must never destroy data as a side effect.
 *
 * Two guarantees, both regressions of a real data-loss incident (#322):
 *
 * 1. **Extension fold.** Kinds committed at runtime by `Store.evolve()` live
 *    in `schema_doc.extension`, not in the caller's compile-time graph.
 *    Committing the caller's graph verbatim erased them from the active
 *    document while their rows stayed in `typegraph_nodes`, readable by
 *    nothing. The persisted document is the sole authority, so a *stale*
 *    graph cannot resurrect a kind another writer removed either.
 *
 * 2. **Drop refusal.** A commit that drops a kind still holding rows is
 *    refused. Committing makes those rows unreachable, and the next
 *    `materializeRemovals` — which re-derives removals by walking schema
 *    history — deletes them, so the commit is the point of no return.
 *    Dropping an *empty* kind is permitted: that is Deploy 3 of the
 *    documented three-deploy removal flow.
 *
 * The path that produced the incident is exercised end-to-end in
 * "the reported incident": open → evolve → write → breaking change →
 * `MigrationError` → follow the error's own advice.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ConfigurationError, MigrationError, StaleVersionError } from "../src";
import { defineGraph } from "../src/core/define-graph";
import { defineEdge } from "../src/core/edge";
import { defineNode } from "../src/core/node";
import { defineGraphExtension } from "../src/graph-extension";
import { getActiveSchema, migrateSchema } from "../src/schema";
import type { SerializedSchema } from "../src/schema/types";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ since: z.string() }),
});

/** The compile-time graph, as an application would declare it. */
const baseGraph = defineGraph({
  id: "migrate_kind_preservation",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});

/**
 * The same graph after a breaking property change — the documented reason to
 * reach for `migrateSchema` ("force the contract deploy"). Removing a
 * required property is breaking; removing a *kind* is not what this is.
 */
const baseGraphWithRenamedProperty = defineGraph({
  id: baseGraph.id,
  nodes: {
    Person: {
      type: defineNode("Person", {
        schema: z.object({ fullName: z.string() }),
      }),
    },
    Company: { type: Company },
  },
  edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
});

const widgetExtension = defineGraphExtension({
  nodes: {
    Widget: { properties: { label: { type: "string" } } },
  },
});

async function activeSchema(
  backend: ReturnType<typeof createTestBackend>,
): Promise<SerializedSchema> {
  const active = await getActiveSchema(backend, baseGraph.id);
  return requireDefined(active, "active schema");
}

async function activeKindNames(
  backend: ReturnType<typeof createTestBackend>,
): Promise<Readonly<{ nodes: readonly string[]; edges: readonly string[] }>> {
  const active = await activeSchema(backend);
  return {
    nodes: Object.keys(active.nodes).toSorted(),
    edges: Object.keys(active.edges).toSorted(),
  };
}

async function activeVersion(
  backend: ReturnType<typeof createTestBackend>,
): Promise<number> {
  const active = await activeSchema(backend);
  return active.version;
}

describe("migrateSchema — graph-extension fold", () => {
  it("preserves runtime-committed kinds, and their rows, when handed the compile-time graph", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    const widget = await evolved
      .getNodeCollectionOrThrow("Widget")
      .create({ label: "left-handed" });

    // The caller passes the graph they have — the compile-time one. They do
    // not know `Widget` exists; that is the whole point.
    await migrateSchema(backend, baseGraph, await activeVersion(backend));

    const kinds = await activeKindNames(backend);
    expect(kinds.nodes).toContain("Widget");

    // ...and the folded document still drives a working Store whose rows read.
    const [reopened] = await createStoreWithSchema(baseGraph, backend);
    expect(reopened.registry.hasNodeType("Widget")).toBe(true);
    const found = await reopened
      .getNodeCollectionOrThrow("Widget")
      .getById(widget.id);
    expect(found?.["label"]).toBe("left-handed");
  });

  it("a stale store's merged graph cannot resurrect a kind another writer removed", async () => {
    // `store.graph` is public and returns the MERGED graph, so passing it to
    // migrateSchema is a reachable call. If the fold unioned that stale
    // extension slice back in, `removeKinds` would be silently undone — and
    // worse, the resurrected kind would keep its queued `kind_removals` row,
    // so the next `materializeRemovals` would delete the rows of a kind the
    // active schema calls live. The persisted document is the sole authority.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    await evolved.getNodeCollectionOrThrow("Widget").create({ label: "keep" });
    const staleGraph = evolved.graph;

    // Another writer removes the kind through the sanctioned path.
    await evolved.removeKinds(["Widget"]);
    const afterRemoval = await activeKindNames(backend);
    expect(afterRemoval.nodes).not.toContain("Widget");

    // The stale holder migrates using the graph it still has.
    await migrateSchema(backend, staleGraph, await activeVersion(backend));

    const final = await activeKindNames(backend);
    expect(final.nodes).not.toContain("Widget");
  });

  it("preserves the persisted deprecated-kind set", async () => {
    // `deprecatedKinds` rides the same stored document as the extension, so
    // the verbatim commit erased it too.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    await store.deprecateKinds(["Company"]);

    await migrateSchema(backend, baseGraph, await activeVersion(backend));

    const active = await activeSchema(backend);
    expect(active.deprecatedKinds).toEqual(["Company"]);
  });

  it("the reported incident: MigrationError recovery no longer orphans kinds", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(widgetExtension);
    const widget = await evolved
      .getNodeCollectionOrThrow("Widget")
      .create({ label: "still here" });

    // A breaking compile-time change: re-opening throws and points the
    // caller at migrateSchema().
    const error = await createStoreWithSchema(
      baseGraphWithRenamedProperty,
      backend,
    ).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(MigrationError);
    const fromVersion = (error as MigrationError).details.fromVersion;

    // Do exactly what the error says.
    await migrateSchema(backend, baseGraphWithRenamedProperty, fromVersion);

    const kinds = await activeKindNames(backend);
    expect(kinds.nodes).toContain("Widget");
    const [reopened] = await createStoreWithSchema(
      baseGraphWithRenamedProperty,
      backend,
    );
    expect(
      await reopened.getNodeCollectionOrThrow("Widget").getById(widget.id),
    ).toBeDefined();
  });
});

describe("migrateSchema — populated-kind-drop refusal", () => {
  /** The compile-time graph minus `Company` and the edge that needs it. */
  const graphWithoutCompany = defineGraph({
    id: baseGraph.id,
    nodes: { Person: { type: Person } },
    edges: {},
  });

  const graphWithoutWorksAt = defineGraph({
    id: baseGraph.id,
    nodes: { Person: { type: Person }, Company: { type: Company } },
    edges: {},
  });

  /** Give `Company` a row so dropping it would strand data. */
  async function seedCompany(
    backend: ReturnType<typeof createTestBackend>,
  ): Promise<void> {
    const [store] = await createStoreWithSchema(baseGraph, backend);
    await store.nodes.Company.create({ name: "Initech" });
  }

  it("refuses a commit that drops a populated node kind, naming it and its row count", async () => {
    const backend = createTestBackend();
    await seedCompany(backend);

    const error = await migrateSchema(backend, graphWithoutCompany, 1).catch(
      (error_: unknown) => error_,
    );

    expect(error).toBeInstanceOf(MigrationError);
    const details = (error as MigrationError).details;
    // Narrowing on `reason` is what makes `droppedKinds` reachable — the
    // details type is a discriminated union, not one shape with optionals.
    if (details.reason !== "kind-removal") throw new Error("wrong reason");
    // `worksAt` is dropped too, but it has no rows to strand.
    expect(details.droppedKinds).toEqual({ nodes: ["Company"], edges: [] });
    expect((error as MigrationError).message).toContain('node "Company" (1)');

    // ...and the refusal leaves the active version untouched.
    const active = await activeSchema(backend);
    expect(active.version).toBe(1);
    expect(Object.keys(active.nodes)).toContain("Company");
  });

  it("refuses a commit that drops a populated edge kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const initech = await store.nodes.Company.create({ name: "Initech" });
    await store.edges.worksAt.create(alice, initech, { since: "2024" });

    const error = await migrateSchema(backend, graphWithoutWorksAt, 1).catch(
      (error_: unknown) => error_,
    );
    const edgeDetails = (error as MigrationError).details;
    if (edgeDetails.reason !== "kind-removal") throw new Error("wrong reason");
    expect(edgeDetails.droppedKinds).toEqual({ nodes: [], edges: ["worksAt"] });
  });

  it("allows dropping an EMPTY kind — the documented three-deploy removal", async () => {
    // Deploy 2 deleted the rows; Deploy 3 drops the kind from defineGraph()
    // and migrates. Nothing is stranded, so nothing is refused.
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const version = await migrateSchema(backend, graphWithoutCompany, 1);

    expect(version).toBe(2);
    const kinds = await activeKindNames(backend);
    expect(kinds).toEqual({ nodes: ["Person"], edges: [] });
  });

  it("rejects a queued write from a Store whose schema was replaced", async () => {
    const backend = createTestBackend();
    const [staleStore] = await createStoreWithSchema(baseGraph, backend);

    await migrateSchema(backend, graphWithoutCompany, 1);

    await expect(
      staleStore.nodes.Company.create({ name: "Too late" }),
    ).rejects.toThrow(StaleVersionError);
    expect(
      await backend.countNodesByKind({
        graphId: baseGraph.id,
        kind: "Company",
        excludeDeleted: false,
      }),
    ).toBe(0);
  });

  it("rejects a queued edge write from a Store whose schema was replaced", async () => {
    const backend = createTestBackend();
    const [staleStore] = await createStoreWithSchema(baseGraph, backend);
    const alice = await staleStore.nodes.Person.create({ name: "Alice" });
    const initech = await staleStore.nodes.Company.create({ name: "Initech" });

    await migrateSchema(backend, graphWithoutWorksAt, 1);

    await expect(
      staleStore.edges.worksAt.create(alice, initech, { since: "too late" }),
    ).rejects.toThrow(StaleVersionError);
    expect(
      await backend.countEdgesByKind({
        graphId: baseGraph.id,
        kind: "worksAt",
        excludeDeleted: false,
      }),
    ).toBe(0);
  });

  it("refuses an emptiness-guarded migration when a custom backend lacks the atomic fence", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);
    const {
      commitSchemaVersionIfKindsEmpty: unsupportedCapability,
      ...customBackend
    } = backend;
    void unsupportedCapability;

    const error = await migrateSchema(
      customBackend,
      graphWithoutCompany,
      1,
    ).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).details).toMatchObject({
      code: "SCHEMA_KIND_EMPTINESS_FENCE_UNSUPPORTED",
      graphId: baseGraph.id,
    });
    expect(
      requireDefined(await backend.getActiveSchema(baseGraph.id)).version,
    ).toBe(1);
  });

  it("allows dropping a kind whose rows were deleted first, and the reconciler reclaims the tombstones", async () => {
    // Deploy 2 of the documented flow. The probe counts live rows only —
    // same `excludeDeleted` default `Store.evolve`'s tightening probe uses —
    // so a soft delete is enough to unblock Deploy 3.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const initech = await store.nodes.Company.create({ name: "Initech" });
    await expect(
      migrateSchema(backend, graphWithoutCompany, 1),
    ).rejects.toThrow(MigrationError);

    await store.nodes.Company.delete(initech.id);

    await expect(migrateSchema(backend, graphWithoutCompany, 1)).resolves.toBe(
      2,
    );

    // The soft-deleted row survives the commit, and is reclaimable: no
    // `typegraph_kind_removals` row is written here, but `materializeRemovals`
    // re-derives removals by walking schema history, so the next reconcile
    // finds the dropped kind and clears it. Permitting the drop does not
    // strand the tombstone permanently.
    const [reopened] = await createStoreWithSchema(
      graphWithoutCompany,
      backend,
    );
    const reclaimed = await reopened.materializeRemovals();
    expect(
      reclaimed.results.find((entry) => entry.kind === "Company")?.status,
    ).toBe("removed");
    expect(
      await backend.countNodesByKind({
        graphId: baseGraph.id,
        kind: "Company",
        excludeDeleted: false,
      }),
    ).toBe(0);
  });

  it("discardDroppedKindRows: the rows really are deleted by the next reconcile", async () => {
    // This is the claim the flag's name and its rewritten docs rest on, and
    // an earlier revision of this PR asserted the opposite — so pin it.
    // No `typegraph_kind_removals` row is written on this path; the reconciler
    // re-derives the removal from schema history and deletes anyway.
    const backend = createTestBackend();
    await seedCompany(backend);

    await migrateSchema(backend, graphWithoutCompany, 1, {
      discardDroppedKindRows: true,
    });

    const [reopened] = await createStoreWithSchema(
      graphWithoutCompany,
      backend,
    );
    await reopened.materializeRemovals();

    expect(
      await backend.countNodesByKind({
        graphId: baseGraph.id,
        kind: "Company",
        excludeDeleted: false,
      }),
    ).toBe(0);
  });

  it("discardDroppedKindRows does not fabricate a cleanup mandate", async () => {
    // The flag means "commit anyway", not "queue a hard delete". Writing a
    // removal row here would let a routine reconcile destroy live rows on a
    // path whose whole purpose is the caller taking responsibility for them.
    const backend = createTestBackend();
    await seedCompany(backend);

    await migrateSchema(backend, graphWithoutCompany, 1, {
      discardDroppedKindRows: true,
    });

    const pending = await requireDefined(
      backend.getPendingKindRemovals,
      "getPendingKindRemovals",
    )(baseGraph.id);
    expect(pending.filter((row) => row.kindName === "Company")).toEqual([]);
  });

  it("commits the orphaning drop when discardDroppedKindRows is set", async () => {
    const backend = createTestBackend();
    await seedCompany(backend);

    const version = await migrateSchema(backend, graphWithoutCompany, 1, {
      discardDroppedKindRows: true,
    });

    expect(version).toBe(2);
    const kinds = await activeKindNames(backend);
    expect(kinds).toEqual({ nodes: ["Person"], edges: [] });
  });
});

describe("migrateSchema — unaffected paths", () => {
  it("still forces a breaking property change (the documented use)", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const version = await migrateSchema(
      backend,
      baseGraphWithRenamedProperty,
      1,
    );

    expect(version).toBe(2);
    const active = await activeSchema(backend);
    const personProperties = active.nodes["Person"]?.properties as
      Readonly<{ properties?: Readonly<Record<string, unknown>> }> | undefined;
    expect(Object.keys(personProperties?.properties ?? {})).toEqual([
      "fullName",
    ]);
  });

  it("commits an additive change without reading a kind as dropped", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(baseGraph, backend);

    const graphWithExtraKind = defineGraph({
      id: baseGraph.id,
      nodes: {
        Person: { type: Person },
        Company: { type: Company },
        Project: {
          type: defineNode("Project", {
            schema: z.object({ name: z.string() }),
          }),
        },
      },
      edges: { worksAt: { type: worksAt, from: [Person], to: [Company] } },
    });

    await migrateSchema(backend, graphWithExtraKind, 1);

    const kinds = await activeKindNames(backend);
    expect(kinds.nodes).toEqual(["Company", "Person", "Project"]);
  });
});
