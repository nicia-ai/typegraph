/**
 * Every read terminal runs through every entry point that accepts it, with
 * the outcome a node select has there.
 *
 * An entry point that accepts a read by type and then refuses it at run time
 * is a contract the caller cannot see. These cases run each read terminal
 * (node and edge selects, projections, relations, aggregates, set
 * operations, prepared forms, and the scalar, paging and streaming forms)
 * through each entry point. Each cell has ONE expected outcome, shared by
 * every terminal in its row: the select family's.
 *
 * `executeOn(target)` runs on the target it is handed. Nothing checks that
 * the target belongs to the database the read was built on, for any
 * terminal, so a read handed another database's target, or a transaction of
 * another database adopted by this backend, returns that database's rows.
 * The refusals that remain are the ones every terminal shares:
 * `tx.batchOnce()` embeds a read only in the context it was built in, and a
 * transaction that has ended behaves as its driver makes it behave.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { count, createStoreWithSchema, param as parameter } from "../../../src";
import type {
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import type { InitialQueryBuilder } from "../../../src/query";
import type { BatchableQuery } from "../../../src/query/builder/types";
import { TRANSACTION_RUNTIME } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

type IntegrationTestGraph = typeof integrationTestGraph;

type QueryScope = Readonly<{
  query: () => InitialQueryBuilder<IntegrationTestGraph, "open">;
}>;

/** A read that can be handed to an entry point as a value. */
type TargetableRead = Readonly<{
  execute: () => Promise<unknown>;
  executeOn: (backend: GraphBackend | TransactionBackend) => Promise<unknown>;
  compileOneStatementBatchItem?: unknown;
}>;

/** One entry point: how to run a read there, and whose rows it returns. */
type Cell = Readonly<{
  run: (read: TargetableRead, name: string) => Promise<unknown>;
  /** The database whose `execute()` result the cell returns. */
  rows: "this database" | "other database";
  /** Whether the read in this cell is built on the other database. */
  builtOn?: "other database";
  /** Present when the cell applies only to reads `batchOnce()` embeds. */
  embedsOnly?: true;
}>;

const BATCH_ONCE_REBIND_REFUSAL =
  "store.batchOnce() cannot rebind a read to a different database or transaction target.";

/** The reads every entry point is offered, built from one scope. */
function targetableReads(
  scope: QueryScope,
): Readonly<Record<string, TargetableRead>> {
  const names = scope
    .query()
    .from("Person", "p")
    .orderBy("p", "name")
    .project((ctx) => ({ name: ctx.p.name }));
  const aggregate = scope
    .query()
    .from("Person", "p")
    .aggregate({ people: count("p") });
  return {
    "node select": scope
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p.name),
    "edge select": scope
      .query()
      .from("Person", "p")
      .traverse("knows", "e")
      .to("Person", "q")
      .select((ctx) => ctx.e.since),
    projection: names,
    relation: names.asRelation(),
    aggregate,
    "aggregate relation": aggregate.asRelation(),
    "set operation": scope
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Ada"))
      .select((ctx) => ctx.p.name)
      .union(
        scope
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.name.eq("Cy"))
          .select((ctx) => ctx.p.name),
      ),
    "prepared aggregate, bound": scope
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq(parameter("name")))
      .aggregate({ people: count("p") })
      .prepare()
      .bind({ name: "Ada" }),
  };
}

/** The reads that run only through their own terminals, from one scope. */
function terminalReads(
  scope: QueryScope,
): Readonly<Record<string, () => Promise<unknown>>> {
  const people = scope
    .query()
    .from("Person", "p")
    .orderBy("p", "name")
    .select((ctx) => ctx.p.name);
  const aggregate = scope
    .query()
    .from("Person", "p")
    .aggregate({ people: count("p") });
  return {
    "select count": () => people.count(),
    "select exists": () => people.exists(),
    "select paginate": () =>
      people.paginate({ first: 1 }).then((page) => page.data),
    "select stream": async () => {
      const streamed: string[] = [];
      for await (const name of people.stream({ batchSize: 1 }))
        streamed.push(name);
      return streamed;
    },
    "prepared select": () =>
      scope
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .select((ctx) => ctx.p.name)
        .prepare()
        .execute({ name: "Bo" }),
    "aggregate count": () => aggregate.count(),
    "aggregate exists": () => aggregate.exists(),
    "aggregate first": () => aggregate.first(),
    "prepared aggregate": () =>
      scope
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq(parameter("name")))
        .aggregate({ people: count("p") })
        .prepare()
        .execute({ name: "Bo" }),
  };
}

