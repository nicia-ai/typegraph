/**
 * The compiler names what it generates in the `__tg` namespace: it renames a
 * subquery's aliases to `__tg_sq_<depth>_a<index>`, and names hidden result
 * columns `__tg_order_<n>`, `__tg_relation_order_<n>` and the like. A caller
 * name spelled like a generated one can meet it, so a caller name starting
 * with `__tg` in any letter case is refused before any SQL is sent: an alias
 * where a builder accepts it and again where a query AST is compiled, an
 * output key where it is declared.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { count, createStore, expr } from "../../../src";
import {
  ConfigurationError,
  SQL_IDENTIFIER_COLLISION_CODE,
  ValidationError,
} from "../../../src/errors";
import type { QueryAst, SetOperation } from "../../../src/query/ast";
import { compileQuery, compileSetOperation } from "../../../src/query/compiler";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationStore, integrationTestGraph } from "./fixtures";
import {
  createStatementCounter,
  type StatementCounter,
} from "./statement-counter";
import type { IntegrationTestContext } from "./test-context";

/** The spelling of the subquery's renamed start alias at depth 1. */
const GENERATED_SUBQUERY_ALIAS = "__tg_sq_1_a0";

/** Reserved spellings: the generated form, upper case, and mixed case with nothing after the prefix. */
const RESERVED_SPELLINGS = ["__tg_x", "__TG_x", "__Tg"] as const;

type Observation =
  | Readonly<{ kind: "rows"; names: readonly string[] }>
  | Readonly<{ kind: "refused"; error: string }>;

async function observe(
  run: () => Promise<readonly string[]>,
): Promise<Observation> {
  try {
    return { kind: "rows", names: [...(await run())].toSorted() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: "refused", error: error.name };
  }
}

/** The people someone else is older than, read through an outer alias. */
async function peopleWithSomeoneOlder(
  store: IntegrationStore,
  outerAlias: string,
): Promise<readonly string[]> {
  const rows = await store
    .query()
    .from("Person", outerAlias)
    .where((expressions) =>
      expressions.$exists((subquery, outer) =>
        subquery
          .from("Person", "older")
          .where((inner) =>
            expr.gt(inner.older.age, requireDefined(outer[outerAlias]).age),
          )
          .project((inner) => ({ id: inner.older.id })),
      ),
    )
    .project((expressions) => ({
      name: requireDefined(expressions[outerAlias]).name,
    }))
    .execute();
  return rows.map((row) => row.name);
}

type Refusal = Readonly<{
  name: string;
  message: string;
  codes: readonly (string | undefined)[];
}>;

function describeRefusal(error: unknown): Refusal {
  if (!(error instanceof Error)) throw error;
  return {
    name: error.name,
    message: error.message,
    codes:
      error instanceof ValidationError ?
        [...new Set(error.details.issues.map((issue) => issue.code))]
      : [],
  };
}

async function captureRefusal(
  action: () => unknown,
): Promise<Refusal | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return describeRefusal(error);
  }
}

function aliasRefusal(alias: string): Refusal {
  return {
    name: "ValidationError",
    message: `Invalid alias "${alias}": aliases starting with "__tg" in any letter case are reserved for names the library generates`,
    codes: [SQL_IDENTIFIER_COLLISION_CODE],
  };
}

const OUTPUT_KEY_REFUSAL: Refusal = {
  name: "ConfigurationError",
  message: "Projection output name is reserved.",
  codes: [],
};

const ALIAS_KEYS = new Set([
  "alias",
  "edgeAlias",
  "nodeAlias",
  "joinFromAlias",
  "targetAlias",
  "depthAlias",
  "pathAlias",
]);

/**
 * A copy of a query AST with one alias renamed everywhere the AST names it:
 * its declaration, every field reference, and the result columns and CTE
 * names derived from it. With the reserved-alias check removed, the copy
 * compiles like the original.
 */
function renameAlias<T>(value: T, from: string, to: string): T {
  function rename(entry: unknown, key: string | undefined): unknown {
    if (Array.isArray(entry)) return entry.map((item) => rename(item, key));
    if (typeof entry === "string") {
      if (key !== undefined && ALIAS_KEYS.has(key) && entry === from) return to;
      if (key === "outputName" && entry.startsWith(`${from}_`))
        return `${to}${entry.slice(from.length)}`;
      if (key === "cteAlias" && entry === `cte_${from}`) return `cte_${to}`;
      return entry;
    }
    if (typeof entry !== "object" || entry === null) return entry;
    const renamed: Record<string | symbol, unknown> = {};
    for (const [entryKey, child] of Object.entries(entry))
      renamed[entryKey] = rename(child, entryKey);
    for (const symbol of Object.getOwnPropertySymbols(entry))
      renamed[symbol] = (entry as Record<symbol, unknown>)[symbol];
    return renamed;
  }
  return rename(value, undefined) as T;
}

