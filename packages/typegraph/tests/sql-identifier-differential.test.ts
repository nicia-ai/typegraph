/**
 * The SQL-name guard against the unguarded compiler, on SQLite and PGlite side
 * by side. For each generated standard query over colliding and
 * near-colliding aliases:
 *
 * - with the guard, every engine returns a typed refusal or exactly the right
 *   row, and both engines reach the same verdict;
 * - a query the unguarded compiler answers correctly on both engines is not
 *   refused — the guard refuses only statements that fail, or return another
 *   value's data, on at least one engine.
 *
 * The guard is disabled by replacing `refuseConflictingSqlNames`, the one
 * function every standard-path entry point calls to apply the verdict, with a
 * pass-through for the unguarded runs.
 *
 * Shapes cover selections, projections, HAVING with a field on either side of
 * a comparison, every legacy aggregate, an ordered aggregate and an aggregate
 * beside an edge filtered on its source id. Output keys never differ only by
 * letter case here: `aggregate()` and `project()` refuse such keys where
 * they are declared, a deliberate restriction outside this guard.
 *
 * Set operations are generated separately: UNION, UNION ALL, INTERSECT and
 * EXCEPT trees up to two levels deep over fan-out leaves with independently
 * drawn aliases, with ORDER BY and LIMIT on the outer or a nested compound.
 * The compound takes its column names from its leftmost leaf; the other
 * leaves' names are matched by position, so a collision among them must not
 * refuse the statement.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  avg,
  count,
  countDistinct,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  havingGt,
  max,
  min,
  type Store,
  sum,
} from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
  ValidationError,
} from "../src/errors";
import type {
  ComposableQuery,
  PredicateExpression,
  QueryAst,
  SetOperation,
  SetOperationType,
} from "../src/query/ast";
import { compileSetOperation } from "../src/query/compiler";
import type * as SqlNameRegistry from "../src/query/compiler/sql-name-registry";
import { fieldRef } from "../src/query/predicates";
import { requireDefined } from "../src/utils/presence";

const guard = vi.hoisted(() => ({ enabled: true }));

vi.mock("../src/query/compiler/sql-name-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof SqlNameRegistry>();
  return {
    ...actual,
    refuseConflictingSqlNames: (
      ...args: Parameters<typeof actual.refuseConflictingSqlNames>
    ) => {
      if (guard.enabled) actual.refuseConflictingSqlNames(...args);
    },
  };
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "sql_identifier_differential",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type DifferentialStore = Store<typeof graph>;

type Engine = Readonly<{
  name: "sqlite" | "pglite";
  dialect: "sqlite" | "postgres";
  backend: GraphBackend;
  store: DifferentialStore;
  aliceId: string;
  bobId: string;
  knowsId: string;
}>;

/** Two 60-character aliases that share their first 59 characters. */
const CLIPPED_TWIN_A = `${"a".repeat(59)}1`;
const CLIPPED_TWIN_B = `${"a".repeat(59)}2`;

const ALIAS_POOL = [
  "p",
  "P",
  "e",
  "E",
  "e_from",
  "E_from",
  "e_to",
  "e_id",
  "item",
  "Item",
  "p_edge",
  "k",
  "K",
  CLIPPED_TWIN_A,
  CLIPPED_TWIN_B,
  `r${"o".repeat(60)}`,
] as const;

const SHAPES = [
  "ids",
  "whole rows",
  "target name",
  "projected name",
  "edge and target",
  "having field on the right",
  "having field on the left",
  "having start id",
  "having legacy aggregate",
  "legacy aggregates",
  "ordered aggregate",
  "max beside edge filtered on fromId",
] as const;
type Shape = (typeof SHAPES)[number];

type Outcome =
  | Readonly<{ kind: "refused"; typed: boolean }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "rows"; rows: readonly unknown[] }>;

type Row = Readonly<{ id: unknown; name?: unknown }>;
type Context = Readonly<Record<string, Row>>;

function idOf(value: unknown): unknown {
  return typeof value === "object" && value !== null ?
      (value as { id?: unknown }).id
    : value;
}

/** A comparison of two fields, as HAVING compiles it. */
function fieldComparison(
  left: ReturnType<typeof fieldRef>,
  right: ReturnType<typeof fieldRef>,
): PredicateExpression {
  return { __type: "comparison", op: "neq", left, right };
}

function nameOf(alias: string) {
  return fieldRef(alias, ["props", "name"], { valueType: "string" });
}

function idOfAlias(alias: string) {
  return fieldRef(alias, ["id"], { valueType: "string" });
}

