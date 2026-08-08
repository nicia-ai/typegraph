/**
 * Issues #428 / #436: constrained writes under GENUINE contention on a real
 * PostgreSQL server.
 *
 * Four declared constraints are enforced by an application probe that no
 * database key repeats at write time — the available key covers a different
 * axis than the constraint declares:
 *
 * - **`getOrCreateByEndpoints` convergence**: the edges relation is unique on
 *   `(graph_id, id)` only, and the match key may include `matchOn` prop values,
 *   so nothing conflicts when two callers both decide to create.
 * - **Edge cardinality `one`**: a predicate over `(kind, from)`, with no key on
 *   that axis.
 * - **`scope: "kindWithSubClasses"` uniqueness**: the probe walks root +
 *   descendants while `insertUnique` reserves one row under the node's OWN
 *   kind, and the uniques primary key is
 *   `(graph_id, node_kind, constraint_name, key)` — sibling kinds are distinct
 *   rows that can never collide.
 * - **Disjointness**: a predicate over `(graph_id, id)` ACROSS kinds, while the
 *   nodes primary key is `(graph_id, kind, id)`.
 *
 * SQLite has always been safe here (`BEGIN IMMEDIATE` admits one writer at a
 * time) and PostgreSQL was safe only with history or revision tracking on,
 * because only those took the per-graph advisory lock. On a DEFAULT PostgreSQL
 * store both writers passed their probe and both committed. Constrained writes
 * now take that same per-graph lock unconditionally.
 *
 * ## Why this suite exists alongside the in-process ones
 *
 * `tests/constraint-write-fence.test.ts` pins the MECHANISM on PGlite — that
 * the lock is taken, before the probe, and NOT taken by unconstrained writes.
 * It cannot pin the outcome: PGlite is single-connection and serial, so two
 * writers can never actually overlap there. This suite is the other half. It
 * runs two independent connections against one database and asserts only
 * OUTCOMES — how many callers succeeded and what the loser was told — never
 * timing or ordering, because which of the two wins the lock is genuinely
 * arbitrary and asserting on it would make the suite flaky by construction.
 *
 * Against the pre-fix code every case here fails nondeterministically: both
 * writers commit, leaving two edges / two live cardinality-`one` edges / two
 * sibling rows sharing a unique key / two disjoint-kind rows sharing an id.
 *
 * Each concurrent pair carries an explicit timeout. A blocked
 * `pg_advisory_xact_lock` waits indefinitely, so a lock-order regression would
 * otherwise stall the run rather than report; the timeout turns a hang into a
 * failure.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** Each concurrent pair: one writer holds the fence while the other waits. */
const CONTENTION_TIMEOUT_MS = 20_000;

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
/** Disjoint with `Person`: the same id under both kinds is two nodes rows. */
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const Worker = defineNode("Worker", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), email: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ name: z.string(), email: z.string() }),
});

/** Cardinality `many`: only `getOrCreateByEndpoints` convergence is at stake. */
const knows = defineEdge("knows", { schema: z.object({ since: z.string() }) });
/** Cardinality `one`: an application count probe with no key behind it. */
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });

/**
 * Declared on every kind in the hierarchy, which is what makes the probe span
 * siblings while the reservation stays kind-local.
 */
const STAFF_EMAIL_UNIQUE = {
  name: "staff_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const graph = defineGraph({
  id: "concurrent-constraint-fence",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Worker: { type: Worker, unique: [STAFF_EMAIL_UNIQUE] },
    Employee: { type: Employee, unique: [STAFF_EMAIL_UNIQUE] },
    Contractor: { type: Contractor, unique: [STAFF_EMAIL_UNIQUE] },
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
    disjointWith(Person, Company),
  ],
});

/**
 * TWO pools, not one with a larger `max`.
 *
 * The losing writer parks inside `pg_advisory_xact_lock` while holding its
 * connection, and it must be impossible for that wait to sit behind the
 * winner's own connection in a shared checkout queue — that would be a
 * self-deadlock of the test harness rather than a product result. Separate
 * pools make the two writers independent by construction.
 */
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let firstDb: NodePgDatabase | undefined;
let secondDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Readonly<{
  first: NodePgDatabase;
  second: NodePgDatabase;
}> {
  if (!isPostgresAvailable || firstDb === undefined || secondDb === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { first: firstDb, second: secondDb };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool();
  const second = createPool();
  try {
    await first.query("SELECT 1");
    await second.query("SELECT 1");
    await first.query(generatePostgresMigrationSQL());
    firstPool = first;
    secondPool = second;
    firstDb = drizzle(first);
    secondDb = drizzle(second);
    isPostgresAvailable = true;
  } catch (error) {
    console.error(
      "concurrent-constraint-fence: Postgres setup failed; skipping suite.",
      error,
    );
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await first.end().catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await second.end().catch(() => {});
  }
});

afterAll(async () => {
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
});

beforeEach(async () => {
  if (firstPool === undefined) return;
  await firstPool.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
});

type Settled<T> = Readonly<{
  fulfilled: readonly T[];
  rejected: readonly unknown[];
}>;

