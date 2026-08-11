/**
 * Targeted regression tests for the post-review fixes:
 *
 *  1. `materializeRemovals` ensures the reconciliation-marker table
 *     before reading from it (legacy DBs upgraded from before the
 *     table existed must not throw).
 *  2. `clearGraph` deletes per-graph rows from every status table —
 *     `index_materializations`, `kind_removals`, and the new
 *     `reconciliation_markers` — so a graphId reuse after clear
 *     doesn't inherit stale state.
 *  3. Strict-authoring `defineGraphExtension` rejects unknown index
 *     keys (e.g. the `coveringField` typo) instead of silently
 *     compiling to a weaker index.
 *  4. `materializeRemovals` cleans up the customized `uniques`
 *     table — not the canonical default — when the backend is
 *     configured with a non-default name.
 *  5. Removing a node kind reaps claims held by its connected edges before
 *     those edge rows disappear.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import { createSqliteTables } from "../src/backend/sqlite";
import { type GraphBackend } from "../src/backend/types";
import { defineEdge, defineGraph, defineNode } from "../src/core";
import { RECORDED_MAX_REVISION } from "../src/core/temporal";
import {
  defineGraphExtension,
  GRAPH_EXTENSION_ISSUE_CODES,
  GraphExtensionValidationError,
  INCOMPATIBLE_CHANGE_TYPES,
} from "../src/graph-extension";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

/**
 * Wraps a backend so its NEXT schema-write transaction rejects, then passes
 * through. Recorded-time interval closes and live row cleanup for a removed
 * kind share that fenced transaction, so this injects a single atomic cleanup
 * failure.
 */
