/**
 * A transaction TypeGraph opened never reports success after the database
 * rolled it back.
 *
 * On PostgreSQL, a statement that fails inside a transaction aborts the whole
 * transaction even when the callback catches the error, and the server answers
 * the closing `COMMIT` with a rollback that most drivers report as success. A
 * callback that catches such a failure and returns normally must therefore see
 * its transaction reject with a `TransactionRolledBackError` whose cause is
 * the engine error — never resolve with nothing saved. SQLite keeps the
 * transaction usable after a failed statement, so the same callback commits
 * there, exactly as before.
 *
 * Each case provokes the failure through a different statement path: a write
 * with no application-side pre-check, a read, the callback's native SQL
 * handle, and the retry path, plus a caller savepoint that recovers the
 * session (which must commit everywhere), a read-only transaction, and a
 * history store whose capture flush must not run on an aborted session.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  TransactionRolledBackError,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type GraphBackend, type NodeRow } from "../../../src/backend/types";
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

/** Runs one statement through a callback's native Drizzle handle. */
async function runNative(native: unknown, statement: string): Promise<unknown> {
  const runner = native as NativeStatementRunner;
  const query = drizzleSql.raw(statement);
  if (runner.execute !== undefined) return runner.execute(query);
  if (runner.run !== undefined) return runner.run(query);
  throw new Error("The transaction context exposes no native SQL handle.");
}

/**
 * Runs `statement` inside a savepoint the caller opens on its native handle,
 * and returns its failure after the savepoint rolled back past it. On
 * PostgreSQL that is Drizzle's nested transaction, which every bundled driver
 * implements as a savepoint; SQLite takes the savepoint statements directly.
 */
async function failInsideNativeSavepoint(
  native: unknown,
  dialect: string,
  statement: string,
): Promise<unknown> {
  if (dialect === "postgres") {
    const runner = native as NativeStatementRunner;
    return runner
      .transaction?.((savepoint) => runNative(savepoint, statement))
      .then(
        () => {
          throw new Error("The statement inside the savepoint succeeded.");
        },
        (error: unknown) => error,
      );
  }
  await runNative(native, "SAVEPOINT caller_recovery");
  const failure = await runNative(native, statement).then(
    () => {
      throw new Error("The statement inside the savepoint succeeded.");
    },
    (error: unknown) => error,
  );
  await runNative(native, "ROLLBACK TO SAVEPOINT caller_recovery");
  await runNative(native, "RELEASE SAVEPOINT caller_recovery");
  return failure;
}

/** The same backend, with every transaction's `getNode` failing in the engine. */
function backendWithFailingRead(backend: GraphBackend): GraphBackend {
  return deriveBackend(projectGraphBackend(backend), {
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              getNode: async () => {
                const rows = await target.execute<NodeRow>(
                  asCompiledRowsSql(sql.raw(MISSING_RELATION_SQL)),
                );
                return rows[0];
              },
            }),
          ),
        options,
      ),
  });
}

