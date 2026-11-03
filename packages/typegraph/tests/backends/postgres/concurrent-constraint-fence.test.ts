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
 * - **A composition `partOf` postcondition**: `getOrCreateByConstraint`
 *   decides what an incumbent whole MEANS from a read, and two callers naming
 *   different wholes for one already-existing part each read "no whole yet".
 *   The refusal is the application's, not a key's.
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
 * writers can never actually overlap there. This suite is the other half: two
 * independent connections against one database, with the interleaving FORCED
 * by hold-and-gate (`./held-transaction-race.ts`). The holder writes inside a
 * transaction it keeps open; the contender starts on the other pool and must be
 * observed parked on a lock the holder took before the holder commits. Which
 * writer wins is therefore fixed by construction, and each case asserts the
 * contender's exact refusal.
 *
 * Against the pre-fix code every constrained case here fails
 * deterministically: the contender settles while the holder is still open, and
 * both commit — two edges / two live cardinality-`one` edges / two sibling rows
 * sharing a unique key / two disjoint-kind rows sharing an id.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  CompositionExistenceError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  partOf,
  type Store,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { graphCommandExecutionContext } from "../../../src/backend/command-contract";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type { GraphBackend, GraphCommand } from "../../../src/backend/types";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  type HeldRace,
  poolApplicationName,
  raceAgainstHeldTransaction,
  requireError,
  requireValue,
  summarizeRace,
} from "./held-transaction-race";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;

const HOLDER_APPLICATION = "concurrent-constraint-fence:holder";
const CONTENDER_APPLICATION = "concurrent-constraint-fence:contender";

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

/** A composition whole, and the part that holds at most one of them. */
const Shelf = defineNode("Shelf", { schema: z.object({}) });
const Book = defineNode("Book", { schema: z.object({ slug: z.string() }) });

/** The key two racing `getOrCreateByConstraint` calls match the same part on. */
const BOOK_SLUG_UNIQUE = {
  name: "book_slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;

/** Cardinality `many`: only `getOrCreateByEndpoints` convergence is at stake. */
const knows = defineEdge("knows", { schema: z.object({ since: z.string() }) });
/** Cardinality `one`: an application count probe with no key behind it. */
const reportsTo = defineEdge("reportsTo", { schema: z.object({}) });
/** The realizing edge of the `partOf(Book, Shelf)` pair. */
const shelvedIn = defineEdge("shelvedIn", { schema: z.object({}) });

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
    Shelf: { type: Shelf },
    Book: { type: Book, unique: [BOOK_SLUG_UNIQUE] },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    reportsTo: {
      type: reportsTo,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
    shelvedIn: {
      type: shelvedIn,
      from: [Book],
      to: [Shelf],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Contractor, Worker),
    disjointWith(Person, Company),
    partOf(Book, Shelf, { via: shelvedIn }),
  ],
});

type GraphStore = Store<typeof graph>;

/**
 * Separate pools, not one with a larger `max`.
 *
 * The contender parks inside `pg_advisory_xact_lock` while holding its
 * connection, and it must be impossible for that wait to sit behind the
 * holder's own connection in a shared checkout queue — that would be a
 * self-deadlock of the test harness rather than a product result. Separate
 * pools make the two writers independent by construction. The probe pool
 * observes the wait.
 */
let holderPool: Pool | undefined;
let contenderPool: Pool | undefined;
let probePool: Pool | undefined;
let holderDb: NodePgDatabase | undefined;
let contenderDb: NodePgDatabase | undefined;

/**
 * The suite is gated on `POSTGRES_URL`, and its setup now FAILS rather than
 * skipping (see ./server-suite-setup.ts), so an unpublished handle here means
 * setup reported success without publishing one. Throwing keeps that a
 * failure: a `ctx.skip()` would turn the same state back into the green skip
 * the setup fix exists to remove.
 */
function requirePostgres(): Readonly<{
  holder: NodePgDatabase;
  contender: NodePgDatabase;
  probe: Pool;
}> {
  if (
    holderDb === undefined ||
    contenderDb === undefined ||
    probePool === undefined
  ) {
    throw new Error(
      "concurrent-constraint-fence: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { holder: holderDb, contender: contenderDb, probe: probePool };
}

function createPool(applicationName?: string): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
    ...(applicationName === undefined ?
      {}
    : poolApplicationName(applicationName)),
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pools = [
    createPool(HOLDER_APPLICATION),
    createPool(CONTENDER_APPLICATION),
    createPool(),
  ] as const;
  await runServerSuiteSetup("concurrent-constraint-fence", pools, async () => {
    const [holder, contender, probe] = pools;
    await holder.query("SELECT 1");
    await contender.query("SELECT 1");
    await probe.query(generatePostgresMigrationSQL());
    holderPool = holder;
    contenderPool = contender;
    probePool = probe;
    holderDb = drizzle(holder);
    contenderDb = drizzle(contender);
  });
});

