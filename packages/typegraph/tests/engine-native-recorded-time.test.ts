/**
 * Engine-native recorded time: a backend that declares
 * `recordedTime` alongside `lineage` constructs a `history: true` store with
 * no TypeGraph capture at all — no clock, no recorded relations touched —
 * and answers `recordedNow()`/`revisionNow()`/`TransactionReceipt.recorded`
 * from `recordedTime.revisionNow` on the committing session instead.
 *
 * No bundled backend implements `recordedTime` yet (`tests/recorded-time-
 * capability.test.ts`'s own module doc says so), so every store-level case
 * here scripts `EngineRecordedTimeMembers` + `LineageMembers` onto a REAL
 * SQLite profile (`buildSqliteEngineProfile`) the same way `tests/recorded-
 * time-transaction-threading.test.ts` does for `lineage` alone, through the
 * shared `attachEngineNativeRecordedTime` fixture (`./engine-native-
 * recorded-time-fixture`) — a plain object literal is not
 * `deriveEngineProfile`'s applicable seam here (`provisioning` is not one
 * of its derivable keys; see that file's own doc comment for why), so this
 * mutates the SAME `provisioning` object in place before handing the
 * profile to `createSqlBackend`. The compile-only cases (the recorded read
 * seam, the identity refusal) need no backend at all and follow `tests/
 * recorded-read-source-seam.test.ts`'s pattern instead.
 */
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  defineEdge,
  defineGraph,
  defineNode,
  migrateLegacyRecordedTime,
  recordedRelation,
} from "../src";
import {
  type EngineRecordedRevision,
  type EngineRecordedTimeMembers,
} from "../src/backend/capabilities/recorded-time";
import { isEngineNativeRecordedReadBinding } from "../src/backend/capabilities/recorded-time-ownership";
import {
  deriveBackend,
  deriveTransactionSessionBackend,
} from "../src/backend/derive-backend";
import { createSqlBackend } from "../src/backend/drizzle/engine";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import {
  type EngineRevision,
  type GraphBackend,
  type LineageMembers,
  type TransactionBackend,
} from "../src/backend/types";
import {
  createEngineRecordedInstant,
  createRecordedInstant,
} from "../src/core/temporal";
import { ConfigurationError } from "../src/errors";
import { MergePlanCapabilityError } from "../src/graph-merge/errors";
import { planMerge } from "../src/graph-merge/merge";
import { createQueryBuilder } from "../src/query/builder";
import { compileQuery } from "../src/query/compiler";
import {
  createEngineRecordedReadBinding,
  createRecordedReadBinding,
  createSqlSchema,
} from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledStatementSql } from "../src/query/sql-intent";
import { buildKindRegistry } from "../src/registry";
import { resolveLineage } from "../src/store/recorded-capture";
import { storeCaptureEnabled } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import { attachEngineNativeRecordedTime } from "./engine-native-recorded-time-fixture";
import { toSqlString } from "./sql-test-utils";
import { createTestBackend, matchingObject } from "./test-utils";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const Widget = defineNode("Widget", {
  schema: z.object({ label: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "engine_native_recorded_time",
  nodes: { Widget: { type: Widget } },
  edges: { knows: { type: knows, from: [Widget], to: [Widget] } },
});

// A separate node/graph, scoped to the `getOrCreateByConstraint` receipt
// case below: the uniqueness constraint that case needs is irrelevant (and
// a small collision risk) for every other case in this file, which all
// share `graph`/`Widget` freely.
const UniqueWidget = defineNode("UniqueWidget", {
  schema: z.object({ label: z.string() }),
});
const uniqueGraph = defineGraph({
  id: "engine_native_recorded_time_unique",
  nodes: {
    UniqueWidget: {
      type: UniqueWidget,
      unique: [
        {
          name: "label_key",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

// A separate node/graph, scoped to the identity-only receipt case below:
// `store.identity` exists only when `defineGraph` declares `identity`, and
// a cross-kind fold needs two node kinds neither `graph` nor `uniqueGraph`
// carries.
const PersonRecord = defineNode("PersonRecord", {
  schema: z.object({ name: z.string() }),
});
const AuthorRecord = defineNode("AuthorRecord", {
  schema: z.object({ penName: z.string() }),
});
const identityGraph = defineGraph({
  id: "engine_native_recorded_time_identity",
  nodes: {
    PersonRecord: { type: PersonRecord },
    AuthorRecord: { type: AuthorRecord },
  },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const ENGINE_REVISION: EngineRecordedRevision = {
  revision: "engine-r1",
  recordedAt: "2026-01-01T00:00:00.000Z",
};

async function captureConfigurationError(
  promise: Promise<unknown>,
): Promise<ConfigurationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ConfigurationError) return error;
    throw error;
  }
  throw new Error("Expected ConfigurationError");
}

function scriptedLineage(): LineageMembers {
  return {
    revision: () => Promise.resolve("engine-r0" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" }),
  };
}

/**
 * Builds an engine-native backend over a fresh in-memory SQLite database,
 * with `revisionNow` scripted to record every session it is called with and
 * always answer {@link ENGINE_REVISION}. Returns the raw driver handle too,
 * so a case can assert directly against it that no recorded row was written.
 */
function createEngineNativeBackend(
  observedSessions: TransactionBackend[],
): Readonly<{
  backend: GraphBackend;
  lineage: LineageMembers;
  sqlite: RealDatabase.Database;
}> {
  const sqlite = new RealDatabase(":memory:");
  cleanups.push(() => {
    sqlite.close();
  });
  const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
    executionProfile: { isSync: true },
  });
  const lineage = scriptedLineage();
  const recordedTime: EngineRecordedTimeMembers = {
    source: (table) => sql.raw(`__engine_native_${table}__`),
    revisionNow: (session) => {
      observedSessions.push(session as TransactionBackend);
      return Promise.resolve(ENGINE_REVISION);
    },
  };
  attachEngineNativeRecordedTime(profile.provisioning, recordedTime, lineage);
  return { backend: createSqlBackend(profile), lineage, sqlite };
}

/**
 * Wraps an engine-native backend's committing session so every
 * `lockSchemaVersionForWrite` acquisition on it is counted, regardless of
 * which object identity (raw `txBackend` or the mutation witness's wrapped
 * `writeTarget`) a caller reaches it through — used by the schema-fence
 * leasing regression below.
 */
function countingUniqueGraphBackend(): Readonly<{
  backend: GraphBackend;
  schemaFenceCalls: () => number;
}> {
  const { backend } = createEngineNativeBackend([]);
  let calls = 0;
  const observingBackend = deriveBackend(backend, {
    transaction: (fn, options) =>
      backend.transaction((tx) => {
        const lockSchemaVersionForWrite = requireDefined(
          tx.lockSchemaVersionForWrite,
        );
        const countingTx = deriveTransactionSessionBackend(tx, {
          lockSchemaVersionForWrite: (params) => {
            calls += 1;
            return lockSchemaVersionForWrite(params);
          },
        });
        return fn(countingTx);
      }, options),
  });
  return { backend: observingBackend, schemaFenceCalls: () => calls };
}

describe("engine-native recorded time: construction", () => {
  it("constructs with { history: true } and skips TypeGraph capture entirely", () => {
    const { backend } = createEngineNativeBackend([]);
    const store = createStore(graph, backend, { history: true });

    expect(store.recordedTimeOwnership).toBe("engine-native");
    expect(store.recordedReadBound).toBe(true);
    // The public `historyEnabled` answers "was `history: true` requested,"
    // true under EITHER ownership form — a `HistoryStore<G>`'s static
    // `historyEnabled: true` must match this at runtime.
    expect(store.historyEnabled).toBe(true);
    // `storeCaptureEnabled` is the distinct, internal flag for "does
    // TypeGraph's own capture run" — false here, since the engine tracks
    // history on its own and none of TypeGraph's recorded relations are
    // ever populated.
    expect(storeCaptureEnabled(store)).toBe(false);
    // The backend's own engine anchor applies for graph-merge base tokens,
    // not the TypeGraph revision-anchor path.
    expect(store.revisionTrackingEnabled).toBe(false);
  });

  /**
   * `assertHistorySchemaOnOpen` (the async open path's history-schema check)
   * used to gate on `options.history === true` alone, so it probed for
   * TypeGraph's own recorded relations on a database that — under
   * engine-native ownership — never has any, refusing every engine-native
   * `history: true` open with `RECORDED_SCHEMA_INCOMPATIBLE`. It must gate
   * on TypeGraph OWNERSHIP instead (`resolveRecordedTimeOwnership(backend)
   * === "typegraph-relations"`), through the one existing owner of that
   * derivation.
   *
   * The bundled migration provisions the recorded relations unconditionally
   * (they exist even on an engine-native store's database, simply unused),
   * so this drops them after the first boot to reach the scenario the check
   * actually guards against: a database whose recorded relations were
   * dropped. Both async open paths that reach the check —
   * `createStoreWithSchema` and `createVerifiedStore`, on the SAME
   * already-bootstrapped database so the second open needs no separate
   * base-schema install — must open an engine-native store over it.
   * MUTATION-PROOF: restoring the old `options?.history !== true` gate
   * (dropping the ownership check) makes both opens below throw
   * `RECORDED_SCHEMA_INCOMPATIBLE` instead of resolving.
   */
  it("opens through both async store-opening paths on a database whose recorded relations were dropped", async () => {
    const { backend } = createEngineNativeBackend([]);
    await createStoreWithSchema(graph, backend, { history: true });
    const schema = createSqlSchema(backend.tableNames);
    if (backend.executeStatement === undefined) {
      throw new Error("SQLite test backend must execute statements");
    }
    for (const table of [
      schema.recordedNodesTable,
      schema.recordedEdgesTable,
      schema.recordedClockTable,
    ]) {
      await backend.executeStatement(
        asCompiledStatementSql(sql`DROP TABLE ${table}`),
      );
    }

    const [schemaStore] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    expect(schemaStore.recordedTimeOwnership).toBe("engine-native");

    const [verifiedStore] = await createVerifiedStore(graph, backend, {
      history: true,
    });
    expect(verifiedStore.recordedTimeOwnership).toBe("engine-native");
  });

  /**
   * The negative control on the SAME scenario as the case above: dropping
   * the recorded relations from a TypeGraph-OWNED store's database must
   * still refuse both async open paths, proving the ownership gate above
   * narrows the refusal to engine-native rather than disabling it.
   */
  it("still refuses both async store-opening paths for a TypeGraph-owned store over the same kind of database", async () => {
    const backend = createTestBackend();
    await createStoreWithSchema(graph, backend, { history: true });
    const schema = createSqlSchema(backend.tableNames);
    if (backend.executeStatement === undefined) {
      throw new Error("SQLite test backend must execute statements");
    }
    for (const table of [
      schema.recordedNodesTable,
      schema.recordedEdgesTable,
      schema.recordedClockTable,
    ]) {
      await backend.executeStatement(
        asCompiledStatementSql(sql`DROP TABLE ${table}`),
      );
    }

    const schemaOpenError = await captureConfigurationError(
      createStoreWithSchema(graph, backend, { history: true }),
    );
    expect(schemaOpenError.details["code"]).toBe(
      "RECORDED_SCHEMA_INCOMPATIBLE",
    );

    const verifiedOpenError = await captureConfigurationError(
      createVerifiedStore(graph, backend, { history: true }),
    );
    expect(verifiedOpenError.details["code"]).toBe(
      "RECORDED_SCHEMA_INCOMPATIBLE",
    );
  });

  it("refuses revisionTracking: true without history", () => {
    const { backend } = createEngineNativeBackend([]);

    let thrown: unknown;
    try {
      createStore(graph, backend, { revisionTracking: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "ENGINE_NATIVE_REVISION_TRACKING_UNSUPPORTED",
    );
  });

  /**
   * `revisionTracking: true` must refuse under engine-native REGARDLESS of
   * `history`, not only in its absence: this backend has no TypeGraph clock
   * for the option to advance either way, and the engine's own revision only
   * ever surfaces through `history: true` on its own. MUTATION-PROOF:
   * widening the guard's condition back to `requestedRevisionTracking &&
   * !requestedHistory` makes this test fail — construction succeeds and
   * `store.revisionTrackingEnabled` reads back `false`, an accepted option
   * silently dropped rather than refused.
   */
  it("refuses revisionTracking: true even when history: true is also requested", () => {
    const { backend } = createEngineNativeBackend([]);

    let thrown: unknown;
    try {
      createStore(graph, backend, { history: true, revisionTracking: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "ENGINE_NATIVE_REVISION_TRACKING_UNSUPPORTED",
    );
  });

  it("refuses an externally bound recordedRead relation, with or without history", () => {
    const { backend } = createEngineNativeBackend([]);
    const external = recordedRelation({ schema: createSqlSchema() });

    let withoutHistory: unknown;
    try {
      createStore(graph, backend, { recordedRead: external });
    } catch (error) {
      withoutHistory = error;
    }
    expect(withoutHistory).toBeInstanceOf(ConfigurationError);
    expect((withoutHistory as ConfigurationError).details["code"]).toBe(
      "ENGINE_NATIVE_RECORDED_READ_UNSUPPORTED",
    );
  });

  it("resolveLineage(store) returns the backend's own lineage, never the recorded-relations one", () => {
    const { backend, lineage } = createEngineNativeBackend([]);
    const store = createStore(graph, backend, { history: true });

    expect(resolveLineage(store)).toBe(lineage);
  });

  it("migrateLegacyRecordedTime refuses on an engine-native backend", async () => {
    const { backend } = createEngineNativeBackend([]);

    let thrown: unknown;
    try {
      await migrateLegacyRecordedTime({ backend });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "ENGINE_NATIVE_MIGRATE_RECORDED_TIME_UNSUPPORTED",
    );
  });
});

describe("engine-native recorded time: transaction receipts", () => {
  it("stamps an e1: receipt from revisionNow on the committing transaction handle, and writes no recorded rows", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend, sqlite } = createEngineNativeBackend(observedSessions);

    let observedTxBackend: TransactionBackend | undefined;
    const observingBackend = deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => {
          observedTxBackend = tx;
          return fn(tx);
        }, options),
    });

    const [store] = await createStoreWithSchema(graph, observingBackend, {
      history: true,
    });
    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.create({ label: "hello" });
    });

    expect(outcome.receipt.recorded).toBe(
      createEngineRecordedInstant(
        ENGINE_REVISION.revision,
        ENGINE_REVISION.recordedAt,
      ),
    );
    expect(observedSessions).toHaveLength(1);
    // revisionNow ran on the SAME committing session the transaction handed
    // the callback — not the root backend. MUTATION-PROOF: pass
    // `this.#backend` instead of `txBackend` to `#engineRecordedInstant` in
    // store.ts's `run()` closure and this assertion fails, since the only
    // session this test ever observes then is the root object.
    expect(observedSessions[0]).toBe(observedTxBackend);

    const recordedNodeCount = sqlite
      .prepare("SELECT COUNT(*) AS count FROM typegraph_recorded_nodes")
      .get() as { count: number };
    expect(recordedNodeCount.count).toBe(0);
  });

  /**
   * `revisionNow`'s contract (`EngineRecordedTimeMembers`'s own doc comment)
   * is session-dependent: on the still-open committing transaction handle it
   * must answer with the PENDING revision that transaction's writes will
   * land at once it commits, never the last one already committed before it
   * opened. This scripted engine answers differently for the two sessions it
   * can be called with, so the receipt can only carry the pending marker if
   * store.ts actually calls `revisionNow` on the transaction handle rather
   * than, say, the root backend after commit. MUTATION-PROOF: passing
   * `this.#backend` (the root) instead of `txBackend` to
   * `#engineRecordedInstant` in store.ts's `run()` closure makes this test
   * fail — `outcome.receipt.recorded` would carry `COMMITTED_REVISION`
   * instead of `PENDING_REVISION`.
   */
  it("carries the transaction's own pending revision, not the last committed one, in the receipt", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    const lineage = scriptedLineage();
    const COMMITTED_REVISION: EngineRecordedRevision = {
      revision: "engine-committed-r1",
      recordedAt: "2026-01-01T00:00:00.000Z",
    };
    const PENDING_REVISION: EngineRecordedRevision = {
      revision: "engine-pending-r2",
      recordedAt: "2026-01-01T00:00:01.000Z",
    };
    let observedTxBackend: TransactionBackend | undefined;
    const recordedTime: EngineRecordedTimeMembers = {
      source: (table) => sql.raw(`__engine_native_${table}__`),
      revisionNow: (session) =>
        Promise.resolve(
          session === observedTxBackend ? PENDING_REVISION : COMMITTED_REVISION,
        ),
    };
    attachEngineNativeRecordedTime(profile.provisioning, recordedTime, lineage);
    const rootBackend = createSqlBackend(profile);
    const observingBackend = deriveBackend(rootBackend, {
      transaction: (fn, options) =>
        rootBackend.transaction((tx) => {
          observedTxBackend = tx;
          return fn(tx);
        }, options),
    });

    const [store] = await createStoreWithSchema(graph, observingBackend, {
      history: true,
    });
    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.create({ label: "hello" });
    });

    expect(outcome.receipt.recorded).toBe(
      createEngineRecordedInstant(
        PENDING_REVISION.revision,
        PENDING_REVISION.recordedAt,
      ),
    );
  });

  it("does not call revisionNow when no receipt was requested", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    await store.transaction(async (tx) => {
      await tx.nodes.Widget.create({ label: "hello" });
    });

    expect(observedSessions).toHaveLength(0);
  });

  /**
   * `#buildTransactionContext` runs every write in a receipted engine-native
   * transaction through the mutation witness's wrapped session
   * (`writeTarget`), so `withTransactionSchemaFenceLease` and
   * `withWriteTransactionSession` must key their lease/session maps on that
   * SAME wrapped object — they key on object identity, and a write issued
   * through the wrapper resolves nothing under a lease the raw `txBackend`
   * registered under. Two constrained creates in one `transactionWithReceipt`
   * call must therefore take exactly ONE `lockSchemaVersionForWrite`
   * acquisition — the second create's `hasLeasedSchemaFence` check must see
   * the first create's lease, matching a plain `store.transaction()` with no
   * receipt requested at all (asserted immediately below as the positive
   * control). MUTATION-PROOF: passing the raw `txBackend` (instead of
   * `writeTarget`) to `withTransactionSchemaFenceLease` and
   * `withWriteTransactionSession` in store.ts's `run()` closure makes the
   * receipted count assertion fail — two acquisitions instead of one, since
   * the lease registered under the raw target is invisible to a write issued
   * through the wrapped one.
   */
  it("leases the schema fence once across two constrained creates in a receipted engine-native transaction", async () => {
    // Positive control: a plain `store.transaction()` (no receipt, so the
    // mutation witness never wraps anything) already leases the fence once
    // across both constrained creates — this is the behavior the receipted
    // case below must match.
    const plain = countingUniqueGraphBackend();
    const [plainStore] = await createStoreWithSchema(
      uniqueGraph,
      plain.backend,
      { history: true },
    );
    await plainStore.transaction(async (tx) => {
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "plain-first",
      });
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "plain-second",
      });
    });
    expect(plain.schemaFenceCalls()).toBe(1);

    const receipted = countingUniqueGraphBackend();
    const [receiptedStore] = await createStoreWithSchema(
      uniqueGraph,
      receipted.backend,
      { history: true },
    );
    await receiptedStore.transactionWithReceipt(async (tx) => {
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "receipted-first",
      });
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "receipted-second",
      });
    });
    expect(receipted.schemaFenceCalls()).toBe(1);
  });

  /**
   * A receipt was requested but the callback wrote nothing: `revisionNow`
   * must not run, and `receipt.recorded` stays undefined — matching
   * {@link TransactionReceipt.recorded}'s doc comment ("undefined when
   * history capture is off, the transaction is read-only, or no captured
   * writes were flushed") under engine-native ownership too, rather than
   * always stamping an `e1:` instant merely because a receipt was asked
   * for. MUTATION-PROOF: reverting store.ts's `run()` closure to build
   * `recordedByGraph` from `receiptRecorder?.snapshot().writes.total !== 0`
   * instead of the mutation witness makes this test fail too (an empty
   * callback still leaves `writes.total` at `0`, so this particular case is
   * a weaker check than the three below — see that block's own doc comment
   * for the mutation-proof that actually distinguishes the two).
   */
  it("stamps no recorded instant for a receipt requested on a no-op transaction", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    const outcome = await store.transactionWithReceipt(async () => {
      // Intentionally empty: no collection write.
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(outcome.receipt.writes.total).toBe(0);
    expect(observedSessions).toHaveLength(0);
  });

  /**
   * The three collection calls that always count as a write INTENT (the
   * collection-level counters `receipt.writes` is built from) even when
   * nothing changed: a delete of a missing id (`executeNodeDelete` gates on
   * existence before ever calling `backend.deleteNode`, so the collection
   * method resolves having called no write member at all), a
   * `getOrCreateByConstraint` that finds the row (`action: "found"` — its
   * intent counter fires the same whether it created or found, since the
   * count is pinned before the call resolves), and a
   * `coalesceUnchangedUpserts`-skipped upsert (the write pipeline never
   * calls any backend write member at all). Each must leave
   * `receipt.recorded` undefined and take no `revisionNow` round trip.
   * MUTATION-PROOF for all three: reverting the two `store.ts` receipt sites
   * from the mutation witness back to
   * `receiptRecorder?.snapshot().writes.total !== 0` makes every case below
   * fail — `receipt.recorded` becomes a defined `e1:` instant and
   * `observedSessions` gains an entry for a transaction that changed no row,
   * since the collection surface still counts each of these as a write
   * intent.
   */
  it("stamps no recorded instant for a delete of a missing id", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.delete("missing-id" as never);
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(0);
  });

  it("stamps no recorded instant when getOrCreateByConstraint finds the row already occupied", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(uniqueGraph, backend, {
      history: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.UniqueWidget.getOrCreateByConstraint("label_key", {
        label: "w1",
      });
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      const result = await tx.nodes.UniqueWidget.getOrCreateByConstraint(
        "label_key",
        { label: "w1" },
      );
      expect(result.action).toBe("found");
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(baselineSessions);
  });

  it("stamps no recorded instant for a coalesced unchanged upsert", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
      coalesceUnchangedUpserts: true,
    });
    await store.transaction(async (tx) => {
      await tx.nodes.Widget.upsertById("w1", { label: "same" });
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.nodes.Widget.upsertById("w1", { label: "same" });
    });

    expect(outcome.receipt.recorded).toBeUndefined();
    expect(observedSessions).toHaveLength(baselineSessions);
  });

  /**
   * Identity assertions bypass `buildRecordedWriteMembers`'s overlay
   * entirely — `withRecordedIdentityMutationTarget` resolves the mutation
   * witness through the WeakMap binding `registerRecordedIdentityMutationWitness`
   * installs in store.ts, not through a wrapped write member. MUTATION-PROOF:
   * reverting `withRecordedIdentityMutationTarget` (`recorded-capture.ts`) to
   * read off a binding never registered for an engine-native transaction — or
   * removing the `registerRecordedIdentityMutationWitness` call at either
   * store.ts receipt site — makes this test fail: `receipt.recorded` comes
   * back `undefined` and `observedSessions` gains no entry, even though the
   * identity assertion committed.
   */
  it("stamps a recorded instant for a transaction whose only write is an identity assertion", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(identityGraph, backend, {
      history: true,
    });
    const person = await store.nodes.PersonRecord.create({ name: "Ada" });
    const author = await store.nodes.AuthorRecord.create({
      penName: "A. Lovelace",
    });
    const baselineSessions = observedSessions.length;

    const outcome = await store.transactionWithReceipt(async (tx) => {
      await tx.identity.assertSame(person, author);
    });

    expect(outcome.receipt.writes.identity.total).toBe(1);
    expect(outcome.receipt.recorded).toBe(
      createEngineRecordedInstant(
        ENGINE_REVISION.revision,
        ENGINE_REVISION.recordedAt,
      ),
    );
    expect(observedSessions).toHaveLength(baselineSessions + 1);
  });
});