/**
 * Aggregate values as both engines agree on them: PostgreSQL returns some
 * numeric aggregates as decimal text.
 */
function normalizeRows(rows: readonly unknown[]): readonly unknown[] {
  return rows.map((row) =>
    typeof row === "object" && row !== null ?
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value) ?
            Number(value)
          : value,
        ]),
      )
    : row,
  );
}

function runQuery(
  engine: Engine,
  aliases: readonly [string, string, string],
  shape: Shape,
): Promise<readonly unknown[]> {
  return runQueryRows(engine, aliases, shape).then((rows) =>
    normalizeRows(rows),
  );
}

function runQueryRows(
  engine: Engine,
  [start, edge, target]: readonly [string, string, string],
  shape: Shape,
): Promise<readonly unknown[]> {
  // Runtime aliases: each is typed as a distinct placeholder literal.
  const typedTarget = target as "differential_target";
  const typedStart = start as "differential_start";
  const typedEdge = edge as "differential_edge";
  const query = engine.store
    .query()
    .fromDynamic("Person", start as "differential_start")
    .whereNode(start as "differential_start", (person) =>
      person.id.eq(engine.aliceId),
    )
    .traverseDynamic("knows", edge as "differential_edge")
    .toDynamic("Person", target as "differential_target");
  switch (shape) {
    case "ids": {
      return query
        .select((ctx: Context) => ({
          start: requireDefined(ctx[start]).id,
          edge: requireDefined(ctx[edge]).id,
          target: requireDefined(ctx[target]).id,
        }))
        .execute();
    }
    case "whole rows": {
      return query
        .select((ctx: Context) => ({
          start: idOf(requireDefined(ctx[start])),
          startName: requireDefined(ctx[start]).name,
          edge: idOf(requireDefined(ctx[edge])),
          target: idOf(requireDefined(ctx[target])),
          targetName: requireDefined(ctx[target]).name,
        }))
        .execute();
    }
    case "target name": {
      return query
        .select((ctx: Context) => ({ name: requireDefined(ctx[target]).name }))
        .execute();
    }
    case "projected name": {
      return query
        .project(
          (ctx) =>
            ({
              name: requireDefined((ctx as unknown as Context)[target]).name,
            }) as never,
        )
        .execute();
    }
    case "edge and target": {
      return query
        .project(
          (ctx) =>
            ({
              edge: requireDefined((ctx as unknown as Context)[edge]).id,
              name: requireDefined((ctx as unknown as Context)[target]).name,
            }) as never,
        )
        .execute();
    }
    case "having field on the right": {
      return query
        .groupByNode(typedTarget)
        .groupBy(typedTarget, "name")
        .having(fieldComparison(nameOf(target), idOfAlias(target)))
        .aggregate({
          name: field(typedTarget, "name"),
          edges: count(typedEdge),
        })
        .execute();
    }
    case "having field on the left": {
      return query
        .groupByNode(typedTarget)
        .groupBy(typedTarget, "name")
        .having(fieldComparison(idOfAlias(target), nameOf(target)))
        .aggregate({
          name: field(typedTarget, "name"),
          edges: count(typedEdge),
        })
        .execute();
    }
    case "having start id": {
      return query
        .groupByNode(typedStart)
        .groupByNode(typedTarget)
        .groupBy(typedTarget, "name")
        .having(fieldComparison(idOfAlias(start), idOfAlias(target)))
        .aggregate({
          name: field(typedTarget, "name"),
          edges: count(typedEdge),
        })
        .execute();
    }
    case "having legacy aggregate": {
      return query
        .groupBy(typedStart, "name")
        .having(havingGt(count(typedTarget), 0))
        .aggregate({
          name: field(typedStart, "name"),
          friends: count(typedTarget),
        })
        .execute();
    }
    case "legacy aggregates": {
      return query
        .groupBy(typedStart, "name")
        .aggregate({
          name: field(typedStart, "name"),
          friends: count(typedTarget),
          edges: countDistinct(typedEdge),
          oldest: max(typedTarget, "age"),
          youngest: min(typedTarget, "age"),
          total: sum(typedTarget, "age"),
          mean: avg(typedTarget, "age"),
        })
        .execute();
    }
    case "ordered aggregate": {
      return query
        .groupBy(typedStart, "name")
        .aggregate({
          name: field(typedStart, "name"),
          oldest: max(typedTarget, "age"),
        })
        .orderBy("oldest", "desc")
        .limit(1)
        .execute();
    }
    case "max beside edge filtered on fromId": {
      return engine.store
        .query()
        .fromDynamic("Person", start as "differential_start")
        .traverseDynamic("knows", edge as "differential_edge")
        .whereEdge(typedEdge, (knowsEdge) =>
          knowsEdge.fromId.eq(engine.aliceId),
        )
        .toDynamic("Person", typedTarget)
        .aggregate({ age: max(typedTarget, "age") })
        .execute();
    }
  }
}

