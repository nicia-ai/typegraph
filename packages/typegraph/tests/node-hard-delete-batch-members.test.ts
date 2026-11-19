/**
 * The node batch hard delete's backend members, driven directly:
 * `hardDeleteNodesBatch` and `findEdgesConnectedToNodes`.
 *
 * The budget is pinned small at backend CONSTRUCTION (chunk sizes are frozen
 * there), so seven ids span three chunks of `floor((9 - 3) / 2) = 3`: an edge
 * between two nodes of different chunks, and a chunk whose ids are all absent,
 * are both exercised. Every statement that binds an id list is checked
 * against the budget, since the local engine itself would accept an
 * oversized one.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { type GraphBackend } from "../src/backend/types";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import { createInitializedStore, disableTransactions } from "./test-utils";

const GRAPH_ID = "node_hard_delete_batch_members";
const MAX_BIND_PARAMETERS = 9;

const Person = defineNode("Person", {
  schema: z.object({ email: z.string(), bio: searchable() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ email: z.string(), bio: searchable() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const owns = defineEdge("owns", { schema: z.object({}) });

function emailUnique(name: string) {
  return {
    name,
    fields: ["email"],
    scope: "kind",
    collation: "binary",
  } as const;
}

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: {
    Person: { type: Person, unique: [emailUnique("person_email")] },
    Robot: { type: Robot, unique: [emailUnique("robot_email")] },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    owns: { type: owns, from: [Robot], to: [Person, Robot] },
  },
});

const openBackends: GraphBackend[] = [];

afterEach(async () => {
  await Promise.all(openBackends.splice(0).map((backend) => backend.close()));
});

/** A Person reference, cast for the typed edge API. */
function person(id: string): never {
  return { kind: "Person", id } as never;
}

/** The one member of the driver client the bind assertion observes. */
interface SqliteClient {
  prepare: (source: string) => unknown;
}

/**
 * A budgeted store seeded with persons p0..p6 and q (q stays out of every
 * batch), a Robot that shares p0's id, and edges of both kinds, live and
 * tombstoned, in both directions.
 */
async function createSeededBackend() {
  const { backend, db } = createLocalSqliteBackend({
    capabilities: { maxBindParameters: MAX_BIND_PARAMETERS },
  });
  openBackends.push(backend);
  const store = await createInitializedStore(graph, backend);
  for (const id of ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "q"]) {
    await store.nodes.Person.create(
      { email: `${id}@person`, bio: `person ${id}` },
      { id },
    );
  }
  await store.nodes.Robot.create(
    { email: "p0@robot", bio: "robot" },
    {
      id: "p0",
    },
  );
  const robot = { kind: "Robot", id: "p0" } as never;
  // p0 (chunk 1) to p5 (chunk 2): read once although both chunks match it.
  await store.edges.knows.create(person("p0"), person("p5"), {}, { id: "e05" });
  await store.edges.knows.create(person("p4"), person("p4"), {}, { id: "e44" });
  await store.edges.knows.create(person("q"), person("p6"), {}, { id: "eq6" });
  await store.edges.knows.create(person("p2"), person("q"), {}, { id: "e2q" });
  await store.edges.knows.delete("e2q" as never);
  await store.edges.owns.create(robot, person("p1"), {}, { id: "o1" });
  // Incident only to the Robot that shares p0's id.
  await store.edges.owns.create(robot, person("q"), {}, { id: "oq" });
  await store.edges.owns.create(robot, robot, {}, { id: "orr" });
  const { $client: client } = db as unknown as Readonly<{
    $client: SqliteClient;
  }>;
  return { backend, client };
}

