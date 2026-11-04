/**
 * Property Tests — Prepared Query Parameter System
 *
 * Tests invariants of parameter collection, substitution, and validation
 * using fast-check to generate arbitrary predicate trees, and that a prepared
 * query executed over a store answers what the inline query does.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  param as parameter,
} from "../../src";
import { projectBackendWithout } from "../../src/backend/derive-backend";
import type {
  BetweenPredicate,
  ComparisonPredicate,
  FieldRef,
  LiteralValue,
  NodePredicate,
  ParameterRef,
  PredicateExpression,
  QueryAst,
  StringPredicate,
} from "../../src/query/ast";
import {
  composableQueryHasParameterReferences,
  hasParameterReferences,
} from "../../src/query/builder/prepared-query";
import { type Predicate } from "../../src/query/predicates";
import { compareStrings } from "../../src/utils/compare";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

// ============================================================
// Arbitraries
// ============================================================

const aliasArb = fc.constantFrom("p", "q", "r", "s");

const fieldRefArb: fc.Arbitrary<FieldRef> = fc.record({
  __type: fc.constant("field_ref" as const),
  alias: aliasArb,
  path: fc.constantFrom(
    ["id"],
    ["props", "name"],
    ["props", "age"],
    ["props", "email"],
    ["kind"],
  ),
});

const literalValueArb: fc.Arbitrary<LiteralValue> = fc.oneof(
  fc.string({ minLength: 0, maxLength: 20 }).map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "string" as const,
  })),
  fc.integer({ min: -1000, max: 1000 }).map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "number" as const,
  })),
  fc.boolean().map((value) => ({
    __type: "literal" as const,
    value,
    valueType: "boolean" as const,
  })),
);

const parameterNameArb = fc.stringMatching(/^[a-z][a-zA-Z0-9]{0,15}$/);

const parameterRefArb: fc.Arbitrary<ParameterRef> = parameterNameArb.map(
  (name) => ({
    __type: "parameter" as const,
    name,
  }),
);

const comparisonRightArb = fc.oneof(literalValueArb, parameterRefArb);

const comparisonPredicateArb: fc.Arbitrary<ComparisonPredicate> = fc.record({
  __type: fc.constant("comparison" as const),
  op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte"),
  left: fieldRefArb,
  right: comparisonRightArb,
});

const stringPredicateArb: fc.Arbitrary<StringPredicate> = fc.record({
  __type: fc.constant("string_op" as const),
  op: fc.constantFrom("contains", "startsWith", "endsWith", "like", "ilike"),
  field: fieldRefArb,
  pattern: fc.oneof(
    fc.string({ minLength: 0, maxLength: 10 }),
    parameterRefArb,
  ),
});

const betweenPredicateArb: fc.Arbitrary<BetweenPredicate> = fc.record({
  __type: fc.constant("between" as const),
  field: fieldRefArb,
  lower: fc.oneof(literalValueArb, parameterRefArb),
  upper: fc.oneof(literalValueArb, parameterRefArb),
});

const nullCheckArb = fc.record({
  __type: fc.constant("null_check" as const),
  op: fc.constantFrom("isNull" as const, "isNotNull" as const),
  field: fieldRefArb,
});

// Leaf predicate (no recursion)
const leafPredicateArb: fc.Arbitrary<PredicateExpression> = fc.oneof(
  comparisonPredicateArb,
  stringPredicateArb,
  betweenPredicateArb,
  nullCheckArb,
);

// Composite predicate with one level of nesting
const compositePredicateArb: fc.Arbitrary<PredicateExpression> = fc.oneof(
  leafPredicateArb,
  fc
    .array(leafPredicateArb, { minLength: 2, maxLength: 4 })
    .map((predicates) => ({ __type: "and" as const, predicates })),
  fc
    .array(leafPredicateArb, { minLength: 2, maxLength: 4 })
    .map((predicates) => ({ __type: "or" as const, predicates })),
  leafPredicateArb.map((predicate) => ({
    __type: "not" as const,
    predicate,
  })),
);

const nodePredicateArb: fc.Arbitrary<NodePredicate> = fc.record({
  targetAlias: aliasArb,
  expression: compositePredicateArb,
});

function makeAstFromPredicates(
  predicates: readonly NodePredicate[],
  having?: PredicateExpression,
): QueryAst {
  return {
    start: { alias: "p", kinds: ["Person"], expansion: "exact" as const },
    traversals: [],
    predicates,
    projection: { fields: [] },
    temporalMode: { mode: "current" },
    ...(having === undefined ? {} : { having }),
  };
}

// ============================================================
// Helpers
// ============================================================

function collectParamNames(expression: PredicateExpression): Set<string> {
  const names = new Set<string>();
  collectFromExpr(expression, names);
  return names;
}

function collectFromExpr(
  expression: PredicateExpression,
  names: Set<string>,
): void {
  switch (expression.__type) {
    case "database_expression_predicate": {
      throw new Error(
        "This legacy-predicate generator does not emit database expressions",
      );
    }
    case "comparison": {
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "parameter"
      ) {
        names.add(expression.right.name);
      }
      return;
    }
    case "tuple_comparison": {
      return;
    }
    case "string_op": {
      if (typeof expression.pattern === "object") {
        names.add(expression.pattern.name);
      }
      return;
    }
    case "between": {
      if (expression.lower.__type === "parameter") {
        names.add(expression.lower.name);
      }
      if (expression.upper.__type === "parameter") {
        names.add(expression.upper.name);
      }
      return;
    }
    case "and":
    case "or": {
      for (const predicate of expression.predicates) {
        collectFromExpr(predicate, names);
      }
      return;
    }
    case "not": {
      collectFromExpr(expression.predicate, names);
      return;
    }
    case "null_check":
    case "array_op":
    case "object_op":
    case "aggregate_comparison":
    case "vector_similarity":
    case "fulltext_match":
    case "exists":
    case "in_subquery": {
      return;
    }
  }
}

// ============================================================
// Properties
// ============================================================

describe("Parameter Detection Properties", () => {
  it("hasParameterReferences is true iff the AST contains at least one ParameterRef", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 5 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);

          // Manually check if any parameter exists
          const allParamNames = new Set<string>();
          for (const predicate of predicates) {
            collectFromExpr(predicate.expression, allParamNames);
          }

          const expected = allParamNames.size > 0;
          expect(hasParameterReferences(ast)).toBe(expected);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("hasParameterReferences also checks the having clause", () => {
    fc.assert(
      fc.property(compositePredicateArb, (having) => {
        const ast = makeAstFromPredicates([], having);
        const expectedParams = collectParamNames(having);
        const expected = expectedParams.size > 0;
        expect(hasParameterReferences(ast)).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });

  it("composableQueryHasParameterReferences matches hasParameterReferences for plain ASTs", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);
          expect(composableQueryHasParameterReferences(ast)).toBe(
            hasParameterReferences(ast),
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("set operations propagate parameter references from either side", () => {
    fc.assert(
      fc.property(
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        fc.array(nodePredicateArb, { minLength: 0, maxLength: 3 }),
        fc.constantFrom("union", "unionAll", "intersect", "except"),
        (leftPreds, rightPreds, operator) => {
          const left = makeAstFromPredicates(leftPreds);
          const right = makeAstFromPredicates(rightPreds);
          const setOp = {
            __type: "set_operation" as const,
            operator,
            left,
            right,
          };

          const leftHas = hasParameterReferences(left);
          const rightHas = hasParameterReferences(right);
          const expected = leftHas || rightHas;

          expect(composableQueryHasParameterReferences(setOp)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Parameter Name Collection Consistency", () => {
  it("parameter-free predicates never cause hasParameterReferences to be true", () => {
    // Generate only literal-value predicates (no parameters)
    const literalOnlyComparison: fc.Arbitrary<ComparisonPredicate> = fc.record({
      __type: fc.constant("comparison" as const),
      op: fc.constantFrom("eq", "neq", "gt", "gte", "lt", "lte"),
      left: fieldRefArb,
      right: literalValueArb,
    });

    const literalOnlyPredicate: fc.Arbitrary<NodePredicate> = fc.record({
      targetAlias: aliasArb,
      expression: literalOnlyComparison,
    });

    fc.assert(
      fc.property(
        fc.array(literalOnlyPredicate, { minLength: 1, maxLength: 5 }),
        (predicates) => {
          const ast = makeAstFromPredicates(predicates);
          expect(hasParameterReferences(ast)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("adding a parameter to a literal-only AST makes hasParameterReferences true", () => {
    const literalComparison: fc.Arbitrary<ComparisonPredicate> = fc.record({
      __type: fc.constant("comparison" as const),
      op: fc.constant("eq" as const),
      left: fieldRefArb,
      right: literalValueArb,
    });

    fc.assert(
      fc.property(
        fc.array(literalComparison, { minLength: 0, maxLength: 3 }),
        parameterNameArb,
        (existingComparisons, parameterName) => {
          const parameterComparison: ComparisonPredicate = {
            __type: "comparison",
            op: "eq",
            left: { __type: "field_ref", alias: "p", path: ["props", "name"] },
            right: { __type: "parameter", name: parameterName },
          };

          const predicates: NodePredicate[] = [
            ...existingComparisons.map((expression) => ({
              targetAlias: "p",
              expression,
            })),
            { targetAlias: "p", expression: parameterComparison },
          ];

          const ast = makeAstFromPredicates(predicates);
          expect(hasParameterReferences(ast)).toBe(true);
        },
      ),
      { numRuns: 50 },
    );
  });
});

// ============================================================
// Prepared vs inline execution over a store
// ============================================================

/**
 * A prepared query executed with a binding must return exactly what the same
 * query with the values written inline returns, and both must match an
 * in-memory filter of the rows. Each prepared query runs with two bindings
 * in turn, so a value cached from the first execution shows up in the second.
 *
 * Names are lowercase ASCII, so the engines' string order and `LIKE` agree
 * with JavaScript's code-point comparison.
 */
