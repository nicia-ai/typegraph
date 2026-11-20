/**
 * The import UPDATE contract on a REAL Postgres engine.
 *
 * Both halves of it are decided in shared code and proved on SQLite
 * (`interchange-update-verdict-fence.test.ts`,
 * `node-update-uniqueness-atomicity.test.ts`), but both are ABOUT Postgres:
 *
 *  - the fence exists because PostgreSQL READ COMMITTED re-resolves
 *    `(graph_id, kind, id)` between a probe and its write, and the emitted
 *    predicate has to be NULL-safe in the Postgres dialect;
 *  - the claim/gate/release ordering exists because the uniqueness claim is an
 *    `INSERT ... ON CONFLICT DO UPDATE` whose returned owner is the conflict
 *    verdict — a Postgres-shaped statement, and the engine where the losing
 *    interleaving happens naturally rather than only under a test double.
 *
 * PGlite boots Postgres in-process, so this runs in plain `pnpm test` with no
 * Docker (same rationale as `pglite-backend.test.ts`).
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type GraphBackend } from "../../../src";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { rowPropsToObject } from "../../../src/backend/types";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../../../src/interchange";
import { createStore } from "../../../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const graph = defineGraph({
  id: "pglite_import_update_atomicity",
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
  edges: {},
});

const ALICE = "person-alice";
const RIVAL = "person-rival";
const HELD_EMAIL = "original@example.com";
const CONTESTED_EMAIL = "moved@example.com";
const SEEDED_BOUND = "2022-01-01T00:00:00.000Z";
const SPOOFED_BOUND = "2020-01-01T00:00:00.000Z";

function documentOf(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2024-01-01T00:00:00.000Z",
    source: { type: "external" },
    nodes,
    edges: [],
  };
}

function spoofRow<T extends { id: string }>(row: T, spoofed: string): T {
  return row.id === ALICE ? { ...row, valid_from: spoofed } : row;
}

/** See `interchange-update-verdict-fence.test.ts` — the probe lies, the row does not. */
function spoofProbedValidFrom(backend: GraphBackend, spoofed: string): void {
  const runTransaction = backend.transaction;
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const readNode = target.getNode;
      const readNodes = target.getNodes;
      return run({
        ...target,
        getNode: async (graphId, kind, id) => {
          const row = await readNode(graphId, kind, id);
          return row === undefined ? row : spoofRow(row, spoofed);
        },
        ...(readNodes === undefined ?
          {}
        : {
            getNodes: async (graphId, kind, ids) => {
              const rows = await readNodes(graphId, kind, ids);
              return rows.map((row) => spoofRow(row, spoofed));
            },
          }),
      });
    }, options),
  );
}

/** See `node-update-uniqueness-atomicity.test.ts`. */
function letRivalClaimTheKeyFirst(backend: GraphBackend): void {
  const runTransaction = backend.transaction;
  vi.spyOn(backend, "transaction").mockImplementation((run, options) =>
    runTransaction(async (target) => {
      const insertUnique = target.insertUnique;
      let armed = true;
      return run({
        ...target,
        insertUnique: async (params) => {
          if (armed && params.nodeId !== RIVAL) {
            armed = false;
            await insertUnique({
              ...params,
              nodeId: RIVAL,
              concreteKind: RIVAL,
            });
          }
          return insertUnique(params);
        },
      });
    }, options),
  );
}

async function seed(
  backend: GraphBackend,
): Promise<ReturnType<typeof createStore<typeof graph>>> {
  const store = createStore(graph, backend);
  const seeded = await importGraph(
    store,
    documentOf([
      {
        kind: "Person",
        id: ALICE,
        properties: { name: "Alice", email: HELD_EMAIL },
        validFrom: SEEDED_BOUND,
      },
    ]),
    ImportOptionsSchema.parse({ onConflict: "error" }),
  );
  expect(seeded.success).toBe(true);
  return store;
}

describe("import update atomicity and fencing on Postgres", () => {
  it("updates a props-only document whose stored bound moved under it", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const store = await seed(backend);
      spoofProbedValidFrom(backend, SPOOFED_BOUND);

      const result = await importGraph(
        store,
        documentOf([
          {
            kind: "Person",
            id: ALICE,
            properties: { name: "Alice", email: CONTESTED_EMAIL },
          },
        ]),
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );
      vi.restoreAllMocks();

      expect(result.errors).toEqual([]);
      expect(result.nodes.updated).toBe(1);
      const row = await backend.getNode(graph.id, "Person", ALICE);
      expect(row?.valid_from).toBe(SEEDED_BOUND);
      expect(
        row === undefined ? undefined : rowPropsToObject(row.props),
      ).toEqual({ name: "Alice", email: CONTESTED_EMAIL });
    } finally {
      vi.restoreAllMocks();
      await backend.close();
    }
  });

  it("refuses a windowed document whose stored bound moved under it", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const store = await seed(backend);
      spoofProbedValidFrom(backend, SPOOFED_BOUND);

      const result = await importGraph(
        store,
        documentOf([
          {
            kind: "Person",
            id: ALICE,
            properties: { name: "Alice", email: CONTESTED_EMAIL },
            validFrom: SPOOFED_BOUND,
          },
        ]),
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );
      vi.restoreAllMocks();

      expect(result.nodes.updated).toBe(0);
      expect(result.errors[0]?.error).toContain(
        "INTERCHANGE_NODE_UPDATE_TARGET_CHANGED",
      );
      const row = await backend.getNode(graph.id, "Person", ALICE);
      expect(
        row === undefined ? undefined : rowPropsToObject(row.props),
      ).toEqual({ name: "Alice", email: HELD_EMAIL });
    } finally {
      vi.restoreAllMocks();
      await backend.close();
    }
  });

  it("leaves the row and both reservations untouched when the claim loses a race", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const store = await seed(backend);
      letRivalClaimTheKeyFirst(backend);

      const result = await importGraph(
        store,
        documentOf([
          {
            kind: "Person",
            id: ALICE,
            properties: { name: "Alice", email: CONTESTED_EMAIL },
          },
          {
            kind: "Person",
            id: "person-bystander",
            properties: { name: "Bystander", email: "bystander@example.com" },
          },
        ]),
        ImportOptionsSchema.parse({ onConflict: "update" }),
      );
      vi.restoreAllMocks();

      expect(result.nodes.updated).toBe(0);
      expect(result.errors[0]?.error).toMatch(/unique/i);
      const row = await backend.getNode(graph.id, "Person", ALICE);
      expect(
        row === undefined ? undefined : rowPropsToObject(row.props),
      ).toEqual({ name: "Alice", email: HELD_EMAIL });
      // The old reservation was never released.
      await expect(
        store.nodes.Person.create({ name: "Clone", email: HELD_EMAIL }),
      ).rejects.toThrow(/unique/i);
      // The rest of the import still committed.
      expect(result.nodes.created).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await backend.close();
    }
  });
});
