/**
 * Shared harness for the engine-native recorded-time PostgreSQL SIMULATION.
 *
 * No bundled backend implements `GraphBackend.recordedTime` yet, so this
 * dresses TypeGraph's OWN recorded relations as an engine-native temporal
 * source: `recordedTime.source` folds the `recorded_from <= r < recorded_to`
 * interval into a subquery over the SAME `typegraph_recorded_nodes`/
 * `typegraph_recorded_edges` tables a capturing store on the SAME database
 * writes, and `recordedTime.revisionNow` reads that same clock row. This is
 * an honest stand-in for a real engine's temporal-table AS OF clause, not a
 * scripted fixture: every read this module's scenario runs goes through the
 * real query compiler, the real recorded-read service, the real subgraph/
 * algorithm machinery, and the real base-version anchor derivation, against
 * a real PostgreSQL-family database (PGlite or a server) — only the SOURCE
 * of "what does the engine's temporal table look like" is simulated.
 *
 * Two test files share this module: `pglite-engine-native-recorded-
 * time.test.ts` (always runs, in-process PGlite) and `engine-native-
 * recorded-time.test.ts` (server PostgreSQL, gated on `POSTGRES_URL`,
 * provisioning its own database per docs/TESTING.md). Splitting keeps the
 * PGlite lane on the dedicated `pglite` vitest project — routed by this
 * directory's own `pglite-*.test.ts` glob (`vitest.pglite-project.ts`),
 * with no ratchet edit needed — while the server lane stays on the default
 * project exactly like every other `POSTGRES_URL`-gated suite in this
 * directory. A single file that both boots PGlite directly AND carries a
 * name outside that glob would be exactly the kind of undeclared heavy
 * suite `tests/pglite-project-inventory.test.ts` exists to catch.
 */