/** Runs `operation`, asserting every id-list statement fits the budget. */
async function withinBindBudget<T>(
  client: SqliteClient,
  operation: () => Promise<T>,
): Promise<T> {
  const prepared = vi.spyOn(client, "prepare");
  let statements: readonly string[];
  let result: T;
  try {
    result = await operation();
  } finally {
    statements = prepared.mock.calls.map(([source]) => source);
    prepared.mockRestore();
  }
  const chunked = statements.filter((source) => /\bIN \(/.test(source));
  expect(chunked.length).toBeGreaterThan(0);
  expect(
    chunked.filter(
      (source) => (source.match(/\?/g)?.length ?? 0) > MAX_BIND_PARAMETERS,
    ),
  ).toEqual([]);
  return result;
}

async function readIds(
  backend: GraphBackend,
  relation: ReturnType<typeof sql>,
  columns: string,
): Promise<readonly string[]> {
  const rows = await backend.execute<Readonly<Record<string, unknown>>>(
    asCompiledRowsSql(sql`
      SELECT ${sql.raw(columns)} AS ref FROM ${relation}
      WHERE graph_id = ${GRAPH_ID}
    `),
  );
  return rows.map((row) => String(row["ref"])).toSorted();
}

describe("hardDeleteNodesBatch", () => {
  it("removes only the listed ids of its kind, with their sidecar and incident edge rows, and reports exactly what it removed", async () => {
    const { backend, client } = await createSeededBackend();
    const batch = requireDefined(backend.hardDeleteNodesBatch);
    const schema = createSqlSchema(backend.tableNames);

    const removed = await withinBindBudget(client, () =>
      batch({
        graphId: GRAPH_ID,
        kind: "Person",
        ids: ["p0", "p1", "absent-a", "absent-b", "p2", "p4", "p5", "p6", "p0"],
      }),
    );

    expect([...removed.removedNodeIds].toSorted()).toEqual([
      "p0",
      "p1",
      "p2",
      "p4",
      "p5",
      "p6",
    ]);
    // Every incident edge of a removed node — either endpoint, either kind,
    // live or tombstoned — and nothing else, each once.
    expect([...removed.removedEdgeIds].toSorted()).toEqual([
      "e05",
      "e2q",
      "e44",
      "eq6",
      "o1",
    ]);
    expect(
      await readIds(backend, schema.nodesTable, "kind || ':' || id"),
    ).toEqual(["Person:p3", "Person:q", "Robot:p0"]);
    expect(await readIds(backend, schema.edgesTable, "id")).toEqual([
      "oq",
      "orr",
    ]);
    expect(
      await readIds(
        backend,
        sql.identifier(schema.tables.uniques),
        "concrete_kind || ':' || node_id",
      ),
    ).toEqual(["Person:p3", "Person:q", "Robot:p0"]);
    expect(
      await readIds(
        backend,
        schema.fulltextTable,
        "node_kind || ':' || node_id",
      ),
    ).toEqual(["Person:p3", "Person:q", "Robot:p0"]);
  });
  // MUTATION CHECK: drop `AND kind = ...` from `buildHardDeleteNodesBatch` —
  // Robot p0 and its rows are removed and reported. Scope the sidecar deletes
  // to the requested ids instead of the RETURNING ones and nothing here
  // changes, which is why the next case exists.

  it("removes a requested id's leftover sidecar and edge rows even when its node row is already gone, and reports only rows it removed", async () => {
    const { backend } = await createSeededBackend();
    const batch = requireDefined(backend.hardDeleteNodesBatch);
    const schema = createSqlSchema(backend.tableNames);
    // q's node row is already gone; its uniqueness, fulltext and edge rows
    // remain — what an interrupted delete that removed the node first would
    // leave. The single-node port clears such rows by id; so must the batch.
    await backend.execute(
      asCompiledRowsSql(sql`
        DELETE FROM ${schema.nodesTable}
        WHERE graph_id = ${GRAPH_ID} AND kind = 'Person' AND id = 'q'
        RETURNING id
      `),
    );

    const removed = await batch({
      graphId: GRAPH_ID,
      kind: "Person",
      ids: ["q", "p3"],
    });

    // No node row for q was removed, so none is reported; q's incident edges
    // were — eq6, the tombstoned e2q, and oq from the Robot.
    expect(removed.removedNodeIds).toEqual(["p3"]);
    expect([...removed.removedEdgeIds].toSorted()).toEqual([
      "e2q",
      "eq6",
      "oq",
    ]);
    expect(await readIds(backend, schema.edgesTable, "id")).toEqual([
      "e05",
      "e44",
      "o1",
      "orr",
    ]);
    const uniqueOwners = await readIds(
      backend,
      sql.identifier(schema.tables.uniques),
      "concrete_kind || ':' || node_id",
    );
    expect(uniqueOwners).not.toContain("Person:q");
    // The Robot sharing an id with a requested Person keeps its rows.
    expect(uniqueOwners).toContain("Robot:p0");
    expect(
      await readIds(
        backend,
        schema.fulltextTable,
        "node_kind || ':' || node_id",
      ),
    ).not.toContain("Person:q");
  });
  // MUTATION CHECK: scope the sidecar and edge deletes to the node DELETE's
  // RETURNING ids again — q's uniqueness and fulltext rows and eq6 survive.

  it("leaves a retry able to clear the node's claims when a sidecar delete fails, on a store without interactive transactions", async () => {
    const { backend, client } = await createSeededBackend();
    const schema = createSqlSchema(backend.tableNames);
    const store = createStore(graph, disableTransactions(backend));
    const uniquesTable = schema.tables.uniques;
    const realPrepare = client.prepare.bind(client);
    const failing = vi.spyOn(client, "prepare").mockImplementation((source) => {
      if (source.trimStart().startsWith(`DELETE FROM "${uniquesTable}"`)) {
        throw new Error("injected uniqueness cleanup failure");
      }
      return realPrepare(source);
    });
    try {
      await expect(
        store.nodes.Person.bulkHardDelete(["p3"] as never),
      ).rejects.toThrow("injected uniqueness cleanup failure");
    } finally {
      failing.mockRestore();
    }

    await store.nodes.Person.bulkHardDelete(["p3"] as never);
    expect(
      await readIds(
        backend,
        sql.identifier(uniquesTable),
        "concrete_kind || ':' || node_id",
      ),
    ).not.toContain("Person:p3");
    // The replacement takes the released key.
    const replacement = await store.nodes.Person.create(
      { email: "p3@person", bio: "replacement" },
      { id: "p3-new" },
    );
    expect(replacement.id).toBe("p3-new");
  });
  // MUTATION CHECK: run the node DELETE first in `hardDeleteNodesBatch` (the
  // original order) — the failure leaves p3's uniqueness row behind a removed
  // node, the retry finds no node and does nothing, and the replacement is
  // refused with a uniqueness violation.
});

describe("findEdgesConnectedToNodes", () => {
  it("reads every live edge of any kind at either endpoint, once, across chunks", async () => {
    const { backend, client } = await createSeededBackend();
    const read = requireDefined(backend.findEdgesConnectedToNodes);

    const rows = await withinBindBudget(client, () =>
      read({
        graphId: GRAPH_ID,
        nodeKind: "Person",
        nodeIds: ["p0", "p1", "p2", "p4", "p5", "p6", "absent", "p0"],
      }),
    );

    // e2q is tombstoned; oq and orr touch only the Robot that shares p0's id.
    expect(rows.map((row) => row.id).toSorted()).toEqual([
      "e05",
      "e44",
      "eq6",
      "o1",
    ]);
  });
  // MUTATION CHECK: drop the by-id de-duplication in
  // `findEdgesConnectedToNodes` — e05 (p0 and p5 sit in different chunks) is
  // read twice.
});
