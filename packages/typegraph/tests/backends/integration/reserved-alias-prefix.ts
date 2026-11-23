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
import { backendDerivationRoot } from "../../../src/backend/derive-backend";
import {
  ConfigurationError,
  SQL_IDENTIFIER_COLLISION_CODE,
  ValidationError,
} from "../../../src/errors";
import {
  ExecutableAggregateQuery,
  ExecutableProjectionQuery,
  ExecutableRelationQuery,
  QueryBuilder,
} from "../../../src/query";
import type { QueryAst, SetOperation } from "../../../src/query/ast";
import { buildCompileOptions } from "../../../src/query/builder/compile-options";
import type { RelationDefinition } from "../../../src/query/builder/relation";
import type {
  QueryBuilderConfig,
  QueryBuilderState,
} from "../../../src/query/builder/types";
import { compileQuery, compileSetOperation } from "../../../src/query/compiler";
import type { DatabaseExpression } from "../../../src/query/expressions";
import { schemaIntrospectorFor } from "../../../src/query/schema-introspector";
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

/** The configuration a query builder is constructed with, built here instead of by a store. */
function standaloneQueryConfig(store: IntegrationStore): QueryBuilderConfig {
  return {
    graphId: store.graphId,
    registry: store.registry,
    schemaIntrospector: schemaIntrospectorFor(store.registry),
    defaultTraversalExpansion: "inverse",
    defaultExpansion: "subclasses",
    identityEnabled: false,
    identitySameIdAcrossKinds: "fold",
    backend: store.backend,
    dialect: store.backend.dialect,
  };
}

/** A query builder state with no source, as a store's builder starts. */
const INITIAL_STATE: QueryBuilderState = {
  startAlias: "",
  currentAlias: "",
  startKinds: [],
  startRequestedKinds: [],
  startExpansion: "exact",
  traversals: [],
  predicates: [],
  projection: [],
  orderBy: [],
  aggregateOrderBy: [],
  limit: undefined,
  offset: undefined,
  temporalMode: "current",
  asOf: undefined,
  recordedAsOf: undefined,
  groupBy: undefined,
  having: undefined,
  fusion: undefined,
  dynamicNodeAliases: new Set(),
  dynamicEdgeAliases: new Set(),
};

/**
 * The state behind a query AST, with every output key renamed by `rename`:
 * what a caller hands a public query constructor instead of declaring the
 * keys through `project()` or `aggregate()`.
 */
function stateFromAst(
  ast: QueryAst,
  rename: (outputName: string) => string,
): QueryBuilderState {
  return {
    ...INITIAL_STATE,
    startAlias: ast.start.alias,
    currentAlias: ast.start.alias,
    startKinds: ast.start.kinds,
    startRequestedKinds: ast.start.kinds,
    startExpansion: ast.start.expansion,
    traversals: ast.traversals,
    projection: ast.projection.fields.map((field) => ({
      ...field,
      outputName: rename(field.outputName),
    })),
    orderBy: ast.orderBy ?? [],
    groupBy: ast.groupBy,
  };
}

/**
 * A query over Person rows handed straight to a public query constructor
 * with its one output key named `key`, past the `project()` and
 * `aggregate()` key checks.
 */
const RAW_STATE_QUERIES: readonly Readonly<{
  name: string;
  build: (
    store: IntegrationStore,
    key: string,
  ) => Readonly<{
    execute: () => Promise<readonly unknown[]>;
  }>;
}>[] = [
  {
    name: "ExecutableProjectionQuery",
    build: (store, key) => {
      const config = standaloneQueryConfig(store);
      const projection = new QueryBuilder<typeof integrationTestGraph>(
        config,
        INITIAL_STATE,
      )
        .from("Person", "p")
        .project((fields) => ({ name: fields.p.name }));
      const name = requireDefined(projection.getExpressionProjection()[0]);
      return new ExecutableProjectionQuery(
        config,
        stateFromAst(
          projection.orderBy((fields) => fields.p.name).toAst(),
          () => key,
        ),
        { [key]: name.expression },
        () => ({}),
      );
    },
  },
  {
    name: "ExecutableAggregateQuery",
    build: (store, key) => {
      const config = standaloneQueryConfig(store);
      const ast = new QueryBuilder<typeof integrationTestGraph>(
        config,
        INITIAL_STATE,
      )
        .from("Person", "p")
        .aggregate({ total: count("p") })
        .toAst();
      return new ExecutableAggregateQuery(
        config,
        stateFromAst(ast, () => key),
        { [key]: count("p") },
      );
    },
  },
];

