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
 * time-transaction-threading.test.ts` does for `lineage` alone — a plain
 * object literal is not `deriveEngineProfile`'s applicable seam here
 * (`provisioning` is not one of its derivable keys; see that file's own doc
 * comment for why), so this mutates the SAME `provisioning` object in place
 * before handing the profile to `createSqlBackend`. The compile-only cases
 * (the recorded read seam, the identity refusal) need no backend at all and
 * follow `tests/recorded-read-source-seam.test.ts`'s pattern instead.
 */
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
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
import { deriveBackend } from "../src/backend/derive-backend";
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
import { buildKindRegistry } from "../src/registry";
import { resolveLineage } from "../src/store/recorded-capture";
import { storeCaptureEnabled } from "../src/store/runtime-port";
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

const ENGINE_REVISION: EngineRecordedRevision = {
  revision: "engine-r1",
  recordedAt: "2026-01-01T00:00:00.000Z",
};

function scriptedLineage(): LineageMembers {
  return {
    revision: () => Promise.resolve("engine-r0" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" }),
  };
}

/**
 * Attaches BOTH co-required members onto a bundled profile's provisioning
 * object in place — see the module doc for why this, rather than
 * `deriveEngineProfile`, is the sanctioned way to script a bundled profile.
 */
function attachEngineNativeRecordedTime(
  provisioning: object,
  recordedTime: EngineRecordedTimeMembers,
  lineage: LineageMembers,
): void {
  const target = provisioning as {
    recordedTime?: EngineRecordedTimeMembers;
    lineage?: LineageMembers;
  };
  target.recordedTime = recordedTime;
  target.lineage = lineage;
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
   * A receipt was requested but the callback wrote nothing: `revisionNow`
   * must not run, and `receipt.recorded` stays undefined — matching
   * {@link TransactionReceipt.recorded}'s doc comment ("undefined when
   * history capture is off, the transaction is read-only, or no captured
   * writes were flushed") under engine-native ownership too, rather than
   * always stamping an `e1:` instant merely because a receipt was asked
   * for. MUTATION-PROOF: dropping the `receiptRecorder.hasWrites()`
   * conjunct in store.ts's `run()` closure makes this test fail —
   * `outcome.receipt.recorded` becomes a defined `e1:` instant and
   * `observedSessions` gains an entry for a transaction that wrote nothing.
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