describe("engine-native recorded time: revisionNow", () => {
  /**
   * `revisionNow()` is another consumer of `#engineRecordedInstant`,
   * alongside `recordedNow()` and the two transaction-commit sites — gating
   * it on `#revisionTrackingEnabled`
   * alone (forced false under engine-native, since the engine anchor
   * applies instead) left it answering `undefined` even under `history:
   * true`. MUTATION-PROOF: removing the `#engineNativeHistory` branch here
   * (restoring the bare `if (!this.#revisionTrackingEnabled) return
   * undefined;` gate) makes this test fail with `undefined` instead of the
   * `e1:` instant.
   */
  it("answers from recordedTime.revisionNow on the root backend, like recordedNow", async () => {
    const observedSessions: TransactionBackend[] = [];
    const { backend } = createEngineNativeBackend(observedSessions);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    const revision = await store.revisionNow();

    expect(revision).toBe(
      createEngineRecordedInstant(
        ENGINE_REVISION.revision,
        ENGINE_REVISION.recordedAt,
      ),
    );
    expect(revision).toBe(await store.recordedNow());
  });

  /**
   * Declared deviation: `revisionTrackingEnabled` stays false under
   * engine-native ownership (the backend's own engine anchor applies
   * instead of the TypeGraph revision-anchor path), and public merge planning's
   * capability gate (`assertPublicPlanCapability`, `graph-merge/merge.ts`)
   * checks exactly that flag, not `revisionNow()`'s availability. Fixing
   * `revisionNow()` above does not lift this refusal — extending public
   * merge-plan capability to the engine-anchor path is a graph-merge
   * decision for the step that actually exercises engine-native branch/
   * merge, not this one. Pinned here so that step inherits an explicit,
   * tested starting point rather than a silent gap.
   */
  it("still refuses a public merge plan (revisionTrackingEnabled stays false)", async () => {
    const { backend } = createEngineNativeBackend([]);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });

    const result = await planMerge(store, []);

    expect(result.success).toBe(false);
    const { error } = result as Readonly<{ success: false; error: unknown }>;
    expect(error).toBeInstanceOf(MergePlanCapabilityError);
  });
});

