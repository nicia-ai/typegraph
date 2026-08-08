/**
 * The per-graph write fence around constrained writes, on a REAL Postgres
 * engine (PGlite, in-process, no Docker).
 *
 * What is under test is an ORDERING and a COST, not an outcome: every
 * constraint here is already enforced correctly by a single writer, so a
 * functional assertion cannot tell a fenced write from an unfenced one. What
 * distinguishes them is whether `pg_advisory_xact_lock('typegraph:
 * recorded-graph-write', graph)` is taken inside the write transaction BEFORE
 * the probe it protects — which is exactly what a default PostgreSQL store did
 * not do, leaving cardinality, shared-scope uniqueness, disjointness, and
 * `getOrCreateByEndpoints` convergence as probes two writers could both pass.
 *
 * PGlite is single-connection and serial, so a genuine two-writer race is NOT
 * constructible here (see `tests/backends/postgres/schema-write-fence-race.
 * test.ts`, which needs server Postgres for the same reason). These assertions
 * are therefore about the fence's presence, its placement relative to the probe,
 * and — just as load-bearing — its ABSENCE on writes that declare no constraint,
 * so the fix cannot be "lock everything".
 *
 * Statements are captured with drizzle's `logger`, matching
 * `backends/postgres/recorded-lock-churn.test.ts`: it sees every statement,
 * including ones a backend-method Proxy would miss.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  subClassOf,
} from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";
import { createStore, type Store } from "../src/store";

const GRAPH_WRITE_NAMESPACE = "typegraph:recorded-graph-write";

type LoggedStatement = Readonly<{ query: string; params: readonly unknown[] }>;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

/**
 * A hierarchy with a SHARED-SCOPE unique: the probe walks root + descendants
 * while `insertUnique` reserves one row under the node's own kind, so sibling
 * kinds are distinct primary-key rows that can never collide (#436 item 1).
 */
const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string(), name: z.string() }),
});
const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string(), name: z.string() }),
});

/** A same-kind unique: the uniques primary key IS the fence, so none is taken. */
const Account = defineNode("Account", {
  schema: z.object({ email: z.string() }),
});

const Team = defineNode("Team", {
  schema: z.object({ name: z.string() }),
});

/** Cardinality `many`: declares nothing, so its create probes nothing. */
const knows = defineEdge("knows", { schema: z.object({}) });
/** Cardinality `one`: an application count probe no database key repeats. */
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

const SHARED_SCOPE_UNIQUE = {
  name: "shared_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "constraint_write_fence",
  nodes: {
    Person: { type: Person },
    Team: { type: Team },
    Worker: { type: Worker, unique: [SHARED_SCOPE_UNIQUE] },
    Employee: { type: Employee, unique: [SHARED_SCOPE_UNIQUE] },
    Contractor: { type: Contractor, unique: [SHARED_SCOPE_UNIQUE] },
    Account: {
      type: Account,
      unique: [
        {
          name: "own_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    reportsTo: {
      type: reportsTo,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Contractor, Worker),
    disjointWith(Person, Team),
  ],
});

type FenceStore = Store<typeof graph>;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const pending = cleanups.splice(0);
  for (const cleanup of pending.toReversed()) await cleanup();
});

async function createLoggedStore(): Promise<
  Readonly<{
    store: FenceStore;
    backend: GraphBackend;
    statements: LoggedStatement[];
    reset: () => void;
  }>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  await client.exec(generatePostgresDDL().join("\n\n"));

  const statements: LoggedStatement[] = [];
  const backend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string, params: unknown[]): void {
          statements.push({ query, params });
        },
      },
    }),
    { vector: false },
  );

  return {
    store: createStore(graph, backend),
    backend,
    statements,
    reset: () => statements.splice(0),
  };
}

function graphWriteLockIndex(statements: readonly LoggedStatement[]): number {
  return statements.findIndex(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  );
}

function graphWriteLockCount(statements: readonly LoggedStatement[]): number {
  return statements.filter(
    (statement) =>
      statement.query.includes("pg_advisory_xact_lock") &&
      statement.params[0] === GRAPH_WRITE_NAMESPACE,
  ).length;
}

function firstIndexMatching(
  statements: readonly LoggedStatement[],
  needle: string,
): number {
  return statements.findIndex((statement) => statement.query.includes(needle));
}

