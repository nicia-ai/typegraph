/**
 * Tests for removed-embedding-field table reclamation (the #10 completeness
 * fix) via `store.materializeRemovals()`.
 *
 * Per-`(graphId, kind, field)` storage means each embedding field owns a typed
 * table. Dropping the `embedding()` modifier from an array field (keeping the
 * property as a plain number array) is an allowed `evolve` delta: the kind and
 * property survive, but the auto-derived `VectorIndexDeclaration` disappears,
 * orphaning the per-field table the moment the field is removed — no node
 * delete required. `materializeRemovals` reclaims it; remove-then-re-add must
 * NOT (the active schema is the source of truth for "still declared").
 *
 * The kind is introduced via a graph extension (compile-time kinds can't be
 * modified by later extensions). Runs against a real `createLocalSqliteBackend`
 * (better-sqlite3 + sqlite-vec) so the table is physically created and its drop
 * is observable in `sqlite_master`.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { defineGraph } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { createBackendOverlay, type GraphBackend } from "../src/backend/types";
import { defineGraphExtension } from "../src/graph-extension";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { createStoreWithSchema, type Store } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "reclaim_vec";

const baseGraph = defineGraph({ id: GRAPH_ID, nodes: {}, edges: {} });
type BaseStore = Store<typeof baseGraph>;

/** Extension that introduces Document with a 3-dim embedding field. */
const addDocumentWithEmbedding = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: {
          type: "array",
          items: { type: "number" },
          embedding: { dimensions: 3 },
        },
      },
    },
  },
});

/** Extension that strips the embedding modifier, keeping a plain number array. */
const dropEmbeddingModifier = defineGraphExtension({
  nodes: {
    Document: {
      properties: {
        title: { type: "string" },
        embedding: { type: "array", items: { type: "number" } },
      },
    },
  },
});

async function writeDocument(
  store: BaseStore,
  props: Record<string, unknown>,
): Promise<void> {
  await store.getNodeCollectionOrThrow("Document").create(props);
}

