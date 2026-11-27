/**
 * The read-only gate at the backend, on every backend.
 *
 * Inside `store.transaction(fn, { accessMode: "read_only" })` every backend
 * object over that transaction refuses each of its write members with the
 * typed read-only refusal before any statement
 * (`src/backend/read-only-write-gate.ts`), whichever entry point reached the
 * member: a Store surface, a schema entry point that takes a backend, or a
 * root backend on the one connection the transaction runs on. These cases
 * drive the entry points that know nothing of the read-only scope.
 */
import { sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../../../src";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../../../src/backend/drizzle/schema/sqlite";
import { backendMembersWithAccess } from "../../../src/backend/member-access";
import { createPostgresTransactionBackend } from "../../../src/backend/postgres";
import { repairInvertedValidityWindows } from "../../../src/backend/repair-validity-windows";
import { createSqliteBackend } from "../../../src/backend/sqlite";
import {
  type AdapterBackend,
  type GraphBackend,
} from "../../../src/backend/types";
import type { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import { sql as portableSql } from "../../../src/query/sql-fragment";
import {
  asCompiledStatementSql,
  asCompiledWriteRowsSql,
  asCompiledWriteStatementSql,
} from "../../../src/query/sql-intent";
import {
  getActiveSchema,
  migrateSchema,
  parseSerializedSchema,
  rollbackSchema,
} from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import {
  prefixedTableNames,
  type TracedTableNames,
} from "../../helpers/traced-connection";
import {
  type BackendMemberFixture,
  READ_MEMBER_ARGUMENTS,
  WRITE_MEMBER_ARGUMENTS,
} from "./backend-member-arguments";
import {
  buildGraph,
  graphState,
  nativeHandle,
  rejectionOf,
  type RotGraph,
  seed,
  writeOutcome,
} from "./read-only-transaction-writes";
import { type IntegrationTestContext } from "./test-context";

const GateNote = defineNode("GateNote", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `read_only_backend_gate_${graphIdCounter}`;
}

function buildSearchGraph(id: string) {
  return defineGraph({
    id,
    nodes: { GateNote: { type: GateNote } },
    edges: {},
  });
}

/** `graph` with one more node kind: an evolved definition of the same graph. */
function evolvedGraph(id: string) {
  const extra = defineNode("GateExtra", {
    schema: z.object({ label: z.string() }),
  });
  const base = buildGraph(id);
  return defineGraph({
    id,
    nodes: { ...base.nodes, GateExtra: { type: extra } },
    edges: base.edges,
    ontology: base.ontology,
    identity: base.identity,
  });
}

/**
 * Asserts `error` is the backend gate's read-only refusal for the graph
 * `graphId`: the typed refusal, naming a backend member or an atomic program.
 */
function expectBackendReadOnlyRefusal(error: unknown, graphId: string): void {
  expect(writeOutcome(error)).toBe("refused as read-only");
  const details = (error as UnsupportedBackendCapabilityError).details;
  expect({
    graphId: details["graphId"],
    accessMode: details["accessMode"],
  }).toEqual({ graphId, accessMode: "read_only" });
  expect(String(details["operation"])).toMatch(/^(backend\.|atomic )/);
}

/** The active schema version of `graphId` on `backend`, if it has one. */
async function activeVersion(
  backend: AdapterBackend<unknown>,
  graphId: string,
): Promise<number | undefined> {
  const active = await getActiveSchema(backend, graphId);
  return active?.version;
}

/** Stands in for a resolver until the promise's executor has run. */
function notYetResolvable(): void {
  // The executor replaces it synchronously.
}

/** A promise and the function that resolves it. */
function signal(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  const handle: { resolve: () => void } = { resolve: notYetResolvable };
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve;
  });
  return {
    promise,
    resolve: () => {
      handle.resolve();
    },
  };
}

/**
 * Opens `store.transaction(fn, { accessMode: "read_only" })` and keeps it
 * open, its callback awaiting, until `release()` is called: resolves once
 * the callback has begun. `settled` is the transaction's outcome.
 */
