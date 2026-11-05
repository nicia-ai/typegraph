/**
 * Node-row locks follow the backend's declared write fence, never its dialect.
 *
 * An edge write locks its endpoints and a node delete locks its node before it
 * reads connected edges (#795). On the bundled lock-based fence those are
 * PostgreSQL row locks inside the reading statement. A backend that declares
 * `writeFence.mechanism: "row"` speaks the PostgreSQL dialect but may have no
 * row locks at all, so it takes one keyed fence row per node instead, as its
 * own statement before the read, and emits no locking clause. A backend whose
 * writers serialize takes neither.
 *
 * The race outcomes under each fence live in
 * `tests/backends/postgres/concurrent-edge-endpoint-delete.test.ts`; this file
 * pins the statements on PGlite, so the default lane catches a locking clause
 * reaching a `row` backend.
 *
 * *Mutation*: make `resolveNodeRowLockPlan` return `{ kind: "row-lock" }` for a
 * `row` plan. The `row` cases fail on the locking-clause and fence-key
 * assertions. Restore afterward.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import {
  NODE_ROW_FENCE_NAMESPACE,
  nodeRowFenceAcquisitions,
  type NodeRowLockPlan,
  resolveNodeRowLockPlan,
} from "../src/backend/capabilities/node-row-lock-plan";
import {
  resolveFenceStatements,
  type WriteFencePlan,
} from "../src/backend/capabilities/write-fence";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type BackendCapabilities } from "../src/backend/types";
import { renderPostgres } from "../src/query/sql-fragment";

const GRAPH_ID = "node-row-lock-plan";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person, onDelete: "cascade" } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const alice = { kind: "Person", id: "alice" } as const;
const bob = { kind: "Person", id: "bob" } as const;

const FENCE_STATEMENTS = resolveFenceStatements(
  {},
  { mechanism: "row", fencesTableName: "typegraph_fences" },
);

const ROW_LOCK_CLAUSE =
  /\bFOR\s+(?:KEY\s+SHARE|NO\s+KEY\s+UPDATE|UPDATE|SHARE)\b/gi;
const FENCE_ACQUISITION = 'INSERT INTO "typegraph_fences"';

function nodeFenceKey(kind: string, id: string): string {
  return `${NODE_ROW_FENCE_NAMESPACE}:${JSON.stringify([GRAPH_ID, kind, id])}`;
}

describe("resolveNodeRowLockPlan", () => {
  it.each([
    {
      plan: { kind: "lock", drain: "table-lock", sql: FENCE_STATEMENTS },
      expected: { kind: "row-lock" },
    },
    {
      plan: {
        kind: "row",
        drain: "table-lock",
        conflict: "wait",
        sql: FENCE_STATEMENTS,
      },
      expected: { kind: "fence-row", sql: FENCE_STATEMENTS },
    },
    { plan: { kind: "engine-serialized" }, expected: { kind: "none" } },
    { plan: { kind: "caller-serialized" }, expected: { kind: "none" } },
    { plan: { kind: "unfenced" }, expected: { kind: "row-lock" } },
  ] satisfies readonly Readonly<{
    plan: WriteFencePlan;
    expected: NodeRowLockPlan;
  }>[])("maps a $plan.kind plan to $expected.kind", ({ plan, expected }) => {
    expect(resolveNodeRowLockPlan(plan)).toEqual(expected);
  });
});

describe("nodeRowFenceAcquisitions", () => {
  it("acquires each node once, in (kind, id) code-point order", () => {
    const acquisitions = nodeRowFenceAcquisitions(FENCE_STATEMENTS, GRAPH_ID, [
      { kind: "Tag", id: "a" },
      { kind: "Person", id: "b" },
      { kind: "Person", id: "B" },
      { kind: "Tag", id: "a" },
      { kind: "Person", id: "b" },
    ]);
    expect(
      acquisitions.map((statement) => renderPostgres(statement).params),
    ).toEqual([
      [nodeFenceKey("Person", "B")],
      [nodeFenceKey("Person", "b")],
      [nodeFenceKey("Tag", "a")],
    ]);
  });
});

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;

/** What one write's statements show about the node-row locks it took. */
type LockObservation = Readonly<{
  /** The strength of each row-lock clause the statements carry, in order. */
  rowLocks: readonly string[];
  /** The fence-row keys the statements acquire, in order. */
  fenceKeys: readonly unknown[];
  /** Every fence acquisition precedes the read or write it guards. */
  fencesLead: boolean;
}>;

type FenceCase = Readonly<{
  name: string;
  capabilities?: Partial<BackendCapabilities>;
  edgeCreate: LockObservation;
  nodeDelete: LockObservation;
}>;