afterAll(async () => {
  for (const pool of [holderPool, contenderPool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  // `typegraph_edge_claims` included: the cardinality-`one` and composition
  // cases both reserve a claim row, and a row left behind would refuse the
  // same write on the next run against this persistent per-suite database.
  await probePool.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edge_claims, typegraph_edges, typegraph_nodes",
  );
});

/** The holder's and contender's stores, each on its own pool. */
function createRacingStores(
  live: ReturnType<typeof requirePostgres>,
): Readonly<{ holderStore: GraphStore; contenderStore: GraphStore }> {
  return {
    holderStore: createStore(graph, createPostgresBackend(live.holder)),
    contenderStore: createStore(graph, createPostgresBackend(live.contender)),
  };
}

function raceOnLivePools<THolder, TContender>(
  live: ReturnType<typeof requirePostgres>,
  holder: (holdOpen: () => Promise<void>) => Promise<THolder>,
  contender: () => Promise<TContender>,
): Promise<HeldRace<THolder, TContender>> {
  return raceAgainstHeldTransaction({
    probe: live.probe,
    holderApplication: HOLDER_APPLICATION,
    contenderApplication: CONTENDER_APPLICATION,
    holder,
    contender,
  });
}

/** Records the transaction-scoped managed plans without changing capability truth. */
function recordManagedPlans(
  backend: GraphBackend,
  plans: GraphCommand[],
): GraphBackend {
  return deriveBackend(backend, {
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              commands: {
                session: target.commands.session,
                execute: async (plan) => {
                  plans.push(plan);
                  return target.commands.execute(
                    plan,
                    graphCommandExecutionContext("transaction"),
                  );
                },
              },
            }),
          ),
        options,
      ),
  });
}

