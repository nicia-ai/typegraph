/**
 * TypeGraph leaves a caller's transaction settings as it found them.
 *
 * A few TypeGraph units change a PostgreSQL setting for themselves with
 * `set_config(name, value, true)`: an iterative algorithm's `workingMemory`
 * (`work_mem`), the working-copy ledger's cleanup bound (`lock_timeout`), and
 * allocation provisioning's schema pin (`search_path`). Such a change lasts
 * until the end of the transaction it runs in. On a backend built over a
 * caller's transaction the unit runs in a savepoint, and `RELEASE SAVEPOINT`
 * keeps it, so the caller would go on under TypeGraph's value.
 *
 * Every case runs in a caller's native transaction with its own `work_mem`
 * and `lock_timeout`, calls TypeGraph through a backend built over that
 * transaction, and reads the three settings back on the same transaction
 * after the call has succeeded or its failure has been caught. Each case
 * rolls the caller's transaction back at the end, so the working copies it
 * provisions leave nothing behind. The cases on a transaction TypeGraph opens
 * itself pin that the unit adds no statement there.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphDef,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { GraphAlgorithmConvergenceError } from "../../../src/errors-entry";
import { computeBaseVersion } from "../../../src/graph-merge/base-version";
import { BranchError } from "../../../src/graph-merge/errors";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import type { IntegrationTestContext } from "./test-context";

const SettingPerson = defineNode("SettingPerson", {
  schema: z.object({ name: z.string() }),
});
const settingKnows = defineEdge("settingKnows", { schema: z.object({}) });

let graphCounter = 0;

function buildGraph() {
  graphCounter += 1;
  return defineGraph({
    id: `transaction_local_settings_${graphCounter}`,
    nodes: { SettingPerson: { type: SettingPerson } },
    edges: {
      settingKnows: {
        type: settingKnows,
        from: [SettingPerson],
        to: [SettingPerson],
      },
    },
  });
}

type SettingGraph = ReturnType<typeof buildGraph>;

type Settings = Readonly<{
  work_mem: string;
  lock_timeout: string;
  search_path: string;
}>;

type SkipContext = Readonly<{ skip: (note?: string) => never }>;

type CapturedStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

/** The caller's own values, neither of them a server default. */
const CALLER_WORK_MEM = "5MB";
const CALLER_LOCK_TIMEOUT = "7s";

async function readSettings(session: TransactionBackend): Promise<Settings> {
  const [row] = await session.execute<Settings>(
    asCompiledRowsSql(
      sql`SELECT current_setting('work_mem') AS work_mem, current_setting('lock_timeout') AS lock_timeout, current_setting('search_path') AS search_path`,
    ),
  );
  return requireDefined(row);
}

async function run(
  session: TransactionBackend,
  statement: ReturnType<typeof sql>,
): Promise<readonly Record<string, unknown>[]> {
  return session.execute(asCompiledRowsSql(statement));
}

/**
 * A backend over `base` whose transactions record every statement TypeGraph
 * issues through them. The transaction is derived, so whatever the base
 * recorded about it still holds for the derived one.
 */
function capturing(base: GraphBackend): Readonly<{
  backend: GraphBackend;
  statements: CapturedStatement[];
}> {
  const compileSql = requireDefined(base.compileSql);
  const statements: CapturedStatement[] = [];
  const backend = deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction(
        (transaction) =>
          fn(
            deriveBackend(transaction, {
              execute: (query) => {
                statements.push(compileSql(query));
                return transaction.execute(query);
              },
              executeTemporaryStatement: async (query) => {
                statements.push(compileSql(query));
                await requireDefined(transaction.executeTemporaryStatement)(
                  query,
                );
              },
            }),
          ),
        options,
      ),
  });
  return { backend, statements };
}

function statementsNaming(
  statements: readonly CapturedStatement[],
  setting: string,
): readonly CapturedStatement[] {
  return statements.filter(
    (statement) =>
      statement.sql.includes("set_config") &&
      (statement.sql.includes(`'${setting}'`) ||
        statement.params.includes(setting)),
  );
}

const ROLLBACK = new Error("roll the caller's transaction back");

function requirePostgres(
  context: IntegrationTestContext,
  ctx: SkipContext,
): AdapterBackend<unknown> {
  const backend = context.getBackend();
  if (backend.dialect !== "postgres") {
    ctx.skip("transaction-local settings are a PostgreSQL facility");
  }
  return backend;
}

