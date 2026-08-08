/**
 * An import UPDATE asserts EVERY component its verdict read — including the
 * effective validity lower bound.
 *
 * `onConflict: "update"` probes the stored row, validates the document's
 * validity window against that row's `valid_from`
 * (`validateUpdateValidityWindow`), and then writes. Those are two statements,
 * and under PostgreSQL READ COMMITTED a concurrent `hardDelete` + recreate
 * re-resolves the key between them. Rounds 6 and 7 moved the edge's kind and
 * then its endpoints into the UPDATE's own `WHERE` for exactly this reason;
 * `valid_from` is the same window with a different component, and it is the one
 * the window verdict is actually computed from — so a write that omits it can
 *
 *  - persist a `valid_to` BELOW the row's real `valid_from` (a window of
 *    negative width, which the direct update path refuses outright), or
 *  - silently ignore a `validFrom` the document stated, which is the very thing
 *    the update-window check exists to refuse.
 *
 * The race is reproduced deterministically by making the PROBE lie about
 * `valid_from` — the round-6/7 idiom from `interchange-edge-kind-conflict.test.
 * ts`, one component over. The import's own check then passes against a bound
 * the database does not hold, and only the predicate in the statement can catch
 * it.
 *
 * NULL-safety is a first-class case, not an edge case: `valid_from` is nullable,
 * `col = NULL` is UNKNOWN in SQL, and an assertion that can never match is as
 * broken as one that never runs. An open-left row asserts `IS NULL`.
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
  schema: z.object({ name: z.string(), email: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ note: z.string() }),
});

const graph = defineGraph({
  id: "import_update_verdict_fence",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

const EDGE_ID = "edge-contested";
const NODE_ID = "person-a";

/** Ordered, canonical, and far enough apart to read at a glance. */
const EARLY_BOUND = "2020-01-01T00:00:00.000Z";
const MIDDLE_BOUND = "2021-01-01T00:00:00.000Z";
const LATE_BOUND = "2022-01-01T00:00:00.000Z";
const EXPORTED_AT = "2024-01-01T00:00:00.000Z";

function importOptions(
  overrides: Partial<ImportOptions>,
): ReturnType<typeof ImportOptionsSchema.parse> {
  return ImportOptionsSchema.parse(overrides);
}

function emptyDocument(): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: EXPORTED_AT,
    source: { type: "external" },
    nodes: [],
    edges: [],
  };
}

/**
 * `repeat` yields the SAME entity twice, which pushes the second occurrence
 * onto the per-row fallback (`processNode` / `processEdge`) instead of the
 * batched slice. Both legs of each entity are covered by running every case
 * under both values — a fence threaded through one leg and forgotten on the
 * other is exactly the shape this defect class keeps taking.
 */
function edgeDocument(
  repeat: boolean,
  overrides: Readonly<{ validFrom?: string | null; validTo?: string }> = {},
): GraphData {
  const edge = {
    kind: "knows",
    id: EDGE_ID,
    from: { kind: "Person", id: NODE_ID },
    to: { kind: "Person", id: "person-b" },
    properties: { note: "written by the import" },
    ...overrides,
  };
  return { ...emptyDocument(), edges: repeat ? [edge, edge] : [edge] };
}

function nodeDocument(
  repeat: boolean,
  overrides: Readonly<{
    email?: string;
    validFrom?: string | null;
    validTo?: string;
  }> = {},
): GraphData {
  const { email = "moved@example.com", ...temporal } = overrides;
  const node = {
    kind: "Person",
    id: NODE_ID,
    properties: { name: "Alice", email },
    ...temporal,
  };
  return { ...emptyDocument(), nodes: repeat ? [node, node] : [node] };
}

/**
 * Makes the import's existence probe report `valid_from` as `spoofed`, whatever
 * the database actually holds — a deterministic stand-in for the concurrent
 * hard-delete-and-recreate the predicate closes: the row the verdict was
 * computed from is not the row the write will find.
 *
 * Wrapped at `transaction()` because the import runs its reads and writes
 * through the TRANSACTION-scoped backend, not the root one a test can spy on.
 */
