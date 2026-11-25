/**
 * The PostgreSQL working copy sends its own statements through an operation of
 * the session of the transaction they run in.
 *
 * An operation's handle is, today, the very transaction object its session
 * holds, so these cases make it distinguishable, as `read-operation-routing`
 * does: `enterOperation` is wrapped so each operation carries its own
 * recording derivation of the transaction. A branch's clone must send its
 * snapshot lock, its copies and its source-version check (recorded as the
 * call itself, with the handle it was given) through the one operation of the
 * session of the source transaction it opens; a durable operation must read
 * its evidence through an operation of the session its own host write enters
 * from (by identity), and write it at pre-commit through an operation of that
 * same session: the store-owned attempt runs its pre-commit hook through the
 * opener's operation.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import type { GraphBackend } from "../../../src/backend/types";
import { branchDurable, operateDurableBranch } from "../../../src/graph-merge";
import * as baseVersion from "../../../src/graph-merge/base-version";
import { unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { renderPostgres } from "../../../src/query/sql-fragment";
import * as operationScope from "../../../src/store/operation-scope";
import { createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "working-copy-operation-routing",
  nodes: { Person: { type: Person } },
  edges: {},
});
type G = typeof graph;

/** One `execute` that went through a recording handle. */
type RoutedStatement = Readonly<{
  session: operationScope.TransactionSession;
  operation: number;
  sql: string;
}>;

/**
 * One source-version check (`compareBaseVersionAtTarget`): the operation
 * it was given, by its handle (`undefined` for any other target), and how many
 * statements had gone through a recording handle when it began.
 */
type VersionCheck = Readonly<{
  operation: number | undefined;
  afterStatements: number;
}>;

type Recording = Readonly<{
  statements: RoutedStatement[];
  /** The session each operation was entered from, by operation number. */
  entered: operationScope.TransactionSession[];
  versionChecks: VersionCheck[];
  restore: () => void;
}>;

/**
 * Wraps the entry mints (`enterOperation`, and `enterTransactionOperation`,
 * which a durable operation enters through) so every operation of a session
 * gets a handle of its own that records each `execute` it carries, rendered,
 * then calls through.
 */
