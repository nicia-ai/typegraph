/**
 * Issue #436: a uniqueness claim fences a writer that takes NO per-graph lock.
 *
 * The suite that already exists for constrained writes
 * (`concurrent-constraint-fence.test.ts`) races two STORE writers, and both of
 * them take the per-graph advisory lock — so every case there passes on the
 * lock alone. This file races a store writer against an `importGraph`, which
 * takes no such lock: the only thing standing between the two is the claim row
 * itself, and its primary key.
 *
 * That premise is pinned rather than assumed. `beforeAll` runs one import
 * through the import leg's store with drizzle's logger attached and asserts it
 * issued NO `pg_advisory_xact_lock` for the graph; build that store with
 * `history: true` and the assertion fails immediately, before any case can pass
 * for the wrong reason.
 *
 * The cases are the ones the axis and the owner pair make decidable at all:
 *
 * - `C1` sibling kinds racing on one shared-scope key. Before the axis move the
 *   two claims were rows under DIFFERENT `node_kind`s, so the uniques primary
 *   key could not refuse either.
 * - `C7` an import moving a node ONTO a key a store create is taking.
 * - `C11` the same id under two kinds in one scope. Before the owner pair the
 *   second writer read its own id back out of `RETURNING` and was accepted,
 *   silently transferring the incumbent's claim.
 * - `C2`/`C12` two DISJOINT kinds racing on one id. There is no key here at all
 *   — the nodes primary key is `(graph_id, kind, id)`, so the two rows never
 *   collide — and the claim on the declared PAIR is the entire fence.
 *
 * The interleaving is FORCED rather than hoped for. Each case parks the import
 * leg between its uniqueness probe and its claim, runs the store leg to
 * completion against a second connection, and only then lets the claim proceed
 * — which is exactly the window a lock would have closed and a claim has to
 * close on its own. Without it the two legs usually serialize by accident and
 * the cases pass with the fence removed.
 *
 * Assertions are about OUTCOMES only — how many rows survived and what the
 * loser was told.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
  type GraphDef,
  type Store,
  subClassOf,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { type GraphBackend } from "../../../src/backend/types";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
  type ImportOptions,
} from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** Each concurrent pair: one writer holds the claim row while the other waits. */
const CONTENTION_TIMEOUT_MS = 20_000;

const STAFF_EMAIL_CONSTRAINT = "staff_email";

const STAFF_EMAIL_UNIQUE = {
  name: STAFF_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string() }),
});

const graph = defineGraph({
  id: "concurrent-claim-fence",
  nodes: {
    Worker: { type: Worker, unique: [STAFF_EMAIL_UNIQUE] },
    Employee: { type: Employee, unique: [STAFF_EMAIL_UNIQUE] },
    Contractor: { type: Contractor, unique: [STAFF_EMAIL_UNIQUE] },
  },
  edges: {},
  ontology: [subClassOf(Employee, Worker), subClassOf(Contractor, Worker)],
});

/**
 * A second graph for the ORDER case (C9b): two constraints folding onto one
 * axis, declared in OPPOSITE order by the two kinds the two writers use.
 *
 * That opposition is the point. Claims are issued in canonical order rather
 * than in the order a schema happens to list them, so both writers take
 * `order_alias` before `order_email` and one simply waits for the other. Issued
 * in declaration order they would form a cycle — each holding the row the other
 * needs — and PostgreSQL would break it by aborting one leg with `40P01`, which
 * for an import means a whole-batch abort where the design promises a per-row
 * refusal.
 */
