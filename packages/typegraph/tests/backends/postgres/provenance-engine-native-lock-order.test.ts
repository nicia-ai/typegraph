/**
 * Lock order of a graph-lock-taking call made after an ordinary write, on the
 * engine-native recorded-time PostgreSQL profile, with two real sessions on
 * both drivers.
 *
 * On that profile an ordinary node write takes its row lock without the
 * per-graph write lock (TypeGraph captures no history, so there is nothing to
 * serialize). A call that takes the graph lock in the middle of a transaction
 * — `provenance.retract(source, tx)`, `provenance.assertHolds(tx, …)`,
 * `tx.assertUnchangedSince()` — therefore takes it AFTER that row lock, the
 * reverse of the order a concurrent retraction takes them (graph lock, then
 * the source row). The holder updates source A and parks; the contender's
 * own-transaction `retract(A)` takes the graph lock and waits on A's row;
 * the holder then makes its call and waits on the graph lock. PostgreSQL
 * detects the cycle and aborts one of the two, which surfaces as the store's
 * typed, retryable `TransactionConflictError` with the driver's `40P01` as
 * its cause; the other commits.
 *
 * `assertHolds(tx)` and `tx.assertUnchangedSince()` behave the same way on the
 * base branch, so this is a property of the profile, not of the retraction
 * verbs. The documented remedy is pinned too: the same holder making the
 * graph-lock-taking call BEFORE its ordinary write makes the contender wait
 * on the graph lock instead, and both commit.
 *
 * Skipped unless `POSTGRES_URL` is set.
 */
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import { Pool } from "pg";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  TransactionConflictError,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../../src/backend/drizzle/engine";
import type { AnyPgDatabase } from "../../../src/backend/drizzle/execution/postgres-execution";
import { buildPostgresEngineProfile } from "../../../src/backend/drizzle/postgres";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { createRetractionCapability } from "../../../src/provenance";
import { recordedRelationsLineage } from "../../../src/store/recorded-capture";
import type { HistoryStore } from "../../../src/store/store";
import { requireDefined } from "../../../src/utils/presence";
import { attachEngineNativeRecordedTime } from "../../engine-native-recorded-time-fixture";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import {
  type Outcome,
  raceAgainstHeldTransaction,
} from "./held-transaction-race";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CONTENTION_TIMEOUT_MS = 30_000;
const HOLDER_APPLICATION = "provenance-lock-order-holder";
const CONTENDER_APPLICATION = "provenance-lock-order-contender";
const DEADLOCK_DETECTED = "40P01";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Source: { type: Source },
      Fact: { type: Fact },
      Justification: { type: Justification },
    },
    edges: {
      premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
      derives: { type: derives, from: [Justification], to: [Fact] },
    },
  });
}

type LockOrderGraph = ReturnType<typeof buildGraph>;
type LockOrderStore = HistoryStore<LockOrderGraph>;
type LockOrderTransaction = Parameters<
  Parameters<LockOrderStore["transaction"]>[0]
>[0];

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const sourceA = { kind: "Source", id: "source-a" } as const;
const sourceB = { kind: "Source", id: "source-b" } as const;
const sharedFact = { kind: "Fact", id: "shared-fact" } as const;

type Session = Readonly<{
  db: AnyPgDatabase;
  close: () => Promise<void>;
}>;

type Driver = Readonly<{
  name: string;
  open: (applicationName: string) => Session;
}>;

const DRIVERS: readonly Driver[] = [
  {
    name: "node-postgres",
    open(applicationName) {
      const pool = new Pool({
        connectionString: TEST_DATABASE_URL,
        connectionTimeoutMillis: 5000,
        max: 2,
        application_name: applicationName,
      });
      return { db: drizzleNodePostgres(pool), close: () => pool.end() };
    },
  },
  {
    name: "postgres-js",
    open(applicationName) {
      const client = postgres(TEST_DATABASE_URL, {
        max: 2,
        onnotice: () => {
          // Notices are not part of any assertion here.
        },
        connection: { application_name: applicationName },
      });
      return { db: drizzlePostgresJs(client), close: () => client.end() };
    },
  },
];