const PqPerson = defineNode("PqPerson", {
  schema: z.object({ name: z.string(), age: z.number().int() }),
});

const storeGraph = defineGraph({
  id: "prop_prepared_store",
  nodes: { PqPerson: { type: PqPerson } },
  edges: {},
});

const PQ_NAMES = ["a", "ab", "b", "ba", "c"] as const;
const pqNameArb = fc.constantFrom(...PQ_NAMES);
const pqAgeArb = fc.integer({ min: 0, max: 5 });

type PqRow = Readonly<{ id: string; name: string; age: number }>;

type PqLeaf =
  | Readonly<{
      field: "name";
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "startsWith";
      values: readonly [string, string];
    }>
  | Readonly<{
      field: "name";
      op: "in" | "notIn";
      values: readonly [readonly string[], readonly string[]];
    }>
  | Readonly<{
      field: "age";
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
      values: readonly [number, number];
    }>
  | Readonly<{
      field: "age";
      op: "in" | "notIn";
      values: readonly [readonly number[], readonly number[]];
    }>
  | Readonly<{
      field: "age";
      op: "between";
      values: readonly [readonly [number, number], readonly [number, number]];
    }>;

type PqTree =
  | Readonly<{ type: "leaf"; leaf: PqLeaf }>
  | Readonly<{ type: "and" | "or"; left: PqTree; right: PqTree }>
  | Readonly<{ type: "not"; inner: PqTree }>;

