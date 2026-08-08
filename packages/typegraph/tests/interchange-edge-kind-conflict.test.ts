/**
 * An interchange edge is matched against a stored row only when that row
 * carries the same kind.
 *
 * Edge ids are graph-global, but the import's existence probe (`getEdge` /
 * `getEdges`) is keyed on `(graph_id, id)` with no kind comparison. So a
 * document edge of kind A whose id is already taken by a kind-B row found that
 * row and every conflict strategy treated it as the same edge:
 *
 * - `update` called `backend.updateEdge` WITHOUT `kind`, so A's properties were
 *   written onto the kind-B row — a silent cross-kind overwrite with nothing in
 *   `result.errors`. `UpdateEdgeParams.kind` exists precisely to put that
 *   predicate in the statement's own `WHERE`, and it MUST be applied when
 *   present; not passing it left the guarantee unused.
 * - `skip` counted the document's edge as already present when no edge of its
 *   kind was ever there — silent loss, since the id is unique per graph and the
 *   incoming edge can never be created under it either.
 *
 * Nodes are structurally safe: their probe is `getNode(graphId, kind, id)`, so
 * a cross-kind id collision reads as absent. That asymmetry is why this was
 * only ever an edge defect, and it is pinned below.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type GraphBackend, rowPropsToObject } from "../src/backend/types";
import {
  type GraphData,
  importGraph,
  type ImportOptions,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ note: z.string() }),
});

const worksWith = defineEdge("worksWith", {
  schema: z.object({ note: z.string() }),
});

const graph = defineGraph({
  id: "edge_kind_conflict",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
    worksWith: {
      type: worksWith,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

/** Two NODE kinds, for the asymmetry check at the bottom of the suite. */
const twoKindGraph = defineGraph({
  id: "edge_kind_conflict_nodes",
  nodes: { Person: { type: Person }, Company: { type: Company } },
  edges: {},
});

/** The one id both kinds compete for. */
const CONTESTED_ID = "edge-contested";

const CANONICAL_TIMESTAMP = "2024-01-01T00:00:00.000Z";

function importOptions(
  overrides: Partial<ImportOptions>,
): ReturnType<typeof ImportOptionsSchema.parse> {
  return ImportOptionsSchema.parse(overrides);
}

/**
 * A document asserting `worksWith` on the contested id. `repeat` yields the
 * SAME edge twice, which is what pushes the second occurrence onto the per-row
 * fallback (`processEdge`) instead of the batched slice — the two code paths
 * this defect existed on independently.
 */
function conflictingDocument(
  repeat: boolean,
  note = "written by the import",
): GraphData {
  const edge = {
    kind: "worksWith",
    id: CONTESTED_ID,
    from: { kind: "Person", id: "person-a" },
    to: { kind: "Person", id: "person-b" },
    properties: { note },
  };
  return {
    formatVersion: "2.0",
    exportedAt: CANONICAL_TIMESTAMP,
    source: { type: "external" },
    nodes: [],
    edges: repeat ? [edge, edge] : [edge],
  };
}

/**
 * Makes the import's existence probe report the contested id under `kind`,
 * whatever the database actually holds — a deterministic stand-in for the
 * window the `kind` predicate closes: the row the probe read is not the row the
 * write will find.
 *
 * Wrapped at `transaction()` because the import runs its reads and writes
 * through the TRANSACTION-scoped backend, not the root one a test can spy on
 * directly.
 */
function spoofProbedEdgeKind(backend: GraphBackend, kind: string): void {
  const runTransaction = backend.transaction;
  const spoof = <T extends { id: string; kind: string }>(row: T): T =>
    row.id === CONTESTED_ID ? { ...row, kind } : row;
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const readEdge = target.getEdge;
      const readEdges = target.getEdges;
      return run({
        ...target,
        getEdge: async (graphId, id) => {
          const row = await readEdge(graphId, id);
          return row === undefined ? row : spoof(row);
        },
        ...(readEdges === undefined ?
          {}
        : {
            getEdges: async (graphId, ids) => {
              const rows = await readEdges(graphId, ids);
              return rows.map((row) => spoof(row));
            },
          }),
      });
    }, options),
  );
}

/** What the stored row says now — the assertion that catches the overwrite. */
async function storedEdge(
  backend: GraphBackend,
): Promise<Readonly<{ kind: string; note: unknown }>> {
  const row = await backend.getEdge(graph.id, CONTESTED_ID);
  if (row === undefined) throw new Error("The contested edge disappeared.");
  return { kind: row.kind, note: rowPropsToObject(row.props)["note"] };
}