type RawRelationFields = Readonly<Record<string, DatabaseExpression>>;
type RawRelationDefinition = RelationDefinition<
  RawRelationFields,
  Record<string, unknown>
>;
type RawRelation = ExecutableRelationQuery<
  RawRelationFields,
  Record<string, unknown>
>;

/**
 * Decodes a Product relation row: the category and the price under
 * `priceKey`, without the hidden ordering columns beside them (PostgreSQL
 * returns the raw numeric price as text).
 */
function decodeProductRow(
  row: Record<string, unknown>,
  priceKey: string,
): Record<string, unknown> {
  return { category: row["category"], [priceKey]: Number(row[priceKey]) };
}

/**
 * A relation over Product rows whose definition is handed straight to the
 * public `ExecutableRelationQuery` constructor, past every builder check: a
 * source query projecting `category` and `price`, passed through `change`
 * before construction.
 */
function relationFromDefinition(
  store: IntegrationStore,
  change: (definition: RawRelationDefinition) => RawRelationDefinition,
): RawRelation {
  const backend = store.backend;
  const config = standaloneQueryConfig(store);
  const query = store
    .query()
    .from("Product", "product")
    .project((fields) => ({
      category: fields.product.category,
      price: fields.product.price,
    }))
    .toAst();
  return new ExecutableRelationQuery(
    change({
      ast: {
        kind: "source",
        query,
        graphId: store.graphId,
        options: buildCompileOptions(config),
      },
      columns: [
        { outputName: "category", valueType: "string", nullable: false },
        { outputName: "price", valueType: "number", nullable: false },
      ],
      fields: {},
      config,
      provenance: {
        graphId: store.graphId,
        executionTarget: backendDerivationRoot(backend),
        recordedAsOf: undefined,
        checked: false,
        temporalCoordinate: JSON.stringify(query.temporalMode),
      },
      decodeRow: (row) => decodeProductRow(row, "price"),
    }),
  );
}

/** Adds an output key that no relation column names to a raw relation definition's source query. */
function addHiddenSourceKey(
  definition: RawRelationDefinition,
  key: string,
): RawRelationDefinition {
  if (definition.ast.kind !== "source") throw new Error("expected a source");
  const { query } = definition.ast;
  const price = requireDefined(query.projection.fields[1]);
  return {
    ...definition,
    ast: {
      ...definition.ast,
      query: {
        ...query,
        projection: {
          ...query.projection,
          fields: [...query.projection.fields, { ...price, outputName: key }],
        },
      },
    },
  };
}

/** Renames the `price` column of a raw relation definition everywhere it is named. */
function renamePriceColumn(
  definition: RawRelationDefinition,
  priceKey: string,
): RawRelationDefinition {
  if (definition.ast.kind !== "source") throw new Error("expected a source");
  const { query } = definition.ast;
  return {
    ...definition,
    ast: {
      ...definition.ast,
      query: {
        ...query,
        projection: {
          ...query.projection,
          fields: query.projection.fields.map((projected) =>
            projected.outputName === "price" ?
              { ...projected, outputName: priceKey }
            : projected,
          ),
        },
      },
    },
    columns: definition.columns.map((column) =>
      column.outputName === "price" ?
        { ...column, outputName: priceKey }
      : column,
    ),
    decodeRow: (row) => decodeProductRow(row, priceKey),
  };
}

/** The highest-priced row of each category. */
function topPricePerCategory(
  relation: RawRelation,
  priceKey: string,
): RawRelation {
  return relation
    .topPerPartition({
      partitionBy: (columns) => [requireDefined(columns["category"])],
      orderBy: (columns) => [
        { expression: requireDefined(columns[priceKey]), direction: "desc" },
      ],
      limit: 1,
    })
    .orderBy((columns) => requireDefined(columns["category"]));
}