describe("engine-native recorded time: asOfRecorded ownership", () => {
  it("refuses an r1: (TypeGraph-owned) instant", () => {
    const { backend } = createEngineNativeBackend([]);
    const store = createStore(graph, backend, { history: true });
    const typeGraphInstant = createRecordedInstant(
      1,
      "2026-01-01T00:00:00.000Z",
    );

    let thrown: unknown;
    try {
      store.asOfRecorded(typeGraphInstant);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "RECORDED_INSTANT_OWNERSHIP_MISMATCH",
    );
  });

  it("accepts an e1: (engine-native) instant", () => {
    const { backend } = createEngineNativeBackend([]);
    const store = createStore(graph, backend, { history: true });
    const engineInstant = createEngineRecordedInstant(
      "engine-r1",
      "2026-01-01T00:00:00.000Z",
    );

    expect(() => store.asOfRecorded(engineInstant)).not.toThrow();
  });

  it("a TypeGraph-owned (typegraph-relations) store refuses an e1: instant symmetrically", () => {
    const store = createStore(graph, createTestBackend(), { history: true });
    const engineInstant = createEngineRecordedInstant(
      "engine-r1",
      "2026-01-01T00:00:00.000Z",
    );

    let thrown: unknown;
    try {
      store.asOfRecorded(engineInstant);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "RECORDED_INSTANT_OWNERSHIP_MISMATCH",
    );
  });
});