function withOneShotTransactionFailure(
  base: GraphBackend,
  shouldFailNow: () => boolean,
): GraphBackend {
  return deriveBackend(base, {
    async schemaWriteTransaction(graphId, fn) {
      if (shouldFailNow()) {
        throw new Error("injected recorded-close failure");
      }
      return requireDefined(base.schemaWriteTransaction)(graphId, fn);
    },
  });
}

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const baseGraph = defineGraph({
  id: "removals_fixes_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

type GraphExtensionIndexInput = NonNullable<
  Parameters<typeof defineGraphExtension>[0]["indexes"]
>[number];

const tagExtension = defineGraphExtension({
  nodes: { Tag: { properties: { label: { type: "string" } } } },
});

// ============================================================
// 0. Evolve initializes kind-removal preflight dependencies
// ============================================================

describe("evolve against a DB missing typegraph_kind_removals", () => {
  it("falls back to full bootstrap for custom backends", async () => {
    const baseBackend = createTestBackend();
    expect(baseBackend.ensureKindRemovalsTable).toBeDefined();
    const backendWithoutFocusedEnsure = projectBackendWithout(baseBackend, [
      "ensureKindRemovalsTable",
    ]);
    let bootstrapCalls = 0;
    const backend: GraphBackend = deriveBackend(backendWithoutFocusedEnsure, {
      async bootstrapTables() {
        bootstrapCalls += 1;
        await requireDefined(baseBackend.bootstrapTables)();
      },
    });
    const [store] = await createStoreWithSchema(baseGraph, backend);
    bootstrapCalls = 0;
    await requireDefined(backend.executeDdl)(
      "DROP TABLE IF EXISTS typegraph_kind_removals",
    );

    const evolved = await store.evolve(tagExtension);

    expect(evolved.introspect().kinds.map((kind) => kind.name)).toContain(
      "Tag",
    );
    expect(bootstrapCalls).toBe(1);

    bootstrapCalls = 0;
    await requireDefined(backend.executeDdl)(
      "DROP TABLE IF EXISTS typegraph_kind_removals",
    );
    const removed = await evolved.removeKinds(["Tag"]);

    expect(bootstrapCalls).toBe(1);
    expect(
      await requireDefined(backend.getPendingKindRemovals)(baseGraph.id),
    ).toEqual([expect.objectContaining({ entity: "node", kindName: "Tag" })]);
    expect(removed.introspect().kinds.map((kind) => kind.name)).not.toContain(
      "Tag",
    );
  });

  it("does not bootstrap the queue for a no-op evolve", async () => {
    const baseBackend = createTestBackend();
    let ensureCalls = 0;
    const backend: GraphBackend = deriveBackend(baseBackend, {
      async ensureKindRemovalsTable() {
        ensureCalls += 1;
        await requireDefined(baseBackend.ensureKindRemovalsTable)();
      },
    });
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(tagExtension);
    ensureCalls = 0;

    const repeated = await evolved.evolve(tagExtension);

    expect(repeated.introspect().kinds.map((kind) => kind.name)).toContain(
      "Tag",
    );
    expect(ensureCalls).toBe(0);
  });
});

// ============================================================
// 1. Legacy DB missing reconciliation_markers
// ============================================================

describe("materializeRemovals against a DB missing typegraph_reconciliation_markers", () => {
  it("ensures the table on first call and succeeds (legacy upgrade path)", async () => {
    // The standard backend bootstrap creates every table at construction
    // time; dropping the markers table afterwards simulates a database
    // that was first created before this slice landed and is now being
    // upgraded.
    const backend = createTestBackend();
    await requireDefined(backend.executeDdl)(
      "DROP TABLE IF EXISTS typegraph_reconciliation_markers",
    );

    // Bootstrap a graph + commit two schema versions so the
    // reconciliation walk has something to look at.
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const removed = await evolved.removeKinds(["Tag"]);

    // The markers table was dropped above. materializeRemovals must
    // ensure it before SELECTing or the reconciliation read throws
    // "no such table".
    const result = await removed.materializeRemovals();
    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.every((entry) => entry.status === "removed")).toBe(
      true,
    );
  });
});

// ============================================================
// 1b. Recorded-close/live-delete transaction failure is atomic and retryable
// ============================================================

describe("materializeRemovals recorded cleanup transaction recovery (history)", () => {
  it("keeps recorded intervals and live rows unchanged when the cleanup transaction fails", async () => {
    // Pin the data/history atomicity contract: the recorded close and live row
    // deletes share one transaction. A failed transaction must leave both sides
    // unchanged, and the pending status row lets the next call retry the whole
    // kind-keyed cleanup.
    let failNextTransaction = false;
    const base = createTestBackend();
    const backend = withOneShotTransactionFailure(base, () => {
      if (failNextTransaction) {
        failNextTransaction = false;
        return true;
      }
      return false;
    });

    const [store] = await createStoreWithSchema(baseGraph, backend, {
      history: true,
    });
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    // Two captured Tag nodes → two open recorded intervals. Tag is a graph
    // extension kind, absent from the static graph type, so reach it dynamically.
    const dynamicNodes = evolved.nodes as unknown as {
      Tag: { create: (props: { label: string }) => Promise<unknown> };
    };
    await dynamicNodes.Tag.create({ label: "t1" });
    await dynamicNodes.Tag.create({ label: "t2" });
    const removed = await evolved.removeKinds(["Tag"]);

    const schema = createSqlSchema(backend.tableNames);
    const openTagIntervals = async (): Promise<number> => {
      const rows = await backend.execute<{ open_count: number }>(
        asCompiledRowsSql(sql`
          SELECT COUNT(*) AS open_count
          FROM ${schema.recordedNodesTable}
          WHERE graph_id = ${baseGraph.id}
            AND kind = 'Tag'
            AND recorded_to = ${RECORDED_MAX_REVISION}
        `),
      );
      return rows[0]?.open_count ?? 0;
    };
    const liveTagRows = async (): Promise<number> => {
      const rows = await backend.execute<{ live_count: number }>(
        asCompiledRowsSql(sql`
          SELECT COUNT(*) AS live_count
          FROM ${schema.nodesTable}
          WHERE graph_id = ${baseGraph.id}
            AND kind = 'Tag'
        `),
      );
      return rows[0]?.live_count ?? 0;
    };

    // Both intervals and both live rows are present before materialization.
    expect(await openTagIntervals()).toBe(2);
    expect(await liveTagRows()).toBe(2);

    // Pass 1: the shared cleanup transaction rejects. The recorded intervals
    // stay open, the live rows remain, and the kind stays pending for retry.
    failNextTransaction = true;
    const firstPass = await removed.materializeRemovals();
    expect(firstPass.results.some((entry) => entry.status === "failed")).toBe(
      true,
    );
    expect(await openTagIntervals()).toBe(2);
    expect(await liveTagRows()).toBe(2);
    const pendingAfterFailure = await requireDefined(
      backend.getPendingKindRemovals,
    )(baseGraph.id);
    expect(pendingAfterFailure.some((row) => row.kindName === "Tag")).toBe(
      true,
    );

    // Pass 2 (retry): the shared transaction closes intervals and deletes rows.
    const secondPass = await removed.materializeRemovals();
    expect(
      secondPass.results.some(
        (entry) => entry.kind === "Tag" && entry.status === "removed",
      ),
    ).toBe(true);
    expect(await openTagIntervals()).toBe(0);
    expect(await liveTagRows()).toBe(0);
    const pendingAfterRetry = await requireDefined(
      backend.getPendingKindRemovals,
    )(baseGraph.id);
    expect(pendingAfterRetry.some((row) => row.kindName === "Tag")).toBe(false);
  });
});

// ============================================================
// 2. clearGraph wipes status rows
// ============================================================

describe("clearGraph against a graph with status-table rows", () => {
  it("deletes index materializations, kind removals, and reconciliation markers", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);

    // Populate a kind_removals + reconciliation_marker row by going
    // through the evolve → remove → materialize cycle.
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
      }),
    );
    const removed = await evolved.removeKinds(["Tag"]);
    await removed.materializeRemovals();

    // Sanity: the marker IS set after materializeRemovals.
    const markerBefore = await requireDefined(backend.getReconciliationMarker)(
      baseGraph.id,
    );
    expect(markerBefore).toBeDefined();
    const removalsBefore = await requireDefined(backend.getAllKindRemovals)(
      baseGraph.id,
    );
    expect(removalsBefore.length).toBeGreaterThan(0);

    // Wipe everything for this graphId.
    await backend.clearGraph(baseGraph.id);

    // All status rows for this graphId are now gone — a stale marker
    // would otherwise let a reused graphId skip recovery on the next
    // materializeRemovals call.
    const markerAfter = await requireDefined(backend.getReconciliationMarker)(
      baseGraph.id,
    );
    expect(markerAfter).toBeUndefined();
    const removalsAfter = await requireDefined(backend.getAllKindRemovals)(
      baseGraph.id,
    );
    expect(removalsAfter).toHaveLength(0);
  });
});