/**
 * Runs `body` in a caller's native transaction that has set its own
 * `work_mem` and `lock_timeout`, hands it a backend over that transaction,
 * and rolls the transaction back afterwards.
 */
async function inCallerTransaction<T>(
  root: AdapterBackend<unknown>,
  body: (
    caller: TransactionBackend,
    overCaller: (
      options?: Parameters<typeof createPostgresBackend>[1],
    ) => GraphBackend,
  ) => Promise<T>,
): Promise<T> {
  const outcome: { value?: T } = {};
  await root
    .transactionWithNative(async (caller, native) => {
      await run(
        caller,
        sql`SELECT set_config('work_mem', ${CALLER_WORK_MEM}, true), set_config('lock_timeout', ${CALLER_LOCK_TIMEOUT}, true)`,
      );
      outcome.value = await body(caller, (options) =>
        createPostgresBackend(native as never, options),
      );
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
  return outcome.value as T;
}

async function seededStore(backend: GraphBackend, graph: SettingGraph) {
  const [store] = await createStoreWithSchema(graph, backend);
  const [alpha, beta, gamma] = await Promise.all([
    store.nodes.SettingPerson.create({ name: "alpha" }),
    store.nodes.SettingPerson.create({ name: "beta" }),
    store.nodes.SettingPerson.create({ name: "gamma" }),
  ]);
  await store.edges.settingKnows.create(alpha, beta, {});
  await store.edges.settingKnows.create(beta, gamma, {});
  return store;
}

function managerOver<G extends GraphDef>(
  control: GraphBackend,
  overCaller: (
    options?: Parameters<typeof createPostgresBackend>[1],
  ) => GraphBackend,
  connect?: () => Promise<GraphBackend>,
): PostgresWorkingCopyManager<G> {
  return createPostgresWorkingCopyManager<G>({
    control,
    connect: (names) =>
      connect?.() ??
      Promise.resolve(
        overCaller({ vector: false, tables: createPostgresTables(names) }),
      ),
  });
}

/** The error `promise` rejects with, or undefined when it fulfils. */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

export function registerTransactionLocalSettingIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Transaction-local settings on a caller's transaction", () => {
    describe("an iterative algorithm's workingMemory", () => {
      it("restores the caller's work_mem after the call, reading it in the statement that sets it", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const { backend, statements } = capturing(overCaller());
            const store = await seededStore(backend, buildGraph());
            const before = await readSettings(caller);
            statements.length = 0;
            const ranks = await store.algorithms.pageRank({
              edges: ["settingKnows"],
              workingMemory: "48MB",
            });
            return {
              before,
              after: await readSettings(caller),
              ranked: ranks.length,
              workMemStatements: statementsNaming(statements, "work_mem").map(
                (statement) => ({
                  readsPrior: statement.sql.includes("current_setting"),
                  setsRequested: statement.params.includes("48MB"),
                }),
              ),
            };
          },
        );

        expect(observed.before.work_mem).toBe(CALLER_WORK_MEM);
        expect(observed.after).toEqual(observed.before);
        expect(observed.ranked).toBe(3);
        // One statement applies the override and returns the prior value; one
        // restores it. No separate probe of the prior value.
        expect(observed.workMemStatements).toEqual([
          { readsPrior: true, setsRequested: true },
          { readsPrior: false, setsRequested: false },
        ]);
      });

      it("leaves the caller's work_mem after a caught failure, on a usable transaction", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const store = await seededStore(overCaller(), buildGraph());
            const before = await readSettings(caller);
            const failure = await failureOf(
              store.algorithms.weaklyConnectedComponents({
                edges: ["settingKnows"],
                maxIterations: 1,
                workingMemory: "48MB",
              }),
            );
            return { before, after: await readSettings(caller), failure };
          },
        );

        expect(observed.failure).toBeInstanceOf(GraphAlgorithmConvergenceError);
        expect(observed.after).toEqual(observed.before);
      });

      // Two algorithms started together on one caller transaction run their
      // savepoint units on one session whose statements are serialized one at
      // a time, not unit by unit, so their apply and restore statements can
      // interleave. That is the session hazard of overlapping units on a
      // caller transaction, which main has for every unit; it is pinned here
      // at the value it produces, not fixed.
      it("two algorithms started together on a caller transaction", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const store = await seededStore(overCaller(), buildGraph());
            const outcomes = await Promise.allSettled([
              store.algorithms.pageRank({
                edges: ["settingKnows"],
                workingMemory: "48MB",
              }),
              store.algorithms.pageRank({
                edges: ["settingKnows"],
                workingMemory: "64MB",
              }),
            ]);
            return {
              outcomes: outcomes.map((outcome) => outcome.status),
              workMemRestored: await readSettings(caller).then(
                (settings) => settings.work_mem === CALLER_WORK_MEM,
              ),
            };
          },
        );

        expectObservation({
          lane: { driver: context.driver },
          observed,
          correct: {
            outcomes: ["fulfilled", "fulfilled"],
            workMemRestored: true,
          },
          defects: [
            {
              label: "overlapping savepoint units on a caller transaction",
              on: { driver: ["pglite", "node-postgres", "postgres-js"] },
              // One unit reads the other's value as its prior and restores it
              // last (on PGlite the first call's 48MB survives).
              today: {
                outcomes: ["fulfilled", "fulfilled"],
                workMemRestored: false,
              },
            },
          ],
        });
      });

      it("adds no statement on a transaction TypeGraph opens", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const { backend, statements } = capturing(root);
        const store = await seededStore(backend, buildGraph());
        statements.length = 0;
        await store.algorithms.weaklyConnectedComponents({
          edges: ["settingKnows"],
          workingMemory: "48MB",
        });

        expect(
          statementsNaming(statements, "work_mem").map((statement) => ({
            readsPrior: statement.sql.includes("current_setting"),
            setsRequested: statement.params.includes("48MB"),
          })),
        ).toEqual([{ readsPrior: false, setsRequested: true }]);
      });
    });

    describe("a working-copy manager over a caller's transaction", () => {
      it("restores lock_timeout after listUnsealedAllocations", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const manager = managerOver(
              overCaller({ vector: false }),
              overCaller,
            );
            const before = await readSettings(caller);
            const listed = await manager.listUnsealedAllocations();
            return { before, after: await readSettings(caller), listed };
          },
        );

        expect(observed.before.lock_timeout).toBe(CALLER_LOCK_TIMEOUT);
        expect(observed.listed).toEqual([]);
        expect(observed.after).toEqual(observed.before);
      });

      it("restores lock_timeout after abortAllocation refuses an unknown allocation", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const manager = managerOver(
              overCaller({ vector: false }),
              overCaller,
            );
            const before = await readSettings(caller);
            const failure = await failureOf(
              manager.abortAllocation(globalThis.crypto.randomUUID()),
            );
            return { before, after: await readSettings(caller), failure };
          },
        );

        expect(observed.failure).toBeInstanceOf(BranchError);
        expect(observed.after).toEqual(observed.before);
      });

      it("restores every setting after makeBackend and its close", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const manager = managerOver(
              overCaller({ vector: false }),
              overCaller,
            );
            const before = await readSettings(caller);
            const working = await manager.makeBackend();
            const afterMake = await readSettings(caller);
            const live = await manager.listUnsealedAllocations();
            await working.close();
            return {
              before,
              afterMake,
              afterClose: await readSettings(caller),
              liveAllocations: live.length,
              remaining: await manager
                .listUnsealedAllocations()
                .then((listed) => listed.length),
            };
          },
        );

        expect(observed.liveAllocations).toBe(1);
        expect(observed.remaining).toBe(0);
        expect(observed.afterMake).toEqual(observed.before);
        expect(observed.afterClose).toEqual(observed.before);
      });

      it("keeps where the caller's later unqualified statements resolve", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const later = `tg_setting_later_${globalThis.crypto.randomUUID().slice(0, 8)}`;
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            // The caller's path leads with a schema it has not created yet, so
            // its current schema, where the manager allocates, is the next one.
            await run(
              caller,
              sql`SELECT set_config('search_path', ${`${later}, public`}, true)`,
            );
            const manager = managerOver(
              overCaller({ vector: false }),
              overCaller,
            );
            const working = await manager.makeBackend();
            await working.close();
            // Now the caller creates that schema and a table by an unqualified
            // name, which lands in the first existing schema of its path.
            await run(caller, sql.raw(`CREATE SCHEMA "${later}"`));
            await run(
              caller,
              sql.raw("CREATE TABLE tg_setting_probe (v integer)"),
            );
            const [created] = await run(
              caller,
              sql`SELECT n.nspname::text AS schema FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'tg_setting_probe'`,
            );
            return {
              searchPath: await readSettings(caller).then(
                (settings) => settings.search_path,
              ),
              createdIn: created?.["schema"],
            };
          },
        );

        expect(observed).toEqual({
          searchPath: `${later}, public`,
          createdIn: later,
        });
      });

      // The ledger is addressed by its unqualified name, in the control
      // session's current schema, so the manager documents that `control`
      // runs with one consistent search_path. A caller that creates the schema
      // leading its path while a copy is live moves its current schema, and
      // the copy's removal then looks in a ledger that does not know it. Main
      // hid that on this path only because provisioning's search_path pin
      // stayed on the caller's transaction; any control session whose current
      // schema changes has it. Pinned at the value it produces, not fixed.
      it("closes a live copy after the caller creates the schema leading its path", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const later = `tg_setting_live_${globalThis.crypto.randomUUID().slice(0, 8)}`;
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const [current] = await run(
              caller,
              sql`SELECT current_schema()::text AS schema`,
            );
            const allocationSchema = String(current?.["schema"]);
            await run(
              caller,
              sql`SELECT set_config('search_path', ${`${later}, ${allocationSchema}`}, true)`,
            );
            const manager = managerOver(
              overCaller({ vector: false }),
              overCaller,
            );
            const working = await manager.makeBackend();
            await run(caller, sql.raw(`CREATE SCHEMA "${later}"`));
            const close = await failureOf(working.close());
            const [ledger] = await run(
              caller,
              sql`SELECT count(*)::int AS live FROM ${sql.identifier(allocationSchema)}.typegraph_working_copy_allocations`,
            );
            return {
              closed: close === undefined,
              liveInAllocationLedger: Number(ledger?.["live"]),
            };
          },
        );

        expectObservation({
          lane: { driver: context.driver },
          observed,
          correct: { closed: true, liveInAllocationLedger: 0 },
          defects: [
            {
              label:
                "working-copy ledger follows the control session's current schema",
              on: { driver: ["pglite", "node-postgres", "postgres-js"] },
              today: { closed: false, liveInAllocationLedger: 1 },
            },
          ],
        });
      });

      it("restores every setting after an ephemeral copy, and after one whose connection fails", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const observed = await inCallerTransaction(
          root,
          async (caller, overCaller) => {
            const graph = buildGraph();
            const source = await seededStore(
              overCaller({ vector: false }),
              graph,
            );
            const before = await readSettings(caller);

            const manager = managerOver<SettingGraph>(
              overCaller({ vector: false }),
              overCaller,
            );
            const copy = await manager.ephemeral.create(
              source,
              await computeBaseVersion(source),
            );
            const copiedRows = await copy.nodes.SettingPerson.find();
            const copied = copiedRows.length;
            await copy.close();
            const afterCopy = await readSettings(caller);

            const connectFailure = new Error("connection refused by the test");
            const failing = managerOver<SettingGraph>(
              overCaller({ vector: false }),
              overCaller,
              () => Promise.reject(connectFailure),
            );
            const failure = await failureOf(
              failing.ephemeral.create(
                source,
                await computeBaseVersion(source),
              ),
            );
            return {
              before,
              copied,
              afterCopy,
              failedWithConnectError: failure === connectFailure,
              afterFailure: await readSettings(caller),
              remaining: await manager
                .listUnsealedAllocations()
                .then((listed) => listed.length),
            };
          },
        );

        expect(observed.copied).toBe(3);
        expect(observed.failedWithConnectError).toBe(true);
        expect(observed.afterCopy).toEqual(observed.before);
        expect(observed.afterFailure).toEqual(observed.before);
        expect(observed.remaining).toBe(0);
      });

      it("adds no statement on a transaction TypeGraph opens", async (ctx) => {
        const root = requirePostgres(context, ctx);
        const { backend, statements } = capturing(root);
        const manager = createPostgresWorkingCopyManager({
          control: backend,
          connect: () => Promise.reject(new Error("not connected")),
        });
        await manager.listUnsealedAllocations();

        expect(
          statementsNaming(statements, "lock_timeout").map((statement) => ({
            readsPrior: statement.sql.includes("current_setting"),
            setsCleanupBound: statement.params.includes("5000ms"),
          })),
        ).toEqual([{ readsPrior: false, setsCleanupBound: true }]);
      });
    });
  });
}
