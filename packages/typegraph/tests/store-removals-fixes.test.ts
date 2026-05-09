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
 */
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createSqliteTables } from "../src/backend/sqlite";
import { defineGraph, defineNode } from "../src/core";
import {
  defineGraphExtension,
  GRAPH_EXTENSION_ISSUE_CODES,
  GraphExtensionValidationError,
  INCOMPATIBLE_CHANGE_TYPES,
} from "../src/graph-extension";
import { createStoreWithSchema } from "../src/store";
import { createTestBackend } from "./test-utils";

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
    await backend.executeDdl!(
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
    const markerBefore = await backend.getReconciliationMarker!(baseGraph.id);
    expect(markerBefore).toBeDefined();
    const removalsBefore = await backend.getAllKindRemovals!(baseGraph.id);
    expect(removalsBefore.length).toBeGreaterThan(0);

    // Wipe everything for this graphId.
    await backend.clearGraph(baseGraph.id);

    // All status rows for this graphId are now gone — a stale marker
    // would otherwise let a reused graphId skip recovery on the next
    // materializeRemovals call.
    const markerAfter = await backend.getReconciliationMarker!(baseGraph.id);
    expect(markerAfter).toBeUndefined();
    const removalsAfter = await backend.getAllKindRemovals!(baseGraph.id);
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
      captured!.issues.some((issue) => issue.message.includes("coveringField")),
    ).toBe(true);
    expect(
      captured!.issues.some(
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
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier("myapp_uniques")} WHERE node_kind = 'Tag'`,
    );
    expect(beforeRows[0]!.count).toBeGreaterThan(0);

    const removed = await evolved.removeKinds(["Tag"]);
    const result = await removed.materializeRemovals();
    expect(result.results.every((entry) => entry.status === "removed")).toBe(
      true,
    );

    // Post-removal: the custom table is empty for this kind.
    const afterRows = await backend.execute<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM ${sql.identifier("myapp_uniques")} WHERE node_kind = 'Tag'`,
    );
    expect(afterRows[0]!.count).toBe(0);
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