/** `ok` when `run` returns `expected`; otherwise what it did instead. */
async function observe(
  run: () => Promise<unknown>,
  expected: unknown,
): Promise<string> {
  try {
    const result = await run();
    return JSON.stringify(result) === JSON.stringify(expected) ?
        "ok"
      : `returned ${JSON.stringify(result)}`;
  } catch (error) {
    return error instanceof Error ?
        `refuses: ${error.name}: ${error.message}`
      : `refuses: ${String(error)}`;
  }
}

/** This database: Ada knows Bo. */
async function seed(store: IntegrationStore): Promise<void> {
  const ada = await store.nodes.Person.create({ name: "Ada" });
  const bo = await store.nodes.Person.create({ name: "Bo" });
  await store.edges.knows.create(ada, bo, { since: "2020" });
}

/** The other database: different rows, so whose rows came back is visible. */
async function seedOther(
  store: Awaited<ReturnType<typeof createStoreWithSchema>>[0],
): Promise<void> {
  const typed = store as unknown as IntegrationStore;
  const cy = await typed.nodes.Person.create({ name: "Cy" });
  const di = await typed.nodes.Person.create({ name: "Di" });
  const ed = await typed.nodes.Person.create({ name: "Ed" });
  await typed.edges.knows.create(cy, di, { since: "2021" });
  await typed.edges.knows.create(di, ed, { since: "2022" });
}

/** A transaction handle kept past the callback that received it. */
async function retainedHandle<T>(
  open: (keep: (handle: T) => void) => Promise<unknown>,
): Promise<T> {
  const kept: T[] = [];
  await open((handle) => kept.push(handle));
  return requireDefined(kept[0]);
}

/**
 * A transaction backend that `createSqlBackend` did not build: a caller's
 * own object over the transaction's members. The library knows nothing
 * about its identity.
 */
function callerBuiltTransaction(
  transaction: TransactionBackend,
): TransactionBackend {
  return new Proxy(transaction, {});
}

/**
 * What a read does on a transaction that has ended, as the error class and
 * its cause rather than the statement text, which differs per terminal.
 */
async function observeEnded(
  run: () => Promise<unknown>,
  expected: unknown,
): Promise<string> {
  try {
    const result = await run();
    return JSON.stringify(result) === JSON.stringify(expected) ?
        "ok"
      : `returned ${JSON.stringify(result)}`;
  } catch (error) {
    if (!(error instanceof Error)) return `refuses: ${String(error)}`;
    const cause = error.cause;
    return cause instanceof Error ?
        `refuses: ${error.name}, cause ${cause.name}: ${cause.message}`
      : `refuses: ${error.name}`;
  }
}

/**
 * What a select does on a transaction that has ended, per driver: the
 * shared expectation of every terminal in that cell.
 */
function endedTransactionOutcome(context: IntegrationTestContext): string {
  switch (context.driver) {
    // The handle reads through the connection it was opened on.
    case "better-sqlite3": {
      return "ok";
    }
    case "libsql": {
      return "refuses: Error, cause LibsqlError: TRANSACTION_CLOSED: The transaction is closed";
    }
    case "pglite":
    case "node-postgres":
    case "postgres-js": {
      return "refuses: TransactionClosedError";
    }
  }
}