const openSessions: Session[] = [];
const probes: Pool[] = [];

function openSession(driver: Driver, applicationName: string): Session {
  const session = driver.open(applicationName);
  openSessions.push(session);
  return session;
}

function openProbe(): Pool {
  const probe = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  probes.push(probe);
  return probe;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
  try {
    await pool.query(generatePostgresMigrationSQL());
  } finally {
    await pool.end();
  }
});

afterAll(async () => {
  for (const session of openSessions.splice(0)) await session.close();
  for (const probe of probes.splice(0)) await probe.end();
});

let graphSequence = 0;

/**
 * An engine-native recorded-time store over `session`: the bundled PostgreSQL
 * profile with an engine-owned recorded clock attached, whose ordinary writes
 * take no graph lock. The capturing store that supplies its lineage commits
 * the graph's schema.
 */
async function engineNativeStore(
  graph: LockOrderGraph,
  session: Session,
): Promise<LockOrderStore> {
  const profile = buildPostgresEngineProfile(session.db, { vector: false });
  const capturingProfile = buildPostgresEngineProfile(session.db, {
    vector: false,
  });
  const [capturingStore] = await createStoreWithSchema(
    graph,
    createSqlBackend(capturingProfile),
    { history: true },
  );
  attachEngineNativeRecordedTime(
    profile.provisioning,
    {
      source: () => {
        throw new Error("these cases read no recorded history");
      },
      revisionNow: () =>
        Promise.resolve({
          revision: "0",
          recordedAt: new Date(0).toISOString(),
        }),
    },
    recordedRelationsLineage(capturingStore),
  );
  return createStore(graph, createSqlBackend(profile), { history: true });
}

/** `shared-fact` holds through `source-a` and, independently, `source-b`. */
async function seed(store: LockOrderStore): Promise<void> {
  const a = await store.nodes.Source.create(
    { label: "a", retracted: false },
    { id: sourceA.id },
  );
  const b = await store.nodes.Source.create(
    { label: "b", retracted: false },
    { id: sourceB.id },
  );
  const fact = await store.nodes.Fact.create(
    { label: "shared" },
    { id: sharedFact.id },
  );
  for (const [id, source] of [
    ["via-a", a],
    ["via-b", b],
  ] as const) {
    const justification = await store.nodes.Justification.create(
      { label: id },
      { id },
    );
    await store.edges.premiseOf.create(source, justification, {});
    await store.edges.derives.create(justification, fact, {});
  }
}

/** The graph-lock-taking call a holder makes on its transaction. */
type LockingCall = Readonly<{
  name: string;
  call: (store: LockOrderStore, tx: LockOrderTransaction) => Promise<unknown>;
}>;

const LOCKING_CALLS: readonly LockingCall[] = [
  {
    name: "provenance.retract(source, tx)",
    call: (store, tx) =>
      createRetractionCapability(store, config).retract(sourceB, tx),
  },
  {
    name: "provenance.assertHolds(tx, …)",
    call: (store, tx) =>
      createRetractionCapability(store, config).assertHolds(tx, [sharedFact]),
  },
];

type LockOrderRace = Readonly<{
  holder: Outcome<unknown>;
  contender: Outcome<unknown>;
  contenderState: "settled" | "blocked";
}>;

/** Two engine-native stores of one fresh graph, on the two applications. */
async function holderAndContender(driver: Driver) {
  graphSequence += 1;
  const graph = buildGraph(`provenance_lock_order_${graphSequence}`);
  const holderStore = await engineNativeStore(
    graph,
    openSession(driver, HOLDER_APPLICATION),
  );
  const contenderStore = await engineNativeStore(
    graph,
    openSession(driver, CONTENDER_APPLICATION),
  );
  await seed(holderStore);
  return { holderStore, contenderStore };
}

function writeSourceA(tx: LockOrderTransaction): Promise<unknown> {
  return tx.nodes.Source.update(sourceA.id as never, { label: "edited" });
}

