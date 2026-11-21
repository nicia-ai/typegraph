/**
 * A transaction TypeGraph opened commits only when it is still the open,
 * healthy transaction TypeGraph began, and says so when it cannot tell.
 *
 * On PostgreSQL, a statement that fails inside a transaction aborts the whole
 * transaction even when the callback catches the error, and the server answers
 * the closing `COMMIT` with a rollback that most drivers report as success. A
 * callback that catches such a failure and returns normally must therefore see
 * its transaction reject with a `TransactionRolledBackError` whose cause is the
 * first engine error — never resolve with nothing saved. A callback that ends
 * the transaction itself through its native handle must see a
 * `TransactionOutcomeUnknownError`, never a retry. Both follow from the
 * backend's declared `commitOutcome` evidence (`"session-marker"`). SQLite
 * (`"statement-scoped"`) keeps the transaction usable after a failed
 * statement, so the same callbacks commit there, exactly as before.
 *
 * Each case provokes the failure through a different statement path — a write
 * with no application-side pre-check, a read, the native SQL handle, a
 * schema preflight — or ends the transaction through the native handle, and
 * pins the retry contract: a rolled-back transaction re-runs when any engine
 * error it observed was a conflict, and a transaction whose outcome is unknown
 * never re-runs.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createAdapterStore,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type GraphBackend,
  type NodeRow,
} from "../../../src/backend/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { type IntegrationTestContext } from "./test-context";

const OutcomeNote = defineNode("OutcomeNote", {
  schema: z.object({ body: z.string() }),
});
const outcomeLink = defineEdge("outcomeLink", {
  schema: z.object({}),
});

const outcomeGraph = defineGraph({
  id: "transaction_commit_outcome",
  nodes: { OutcomeNote: { type: OutcomeNote } },
  edges: {
    outcomeLink: { type: outcomeLink, from: [OutcomeNote], to: [OutcomeNote] },
  },
});

/** A statement every engine refuses: the relation does not exist. */
const MISSING_RELATION_SQL = "SELECT * FROM transaction_outcome_missing_table";

/** A statement PostgreSQL refuses with a serialization failure (40001). */
const POSTGRES_CONFLICT_SQL =
  "DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE = 'serialization_failure'; END $$";

const SQL_STATE = /^[\dA-Z]{5}$/;

/** The SQLSTATE of the first engine error in `error`'s cause chain. */
function engineCodeOf(error: unknown): string | undefined {
  let link: unknown = error;
  for (let depth = 0; depth < 10 && link !== undefined; depth += 1) {
    if (typeof link !== "object" || link === null) return undefined;
    const code: unknown = Reflect.get(link, "code");
    if (typeof code === "string" && SQL_STATE.test(code)) return code;
    link = Reflect.get(link, "cause");
  }
  return undefined;
}

type NativeStatementRunner = Readonly<{
  execute?: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
  run?: (query: ReturnType<typeof drizzleSql.raw>) => Promise<unknown>;
  transaction?: (
    body: (savepoint: NativeStatementRunner) => Promise<unknown>,
  ) => Promise<unknown>;
}>;

/**
 * The native Drizzle handle (`tx.sql`) of an adapter Store's transaction
 * context. The integration Stores are adapter Stores, typed generically here.
 */
function nativeHandleOf(transactionContext: object): unknown {
  return Reflect.get(transactionContext, "sql");
}

/** Runs one query through a callback's native Drizzle handle. */
async function runNativeQuery(
  native: unknown,
  query: ReturnType<typeof drizzleSql.raw>,
): Promise<unknown> {
  const runner = native as NativeStatementRunner;
  if (runner.execute !== undefined) return runner.execute(query);
  if (runner.run !== undefined) return runner.run(query);
  throw new Error("The transaction context exposes no native SQL handle.");
}

function runNative(native: unknown, statement: string): Promise<unknown> {
  return runNativeQuery(native, drizzleSql.raw(statement));
}