const NO_LOCKS: LockObservation = {
  rowLocks: [],
  fenceKeys: [],
  fencesLead: true,
};

const FENCE_CASES: readonly FenceCase[] = [
  {
    name: "the bundled lock fence",
    edgeCreate: { ...NO_LOCKS, rowLocks: ["FOR KEY SHARE"] },
    nodeDelete: { ...NO_LOCKS, rowLocks: ["FOR UPDATE"] },
  },
  {
    name: "a declared row fence",
    capabilities: {
      writeFence: { mechanism: "row", drain: "table-lock", conflict: "wait" },
    },
    edgeCreate: {
      ...NO_LOCKS,
      fenceKeys: [
        nodeFenceKey("Person", "alice"),
        nodeFenceKey("Person", "bob"),
      ],
    },
    nodeDelete: { ...NO_LOCKS, fenceKeys: [nodeFenceKey("Person", "bob")] },
  },
  {
    name: "a caller-serialized fence",
    capabilities: { writeFence: { mechanism: "caller-serialized" } },
    edgeCreate: NO_LOCKS,
    nodeDelete: NO_LOCKS,
  },
];

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/**
 * An unmanaged store on a fresh PGlite instance, logging every statement at
 * both the driver boundary (root executions) and drizzle's logger
 * (transaction-scoped executions).
 */
async function loggedStore(fence: FenceCase) {
  const client = await PGlite.create();
  const statements: LoggedStatement[] = [];
  const query = client.query.bind(client);
  const querySpy = vi.spyOn(client, "query").mockImplementation((...args) => {
    statements.push({ query: args[0], params: args[1] ?? [] });
    return query(...args);
  });
  closers.push(async () => {
    querySpy.mockRestore();
    await client.close();
  });
  await client.exec(generatePostgresDDL().join("\n\n"));
  const backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(queryText: string, params: unknown[]): void {
          statements.push({ query: queryText, params });
        },
      },
    }),
    {
      vector: false,
      ...(fence.capabilities === undefined ?
        {}
      : { capabilities: fence.capabilities }),
    },
  );
  const store = createStore(graph, backend);
  await store.nodes.Person.create({ name: "Alice" }, { id: alice.id });
  await store.nodes.Person.create({ name: "Bob" }, { id: bob.id });
  statements.length = 0;
  return { store, statements };
}

type LoggedStore = Awaited<ReturnType<typeof loggedStore>>["store"];

/**
 * Reads the node-row locks out of `statements`. `guarded` picks the first
 * statement the locks must precede.
 */
function observeLocks(
  label: string,
  statements: readonly LoggedStatement[],
  guarded: (text: string) => boolean,
): LockObservation {
  const rowLocks = statements.flatMap((statement) =>
    [...statement.query.matchAll(ROW_LOCK_CLAUSE)].map((match) =>
      match[0].toUpperCase().replaceAll(/\s+/g, " "),
    ),
  );
  const fenceIndexes = statements.flatMap((statement, index) =>
    statement.query.includes(FENCE_ACQUISITION) ? [index] : [],
  );
  const guardedIndex = statements.findIndex((statement) =>
    guarded(statement.query),
  );
  const observation = {
    rowLocks,
    fenceKeys: fenceIndexes.flatMap((index) => statements[index]?.params ?? []),
    fencesLead:
      guardedIndex !== -1 &&
      fenceIndexes.every((index) => index < guardedIndex),
  };
  console.log(
    `[${label}] ${String(statements.length)} statements: ${JSON.stringify(observation)}`,
  );
  return observation;
}

describe.each(FENCE_CASES)("node-row locks under $name", (fence) => {
  it.each([
    {
      shape: "on the root",
      run: (store: LoggedStore) => store.edges.knows.create(alice, bob, {}),
    },
    {
      shape: "in a transaction",
      run: (store: LoggedStore) =>
        store.transaction((tx) => tx.edges.knows.create(alice, bob, {})),
    },
  ])("an edge create $shape locks both endpoints", async ({ shape, run }) => {
    const { store, statements } = await loggedStore(fence);
    await run(store);

    expect(
      observeLocks(`${fence.name}, edge create ${shape}`, statements, (text) =>
        text.includes('INSERT INTO "typegraph_edges"'),
      ),
    ).toEqual(fence.edgeCreate);
  });

  it("a node delete locks its node before it reads connected edges", async () => {
    const { store, statements } = await loggedStore(fence);
    await store.edges.knows.create(alice, bob, {});
    statements.length = 0;

    await store.nodes.Person.delete(asNodeId<typeof Person>(bob.id));

    expect(
      observeLocks(`${fence.name}, node delete`, statements, (text) =>
        text.includes('FROM "typegraph_edges"'),
      ),
    ).toEqual(fence.nodeDelete);
  });
});