const pqPair = <T>(arbitrary: fc.Arbitrary<T>) =>
  fc.tuple(arbitrary, arbitrary);

const pqLeafArb: fc.Arbitrary<PqLeaf> = fc.oneof(
  fc.record({
    field: fc.constant("name" as const),
    op: fc.constantFrom(
      "eq" as const,
      "neq" as const,
      "gt" as const,
      "gte" as const,
      "lt" as const,
      "lte" as const,
      "startsWith" as const,
    ),
    values: pqPair(pqNameArb),
  }),
  fc.record({
    field: fc.constant("name" as const),
    op: fc.constantFrom("in" as const, "notIn" as const),
    values: pqPair(fc.array(pqNameArb, { minLength: 1, maxLength: 3 })),
  }),
  fc.record({
    field: fc.constant("age" as const),
    op: fc.constantFrom(
      "eq" as const,
      "neq" as const,
      "gt" as const,
      "gte" as const,
      "lt" as const,
      "lte" as const,
    ),
    values: pqPair(pqAgeArb),
  }),
  fc.record({
    field: fc.constant("age" as const),
    op: fc.constantFrom("in" as const, "notIn" as const),
    values: pqPair(fc.array(pqAgeArb, { minLength: 1, maxLength: 3 })),
  }),
  fc.record({
    field: fc.constant("age" as const),
    op: fc.constant("between" as const),
    values: pqPair(fc.tuple(pqAgeArb, pqAgeArb)),
  }),
);

