/**
 * Provenance support reads on a caller's snapshot-isolated transaction, on a
 * real PostgreSQL server with two sessions, on both drivers.
 *
 * Holding the per-graph write lock excludes concurrent writers; it does not
 * make a session SEE what an earlier holder committed. A REPEATABLE READ
 * transaction keeps the snapshot it took at its first statement, however long
 * it then waits for the lock. On a profile that admits that isolation (here,
 * an engine-native recorded-time store, which TypeGraph's own capture does
 * not police), a retraction, `assertHolds(tx)` or a writable `holding(tx)` on
 * such a transaction would judge support from a graph another session had
 * already changed: a fact supported independently by sources A and B stays
 * live after both retractions commit, and `assertHolds` certifies a fact that
 * no longer holds.
 *
 * Every case drives that sequence with gates and no timers: session 1 opens a
 * REPEATABLE READ transaction and takes its snapshot, session 2 retracts and
 * commits, and only then does session 1 call the capability. The refusal
 * must come from the graph lock's own isolation evidence, before any support
 * read, and leave the transaction usable.
 *
 * Revert checks: drop `refuseWriterBetweenSnapshotAndGraphLock` from the store's
 * `#acquireFreshSnapshotWriteFences` (`src/store/store.ts`) and the retraction
 * case commits with the shared fact still live, and `assertHolds` and
 * `holding(tx)` answer from the stale snapshot. Drop `OWN_TRANSACTION_OPTIONS`
 * from the own-transaction `store.transaction` call in
 * `src/provenance/transition.ts` and session 2's retraction, on a connection
 * whose default isolation is repeatable read, is refused.
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
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createSqlBackend } from "../../../src/backend/drizzle/engine";
import type { AnyPgDatabase } from "../../../src/backend/drizzle/execution/postgres-execution";
import { buildPostgresEngineProfile } from "../../../src/backend/drizzle/postgres";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { createRetractionCapability } from "../../../src/provenance";
import { recordedRelationsLineage } from "../../../src/store/recorded-capture";
import type { HistoryStore } from "../../../src/store/store";
import { createGate, type Gate } from "../../concurrency-utils";
import { attachEngineNativeRecordedTime } from "../../engine-native-recorded-time-fixture";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CONTENTION_TIMEOUT_MS = 30_000;
const REPEATABLE_READ_DEFAULT = "repeatable read";

/** A connection default the drivers accept. */
type DefaultIsolation = typeof REPEATABLE_READ_DEFAULT;

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

type StaleGraph = ReturnType<typeof buildGraph>;

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

/** One statement a session issued, in order. */
type LoggedStatement = Readonly<{ query: string }>;

/** A session: a drizzle database over its own connections, and its log. */
type Session = Readonly<{
  db: AnyPgDatabase;
  statements: LoggedStatement[];
  close: () => Promise<void>;
}>;

type Driver = Readonly<{
  name: string;
  /** `defaultIsolation` sets the connection's default transaction isolation. */
  open: (defaultIsolation?: DefaultIsolation) => Session;
}>;

function statementLogger(statements: LoggedStatement[]) {
  return {
    logQuery(query: string) {
      statements.push({ query });
    },
  };
}

const DRIVERS: readonly Driver[] = [
  {
    name: "node-postgres",
    open(defaultIsolation) {
      const statements: LoggedStatement[] = [];
      const pool = new Pool({
        connectionString: TEST_DATABASE_URL,
        connectionTimeoutMillis: 5000,
        max: 2,
        ...(defaultIsolation === undefined ?
          {}
        : {
            options: `-c default_transaction_isolation=${defaultIsolation.replace(" ", String.raw`\ `)}`,
          }),
      });
      return {
        db: drizzleNodePostgres(pool, {
          logger: statementLogger(statements),
        }),
        statements,
        close: () => pool.end(),
      };
    },
  },
  {
    name: "postgres-js",
    open(defaultIsolation) {
      const statements: LoggedStatement[] = [];
      const client = postgres(TEST_DATABASE_URL, {
        max: 2,
        onnotice: () => {
          // Notices are not part of any assertion here.
        },
        ...(defaultIsolation === undefined ?
          {}
        : { connection: { default_transaction_isolation: defaultIsolation } }),
      });
      return {
        db: drizzlePostgresJs(client, {
          logger: statementLogger(statements),
        }),
        statements,
        close: () => client.end(),
      };
    },
  },
];

const openSessions: Session[] = [];

function openSession(
  driver: Driver,
  defaultIsolation?: DefaultIsolation,
): Session {
  const session = driver.open(defaultIsolation);
  openSessions.push(session);
  return session;
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
});

let graphSequence = 0;

/**
 * An engine-native recorded-time store over `session`: the bundled PostgreSQL
 * profile with an engine-owned recorded clock attached, so a caller's
 * transaction may run at any isolation the server accepts. The capturing
 * store that supplies its lineage commits the graph's schema.
 */