/**
 * How a transaction settled, reduced to plain data so both lanes share one
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

/** Whether the engine aborts a transaction on a failed statement. */
function abortsOnFailedStatement(dialect: string): boolean {
  return dialect === "postgres";
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
  describe("a transaction the database rolled back never resolves", () => {
    it("rejects after a caught duplicate edge id on PostgreSQL, and commits on SQLite", async () => {
      const errors: unknown[] = [];
      const store = await context.createStore(outcomeGraph, {
        hooks: {
          onError: (_ctx, error) => {
            errors.push(error);
          },
        },
      });
      const aborts = abortsOnFailedStatement(store.backend.dialect);
      const from = await store.nodes.OutcomeNote.create({ body: "from" });
      const to = await store.nodes.OutcomeNote.create({ body: "to" });
      await store.edges.outcomeLink.create(
        from,
        to,
        {},
        {
          id: asEdgeId("outcome-duplicate"),
        },
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
            {
              id: asEdgeId("outcome-duplicate"),
            },
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
        aborts ?
          rolledBack("23505")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-earlier")).toBe(
        aborts ? undefined : "written before the failure",
      );
      // The edge create reports its own failure. On PostgreSQL the buffered
      // node create is then reported once, with the transaction's own error.
      expect(errors.slice(1)).toEqual(aborts ? [rejection] : []);
      expect(errors).toHaveLength(aborts ? 2 : 1);
    });

    it("rejects after a caught failing read on PostgreSQL, and commits on SQLite", async () => {
      const store = await context.createStore(outcomeGraph);
      const aborts = abortsOnFailedStatement(store.backend.dialect);
      const failingReadStore = createStore(
        outcomeGraph,
        backendWithFailingRead(store.backend),
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
        aborts ?
          rolledBack("42P01")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-before-read")).toBe(
        aborts ? undefined : "written before the read",
      );
    });

    it("rejects after a caught failing statement on the native handle on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      const aborts = abortsOnFailedStatement(store.backend.dialect);

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
        aborts ?
          rolledBack("42P01")
        : { kind: "committed", value: "callback returned" },
      );
      expect(await noteBody(store, "outcome-before-native")).toBe(
        aborts ? undefined : "written before the native statement",
      );
    });

    it("commits when the caller's own savepoint rolled back past the failure", async () => {
      const store = await context.createStore(outcomeGraph);

      const outcome = await outcomeOf(
        store.transaction(async (tx) => {
          await tx.nodes.OutcomeNote.create(
            { body: "written before the savepoint" },
            { id: "outcome-before-savepoint" },
          );
          const failure = await failInsideNativeSavepoint(
            nativeHandleOf(tx),
            store.backend.dialect,
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
        value:
          abortsOnFailedStatement(store.backend.dialect) ? "42P01" : undefined,
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
      const aborts = abortsOnFailedStatement(store.backend.dialect);
      const conflictStatement =
        aborts ?
          "DO $$ BEGIN RAISE EXCEPTION 'synthetic conflict' USING ERRCODE = 'serialization_failure'; END $$"
        : "SELECT 1";

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

        expect(outcome).toEqual({ kind: "committed", value: aborts ? 2 : 1 });
        expect(await noteBody(store, `outcome-retry-${handling}-1`)).toBe(
          aborts ? undefined : `${handling} attempt 1`,
        );
        expect(await noteBody(store, `outcome-retry-${handling}-2`)).toBe(
          aborts ? `${handling} attempt 2` : undefined,
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
        aborts ?
          {
            name: "TransactionConflictError",
            causeName: TransactionRolledBackError.name,
            engineCode: "40001",
          }
        : { name: undefined, causeName: undefined, engineCode: undefined },
      );
    });

    it("rejects a read-only transaction after a caught failing read on PostgreSQL", async () => {
      const store = await context.createStore(outcomeGraph);
      await store.nodes.OutcomeNote.create(
        { body: "read me" },
        { id: "outcome-read-only" },
      );
      const failingReadStore = createStore(
        outcomeGraph,
        backendWithFailingRead(store.backend),
      );

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
        abortsOnFailedStatement(store.backend.dialect) ?
          rolledBack("42P01")
        : { kind: "committed", value: "read-only callback returned" },
      );
    });

    it("rejects a history store's transaction before its capture flush, with no receipt", async () => {
      const store = await context.createHistoryStore(outcomeGraph);
      const aborts = abortsOnFailedStatement(store.backend.dialect);
      const from = await store.nodes.OutcomeNote.create({ body: "from" });
      const to = await store.nodes.OutcomeNote.create({ body: "to" });
      await store.edges.outcomeLink.create(
        from,
        to,
        {},
        {
          id: asEdgeId("outcome-history-duplicate"),
        },
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
                {
                  id: asEdgeId("outcome-history-duplicate"),
                },
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
        aborts ?
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
        aborts ? undefined : "captured before the failure",
      );
    });
  });
}