function spoofProbedValidFrom(
  backend: GraphBackend,
  spoofed: string | undefined,
): void {
  const runTransaction = backend.transaction;
  const spoof = <T extends { id: string }>(row: T): T =>
    row.id === EDGE_ID || row.id === NODE_ID ?
      { ...row, valid_from: spoofed }
    : row;
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const readEdge = target.getEdge;
      const readEdges = target.getEdges;
      const readNode = target.getNode;
      const readNodes = target.getNodes;
      return run({
        ...target,
        getEdge: async (graphId, id) => {
          const row = await readEdge(graphId, id);
          return row === undefined ? row : spoof(row);
        },
        getNode: async (graphId, kind, id) => {
          const row = await readNode(graphId, kind, id);
          return row === undefined ? row : spoof(row);
        },
        ...(readNodes === undefined ?
          {}
        : {
            getNodes: async (graphId, kind, ids) => {
              const rows = await readNodes(graphId, kind, ids);
              return rows.map((row) => spoof(row));
            },
          }),
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

type StoredWindow = Readonly<{
  validFrom: string | undefined;
  validTo: string | undefined;
  props: Record<string, unknown>;
}>;

async function storedEdgeWindow(backend: GraphBackend): Promise<StoredWindow> {
  const row = await backend.getEdge(graph.id, EDGE_ID);
  if (row === undefined) throw new Error("The contested edge disappeared.");
  return {
    validFrom: row.valid_from,
    validTo: row.valid_to,
    props: rowPropsToObject(row.props),
  };
}

async function storedNodeWindow(backend: GraphBackend): Promise<StoredWindow> {
  const row = await backend.getNode(graph.id, "Person", NODE_ID);
  if (row === undefined) throw new Error("The contested node disappeared.");
  return {
    validFrom: row.valid_from,
    validTo: row.valid_to,
    props: rowPropsToObject(row.props),
  };
}

describe("import update verdict fence", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openDatabases.splice(0)) database.close();
  });

  function seed(): Readonly<{
    backend: GraphBackend;
    store: ReturnType<typeof createStore<typeof graph>>;
  }> {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    const backend = createSqliteBackend(drizzle(database));
    const store = createStore(graph, backend);
    return { backend, store };
  }

  /**
   * Seeds through IMPORT rather than the collection API so the row's stored
   * `valid_from` is exactly `LATE_BOUND` — the bound the spoof will contradict.
   */
  async function seedLateBound(): Promise<
    Readonly<{
      backend: GraphBackend;
      store: ReturnType<typeof createStore<typeof graph>>;
    }>
  > {
    const { backend, store } = seed();
    const seedResult = await importGraph(
      store,
      {
        ...emptyDocument(),
        nodes: [
          {
            kind: "Person",
            id: NODE_ID,
            properties: { name: "Alice", email: "original@example.com" },
            validFrom: LATE_BOUND,
          },
          {
            kind: "Person",
            id: "person-b",
            properties: { name: "Bob", email: "bob@example.com" },
          },
        ],
        edges: [
          {
            kind: "knows",
            id: EDGE_ID,
            from: { kind: "Person", id: NODE_ID },
            to: { kind: "Person", id: "person-b" },
            properties: { note: "original" },
            validFrom: LATE_BOUND,
          },
        ],
      },
      importOptions({ onConflict: "error" }),
    );
    expect(seedResult.success).toBe(true);
    return { backend, store };
  }

  for (const repeat of [true, false]) {
    const leg = repeat ? "per-row" : "batched";

    it(`refuses an EDGE update whose bound changed between the probe and the write (${leg})`, async () => {
      const { backend, store } = await seedLateBound();
      // The probe reports a bound EARLIER than the row really holds, so the
      // document's `validTo` reads as a valid upper bound against it. Against
      // the row's real `valid_from` it is a window of negative width — the
      // write this fence has to refuse.
      spoofProbedValidFrom(backend, EARLY_BOUND);

      const result = await importGraph(
        store,
        edgeDocument(repeat, { validTo: MIDDLE_BOUND }),
        importOptions({ onConflict: "update" }),
      );

      // Nothing was written: not the props, and above all not the inverted
      // window.
      expect(await storedEdgeWindow(backend)).toEqual({
        validFrom: LATE_BOUND,
        validTo: undefined,
        props: { note: "original" },
      });
      expect(result.edges.updated).toBe(0);
      expect(result.success).toBe(false);
      expect(
        result.errors.find((entry) => entry.id === EDGE_ID)?.error,
      ).toContain("INTERCHANGE_EDGE_KIND_CONFLICT");
    });

    it(`refuses a NODE update whose bound changed between the probe and the write (${leg})`, async () => {
      const { backend, store } = await seedLateBound();
      spoofProbedValidFrom(backend, EARLY_BOUND);

      const result = await importGraph(
        store,
        nodeDocument(repeat, { validTo: MIDDLE_BOUND }),
        importOptions({ onConflict: "update" }),
      );

      expect(await storedNodeWindow(backend)).toEqual({
        validFrom: LATE_BOUND,
        validTo: undefined,
        props: { name: "Alice", email: "original@example.com" },
      });
      expect(result.nodes.updated).toBe(0);
      expect(result.success).toBe(false);
      expect(
        result.errors.find((entry) => entry.id === NODE_ID)?.error,
      ).toContain("INTERCHANGE_NODE_UPDATE_TARGET_CHANGED");
    });

    it(`leaves NO sidecar mutation behind when a node update matches zero rows (${leg})`, async () => {
      // The uniqueness diff, the fulltext row and the embedding sync all run
      // WITH a node update. They used to run BEFORE it, so a zero-row primary
      // write left this node's email reservation moved to a value no row ever
      // held: the old key released (a later create could duplicate it) and the
      // new key claimed (a later create of the imported value was refused).
      // The primary write's rowcount now gates every one of them.
      const { backend, store } = await seedLateBound();
      spoofProbedValidFrom(backend, EARLY_BOUND);

      const result = await importGraph(
        store,
        nodeDocument(repeat, {
          email: "moved@example.com",
          validTo: MIDDLE_BOUND,
        }),
        importOptions({ onConflict: "update" }),
      );
      expect(result.nodes.updated).toBe(0);
      vi.restoreAllMocks();

      // The OLD key is still reserved: creating another node with it must fail.
      await expect(
        store.nodes.Person.create({
          name: "Clone",
          email: "original@example.com",
        }),
      ).rejects.toThrow(/unique/i);
      // The NEW key was never claimed: creating a node with it must succeed.
      const created = await store.nodes.Person.create({
        name: "Mover",
        email: "moved@example.com",
      });
      expect(created.email).toBe("moved@example.com");
    });
  }

  it("asserts an OPEN-LEFT bound as IS NULL, not as `= NULL`", async () => {
    // A row with no lower bound is the case a naive `AND valid_from = ?`
    // predicate silently breaks: SQL compares NULL to UNKNOWN, so the update
    // matches nothing and an ordinary re-import of an open-left row starts
    // reporting a conflict that is not there. The fence has to say IS NULL.
    const { backend, store } = seed();
    const seeded = await importGraph(
      store,
      {
        ...emptyDocument(),
        nodes: [
          {
            kind: "Person",
            id: NODE_ID,
            properties: { name: "Alice", email: "original@example.com" },
            // eslint-disable-next-line unicorn/no-null -- the interchange format states an open-left window as null
            validFrom: null,
          },
          {
            kind: "Person",
            id: "person-b",
            properties: { name: "Bob", email: "bob@example.com" },
          },
        ],
        edges: [
          {
            kind: "knows",
            id: EDGE_ID,
            from: { kind: "Person", id: NODE_ID },
            to: { kind: "Person", id: "person-b" },
            properties: { note: "original" },
            // eslint-disable-next-line unicorn/no-null -- see above
            validFrom: null,
          },
        ],
      },
      importOptions({ onConflict: "error" }),
    );
    expect(seeded.success).toBe(true);
    const seededNode = await storedNodeWindow(backend);
    const seededEdge = await storedEdgeWindow(backend);
    expect(seededNode.validFrom).toBeUndefined();
    expect(seededEdge.validFrom).toBeUndefined();

    const result = await importGraph(
      store,
      {
        ...emptyDocument(),
        nodes: nodeDocument(false).nodes,
        edges: edgeDocument(false).edges,
      },
      importOptions({ onConflict: "update" }),
    );

    expect(result.errors).toEqual([]);
    expect(result.nodes.updated).toBe(1);
    expect(result.edges.updated).toBe(1);
    expect(await storedNodeWindow(backend)).toEqual({
      validFrom: undefined,
      validTo: undefined,
      props: { name: "Alice", email: "moved@example.com" },
    });
    expect(await storedEdgeWindow(backend)).toEqual({
      validFrom: undefined,
      validTo: undefined,
      props: { note: "written by the import" },
    });
  });

  it("refuses an update against an open-left row whose bound appeared under it", async () => {
    // The other half of NULL-safety: the probe says open-left, the database
    // holds a bound. `IS NULL` must not match that row.
    const { backend, store } = await seedLateBound();
    spoofProbedValidFrom(backend, undefined);

    const result = await importGraph(
      store,
      {
        ...emptyDocument(),
        nodes: nodeDocument(false).nodes,
        edges: edgeDocument(false).edges,
      },
      importOptions({ onConflict: "update" }),
    );

    expect(result.nodes.updated).toBe(0);
    expect(result.edges.updated).toBe(0);
    const storedNode = await storedNodeWindow(backend);
    const storedEdge = await storedEdgeWindow(backend);
    expect(storedNode.props).toEqual({
      name: "Alice",
      email: "original@example.com",
    });
    expect(storedEdge.props).toEqual({ note: "original" });
  });
});