async function engineNativeStore(
  graph: StaleGraph,
  session: Session,
): Promise<HistoryStore<StaleGraph>> {
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
async function seed(store: HistoryStore<StaleGraph>): Promise<void> {
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

/** Whether a statement reads a graph row (a source, or the support graph). */
function readsGraphRow(statement: LoggedStatement): boolean {
  return (
    !statement.query.includes("pg_advisory_xact_lock") &&
    /^\s*select\b/iu.test(statement.query) &&
    /\bfrom\s+"typegraph_(?:nodes|edges)"/iu.test(statement.query)
  );
}

function expectFreshSnapshotRefusal(error: unknown, operation: string): void {
  expect(error).toBeInstanceOf(UnsupportedBackendCapabilityError);
  expect((error as UnsupportedBackendCapabilityError).details).toMatchObject({
    operation,
    capability: "observedReadCommittedIsolation",
    isolation: "repeatable_read",
  });
}

type CallerOutcome = Readonly<{
  refusal: unknown;
  /** Statements session 1 issued inside the refused call. */
  issued: readonly LoggedStatement[];
  /** A read after the refusal: the transaction is still usable. */
  readAfter: boolean;
}>;

/**
 * Session 1 opens a REPEATABLE READ transaction and takes its snapshot;
 * `concurrent` runs on session 2 and commits; then session 1 runs `call` on
 * its transaction. Gates order the three steps; nothing waits on a timer.
 */
async function callOnStaleSnapshot(
  driver: Driver,
  concurrent: (provenance: ReturnType<typeof capabilityOn>) => Promise<unknown>,
  call: (
    provenance: ReturnType<typeof capabilityOn>,
    tx: Parameters<Parameters<HistoryStore<StaleGraph>["transaction"]>[0]>[0],
  ) => Promise<unknown>,
): Promise<
  Readonly<{
    outcome: CallerOutcome;
    observer: ReturnType<typeof capabilityOn>;
  }>
> {
  graphSequence += 1;
  const graph = buildGraph(`provenance_stale_snapshot_${graphSequence}`);
  const staleSession = openSession(driver);
  const writerSession = openSession(driver);
  const staleStore = await engineNativeStore(graph, staleSession);
  const writerStore = await engineNativeStore(graph, writerSession);
  await seed(staleStore);
  const staleProvenance = capabilityOn(staleStore);
  const writerProvenance = capabilityOn(writerStore);

  const snapshotTaken = createGate();
  const concurrentCommitted = createGate();
  const staleTransaction = staleStore.transaction(
    async (tx): Promise<CallerOutcome> => {
      // The snapshot is taken by this transaction's first statement.
      await tx.nodes.Fact.getById(sharedFact.id as never);
      snapshotTaken.open();
      await concurrentCommitted.opened;
      const before = staleSession.statements.length;
      const refusal = await rejectionOf(call(staleProvenance, tx));
      const issued = staleSession.statements.slice(before);
      const readAfter =
        (await tx.nodes.Source.getById(sourceA.id as never)) !== undefined;
      return { refusal, issued, readAfter };
    },
    { isolationLevel: "repeatable_read" },
  );
  const outcome = await afterConcurrentCommit(
    staleTransaction,
    snapshotTaken,
    concurrentCommitted,
    () => concurrent(writerProvenance),
  );
  return { outcome, observer: writerProvenance };
}

/**
 * Runs `concurrent` once the reader has taken its snapshot (or has already
 * settled), then opens `concurrentCommitted` whether `concurrent` succeeded or
 * not, and settles the reader before reporting either failure. A failing
 * writer therefore never leaves the reader parked on the gate with its
 * connection checked out, which would stall teardown and hide the failure.
 */
async function afterConcurrentCommit<T>(
  reader: Promise<T>,
  snapshotTaken: Gate,
  concurrentCommitted: Gate,
  concurrent: () => Promise<unknown>,
): Promise<T> {
  const readerSettled = reader.then(
    () => "settled" as const,
    () => "settled" as const,
  );
  const writer = await rejectionOf(
    (async () => {
      await Promise.race([snapshotTaken.opened, readerSettled]);
      await concurrent();
    })(),
  );
  concurrentCommitted.open();
  const [readerOutcome] = await Promise.allSettled([reader]);
  if (writer !== undefined) throw writer;
  if (readerOutcome.status === "rejected") throw readerOutcome.reason;
  return readerOutcome.value;
}

function capabilityOn(store: HistoryStore<StaleGraph>) {
  return createRetractionCapability(store, config);
}

/** The error `work` rejects with, or `undefined` when it resolves. */
async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Retracts both sources, so `shared-fact` loses all its support. */
function retractBothSources(
  provenance: ReturnType<typeof capabilityOn>,
): Promise<unknown> {
  return provenance.retractMany([sourceA, sourceB]);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "provenance on a caller's stale snapshot (PostgreSQL)",
  () => {
    describe.each(DRIVERS)("$name", (driver) => {
      it(
        "refuses retract(B, tx) on a REPEATABLE READ snapshot that predates another session's committed retract(A), before any support read",
        { timeout: CONTENTION_TIMEOUT_MS },
        async () => {
          const { outcome, observer } = await callOnStaleSnapshot(
            driver,
            (provenance) => provenance.retract(sourceA),
            (provenance, tx) => provenance.retract(sourceB, tx),
          );

          expectFreshSnapshotRefusal(
            outcome.refusal,
            "provenance.retract(source, tx)",
          );
          expect(
            outcome.issued.some((statement) =>
              statement.query.includes("pg_advisory_xact_lock"),
            ),
            "the refusal is judged from the graph lock's own evidence",
          ).toBe(true);
          expect(
            outcome.issued.filter((statement) => readsGraphRow(statement)),
            "no source or support row is read on the stale snapshot",
          ).toEqual([]);
          expect(outcome.readAfter).toBe(true);
          // Only A's retraction committed; the shared fact still holds via B.
          expect(await observer.holding()).toEqual([sharedFact]);
        },
      );

      it(
        "refuses assertHolds(tx) and a writable holding(tx) on a snapshot that predates the retraction killing the fact",
        { timeout: CONTENTION_TIMEOUT_MS },
        async () => {
          const asserted = await callOnStaleSnapshot(
            driver,
            retractBothSources,
            (provenance, tx) => provenance.assertHolds(tx, [sharedFact]),
          );
          expectFreshSnapshotRefusal(
            asserted.outcome.refusal,
            "provenance.assertHolds()",
          );
          expect(
            asserted.outcome.issued.filter((statement) =>
              readsGraphRow(statement),
            ),
          ).toEqual([]);
          expect(asserted.outcome.readAfter).toBe(true);
          expect(await asserted.observer.holding()).toEqual([]);

          const held = await callOnStaleSnapshot(
            driver,
            retractBothSources,
            (provenance, tx) => provenance.holding(tx),
          );
          expectFreshSnapshotRefusal(
            held.outcome.refusal,
            "provenance.holding(tx)",
          );
          expect(
            held.outcome.issued.filter((statement) => readsGraphRow(statement)),
          ).toEqual([]);
          expect(held.outcome.readAfter).toBe(true);
        },
      );

      it(
        "control, passes without the freshness check: answers holding(tx) in a read-only REPEATABLE READ transaction from its one snapshot, so the check must not reach read-only transactions",
        { timeout: CONTENTION_TIMEOUT_MS },
        async () => {
          graphSequence += 1;
          const graph = buildGraph(
            `provenance_stale_snapshot_${graphSequence}`,
          );
          const readerSession = openSession(driver);
          const writerSession = openSession(driver);
          const readerStore = await engineNativeStore(graph, readerSession);
          const writerStore = await engineNativeStore(graph, writerSession);
          await seed(readerStore);
          const reader = capabilityOn(readerStore);
          const writer = capabilityOn(writerStore);

          const snapshotTaken = createGate();
          const concurrentCommitted = createGate();
          const read = readerStore.transaction(
            async (tx) => {
              await tx.nodes.Fact.getById(sharedFact.id as never);
              snapshotTaken.open();
              await concurrentCommitted.opened;
              return reader.holding(tx);
            },
            { isolationLevel: "repeatable_read", accessMode: "read_only" },
          );
          const held = await afterConcurrentCommit(
            read,
            snapshotTaken,
            concurrentCommitted,
            () => writer.retractMany([sourceA, sourceB]),
          );

          // A read-only transaction decides no write: its statements share
          // the one snapshot, so the answer is that snapshot's, consistently.
          expect(held).toEqual([sharedFact]);
          expect(await writer.holding()).toEqual([]);
        },
      );

      it(
        "runs the own-transaction retraction at read committed on a connection whose default is repeatable read",
        { timeout: CONTENTION_TIMEOUT_MS },
        async () => {
          graphSequence += 1;
          const graph = buildGraph(
            `provenance_stale_snapshot_${graphSequence}`,
          );
          const session = openSession(driver, REPEATABLE_READ_DEFAULT);
          const store = await engineNativeStore(graph, session);
          await seed(store);
          const provenance = capabilityOn(store);

          await expect(
            store.transaction((tx) => provenance.retract(sourceA, tx)),
            "the connection's default really is a snapshot isolation",
          ).rejects.toBeInstanceOf(UnsupportedBackendCapabilityError);

          const report = await provenance.retract(sourceA);
          expect(report.died).toEqual([]);
          const second = await provenance.retract(sourceB);
          expect(second.died).toEqual([sharedFact]);
        },
      );
    });
  },
);