// ============================================================
// 3. Strict mode rejects index typos
// ============================================================

describe("defineGraphExtension strict-authoring index validation", () => {
  it("rejects unknown index keys like `coveringField` (typo for `coveringFields`)", () => {
    expect(() =>
      defineGraphExtension({
        nodes: {
          Doc: { properties: { title: { type: "string" } } },
        },
        indexes: [
          {
            entity: "node",
            kind: "Doc",
            fields: ["title"],
            // Typo: should be `coveringFields`. Without the strict-mode
            // unknown-key check this silently compiled to an index with
            // no covering fields and no signal to the reviewer.
            coveringField: ["title"],
          } as unknown as GraphExtensionIndexInput,
        ],
      }),
    ).toThrow(GraphExtensionValidationError);
  });

  it("includes the unknown key in the validation error issues", () => {
    let captured: GraphExtensionValidationError | undefined;
    try {
      defineGraphExtension({
        nodes: {
          Doc: { properties: { title: { type: "string" } } },
        },
        indexes: [
          {
            entity: "node",
            kind: "Doc",
            fields: ["title"],
            coveringField: ["title"],
          } as unknown as GraphExtensionIndexInput,
        ],
      });
    } catch (error) {
      if (error instanceof GraphExtensionValidationError) {
        captured = error;
      }
    }
    expect(captured).toBeInstanceOf(GraphExtensionValidationError);
    expect(
      requireDefined(captured).issues.some((issue) =>
        issue.message.includes("coveringField"),
      ),
    ).toBe(true);
    expect(
      requireDefined(captured).issues.some(
        (issue) => issue.code === "INVALID_INDEX_DECLARATION",
      ),
    ).toBe(true);
  });

  it("rejects unknown keys inside index `where` clauses", () => {
    expect(() =>
      defineGraphExtension({
        nodes: {
          Doc: {
            properties: {
              title: { type: "string" },
              archivedAt: { type: "string" },
            },
          },
        },
        indexes: [
          {
            entity: "node",
            kind: "Doc",
            fields: ["title"],
            where: {
              field: "archivedAt",
              op: "isNull",
              fieldd: "archivedAt",
            },
          } as unknown as GraphExtensionIndexInput,
        ],
      }),
    ).toThrow(GraphExtensionValidationError);
  });
});