function expectedRows(engine: Engine, shape: Shape): readonly unknown[] {
  switch (shape) {
    case "ids": {
      return [
        { start: engine.aliceId, edge: engine.knowsId, target: engine.bobId },
      ];
    }
    case "whole rows": {
      return [
        {
          start: engine.aliceId,
          startName: "Alice",
          edge: engine.knowsId,
          target: engine.bobId,
          targetName: "Bob",
        },
      ];
    }
    case "target name":
    case "projected name": {
      return [{ name: "Bob" }];
    }
    case "edge and target": {
      return [{ edge: engine.knowsId, name: "Bob" }];
    }
    case "having field on the right":
    case "having field on the left":
    case "having start id": {
      return [{ name: "Bob", edges: 1 }];
    }
    case "having legacy aggregate": {
      return [{ name: "Alice", friends: 1 }];
    }
    case "legacy aggregates": {
      return [
        {
          name: "Alice",
          friends: 1,
          edges: 1,
          oldest: 41,
          youngest: 41,
          total: 41,
          mean: 41,
        },
      ];
    }
    case "ordered aggregate": {
      return [{ name: "Alice", oldest: 41 }];
    }
    case "max beside edge filtered on fromId": {
      return [{ age: 41 }];
    }
  }
}

async function outcomeOf(
  run: () => Promise<readonly unknown[]>,
): Promise<Outcome> {
  try {
    return { kind: "rows", rows: await run() };
  } catch (error) {
    if (error instanceof ValidationError)
      return {
        kind: "refused",
        typed: error.details.issues.every(
          (issue) =>
            issue.code === SQL_IDENTIFIER_COLLISION_CODE ||
            issue.code === SQL_IDENTIFIER_TOO_LONG_CODE,
        ),
      };
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isExactlyRight(
  outcome: Outcome,
  engine: Engine,
  shape: Shape,
): boolean {
  return (
    outcome.kind === "rows" &&
    JSON.stringify(outcome.rows) === JSON.stringify(expectedRows(engine, shape))
  );
}

async function seedEngine(
  name: Engine["name"],
  dialect: Engine["dialect"],
  backend: GraphBackend,
): Promise<Engine> {
  const [store] = await createStoreWithSchema(graph, backend);
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob", age: 41 });
  const edge = await store.edges.knows.create(alice, bob, {});
  // The set-operation leaves start at `sa` or `sb`; every other shape starts
  // at Alice or filters on her id, so these rows do not reach it. Ids are
  // lowercase letters, which every collation orders alike, and edge ids sort
  // in the opposite order to their targets' ids, so ordering by an edge's id
  // where a target's id was asked for returns the rows in another order.
  const setA = await store.nodes.Person.create({ name: "SetA" }, { id: "sa" });
  const setB = await store.nodes.Person.create({ name: "SetB" }, { id: "sb" });
  const setC = await store.nodes.Person.create({ name: "SetC" }, { id: "sc" });
  await store.edges.knows.create(setA, setB, {}, { id: "ez" });
  await store.edges.knows.create(setA, setC, {}, { id: "ey" });
  await store.edges.knows.create(setB, setC, {}, { id: "ex" });
  return {
    name,
    dialect,
    backend,
    store,
    aliceId: alice.id,
    bobId: bob.id,
    knowsId: edge.id,
  };
}

// ============================================================
// Set operations
// ============================================================

/** Start, first edge, first target, second edge (also from start), second target. */
type LeafAliases = readonly [string, string, string, string, string];
type LeafStart = "sa" | "sb" | "both";
type SetLeaf = Readonly<{ aliases: LeafAliases; start: LeafStart }>;
type SetOrder = Readonly<{ direction: "asc" | "desc"; limit?: number }>;
type SetTree =
  | Readonly<{ kind: "leaf"; leaf: SetLeaf }>
  | Readonly<{
      kind: "op";
      operator: SetOperationType;
      left: SetTree;
      right: SetTree;
      order?: SetOrder;
    }>;

/** Aliases that collide with nothing: the reference leaf's spelling. */
const PLAIN_LEAF_ALIASES: LeafAliases = ["s0", "x1", "n1", "x2", "n2"];

function leafQuery(engine: Engine, leaf: SetLeaf) {
  const [start, firstEdge, firstTarget, secondEdge, secondTarget] =
    leaf.aliases;
  const typedStart = start as "leaf_start";
  return engine.store
    .query()
    .fromDynamic("Person", typedStart)
    .whereNode(typedStart, (person) =>
      leaf.start === "both" ?
        person.id.in(["sa", "sb"])
      : person.id.eq(leaf.start),
    )
    .traverseDynamic("knows", firstEdge as "leaf_first_edge")
    .toDynamic("Person", firstTarget as "leaf_first_target")
    .traverseDynamic("knows", secondEdge as "leaf_second_edge", {
      from: typedStart,
    })
    .toDynamic("Person", secondTarget as "leaf_second_target")
    .select((ctx: Context) => requireDefined(ctx[start]).id);
}

/** Every compound below the root that has its own ORDER BY. */
function orderedNestedCompounds(
  tree: SetTree,
): readonly Extract<SetTree, { kind: "op" }>[] {
  if (tree.kind === "leaf") return [];
  return [tree.left, tree.right].flatMap((operand) => [
    ...(operand.kind === "op" && operand.order !== undefined ? [operand] : []),
    ...orderedNestedCompounds(operand),
  ]);
}

/**
 * Compounds that read a leaf's names the way `tree` does, over rows that
 * show them: the root's leftmost leaf, whose names its rows come back under,
 * and the leftmost leaf of each ordered nested compound, read by its ORDER BY
 * (compared by values: its names do not reach the caller).
 */
function nameProbes(
  tree: SetTree,
): readonly Readonly<{ probe: SetTree; names: "checked" | "values only" }>[] {
  function probe(leaf: SetLeaf, order?: SetOrder): SetTree {
    return {
      kind: "op",
      operator: "unionAll",
      left: { kind: "leaf", leaf: { aliases: leaf.aliases, start: "both" } },
      right: {
        kind: "leaf",
        leaf: { aliases: PLAIN_LEAF_ALIASES, start: "both" },
      },
      ...(order === undefined ? {} : { order: { direction: order.direction } }),
    };
  }
  return [
    { probe: probe(leftmostLeaf(tree)), names: "checked" },
    ...orderedNestedCompounds(tree).map((nested) => ({
      probe: probe(leftmostLeaf(nested), nested.order),
      names: "values only" as const,
    })),
  ];
}

function leftmostLeaf(tree: SetTree): SetLeaf {
  return tree.kind === "leaf" ? tree.leaf : leftmostLeaf(tree.left);
}

/**
 * Ordering by the leftmost leaf's first target, second target, start, first
 * edge and second edge ids. Any four of them identify a row, so the order
 * stays total even where an engine reads another column for one of them.
 */
function orderSpecs(tree: SetTree, direction: "asc" | "desc") {
  const [start, firstEdge, firstTarget, secondEdge, secondTarget] =
    leftmostLeaf(tree).aliases;
  return [firstTarget, secondTarget, start, firstEdge, secondEdge].map(
    (alias) => ({
      field: idOfAlias(alias),
      direction,
    }),
  );
}

function setOperationAst(engine: Engine, tree: SetTree): ComposableQuery {
  if (tree.kind === "leaf") return leafQuery(engine, tree.leaf).toAst();
  const ast: SetOperation = {
    __type: "set_operation",
    operator: tree.operator,
    left: setOperationAst(engine, tree.left),
    right: setOperationAst(engine, tree.right),
    ...(tree.order === undefined ?
      {}
    : {
        orderBy: orderSpecs(tree, tree.order.direction),
        ...(tree.order.limit === undefined ? {} : { limit: tree.order.limit }),
      }),
  };
  return ast;
}

/** Runs a set operation the way `UnionableQuery` compiles it, returning raw rows. */
async function runSetOperation(
  engine: Engine,
  tree: SetTree,
): Promise<readonly unknown[]> {
  const ast = setOperationAst(engine, tree);
  if (!("__type" in ast))
    throw new Error("a set operation tree has an operator");
  return engine.backend.execute(
    compileSetOperation(ast, engine.store.graphId, { dialect: engine.dialect }),
  );
}

/** One raw row as its values in column order. */
type RowValues = readonly unknown[];

function rowKey(values: RowValues): string {
  return JSON.stringify(values);
}

function distinctRows(rows: readonly RowValues[]): readonly RowValues[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = rowKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The rows a set-operation tree must return, as column values, from the rows
 * of the reference leaf for each start: union, intersection and difference
 * over whole rows, then ordering and limit where the tree asks for them.
 */
function expectedSetRows(
  tree: SetTree,
  leafRows: ReadonlyMap<LeafStart, readonly RowValues[]>,
  orderColumns: readonly number[],
): readonly RowValues[] {
  if (tree.kind === "leaf")
    return requireDefined(leafRows.get(tree.leaf.start));
  const left = expectedSetRows(tree.left, leafRows, orderColumns);
  const right = expectedSetRows(tree.right, leafRows, orderColumns);
  const rightKeys = new Set(right.map((row) => rowKey(row)));
  const combined = (() => {
    switch (tree.operator) {
      case "union": {
        return distinctRows([...left, ...right]);
      }
      case "unionAll": {
        return [...left, ...right];
      }
      case "intersect": {
        return distinctRows(left.filter((row) => rightKeys.has(rowKey(row))));
      }
      case "except": {
        return distinctRows(left.filter((row) => !rightKeys.has(rowKey(row))));
      }
    }
  })();
  if (tree.order === undefined) return combined;
  const sign = tree.order.direction === "asc" ? 1 : -1;
  const ordered = combined.toSorted((first, second) => {
    for (const column of orderColumns) {
      const a = String(first[column]);
      const b = String(second[column]);
      if (a !== b) return a < b ? -sign : sign;
    }
    return 0;
  });
  return tree.order.limit === undefined ?
      ordered
    : ordered.slice(0, tree.order.limit);
}

function leafArbitrary(): fc.Arbitrary<SetLeaf> {
  const drawn = fc
    .uniqueArray(fc.constantFrom(...ALIAS_POOL), {
      minLength: 5,
      maxLength: 5,
    })
    .map((aliases) => aliases as unknown as LeafAliases);
  return fc.record({
    aliases: fc.oneof(
      { weight: 1, arbitrary: fc.constant(PLAIN_LEAF_ALIASES) },
      { weight: 3, arbitrary: drawn },
    ),
    start: fc.constantFrom<LeafStart>("sa", "sb", "both"),
  });
}

function orderArbitrary(): fc.Arbitrary<SetOrder | undefined> {
  return fc.oneof(
    fc.constant(undefined),
    fc.record(
      {
        direction: fc.constantFrom<"asc" | "desc">("asc", "desc"),
        limit: fc.integer({ min: 1, max: 3 }),
      },
      { requiredKeys: ["direction"] },
    ),
  );
}

function setTreeArbitrary(): fc.Arbitrary<SetTree> {
  const leaf = leafArbitrary().map((value): SetTree => ({
    kind: "leaf",
    leaf: value,
  }));
  const operator = fc.constantFrom<SetOperationType>(
    "union",
    "unionAll",
    "intersect",
    "except",
  );
  const operation = (operand: fc.Arbitrary<SetTree>) =>
    fc
      .record({
        operator,
        left: operand,
        right: operand,
        order: orderArbitrary(),
      })
      .map(({ order, ...rest }): SetTree => ({
        kind: "op",
        ...rest,
        ...(order === undefined ? {} : { order }),
      }));
  const nested = operation(
    fc.oneof({ weight: 2, arbitrary: leaf }, operation(leaf)),
  );
  // Half the trees name their columns from a plain leaf, so that collisions
  // drawn for the other leaves reach the statement instead of being refused
  // for the leftmost leaf's names.
  return fc
    .tuple(fc.oneof(operation(leaf), nested), fc.boolean())
    .map(([tree, plainLeftmost]) =>
      plainLeftmost ? withPlainLeftmostLeaf(tree) : tree,
    );
}

function withPlainLeftmostLeaf(tree: SetTree): SetTree {
  if (tree.kind === "leaf")
    return {
      kind: "leaf",
      leaf: { aliases: PLAIN_LEAF_ALIASES, start: tree.leaf.start },
    };
  return { ...tree, left: withPlainLeftmostLeaf(tree.left) };
}

/** Whether a leaf other than the one naming the compound's columns has drawn aliases. */
function hasDrawnOperand(tree: SetTree): boolean {
  function leaves(node: SetTree): readonly SetLeaf[] {
    return node.kind === "leaf" ?
        [node.leaf]
      : [...leaves(node.left), ...leaves(node.right)];
  }
  return leaves(tree)
    .slice(1)
    .some((leaf) => leaf.aliases !== PLAIN_LEAF_ALIASES);
}

describe("SQL-name guard against the unguarded compiler on SQLite and PGlite", () => {
  let engines: readonly Engine[] = [];
  let closeBackends: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pglite = await createLocalPgliteBackend({ vector: false });
    // Both backends live for the whole suite: each test reads the rows
    // seeded once here.
    const sqlite = createLocalSqliteBackend();
    closeBackends = async () => {
      await sqlite.backend.close();
      await pglite.backend.close();
    };
    engines = [
      await seedEngine("sqlite", "sqlite", sqlite.backend),
      await seedEngine(
        "pglite",
        "postgres",
        createPostgresBackend(pglite.db, { vector: false }),
      ),
    ];
  });

  afterAll(async () => {
    await closeBackends?.();
  });

  it("refuses only queries that some engine answers wrongly or fails, and answers the rest exactly", async () => {
    const aliasTriple = fc
      .tuple(
        fc.constantFrom(...ALIAS_POOL),
        fc.constantFrom(...ALIAS_POOL),
        fc.constantFrom(...ALIAS_POOL),
      )
      .filter(
        ([start, edge, target]) =>
          start !== edge && start !== target && edge !== target,
      );
    // Tallied over every run, and printed so a run reports its counts.
    const tally = {
      runs: 0,
      refused: 0,
      wrongUnguarded: 0,
      overRefused: 0,
      wrongGuarded: 0,
    };
    await fc.assert(
      fc.asyncProperty(
        aliasTriple,
        fc.constantFrom(...SHAPES),
        async (aliases, shape) => {
          guard.enabled = true;
          const guarded = await Promise.all(
            engines.map((engine) =>
              outcomeOf(() => runQuery(engine, aliases, shape)),
            ),
          );
          guard.enabled = false;
          const unguarded = await Promise.all(
            engines.map((engine) =>
              outcomeOf(() => runQuery(engine, aliases, shape)),
            ),
          );
          guard.enabled = true;

          const unguardedRight = engines.every((engine, index) =>
            isExactlyRight(requireDefined(unguarded[index]), engine, shape),
          );
          tally.runs += 1;
          if (guarded[0]?.kind === "refused") tally.refused += 1;
          if (!unguardedRight) tally.wrongUnguarded += 1;
          if (unguardedRight && guarded.some((o) => o.kind === "refused"))
            tally.overRefused += 1;
          if (
            guarded.some(
              (outcome, index) =>
                outcome.kind !== "refused" &&
                !isExactlyRight(outcome, requireDefined(engines[index]), shape),
            )
          )
            tally.wrongGuarded += 1;

          // Typed refusal or exactly the right row, with one verdict.
          for (const [index, engine] of engines.entries()) {
            const outcome = requireDefined(guarded[index]);
            expect({ engine: engine.name, outcome }).toEqual({
              engine: engine.name,
              outcome:
                outcome.kind === "refused" ?
                  { kind: "refused", typed: true }
                : { kind: "rows", rows: expectedRows(engine, shape) },
            });
          }
          expect(new Set(guarded.map((outcome) => outcome.kind)).size).toBe(1);

          // A refusal is justified only by an engine the unguarded statement
          // fails or answers wrongly on.
          expect({
            aliases,
            shape,
            refusedThoughRightUnguarded:
              unguardedRight && guarded[0]?.kind === "refused",
          }).toEqual({ aliases, shape, refusedThoughRightUnguarded: false });
        },
      ),
      {
        numRuns: 400,
        seed: 951,
        examples: [
          // The second review: HAVING reads `e_from.id` on the right beside an
          // edge `e`; a max of `e_from`'s age reads neither `e_from_id`.
          [["p", "e", "e_from"], "having field on the right"],
          [["p", "e", "e_from"], "having field on the left"],
          [["p", "e", "e_from"], "max beside edge filtered on fromId"],
          [["p", "e", "e_from"], "legacy aggregates"],
          [["p", "e", "e_from"], "ordered aggregate"],
          [["p", "e", "e_from"], "having start id"],
          // An edge `e` beside a target `e_from`: neither `e_from_id` is read.
          [["p", "e", "e_from"], "projected name"],
          [["p", "e", "e_from"], "target name"],
          [["p", "e", "e_from"], "edge and target"],
          [["k", "K", "p"], "ids"],
          [["k", "K", "p"], "whole rows"],
          [["item", "e", "Item"], "projected name"],
        ],
      },
    );
    console.info(`sql-identifier differential: ${JSON.stringify(tally)}`);
    expect({
      overRefused: tally.overRefused,
      wrongGuarded: tally.wrongGuarded,
    }).toEqual({
      overRefused: 0,
      wrongGuarded: 0,
    });
  });

  it("refuses only set operations that some engine answers wrongly or fails, and answers the rest exactly", async () => {
    // The reference rows of each start, as column values, from a leaf whose
    // aliases collide with nothing.
    const referenceRows = new Map<
      Engine,
      ReadonlyMap<LeafStart, readonly RowValues[]>
    >();
    for (const engine of engines) {
      const rows = new Map<LeafStart, readonly RowValues[]>();
      for (const start of ["sa", "sb", "both"] as const) {
        const leaf: QueryAst = leafQuery(engine, {
          aliases: PLAIN_LEAF_ALIASES,
          start,
        }).toAst();
        // A one-leaf UNION ALL with itself, halved: the reference rows come
        // back through the same compound path, without depending on it to
        // deduplicate.
        const doubled = await engine.backend.execute<Record<string, unknown>>(
          compileSetOperation(
            {
              __type: "set_operation",
              operator: "unionAll",
              left: leaf,
              right: leaf,
            },
            engine.store.graphId,
            { dialect: engine.dialect },
          ),
        );
        rows.set(
          start,
          doubled.slice(0, doubled.length / 2).map((row) => Object.values(row)),
        );
      }
      referenceRows.set(engine, rows);
    }
    const plainNames = leafQuery(requireDefined(engines[0]), {
      aliases: PLAIN_LEAF_ALIASES,
      start: "sa",
    })
      .toAst()
      .projection.fields.map((projected) => projected.outputName);
    expect(
      [
        ...requireDefined(
          referenceRows.get(requireDefined(engines[0])),
        ).values(),
      ].map((rows) => rows.length),
    ).toEqual([4, 1, 5]);

    /**
     * Whether `outcome` is exactly the rows `tree` must return. Its column
     * names are checked only when `names` is "checked": a nested compound
     * run on its own is compared by its values in column order.
     */
    function isExactlySetResult(
      outcome: Outcome,
      engine: Engine,
      tree: SetTree,
      names: "checked" | "values only" = "checked",
    ): boolean {
      if (outcome.kind !== "rows") return false;
      const leftmost = leftmostLeaf(tree).aliases;
      // Column names come from the leftmost leaf: the reference names with
      // each alias spelled as that leaf spells it.
      const columnNames = plainNames.map((name) => {
        const index = PLAIN_LEAF_ALIASES.findIndex((alias) =>
          name.startsWith(`${alias}_`),
        );
        const alias = requireDefined(PLAIN_LEAF_ALIASES[index]);
        return `${requireDefined(leftmost[index])}${name.slice(alias.length)}`;
      });
      const orderColumns = (
        ["n1_id", "n2_id", "s0_id", "x1_id", "x2_id"] as const
      ).map((name) => plainNames.indexOf(name));
      const expected = expectedSetRows(
        tree,
        requireDefined(referenceRows.get(engine)),
        orderColumns,
      );
      const rows = outcome.rows as readonly Record<string, unknown>[];
      if (
        names === "checked" &&
        rows.some(
          (row) =>
            JSON.stringify(Object.keys(row)) !== JSON.stringify(columnNames),
        )
      )
        return false;
      const actual = rows.map((row) => rowKey(Object.values(row)));
      const wanted = expected.map((row) => rowKey(row));
      return tree.kind === "op" && tree.order !== undefined ?
          JSON.stringify(actual) === JSON.stringify(wanted)
        : JSON.stringify(actual.toSorted()) ===
            JSON.stringify(wanted.toSorted());
    }

    const tally = {
      runs: 0,
      refused: 0,
      wrongUnguarded: 0,
      overRefused: 0,
      wrongGuarded: 0,
      // Accepted trees in which a leaf after the first has drawn aliases.
      acceptedWithDrawnOperands: 0,
    };
    await fc.assert(
      fc.asyncProperty(setTreeArbitrary(), async (tree) => {
        guard.enabled = true;
        const guarded = await Promise.all(
          engines.map((engine) =>
            outcomeOf(() => runSetOperation(engine, tree)),
          ),
        );
        guard.enabled = false;
        const unguarded = await Promise.all(
          engines.map((engine) =>
            outcomeOf(() => runSetOperation(engine, tree)),
          ),
        );

        // The rows a tree returns can hide what its names do: an empty
        // INTERSECT decodes no column, and a UNION with a superset absorbs a
        // nested compound ordered by the wrong column. Each place that reads
        // a leaf's names is also probed with rows that show it.
        const probesRight = await Promise.all(
          nameProbes(tree).map(({ probe, names }) =>
            Promise.all(
              engines.map(async (engine) =>
                isExactlySetResult(
                  await outcomeOf(() => runSetOperation(engine, probe)),
                  engine,
                  probe,
                  names,
                ),
              ),
            ),
          ),
        );
        guard.enabled = true;
        const unguardedRight =
          probesRight.flat().every(Boolean) &&
          engines.every((engine, index) =>
            isExactlySetResult(requireDefined(unguarded[index]), engine, tree),
          );
        tally.runs += 1;
        if (guarded[0]?.kind === "refused") tally.refused += 1;
        if (!unguardedRight) tally.wrongUnguarded += 1;
        if (guarded[0]?.kind === "rows" && hasDrawnOperand(tree))
          tally.acceptedWithDrawnOperands += 1;
        if (unguardedRight && guarded.some((o) => o.kind === "refused"))
          tally.overRefused += 1;
        const guardedWrong = guarded.some(
          (outcome, index) =>
            outcome.kind !== "refused" &&
            !isExactlySetResult(outcome, requireDefined(engines[index]), tree),
        );
        if (guardedWrong) tally.wrongGuarded += 1;

        // Typed refusal or exactly the right rows, with one verdict.
        expect({
          tree,
          kinds: guarded.map((outcome) =>
            outcome.kind === "refused" ?
              { refused: outcome.typed }
            : outcome.kind,
          ),
          guardedWrong,
        }).toEqual({
          tree,
          kinds:
            guarded[0]?.kind === "refused" ?
              engines.map(() => ({ refused: true }))
            : engines.map(() => "rows"),
          guardedWrong: false,
        });
        // A refusal is justified only by an engine the unguarded statement
        // fails or answers wrongly on.
        expect({
          tree,
          refusedThoughRightUnguarded:
            unguardedRight && guarded[0]?.kind === "refused",
        }).toEqual({ tree, refusedThoughRightUnguarded: false });
      }),
      {
        numRuns: 400,
        seed: 951,
        examples: [
          // The third review: the right operand reads `K_id` and `k_id` from
          // separate CTEs; the compound takes its names from the left one.
          [
            {
              kind: "op",
              operator: "union",
              left: {
                kind: "leaf",
                leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sa" },
              },
              right: {
                kind: "leaf",
                leaf: { aliases: ["p", "K", "x", "e", "k"], start: "sb" },
              },
            },
          ],
          // The same leaf on the left names the compound's columns.
          [
            {
              kind: "op",
              operator: "union",
              left: {
                kind: "leaf",
                leaf: { aliases: ["p", "K", "x", "e", "k"], start: "sb" },
              },
              right: {
                kind: "leaf",
                leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sa" },
              },
            },
          ],
          // A nested compound on the right whose ORDER BY reads its leftmost
          // leaf's `x_id`, `k_id` and `p_id` by name: `k_id` meets `K_id`.
          // The UNION absorbs the nested rows; the name probe still shows
          // SQLite ordering by `K_id`.
          [
            {
              kind: "op",
              operator: "union",
              left: {
                kind: "leaf",
                leaf: { aliases: PLAIN_LEAF_ALIASES, start: "both" },
              },
              right: {
                kind: "op",
                operator: "except",
                left: {
                  kind: "leaf",
                  leaf: { aliases: ["p", "K", "x", "e", "k"], start: "both" },
                },
                right: {
                  kind: "leaf",
                  leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sb" },
                },
                order: { direction: "desc", limit: 2 },
              },
              order: { direction: "asc" },
            },
          ],
          // The same nested compound, kept by a UNION ALL: with LIMIT 1,
          // SQLite ordering by `K_id` instead of `k_id` returns another row.
          [
            {
              kind: "op",
              operator: "unionAll",
              left: {
                kind: "leaf",
                leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sb" },
              },
              right: {
                kind: "op",
                operator: "except",
                left: {
                  kind: "leaf",
                  leaf: { aliases: ["p", "K", "x", "e", "k"], start: "both" },
                },
                right: {
                  kind: "leaf",
                  leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sb" },
                },
                order: { direction: "desc", limit: 1 },
              },
            },
          ],
          // The same, with the colliding names outside the nested ORDER BY.
          [
            {
              kind: "op",
              operator: "intersect",
              left: {
                kind: "leaf",
                leaf: { aliases: PLAIN_LEAF_ALIASES, start: "both" },
              },
              right: {
                kind: "op",
                operator: "unionAll",
                left: {
                  kind: "leaf",
                  leaf: { aliases: ["P", "x1", "n1", "p", "n2"], start: "sa" },
                },
                right: {
                  kind: "leaf",
                  leaf: { aliases: PLAIN_LEAF_ALIASES, start: "sb" },
                },
                order: { direction: "asc", limit: 3 },
              },
            },
          ],
        ],
      },
    );
    console.info(
      `sql-identifier set-operation differential: ${JSON.stringify(tally)}`,
    );
    expect({
      overRefused: tally.overRefused,
      wrongGuarded: tally.wrongGuarded,
    }).toEqual({ overRefused: 0, wrongGuarded: 0 });
  });
});