describe("reclaimRemovedVectorFieldTables (sqlite-vec, end-to-end)", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createLocalSqliteBackend().backend;
    if (backend.vectorStrategy === undefined) {
      throw new Error("sqlite-vec must be loaded for this suite");
    }
  });

  afterEach(async () => {
    await backend.close();
  });

  async function tableExists(name: string): Promise<boolean> {
    const rows = await backend.execute<{ name: string }>(
      asCompiledRowsSql(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${name}`,
      ),
    );
    return rows.length > 0;
  }

  function perFieldTable(kind: string, fieldPath: string): string {
    return requireDefined(backend.vectorStrategy).tableName(
      GRAPH_ID,
      kind,
      fieldPath,
    );
  }

  async function storeWithMaterializedEmbedding(): Promise<BaseStore> {
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const withField = await store.evolve(addDocumentWithEmbedding);
    await writeDocument(withField, { title: "a", embedding: [1, 0, 0] });
    return withField;
  }

  it("drops the per-field table when an embedding field is removed from a surviving kind", async () => {
    const withField = await storeWithMaterializedEmbedding();
    const table = perFieldTable("Document", "embedding");
    expect(await tableExists(table)).toBe(true);

    const evolved = await withField.evolve(dropEmbeddingModifier);
    const result = await evolved.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([
      { kind: "Document", fieldPath: "embedding", status: "reclaimed" },
    ]);
    expect(await tableExists(table)).toBe(false);
  });

  it("is idempotent: a second pass leaves the table absent", async () => {
    const withField = await storeWithMaterializedEmbedding();
    const evolved = await withField.evolve(dropEmbeddingModifier);

    await evolved.materializeRemovals();
    const second = await evolved.materializeRemovals();

    // Re-derived from immutable history, so still listed; the DROP IF EXISTS
    // is a clean no-op and the table stays gone.
    expect(second.reclaimedVectorFields).toEqual([
      { kind: "Document", fieldPath: "embedding", status: "reclaimed" },
    ]);
    expect(await tableExists(perFieldTable("Document", "embedding"))).toBe(
      false,
    );
  });

  it("does NOT drop a field that was removed then re-added (active schema wins)", async () => {
    const withField = await storeWithMaterializedEmbedding();
    const withoutField = await withField.evolve(dropEmbeddingModifier);
    const readded = await withoutField.evolve(addDocumentWithEmbedding);
    // The re-added field is current — writing repopulates its table.
    await writeDocument(readded, { title: "b", embedding: [0, 1, 0] });

    const result = await readded.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([]);
    expect(await tableExists(perFieldTable("Document", "embedding"))).toBe(
      true,
    );
  });

  it("reports an empty result when no embedding field was ever removed", async () => {
    const withField = await storeWithMaterializedEmbedding();

    const result = await withField.materializeRemovals();

    expect(result.reclaimedVectorFields).toEqual([]);
    expect(await tableExists(perFieldTable("Document", "embedding"))).toBe(
      true,
    );
  });

  it("drops the per-field table when the whole KIND is removed (removed-kind path)", async () => {
    // removeKinds cleanup goes through buildEmbeddingTableCleanup ->
    // buildDropStorage (not reclaimedVectorFields, which is for surviving
    // kinds). The kind's per-field storage must be fully dropped.
    const withField = await storeWithMaterializedEmbedding();
    const table = perFieldTable("Document", "embedding");
    expect(await tableExists(table)).toBe(true);

    const removed = await withField.removeKinds(["Document"]);
    const result = await removed.materializeRemovals();

    expect(
      result.results.some(
        (entry) => entry.kind === "Document" && entry.status === "removed",
      ),
    ).toBe(true);
    expect(await tableExists(table)).toBe(false);
  });

  it("store.clear() resets per-field vector storage — no leaked/stale vectors (#1)", async () => {
    const withField = await storeWithMaterializedEmbedding(); // wrote "a" [1,0,0]
    // Raw backend vector rows are unfiltered by node existence, so they expose
    // a storage leak that node-joined search would hide.
    const rawParams = {
      graphId: GRAPH_ID,
      nodeKind: "Document",
      fieldPath: "embedding",
      queryEmbedding: [1, 0, 0],
      metric: "cosine" as const,
      dimensions: 3,
      indexType: "none" as const,
      limit: 10,
    };
    const before = await requireDefined(backend.vectorSearch)(rawParams);
    expect(before.length).toBe(1);

    await withField.clear();

    // The leaked row is gone — clear() reset the per-field storage.
    const after = await requireDefined(backend.vectorSearch)(rawParams);
    expect(after).toEqual([]);

    // Latch still valid: a fresh write + search works (no "no such table").
    await writeDocument(withField, { title: "fresh", embedding: [0, 1, 0] });
    const hits = await withField.search.vector("Document", {
      fieldPath: "embedding",
      queryEmbedding: [0, 1, 0],
      limit: 10,
    });
    expect(hits.map((hit) => hit.node["title"])).toEqual(["fresh"]);
  });

  it("memoizes the reclaim history walk per active version (#12)", async () => {
    let calls = 0;
    const observedBackend = createBackendOverlay(backend, {
      getSchemaVersion(graphId, version) {
        calls += 1;
        return backend.getSchemaVersion(graphId, version);
      },
    });
    const [store] = await createStoreWithSchema(baseGraph, observedBackend);
    const withField = await store.evolve(addDocumentWithEmbedding);
    await writeDocument(withField, { title: "a", embedding: [1, 0, 0] });
    const evolved = await withField.evolve(dropEmbeddingModifier);

    // Count schema-version reads to prove the second pass doesn't re-walk
    // history (reconcile's marker + reclaim's per-version memo both short-circuit).
    calls = 0;
    await evolved.materializeRemovals();
    const firstPassCalls = calls;
    calls = 0;
    await evolved.materializeRemovals();

    expect(firstPassCalls).toBeGreaterThan(0);
    expect(calls).toBe(0);
  });
});