/** A legal recursive query whose aliases `k`, `f` and `d` the cases rename. */
function recursiveAst(store: IntegrationStore): QueryAst {
  return store
    .query()
    .from("Person", "p")
    .traverse("knows", "k")
    .recursive({ depth: "d" })
    .to("Person", "f")
    .whereNode("p", (person) => person.age.gt(1))
    .select((row) => ({ name: row.p.name, depth: row.d }))
    .toAst();
}

function standardAst(store: IntegrationStore, alias: string): QueryAst {
  return store
    .query()
    .from("Person", alias)
    .select((row) => ({ name: requireDefined(row[alias]).name }))
    .toAst();
}

export function registerReservedAliasPrefixIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Reserved __tg alias prefix", () => {
    it("refuses an outer alias spelled like a generated subquery alias instead of reading the subquery's own row", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Alice", age: 10 });
      await store.nodes.Person.create({ name: "Bob", age: 20 });

      // The same query under an ordinary alias: only Alice has someone older.
      expect(await observe(() => peopleWithSomeoneOlder(store, "p"))).toEqual({
        kind: "rows",
        names: ["Alice"],
      });

      // Before the prefix was reserved (#975), the subquery's own start alias
      // was renamed to the same spelling, so the outer reference read the
      // subquery's row and the query returned no rows.
      expect(
        await observe(() =>
          peopleWithSomeoneOlder(store, GENERATED_SUBQUERY_ALIAS),
        ),
      ).toEqual({ kind: "refused", error: "ValidationError" });
    });

    describe("where a builder accepts an alias", () => {
      let counter: StatementCounter;
      let store: IntegrationStore;

      beforeEach(() => {
        counter = createStatementCounter(context.getStore().backend);
        store = createStore(
          integrationTestGraph,
          counter.backend,
        ) as IntegrationStore;
      });

      const entryPoints: readonly Readonly<{
        name: string;
        build: (store: IntegrationStore, alias: string) => unknown;
      }>[] = [
        {
          name: "from()",
          build: (store, alias) => store.query().from("Person", alias),
        },
        {
          name: "fromDynamic()",
          build: (store, alias) => store.query().fromDynamic("Person", alias),
        },
        {
          name: "traverse() edge alias",
          build: (store, alias) =>
            store.query().from("Person", "p").traverse("knows", alias),
        },
        {
          name: "optionalTraverse() edge alias",
          build: (store, alias) =>
            store.query().from("Person", "p").optionalTraverse("knows", alias),
        },
        {
          name: "traverseDynamic() edge alias",
          build: (store, alias) =>
            store.query().from("Person", "p").traverseDynamic("knows", alias),
        },
        {
          name: "optionalTraverseDynamic() edge alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .optionalTraverseDynamic("knows", alias),
        },
        {
          name: "to() node alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .traverse("knows", "k")
              .to("Person", alias),
        },
        {
          name: "toDynamic() node alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .traverse("knows", "k")
              .toDynamic("Person", alias),
        },
        {
          name: "toKindSet() node alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .traverse("knows", "k")
              .toKindSet(["Person"], alias),
        },
        {
          name: "recursive() depth alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .traverse("knows", "k")
              .recursive({ depth: alias }),
        },
        {
          name: "recursive() path alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .traverse("knows", "k")
              .recursive({ path: alias }),
        },
        {
          name: "parts() node alias",
          build: (store, alias) =>
            store.query().from("Person", "p").parts(alias),
        },
        {
          name: "wholes() node alias",
          build: (store, alias) =>
            store.query().from("Person", "p").wholes(alias),
        },
        {
          name: "$exists() subquery alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .where((expressions) =>
                expressions.$exists((subquery) =>
                  subquery
                    .from("Person", alias)
                    .project(() => ({ one: expr.literal(1) })),
                ),
              ),
        },
        {
          name: "$scalar() subquery alias",
          build: (store, alias) =>
            store
              .query()
              .from("Person", "p")
              .project((expressions) => ({
                one: expressions.$scalar((subquery) =>
                  subquery
                    .from("Person", alias)
                    .project(() => ({ one: expr.literal(1) }))
                    .limit(1),
                ),
              })),
        },
      ];

      for (const { name, build } of entryPoints) {
        it(`refuses a reserved ${name} in any letter case`, async () => {
          for (const alias of RESERVED_SPELLINGS) {
            expect(await captureRefusal(() => build(store, alias))).toEqual(
              aliasRefusal(alias),
            );
          }
          expect(counter.count()).toBe(0);
        });
      }
    });

    describe("where a query AST is compiled", () => {
      const cases: readonly Readonly<{
        name: string;
        compile: (store: IntegrationStore, alias: string) => unknown;
      }>[] = [
        {
          name: "a start alias",
          compile: (store, alias) =>
            compileQuery(
              renameAlias(standardAst(store, "p"), "p", alias),
              store.graphId,
              store.backend.dialect,
            ),
        },
        {
          name: "a traversal edge alias",
          compile: (store, alias) =>
            compileQuery(
              renameAlias(recursiveAst(store), "k", alias),
              store.graphId,
              store.backend.dialect,
            ),
        },
        {
          name: "a traversal node alias",
          compile: (store, alias) =>
            compileQuery(
              renameAlias(recursiveAst(store), "f", alias),
              store.graphId,
              store.backend.dialect,
            ),
        },
        {
          name: "a recursive depth alias",
          compile: (store, alias) =>
            compileQuery(
              renameAlias(recursiveAst(store), "d", alias),
              store.graphId,
              store.backend.dialect,
            ),
        },
        {
          name: "a set-operation leaf alias",
          compile: (store, alias) => {
            const operation: SetOperation = {
              __type: "set_operation",
              operator: "union",
              left: standardAst(store, "p"),
              right: renameAlias(standardAst(store, "p"), "p", alias),
            };
            return compileSetOperation(
              operation,
              store.graphId,
              store.backend.dialect,
            );
          },
        },
        {
          name: "a subquery alias",
          compile: (store, alias) =>
            compileQuery(
              renameAlias(
                store
                  .query()
                  .from("Person", "p")
                  .where((expressions) =>
                    expressions.$exists((subquery) =>
                      subquery
                        .from("Person", "sub")
                        .project((inner) => ({ id: inner.sub.id })),
                    ),
                  )
                  .select((row) => ({ name: row.p.name }))
                  .toAst(),
                "sub",
                alias,
              ),
              store.graphId,
              store.backend.dialect,
            ),
        },
      ];

      for (const { name, compile } of cases) {
        it(`refuses ${name} in the reserved namespace in any letter case`, async () => {
          const store = context.getStore();
          // The unrenamed query compiles.
          expect(await captureRefusal(() => compile(store, "zz"))).toBe(
            undefined,
          );
          for (const alias of RESERVED_SPELLINGS) {
            expect(await captureRefusal(() => compile(store, alias))).toEqual(
              aliasRefusal(alias),
            );
          }
        });
      }

      it("does not refuse the aliases the compiler renames a subquery's recursive stages to", async () => {
        const store = context.getStore();
        await store.nodes.Person.create({ name: "Alice", age: 10 });
        // A recursive chain in a subquery compiles each fixed stage as a
        // statement of its own, under the aliases the compiler renamed the
        // subquery's aliases to; only the caller's aliases are checked.
        const rows = await store
          .query()
          .from("Person", "p")
          .where((expressions) =>
            expressions.$exists((subquery) =>
              subquery
                .from("Person", "x")
                .traverse("knows", "first")
                .to("Person", "m")
                .traverse("knows", "second")
                .recursive()
                .to("Person", "y")
                .project((inner) => ({ id: inner.y.id })),
            ),
          )
          .project((expressions) => ({ name: expressions.p.name }))
          .execute();
        expect(rows).toEqual([]);
      });
    });

    describe("where an output key is declared", () => {
      const declarations: readonly Readonly<{
        name: string;
        declare: (store: IntegrationStore, key: string) => unknown;
      }>[] = [
        {
          name: "project()",
          declare: (store, key) =>
            store
              .query()
              .from("Person", "p")
              .project((row) => ({ [key]: row.p.name })),
        },
        {
          name: "aggregate()",
          declare: (store, key) =>
            store
              .query()
              .from("Person", "p")
              .aggregate({ [key]: count("p") }),
        },
        {
          name: "relation project()",
          declare: (store, key) =>
            store
              .query()
              .from("Person", "p")
              .project((row) => ({ name: row.p.name }))
              .asRelation()
              .project((columns) => ({ [key]: columns.name })),
        },
        {
          name: "relation aggregate()",
          declare: (store, key) =>
            store
              .query()
              .from("Person", "p")
              .project((row) => ({ name: row.p.name }))
              .asRelation()
              .aggregate((columns) => ({ [key]: expr.count(columns.name) })),
        },
      ];

      for (const { name, declare } of declarations) {
        it(`refuses a ${name} key in the reserved namespace in any letter case`, async () => {
          const store = context.getStore();
          for (const key of [...RESERVED_SPELLINGS, "__tg_relation_order_0"]) {
            expect(await captureRefusal(() => declare(store, key))).toEqual(
              OUTPUT_KEY_REFUSAL,
            );
          }
          expect(
            await captureRefusal(() => declare(store, "tg_ordinary")),
          ).toBe(undefined);
        });
      }

      it("names the refused key", async () => {
        const store = context.getStore();
        const error = await captureError(() =>
          store
            .query()
            .from("Person", "p")
            .project((row) => ({ name: row.p.name }))
            .asRelation()
            .project((columns) => ({ __TG_relation_order_0: columns.name })),
        );
        expect(error).toBeInstanceOf(ConfigurationError);
        expect((error as ConfigurationError).details).toEqual({
          outputName: "__TG_relation_order_0",
        });
      });
    });
  });
}

async function captureError(action: () => unknown): Promise<unknown> {
  try {
    await action();
    return undefined;
  } catch (error) {
    return error;
  }
}