export function registerReadEntryPointIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("read terminals through every entry point", () => {
    beforeEach(async () => {
      await seed(context.getStore());
    });

    it("a read built on the Store has the select's outcome on every target it is handed", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const embeds = store.backend.capabilities.windowFunctions;
      const otherBackend = await context.createIsolatedBackend();
      const [otherStore] = await createStoreWithSchema(
        integrationTestGraph,
        otherBackend,
      );
      await seedOther(otherStore);
      const reads = targetableReads(store);
      const otherReads = targetableReads(otherStore);
      const schemaWriteTransaction = backend.schemaWriteTransaction;

      const cells: Readonly<Record<string, Cell>> = {
        "store.batch": {
          run: (read) =>
            store
              .batch(read as BatchableQuery, read as BatchableQuery)
              .then(([first]) => first),
          rows: "this database",
        },
        "executeOn(root)": {
          run: (read) => read.executeOn(backend),
          rows: "this database",
        },
        "executeOn(engine transaction)": {
          run: (read) =>
            backend.transaction((transaction) => read.executeOn(transaction)),
          rows: "this database",
        },
        "executeOn(Store transaction)": {
          run: (read) =>
            store.transaction((tx) =>
              read.executeOn(tx[TRANSACTION_RUNTIME].backend),
            ),
          rows: "this database",
        },
        ...(schemaWriteTransaction !== undefined && {
          "executeOn(schema-write transaction)": {
            run: (read) =>
              schemaWriteTransaction(integrationTestGraph.id, (transaction) =>
                read.executeOn(transaction),
              ),
            rows: "this database",
          },
        }),
        "executeOn(caller-built transaction backend)": {
          run: (read) =>
            backend.transaction((transaction) =>
              read.executeOn(callerBuiltTransaction(transaction)),
            ),
          rows: "this database",
        },
        "store.batchOnce": {
          run: (read) =>
            store
              .batchOnce(() => [read as never])
              .then(([first]: readonly unknown[]) => first),
          rows: "this database",
          embedsOnly: true,
        },
        // The caller owns the target: another database's is not detected.
        "executeOn(other database)": {
          run: (read) => read.executeOn(otherBackend),
          rows: "other database",
        },
        "executeOn(other database's transaction)": {
          run: (read) =>
            otherBackend.transaction((transaction) =>
              read.executeOn(transaction),
            ),
          rows: "other database",
        },
        "executeOn(other database's transaction, adopted here)": {
          run: (read) =>
            otherBackend.transactionWithNative((_transaction, native) =>
              read.executeOn(backend.adoptTransaction(native as never)),
            ),
          rows: "other database",
        },
        "store.batch, built on the other database": {
          run: (_read, name) => {
            const read = requireDefined(otherReads[name]);
            return store
              .batch(read as BatchableQuery, read as BatchableQuery)
              .then(([first]) => first);
          },
          rows: "this database",
          builtOn: "other database",
        },
        "executeOn(root), built on the other database": {
          run: (_read, name) =>
            requireDefined(otherReads[name]).executeOn(backend),
          rows: "this database",
          builtOn: "other database",
        },
      };

      const observed: Record<string, Record<string, string>> = {};
      const expected: Record<string, Record<string, string>> = {};
      for (const [name, read] of Object.entries(reads)) {
        const results = {
          "this database": await read.execute(),
          "other database": await requireDefined(otherReads[name]).execute(),
        };
        observed[name] = {};
        expected[name] = {};
        for (const [entry, cell] of Object.entries(cells)) {
          if (
            cell.embedsOnly === true &&
            (!embeds || read.compileOneStatementBatchItem === undefined)
          )
            continue;
          observed[name][entry] = await observe(
            () => cell.run(read, name),
            results[cell.rows],
          );
          expected[name][entry] = "ok";
        }
        // A transaction handle used after its callback returned.
        const ended = await retainedHandle<TransactionBackend>((keep) =>
          backend.transaction((transaction) => {
            keep(transaction);
            return Promise.resolve();
          }),
        );
        observed[name]["executeOn(engine transaction, after its callback)"] =
          await observeEnded(
            () => read.executeOn(ended),
            results["this database"],
          );
        expected[name]["executeOn(engine transaction, after its callback)"] =
          endedTransactionOutcome(context);
      }
      expect(observed).toEqual(expected);
    });

    it("a read built inside store.transaction() has the select's outcome in it and after it ends", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const embeds = store.backend.capabilities.windowFunctions;
      const rootResults = new Map<string, unknown>();
      const storeReads = targetableReads(store);
      for (const [name, read] of Object.entries(storeReads))
        rootResults.set(name, await read.execute());
      for (const [name, run] of Object.entries(terminalReads(store)))
        rootResults.set(name, await run());

      const observed: Record<string, Record<string, string>> = {};
      const expected: Record<string, Record<string, string>> = {};
      const kept: {
        reads?: Readonly<Record<string, TargetableRead>>;
        terminals?: Readonly<Record<string, () => Promise<unknown>>>;
      } = {};
      await store.transaction(async (tx) => {
        const reads = targetableReads(tx);
        kept.reads = reads;
        kept.terminals = terminalReads(tx);
        for (const [name, read] of Object.entries(reads)) {
          const result = rootResults.get(name);
          const cells: Record<string, () => Promise<unknown>> = {
            execute: () => read.execute(),
            "executeOn(its transaction)": () =>
              read.executeOn(tx[TRANSACTION_RUNTIME].backend),
            ...(embeds &&
              read.compileOneStatementBatchItem !== undefined && {
                "tx.batchOnce": () =>
                  tx
                    .batchOnce(() => [read as never])
                    .then(([first]: readonly unknown[]) => first),
              }),
          };
          observed[name] = {};
          expected[name] = {};
          for (const [entry, run] of Object.entries(cells)) {
            observed[name][entry] = await observe(run, result);
            expected[name][entry] = "ok";
          }
        }
        // Every terminal alike: batchOnce() embeds a read only in the
        // context it was built in, and its refusal names the remedy.
        if (embeds)
          for (const [name, read] of Object.entries(storeReads)) {
            if (read.compileOneStatementBatchItem === undefined) continue;
            const cells = requireDefined(observed[name]);
            cells["tx.batchOnce, built on the Store"] = await observe(
              () => tx.batchOnce(() => [read as never]),
              undefined,
            );
            requireDefined(expected[name])["tx.batchOnce, built on the Store"] =
              `refuses: ConfigurationError: ${BATCH_ONCE_REBIND_REFUSAL}`;
          }
        for (const [name, run] of Object.entries(terminalReads(tx))) {
          observed[name] = {
            execute: await observe(run, rootResults.get(name)),
          };
          expected[name] = { execute: "ok" };
        }
      });

      // After the transaction ends: its own execute() meets the closed
      // transaction as its driver makes it, and a target handed to it runs.
      for (const [name, read] of Object.entries(requireDefined(kept.reads))) {
        const result = rootResults.get(name);
        const cells = requireDefined(observed[name]);
        const expectedCells = requireDefined(expected[name]);
        cells["execute, after it ends"] = await observeEnded(
          () => read.execute(),
          result,
        );
        expectedCells["execute, after it ends"] =
          endedTransactionOutcome(context);
        cells["executeOn(root), after it ends"] = await observe(
          () => read.executeOn(backend),
          result,
        );
        expectedCells["executeOn(root), after it ends"] = "ok";
        cells["executeOn(engine transaction), after it ends"] = await observe(
          () =>
            backend.transaction((transaction) => read.executeOn(transaction)),
          result,
        );
        expectedCells["executeOn(engine transaction), after it ends"] = "ok";
      }
      for (const [name, run] of Object.entries(
        requireDefined(kept.terminals),
      )) {
        requireDefined(observed[name])["execute, after it ends"] =
          await observeEnded(run, rootResults.get(name));
        requireDefined(expected[name])["execute, after it ends"] =
          endedTransactionOutcome(context);
      }
      expect(observed).toEqual(expected);
    });
  });
}