const pqTreeArb: fc.Arbitrary<PqTree> = fc.letrec<{ tree: PqTree }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    pqLeafArb.map((leaf) => ({ type: "leaf", leaf }) as const),
    fc
      .record({
        type: fc.constantFrom("and" as const, "or" as const),
        left: tie("tree"),
        right: tie("tree"),
      })
      .map((node) => node as PqTree),
    tie("tree").map((inner) => ({ type: "not", inner }) as const),
  ),
})).tree;

function pqCompare(op: "gt" | "gte" | "lt" | "lte", order: number): boolean {
  switch (op) {
    case "gt": {
      return order > 0;
    }
    case "gte": {
      return order >= 0;
    }
    case "lt": {
      return order < 0;
    }
    case "lte": {
      return order <= 0;
    }
  }
}

/** The in-memory reference: does `row` satisfy `leaf` under binding `slot`? */
function pqLeafHolds(leaf: PqLeaf, slot: 0 | 1, row: PqRow): boolean {
  switch (leaf.op) {
    case "between": {
      const [lower, upper] = leaf.values[slot];
      return row.age >= lower && row.age <= upper;
    }
    case "in":
    case "notIn": {
      const listed =
        leaf.field === "name" ?
          leaf.values[slot].includes(row.name)
        : leaf.values[slot].includes(row.age);
      return leaf.op === "in" ? listed : !listed;
    }
    case "startsWith": {
      return row.name.startsWith(leaf.values[slot]);
    }
    case "eq":
    case "neq": {
      const equal =
        leaf.field === "name" ?
          row.name === leaf.values[slot]
        : row.age === leaf.values[slot];
      return leaf.op === "eq" ? equal : !equal;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const order =
        leaf.field === "name" ?
          compareStrings(row.name, leaf.values[slot])
        : row.age - leaf.values[slot];
      return pqCompare(leaf.op, order);
    }
  }
}

function pqTreeHolds(tree: PqTree, slot: 0 | 1, row: PqRow): boolean {
  switch (tree.type) {
    case "leaf": {
      return pqLeafHolds(tree.leaf, slot, row);
    }
    case "and": {
      return (
        pqTreeHolds(tree.left, slot, row) && pqTreeHolds(tree.right, slot, row)
      );
    }
    case "or": {
      return (
        pqTreeHolds(tree.left, slot, row) || pqTreeHolds(tree.right, slot, row)
      );
    }
    case "not": {
      return !pqTreeHolds(tree.inner, slot, row);
    }
  }
}

/**
 * Builds the predicate for `tree`. `operand` turns a leaf's value into what
 * the field method takes: the literal for the inline query, a `param()`
 * reference (named after the leaf's position) for the prepared one, while
 * `bind` records that parameter's value for the binding.
 */