describe("engine-native recorded time: recorded read seam (compile-only)", () => {
  it("asOfRecorded(e1) sources rows through recordedTime.source, with no interval", () => {
    const schema = createSqlSchema();
    const marker = "__engine_native_marked_nodes__";
    const binding = createEngineRecordedReadBinding(
      {
        source: (table) =>
          table === "nodes" ? sql.raw(marker) : sql.raw(`other_${table}`),
        revisionNow: () => Promise.resolve(ENGINE_REVISION),
      },
      schema,
    );
    const registry = buildKindRegistry(graph);
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Widget", "widget")
      .select((context) => context.widget.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "e1:engine-r1:2026-01-01T00:00:00.000Z",
    };

    const compiled = compileQuery(ast, graph.id, {
      dialect: "sqlite",
      schema,
      recordedReadBinding: binding,
    });
    const text = toSqlString(compiled, "sqlite");

    expect(text).toContain(marker);
    expect(text).not.toContain(schema.tables.recordedNodes);
    expect(text).not.toContain("recorded_from");
    expect(text).not.toContain("recorded_to");
  });

  it("still emits the interval for TypeGraph's own recorded relation binding, unchanged", () => {
    const schema = createSqlSchema();
    const registry = buildKindRegistry(graph);
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Widget", "widget")
      .select((context) => context.widget.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "r1:0000000000000001:2026-01-01T00:00:00.000Z",
    };

    const compiled = compileQuery(ast, graph.id, {
      dialect: "sqlite",
      schema,
      recordedReadBinding: createRecordedReadBinding(schema),
    });
    const text = toSqlString(compiled, "sqlite");

    expect(text).toContain(schema.tables.recordedNodes);
    expect(text).toContain("recorded_from");
    expect(text).toContain("recorded_to");
  });
});