async function holdReadOnlyTransaction(
  store: Readonly<{
    transaction: (
      fn: (tx: unknown) => Promise<unknown>,
      options: Readonly<{ accessMode: "read_only" }>,
    ) => Promise<unknown>;
  }>,
): Promise<Readonly<{ release: () => void; settled: Promise<unknown> }>> {
  const released = signal();
  const begun = signal();
  const settled = store.transaction(
    async () => {
      begun.resolve();
      await released.promise;
    },
    { accessMode: "read_only" },
  );
  await begun.promise;
  return {
    release: () => {
      released.resolve();
    },
    settled,
  };
}

/** Lets other work run for a few event-loop turns. */
async function otherWorkRuns(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/** An `INSERT` of `value` into the one-column `table`. */
function insertInto(table: string, value: number) {
  return portableSql.raw(`INSERT INTO ${table} (x) VALUES (${value})`);
}

export function registerReadOnlyBackendGateIntegrationTests(
  context: IntegrationTestContext,
): void {
  /**
   * A backend over the caller's transaction handle `handle`:
   * `createPostgresTransactionBackend` on PostgreSQL, `createSqliteBackend`
   * over libSQL's transaction object, and on better-sqlite3, whose `tx.sql`
   * is the database itself, a root backend over the one connection the
   * transaction runs on.
   */
  function backendOverTransaction(handle: unknown): AdapterBackend<unknown> {
    if (context.driver === "better-sqlite3") {
      return createSqliteBackend(handle as never) as AdapterBackend<unknown>;
    }
    if (context.driver === "libsql") {
      return createSqliteBackend(handle as never, {
        executionProfile: { isSync: false, transactionMode: "drizzle" },
      }) as AdapterBackend<unknown>;
    }
    return createPostgresTransactionBackend(
      handle as never,
    ) as AdapterBackend<unknown>;
  }

  describe("work from other flows while a read-only transaction is open", () => {
    it("queues root writes, a read-write transaction and a second Store's write behind it, and runs them once it has ended, as without the scope", async () => {
      const graph = buildGraph(nextGraphId());
      const other = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const [otherStore] = await createAdapterStoreWithSchema(other, backend);
      const held = await holdReadOnlyTransaction(store);
      const order: string[] = [];
      const outcomes: Record<string, string> = {};
      const track = (name: string, pending: Promise<unknown>) =>
        pending.then(
          () => {
            order.push(name);
            outcomes[name] = "fulfilled";
          },
          (error: unknown) => {
            order.push(name);
            outcomes[name] = writeOutcome(error);
          },
        );
      const pending = [
        track(
          "root create",
          store.nodes.RotTeam.create({ name: "queued" }, { id: "queued" }),
        ),
        track(
          "root read-write transaction",
          store.transaction(async (tx) => {
            await tx.nodes.RotTeam.create({ name: "in-tx" }, { id: "in-tx" });
          }),
        ),
        track(
          "second store create",
          otherStore.nodes.RotTeam.create({ name: "other" }, { id: "other" }),
        ),
      ];
      await otherWorkRuns();
      order.push("read-only transaction released");
      held.release();
      await held.settled;
      await Promise.all(pending);
      expect(outcomes).toEqual({
        "root create": "fulfilled",
        "root read-write transaction": "fulfilled",
        "second store create": "fulfilled",
      });
      // A SQLite backend serializes its transactions: every write waited
      // for the read-only transaction to end. Elsewhere they may run beside it.
      const serializes =
        context.driver === "better-sqlite3" || context.driver === "libsql";
      expect(serializes ? order[0] : "not ordered").toBe(
        serializes ? "read-only transaction released" : "not ordered",
      );
      const teams = await store.nodes.RotTeam.find();
      expect(teams.map((team) => team.id).toSorted()).toEqual([
        "in-tx",
        "queued",
      ]);
      const otherTeams = await otherStore.nodes.RotTeam.find();
      expect(otherTeams.map((team) => team.id)).toEqual(["other"]);
    });

    it("refuses root refreshStatistics() from another flow only where it would run inside the read-only transaction", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      const held = await holdReadOnlyTransaction(store);
      const refresh = rejectionOf(store.refreshStatistics());
      await otherWorkRuns();
      held.release();
      await held.settled;
      const refusal = await refresh;
      // better-sqlite3 runs ANALYZE on the connection as it is called, inside
      // the read-only transaction the connection has open. Every other driver
      // runs it beside the transaction or after it, where the engine decides
      // (libSQL reports the read-only transaction's lock as SQLITE_BUSY).
      const runsInside = context.driver === "better-sqlite3";
      expect(writeOutcome(refusal) === "refused as read-only").toBe(runsInside);
      if (runsInside) expectBackendReadOnlyRefusal(refusal, graph.id);
    });
  });

  describe("a backend's own write members inside a read-only scope", () => {
    it("refuses store.search.rebuildFulltext() on a Store over the transaction, and the transaction stays usable", async () => {
      const graph = buildSearchGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await store.nodes.GateNote.create({ body: "alpha" }, { id: "n1" });
      let refusal: unknown;
      const committed = await store.transaction(
        async (tx) => {
          const overTransaction = createAdapterStore(
            graph,
            backendOverTransaction(nativeHandle(tx)),
          );
          refusal = await rejectionOf(overTransaction.search.rebuildFulltext());
          return tx.nodes.GateNote.getById(asNodeId("n1"));
        },
        { accessMode: "read_only" },
      );
      expectBackendReadOnlyRefusal(refusal, graph.id);
      // On PostgreSQL the transaction is the engine's read-only one, so a
      // write statement would have aborted it before this read.
      expect(committed?.id).toBe("n1");
    });

    it("refuses a schema entry point over the transaction for a new graph and for an evolved one, and commits no schema", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      await seed(store);
      const fresh = buildGraph(nextGraphId());
      const evolved = evolvedGraph(graph.id);
      const before = await graphState(store);
      const outcomes: Record<string, unknown> = {};
      const committed = await store.transaction(
        async (tx) => {
          const overTransaction = backendOverTransaction(nativeHandle(tx));
          outcomes["new graph"] = await rejectionOf(
            createAdapterStoreWithSchema(fresh, overTransaction),
          );
          outcomes["evolved graph"] = await rejectionOf(
            createAdapterStoreWithSchema(evolved, overTransaction),
          );
          outcomes["migrateSchema()"] = await rejectionOf(
            migrateSchema(overTransaction, evolved, 1),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expect(Object.keys(outcomes)).toHaveLength(3);
      for (const outcome of Object.values(outcomes)) {
        expectBackendReadOnlyRefusal(outcome, graph.id);
      }
      expect(committed?.id).toBe("p1");
      expect(await getActiveSchema(backend, fresh.id)).toBeUndefined();
      expect(await activeVersion(backend, graph.id)).toBe(1);
      expect(await graphState(store)).toEqual(before);
    });

    it('refuses repairInvertedValidityWindows({ mode: "apply" }) through a backend adopted over the transaction, and the transaction stays usable', async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      await seed(store);
      let refusal: unknown;
      const committed = await store.transaction(
        async (tx) => {
          refusal = await rejectionOf(
            repairInvertedValidityWindows({
              // A transaction backend carries every member the repair
              // reaches; it has no `transaction` member, so the repair runs
              // on it directly.
              backend: backend.adoptTransaction(
                nativeHandle(tx),
              ) as unknown as GraphBackend,
              graphId: graph.id,
              relations: "live-and-recorded",
              mode: "apply",
            }),
          );
          return tx.nodes.RotPerson.getById(asNodeId("p1"));
        },
        { accessMode: "read_only" },
      );
      expectBackendReadOnlyRefusal(refusal, graph.id);
      // On PostgreSQL a write statement would have aborted the transaction
      // before this read.
      expect(committed?.id).toBe("p1");
    });

    it("refuses rollbackSchema() over the transaction, and the active version stays", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      await createAdapterStoreWithSchema(graph, backend);
      await createAdapterStoreWithSchema(evolvedGraph(graph.id), backend);
      expect(await activeVersion(backend, graph.id)).toBe(2);
      const opener = createAdapterStore(graph, backend);
      let refusal: unknown;
      await opener.transaction(
        async (tx) => {
          refusal = await rejectionOf(
            rollbackSchema(
              backendOverTransaction(nativeHandle(tx)),
              graph.id,
              1,
            ),
          );
        },
        { accessMode: "read_only" },
      );
      expectBackendReadOnlyRefusal(refusal, graph.id);
      expect(await activeVersion(backend, graph.id)).toBe(2);
    });

    it("refuses a statement library code marked as a write through a raw-SQL member, and leaves an unmarked one to the engine", async () => {
      const graph = buildGraph(nextGraphId());
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(graph, backend);
      const table = `read_only_gate_raw_${graph.id}`;
      await requireDefined(backend.executeDdl)(
        `CREATE TABLE ${table} (x INTEGER)`,
      );
      try {
        const outcomes: Record<string, string> = {};
        const transaction = await rejectionOf(
          store.transaction(
            async (tx) => {
              const overTransaction = backendOverTransaction(nativeHandle(tx));
              const execute = requireDefined(overTransaction.executeStatement);
              outcomes["marked"] = writeOutcome(
                await rejectionOf(
                  execute(asCompiledWriteStatementSql(insertInto(table, 1))),
                ),
              );
              outcomes["unmarked"] = writeOutcome(
                await rejectionOf(
                  execute(asCompiledStatementSql(insertInto(table, 2))),
                ),
              );
            },
            { accessMode: "read_only" },
          ),
        );
        const sqlite =
          context.driver === "better-sqlite3" || context.driver === "libsql";
        // SQLite has no read-only transaction at the engine: the unmarked
        // write runs and commits. PostgreSQL rejects it, which aborts the
        // transaction.
        expect({
          ...outcomes,
          transaction: transaction === undefined ? "committed" : "rejected",
        }).toEqual(
          sqlite ?
            {
              marked: "refused as read-only",
              unmarked: "fulfilled",
              transaction: "committed",
            }
          : {
              marked: "refused as read-only",
              unmarked: "rejected: 25006",
              transaction: "rejected",
            },
        );
      } finally {
        await requireDefined(backend.executeDdl)(`DROP TABLE ${table}`);
      }
    });

    it("refuses a write through tx.measure() in a read-only transactionWithReceipt() at the context's own gate", async () => {
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(
        graph,
        context.getBackend(),
      );
      await seed(store);
      let refusal: unknown;
      await store.transactionWithReceipt(
        async (tx) => {
          refusal = await rejectionOf(
            tx.measure((scope) =>
              scope.nodes.RotTeam.create({ name: "t3" }, { id: "t3" }),
            ),
          );
        },
        { accessMode: "read_only" },
      );
      // The measured scope's surface passes the context's own write gate,
      // which names the context's member, before the backend's would.
      expect(writeOutcome(refusal)).toBe("refused as read-only");
      expect(
        (refusal as UnsupportedBackendCapabilityError).details,
      ).toMatchObject({
        operation: "tx.nodes.RotTeam.create()",
        graphId: graph.id,
      });
      expect(await store.nodes.RotTeam.getById(asNodeId("t3"))).toBeUndefined();
    });

    // A root backend's statements run inside its own read-only transaction
    // only where the driver runs every transaction on the root's one
    // connection; elsewhere the root's statement runs on a connection of its
    // own (or, on PGlite, waits for the transaction to end).
    it.runIf(context.driver === "better-sqlite3")(
      "refuses the Store's own root refreshStatistics() inside its read-only callback on a one-connection driver, and creates no statistics",
      async () => {
        const graph = buildGraph(nextGraphId());
        const [store] = await createAdapterStoreWithSchema(
          graph,
          context.getBackend(),
        );
        await seed(store);
        const statisticsTables = async (): Promise<unknown> =>
          store.transaction(async (tx) => {
            const handle = nativeHandle(tx) as Readonly<{
              all: (query: unknown) => unknown;
            }>;
            const { sql } = await import("drizzle-orm");
            return handle.all(
              sql.raw(
                "SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'",
              ),
            );
          });
        const before = await statisticsTables();
        let refusal: unknown;
        await store.transaction(
          async () => {
            refusal = await rejectionOf(store.refreshStatistics());
          },
          { accessMode: "read_only" },
        );
        expectBackendReadOnlyRefusal(refusal, graph.id);
        expect(await statisticsTables()).toEqual(before);
      },
    );
  });
}