describe.runIf(process.env["POSTGRES_URL"])(
  "constrained writes under genuine contention (PostgreSQL)",
  () => {
    it(
      "converges two getOrCreateByEndpoints onto ONE edge, the second waiting on the fence",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const alice = await setup.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const bob = await setup.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const { holderStore, contenderStore } = createRacingStores(live);

        // Identical props, so both callers name the SAME match key: converging
        // on it is the whole contract, and differing props would be two
        // legitimately different edges under `matchOn`.
        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              const result = await tx.edges.knows.getOrCreateByEndpoints(
                alice,
                bob,
                { since: "2024" },
              );
              await holdOpen();
              return result;
            }),
          () =>
            contenderStore.edges.knows.getOrCreateByEndpoints(alice, bob, {
              since: "2024",
            }),
        );

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: "ok",
        });
        const created = requireValue(race.holder);
        const found = requireValue(race.contender);
        expect(created.action).toBe("created");
        expect(found.action).toBe("found");
        expect(found.edge.id).toBe(created.edge.id);
        expect(await setup.edges.knows.findFrom(alice)).toHaveLength(1);
      },
    );

    it(
      "refuses the second of two cardinality-one creates",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
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
        const { holderStore, contenderStore } = createRacingStores(live);

        // Same source, different targets: `one` allows at most one edge of this
        // kind FROM alice, so the two are in direct conflict.
        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.reportsTo.create(alice, bob, {});
              await holdOpen();
            }),
          () => contenderStore.edges.reportsTo.create(alice, carol, {}),
        );

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CardinalityError.name,
        });
        const survivors = await setup.edges.reportsTo.findFrom(alice);
        expect(survivors.map((edge) => edge.toId)).toEqual([bob.id]);
      },
    );

    it(
      "refuses the second of two sibling-kind inserts sharing a scoped unique key",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const holderPlans: GraphCommand[] = [];
        const contenderPlans: GraphCommand[] = [];
        const holderStore = createStore(
          graph,
          recordManagedPlans(createPostgresBackend(live.holder), holderPlans),
        );
        const contenderStore = createStore(
          graph,
          recordManagedPlans(
            createPostgresBackend(live.contender),
            contenderPlans,
          ),
        );

        // Employee and Contractor are SIBLINGS under Worker. Their uniques rows
        // are keyed by their own kinds, so the sidecar's primary key cannot
        // refuse the second — only the serialized probe can.
        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.nodes.Employee.create({
                name: "Employee",
                email: "shared@example.com",
              });
              await holdOpen();
            }),
          () =>
            contenderStore.nodes.Contractor.create({
              name: "Contractor",
              email: "shared@example.com",
            }),
        );

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: UniquenessError.name,
        });
        const refusal = requireError(race.contender);
        expect(refusal).toBeInstanceOf(UniquenessError);
        expect((refusal as UniquenessError).details.constraintName).toBe(
          "staff_email",
        );

        expect(await holderStore.nodes.Employee.find()).toHaveLength(1);
        expect(await holderStore.nodes.Contractor.find()).toEqual([]);
        const commands = [...holderPlans, ...contenderPlans];
        expect(commands).toHaveLength(2);
        for (const command of commands) {
          expect(command.kind).toBe("node.create");
          if (command.kind !== "node.create") {
            throw new Error("Expected a node.create command");
          }
          expect(command.plan.entity).toBe("node");
          expect(command.plan.claims).toHaveLength(1);
        }
      },
    );

    it(
      "refuses the second of two disjoint-kind creates sharing an id",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { holderStore, contenderStore } = createRacingStores(live);

        // `(graph_id, kind, id)` makes these two DIFFERENT rows, so the nodes
        // primary key is structurally incapable of refusing the second.
        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.nodes.Person.create(
                { name: "Person" },
                { id: "shared-id" },
              );
              await holdOpen();
            }),
          () =>
            contenderStore.nodes.Company.create(
              { name: "Company" },
              { id: "shared-id" },
            ),
        );

        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: DisjointError.name,
        });
        expect(await holderStore.nodes.Person.find()).toHaveLength(1);
        expect(await holderStore.nodes.Company.find()).toEqual([]);
      },
    );

    it(
      "refuses the second of two partOf postconditions naming DIFFERENT wholes",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // The composition counterpart of the cases above, and the half the
        // in-process simulation (`tests/composition-attachment-fence.test.ts`)
        // cannot reach: that file forces the interleaving by running the
        // competing write inside the loser's own read, on one connection. Here
        // two independent connections overlap, which is the only way to see
        // what the engine actually admits.
        //
        // Both callers match the SAME already-existing, UNATTACHED part, so
        // neither creates a row and each one's lookup can legitimately observe
        // "no whole yet". Nothing in the schema can refuse the second: the
        // decision is "what does the incumbent whole mean", which only a
        // verdict re-read under the per-graph fence can answer.
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
        const shelfA = await setup.nodes.Shelf.create({}, { id: "shelf-a" });
        const shelfB = await setup.nodes.Shelf.create({}, { id: "shelf-b" });
        await setup.nodes.Book.create({ slug: "contested" }, { id: "book" });
        const { holderStore, contenderStore } = createRacingStores(live);

        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.nodes.Book.getOrCreateByConstraint(
                "book_slug",
                { slug: "contested" },
                { partOf: { whole: { kind: "Shelf", id: shelfA.id } } },
              );
              await holdOpen();
            }),
          () =>
            contenderStore.nodes.Book.getOrCreateByConstraint(
              "book_slug",
              { slug: "contested" },
              { partOf: { whole: { kind: "Shelf", id: shelfB.id } } },
            ),
        );

        // One attachment, one refusal — never two attachments, and never a
        // silent move that leaves the contender reporting success.
        expect(summarizeRace(race)).toEqual({
          contenderState: "blocked",
          holder: "ok",
          contender: CompositionExistenceError.name,
        });
        const refusal = requireError(race.contender);
        expect(refusal).toBeInstanceOf(CompositionExistenceError);
        const details = (refusal as CompositionExistenceError).details;
        expect(details.situation).toBe("existing");
        expect(details.requestedVia).toBe("shelvedIn");
        expect(details.currentWhole).toEqual({ kind: "Shelf", id: shelfA.id });
        expect(details.requestedWhole?.id).toBe(shelfB.id);

        // The part holds the holder's whole, through exactly one edge, with no
        // retired window: a move would leave two rows, one of them ended.
        const edges = await setup.edges.shelvedIn.find(
          {},
          { temporalMode: "includeEnded" },
        );
        expect(
          edges.map((edge) => ({
            toId: edge.toId,
            validTo: edge.meta.validTo,
          })),
        ).toEqual([{ toId: shelfA.id, validTo: undefined }]);
      },
    );

    it(
      "lets two UNCONSTRAINED writes both succeed without waiting on each other",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        // The control: the fence must not turn independent writes into
        // failures, nor serialize them. `knows` is cardinality `many` and a
        // plain `create` runs no probe, so the contender commits while the
        // holder's transaction is still open. The statement-level absence
        // assertion is `tests/constraint-write-fence.test.ts`, which counts
        // the statements themselves on PGlite.
        const live = requirePostgres();
        const setup = createStore(graph, createPostgresBackend(live.holder));
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
        const { holderStore, contenderStore } = createRacingStores(live);

        const race = await raceOnLivePools(
          live,
          (holdOpen) =>
            holderStore.transaction(async (tx) => {
              await tx.edges.knows.create(alice, bob, { since: "a" });
              await holdOpen();
            }),
          () => contenderStore.edges.knows.create(alice, carol, { since: "b" }),
        );

        expect(summarizeRace(race)).toEqual({
          contenderState: "settled",
          holder: "ok",
          contender: "ok",
        });
        expect(await setup.edges.knows.findFrom(alice)).toHaveLength(2);
      },
    );
  },
);