/** Settles `promise`, returning its failure, and fails if it succeeded. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("The statement was expected to fail.");
    },
    (error: unknown) => error,
  );
}

/**
 * Runs `statement` inside a savepoint the caller opens on its native handle,
 * and returns its failure after the savepoint rolled back past it. With a
 * session marker (PostgreSQL) that is Drizzle's nested transaction, which
 * every bundled driver implements as a savepoint; SQLite takes the savepoint
 * statements directly.
 */
async function failInsideNativeSavepoint(
  native: unknown,
  usesSessionMarker: boolean,
  statement: string,
): Promise<unknown> {
  if (usesSessionMarker) {
    const runner = native as NativeStatementRunner;
    return failureOf(
      runner.transaction?.((savepoint) => runNative(savepoint, statement)) ??
        Promise.resolve(),
    );
  }
  await runNative(native, "SAVEPOINT caller_recovery");
  const failure = await failureOf(runNative(native, statement));
  await runNative(native, "ROLLBACK TO SAVEPOINT caller_recovery");
  await runNative(native, "RELEASE SAVEPOINT caller_recovery");
  return failure;
}

/**
 * The same backend, with every transaction's `getNode` a managed read that
 * runs `statement` through the transaction's statement queue and finds
 * nothing.
 */
function backendWithReadRunning(
  backend: GraphBackend,
  statement: string,
): GraphBackend {
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              getNode: async (): Promise<NodeRow | undefined> => {
                await target.execute(asCompiledRowsSql(sql.raw(statement)));
                return;
              },
            }),
          ),
        options,
      ),
  });
}

/**
 * {@link backendWithReadRunning} for an adapter backend, whose Store
 * transactions also hand the callback the native `tx.sql` handle.
 */
function adapterBackendWithReadRunning(
  backend: AdapterBackend<unknown>,
  statement: string,
): AdapterBackend<unknown> {
  return deriveBackend(backend, {
    transactionWithNative: (run, options) =>
      backend.transactionWithNative(
        (target, native) =>
          run(
            deriveBackend(target, {
              getNode: async (): Promise<NodeRow | undefined> => {
                await target.execute(asCompiledRowsSql(sql.raw(statement)));
                return;
              },
            }),
            native,
          ),
        options,
      ),
  });
}

/**
 * How a transaction settled, reduced to plain data so every lane shares one
 * assertion: the value it resolved with, or the error it rejected with and the
 * SQLSTATE of the engine error beneath it.
 */
type Outcome =
  | Readonly<{ kind: "committed"; value: unknown }>
  | Readonly<{
      kind: "rejected";
      errorName: string | undefined;
      engineCode: string | undefined;
    }>;

async function outcomeOf(promise: Promise<unknown>): Promise<Outcome> {
  try {
    return { kind: "committed", value: await promise };
  } catch (error) {
    return {
      kind: "rejected",
      errorName: error instanceof Error ? error.name : undefined,
      engineCode: engineCodeOf(error),
    };
  }
}

function rolledBack(engineCode: string): Outcome {
  return {
    kind: "rejected",
    errorName: TransactionRolledBackError.name,
    engineCode,
  };
}

function outcomeUnknown(engineCode?: string): Outcome {
  return {
    kind: "rejected",
    errorName: TransactionOutcomeUnknownError.name,
    engineCode,
  };
}

/**
 * Whether the backend decides its commit from a session marker — on the
 * bundled backends, whether a failed statement aborts the transaction.
 */
function usesSessionMarker(
  backend: Readonly<{ capabilities: BackendCapabilities }>,
): boolean {
  return backend.capabilities.execution.commitOutcome === "session-marker";
}

async function noteBody(
  store: Readonly<{
    nodes: Readonly<{
      OutcomeNote: Readonly<{
        getById: (id: never) => Promise<Readonly<{ body: string }> | undefined>;
      }>;
    }>;
  }>,
  id: string,
): Promise<string | undefined> {
  const note = await store.nodes.OutcomeNote.getById(id as never);
  return note?.body;
}

export function registerTransactionCommitOutcomeIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a transaction commits only while it is the transaction TypeGraph opened", () => {
    it("rejects after a caught duplicate edge id on PostgreSQL, and commits on SQLite", async () => {
      const errors: unknown[] = [];
      const store = await context.createStore(outcomeGraph, {
        hooks: {
          onError: (_ctx, error) => {
            errors.push(error);
          },
        },
      });
      const marked = usesSessionMarker(store.backend);
      const from = await store.nodes.OutcomeNote.create({ body: "from" });
      const to = await store.nodes.OutcomeNote.create({ body: "to" });
      await store.edges.outcomeLink.create(
        from,
        to,
        {},
        { id: asEdgeId("outcome-duplicate") },
      );

      const transaction = store.transaction(async (tx) => {
        await tx.nodes.OutcomeNote.create(
          { body: "written before the failure" },
          { id: "outcome-earlier" },
        );
        await expect(
          tx.edges.outcomeLink.create(
            from,
            to,
            {},
            { id: asEdgeId("outcome-duplicate") },
          ),
        ).rejects.toThrow();
        return "callback returned";
      });
      const outcome = await outcomeOf(transaction);
      const rejection = await transaction.then(
        () => "resolved",
        (error: unknown) => error,
      );

      expect(outcome).toEqual(
        marked ?
          rolledBack("23505")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-earlier")).toBe(
        marked ? undefined : "written before the failure",
      );
      // The edge create reports its own failure. On PostgreSQL the buffered
      // node create is then reported once, with the transaction's own error.
      expect(errors.slice(1)).toEqual(marked ? [rejection] : []);
      expect(errors).toHaveLength(marked ? 2 : 1);
    });

    it("rejects after a caught failing read on PostgreSQL, and commits on SQLite", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const failingReadStore = createStore(
        outcomeGraph,
        backendWithReadRunning(store.backend, MISSING_RELATION_SQL),
      );

      const outcome = await outcomeOf(
        failingReadStore.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the read" },
            { id: "outcome-before-read" },
          );
          await expect(
            tx.nodes.OutcomeNote.getById("outcome-before-read" as never),
          ).rejects.toThrow();
          return "callback returned";
        }),
      );

      expect(outcome).toEqual(
        marked ?
          rolledBack("42P01")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-before-read")).toBe(
        marked ? undefined : "written before the read",
      );
    });

    it("rejects after a caught failing statement on the native handle on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      const outcome = await outcomeOf(
        store.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the native statement" },
            { id: "outcome-before-native" },
          );
          await expect(
            runNative(nativeHandleOf(tx), MISSING_RELATION_SQL),
          ).rejects.toThrow();
          return "callback returned";
        }),
      );

      expect(outcome).toEqual(
        marked ?
          rolledBack("42P01")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-before-native")).toBe(
        marked ? undefined : "written before the native statement",
      );
    });

    it("commits when the caller's own savepoint rolled back past the failure", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      const outcome = await outcomeOf(
        store.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the savepoint" },
            { id: "outcome-before-savepoint" },
          );
          const failure = await failInsideNativeSavepoint(
            nativeHandleOf(tx),
            marked,
            MISSING_RELATION_SQL,
          );
          await tx.nodes.OutcomeNote.create(
            { body: "written after the savepoint" },
            { id: "outcome-after-savepoint" },
          );
          return engineCodeOf(failure);
        }),
      );

      expect(outcome).toEqual({
        kind: "committed",
        value: marked ? "42P01" : undefined,
      });
      expect(await noteBody(store, "outcome-before-savepoint")).toBe(
        "written before the savepoint",
      );
      expect(await noteBody(store, "outcome-after-savepoint")).toBe(
        "written after the savepoint",
      );
    });

    it("still retries a serialization failure, caught or not, under optimistic retry", async () => {
      const store = await context.createStore(outcomeGraph);
      // SQLite has no statement that raises a serialization failure inside a
      // transaction, so there the statement is one that succeeds and the
      // first attempt commits.
      const marked = usesSessionMarker(store.backend);
      const conflictStatement = marked ? POSTGRES_CONFLICT_SQL : "SELECT 1";

      for (const handling of ["propagated", "caught"] as const) {
        let attempts = 0;
        const outcome = await outcomeOf(
          store.transaction(
            async (tx) => {
              attempts += 1;
              await tx.nodes.OutcomeNote.create(
                { body: `${handling} attempt ${attempts}` },
                { id: `outcome-retry-${handling}-${attempts}` },
              );
              if (attempts > 1) return attempts;
              const statement = runNative(
                nativeHandleOf(tx),
                conflictStatement,
              );
              await (handling === "propagated" ? statement : (
                statement.catch(() => "caught")
              ));
              return attempts;
            },
            { retry: { attempts: 2 } },
          ),
        );

        expect(outcome).toEqual({ kind: "committed", value: marked ? 2 : 1 });
        expect(await noteBody(store, `outcome-retry-${handling}-1`)).toBe(
          marked ? undefined : `${handling} attempt 1`,
        );
        expect(await noteBody(store, `outcome-retry-${handling}-2`)).toBe(
          marked ? `${handling} attempt 2` : undefined,
        );
      }

      // With no attempt left, a caught conflict is reported as a conflict
      // whose cause is the rollback, and under it the engine error.
      let exhausted: unknown;
      await store
        .transaction(async (tx) => {
          await runNative(nativeHandleOf(tx), conflictStatement).catch(
            () => "caught",
          );
        })
        .catch((error: unknown) => {
          exhausted = error;
        });
      expect({
        name: exhausted instanceof Error ? exhausted.name : undefined,
        causeName:
          exhausted instanceof Error && exhausted.cause instanceof Error ?
            exhausted.cause.name
          : undefined,
        engineCode: engineCodeOf(exhausted),
      }).toEqual(
        marked ?
          {
            name: "TransactionConflictError",
            causeName: TransactionRolledBackError.name,
            engineCode: "40001",
          }
        : { name: undefined, causeName: undefined, engineCode: undefined },
      );
    });

    it("retries a caught serialization failure even when a later statement fails differently", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const conflictStatement = marked ? POSTGRES_CONFLICT_SQL : "SELECT 1";

      let attempts = 0;
      const outcome = await outcomeOf(
        store.transaction(
          async (tx) => {
            attempts += 1;
            await tx.nodes.OutcomeNote.create(
              { body: `attempt ${attempts}` },
              { id: `outcome-first-failure-${attempts}` },
            );
            if (attempts > 1) return attempts;
            const native = nativeHandleOf(tx);
            await runNative(native, conflictStatement).catch(() => "caught");
            // PostgreSQL parses a statement before it checks for an aborted
            // transaction, so this fails with its own syntax error, not 25P02.
            await runNative(native, "SELEC 1").catch(() => "caught");
            return attempts;
          },
          { retry: { attempts: 2 } },
        ),
      );

      expect(outcome).toEqual({ kind: "committed", value: marked ? 2 : 1 });
      expect(await noteBody(store, "outcome-first-failure-1")).toBe(
        marked ? undefined : "attempt 1",
      );
    });

    it("retries when a queued read's conflict follows a failure a savepoint recovered", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const conflictingReadStore = createAdapterStore(
        outcomeGraph,
        adapterBackendWithReadRunning(
          context.getBackend(),
          marked ? POSTGRES_CONFLICT_SQL : "SELECT 1",
        ),
      );

      let attempts = 0;
      const outcome = await outcomeOf(
        conflictingReadStore.transaction(
          async (tx) => {
            attempts += 1;
            await tx.nodes.OutcomeNote.create(
              { body: `attempt ${attempts}` },
              { id: `outcome-queued-conflict-${attempts}` },
            );
            if (attempts > 1) return attempts;
            await failInsideNativeSavepoint(
              nativeHandleOf(tx),
              marked,
              MISSING_RELATION_SQL,
            );
            // A managed read, queued behind everything the callback sent,
            // that the engine refuses with a serialization failure.
            await tx.nodes.OutcomeNote.getById("anything" as never).catch(
              () => "caught",
            );
            return attempts;
          },
          { retry: { attempts: 2 } },
        ),
      );

      // The recovered 42P01 came first and stays the cause; the conflict
      // after it is what makes the rolled-back attempt worth re-running.
      expect(outcome).toEqual({ kind: "committed", value: marked ? 2 : 1 });
      expect(await noteBody(store, "outcome-queued-conflict-1")).toBe(
        marked ? undefined : "attempt 1",
      );
    });

    it("retries a conflict that follows a caught client-side parameter error, and never makes that error the cause", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const conflictStatement = marked ? POSTGRES_CONFLICT_SQL : "SELECT 1";
      const circular: Record<string, unknown> = {};
      circular["self"] = circular;

      async function failClientSideThenConflict(native: unknown) {
        // The driver cannot serialize the parameter as JSON, so the
        // statement never runs and the transaction stays usable.
        const clientSide = await failureOf(
          runNativeQuery(
            native,
            marked ?
              drizzleSql`SELECT ${circular}::jsonb AS value`
            : drizzleSql`SELECT ${circular} AS value`,
          ),
        );
        expect(engineCodeOf(clientSide)).toBeUndefined();
        await runNative(native, conflictStatement).catch(() => "caught");
      }

      let attempts = 0;
      const outcome = await outcomeOf(
        store.transaction(
          async (tx) => {
            attempts += 1;
            if (attempts === 1) {
              await failClientSideThenConflict(nativeHandleOf(tx));
            }
            return attempts;
          },
          { retry: { attempts: 2 } },
        ),
      );
      expect(outcome).toEqual({ kind: "committed", value: marked ? 2 : 1 });

      // With no attempt left, the cause beneath the rollback is the
      // conflict, the first error that reached the engine.
      const exhausted = await outcomeOf(
        store.transaction(async (tx) => {
          await failClientSideThenConflict(nativeHandleOf(tx));
        }),
      );
      expect(exhausted).toEqual(
        marked ?
          {
            kind: "rejected",
            errorName: "TransactionConflictError",
            engineCode: "40001",
          }
        : { kind: "committed", value: undefined },
      );
    });

    it("never retries after the callback committed through its native handle", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      let attempts = 0;
      const outcome = await outcomeOf(
        store.transaction(
          async (tx) => {
            attempts += 1;
            await tx.nodes.OutcomeNote.create(
              { body: `attempt ${attempts}` },
              { id: `outcome-native-commit-${attempts}` },
            );
            const native = nativeHandleOf(tx);
            if (marked) {
              // A conflict caught and rolled back inside a savepoint: the
              // transaction stays healthy, and the conflict was observed.
              await failInsideNativeSavepoint(
                native,
                marked,
                POSTGRES_CONFLICT_SQL,
              );
            }
            await runNative(native, "COMMIT");
            return attempts;
          },
          { retry: { attempts: 2 } },
        ),
      );

      // The native COMMIT made attempt 1 durable. Re-running the callback
      // would write it twice, so the outcome is reported, never retried.
      expect(attempts).toBe(1);
      expect(await noteBody(store, "outcome-native-commit-1")).toBe(
        "attempt 1",
      );
      // SQLite refuses the closing COMMIT itself with its driver's error.
      expect(marked ? outcome : outcome.kind).toEqual(
        marked ? outcomeUnknown("40001") : "rejected",
      );
    });

    it("reports an unknown outcome after a native ROLLBACK with no failure before it", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      const outcome = await outcomeOf(
        store.transaction(
          async (tx) => {
            await tx.nodes.OutcomeNote.create(
              { body: "written before the native rollback" },
              { id: "outcome-plain-native-rollback" },
            );
            await runNative(nativeHandleOf(tx), "ROLLBACK");
            return "callback returned";
          },
          { retry: { attempts: 2 } },
        ),
      );

      expect(await noteBody(store, "outcome-plain-native-rollback")).toBe(
        undefined,
      );
      expect(marked ? outcome : outcome.kind).toEqual(
        marked ? outcomeUnknown() : "rejected",
      );
    });

    it("reports an unknown outcome, not a rollback, after a caught failure and a native ROLLBACK", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      const outcome = await outcomeOf(
        store.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the native rollback" },
            { id: "outcome-native-rollback" },
          );
          const native = nativeHandleOf(tx);
          await expect(
            runNative(native, MISSING_RELATION_SQL),
          ).rejects.toThrow();
          await runNative(native, "ROLLBACK");
          return "callback returned";
        }),
      );

      expect(await noteBody(store, "outcome-native-rollback")).toBeUndefined();
      // The session left the transaction, so a statement after the ROLLBACK
      // would have run outside it: TypeGraph cannot vouch for the outcome.
      expect(marked ? outcome : outcome.kind).toEqual(
        marked ? outcomeUnknown("42P01") : "rejected",
      );
    });

    it("never commits a transaction the callback opened after a native ROLLBACK", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);

      const outcome = await outcomeOf(
        store.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the native rollback" },
            { id: "outcome-replaced-before" },
          );
          const native = nativeHandleOf(tx);
          await runNative(native, "ROLLBACK");
          // postgres-js refuses a BEGIN outside its own transaction API.
          await runNative(native, "BEGIN").catch(() => "refused");
          return "callback returned";
        }),
      );

      expect(await noteBody(store, "outcome-replaced-before")).toBeUndefined();
      // "statement-scoped" evidence cannot tell the transaction the callback
      // opened from TypeGraph's own, the documented limit on SQLite: what
      // happens next is the driver's (better-sqlite3 commits the new
      // transaction; libsql refuses its closed transaction object).
      expect(marked ? outcome : "either").toEqual(
        marked ? outcomeUnknown() : "either",
      );
    });

    it("rejects a schema-version flip whose preflight caught a failed statement on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const { backend } = store;
      const active = await backend.getActiveSchema(outcomeGraph.id);
      const version = active?.version ?? 1;
      const flip = backend.setActiveVersionWithPreflight;
      if (flip === undefined) {
        throw new Error("The bundled backend has no preflighted flip.");
      }

      const outcome = await outcomeOf(
        flip(
          {
            graphId: outcomeGraph.id,
            expected: { kind: "active", version },
            version,
          },
          async (target) => {
            await target
              .execute(asCompiledRowsSql(sql.raw(MISSING_RELATION_SQL)))
              .catch(() => "caught");
          },
        ).then(() => "flipped"),
      );

      // The flip's own write must not reach the aborted session and surface
      // as a raw 25P02; the rollback is reported with the preflight's error.
      expect(outcome).toEqual(
        marked ? rolledBack("42P01") : { kind: "committed", value: "flipped" },
      );
    });

    it("rejects a schema commit whose preflight caught a failed statement on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const { backend } = store;
      const active = await backend.getActiveSchema(outcomeGraph.id);
      const commit = backend.commitSchemaVersionWithPreflight;
      if (active === undefined || commit === undefined) {
        throw new Error("The bundled backend has no preflighted commit.");
      }
      const nextVersion = active.version + 1;

      const outcome = await outcomeOf(
        commit(
          {
            graphId: outcomeGraph.id,
            expected: { kind: "active", version: active.version },
            version: nextVersion,
            schemaHash: active.schema_hash,
            schemaDoc: JSON.parse(active.schema_doc) as never,
          },
          async (target) => {
            await target
              .execute(asCompiledRowsSql(sql.raw(MISSING_RELATION_SQL)))
              .catch(() => "caught");
          },
        ).then((row) => row.version),
      );

      expect(outcome).toEqual(
        marked ?
          rolledBack("42P01")
        : { kind: "committed", value: nextVersion },
      );
      const activeAfter = await backend.getActiveSchema(outcomeGraph.id);
      expect(activeAfter?.version).toBe(marked ? active.version : nextVersion);
    });

    it("commits a clean read-only transaction, and rejects one after a caught failing read on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      await store.nodes.OutcomeNote.create(
        { body: "read me" },
        { id: "outcome-read-only" },
      );
      const failingReadStore = createStore(
        outcomeGraph,
        backendWithReadRunning(store.backend, MISSING_RELATION_SQL),
      );

      expect(
        await outcomeOf(
          store.transaction(
            async (tx) => {
              const note = await tx.nodes.OutcomeNote.getById(
                "outcome-read-only" as never,
              );
              return note?.body;
            },
            { accessMode: "read_only" },
          ),
        ),
      ).toEqual({ kind: "committed", value: "read me" });

      const outcome = await outcomeOf(
        failingReadStore.transaction(
          async (tx) => {
            await expect(
              tx.nodes.OutcomeNote.getById("outcome-read-only" as never),
            ).rejects.toThrow();
            return "read-only callback returned";
          },
          { accessMode: "read_only" },
        ),
      );

      expect(outcome).toEqual(
        usesSessionMarker(store.backend) ?
          rolledBack("42P01")
        : { kind: "committed", value: "read-only callback returned" },
      );
    });

    it("rejects a history store's transaction before its capture flush, with no receipt", async () => {
      const store = await context.createHistoryStore(outcomeGraph);
      const marked = usesSessionMarker(store.backend);
      const from = await store.nodes.OutcomeNote.create({ body: "from" });
      const to = await store.nodes.OutcomeNote.create({ body: "to" });
      await store.edges.outcomeLink.create(
        from,
        to,
        {},
        { id: asEdgeId("outcome-history-duplicate") },
      );

      const outcome = await outcomeOf(
        store
          .transactionWithReceipt(async (tx) => {
            await tx.nodes.OutcomeNote.create(
              { body: "captured before the failure" },
              { id: "outcome-history-earlier" },
            );
            await expect(
              tx.edges.outcomeLink.create(
                from,
                to,
                {},
                { id: asEdgeId("outcome-history-duplicate") },
              ),
            ).rejects.toThrow();
            return "history callback returned";
          })
          .then(({ result, receipt }) => ({
            result,
            receiptRecorded: receipt.recorded !== undefined,
          })),
      );

      // A capture flush on the aborted session would itself fail with a
      // 25P02; the check runs first and reports the duplicate instead.
      expect(outcome).toEqual(
        marked ?
          rolledBack("23505")
        : {
            kind: "committed",
            value: {
              result: "history callback returned",
              receiptRecorded: true,
            },
          },
      );
      expect(await noteBody(store, "outcome-history-earlier")).toBe(
        marked ? undefined : "captured before the failure",
      );
    });

    it("reports a post-commit hook's failure without calling the committed transaction rolled back", async () => {
      const hookFailure = new Error("onOperationEnd failed");
      const store = await context.createStore(outcomeGraph, {
        hooks: {
          onOperationEnd: () => {
            throw hookFailure;
          },
        },
      });

      const rejection = await store
        .transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "committed before the hook" },
            { id: "outcome-hook-failure" },
          );
        })
        .then(
          () => "resolved",
          (error: unknown) => error,
        );

      // The hook runs after COMMIT: its failure rejects the call, but the
      // write is durable and the rejection is not a rollback.
      expect(rejection).toBe(hookFailure);
      expect(await noteBody(store, "outcome-hook-failure")).toBe(
        "committed before the hook",
      );
    });
  });
}