describe("constrained writes take the per-graph write fence", () => {
  it("fences an edge create whose cardinality is probed, and orders the lock before the probe", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    await store.edges.reportsTo.create(alice, bob, {});

    expect(graphWriteLockCount(statements)).toBe(1);
    // The count probe (`SELECT COUNT(*) ... FROM typegraph_edges`) and the
    // INSERT it authorizes must both sit after the lock, or the verdict was
    // computed outside the exclusion it depends on.
    const lockIndex = graphWriteLockIndex(statements);
    const probeIndex = firstIndexMatching(statements, "count");
    const insertIndex = firstIndexMatching(statements, "INSERT INTO");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(probeIndex);
  });

  it("does NOT fence an edge create with cardinality many", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    await store.edges.knows.create(alice, bob, {});

    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences getOrCreateByEndpoints even at cardinality many, because it converges on a match key", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });

    reset();
    const created = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      {},
    );
    expect(created.action).toBe("created");
    expect(graphWriteLockCount(statements)).toBe(1);

    // The found fast path performs no write, so it must not pay for the fence.
    reset();
    const found = await store.edges.knows.getOrCreateByEndpoints(
      alice,
      bob,
      {},
    );
    expect(found.action).toBe("found");
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences bulkGetOrCreateByEndpoints once for the whole batch", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const carol = await store.nodes.Person.create({ name: "Carol" });

    reset();
    const results = await store.edges.knows.bulkGetOrCreateByEndpoints([
      { from: alice, to: bob, props: {} },
      { from: alice, to: carol, props: {} },
    ]);

    expect(results.map((result) => result.action)).toEqual([
      "created",
      "created",
    ]);
    // One transaction, one lock: the nested create batch must not re-acquire
    // what the enclosing frame already holds.
    expect(graphWriteLockCount(statements)).toBe(1);
  });

  it("fences a node create whose uniqueness scope spans sibling kinds", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Employee.create({ email: "x@example.com", name: "E" });

    expect(graphWriteLockCount(statements)).toBe(1);
    const lockIndex = graphWriteLockIndex(statements);
    const probeIndex = firstIndexMatching(statements, "typegraph_node_uniques");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(lockIndex);
  });

  it("does NOT fence a node create whose unique is scoped to its own kind", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Account.create({ email: "own@example.com" });

    // The probe reads exactly the `(graph, kind, constraint, key)` row the
    // insert then reserves, so the uniques primary key is the fence.
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("fences a node create whose kind participates in a disjointness axiom", async () => {
    const { store, statements, reset } = await createLoggedStore();

    reset();
    await store.nodes.Person.create({ name: "Alice" }, { id: "shared-id" });

    expect(graphWriteLockCount(statements)).toBe(1);
    // Ordered against the PROBE, not just the INSERT — as in the two sibling
    // cases above. A fence taken after the cross-kind probe would still precede
    // the INSERT while leaving the verdict computed outside the exclusion it
    // depends on, which is the whole defect; asserting only INSERT ordering
    // would let that mutation live.
    const lockIndex = graphWriteLockIndex(statements);
    const probeIndex = firstIndexMatching(statements, "typegraph_nodes");
    const insertIndex = firstIndexMatching(statements, "INSERT INTO");
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(probeIndex).toBeGreaterThan(lockIndex);
    expect(insertIndex).toBeGreaterThan(probeIndex);
  });

  it("fences a shared-scope node UPDATE but not a delete", async () => {
    const { store, statements, reset } = await createLoggedStore();
    const employee = await store.nodes.Employee.create({
      email: "u@example.com",
      name: "E",
    });

    reset();
    await store.nodes.Employee.update(employee.id, {
      email: "u2@example.com",
    });
    expect(graphWriteLockCount(statements)).toBe(1);

    // A delete RELEASES uniqueness entries; it re-derives no cross-kind verdict
    // and so declares no fence.
    reset();
    await store.nodes.Employee.delete(employee.id);
    expect(graphWriteLockCount(statements)).toBe(0);
  });

  it("still refuses the sibling-kind duplicate the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    await store.nodes.Employee.create({ email: "dup@example.com", name: "E" });

    await expect(
      store.nodes.Contractor.create({ email: "dup@example.com", name: "C" }),
    ).rejects.toThrow(/Uniqueness/u);
  });

  it("still refuses the disjoint-kind duplicate id the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    await store.nodes.Person.create({ name: "Alice" }, { id: "shared-id" });

    await expect(
      store.nodes.Team.create({ name: "Team" }, { id: "shared-id" }),
    ).rejects.toThrow(/[Dd]isjoint/u);
  });

  it("still refuses the second cardinality-one edge the fence exists to serialize", async () => {
    const { store } = await createLoggedStore();
    const alice = await store.nodes.Person.create({ name: "Alice" });
    const bob = await store.nodes.Person.create({ name: "Bob" });
    const carol = await store.nodes.Person.create({ name: "Carol" });

    await store.edges.reportsTo.create(alice, bob, {});
    await expect(
      store.edges.reportsTo.create(alice, carol, {}),
    ).rejects.toThrow(/[Cc]ardinality/u);
  });
});