describe("engine-native recorded time: live point read and scan", () => {
  /**
   * `recordedTime.source` dresses the LIVE nodes/edges tables as the
   * engine's recorded source (a stand-in for a real temporal-table
   * expression, sufficient here since the point is proving the read paths
   * work against a source with no `recorded_from`/`recorded_to` columns —
   * exactly what an engine-native source looks like). `predicate` returns
   * `undefined`, matching every engine-native binding.
   */
  // Deliberately far in the future, not `ENGINE_REVISION`'s fixed past
  // instant: the diagonal `asOfRecorded` read pins valid-time to the
  // anchor's wall-time component, so it must postdate the write this test
  // makes at the real wall clock for the created row to still be valid-time
  // current at the anchor.
  const LIVE_REVISION: EngineRecordedRevision = {
    revision: "engine-live",
    recordedAt: "2030-01-01T00:00:00.000Z",
  };

  function liveTableDressedRecordedTime(): EngineRecordedTimeMembers {
    return {
      source: (table) => {
        if (table === "nodes") return sql.raw("typegraph_nodes");
        if (table === "edges") return sql.raw("typegraph_edges");
        return sql.raw("typegraph_identity_assertions");
      },
      revisionNow: () => Promise.resolve(LIVE_REVISION),
    };
  }

  /**
   * `recordedGetByIds`/`recordedScan` (`src/store/recorded-read-service.ts`)
   * order recorded point reads/scans by `recorded_from` for a TypeGraph-
   * relation-backed binding, a column an engine-native source's live-table
   * stand-in does not have. MUTATION-PROOF: restore the unconditional
   * `ORDER BY ${aliasSql}.recorded_from` (point read) / `ORDER BY
   * ${aliasSql}.id ASC, ${aliasSql}.recorded_from ASC` (scan) this test
   * guards, and both assertions below fail with a SQLite "no such column:
   * recorded_from" error instead of returning the created node.
   */
  it("nodeGetById and node scan reconstruct a live row through the engine-native source", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    attachEngineNativeRecordedTime(
      profile.provisioning,
      liveTableDressedRecordedTime(),
      scriptedLineage(),
    );
    const backend = createSqlBackend(profile);
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const widget = await store.nodes.Widget.create({ label: "hello" });
    const anchor = createEngineRecordedInstant(
      LIVE_REVISION.revision,
      LIVE_REVISION.recordedAt,
    );
    const view = store.asOfRecorded(anchor);

    const byId = await view.nodes.Widget.getById(widget.id);
    expect(byId?.label).toBe("hello");

    const scanned = await view.nodes.Widget.scan();
    expect(scanned.data.map((node) => node.id)).toEqual([widget.id]);
  });
});