import { expect } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
} from "../../../src";
import {
  type EngineRecordedRevision,
  type RecordedSourceTable,
  type RecordedTimeSession,
} from "../../../src/backend/capabilities/recorded-time";
import { createSqlBackend } from "../../../src/backend/drizzle/engine";
import type { AnyPgDatabase } from "../../../src/backend/drizzle/execution/postgres-execution";
import {
  buildPostgresEngineProfile,
  createPostgresBackend,
} from "../../../src/backend/drizzle/postgres";
import {
  createEngineRecordedInstant,
  parseRecordedInstant,
  type RecordedInstant,
  recordedInstantRevision,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import {
  computeBaseVersion,
  engineAnchorOf,
  hasRevisionAnchor,
} from "../../../src/graph-merge/base-version";
import {
  createSqlSchema,
  type SqlSchema,
} from "../../../src/query/compiler/schema";
import { sql, type SqlFragment } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import {
  readRecordedClock,
  recordedRelationsLineage,
} from "../../../src/store/recorded-capture";
import { attachEngineNativeRecordedTime } from "../../engine-native-recorded-time-fixture";

/** Wall time this simulation's `revisionNow` answers before any commit. */
const GENESIS_WALL_TIME = "1970-01-01T00:00:00.000Z";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const knows = defineEdge("knows", { schema: z.object({}) });

const engineNativeSimulationGraph = defineGraph({
  id: "engine_native_pg_simulation",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
  identity: { sameIdAcrossKinds: "fold" },
});

type EngineNativeSimulationGraph = typeof engineNativeSimulationGraph;

/**
 * Translates a TypeGraph-owned (`r1:`) instant into the engine-native
 * (`e1:`) form this simulation's `revisionNow` would have minted for the
 * SAME commit — the one translation this whole scenario needs, since the
 * capturing store and the engine-native store never agree on instant FORM,
 * only on the revision number and wall time underneath it.
 */
function asEngineInstant(instant: RecordedInstant): RecordedInstant {
  return createEngineRecordedInstant(
    String(recordedInstantRevision(instant)),
    recordedInstantWallTime(instant),
  );
}

/**
 * The simulated engine's `recordedTime.source`: dresses TypeGraph's own
 * recorded relation as a temporal-table expression by folding the interval
 * into the source fragment itself, exactly as a real engine-native temporal
 * table would. `predicate` (the `EngineRecordedReadSource` binding
 * `createEngineRecordedReadBinding` builds, `src/query/compiler/schema.ts`)
 * always returns `undefined` for this binding kind, so the interval has
 * nowhere else to go. Graph-id scoping is deliberately NOT folded in here:
 * every read path that reaches `source` already filters by `graph_id` on
 * the alias it assigns the returned fragment (recorded-read-service.ts, the
 * query compiler's joins, recursive-cte.ts), the same way it does for the
 * live tables — this file's parity assertions are the proof.
 */
function simulatedEngineSource(schema: SqlSchema) {
  return function source(
    table: RecordedSourceTable,
    revision: EngineRecordedRevision,
  ): SqlFragment {
    const relation =
      table === "nodes" ? schema.recordedNodesTable
      : table === "edges" ? schema.recordedEdgesTable
      : schema.recordedIdentityAssertionsTable;
    const revisionNumber = Number(revision.revision);
    return sql`(SELECT * FROM ${relation} WHERE recorded_from <= ${revisionNumber} AND ${revisionNumber} < recorded_to)`;
  };
}

/**
 * The simulated engine's `revisionNow`: reads the SAME recorded-clock row
 * TypeGraph's own capture advances, on whatever session it is called with.
 *
 * A plain (non-transactional) session answers that row's revision directly
 * — the engine's current COMMITTED revision, the root-backend half of
 * `EngineRecordedTimeMembers.revisionNow`'s contract. Inside an open,
 * already-written transaction it answers ONE PAST that committed revision
 * instead — the PENDING revision this transaction's own write will land at
 * once it commits, the transaction-handle half of the same contract
 * (`TransactionReceipt.recorded`, stamped from this branch before COMMIT,
 * would otherwise describe the commit BEFORE the one it is attached to).
 * "Inside an open, already-written transaction" is the one fact this
 * simulation cannot read off TypeGraph's own clock row (that row only ever
 * moves on the CAPTURING store's commits, never this store's), so it asks
 * the shared PostgreSQL session directly: `pg_current_xact_id_if_assigned()`
 * is non-null only once the current transaction has performed a write,
 * which is exactly the state both `TransactionReceipt.recorded` call sites
 * are in when they call this member (`Store`'s own doc comment on
 * `#engineRecordedInstant` states the ordering).
 *
 * Answers a genesis revision (never a real committed one — `recorded_from`
 * starts at 1) before the graph's first capturing commit, so `source`'s
 * interval matches no row rather than reading an unpopulated clock as an
 * error.
 */
async function simulatedEngineRevisionNow(
  session: RecordedTimeSession,
  schema: SqlSchema,
  graphId: string,
): Promise<EngineRecordedRevision> {
  const instant = await readRecordedClock(session, schema, graphId);
  const committedRevision =
    instant === undefined ? 0 : recordedInstantRevision(instant);
  const committedWallTime =
    instant === undefined ? GENESIS_WALL_TIME : (
      recordedInstantWallTime(instant)
    );

  const pendingRows = await session.execute<{ pending: unknown }>(
    asCompiledRowsSql(
      sql`SELECT pg_current_xact_id_if_assigned() IS NOT NULL AS pending`,
    ),
  );
  const hasPendingWrite = pendingRows[0]?.pending === true;
  if (!hasPendingWrite) {
    return {
      revision: String(committedRevision),
      recordedAt: committedWallTime,
    };
  }

  return {
    revision: String(committedRevision + 1),
    recordedAt: new Date().toISOString(),
  };
}

export type EngineNativeSimulation = Readonly<{
  capturingStore: HistoryStore<EngineNativeSimulationGraph>;
  engineNativeStore: HistoryStore<EngineNativeSimulationGraph>;
  countRecordedNodes: () => Promise<number>;
}>;

/**
 * Builds the whole simulation over ONE shared database connection: a
 * capturing store (TypeGraph's own recorded-relations ownership) that
 * writes the history, and an engine-native store whose `recordedTime`
 * dresses that SAME database's recorded relations as its own temporal
 * source, with `lineage` set to the real `recordedRelationsLineage` derived
 * from the capturing store — the co-requirement `createSqlBackend` enforces
 * on any backend declaring `recordedTime`. Both stores
 * address the SAME graph id and the SAME live tables: the engine-native
 * store's writes land in the identical `typegraph_nodes`/`typegraph_edges`
 * rows the capturing store reads, and its `lineage` reads the identical
 * `typegraph_recorded_*` rows the capturing store writes.
 */
export async function buildEngineNativeSimulation(
  db: AnyPgDatabase,
): Promise<EngineNativeSimulation> {
  const schema = createSqlSchema();
  const graphId = engineNativeSimulationGraph.id;

  const capturingBackend = createPostgresBackend(db, { vector: false });
  const [capturingStore] = await createStoreWithSchema(
    engineNativeSimulationGraph,
    capturingBackend,
    { history: true },
  );

  const engineProfile = buildPostgresEngineProfile(db, { vector: false });
  attachEngineNativeRecordedTime(
    engineProfile.provisioning,
    {
      source: simulatedEngineSource(schema),
      revisionNow: (session) =>
        simulatedEngineRevisionNow(session, schema, graphId),
    },
    recordedRelationsLineage(capturingStore),
  );
  const engineNativeBackend = createSqlBackend(engineProfile);
  const engineNativeStore = createStore(
    engineNativeSimulationGraph,
    engineNativeBackend,
    { history: true },
  );

  async function countRecordedNodes(): Promise<number> {
    const rows = await capturingBackend.execute<{ count: unknown }>(
      asCompiledRowsSql(sql`
        SELECT COUNT(*) AS count FROM ${schema.recordedNodesTable}
        WHERE graph_id = ${graphId}
      `),
    );
    const raw = rows[0]?.count;
    return raw === undefined ? 0 : Number(raw);
  }

  return { capturingStore, engineNativeStore, countRecordedNodes };
}

/** Total edge count across a `SubgraphResult`'s forward adjacency. */
function totalSubgraphEdgeCount(
  result: Readonly<{
    adjacency: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>;
  }>,
): number {
  let count = 0;
  for (const edgesByKind of result.adjacency.values()) {
    for (const edges of edgesByKind.values()) count += edges.length;
  }
  return count;
}

/**
 * The shared scenario both lanes run: a capturing store writes history, the
 * engine-native store built alongside it (see {@link buildEngineNativeSimulation})
 * reconstructs the SAME answers at the SAME translated instant across every
 * recorded-read surface, its own writes leave the recorded relations
 * untouched, and its base-version anchor is the engine anchor (never a
 * TypeGraph revision anchor), tracking the capturing store's further
 * commits.
 */
export async function runEngineNativeSimulationScenario(
  simulation: EngineNativeSimulation,
): Promise<void> {
  const { capturingStore, engineNativeStore, countRecordedNodes } = simulation;

  // GENESIS: before the graph's first capturing commit, the clock row does
  // not exist yet, so `revisionNow` answers the fixed genesis revision
  // rather than reading an unpopulated clock as an error.
  const genesisInstant = await engineNativeStore.recordedNow();
  if (genesisInstant === undefined) {
    throw new Error(
      "engineNativeStore.recordedNow() must be defined even before the graph's first capturing commit.",
    );
  }
  expect(parseRecordedInstant(genesisInstant).kind).toBe("engine");
  expect(parseRecordedInstant(genesisInstant).revision).toBe("0");
  expect(recordedInstantWallTime(genesisInstant)).toBe(GENESIS_WALL_TIME);

  const alice = await capturingStore.nodes.Person.create({ name: "Alice" });
  const bob = await capturingStore.nodes.Person.create({ name: "Bob" });
  const aliceKnowsBob = await capturingStore.edges.knows.create(alice, bob, {});
  const anchor = await capturingStore.recordedNow();
  if (anchor === undefined) {
    throw new Error(
      "capturingStore.recordedNow() must be defined after a committed write.",
    );
  }
  const engineAnchor = asEngineInstant(anchor);

  // recordedNow() advances with the capturing store's commits, translated.
  expect(await engineNativeStore.recordedNow()).toBe(engineAnchor);

  // A later write the first recorded pin above must NOT see.
  await capturingStore.nodes.Person.update(alice.id, { name: "Alicia" });

  // A second pin taken AFTER that update: a read at it must land on the NEW
  // recorded row rather than the one the update superseded. Reading the
  // FIRST pin only ever exercises the interval fold's LOWER bound (no row
  // this scenario writes is ever read at a pin later than its own
  // supersession) — this second pin is what makes the UPPER bound
  // (`revision < recorded_to`) load-bearing: without it, both alice's
  // original row and its replacement satisfy `recorded_from <= revision`
  // at this pin, and the fold must return exactly the replacement.
  const secondAnchor = await capturingStore.recordedNow();
  if (secondAnchor === undefined) {
    throw new Error(
      "capturingStore.recordedNow() must be defined after a committed write.",
    );
  }
  const engineSecondAnchor = asEngineInstant(secondAnchor);

  // A structural change NEITHER pin above must see, swapping alice's ONLY
  // live edge from bob to a brand-new node: delete alice→bob (its target
  // node stays, only the edge goes) and create alice→carol (a node with no
  // recorded row as of either pin) instead. A recorded read that fell back
  // to the LIVE edges table instead of `recordedTime.source` would then
  // find NO edge out of alice at either pin — carol has no pinned node row
  // to join against, and bob's live edge is gone — diverging from the
  // fixed subgraph/degree/traversal counts the parity assertions below
  // expect. (Adding carol's edge without also deleting alice→bob would not
  // by itself prove this: the extra edge's target node is invisible at
  // either pin regardless of which edges table is read, so subgraph/degree
  // would coincidentally still land on the same counts.)
  await capturingStore.edges.knows.delete(aliceKnowsBob.id);
  const carol = await capturingStore.nodes.Person.create({ name: "Carol" });
  await capturingStore.edges.knows.create(alice, carol, {});

  const capturingView = capturingStore.asOfRecorded(anchor);
  const engineNativeView = engineNativeStore.asOfRecorded(engineAnchor);

  // Point read parity at the first pin.
  const [capturedAlice, nativeAlice] = await Promise.all([
    capturingView.nodes.Person.getById(alice.id),
    engineNativeView.nodes.Person.getById(alice.id),
  ]);
  expect(nativeAlice?.name).toBe("Alice");
  expect(nativeAlice?.name).toBe(capturedAlice?.name);

  // Point read parity at the second pin — proves the interval fold's upper
  // bound, not only its lower one (see the comment where `secondAnchor` was
  // taken).
  const capturingSecondView = capturingStore.asOfRecorded(secondAnchor);
  const engineNativeSecondView =
    engineNativeStore.asOfRecorded(engineSecondAnchor);
  const [capturedAliceSecond, nativeAliceSecond] = await Promise.all([
    capturingSecondView.nodes.Person.getById(alice.id),
    engineNativeSecondView.nodes.Person.getById(alice.id),
  ]);
  expect(nativeAliceSecond?.name).toBe("Alicia");
  expect(nativeAliceSecond?.name).toBe(capturedAliceSecond?.name);

  // store.query(...).asOfRecorded parity.
  const [capturedNames, nativeNames] = await Promise.all([
    capturingView
      .query()
      .from("Person", "person")
      .select((context) => context.person.name)
      .execute(),
    engineNativeView
      .query()
      .from("Person", "person")
      .select((context) => context.person.name)
      .execute(),
  ]);
  expect(nativeNames.toSorted()).toEqual(capturedNames.toSorted());
  expect(nativeNames.toSorted()).toEqual(["Alice", "Bob"]);

  // Subgraph parity.
  const [capturedSubgraph, nativeSubgraph] = await Promise.all([
    capturingView.subgraph(alice.id, { edges: ["knows"] }),
    engineNativeView.subgraph(alice.id, { edges: ["knows"] }),
  ]);
  expect([...nativeSubgraph.nodes.keys()].toSorted()).toEqual(
    [...capturedSubgraph.nodes.keys()].toSorted(),
  );
  expect(totalSubgraphEdgeCount(nativeSubgraph)).toBe(
    totalSubgraphEdgeCount(capturedSubgraph),
  );
  expect(totalSubgraphEdgeCount(nativeSubgraph)).toBe(1);

  // Algorithm parity.
  const [capturedDegree, nativeDegree] = await Promise.all([
    capturingView.algorithms.degree(alice.id),
    engineNativeView.algorithms.degree(alice.id),
  ]);
  expect(nativeDegree).toBe(capturedDegree);
  expect(nativeDegree).toBe(1);

  // Identity-graph traversal parity WITHOUT expanding identity members — the
  // one identity-adjacent surface engine-native recorded reads support (see
  // tests/engine-native-recorded-time.test.ts's "historical identity
  // refusal" describe block for the `includeIdentityMembers: true` surface
  // this deliberately stays clear of).
  const [capturedFriends, nativeFriends] = await Promise.all([
    capturingView
      .query()
      .from("Person", "p")
      .traverse("knows", "e")
      .to("Person", "friend")
      .select((context) => context.friend.id)
      .execute(),
    engineNativeView
      .query()
      .from("Person", "p")
      .traverse("knows", "e")
      .to("Person", "friend")
      .select((context) => context.friend.id)
      .execute(),
  ]);
  expect(nativeFriends).toEqual(capturedFriends);
  expect(nativeFriends).toEqual([bob.id]);

  // The engine-native store's own write writes NO recorded rows, and its
  // receipt is stamped from the PENDING revision `simulatedEngineRevisionNow`
  // mints inside that still-open, already-written transaction — one past
  // the COMMITTED revision `recordedNow()` answers immediately before the
  // write, and never equal to the COMMITTED revision `recordedNow()`
  // answers again immediately after (this write never touches the
  // capturing store's clock, so that value is unchanged across the write).
  const recordedNodesBeforeOwnWrite = await countRecordedNodes();
  const recordedNowBeforeOwnWrite = await engineNativeStore.recordedNow();
  if (recordedNowBeforeOwnWrite === undefined) {
    throw new Error(
      "engineNativeStore.recordedNow() must be defined before the engine-native store's own write.",
    );
  }
  const outcome = await engineNativeStore.transactionWithReceipt(async (tx) => {
    await tx.nodes.Person.create({ name: "Erin" });
  });
  const recordedNodesAfterOwnWrite = await countRecordedNodes();
  const recordedNowAfterOwnWrite = await engineNativeStore.recordedNow();
  if (recordedNowAfterOwnWrite === undefined) {
    throw new Error(
      "engineNativeStore.recordedNow() must be defined after the engine-native store's own write.",
    );
  }
  expect(recordedNodesAfterOwnWrite).toBe(recordedNodesBeforeOwnWrite);
  const receiptRecorded = outcome.receipt.recorded;
  expect(receiptRecorded).toBeDefined();
  if (receiptRecorded === undefined) {
    throw new Error(
      "outcome.receipt.recorded must be defined for a store constructed with { history: true }.",
    );
  }
  expect(parseRecordedInstant(receiptRecorded).kind).toBe("engine");
  expect(recordedNowAfterOwnWrite).toBe(recordedNowBeforeOwnWrite);
  expect(receiptRecorded).not.toBe(recordedNowAfterOwnWrite);
  const receiptRevision = Number(
    parseRecordedInstant(receiptRecorded).revision,
  );
  const beforeRevision = Number(
    parseRecordedInstant(recordedNowBeforeOwnWrite).revision,
  );
  expect(receiptRevision).toBeGreaterThan(beforeRevision);

  // Branch/merge base-version anchoring: the engine anchor, never a
  // TypeGraph revision anchor, tracking the capturing store's own further
  // commits.
  const baseBefore = await computeBaseVersion(engineNativeStore);
  expect(hasRevisionAnchor(baseBefore)).toBe(false);
  expect(engineAnchorOf(baseBefore)).toBeDefined();

  await capturingStore.nodes.Person.create({ name: "Dave" });
  const baseAfter = await computeBaseVersion(engineNativeStore);
  expect(hasRevisionAnchor(baseAfter)).toBe(false);
  expect(baseAfter).not.toBe(baseBefore);
}