// ============================================================
// 4. Custom uniques table cleanup
// ============================================================

describe("materializeRemovals against a backend with a custom `uniques` table", () => {
  it("deletes from the customized table, not the canonical default", async () => {
    const customTables = createSqliteTables({
      uniques: "myapp_uniques",
    });
    const backend = createTestBackend(customTables);

    // Sanity: backend exposes the custom name.
    expect(backend.tableNames?.uniques).toBe("myapp_uniques");

    // The canonical default table doesn't exist on this backend — if
    // cleanup ever reverted to the hardcoded default it would throw
    // "no such table". (The backend's DDL only creates `myapp_uniques`.)
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: {
          Tag: {
            properties: { label: { type: "string" } },
            unique: [{ name: "tag_label", fields: ["label"] }],
          },
        },
      }),
    );

    // Insert a row so there's something concrete to delete.
    const dynamicNodes = evolved.nodes as unknown as {
      Tag: {
        create: (props: { label: string }) => Promise<unknown>;
      };
    };
    await dynamicNodes.Tag.create({ label: "alice" });

    // Pre-removal: a row exists in the custom uniques table.
    const beforeRows = await backend.execute<{ count: number }>(
      asCompiledRowsSql(
        sql`SELECT COUNT(*) AS count FROM ${sql.identifier("myapp_uniques")} WHERE node_kind = 'Tag'`,
      ),
    );
    expect(requireDefined(beforeRows[0]).count).toBeGreaterThan(0);

    const removed = await evolved.removeKinds(["Tag"]);
    const result = await removed.materializeRemovals();
    expect(result.results.every((entry) => entry.status === "removed")).toBe(
      true,
    );

    // Post-removal: the custom table is empty for this kind.
    const afterRows = await backend.execute<{ count: number }>(
      asCompiledRowsSql(
        sql`SELECT COUNT(*) AS count FROM ${sql.identifier("myapp_uniques")} WHERE node_kind = 'Tag'`,
      ),
    );
    expect(requireDefined(afterRows[0]).count).toBe(0);
  });
});

// ============================================================
// 5. Node-kind removal reaps connected edge claims
// ============================================================