describe("engine-native recorded time: historical identity refusal", () => {
  const Person = defineNode("Person", {
    schema: z.object({ name: z.string() }),
  });
  const link = defineEdge("link", { schema: z.object({}) });
  const identityGraph = defineGraph({
    id: "engine_native_recorded_time_identity",
    nodes: { Person: { type: Person } },
    edges: { link: { type: link, from: [Person], to: [Person] } },
    identity: { sameIdAcrossKinds: "fold" },
  });

  /**
   * Pins the single predicate the two refusal sites below now share
   * (`isEngineNativeRecordedReadBinding`,
   * `backend/capabilities/recorded-time-ownership.ts`) instead of each
   * re-spelling the "is this engine-native" decision independently — the
   * query compiler's historical identity traversal used to test
   * `ctx.recordedReadBinding?.kind === "engine-native"` inline, and
   * `Store.identityAtCoordinate` used to test `this.#recordedTimeOwnership
   * === "engine-native"` inline. MUTATION-PROOF: changing this function's
   * body to `return false;` makes this test fail, along with BOTH refusal
   * tests below (`view.identity` builds a facade instead of throwing, and
   * `compileQuery` no longer throws) — one shared owner, not three copies
   * that happen to agree.
   */
  it("isEngineNativeRecordedReadBinding answers true only for the engine-native binding kind", () => {
    const schema = createSqlSchema();
    expect(isEngineNativeRecordedReadBinding(undefined)).toBe(false);
    expect(
      isEngineNativeRecordedReadBinding(createRecordedReadBinding(schema)),
    ).toBe(false);
    expect(
      isEngineNativeRecordedReadBinding(recordedRelation({ schema })),
    ).toBe(false);
    expect(
      isEngineNativeRecordedReadBinding(
        createEngineRecordedReadBinding(
          {
            source: (table) => sql.raw(`__engine_native_${table}__`),
            revisionNow: () => Promise.resolve(ENGINE_REVISION),
          },
          schema,
        ),
      ),
    ).toBe(true);
  });

  it("refuses a recorded coordinate that expands identity members under an engine-native binding", () => {
    const schema = createSqlSchema();
    const binding = createEngineRecordedReadBinding(
      {
        source: (table) => sql.raw(`__engine_native_${table}__`),
        revisionNow: () => Promise.resolve(ENGINE_REVISION),
      },
      schema,
    );
    const registry = buildKindRegistry(identityGraph);
    const query = createQueryBuilder<typeof identityGraph>(
      identityGraph.id,
      registry,
    )
      .from("Person", "person")
      .traverse("link", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .to("Person", "friend")
      .select((context) => context.friend.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "e1:engine-r1:2026-01-01T00:00:00.000Z",
    };

    let thrown: unknown;
    try {
      compileQuery(ast, identityGraph.id, {
        dialect: "sqlite",
        schema,
        identitySameIdAcrossKinds: "fold",
        recordedReadBinding: binding,
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).details["code"]).toBe(
      "ENGINE_NATIVE_RECORDED_IDENTITY_UNSUPPORTED",
    );
  });

  /**
   * The `Store.identityAtCoordinate` guard itself (`store.ts`), not just the
   * query-compiler entry point above: `store.asOfRecorded(anchor).identity`
   * is the public path a caller actually reaches this through.
   * MUTATION-PROOF: deleting the `recordedAsOf !== undefined &&
   * isEngineNativeRecordedReadBinding(this.#recordedReadBinding)` guard
   * block in `identityAtCoordinate` makes this test fail (`.identity`
   * builds the facade instead of throwing) while every other case in this
   * file still passes, since none of them reads `identity` on an
   * engine-native store.
   */
  it("refuses identityAtCoordinate itself for a recorded coordinate on an engine-native store", async () => {
    const { backend } = createEngineNativeBackend([]);
    const [store] = await createStoreWithSchema(identityGraph, backend, {
      history: true,
    });
    const anchor = createEngineRecordedInstant(
      ENGINE_REVISION.revision,
      ENGINE_REVISION.recordedAt,
    );
    const view = store.asOfRecorded(anchor);

    expect(() => view.identity).toThrow(ConfigurationError);
    expect(() => view.identity).toThrow(
      matchingObject({
        details: matchingObject({
          code: "ENGINE_NATIVE_RECORDED_IDENTITY_UNSUPPORTED",
        }),
      }),
    );
  });

  it("still compiles the historical identity CTE for TypeGraph's own recorded relation binding, unchanged", () => {
    const schema = createSqlSchema();
    const registry = buildKindRegistry(identityGraph);
    const query = createQueryBuilder<typeof identityGraph>(
      identityGraph.id,
      registry,
    )
      .from("Person", "person")
      .traverse("link", "edge", {
        expand: "none",
        includeIdentityMembers: true,
      })
      .to("Person", "friend")
      .select((context) => context.friend.id);
    const ast = {
      ...query.toAst(),
      recordedAsOf: "r1:0000000000000001:2026-01-01T00:00:00.000Z",
    };

    const compiled = compileQuery(ast, identityGraph.id, {
      dialect: "sqlite",
      schema,
      identitySameIdAcrossKinds: "fold",
      recordedReadBinding: createRecordedReadBinding(schema),
    });
    const text = toSqlString(compiled, "sqlite");

    expect(text).toContain("identity_peer_class");
  });
});