function routeOperationsThroughRecordingHandles(): Recording {
  const statements: RoutedStatement[] = [];
  const entered: operationScope.TransactionSession[] = [];
  const versionChecks: VersionCheck[] = [];
  const operationOfHandle = new Map<object, number>();
  const enterOperation = operationScope.enterOperation;
  const compareBaseVersionAtTarget = baseVersion.compareBaseVersionAtTarget;
  const enterTransactionOperation = operationScope.enterTransactionOperation;
  function recordingEntry(
    entry: operationScope.OperationEntry,
  ): operationScope.OperationEntry {
    const enteredFrom = operationScope.operationEntrySession(entry);
    if (enteredFrom === undefined) return entry;
    const session: operationScope.TransactionSession = enteredFrom;
    const operation = entered.length;
    entered.push(session);
    const transaction = operationScope.operationEntryBackend(
      entry,
    ) as GraphBackend;
    const handle = deriveBackend(transaction, {
      execute: <Row>(query: Parameters<GraphBackend["execute"]>[0]) => {
        statements.push({
          session,
          operation,
          sql: renderPostgres(query).sql,
        });
        return transaction.execute<Row>(query);
      },
    });
    operationOfHandle.set(handle, operation);
    const routed: object = { ...entry, backend: handle };
    return routed as operationScope.OperationEntry;
  }
  const spies = [
    vi
      .spyOn(operationScope, "enterOperation")
      .mockImplementation((scope: operationScope.EntryScope) =>
        recordingEntry(enterOperation(scope)),
      ),
    vi
      .spyOn(operationScope, "enterTransactionOperation")
      .mockImplementation(
        (transaction) =>
          recordingEntry(
            enterTransactionOperation(transaction),
          ) as operationScope.Operation,
      ),
    // The version check reads through members the handle does not record
    // (`getActiveSchema`), so the check itself is recorded with its target.
    vi
      .spyOn(baseVersion, "compareBaseVersionAtTarget")
      .mockImplementation((store, target, expected) => {
        versionChecks.push({
          operation: operationOfHandle.get(target.backend),
          afterStatements: statements.length,
        });
        return compareBaseVersionAtTarget(store, target, expected);
      }),
  ];
  return {
    statements,
    entered,
    versionChecks,
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy operation routing",
  () => {
    let pool: Pool;
    let allocationCounter = 0;

    beforeAll(() => {
      pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
    });
    afterAll(async () => {
      await pool.end();
    });

    function createManager() {
      const control = createPostgresBackend(drizzle(pool));
      const manager = createPostgresWorkingCopyManager<G>({
        control,
        cleanupLockTimeoutMs: 30_000,
        connect: (names, allocation) =>
          Promise.resolve(
            createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
              ...(allocation === undefined ?
                {}
              : { vector: allocation.vectorStrategy }),
            }),
          ),
        operations: {
          graph,
          apply: async (transaction, mutation) => {
            const { name } = z.object({ name: z.string() }).parse(mutation);
            await transaction.nodes.Person.create({ name });
          },
        },
      });
      return { control, manager };
    }

    async function branch(recording?: Recording) {
      const { control, manager } = createManager();
      const [source] = await createStoreWithSchema(graph, control);
      await source.nodes.Person.create({ name: "Ada" });
      allocationCounter += 1;
      if (recording !== undefined) {
        recording.statements.length = 0;
        recording.entered.length = 0;
        recording.versionChecks.length = 0;
      }
      const created = unwrap(
        await branchDurable(source, manager.durable, {
          id: asBranchId(`routing-branch-${allocationCounter}`),
          allocationId: `routing-allocation-${allocationCounter}`,
        }),
      );
      return { manager, created };
    }

    it("a branch's clone sends its statements through the one operation of the session of the source transaction it opens", async () => {
      const recording = routeOperationsThroughRecordingHandles();
      try {
        const { created } = await branch(recording);
        try {
          const locks = recording.statements.filter((statement) =>
            statement.sql.includes("IN SHARE MODE"),
          );
          const copies = recording.statements.filter((statement) =>
            /^INSERT INTO .* SELECT /.test(statement.sql),
          );
          const [lock] = locks;
          const lockAt =
            lock === undefined ? -1 : recording.statements.indexOf(lock);
          const firstCopyAt = recording.statements.findIndex((statement) =>
            copies.includes(statement),
          );
          expect({
            locks: locks.length,
            copied: copies.length > 0,
            // The lock and every copy share the clone's one operation.
            oneOperation: [...locks, ...copies].every(
              (statement) => statement.operation === lock?.operation,
            ),
            // The source-version check runs once under the lock, before
            // copying begins, through that same operation's handle.
            versionChecksUnderTheLock: recording.versionChecks
              .filter(
                (check) =>
                  check.afterStatements > lockAt &&
                  check.afterStatements <= firstCopyAt,
              )
              .map((check) => ({
                throughTheLocksOperation: check.operation === lock?.operation,
              })),
            // That session is the clone's own: it entered nothing else.
            enteredFromItsSession:
              lock === undefined ? 0 : (
                recording.entered.filter(
                  (session) => session === recording.entered[lock.operation],
                ).length
              ),
          }).toEqual({
            locks: 1,
            copied: true,
            oneOperation: true,
            versionChecksUnderTheLock: [{ throughTheLocksOperation: true }],
            enteredFromItsSession: 1,
          });
        } finally {
          await created.branch.close();
        }
      } finally {
        recording.restore();
      }
    });

    it("a durable operation reads its evidence through an operation of the session its host write enters from", async () => {
      const { manager, created } = await branch();
      const recording = routeOperationsThroughRecordingHandles();
      try {
        const outcome = unwrap(
          await operateDurableBranch(created.descriptor, manager.durable, {
            idempotencyKey: "routing-op",
            metadata: {},
            mutation: { name: "Grace" },
          }),
        );
        const evidenceReads = recording.statements.filter(
          (statement) =>
            statement.sql.startsWith("SELECT") &&
            statement.sql.includes("op_evidence"),
        );
        const [read] = evidenceReads;
        const session =
          read === undefined ? undefined : recording.entered[read.operation];
        expect({
          outcome: outcome.outcome,
          evidenceReads: evidenceReads.length,
          // The run's own operation, and the host's create: two operations of
          // ONE session, the transaction's.
          operationsOfThatSession: recording.entered.filter(
            (entered) => entered === session,
          ).length,
          sessions: new Set(recording.entered).size,
        }).toEqual({
          outcome: "applied",
          evidenceReads: 1,
          operationsOfThatSession: recording.entered.length,
          sessions: 1,
        });
        expect(recording.entered.length).toBeGreaterThanOrEqual(2);
        // The evidence row is written at pre-commit through the operation
        // the store-owned attempt runs its pre-commit hook through: one of
        // the host transaction's session.
        expect(
          recording.statements
            .filter(
              (statement) =>
                statement.sql.startsWith("INSERT INTO ") &&
                statement.sql.includes("op_evidence"),
            )
            .map((statement) => ({
              ofTheHostSession: statement.session === session,
            })),
        ).toEqual([{ ofTheHostSession: true }]);
      } finally {
        recording.restore();
        await created.branch.close();
      }
    });
  },
);