const ORDER_ALIAS_UNIQUE = {
  name: "order_alias",
  fields: ["alias"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const ORDER_EMAIL_UNIQUE = {
  name: "order_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const OrderAliasFirst = defineNode("OrderAliasFirst", {
  schema: z.object({ alias: z.string(), email: z.string() }),
});
const OrderEmailFirst = defineNode("OrderEmailFirst", {
  schema: z.object({ alias: z.string(), email: z.string() }),
});

const orderGraph = defineGraph({
  id: "concurrent-claim-order",
  nodes: {
    OrderAliasFirst: {
      type: OrderAliasFirst,
      unique: [ORDER_ALIAS_UNIQUE, ORDER_EMAIL_UNIQUE],
    },
    OrderEmailFirst: {
      type: OrderEmailFirst,
      unique: [ORDER_EMAIL_UNIQUE, ORDER_ALIAS_UNIQUE],
    },
  },
  edges: {},
  ontology: [subClassOf(OrderEmailFirst, OrderAliasFirst)],
});

/**
 * A third graph for the DISJOINTNESS case (C2/C12): two kinds declared disjoint
 * and nothing else — no unique constraint, so nothing but the pair claim can
 * refuse either writer.
 */
const ClaimPerson = defineNode("ClaimPerson", {
  schema: z.object({ name: z.string() }),
});
const ClaimCompany = defineNode("ClaimCompany", {
  schema: z.object({ name: z.string() }),
});

const disjointGraph = defineGraph({
  id: "concurrent-claim-disjoint",
  nodes: {
    ClaimPerson: { type: ClaimPerson },
    ClaimCompany: { type: ClaimCompany },
  },
  edges: {},
  ontology: [disjointWith(ClaimPerson, ClaimCompany)],
});

const IMPORT_OPTIONS: ImportOptions = {
  onConflict: "update",
  onUnknownProperty: "error",
  validateReferences: true,
  batchSize: 100,
  refreshStatistics: false,
};

function importPayload(nodes: GraphData["nodes"]): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "concurrent claim fence" },
    nodes,
    edges: [],
  };
}

/** Statements the import leg issued, for the lock-free premise assertion. */
const importStatements: string[] = [];