/** Two categories of products; the highest price is 20 in A and 30 in B. */
async function createProducts(store: IntegrationStore): Promise<void> {
  for (const product of [
    { name: "a-low", category: "A", price: 10 },
    { name: "a-high", category: "A", price: 20 },
    { name: "b-high", category: "B", price: 30 },
  ])
    await store.nodes.Product.create(product);
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

      it("refuses a malformed alias in the reserved namespace with the same refusal from the builder and the compiler", async () => {
        const store = context.getStore();
        for (const alias of [
          "__tg-bad",
          "__TG bad",
          `__tg_${"x".repeat(70)}`,
        ]) {
          const fromBuilder = await captureRefusal(() =>
            store.query().from("Person", alias),
          );
          const fromCompiler = await captureRefusal(() =>
            compileQuery(
              renameAlias(standardAst(store, "p"), "p", alias),
              store.graphId,
              store.backend.dialect,
            ),
          );
          expect(fromBuilder).toEqual(aliasRefusal(alias));
          expect(fromCompiler).toEqual(aliasRefusal(alias));
        }
      });

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

    describe("where a relation definition is compiled", () => {
      it("refuses a visible column spelled like the hidden partition rank instead of returning the wrong rows", async () => {
        const store = context.getStore();
        await createProducts(store);

        // The same definition under an ordinary column name ranks correctly.
        const control = relationFromDefinition(store, (definition) =>
          renamePriceColumn(definition, "rank"),
        );
        expect(await topPricePerCategory(control, "rank").execute()).toEqual([
          { category: "A", rank: 20 },
          { category: "B", rank: 30 },
        ]);

        // A definition handed to the public constructor skips the builder's
        // key checks. Named like the rank column topPerPartition() adds, the
        // visible column met it: SQLite returned no rows and PostgreSQL
        // refused an ambiguous column.
        const reserved = relationFromDefinition(store, (definition) =>
          renamePriceColumn(definition, "__tg_partition_rank"),
        );
        expect(
          await captureRefusal(() =>
            topPricePerCategory(reserved, "__tg_partition_rank").execute(),
          ),
        ).toEqual(OUTPUT_KEY_REFUSAL);
      });

      const terminals: readonly Readonly<{
        name: string;
        run: (relation: RawRelation) => unknown;
      }>[] = [
        { name: "execute()", run: (relation) => relation.execute() },
        { name: "compile()", run: (relation) => relation.compile() },
        { name: "prepare()", run: (relation) => relation.prepare() },
        { name: "count()", run: (relation) => relation.count() },
        { name: "exists()", run: (relation) => relation.exists() },
      ];

      for (const { name, run } of terminals) {
        it(`refuses a reserved visible column in any letter case at ${name}`, async () => {
          const store = context.getStore();
          expect(
            await captureRefusal(() =>
              run(
                relationFromDefinition(store, (definition) =>
                  renamePriceColumn(definition, "rank"),
                ),
              ),
            ),
          ).toBe(undefined);
          for (const key of RESERVED_SPELLINGS) {
            expect(
              await captureRefusal(() =>
                run(
                  relationFromDefinition(store, (definition) =>
                    renamePriceColumn(definition, key),
                  ),
                ),
              ),
            ).toEqual(OUTPUT_KEY_REFUSAL);
          }
        });
      }

      it("refuses a reserved output key of a source query that no relation column names", async () => {
        const store = context.getStore();
        await createProducts(store);
        expect(
          await relationFromDefinition(store, (definition) =>
            addHiddenSourceKey(definition, "spare"),
          )
            .orderBy((columns) => requireDefined(columns["price"]))
            .execute(),
        ).toEqual([
          { category: "A", price: 10 },
          { category: "A", price: 20 },
          { category: "B", price: 30 },
        ]);
        for (const key of [...RESERVED_SPELLINGS, "__tg_partition_rank"]) {
          expect(
            await captureRefusal(() =>
              relationFromDefinition(store, (definition) =>
                addHiddenSourceKey(definition, key),
              ).execute(),
            ),
          ).toEqual(OUTPUT_KEY_REFUSAL);
        }
      });

      it("refuses a reserved key in a set operand's source", async () => {
        const store = context.getStore();
        const left = relationFromDefinition(store, (definition) => definition);
        expect(
          await captureRefusal(() =>
            left
              .union(
                relationFromDefinition(store, (definition) =>
                  addHiddenSourceKey(definition, "spare"),
                ),
              )
              .execute(),
          ),
        ).toBe(undefined);
        expect(
          await captureRefusal(() =>
            left
              .union(
                relationFromDefinition(store, (definition) =>
                  addHiddenSourceKey(definition, "__tg_x"),
                ),
              )
              .execute(),
          ),
        ).toEqual(OUTPUT_KEY_REFUSAL);
      });
    });

    describe("where a query state is handed to a public constructor", () => {
      for (const { name, build } of RAW_STATE_QUERIES) {
        it(`refuses a reserved ${name} output key in any letter case`, async () => {
          const store = context.getStore();
          await store.nodes.Person.create({ name: "Alice", age: 10 });
          expect(
            await captureRefusal(() => build(store, "label").execute()),
          ).toBe(undefined);
          for (const key of [...RESERVED_SPELLINGS, "__tg_order_0"]) {
            expect(
              await captureRefusal(() => build(store, key).execute()),
            ).toEqual(OUTPUT_KEY_REFUSAL);
          }
        });
      }
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
