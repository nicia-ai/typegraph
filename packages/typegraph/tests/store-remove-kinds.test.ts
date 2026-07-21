/**
 * Tests for `store.removeKinds()` and `store.materializeRemovals()`.
 *
 * The two-phase contract:
 *   1. removeKinds: atomic schema commit removing the graph-extension kinds
 *      (cascading-remove edges that lose their last endpoint, drop
 *      ontology references). Millisecond-budget.
 *   2. materializeRemovals: data cleanup against the
 *      `typegraph_kind_removals` status table. Bounded by row count;
 *      idempotent.
 *
 * Compile-time kinds are rejected — they're removed by recompiling
 * and redeploying without them. Graph-extension kinds referenced by
 * compile-time edges or ontology relations are also rejected, since
 * the compile-time reference would resurrect the orphan on the next
 * deploy.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, KindNotFoundError } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { RECORDED_MAX_REVISION } from "../src/core/temporal";
import {
  defineGraphExtension,
  KindHasReferentsError,
  RemoveCompileTimeKindError,
} from "../src/graph-extension";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import { planRemovals } from "../src/graph-extension/remove";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { migrateSchema } from "../src/schema/manager";
import { createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

type CountRow = Readonly<{ count: unknown }>;

async function countOpenRecordedNodeRows(
  backend: GraphBackend,
  graphId: string,
  kind: string,
): Promise<number> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${graphId}
        AND kind = ${kind}
        AND recorded_to = ${RECORDED_MAX_REVISION}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

async function countRecordedNodeRows(
  backend: GraphBackend,
  graphId: string,
  kind: string,
): Promise<number> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<CountRow>(
    asCompiledRowsSql(sql`
      SELECT COUNT(*) AS count
      FROM ${schema.recordedNodesTable}
      WHERE graph_id = ${graphId}
        AND kind = ${kind}
    `),
  );
  return Number(rows[0]?.count ?? 0);
}

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "remove_kinds_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("Store.removeKinds — schema commit", () => {
  it("removes a graph-extension kind and bumps schema version", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const beforeVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;

    const removed = await evolved.removeKinds(["Tag"]);

    const afterVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    expect(afterVersion).toBe(beforeVersion + 1);
    expect(removed.registry.hasNodeType("Tag")).toBe(false);
    expect(
      removed.introspect().kinds.find((k) => k.name === "Tag"),
    ).toBeUndefined();
  });

  it("is idempotent: removing an absent kind is a no-op (no version bump)", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const beforeVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;

    const result = await store.removeKinds(["DoesNotExist"]);

    const afterVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    expect(afterVersion).toBe(beforeVersion);
    expect(result.registry.hasNodeType("DoesNotExist")).toBe(false);
  });

  it("rejects removing a compile-time kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const caught = await store
      .removeKinds(["Person"])
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(RemoveCompileTimeKindError);
    expect((caught as RemoveCompileTimeKindError).kindName).toBe("Person");
    expect((caught as RemoveCompileTimeKindError).entity).toBe("node");
  });

  it("cascading-removes a graph-extension edge whose only endpoint was removed", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
          Author: { properties: { name: { type: "string" } } },
        },
        edges: {
          // appliesTo only connects Tag → Author. Removing Tag empties
          // the `from` list, so the edge cascades.
          appliesTo: { from: ["Tag"], to: ["Author"], properties: {} },
        },
      }),
    );

    const removed = await evolved.removeKinds(["Tag"]);

    expect(removed.registry.hasEdgeType("appliesTo")).toBe(false);
    const intro = removed.introspect();
    expect(
      intro.edges.find((edge) => edge.name === "appliesTo"),
    ).toBeUndefined();
  });

  it("retains a graph-extension edge whose endpoint list survives the removal", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
          Category: { properties: { name: { type: "string" } } },
          Author: { properties: { name: { type: "string" } } },
        },
        edges: {
          // both Tag and Category in `from`; removing Tag leaves
          // Category and the edge survives with a pruned endpoint list.
          appliesTo: {
            from: ["Tag", "Category"],
            to: ["Author"],
            properties: {},
          },
        },
      }),
    );

    const removed = await evolved.removeKinds(["Tag"]);

    expect(removed.registry.hasEdgeType("appliesTo")).toBe(true);
    const edgeIntro = removed
      .introspect()
      .edges.find((edge) => edge.name === "appliesTo");
    expect(edgeIntro?.from).toEqual(["Category"]);
  });

  it("removes ontology relations referencing the removed kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
          NamedTag: { properties: { label: { type: "string" } } },
        },
        ontology: [{ metaEdge: "subClassOf", from: "NamedTag", to: "Tag" }],
      }),
    );

    const removed = await evolved.removeKinds(["NamedTag"]);

    const ontology = removed.introspect().ontology;
    expect(
      ontology.find(
        (entry) => entry.from === "NamedTag" || entry.to === "NamedTag",
      ),
    ).toBeUndefined();
  });

  it("rejects removing a graph-extension kind referenced by a compile-time edge", () => {
    // Construct the post-evolve scenario through `planRemovals` directly.
    // The real-world shape this guards against: a developer adds a
    // compile-time edge whose endpoint name overlaps with a graph-
    // extension kind (the type system rejects the natural construction,
    // but a hand-rolled GraphDef or a cast can bypass that). If the
    // referent check is wrong, removing the extension kind would orphan
    // the compile-time edge's `to` endpoint at the next deploy.
    const Document = defineNode("Document", {
      schema: z.object({ title: z.string() }),
    });
    const tagged = defineEdge("tagged", {
      schema: z.object({}),
    });
    const seedGraph = defineGraph({
      id: "remove_kinds_referent_test",
      nodes: { Document: { type: Document } },
      edges: { tagged: { type: tagged, from: [Document], to: [Document] } },
    });

    // Cast-mutate `tagged.to` to reference an extension kind `Tag` that
    // isn't a compile-time node. `planRemovals` walks `graph.edges`
    // through this exact shape (`{ kind: string }` records) — see
    // `findCompileTimeReferents` in `graph-extension/remove.ts`.
    const syntheticGraph = {
      ...seedGraph,
      edges: {
        tagged: {
          ...seedGraph.edges.tagged,
          to: [{ kind: "Tag" }],
        },
      },
      extension: {
        version: 1,
        nodes: { Tag: { properties: { label: { type: "string" as const } } } },
      },
    } as unknown as typeof seedGraph;

    expect(() => planRemovals(syntheticGraph, ["Tag"])).toThrow(
      KindHasReferentsError,
    );

    const error = (() => {
      try {
        planRemovals(syntheticGraph, ["Tag"]);
        return;
      } catch (error_) {
        return error_;
      }
    })();
    if (!(error instanceof KindHasReferentsError)) {
      throw new Error("expected KindHasReferentsError");
    }
    expect(error.referents).toEqual([
      { type: "compile-time-edge", name: "tagged" },
    ]);
  });

  it("idempotent removal: removing the same kind twice is a no-op the second time", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const first = await evolved.removeKinds(["Tag"]);
    const versionAfterFirst = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;

    const second = await first.removeKinds(["Tag"]);
    const versionAfterSecond = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;

    expect(versionAfterSecond).toBe(versionAfterFirst);
    expect(second.registry.hasNodeType("Tag")).toBe(false);
  });
});

describe("Store.removeKinds — pending data-cleanup status", () => {
  it("queues each removed kind in the pending-removals table", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: { properties: { label: { type: "string" } } },
        },
      }),
    );
    const tagsBefore = evolved.getNodeCollectionOrThrow("Tag");
    await tagsBefore.create({ label: "alpha" });
    await tagsBefore.create({ label: "beta" });

    await evolved.removeKinds(["Tag"]);

    const pending = await requireDefined(backend.getPendingKindRemovals)(
      baseGraph.id,
    );
    const tagPending = pending.find((row) => row.kindName === "Tag");
    expect(tagPending).toBeDefined();
    expect(tagPending?.entity).toBe("node");
    expect(tagPending?.removedAt).toBeUndefined();
  });
});

describe("Store.materializeRemovals", () => {
  it("deletes orphan rows for a queued removal and clears the pending status", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });
    await tags.create({ label: "beta" });

    const removed = await evolved.removeKinds(["Tag"]);
    const result = await removed.materializeRemovals();

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.kind).toBe("Tag");
    expect(result.results[0]?.status).toBe("removed");

    const stillPending = await requireDefined(backend.getPendingKindRemovals)(
      baseGraph.id,
    );
    expect(stillPending).toHaveLength(0);
  });

  it("closes recorded rows when materializing removals under history capture", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend, {
      history: true,
    });
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });
    await tags.create({ label: "beta" });
    expect(await countOpenRecordedNodeRows(backend, baseGraph.id, "Tag")).toBe(
      2,
    );

    const removed = await evolved.removeKinds(["Tag"]);
    const result = await removed.materializeRemovals();

    expect(result.results[0]?.status).toBe("removed");
    expect(await countOpenRecordedNodeRows(backend, baseGraph.id, "Tag")).toBe(
      0,
    );
  });

  it("closes recorded rows by kind, preserves history, and is idempotent on retry", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend, {
      history: true,
    });
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });
    await tags.create({ label: "beta" });

    const removed = await evolved.removeKinds(["Tag"]);
    await removed.materializeRemovals();

    // The live deletes commit before the recorded close, so the close must
    // work from the kind (not ids read from the now-empty live tables).
    expect(await countOpenRecordedNodeRows(backend, baseGraph.id, "Tag")).toBe(
      0,
    );
    // History is closed, not deleted: the pre-removal state stays
    // reconstructable.
    expect(await countRecordedNodeRows(backend, baseGraph.id, "Tag")).toBe(2);

    // Re-running recovers gracefully (the path a previously-failed close
    // would take): no error, nothing left open.
    await expect(removed.materializeRemovals()).resolves.toBeDefined();
    expect(await countOpenRecordedNodeRows(backend, baseGraph.id, "Tag")).toBe(
      0,
    );
  });

  it("eager runs cleanup inline and removes data atomically with schema", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });

    await evolved.removeKinds(["Tag"], { eager: {} });

    // Pending removals is empty after eager cleanup.
    const pending = await requireDefined(backend.getPendingKindRemovals)(
      baseGraph.id,
    );
    expect(pending).toHaveLength(0);
  });

  it("returns an empty result when there are no pending removals", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const result = await store.materializeRemovals();
    expect(result.results).toEqual([]);
  });

  it("recovers from a removeKinds() crash window: schema committed, queue write missing", async () => {
    // `removeKinds()` commits the schema diff before recording the
    // cleanup queue. If the queue write fails between those steps the
    // schema is durable but the queue lacks the rows the cleanup pass
    // needs — and a retry of `removeKinds()` short-circuits on the
    // no-op path because the kind is already absent. Reconciliation
    // recovers by walking schema history.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });
    await tags.create({ label: "beta" });

    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Tag" }),
    ).toBe(2);

    // Simulate the crash window: commit the schema diff (Tag removed)
    // through `migrateSchema` directly, bypassing `removeKinds` and
    // its queue write. baseGraph's compile-time slice has Person only;
    // committing it as the new active schema is structurally
    // equivalent to a successful Tag removal that crashed before the
    // queue insert.
    const evolvedVersion = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    await migrateSchema(backend, baseGraph, evolvedVersion);

    // The queue is empty (the crash window). Tag rows are orphaned
    // because the schema doesn't reference Tag any more.
    const pendingAfterCrash = await requireDefined(
      backend.getPendingKindRemovals,
    )(baseGraph.id);
    expect(pendingAfterCrash).toHaveLength(0);
    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Tag" }),
    ).toBe(2);

    // A fresh store reading the same database. `materializeRemovals()`
    // walks schema history, finds Tag missing in active, reconciles
    // the queue, then runs cleanup.
    const [recovered] = await createStoreWithSchema(baseGraph, backend);
    const result = await recovered.materializeRemovals();

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.kind).toBe("Tag");
    expect(result.results[0]?.entity).toBe("node");
    expect(result.results[0]?.status).toBe("removed");
    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Tag" }),
    ).toBe(0);

    // After cleanup, the queue is empty (rows are completed, not pending).
    const pendingAfterRecover = await requireDefined(
      backend.getPendingKindRemovals,
    )(baseGraph.id);
    expect(pendingAfterRecover).toHaveLength(0);

    // A second materializeRemovals() is a no-op — reconciliation
    // re-records the row idempotently (COALESCE preserves the prior
    // success), so nothing surfaces as new work.
    const second = await recovered.materializeRemovals();
    expect(second.results).toHaveLength(0);
  });

  it("recovers when additional schema commits happen after the crashed removeKinds()", async () => {
    // The crash window from the previous test followed by additional
    // schema transitions: an evolve adds a new kind at v3 while the
    // crash-window queue gap is at v2. Active-vs-prior reconciliation
    // would only inspect (v2, v3) — Tag is still gone in v3 but no
    // KIND was removed at the v3 transition itself, so a single-step
    // reconciler would conclude there's nothing to do and leave the
    // v2 orphans behind. The fix walks history all the way back, so
    // the v2 → v1 transition still surfaces Tag as a missing removal.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    // v2 (evolve adds Tag).
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const tags = evolved.getNodeCollectionOrThrow("Tag");
    await tags.create({ label: "alpha" });

    // v3 (simulated crash-window removal — schema dropped, queue empty).
    const versionBeforeRemoveCrash = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    await migrateSchema(backend, baseGraph, versionBeforeRemoveCrash);

    const pendingAfterCrash = await requireDefined(
      backend.getPendingKindRemovals,
    )(baseGraph.id);
    expect(
      pendingAfterCrash.filter((row) => row.kindName === "Tag"),
    ).toHaveLength(0);

    // v4 (evolve adds an unrelated kind so the active version is no
    // longer adjacent to the crash-window transition).
    const versionBeforeReevolve = requireDefined(
      await backend.getActiveSchema(baseGraph.id),
    ).version;
    const reevolveExtension = defineGraphExtension({
      nodes: { Note: { properties: { body: { type: "string" } } } },
    });
    const merged = mergeGraphExtension(baseGraph, reevolveExtension);
    await migrateSchema(backend, merged, versionBeforeReevolve);

    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Tag" }),
    ).toBe(1);

    // Reconciliation walks all the way back: active (Tag absent) →
    // prior (Tag absent) → prior-prior (Tag present) — the diff at
    // version (versionBeforeRemoveCrash + 1) surfaces Tag as a
    // recovered removal even though the active transition had no
    // removals at all.
    const [recovered] = await createStoreWithSchema(merged, backend);
    const result = await recovered.materializeRemovals();

    expect(result.results.find((r) => r.kind === "Tag")?.status).toBe(
      "removed",
    );
    expect(
      await backend.countNodesByKind({ graphId: baseGraph.id, kind: "Tag" }),
    ).toBe(0);
  });
});

describe("Store.removeKinds — re-add and re-remove cycle", () => {
  it("queues a fresh pending row when a kind is removed, re-added via evolve, then removed again", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const tagExtension = defineGraphExtension({
      nodes: { Tag: { properties: { label: { type: "string" } } } },
    });

    const v1 = await store.evolve(tagExtension);
    const tags1 = v1.getNodeCollectionOrThrow("Tag");
    await tags1.create({ label: "alpha" });

    const removed1 = await v1.removeKinds(["Tag"]);
    const cleanup1 = await removed1.materializeRemovals();
    expect(cleanup1.results[0]?.status).toBe("removed");
    expect(
      await requireDefined(backend.getPendingKindRemovals)(baseGraph.id),
    ).toHaveLength(0);

    // Re-add the same kind, write data, then remove again. The
    // status table is keyed on (graph_id, kind_name, entity,
    // schema_version) — without `schema_version` in the key, the
    // second queue write would overwrite the first row's
    // `removed_at` via COALESCE and silently leave alpha2 orphaned.
    const v2 = await removed1.evolve(tagExtension);
    const tags2 = v2.getNodeCollectionOrThrow("Tag");
    await tags2.create({ label: "alpha2" });
    const removed2 = await v2.removeKinds(["Tag"]);

    const stillPending = await requireDefined(backend.getPendingKindRemovals)(
      baseGraph.id,
    );
    expect(stillPending.find((row) => row.kindName === "Tag")).toBeDefined();

    const cleanup2 = await removed2.materializeRemovals();
    expect(cleanup2.results.find((entry) => entry.kind === "Tag")?.status).toBe(
      "removed",
    );
  });

  it("queues node and edge removals separately when they share a kind name", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          Tag: {
            from: ["Person"],
            to: ["Tag"],
            properties: { since: { type: "string" } },
          },
        },
      }),
    );

    await evolved.removeKinds(["Tag"]);

    const pending = await requireDefined(backend.getPendingKindRemovals)(
      baseGraph.id,
    );
    const tagRows = pending.filter((row) => row.kindName === "Tag");
    // Without `entity` in the PK, the second upsert collapses onto
    // the first, dropping one of the two pending rows.
    expect(tagRows).toHaveLength(2);
    expect(tagRows.map((row) => row.entity).toSorted()).toEqual([
      "edge",
      "node",
    ]);
  });
});

describe("Store.removeKinds — stale-store recovery", () => {
  // Without stripping the local extension first, `#catchUpToStored`'s
  // merge unions stale local extension nodes back on top of the
  // persisted document, resurrecting kinds another writer has removed.
  it("a stale store evolving with a new kind does NOT resurrect a removed kind", async () => {
    const backend = createTestBackend();
    const [storeA] = await createStoreWithSchema(baseGraph, backend);
    const staleWithTag = await storeA.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );

    const [storeB] = await createStoreWithSchema(baseGraph, backend);
    const evolvedB = await storeB.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    await evolvedB.removeKinds(["Tag"]);

    const evolved = await staleWithTag.evolve(
      defineGraphExtension({
        nodes: { Category: { properties: { name: { type: "string" } } } },
      }),
    );

    expect(evolved.registry.hasNodeType("Tag")).toBe(false);
    expect(
      evolved.introspect().kinds.find((k) => k.name === "Tag"),
    ).toBeUndefined();
    expect(evolved.registry.hasNodeType("Category")).toBe(true);

    const [restored] = await createStoreWithSchema(baseGraph, backend);
    expect(restored.registry.hasNodeType("Tag")).toBe(false);
    expect(restored.registry.hasNodeType("Category")).toBe(true);
  });
});

describe("Store.removeKinds — restart parity", () => {
  it("a fresh store reading the same database does not see the removed kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    await evolved.removeKinds(["Tag"]);

    const [reloaded] = await createStoreWithSchema(baseGraph, backend);
    expect(reloaded.registry.hasNodeType("Tag")).toBe(false);
    expect(
      reloaded.introspect().kinds.find((k) => k.name === "Tag"),
    ).toBeUndefined();
    // Person (the compile-time kind) is unaffected.
    expect(reloaded.registry.hasNodeType("Person")).toBe(true);
  });
});

// Surface KindNotFoundError unused-import marker so the import
// stays useful — KindNotFoundError is the public surface for
// "I just operated on a kind that's gone" and is documented as the
// correct catch type for post-remove access patterns.
void KindNotFoundError;