let storePool: Pool | undefined;
let importPool: Pool | undefined;
let storeDb: NodePgDatabase | undefined;
let importDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(): Readonly<{
  storeDb: NodePgDatabase;
  importDb: NodePgDatabase;
}> {
  if (!isPostgresAvailable || storeDb === undefined || importDb === undefined) {
    throw new Error(
      "concurrent-claim-fence: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { storeDb, importDb };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

/**
 * A live store with the DEFAULT options — no history, no revision tracking —
 * which is the configuration in which an import takes no per-graph lock. The
 * `beforeAll` premise assertion is what keeps that true.
 */
async function createGraphStore(
  database: NodePgDatabase,
  decorate: (backend: GraphBackend) => GraphBackend = (backend) => backend,
) {
  const [store] = await createStoreWithSchema(
    graph,
    decorate(createPostgresBackend(database)),
  );
  return store;
}

/** The same, for the claim-ORDER graph. */
async function createOrderStore(
  database: NodePgDatabase,
  decorate: (backend: GraphBackend) => GraphBackend = (backend) => backend,
) {
  const [store] = await createStoreWithSchema(
    orderGraph,
    decorate(createPostgresBackend(database)),
  );
  return store;
}

/** The same, for the DISJOINT graph. */
async function createDisjointStore(
  database: NodePgDatabase,
  decorate: (backend: GraphBackend) => GraphBackend = (backend) => backend,
) {
  const [store] = await createStoreWithSchema(
    disjointGraph,
    decorate(createPostgresBackend(database)),
  );
  return store;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool();
  const second = createPool();
  await runServerSuiteSetup(
    "concurrent-claim-fence",
    [first, second],
    async () => {
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await first.query(generatePostgresMigrationSQL());
      storePool = first;
      importPool = second;
      storeDb = drizzle(first);
      importDb = drizzle(second, {
        logger: {
          logQuery(query: string): void {
            importStatements.push(query);
          },
        },
      });
      isPostgresAvailable = true;

      // The premise: this leg takes no per-graph lock, so a claim is the only
      // thing that can fence it.
      const store = await createGraphStore(importDb);
      importStatements.splice(0);
      await importGraph(
        store,
        importPayload([
          {
            kind: "Employee",
            id: "premise-probe",
            properties: { email: "premise@example.com" },
          },
        ]),
        IMPORT_OPTIONS,
      );
      const locks = importStatements.filter((query) =>
        query.includes("pg_advisory_xact_lock"),
      );
      if (locks.length > 0) {
        throw new Error(
          `concurrent-claim-fence: the import leg took ${locks.length} per-graph advisory lock(s), so every case here would certify the lock rather than the claim.`,
        );
      }
    },
  );
});

afterAll(async () => {
  if (storePool !== undefined) await storePool.end();
  if (importPool !== undefined) await importPool.end();
});

beforeEach(async () => {
  if (storePool === undefined) return;
  await storePool.query(
    "TRUNCATE typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
});

/**
 * A one-shot rendezvous: the import leg announces it has reached its claim and
 * waits there until the store leg has committed.
 */
type ClaimGate = Readonly<{
  reached: Promise<undefined>;
  arrive: () => Promise<void>;
  release: () => void;
}>;

function createClaimGate(): ClaimGate {
  // The resolvers are captured out of the executors rather than initialized to
  // no-ops: a placeholder would silently swallow an arrival if the capture ever
  // stopped happening.
  let announceReached: (() => void) | undefined;
  const reached = new Promise<undefined>((resolve) => {
    announceReached = () => {
      resolve(undefined);
    };
  });
  let releaseGate: (() => void) | undefined;
  const released = new Promise<undefined>((resolve) => {
    releaseGate = () => {
      resolve(undefined);
    };
  });
  return {
    reached,
    arrive: async () => {
      requireDefined(announceReached, "claim gate arrival")();
      await released;
    },
    release: () => {
      requireDefined(releaseGate, "claim gate release")();
    },
  };
}

/**
 * The store leg's backend, parked once it HOLDS its first claim row and before
 * it asks for its second — the only interleaving in which a claim-order cycle
 * is constructible at all. The lock it holds is a real row lock in a real
 * transaction, so the other leg genuinely waits on it.
 */
function backendPausingAfterFirstClaim(
  backend: GraphBackend,
  gate: ClaimGate,
): GraphBackend {
  return {
    ...backend,
    transaction: (run, options) =>
      backend.transaction(async (target) => {
        // `let` earns its place: "have I already paused?" is per-transaction
        // state the wrapper has nowhere else to keep.
        let claimsIssued = 0;
        return run({
          ...target,
          insertUnique: async (params) => {
            await target.insertUnique(params);
            claimsIssued += 1;
            if (claimsIssued === 1) {
              await gate.arrive();
            }
          },
        });
      }, options),
  };
}

/**
 * The import leg's backend, parked at the moment its claim is about to be
 * issued — after every probe it makes, before the row it gates is reserved.
 * That is the window under test: the store leg gets to take and commit the key
 * inside it, so only the claim itself can refuse the import.
 */
function backendPausingBeforeClaim(
  backend: GraphBackend,
  gate: ClaimGate,
): GraphBackend {
  const pause = async (): Promise<void> => {
    await gate.arrive();
  };
  return {
    ...backend,
    transaction: (run, options) =>
      backend.transaction(async (target) => {
        const insertUniqueBatch = target.insertUniqueBatch;
        return run({
          ...target,
          insertUnique: async (params) => {
            await pause();
            return target.insertUnique(params);
          },
          ...(insertUniqueBatch === undefined ?
            {}
          : {
              insertUniqueBatch: async (entries) => {
                await pause();
                return insertUniqueBatch(entries);
              },
            }),
        });
      }, options),
  };
}

/**
 * A rejection's whole cause chain, including each link's SQL state.
 *
 * A driver-level failure — a deadlock victim, most importantly — reaches the
 * caller wrapped in the query error that raised it, so its `code` lives on a
 * `cause` several links down. A case asserting the ABSENCE of such a failure
 * has to read all of them or it certifies nothing.
 */
function failureChainText(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status !== "rejected") return refusalText(outcome);
  const parts: string[] = [];
  // `let` earns its place: walking a cause chain is a cursor, and the chain has
  // no array form to iterate.
  let link: unknown = outcome.reason;
  while (link instanceof Error && parts.length < 10) {
    const code = (link as Readonly<{ code?: string }>).code;
    parts.push(
      `${link.name}: ${link.message}${code === undefined ? "" : ` [${code}]`}`,
    );
    link = link.cause;
  }
  return parts.length === 0 ? String(outcome.reason) : parts.join(" <- ");
}

/** Every message the losing leg could have produced, however it surfaced. */
function refusalText(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === "rejected") return String(outcome.reason);
  const result = outcome.value as
    Readonly<{ errors?: readonly Readonly<{ error: string }>[] }> | undefined;
  return (result?.errors ?? []).map((entry) => entry.error).join(" | ");
}

/** How one case builds its two legs' stores — one factory per fixture graph. */
type StoreFactory<G extends GraphDef> = (
  database: NodePgDatabase,
  decorate?: (backend: GraphBackend) => GraphBackend,
) => Promise<Store<G>>;

/**
 * Runs the import leg up to its claim, lets the store leg take the claim row
 * and commit, then releases the claim into a row that is now held — the window
 * a lock-free writer has no other protection in.
 */
async function raceStoreAgainstParkedImport<G extends GraphDef>(
  createStoreFor: StoreFactory<G>,
  payload: GraphData,
  storeWrite: (store: Store<G>) => Promise<unknown>,
): Promise<Readonly<{ importRefusal: string }>> {
  const live = requirePostgres();
  const gate = createClaimGate();
  const importStore = await createStoreFor(live.importDb, (backend) =>
    backendPausingBeforeClaim(backend, gate),
  );
  const store = await createStoreFor(live.storeDb);

  const importRun = importGraph(importStore, payload, IMPORT_OPTIONS);
  // Raced against the import's own completion, so a leg that issues NO claim —
  // which is exactly what deleting the fence produces — reports the missing
  // fence as a failed OUTCOME assertion rather than as a 20-second timeout. A
  // test that can only fail by hanging certifies nothing about what it hung on.
  const importSettled = Promise.allSettled([importRun]).then(
    (): undefined => undefined,
  );
  await Promise.race([gate.reached, importSettled]);
  await storeWrite(store);
  gate.release();

  const [importOutcome] = await Promise.allSettled([importRun]);
  return { importRefusal: refusalText(requireDefined(importOutcome)) };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "claims fence a lock-free writer against a store writer (PostgreSQL)",
  () => {
    it(
      "refuses an import whose sibling-kind key a store create took inside its claim window",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const { importRefusal } = await raceStoreAgainstParkedImport(
          createGraphStore,
          importPayload([
            {
              kind: "Employee",
              id: "c1-employee",
              properties: { email: "c1@example.com" },
            },
          ]),
          (store) =>
            store.nodes.Contractor.create(
              { email: "c1@example.com" },
              { id: "c1-contractor" },
            ),
        );

        const live = requirePostgres();
        const reader = await createGraphStore(live.storeDb);
        expect(await reader.nodes.Contractor.find()).toHaveLength(1);
        // Nothing the refused import wrote is visible: the claim refusal aborts
        // its transaction, which is the honest boundary of "per-row" (the
        // refusal came from a peer's commit, not from this payload).
        expect(await reader.nodes.Employee.find()).toHaveLength(0);
        expect(importRefusal).toContain(STAFF_EMAIL_CONSTRAINT);
        // The refusal names the HOLDER's own kind, not the claim axis.
        expect(importRefusal).toContain("Contractor");
      },
    );

    it(
      "refuses an import moving a node onto a key a store create took inside its claim window",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const setup = await createGraphStore(live.storeDb);
        await setup.nodes.Employee.create(
          { email: "c7-original@example.com" },
          { id: "c7-employee" },
        );

        const { importRefusal } = await raceStoreAgainstParkedImport(
          createGraphStore,
          importPayload([
            {
              kind: "Employee",
              id: "c7-employee",
              properties: { email: "c7-target@example.com" },
            },
          ]),
          (store) =>
            store.nodes.Contractor.create(
              { email: "c7-target@example.com" },
              { id: "c7-contractor" },
            ),
        );

        const reader = await createGraphStore(live.storeDb);
        const holders = [
          ...(await reader.nodes.Employee.find()),
          ...(await reader.nodes.Contractor.find()),
        ].filter((node) => node.email === "c7-target@example.com");
        expect(holders).toHaveLength(1);
        expect(holders[0]?.kind).toBe("Contractor");
        expect(importRefusal).toContain(STAFF_EMAIL_CONSTRAINT);
      },
    );

    it(
      "refuses an import whose id a store create already holds under another kind in one scope",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const { importRefusal } = await raceStoreAgainstParkedImport(
          createGraphStore,
          importPayload([
            {
              kind: "Employee",
              id: "c11-shared",
              properties: { email: "c11@example.com" },
            },
          ]),
          (store) =>
            store.nodes.Contractor.create(
              { email: "c11@example.com" },
              { id: "c11-shared" },
            ),
        );

        const live = requirePostgres();
        const reader = await createGraphStore(live.storeDb);
        expect(await reader.nodes.Contractor.find()).toHaveLength(1);
        expect(await reader.nodes.Employee.find()).toHaveLength(0);

        // One live claim row, still owned by the writer whose node survived:
        // comparing ids alone would have let the import rewrite its owner.
        const claims = await requireDefined(storePool).query(
          "SELECT concrete_kind, node_id FROM typegraph_node_uniques WHERE deleted_at IS NULL",
        );
        expect(claims.rows).toEqual([
          { concrete_kind: "Contractor", node_id: "c11-shared" },
        ]);
        expect(importRefusal).toContain(STAFF_EMAIL_CONSTRAINT);
      },
    );

    it(
      "refuses an import whose id a store create already holds under a DISJOINT kind",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        // C2 and C12. Nothing about these two rows collides at the database
        // level — the nodes primary key is `(graph_id, kind, id)`, and neither
        // kind declares a unique constraint — so before the pair claim existed
        // both writers committed and the graph carried a violation of an axiom
        // it declares. The refusal here can only be the claim's.
        const { importRefusal } = await raceStoreAgainstParkedImport(
          createDisjointStore,
          importPayload([
            {
              kind: "ClaimCompany",
              id: "c12-shared",
              properties: { name: "C" },
            },
          ]),
          (store) =>
            store.nodes.ClaimPerson.create({ name: "P" }, { id: "c12-shared" }),
        );

        const live = requirePostgres();
        const reader = await createDisjointStore(live.storeDb);
        expect(await reader.nodes.ClaimPerson.find()).toHaveLength(1);
        expect(await reader.nodes.ClaimCompany.find()).toHaveLength(0);

        // One live claim row, still owned by the writer whose node survived —
        // C12's half: comparing ids alone would have matched the "already mine"
        // arm of the upsert and flipped `concrete_kind` to the loser's kind.
        const claims = await requireDefined(storePool).query(
          "SELECT concrete_kind, node_id FROM typegraph_node_uniques WHERE deleted_at IS NULL",
        );
        expect(claims.rows).toEqual([
          { concrete_kind: "ClaimPerson", node_id: "c12-shared" },
        ]);

        // And the loser was told the FAMILY's own error, naming both kinds.
        expect(importRefusal).toContain("Disjoint constraint violation");
        expect(importRefusal).toContain("ClaimCompany");
        expect(importRefusal).toContain("ClaimPerson");
      },
    );

    it(
      "resolves two writers contending for the SAME two claim rows without a deadlock",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        // C9b. The two kinds declare their constraints in opposite order, so
        // issuing claims in declaration order would have each writer holding
        // the row the other needs. Canonical order removes the cycle: both take
        // `order_alias` first, and the second writer simply waits for the first
        // to commit and is then refused on the merits.
        //
        // Under a cycle PostgreSQL aborts one leg with `40P01`, which is a
        // different and much worse outcome than a refusal: it destroys the
        // transaction, so an import's per-row recovery becomes a whole-batch
        // abort. Asserting on the ABSENCE of that code is the point of the case.
        const live = requirePostgres();
        const gate = createClaimGate();
        const storeStore = await createOrderStore(live.storeDb, (backend) =>
          backendPausingAfterFirstClaim(backend, gate),
        );
        const importStore = await createOrderStore(live.importDb);

        const storeRun = storeStore.nodes.OrderAliasFirst.create(
          { alias: "c9b-alias", email: "c9b@example.com" },
          { id: "c9b-store" },
        );
        // The store leg now HOLDS its first claim row inside an open
        // transaction.
        await gate.reached;

        const importRun = importGraph(
          importStore,
          {
            formatVersion: FORMAT_VERSION,
            exportedAt: new Date().toISOString(),
            source: { type: "external", description: "claim order" },
            nodes: [
              {
                kind: "OrderEmailFirst",
                id: "c9b-import",
                properties: {
                  alias: "c9b-alias",
                  email: "c9b@example.com",
                },
              },
            ],
            edges: [],
          },
          IMPORT_OPTIONS,
        );
        // Long enough for the import leg to reach its own first claim and block
        // there; the outcome is the same if it has not, so this cannot make the
        // case pass for the wrong reason — it can only make it less pointed.
        await new Promise((resolve) => setTimeout(resolve, 500));
        gate.release();

        const [storeOutcome, importOutcome] = await Promise.allSettled([
          storeRun,
          importRun,
        ]);
        // The whole cause chain, because a driver's `40P01` reaches the caller
        // wrapped: reading only the top message would let a genuine deadlock
        // pass this case as an ordinary query failure.
        const messages = [
          failureChainText(requireDefined(storeOutcome)),
          failureChainText(requireDefined(importOutcome)),
        ].join(" | ");
        expect(messages).not.toContain("40P01");
        expect(messages.toLowerCase()).not.toContain("deadlock");
        // And the loser lost on the MERITS: a typed refusal naming the
        // constraint, not a statement the engine killed.
        expect(messages).toContain("UniquenessError");
        expect(messages).toContain(ORDER_ALIAS_UNIQUE.name);

        // Exactly one winner, and it is the leg that committed.
        const reader = await createOrderStore(live.storeDb);
        expect(await reader.nodes.OrderAliasFirst.find()).toHaveLength(1);
        expect(await reader.nodes.OrderEmailFirst.find()).toHaveLength(0);
      },
    );
  },
);