/**
 * A write statement marked as library code's on the nodes table `nodes`,
 * for each raw-SQL member that takes a compiled statement.
 */
function rawWriteArguments(
  nodes: string,
): Readonly<Record<string, readonly unknown[]>> {
  const update = `UPDATE "${nodes}" SET kind = kind WHERE 0`;
  return {
    execute: [
      asCompiledWriteRowsSql(portableSql.raw(`${update} RETURNING id`)),
    ],
    executeStatement: [asCompiledWriteStatementSql(portableSql.raw(update))],
  };
}

/** A statement that writes or runs DDL, as the driver was asked to run it. */
const WRITE_STATEMENT =
  /^\s*(INSERT|UPDATE|DELETE|REPLACE|UPSERT|MERGE|CREATE|DROP|ALTER|TRUNCATE|ANALYZE|REINDEX|VACUUM|GRANT|REVOKE|COMMENT)\b|^\s*WITH\b[\s\S]*\b(INSERT|UPDATE|DELETE)\b/i;

/** Every backend object a caller can hold over a read-only transaction. */
type ScopeTargets = Readonly<Record<"over" | "adopted", object>>;

function memberIsPresent(target: object, member: string): boolean {
  const value: unknown = Reflect.get(target, member);
  return member === "commands" ?
      typeof value === "object" && value !== null
    : typeof value === "function";
}