describe("Interchange edge kind conflicts", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close();
  });

  async function seed(): Promise<{
    backend: GraphBackend;
    store: ReturnType<typeof createStore<typeof graph>>;
  }> {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    const backend = createSqliteBackend(drizzle(database));
    const store = createStore(graph, backend);
    const alice = await store.nodes.Person.create(
      { name: "Alice" },
      { id: "person-a" },
    );
    const bob = await store.nodes.Person.create(
      { name: "Bob" },
      { id: "person-b" },
    );
    // The incumbent: kind `knows`, holding the contested id.
    await store.edges.knows.create(
      alice,
      bob,
      { note: "original" },
      { id: CONTESTED_ID },
    );
    return { backend, store };
  }

  for (const repeat of [false, true]) {
    const path = repeat ? "per-row" : "batched";

    it(`refuses a cross-kind id on the ${path} update path and leaves the stored row untouched`, async () => {
      const { backend, store } = await seed();

      const result = await importGraph(
        store,
        conflictingDocument(repeat),
        importOptions({ onConflict: "update" }),
      );

      // The kind-B row is exactly as it was: neither its kind nor its props
      // were rewritten by an edge of another kind.
      expect(await storedEdge(backend)).toEqual({
        kind: "knows",
        note: "original",
      });
      // ...and the caller is TOLD, which is the half that made the overwrite
      // silent rather than merely wrong.
      expect(result.success).toBe(false);
      expect(result.edges.updated).toBe(0);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          entityType: "edge",
          kind: "worksWith",
          id: CONTESTED_ID,
          error: expect.stringMatching(
            /INTERCHANGE_EDGE_KIND_CONFLICT/,
          ) as unknown as string,
        }),
      );
      // The message names both kinds, so the caller can act without re-reading
      // the database.
      const reported = result.errors.find(
        (entry) => entry.id === CONTESTED_ID,
      )?.error;
      expect(reported).toContain('already exists with kind "knows"');
      expect(reported).toContain('states kind "worksWith"');
    });

    it(`refuses a cross-kind id on the ${path} skip path rather than counting it as present`, async () => {
      // `skip` means "keep the existing edge and ignore the incoming one".
      // There IS no existing edge of the incoming kind, and the id is unique
      // per graph, so the incoming edge can never land — reporting it is the
      // only outcome that is not a silent loss.
      const { backend, store } = await seed();

      const result = await importGraph(
        store,
        conflictingDocument(repeat),
        importOptions({ onConflict: "skip" }),
      );

      expect(await storedEdge(backend)).toEqual({
        kind: "knows",
        note: "original",
      });
      expect(result.edges.skipped).toBe(0);
      expect(result.success).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          id: CONTESTED_ID,
          error: expect.stringMatching(
            /INTERCHANGE_EDGE_KIND_CONFLICT/,
          ) as unknown as string,
        }),
      );
    });
  }

  it("refuses the update when the row stops matching between the probe and the write", async () => {
    // The probe-time check above is a read-then-write pair keyed on
    // `(graph_id, id)`, and PostgreSQL READ COMMITTED re-resolves that id
    // between the two — a concurrent hard-delete-and-recreate lands the write
    // on a row the check never saw. `UpdateEdgeParams.kind` exists to move the
    // predicate into the UPDATE's own WHERE, which is the only placement that
    // window cannot be opened around.
    //
    // Reproduced deterministically by making the PROBE lie: it reports the
    // contested id as already being `worksWith`, so the import's own check
    // passes, while the database still holds the `knows` row the write will
    // meet. Without the predicate in the statement, this is exactly the silent
    // cross-kind overwrite — a check that had already been passed.
    const { backend, store } = await seed();
    spoofProbedEdgeKind(backend, "worksWith");

    const result = await importGraph(
      store,
      conflictingDocument(false),
      importOptions({ onConflict: "update" }),
    );

    vi.restoreAllMocks();
    // The kind-B row is untouched: the write matched nothing rather than
    // landing on it.
    expect(await storedEdge(backend)).toEqual({
      kind: "knows",
      note: "original",
    });
    // ...and the zero-row write is reported per row, not thrown, so an import
    // whose earlier rows are already written is not aborted for it.
    expect(result.success).toBe(false);
    expect(result.edges.updated).toBe(0);
    const reported = result.errors.find(
      (entry) => entry.id === CONTESTED_ID,
    )?.error;
    expect(reported).toContain("INTERCHANGE_EDGE_KIND_CONFLICT");
    expect(reported).toContain("no live edge with that id and kind remained");
  });

  it("still updates an edge whose stored row carries the SAME kind", async () => {
    // The guard must not cost the case it is not about: a matching kind
    // updates exactly as before, now with the kind stated in the write's own
    // WHERE clause.
    const { backend, store } = await seed();
    const document: GraphData = {
      formatVersion: "2.0",
      exportedAt: CANONICAL_TIMESTAMP,
      source: { type: "external" },
      nodes: [],
      edges: [
        {
          kind: "knows",
          id: CONTESTED_ID,
          from: { kind: "Person", id: "person-a" },
          to: { kind: "Person", id: "person-b" },
          properties: { note: "updated" },
        },
      ],
    };

    const result = await importGraph(
      store,
      document,
      importOptions({ onConflict: "update" }),
    );

    expect(result.success).toBe(true);
    expect(result.edges.updated).toBe(1);
    expect(await storedEdge(backend)).toEqual({
      kind: "knows",
      note: "updated",
    });
  });

  it("leaves a cross-kind NODE id alone: the node probe is already kind-scoped", async () => {
    // The reason this was an edge-only defect, pinned so the asymmetry stays a
    // fact rather than an assumption. `getNode(graphId, kind, id)` cannot see a
    // row of another kind, so the incoming node is simply created.
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    const nodeStore = createStore(
      twoKindGraph,
      createSqliteBackend(drizzle(database)),
    );
    await nodeStore.nodes.Person.create({ name: "Shared" }, { id: "shared-1" });

    const result = await importGraph(
      nodeStore,
      {
        formatVersion: "2.0",
        exportedAt: CANONICAL_TIMESTAMP,
        source: { type: "external" },
        nodes: [
          { kind: "Company", id: "shared-1", properties: { name: "Shared" } },
        ],
        edges: [],
      },
      importOptions({ onConflict: "update" }),
    );

    expect(result.success).toBe(true);
    expect(result.nodes.created).toBe(1);
    // Both rows exist, one per kind.
    expect(await nodeStore.nodes.Person.count()).toBe(1);
    expect(await nodeStore.nodes.Company.count()).toBe(1);
  });
});
