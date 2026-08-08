/**
 * An interchange edge is matched against a stored row only when that row
 * carries the same IMMUTABLE IDENTITY: kind and both endpoints.
 *
 * Edge ids are graph-global, but the import's existence probe (`getEdge` /
 * `getEdges`) is keyed on `(graph_id, id)` alone. So a document edge whose id is
 * already taken by a different edge found that row and every conflict strategy
 * treated it as the same edge:
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
 * Comparing KIND ALONE closed only half of it. Endpoints are immutable for a
 * given row, so a document naming the incumbent's kind and id but different
 * endpoints was still "the same edge" to the comparison: `update` reported
 * `updated: 1`, overwrote the incumbent's props, and silently kept its old
 * endpoints. The predicate therefore compares all five components, and the
 * update states all five in its own `WHERE`.
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
 * A document whose edge carries the incumbent's KIND but a different endpoint.
 * The half of the immutable identity a kind-only comparison could not see.
 */
function endpointConflictingDocument(
  repeat: boolean,
  note = "written by the import",
): GraphData {
  const edge = {
    kind: "knows",
    id: CONTESTED_ID,
    from: { kind: "Person", id: "person-a" },
    to: { kind: "Person", id: "person-c" },
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

/** The immutable identity components a stored edge row carries. */
type SpoofedIdentity = Partial<
  Readonly<{
    kind: string;
    from_kind: string;
    from_id: string;
    to_kind: string;
    to_id: string;
  }>
>;

/**
 * Makes the import's existence probe report the contested id under `overrides`,
 * whatever the database actually holds — a deterministic stand-in for the
 * window the identity predicate closes: the row the probe read is not the row
 * the write will find.
 *
 * Takes the whole identity rather than the kind alone so the same scaffolding
 * covers both halves; a spoof that could only lie about `kind` would certify
 * only the half that was already fixed.
 *
 * Wrapped at `transaction()` because the import runs its reads and writes
 * through the TRANSACTION-scoped backend, not the root one a test can spy on
 * directly.
 */
function spoofProbedEdgeIdentity(
  backend: GraphBackend,
  overrides: SpoofedIdentity,
): void {
  const runTransaction = backend.transaction;
  const spoof = <T extends { id: string; kind: string }>(row: T): T =>
    row.id === CONTESTED_ID ? { ...row, ...overrides } : row;
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

/**
 * The stored row's FULL state: props plus the immutable identity. Endpoints are
 * immutable, so an update that "succeeded" against a mismatched row would leave
 * the old ones in place — silently discarding the endpoints the document
 * stated. Asserting them is what catches that.
 */
async function storedEdgeState(backend: GraphBackend): Promise<
  Readonly<{
    kind: string;
    from: string;
    to: string;
    note: unknown;
  }>
> {
  const row = await backend.getEdge(graph.id, CONTESTED_ID);
  if (row === undefined) throw new Error("The contested edge disappeared.");
  return {
    kind: row.kind,
    from: `${row.from_kind}:${row.from_id}`,
    to: `${row.to_kind}:${row.to_id}`,
    note: rowPropsToObject(row.props)["note"],
  };
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
    // The third endpoint, so an endpoint-conflicting document names a node that
    // really exists — the refusal must be about identity, not a dangling
    // reference.
    await store.nodes.Person.create({ name: "Carol" }, { id: "person-c" });
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
      expect(reported).toContain('kind "knows"');
      expect(reported).toContain('document states "worksWith"');
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

    it(`refuses a same-kind id whose ENDPOINTS differ on the ${path} update path`, async () => {
      // Kind alone is not an identity. This document names the incumbent's kind
      // and the incumbent's id but points somewhere else, and a kind-only
      // comparison called that the same edge: it reported `updated: 1`, wrote
      // the document's props onto the incumbent, and silently kept the
      // incumbent's endpoints — the document's stated `to` simply discarded,
      // because endpoints are immutable and the update never carried them.
      const { backend, store } = await seed();

      const result = await importGraph(
        store,
        endpointConflictingDocument(repeat),
        importOptions({ onConflict: "update" }),
      );

      expect(await storedEdgeState(backend)).toEqual({
        kind: "knows",
        from: "Person:person-a",
        to: "Person:person-b",
        note: "original",
      });
      expect(result.success).toBe(false);
      expect(result.edges.updated).toBe(0);
      const reported = result.errors.find(
        (entry) => entry.id === CONTESTED_ID,
      )?.error;
      expect(reported).toContain("INTERCHANGE_EDGE_KIND_CONFLICT");
      // The message names the component that differs, so "which one?" does not
      // require re-reading the database.
      expect(reported).toContain('to "Person:person-b"');
      expect(reported).toContain('document states "Person:person-c"');
      // ...and does NOT claim the kind differs, because it does not.
      expect(reported).not.toContain("kind ");
    });

    it(`refuses a same-kind id whose ENDPOINTS differ on the ${path} skip path`, async () => {
      // The arms pair: `skip` counted the document's edge as already present
      // when no edge with those endpoints was ever there, and the id is unique
      // per graph, so it could never be created either.
      const { backend, store } = await seed();

      const result = await importGraph(
        store,
        endpointConflictingDocument(repeat),
        importOptions({ onConflict: "skip" }),
      );

      expect(await storedEdgeState(backend)).toEqual({
        kind: "knows",
        from: "Person:person-a",
        to: "Person:person-b",
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
    spoofProbedEdgeIdentity(backend, { kind: "worksWith" });

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
    expect(reported).toContain(
      "no live edge with that id and identity remained",
    );
  });

  it("refuses the update when the probe lies about the ENDPOINTS rather than the kind", async () => {
    // The same window, one component over: the probe reports the endpoint the
    // DOCUMENT states, so the import's own identity check passes, while the
    // database still holds the row the write will meet. Without the four
    // endpoint assertions in `UpdateEdgeParams` this is a props overwrite onto
    // an edge pointing somewhere the import never looked — the endpoint half of
    // the check left advisory while the kind half was enforced.
    const { backend, store } = await seed();
    spoofProbedEdgeIdentity(backend, { to_id: "person-c" });

    const result = await importGraph(
      store,
      endpointConflictingDocument(false),
      importOptions({ onConflict: "update" }),
    );

    vi.restoreAllMocks();
    expect(await storedEdgeState(backend)).toEqual({
      kind: "knows",
      from: "Person:person-a",
      to: "Person:person-b",
      note: "original",
    });
    expect(result.success).toBe(false);
    expect(result.edges.updated).toBe(0);
    const reported = result.errors.find(
      (entry) => entry.id === CONTESTED_ID,
    )?.error;
    expect(reported).toContain("INTERCHANGE_EDGE_KIND_CONFLICT");
    expect(reported).toContain(
      "no live edge with that id and identity remained",
    );
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