type PqOperands = Readonly<{
  name: (
    position: string,
    value: string,
  ) => string | ReturnType<typeof parameter>;
  age: (
    position: string,
    value: number,
  ) => number | ReturnType<typeof parameter>;
  names: (
    position: string,
    value: readonly string[],
  ) => readonly string[] | ReturnType<typeof parameter>;
  ages: (
    position: string,
    value: readonly number[],
  ) => readonly number[] | ReturnType<typeof parameter>;
}>;

type PqNodeFields = Readonly<{
  name: Readonly<{
    eq: (value: string | ReturnType<typeof parameter>) => Predicate;
    neq: (value: string | ReturnType<typeof parameter>) => Predicate;
    gt: (value: string | ReturnType<typeof parameter>) => Predicate;
    gte: (value: string | ReturnType<typeof parameter>) => Predicate;
    lt: (value: string | ReturnType<typeof parameter>) => Predicate;
    lte: (value: string | ReturnType<typeof parameter>) => Predicate;
    startsWith: (value: string | ReturnType<typeof parameter>) => Predicate;
    in: (values: readonly string[] | ReturnType<typeof parameter>) => Predicate;
    notIn: (
      values: readonly string[] | ReturnType<typeof parameter>,
    ) => Predicate;
  }>;
  age: Readonly<{
    eq: (value: number | ReturnType<typeof parameter>) => Predicate;
    neq: (value: number | ReturnType<typeof parameter>) => Predicate;
    gt: (value: number | ReturnType<typeof parameter>) => Predicate;
    gte: (value: number | ReturnType<typeof parameter>) => Predicate;
    lt: (value: number | ReturnType<typeof parameter>) => Predicate;
    lte: (value: number | ReturnType<typeof parameter>) => Predicate;
    in: (values: readonly number[] | ReturnType<typeof parameter>) => Predicate;
    notIn: (
      values: readonly number[] | ReturnType<typeof parameter>,
    ) => Predicate;
    between: (
      lower: number | ReturnType<typeof parameter>,
      upper: number | ReturnType<typeof parameter>,
    ) => Predicate;
  }>;
}>;

function pqLeafPredicate(
  fields: PqNodeFields,
  leaf: PqLeaf,
  position: string,
  operands: PqOperands,
): Predicate {
  switch (leaf.op) {
    case "between": {
      const [lower, upper] = leaf.values[0];
      return fields.age.between(
        operands.age(`${position}lo`, lower),
        operands.age(`${position}hi`, upper),
      );
    }
    case "in":
    case "notIn": {
      return leaf.field === "name" ?
          fields.name[leaf.op](operands.names(position, leaf.values[0]))
        : fields.age[leaf.op](operands.ages(position, leaf.values[0]));
    }
    case "startsWith": {
      return fields.name.startsWith(operands.name(position, leaf.values[0]));
    }
    case "eq":
    case "neq":
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      return leaf.field === "name" ?
          fields.name[leaf.op](operands.name(position, leaf.values[0]))
        : fields.age[leaf.op](operands.age(position, leaf.values[0]));
    }
  }
}

function pqTreePredicate(
  fields: PqNodeFields,
  tree: PqTree,
  position: string,
  operands: PqOperands,
): Predicate {
  switch (tree.type) {
    case "leaf": {
      return pqLeafPredicate(fields, tree.leaf, position, operands);
    }
    case "and":
    case "or": {
      const left = pqTreePredicate(fields, tree.left, `${position}l`, operands);
      const right = pqTreePredicate(
        fields,
        tree.right,
        `${position}r`,
        operands,
      );
      return tree.type === "and" ? left.and(right) : left.or(right);
    }
    case "not": {
      return pqTreePredicate(
        fields,
        tree.inner,
        `${position}n`,
        operands,
      ).not();
    }
  }
}