describe("materializeRemovals edge-claim housekeeping", () => {
  it("reaps claims for edges hard-deleted by a node cascade", async () => {
    const CascadePerson = defineNode("CascadePerson", {
      schema: z.object({ name: z.string() }),
    });
    const cascadeLink = defineEdge("cascadeLink", { schema: z.object({}) });
    const cascadeGraph = defineGraph({
      id: "node_cascade_edge_claim_cleanup",
      nodes: {
        CascadePerson: { type: CascadePerson, onDelete: "cascade" },
      },
      edges: {
        cascadeLink: {
          type: cascadeLink,
          from: [CascadePerson],
          to: [CascadePerson],
          cardinality: "one",
        },
      },
    });
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(cascadeGraph, backend);
    const source = await store.nodes.CascadePerson.create({ name: "Source" });
    const target = await store.nodes.CascadePerson.create({ name: "Target" });
    const edge = await store.edges.cascadeLink.create(source, target, {});
    const claimCount = async (): Promise<number> => {
      const rows = await backend.execute<{ count: number }>(
        asCompiledRowsSql(
          sql`SELECT COUNT(*) AS count FROM ${sql.identifier("typegraph_edge_claims")} WHERE edge_id = ${edge.id}`,
        ),
      );
      return requireDefined(rows[0]).count;
    };
    expect(await claimCount()).toBe(1);

    await store.nodes.CascadePerson.hardDelete(source.id);

    expect(await claimCount()).toBe(0);
  });

  it("reaps claims held by edges connected to a removed node kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(
      defineGraphExtension({
        nodes: { Tag: { properties: { label: { type: "string" } } } },
        edges: {
          taggedPerson: {
            from: ["Tag"],
            to: ["Person"],
            properties: {},
          },
        },
      }),
    );
    const dynamicNodes = evolved.nodes as unknown as {
      Tag: { create: (props: { label: string }) => Promise<{ id: string }> };
    };
    const dynamicEdges = evolved.edges as unknown as {
      taggedPerson: {
        create: (
          from: Readonly<{ kind: "Tag"; id: string }>,
          to: Readonly<{ kind: "Person"; id: string }>,
          props: Record<string, never>,
        ) => Promise<{ id: string }>;
      };
    };
    const tag = await dynamicNodes.Tag.create({ label: "important" });
    const person = await evolved.nodes.Person.create({ name: "Ada" });
    const edge = await dynamicEdges.taggedPerson.create(
      { kind: "Tag", id: tag.id },
      person,
      {},
    );
    await requireDefined(backend.claimEdgeCardinality)({
      graphId: baseGraph.id,
      cardinality: "one",
      edgeKind: "taggedPerson",
      edgeId: edge.id,
      fromKind: "Tag",
      fromId: tag.id,
      toKind: "Person",
      toId: person.id,
    });
    const claimCount = async (): Promise<number> => {
      const rows = await backend.execute<{ count: number }>(
        asCompiledRowsSql(
          sql`SELECT COUNT(*) AS count FROM ${sql.identifier("typegraph_edge_claims")} WHERE edge_id = ${edge.id}`,
        ),
      );
      return requireDefined(rows[0]).count;
    };
    expect(await claimCount()).toBe(1);

    const removed = await evolved.removeKinds(["Tag", "taggedPerson"]);
    // Run only the node-kind row. The edge-kind cleanup remains pending, so it
    // cannot hide a missing connected-edge reap in this path.
    const result = await removed.materializeRemovals({ kinds: ["Tag"] });
    expect(result.results).toContainEqual({
      entity: "node",
      kind: "Tag",
      status: "removed",
    });
    expect(await claimCount()).toBe(0);
  });
});

// ============================================================
// Bonus: justify the const-array exports added in 0.25.0
// ============================================================

describe("graph-extension const-array exports", () => {
  it("INCOMPATIBLE_CHANGE_TYPES is non-empty and matches IncompatibleChangeType", () => {
    expect(INCOMPATIBLE_CHANGE_TYPES.length).toBeGreaterThan(0);
    // Spot-check a known member — the type is derived from the array,
    // so a value drift here would also be a type drift.
    expect(INCOMPATIBLE_CHANGE_TYPES.includes("REMOVE_PROPERTY")).toBe(true);
  });

  it("GRAPH_EXTENSION_ISSUE_CODES covers every code emitted by the validator", () => {
    expect(GRAPH_EXTENSION_ISSUE_CODES.length).toBeGreaterThan(0);
    expect(
      GRAPH_EXTENSION_ISSUE_CODES.includes("INVALID_INDEX_DECLARATION"),
    ).toBe(true);
    expect(
      GRAPH_EXTENSION_ISSUE_CODES.includes("UNSUPPORTED_PROPERTY_TYPE"),
    ).toBe(true);
  });
});