/**
 * The holder makes `call` and an ordinary update of source A in `order`, then
 * parks with its transaction open; once the contender's `retract(A)` has
 * settled or is observed waiting on the holder, the holder makes the
 * remaining step and commits.
 */
async function race(
  driver: Driver,
  locking: LockingCall,
  order: "write-then-call" | "call-then-write",
): Promise<LockOrderRace> {
  const { holderStore, contenderStore } = await holderAndContender(driver);
  const contender = createRetractionCapability(contenderStore, config);

  return raceAgainstHeldTransaction({
    probe: openProbe(),
    holderApplication: HOLDER_APPLICATION,
    contenderApplication: CONTENDER_APPLICATION,
    holder: (holdOpen) =>
      holderStore.transaction(async (tx) => {
        if (order === "write-then-call") {
          await writeSourceA(tx);
          await holdOpen();
          return locking.call(holderStore, tx);
        }
        await locking.call(holderStore, tx);
        await holdOpen();
        return writeSourceA(tx);
      }),
    contender: () => contender.retract(sourceA),
  });
}

/** Whether `error` or an error in its cause chain carries SQLSTATE `code`. */
function carriesSqlState(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code: own, cause } = error as Readonly<{
    code?: unknown;
    cause?: unknown;
  }>;
  return own === code || carriesSqlState(cause, code);
}

/** The typed, retryable conflict the store raises for a detected deadlock. */
function isDeadlockConflict(outcome: Outcome<unknown>): boolean {
  return (
    outcome.status === "error" &&
    outcome.error instanceof TransactionConflictError &&
    carriesSqlState(outcome.error.cause, DEADLOCK_DETECTED)
  );
}

describe.runIf(process.env["POSTGRES_URL"])(
  "graph-lock-taking calls after an ordinary write on engine-native PostgreSQL",
  () => {
    describe.each(DRIVERS)("$name", (driver) => {
      describe.each(LOCKING_CALLS)("$name", (locking) => {
        it(
          "after the write: the contender's retraction waits on the holder's row, the holder's call waits on the contender's graph lock, and PostgreSQL aborts exactly one as a retryable TransactionConflictError",
          { timeout: CONTENTION_TIMEOUT_MS },
          async () => {
            const outcome = await race(driver, locking, "write-then-call");

            expect(outcome.contenderState).toBe("blocked");
            const aborted = [outcome.holder, outcome.contender].filter((side) =>
              isDeadlockConflict(side),
            );
            const committed = [outcome.holder, outcome.contender].filter(
              (side) => side.status === "ok",
            );
            expect(
              { aborted: aborted.length, committed: committed.length },
              `holder: ${outcome.holder.status}, contender: ${outcome.contender.status}`,
            ).toEqual({ aborted: 1, committed: 1 });
          },
        );

        it(
          "before the write (the documented order): the contender waits on the graph lock and both commit",
          { timeout: CONTENTION_TIMEOUT_MS },
          async () => {
            const outcome = await race(driver, locking, "call-then-write");

            expect(outcome.contenderState).toBe("blocked");
            expect(outcome.holder.status).toBe("ok");
            expect(outcome.contender.status).toBe("ok");
          },
        );
      });

      it("tx.assertUnchangedSince() is refused on this profile before any lock, so it takes no part in the cycle", async () => {
        const { holderStore } = await holderAndContender(driver);
        const anchor = requireDefined(
          await holderStore.lineageRevisionNow(),
          "the engine-native fixture mints a lineage anchor",
        );

        const refusal = await holderStore
          .transaction(async (tx) => {
            await writeSourceA(tx);
            await tx.assertUnchangedSince(anchor, [{ nodeKind: "Fact" }]);
          })
          .then(
            () => {
              throw new Error("expected a refusal");
            },
            (error: unknown) => error,
          );

        expect(refusal).toBeInstanceOf(UnsupportedBackendCapabilityError);
        expect(
          (refusal as UnsupportedBackendCapabilityError).details,
        ).toMatchObject({
          operation: "tx.assertUnchangedSince()",
          capability: "graphWriteFence",
        });
      });
    });
  },
);