/**
 * Splits a settled pair into winners and losers. The assertions are always
 * about the COUNTS and the loser's error TYPE — never about which of the two
 * stores won, which is arbitrary and would make the case flaky.
 */
function partitionSettled<T>(
  results: readonly PromiseSettledResult<T>[],
): Settled<T> {
  return {
    fulfilled: results
      .filter((result): result is PromiseFulfilledResult<T> => {
        return result.status === "fulfilled";
      })
      .map((result) => result.value),
    rejected: results
      .filter((result): result is PromiseRejectedResult => {
        return result.status === "rejected";
      })
      .map((result): unknown => result.reason),
  };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "constrained writes under genuine contention (PostgreSQL)",
  () => {
    it(
      "converges two concurrent getOrCreateByEndpoints onto ONE edge",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const setup = createStore(graph, createPostgresBackend(live.first));
        const alice = await setup.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const bob = await setup.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // Identical props, so both callers name the SAME match key: converging
        // on it is the whole contract, and differing props would be two
        // legitimately different edges under `matchOn`.
        const [first, second] = await Promise.all([
          storeA.edges.knows.getOrCreateByEndpoints(alice, bob, {
            since: "2024",
          }),
          storeB.edges.knows.getOrCreateByEndpoints(alice, bob, {
            since: "2024",
          }),
        ]);

        // Both callers hold the same edge...
        expect(first.edge.id).toBe(second.edge.id);
        // ...exactly one of them made it...
        expect(
          [first.action, second.action].filter(
            (action) => action === "created",
          ),
        ).toHaveLength(1);
        expect(
          [first.action, second.action].filter((action) => action === "found"),
        ).toHaveLength(1);
        // ...and the relation holds one edge, not two.
        expect(await setup.edges.knows.findFrom(alice)).toHaveLength(1);
      },
    );

    it(
      "admits exactly one of two concurrent cardinality-one creates",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const setup = createStore(graph, createPostgresBackend(live.first));
        const alice = await setup.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const bob = await setup.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const carol = await setup.nodes.Person.create(
          { name: "Carol" },
          { id: "carol" },
        );

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // Same source, different targets: `one` allows at most one edge of this
        // kind FROM alice, so the two are in direct conflict.
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.reportsTo.create(alice, bob, {}),
            storeB.edges.reportsTo.create(alice, carol, {}),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(CardinalityError);
        expect(await setup.edges.reportsTo.findFrom(alice)).toHaveLength(1);
      },
    );

    it(
      "admits exactly one of two concurrent sibling-kind inserts sharing a scoped unique key",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // Employee and Contractor are SIBLINGS under Worker. Their uniques rows
        // are keyed by their own kinds, so the sidecar's primary key cannot
        // refuse the second — only the serialized probe can.
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.nodes.Employee.create({
              name: "Employee",
              email: "shared@example.com",
            }),
            storeB.nodes.Contractor.create({
              name: "Contractor",
              email: "shared@example.com",
            }),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(UniquenessError);
        expect((rejected[0] as UniquenessError).details.constraintName).toBe(
          "staff_email",
        );

        const employees = await storeA.nodes.Employee.find();
        const contractors = await storeA.nodes.Contractor.find();
        expect(employees.length + contractors.length).toBe(1);
      },
    );

    it(
      "admits exactly one of two concurrent disjoint-kind creates sharing an id",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        // `(graph_id, kind, id)` makes these two DIFFERENT rows, so the nodes
        // primary key is structurally incapable of refusing the second.
        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.nodes.Person.create({ name: "Person" }, { id: "shared-id" }),
            storeB.nodes.Company.create(
              { name: "Company" },
              { id: "shared-id" },
            ),
          ]),
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toBeInstanceOf(DisjointError);

        const people = await storeA.nodes.Person.find();
        const companies = await storeA.nodes.Company.find();
        expect(people.length + companies.length).toBe(1);
      },
    );

    it(
      "lets two concurrent UNCONSTRAINED writes both succeed",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        // The control, on OUTCOMES only: the fence must not turn independent
        // writes into failures. `knows` is cardinality `many` and a plain
        // `create` runs no probe, so both writers must simply succeed.
        //
        // This case deliberately does NOT claim the lock is absent — nothing
        // here observes lock acquisition, and two successes are equally
        // consistent with a lock that was taken and released. The deterministic
        // absence assertion is `tests/constraint-write-fence.test.ts`, which
        // counts the statements themselves on PGlite.
        const live = requirePostgres(ctx);
        const setup = createStore(graph, createPostgresBackend(live.first));
        const alice = await setup.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const bob = await setup.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const carol = await setup.nodes.Person.create(
          { name: "Carol" },
          { id: "carol" },
        );

        const storeA = createStore(graph, createPostgresBackend(live.first));
        const storeB = createStore(graph, createPostgresBackend(live.second));

        const { fulfilled, rejected } = partitionSettled(
          await Promise.allSettled([
            storeA.edges.knows.create(alice, bob, { since: "a" }),
            storeB.edges.knows.create(alice, carol, { since: "b" }),
          ]),
        );

        expect(rejected).toEqual([]);
        expect(fulfilled).toHaveLength(2);
        expect(await setup.edges.knows.findFrom(alice)).toHaveLength(2);
      },
    );
  },
);
