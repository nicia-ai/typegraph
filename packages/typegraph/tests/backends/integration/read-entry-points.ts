/**
 * Every read terminal runs through every entry point that accepts it.
 *
 * An entry point that accepts a read by type and then refuses it at run time
 * is a contract the caller cannot see. These cases run each read terminal —
 * node and edge selects, projections, relations, aggregates, set operations,
 * prepared forms, and the scalar, paging and streaming forms — through each
 * entry point: `execute()`, `store.batch()`, `store.batchOnce()`,
 * `executeOn()` with the root backend, with a transaction the caller opened
 * on the engine, and with a Store transaction's own backend, and, built
 * inside `store.transaction()`, through `execute()`, `tx.batchOnce()` and
 * `executeOn()`. Each cell must return what `execute()` on the root returns.
 *
 * The one refusal that stays is the one the target check exists for: a
 * relation-backed read built against a different database, or a read built
 * inside a transaction carried out of it, is refused before any statement.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { count, createStore, param as parameter } from "../../../src";
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

const BATCH_ONCE_REBIND_REFUSAL =
  "store.batchOnce() cannot rebind a read to a different database or transaction target.";

const TARGET_REFUSAL =
  "A relation cannot execute on a different database or transaction target.";

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
          .whereNode("p", (p) => p.name.eq("Bo"))
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
    return `refuses: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function seed(store: IntegrationStore): Promise<void> {
  const ada = await store.nodes.Person.create({ name: "Ada" });
  const bo = await store.nodes.Person.create({ name: "Bo" });
  await store.edges.knows.create(ada, bo, { since: "2020" });
}

export function registerReadEntryPointIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("read terminals through every entry point", () => {
    beforeEach(async () => {
      await seed(context.getStore());
    });

    it("a read built on the Store returns execute()'s result through every entry point", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const embeds = store.backend.capabilities.windowFunctions;
      const reads = targetableReads(store);

      const observed: Record<string, Record<string, string>> = {};
      const expected: Record<string, Record<string, string>> = {};
      for (const [name, read] of Object.entries(reads)) {
        const result = await read.execute();
        const cells: Record<string, () => Promise<unknown>> = {
          "store.batch": () =>
            store
              .batch(read as BatchableQuery, read as BatchableQuery)
              .then(([first]) => first),
          "executeOn(root)": () => read.executeOn(backend),
          "executeOn(engine transaction)": () =>
            backend.transaction((transaction) => read.executeOn(transaction)),
          "executeOn(Store transaction)": () =>
            store.transaction((tx) =>
              read.executeOn(tx[TRANSACTION_RUNTIME].backend),
            ),
          ...(embeds &&
            read.compileOneStatementBatchItem !== undefined && {
              "store.batchOnce": () =>
                store
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
      expect(observed).toEqual(expected);
    });

    it("a read built inside store.transaction() returns the root execute()'s result through every entry point", async () => {
      const store = context.getStore();
      const embeds = store.backend.capabilities.windowFunctions;
      const rootResults = new Map<string, unknown>();
      const storeReads = targetableReads(store);
      for (const [name, read] of Object.entries(storeReads))
        rootResults.set(name, await read.execute());
      for (const [name, run] of Object.entries(terminalReads(store)))
        rootResults.set(name, await run());

      const observed: Record<string, Record<string, string>> = {};
      const expected: Record<string, Record<string, string>> = {};
      await store.transaction(async (tx) => {
        for (const [name, read] of Object.entries(targetableReads(tx))) {
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
              `refuses: ${BATCH_ONCE_REBIND_REFUSAL}`;
          }
        for (const [name, run] of Object.entries(terminalReads(tx))) {
          observed[name] = {
            execute: await observe(run, rootResults.get(name)),
          };
          expected[name] = { execute: "ok" };
        }
      });
      expect(observed).toEqual(expected);
    });

    it("a relation-backed read built against a different database is refused before any statement", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const otherBackend = await context.createIsolatedBackend();
      // Building a query sends nothing, so the other database needs no tables.
      const otherStore = createStore(integrationTestGraph, otherBackend);
      const foreign: Readonly<Record<string, TargetableRead>> = {
        aggregate: otherStore
          .query()
          .from("Person", "p")
          .aggregate({ people: count("p") }),
        relation: otherStore
          .query()
          .from("Person", "p")
          .project((ctx) => ({ name: ctx.p.name }))
          .asRelation(),
      };
      const own = store
        .query()
        .from("Person", "p")
        .aggregate({ people: count("p") });
      const statements: string[] = [];
      const hooked = await context.createStore(integrationTestGraph, {
        hooks: {
          onQueryStart: (event) => {
            statements.push(event.sql);
          },
        },
      });

      const observed: Record<string, string> = {};
      for (const [name, read] of Object.entries(foreign)) {
        observed[`foreign ${name} executeOn(root)`] = await observe(
          () => read.executeOn(backend),
          undefined,
        );
        observed[`foreign ${name} executeOn(engine transaction)`] =
          await observe(
            () =>
              backend.transaction((transaction) => read.executeOn(transaction)),
            undefined,
          );
        observed[`foreign ${name} in store.batch`] = await observe(
          () => hooked.batch(read as BatchableQuery, read as BatchableQuery),
          undefined,
        );
      }
      observed["own aggregate executeOn(other engine transaction)"] =
        await observe(
          () =>
            otherBackend.transaction((transaction) =>
              own.executeOn(transaction),
            ),
          undefined,
        );
      // A read built inside a transaction does not run outside it.
      let escaped: TargetableRead | undefined;
      await store.transaction((tx) => {
        escaped = tx
          .query()
          .from("Person", "p")
          .aggregate({ people: count("p") });
        return Promise.resolve();
      });
      const escapedRead = escaped;
      if (escapedRead === undefined) throw new Error("no escaped read");
      observed["transaction aggregate executeOn(root)"] = await observe(
        () => escapedRead.executeOn(backend),
        undefined,
      );
      observed["transaction aggregate executeOn(engine transaction)"] =
        await observe(
          () =>
            backend.transaction((transaction) =>
              escapedRead.executeOn(transaction),
            ),
          undefined,
        );

      expect(observed).toEqual(
        Object.fromEntries(
          Object.keys(observed).map((cell) => [
            cell,
            `refuses: ${TARGET_REFUSAL}`,
          ]),
        ),
      );
      // The hooked batch opened its transaction and refused before the
      // first read's statement.
      expect(statements).toEqual([]);
    });
  });
}