/** Calls `member` of `target` with `args`; a command port's `execute`. */
function callMember(
  target: object,
  member: string,
  args: readonly unknown[],
): Promise<unknown> {
  return Promise.resolve().then((): unknown => {
    const value: unknown = Reflect.get(target, member);
    if (member === "commands") {
      const port = value as Readonly<{
        execute: (...portArguments: readonly unknown[]) => unknown;
      }>;
      return port.execute(...args);
    }
    return Reflect.apply(
      value as (...a: readonly unknown[]) => unknown,
      target,
      [...args],
    );
  });
}

export function registerReadOnlyBackendMemberIntegrationTests(
  context: IntegrationTestContext,
): void {
  /** A backend over `handle` on the traced connection's own tables. */
  function tracedBackendOverTransaction(
    handle: unknown,
    names: TracedTableNames,
  ): AdapterBackend<unknown> {
    if (context.driver === "better-sqlite3") {
      return createSqliteBackend(handle as never, {
        tables: createSqliteTables(names),
      }) as AdapterBackend<unknown>;
    }
    if (context.driver === "libsql") {
      return createSqliteBackend(handle as never, {
        tables: createSqliteTables(names),
        executionProfile: { isSync: false, transactionMode: "drizzle" },
      }) as AdapterBackend<unknown>;
    }
    return createPostgresTransactionBackend(handle as never, {
      tables: createPostgresTables(names),
    }) as AdapterBackend<unknown>;
  }

  /** `SELECT total_changes()` through `handle` on SQLite; `undefined` elsewhere. */
  async function totalChanges(handle: unknown): Promise<number | undefined> {
    if (context.driver !== "better-sqlite3" && context.driver !== "libsql") {
      return undefined;
    }
    const runner = handle as Readonly<{ all: (query: unknown) => unknown }>;
    const rows = (await Promise.resolve(
      runner.all(drizzleSql.raw("SELECT total_changes() AS changes")),
    )) as readonly Readonly<{ changes: unknown }>[];
    return Number(rows[0]?.changes);
  }

  type Traced = Readonly<{
    store: Awaited<
      ReturnType<typeof createAdapterStoreWithSchema<RotGraph, unknown>>
    >[0];
    root: AdapterBackend<unknown>;
    names: TracedTableNames;
    graphId: string;
    statements: () => readonly Readonly<{ text: string }>[];
    reset: () => void;
  }>;

  async function withTracedGraph(run: (traced: Traced) => Promise<void>) {
    graphIdCounter += 1;
    const names = prefixedTableNames(`rog${graphIdCounter}`);
    const connection = await context.openTracedConnection([names]);
    try {
      const root = requireDefined(connection.backends[0]);
      const graph = buildGraph(nextGraphId());
      const [store] = await createAdapterStoreWithSchema(graph, root);
      await seed(store);
      await run({
        store,
        root,
        names,
        graphId: graph.id,
        statements: connection.statements,
        reset: connection.reset,
      });
    } finally {
      await connection.close();
    }
  }

  /**
   * What the argument builders read off the graph, read on the root before
   * the read-only transaction opens: the root's connection is the
   * transaction's own on a one-connection driver.
   */
  type GraphFixture = Omit<
    BackendMemberFixture,
    "nativeTransaction" | "commandSession"
  >;

  async function graphFixtureOf(traced: Traced): Promise<GraphFixture> {
    const active = requireDefined(
      await traced.root.getActiveSchema(traced.graphId),
    );
    return {
      graphId: traced.graphId,
      schemaVersion: active.version,
      schemaHash: active.schema_hash,
      schemaDoc: parseSerializedSchema(active.schema_doc),
      identityTableNames: {
        identityAssertions: traced.names.identityAssertions,
        recordedIdentityAssertions: traced.names.recordedIdentityAssertions,
        identityClosure: traced.names.identityClosure,
        identitySeparation: traced.names.identitySeparation,
        identityTransitions: traced.names.identityTransitions,
        identityTransitionRetention: traced.names.identityTransitionRetention,
      },
    };
  }

  function fixtureOf(
    graphFixture: GraphFixture,
    nativeTransaction: unknown,
    label: keyof ScopeTargets,
  ): BackendMemberFixture {
    return {
      ...graphFixture,
      nativeTransaction,
      commandSession: label === "over" ? "root" : "transaction",
    };
  }

  function scopeTargets(traced: Traced, handle: unknown): ScopeTargets {
    return {
      over: tracedBackendOverTransaction(handle, traced.names),
      adopted: traced.root.adoptTransaction(handle),
    };
  }

  describe("every backend member inside a read-only scope", () => {
    it("refuses every write member of every backend object over the transaction, with the typed refusal and no statement at the driver", async () => {
      await withTracedGraph(async (traced) => {
        const graphFixture = await graphFixtureOf(traced);
        const outcomes: Record<string, string> = {};
        let committed: unknown;
        await traced.store.transaction(
          async (tx) => {
            const handle = nativeHandle(tx);
            // Reading `tx.sql` can leave the transaction a statement of its
            // own to run before the next one (PostgreSQL's commit-outcome
            // marker): a read here runs it before any member is counted.
            await tx.nodes.RotPerson.getById(asNodeId("p1"));
            for (const [label, target] of Object.entries(
              scopeTargets(traced, handle),
            )) {
              const fixture = fixtureOf(
                graphFixture,
                handle,
                label as keyof ScopeTargets,
              );
              for (const member of backendMembersWithAccess("write")) {
                if (!memberIsPresent(target, member)) continue;
                const args = (
                  WRITE_MEMBER_ARGUMENTS[member] as (
                    f: BackendMemberFixture,
                  ) => unknown
                )(fixture);
                if (!Array.isArray(args)) continue;
                traced.reset();
                const error = await rejectionOf(
                  callMember(target, member, args),
                );
                const statements = traced.statements();
                outcomes[`${label} ${member}`] =
                  `${writeOutcome(error)} after ${statements.length} statements${statements.map((statement) => ` [${statement.text.replaceAll(/\s+/g, " ").slice(0, 160)}]`).join("")}`;
                if (writeOutcome(error) === "refused as read-only") {
                  expectBackendReadOnlyRefusal(error, traced.graphId);
                }
              }
            }
            committed = await tx.nodes.RotPerson.getById(asNodeId("p1"));
          },
          { accessMode: "read_only" },
        );
        expect(outcomes).toEqual(
          Object.fromEntries(
            Object.keys(outcomes).map((label) => [
              label,
              "refused as read-only after 0 statements",
            ]),
          ),
        );
        // Every required write member of the portable surface is on the
        // backend over the transaction; the transaction stayed usable.
        for (const member of [
          "insertNode",
          "updateNode",
          "deleteNode",
          "insertEdge",
          "commands",
          "insertUnique",
          "commitSchemaVersion",
          "setActiveVersion",
          "refreshStatistics",
          "clearGraph",
          "transaction",
        ]) {
          expect(Object.keys(outcomes)).toContain(`over ${member}`);
        }
        expect(Object.keys(outcomes)).toContain("adopted insertNode");
        expect((committed as { id?: unknown } | undefined)?.id).toBe("p1");
      });
    });

    // On better-sqlite3 the root backend runs on the one connection the
    // read-only transaction holds: what matters is where each member's work
    // is admitted. Elsewhere the root runs beside the transaction, or waits
    // for it inside the driver, and the Store-level case above covers it.
    it.runIf(context.driver === "better-sqlite3")(
      "lets no root write member called from another flow write inside the read-only transaction: each waits behind it, or is refused before any statement",
      async () => {
        await withTracedGraph(async (traced) => {
          const graphFixture = await graphFixtureOf(traced);
          const violations: Record<string, string> = {};
          const refused: string[] = [];
          const queued: string[] = [];
          for (const member of [
            ...backendMembersWithAccess("write"),
            ...backendMembersWithAccess("raw"),
          ]) {
            if (!memberIsPresent(traced.root, member)) continue;
            let handle: unknown;
            const held = await holdReadOnlyTransaction({
              transaction: (fn, options) =>
                traced.store.transaction(async (tx) => {
                  handle = nativeHandle(tx);
                  await fn(tx);
                }, options),
            });
            const fixture = {
              ...fixtureOf(graphFixture, handle, "over"),
              commandSession: "root" as const,
            };
            const writeArguments = WRITE_MEMBER_ARGUMENTS[
              member as keyof typeof WRITE_MEMBER_ARGUMENTS
            ] as ((f: BackendMemberFixture) => unknown) | undefined;
            const args =
              rawWriteArguments(traced.names.nodes)[member] ??
              writeArguments?.(fixture);
            if (!Array.isArray(args)) {
              held.release();
              await held.settled;
              continue;
            }
            traced.reset();
            const outcome = rejectionOf(callMember(traced.root, member, args));
            await otherWorkRuns();
            const inside = traced
              .statements()
              .map((statement) => statement.text);
            held.release();
            await rejectionOf(held.settled);
            const error = await outcome;
            if (writeOutcome(error) === "refused as read-only") {
              expectBackendReadOnlyRefusal(error, traced.graphId);
              refused.push(member);
              if (inside.length > 0) {
                violations[member] =
                  `refused after ${inside.length} statements`;
              }
            } else {
              queued.push(member);
              const written = inside.filter((text) =>
                WRITE_STATEMENT.test(text),
              );
              if (written.length > 0) {
                violations[member] =
                  `wrote inside: ${written.join(" | ").slice(0, 300)}`;
              }
            }
          }
          expect(violations).toEqual({});
          expect(queued).toEqual(
            expect.arrayContaining([
              "transaction",
              "insertNode",
              "commands",
              "clearGraph",
              "executeStatement",
            ]),
          );
          expect(refused).toEqual(
            expect.arrayContaining(["refreshStatistics", "executeDdl"]),
          );
        });
      },
    );

    it("runs every read member of every backend object over the transaction without a write statement or a changed row", async () => {
      await withTracedGraph(async (traced) => {
        const graphFixture = await graphFixtureOf(traced);
        const writes: Record<string, readonly string[]> = {};
        const engineRefusals: Record<string, string> = {};
        const called: string[] = [];
        for (const label of ["over", "adopted"] as const) {
          for (const member of backendMembersWithAccess("read")) {
            // One read-only transaction per member: a read the engine
            // rejects (an absent optional relation, say) aborts a
            // PostgreSQL transaction, and must not hide the next member.
            await rejectionOf(
              traced.store.transaction(
                async (tx) => {
                  const handle = nativeHandle(tx);
                  const target = scopeTargets(traced, handle)[label];
                  if (!memberIsPresent(target, member)) return;
                  const args = (
                    READ_MEMBER_ARGUMENTS[member] as (
                      f: BackendMemberFixture,
                    ) => unknown
                  )(fixtureOf(graphFixture, handle, label));
                  if (!Array.isArray(args)) return;
                  const changesBefore = await totalChanges(handle);
                  traced.reset();
                  const error = await rejectionOf(
                    callMember(target, member, args),
                  );
                  const written = traced
                    .statements()
                    .map((statement) => statement.text)
                    .filter((text) => WRITE_STATEMENT.test(text));
                  const changesAfter = await totalChanges(handle);
                  called.push(`${label} ${member}`);
                  if (written.length > 0 || changesAfter !== changesBefore) {
                    writes[`${label} ${member}`] = [
                      ...written,
                      `total_changes ${changesBefore} -> ${changesAfter}`,
                    ];
                  }
                  if (writeOutcome(error) === "rejected: 25006") {
                    engineRefusals[`${label} ${member}`] = writeOutcome(error);
                  }
                },
                { accessMode: "read_only" },
              ),
            );
          }
        }
        expect(writes).toEqual({});
        expect(engineRefusals).toEqual({});
        for (const member of [
          "getNode",
          "findNodesByKind",
          "getActiveSchema",
        ]) {
          expect(called).toContain(`over ${member}`);
          expect(called).toContain(`adopted ${member}`);
        }
      });
    });
  });
}