/** The binding that gives the prepared query the values in `slot`. */
function pqBindings(
  tree: PqTree,
  slot: 0 | 1,
  position = "p",
): Record<string, unknown> {
  switch (tree.type) {
    case "leaf": {
      const { leaf } = tree;
      if (leaf.op === "between") {
        const [lower, upper] = leaf.values[slot];
        return { [`${position}lo`]: lower, [`${position}hi`]: upper };
      }
      return { [position]: leaf.values[slot] };
    }
    case "and":
    case "or": {
      return {
        ...pqBindings(tree.left, slot, `${position}l`),
        ...pqBindings(tree.right, slot, `${position}r`),
      };
    }
    case "not": {
      return pqBindings(tree.inner, slot, `${position}n`);
    }
  }
}

/** Swaps a tree's two value slots, so slot 0 spells the second binding inline. */
function pqSwapSlots(tree: PqTree): PqTree {
  switch (tree.type) {
    case "leaf": {
      const [first, second] = tree.leaf.values;
      return {
        type: "leaf",
        leaf: { ...tree.leaf, values: [second, first] } as PqLeaf,
      };
    }
    case "and":
    case "or": {
      return {
        type: tree.type,
        left: pqSwapSlots(tree.left),
        right: pqSwapSlots(tree.right),
      };
    }
    case "not": {
      return { type: "not", inner: pqSwapSlots(tree.inner) };
    }
  }
}

const INLINE_OPERANDS: PqOperands = {
  name: (_, value) => value,
  age: (_, value) => value,
  names: (_, value) => value,
  ages: (_, value) => value,
};

const PARAMETER_OPERANDS: PqOperands = {
  name: (position) => parameter(position),
  age: (position) => parameter(position),
  names: (position) => parameter(position),
  ages: (position) => parameter(position),
};

/**
 * Prepared execution runs a cached SQL template through `executeRaw` when the
 * backend has it, and substitutes the bindings into the AST and compiles
 * afresh when it does not; each lane must answer the same.
 */
const PREPARED_EXECUTION_LANES = [
  { lane: "the executeRaw template", withoutExecuteRaw: false },
  { lane: "the substituted-AST fallback", withoutExecuteRaw: true },
] as const;

describe("prepared vs inline execution over a store", () => {
  it.each(PREPARED_EXECUTION_LANES)(
    "returns the inline query's rows and the in-memory filter's, for each of two bindings, through $lane",
    async ({ withoutExecuteRaw }) => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.record({ name: pqNameArb, age: pqAgeArb }), {
            minLength: 1,
            maxLength: 10,
          }),
          fc.array(pqTreeArb, { minLength: 1, maxLength: 3 }),
          async (people, trees) => {
            const backend = createTestBackend();
            try {
              const store = createStore(
                storeGraph,
                withoutExecuteRaw ?
                  projectBackendWithout(backend, ["executeRaw"])
                : backend,
              );
              const rows: PqRow[] = [];
              for (const person of people) {
                const created = await store.nodes.PqPerson.create(person);
                rows.push({ id: created.id, ...person });
              }

              const run = (tree: PqTree, operands: PqOperands) =>
                store
                  .query()
                  .from("PqPerson", "person")
                  .whereNode("person", (fields) =>
                    pqTreePredicate(fields, tree, "p", operands),
                  )
                  .orderBy("person", "id", "asc")
                  .select((ctx) => ctx.person.id);

              for (const tree of trees) {
                const prepared = run(tree, PARAMETER_OPERANDS).prepare();
                for (const slot of [0, 1] as const) {
                  const inlineTree = slot === 0 ? tree : pqSwapSlots(tree);
                  const expected = rows
                    .filter((row) => pqTreeHolds(tree, slot, row))
                    .map((row) => row.id)
                    .toSorted(compareStrings);
                  expect({
                    tree,
                    slot,
                    prepared: await prepared.execute(pqBindings(tree, slot)),
                    inline: await run(inlineTree, INLINE_OPERANDS).execute(),
                  }).toEqual({
                    tree,
                    slot,
                    prepared: expected,
                    inline: expected,
                  });
                }
              }
            } finally {
              await backend.close();
            }
          },
        ),
        { numRuns: propertyRuns({ ci: 100, local: 250 }) },
      );
    },
    120_000,
  );
});
