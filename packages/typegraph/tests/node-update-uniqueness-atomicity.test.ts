/**
 * A node's row update and its uniqueness transition commit or fail AS ONE UNIT,
 * under a consumer that catches per row and keeps going.
 *
 * `applyNodeUpdate` performs two independently fallible writes — the row, and
 * the uniqueness entries — with no savepoint between them. The store is safe by
 * accident there: any throw aborts its whole write transaction. Interchange
 * import is not: `onConflict: "update"` catches `UniquenessError` per row,
 * records it, and COMMITS everything else. So the pair has to be atomic on its
 * own terms.
 *
 * The ordering that fails is "probe, update the row, then move the entries": a
 * peer that claims the key between the probe and the entry write makes the
 * entry write throw with the row already changed. Import then reports
 * `updated: 0` for a row whose props DID change, whose old reservation was
 * released, and whose new reservation belongs to someone else — three lies in
 * one committed transaction. Claiming before the row write is what closes it,
 * because `insertUnique` is an upsert that reports the key's final owner: the
 * claim IS the conflict gate, and once this transaction holds the key no peer
 * can take it.
 *
 * The race is forced deterministically by having a rival claim the contested key
 * from inside the same transaction, immediately before this import's own claim
 * for it lands — the exact interleaving PostgreSQL's READ COMMITTED permits
 * naturally and SQLite's single writer does not.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type GraphBackend, rowPropsToObject } from "../src/backend/types";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore } from "../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

const graph = defineGraph({
  id: "node_update_uniqueness_atomicity",
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

/**
 * Lets a rival claim `CONTESTED_EMAIL` immediately BEFORE this import's own
 * claim for it reaches the table, then delegates — so the import's claim finds
 * the key owned by someone else.
 *
 * Hooked on `insertUnique` rather than on the probe because that is the one
 * point every ordering has in common: whether the claim is issued before the row
 * write or after it, it is issued here, and the rival gets in first either way.
 * Fires once, so the rival's own insert is not intercepted.
 */
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

function documentOf(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: "2.0",
    exportedAt: "2024-01-01T00:00:00.000Z",
    source: { type: "external" },
    nodes,
    edges: [],
  };
}

/** Moves Alice onto the contested email, alongside an unrelated create. */
function document(): GraphData {
  return documentOf([
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
  ]);
}

describe("node update uniqueness atomicity", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openDatabases.splice(0)) database.close();
  });

  async function seed(): Promise<
    Readonly<{
      backend: GraphBackend;
      store: ReturnType<typeof createStore<typeof graph>>;
    }>
  > {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    const backend = createSqliteBackend(drizzle(database));
    const store = createStore(graph, backend);
    // Seeded through import so the row carries the id the document names; the
    // collection API assigns its own.
    const seeded = await importGraph(
      store,
      documentOf([
        {
          kind: "Person",
          id: ALICE,
          properties: { name: "Alice", email: HELD_EMAIL },
        },
      ]),
      ImportOptionsSchema.parse({ onConflict: "error" }),
    );
    expect(seeded.success).toBe(true);
    return { backend, store };
  }

  it("leaves the row and BOTH reservations untouched when the claim loses a race", async () => {
    const { backend, store } = await seed();
    letRivalClaimTheKeyFirst(backend);

    const result = await importGraph(
      store,
      document(),
      ImportOptionsSchema.parse({ onConflict: "update" }),
    );
    vi.restoreAllMocks();

    // The contested row is reported, not silently half-applied.
    expect(result.nodes.updated).toBe(0);
    expect(result.success).toBe(false);
    expect(result.errors.find((entry) => entry.id === ALICE)?.error).toMatch(
      /unique/i,
    );

    // The props never moved: the row write is gated on the claim, so it never ran.
    const row = await backend.getNode(graph.id, "Person", ALICE);
    expect(row === undefined ? undefined : rowPropsToObject(row.props)).toEqual(
      {
        name: "Alice",
        email: HELD_EMAIL,
      },
    );

    // The OLD reservation was never released — releasing it before the row
    // write lands is exactly what would let a later create duplicate the value.
    await expect(
      store.nodes.Person.create({ name: "Clone", email: HELD_EMAIL }),
    ).rejects.toThrow(/unique/i);

    // The rest of the import still committed: this is a per-row fact, not an
    // abort.
    expect(result.nodes.created).toBe(1);
    expect(
      await backend.getNode(graph.id, "Person", "person-bystander"),
    ).toBeDefined();
  });

  it("still applies the transition when nothing contests the key", async () => {
    // The control: without the rival, the same document moves the reservation.
    const { backend, store } = await seed();

    const result = await importGraph(
      store,
      document(),
      ImportOptionsSchema.parse({ onConflict: "update" }),
    );

    expect(result.errors).toEqual([]);
    expect(result.nodes.updated).toBe(1);
    const row = await backend.getNode(graph.id, "Person", ALICE);
    expect(row === undefined ? undefined : rowPropsToObject(row.props)).toEqual(
      {
        name: "Alice",
        email: CONTESTED_EMAIL,
      },
    );
    // Old key released, new key held by Alice.
    const reclaimed = await store.nodes.Person.create({
      name: "Reuser",
      email: HELD_EMAIL,
    });
    expect(reclaimed.email).toBe(HELD_EMAIL);
    await expect(
      store.nodes.Person.create({ name: "Clash", email: CONTESTED_EMAIL }),
    ).rejects.toThrow(/unique/i);
  });
});
