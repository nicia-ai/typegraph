/**
 * Alias predicates as a differential property: a `whereNode()` predicate with
 * operands drawn from its target alias, another alias of the same statement,
 * an outer alias (inside a `$exists()` subquery) and literals is either
 * refused with the typed error the alias rules name, or returns exactly the
 * rows of the same comparison written in the completed-match `where()`.
 *
 * Every person has a distinct age, so a read of another alias that compiled
 * as the target's own column (the target compared with itself) changes the
 * rows. The outer alias is sometimes spelled like the compiler's generated
 * name for the subquery's start alias (`__tg_sq_1_a0`), so a check that ran
 * on renamed aliases would accept a foreign read as a read of the target.
 *
 * The statement is a two-hop chain `x -> m -> y` whose hops are fixed or
 * recursive. A recursive chain compiles each fixed stage as a separate
 * statement without the enclosing query, so an outer read on such a stage's
 * alias is refused; on a recursive stage it is evaluated.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { expr, field } from "../../../src";
import { UnsupportedPredicateError } from "../../../src/errors";
import type { DatabaseExpression } from "../../../src/query/expressions";
import { requireDefined } from "../../../src/utils/presence";
import { propertyRuns } from "../../property/run-budget";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

const LOCAL_ALIASES = ["x", "m", "y"] as const;
type LocalAlias = (typeof LOCAL_ALIASES)[number];

type Hop = "fixed" | "recursive";
type Shape = Readonly<{ first: Hop; second: Hop }>;

type Operand =
  | Readonly<{ kind: "local"; alias: LocalAlias }>
  | Readonly<{ kind: "outer" }>
  | Readonly<{ kind: "literal"; value: number }>;

type Operator = "eq" | "neq" | "gt" | "lt";

/**
 * `expression`: `expr.<op>(left, right)` over expression operands, where an
 * outer operand is an outer reference. `field`: `target.age.<op>(right)` with
 * `right` a raw `field(alias, "age")` naming any alias, the outer alias
 * included (which is then a read of an alias this statement does not have).
 */
type Form = "expression" | "field";

type Case = Readonly<{
  subquery: boolean;
  outerAlias: string;
  shape: Shape;
  target: LocalAlias;
  form: Form;
  operator: Operator;
  left: Operand;
  right: Operand;
}>;

type Expected =
  | Readonly<{ kind: "rows" }>
  | Readonly<{ kind: "cross-alias"; targetAlias: string; readAlias: string }>
  | Readonly<{ kind: "isolated-stage"; targetAlias: string }>;

type ExpressionScope = Readonly<
  Record<
    string,
    Readonly<{
      age: DatabaseExpression<number | undefined>;
      id: DatabaseExpression<string>;
      name: DatabaseExpression<string>;
    }>
  >
>;

/**
 * Dave(15) -> Alice(10) -> Bob(20) -> Carol(5), and Alice -> Carol: three
 * two-hop chains with distinct ages at every position.
 */
async function seedChains(store: IntegrationStore): Promise<void> {
  const dave = await store.nodes.Person.create({ name: "Dave", age: 15 });
  const alice = await store.nodes.Person.create({ name: "Alice", age: 10 });
  const bob = await store.nodes.Person.create({ name: "Bob", age: 20 });
  const carol = await store.nodes.Person.create({ name: "Carol", age: 5 });
  await store.edges.knows.create(dave, alice, {});
  await store.edges.knows.create(alice, bob, {});
  await store.edges.knows.create(alice, carol, {});
  await store.edges.knows.create(bob, carol, {});
}

/** The aliases a recursive chain compiles in a statement of their own. */
function isolatedAliases(shape: Shape): ReadonlySet<LocalAlias> {
  if (shape.first === "fixed" && shape.second === "fixed") return new Set();
  const isolated = new Set<LocalAlias>();
  if (shape.first === "fixed") {
    isolated.add("x");
    isolated.add("m");
  }
  if (shape.second === "fixed") isolated.add("y");
  return isolated;
}

/** The fields of its own statement the predicate reads, in compile order. */
function statementReads(testCase: Case): readonly string[] {
  if (testCase.form === "field") {
    const right = testCase.right;
    if (right.kind === "literal") return [testCase.target];
    return [
      testCase.target,
      right.kind === "local" ? right.alias : testCase.outerAlias,
    ];
  }
  return [testCase.left, testCase.right].flatMap((operand) =>
    operand.kind === "local" ? [operand.alias] : [],
  );
}

function expectedOutcome(testCase: Case): Expected {
  const foreign = statementReads(testCase).find(
    (alias) => alias !== testCase.target,
  );
  if (foreign !== undefined)
    return {
      kind: "cross-alias",
      targetAlias: testCase.target,
      readAlias: foreign,
    };
  const readsOuter =
    testCase.form === "expression" &&
    (testCase.left.kind === "outer" || testCase.right.kind === "outer");
  if (readsOuter && isolatedAliases(testCase.shape).has(testCase.target))
    return { kind: "isolated-stage", targetAlias: testCase.target };
  return { kind: "rows" };
}

function operandExpression(
  operand: Operand,
  inner: ExpressionScope,
  outer: ExpressionScope | undefined,
  outerAlias: string,
): DatabaseExpression<number | undefined> {
  switch (operand.kind) {
    case "local": {
      return requireDefined(inner[operand.alias]).age;
    }
    case "outer": {
      return requireDefined(requireDefined(outer)[outerAlias]).age;
    }
    case "literal": {
      return expr.literal(operand.value);
    }
  }
}

function comparison(
  operator: Operator,
  left: DatabaseExpression<number | undefined>,
  right: DatabaseExpression<number | undefined>,
) {
  switch (operator) {
    case "eq": {
      return expr.eq(left, right);
    }
    case "neq": {
      return expr.neq(left, right);
    }
    case "gt": {
      return expr.gt(left, right);
    }
    case "lt": {
      return expr.lt(left, right);
    }
  }
}

/** The predicate's comparison over expressions of a completed match. */
function completedComparison(
  testCase: Case,
  inner: ExpressionScope,
  outer: ExpressionScope | undefined,
) {
  const left: Operand =
    testCase.form === "field" ?
      { kind: "local", alias: testCase.target }
    : testCase.left;
  return comparison(
    testCase.operator,
    operandExpression(left, inner, outer, testCase.outerAlias),
    operandExpression(testCase.right, inner, outer, testCase.outerAlias),
  );
}

type AgeField = Readonly<
  Record<Operator, (value: unknown) => Readonly<{ __type: string }>>
>;

/** The `whereNode()` callback the case describes. */
function aliasPredicate(testCase: Case, outer: ExpressionScope | undefined) {
  return (accessor: unknown, inner: unknown) => {
    if (testCase.form === "expression")
      return completedComparison(testCase, inner as ExpressionScope, outer);
    const age = (accessor as Readonly<{ age: AgeField }>).age;
    const right = testCase.right;
    const operand =
      right.kind === "literal" ? right.value
      : right.kind === "local" ? field(right.alias, "age")
      : field(testCase.outerAlias, "age");
    return age[testCase.operator](operand);
  };
}

type Placement = "alias-predicate" | "completed-match";

/**
 * Builds the chain with the comparison either on the target alias or in the
 * completed-match `where()`. The builder is typed per literal alias, which a
 * generated case cannot name, so it is driven through a structural view.
 */
type ChainBuilder = Readonly<{
  traverse: (
    edge: string,
    alias: string,
    options: Readonly<{ expand: "none" }>,
  ) => ChainTraversal;
  whereNode: (alias: string, predicate: unknown) => ChainBuilder;
  where: (predicate: (inner: ExpressionScope) => unknown) => ChainBuilder;
  project: (projection: (inner: ExpressionScope) => unknown) => unknown;
  select: (selection: (row: unknown) => unknown) => ChainTerminal;
}>;
type ChainTraversal = Readonly<{
  to: (kind: string, alias: string) => ChainBuilder;
  recursive: (options: Readonly<{ maxHops: number }>) => ChainTraversal;
}>;
type ChainTerminal = Readonly<{ execute: () => Promise<readonly unknown[]> }>;
type OuterBuilder = Readonly<{
  where: (
    predicate: (
      expressions: Readonly<{
        $exists: (
          build: (
            subquery: Readonly<{
              from: (kind: string, alias: string) => ChainBuilder;
            }>,
            outer: ExpressionScope,
          ) => unknown,
        ) => unknown;
      }>,
    ) => unknown,
  ) => Readonly<{
    project: (
      projection: (expressions: ExpressionScope) => unknown,
    ) => ChainTerminal;
  }>;
}>;

function hop(builder: ChainBuilder, edgeAlias: string, kind: Hop) {
  const traversal = builder.traverse("knows", edgeAlias, { expand: "none" });
  return kind === "recursive" ? traversal.recursive({ maxHops: 1 }) : traversal;
}

function chain(
  start: ChainBuilder,
  testCase: Case,
  placement: Placement,
  outer: ExpressionScope | undefined,
): ChainBuilder {
  const built = hop(
    hop(start, "first", testCase.shape.first).to("Person", "m"),
    "second",
    testCase.shape.second,
  ).to("Person", "y");
  return placement === "alias-predicate" ?
      built.whereNode(testCase.target, aliasPredicate(testCase, outer))
    : built.where((inner) => completedComparison(testCase, inner, outer));
}

async function runCase(
  store: IntegrationStore,
  testCase: Case,
  placement: Placement,
): Promise<readonly string[]> {
  if (!testCase.subquery) {
    const start = store.query().from("Person", "x") as unknown as ChainBuilder;
    const rows = await chain(start, testCase, placement, undefined)
      .select((row) => {
        const names = row as Readonly<
          Record<LocalAlias, Readonly<{ name: string }>>
        >;
        return `${names.x.name}>${names.m.name}>${names.y.name}`;
      })
      .execute();
    return (rows as readonly string[]).toSorted();
  }
  const outerQuery = store
    .query()
    .from("Person", testCase.outerAlias) as unknown as OuterBuilder;
  const rows = await outerQuery
    .where((expressions) =>
      expressions.$exists((subquery, outer) =>
        chain(subquery.from("Person", "x"), testCase, placement, outer).project(
          (inner) => ({ id: requireDefined(inner["y"]).id }),
        ),
      ),
    )
    .project((expressions) => ({
      name: requireDefined(expressions[testCase.outerAlias]).name,
    }))
    .execute();
  return (rows as readonly Readonly<{ name: string }>[])
    .map((row) => row.name)
    .toSorted();
}

const hopArbitrary = fc.constantFrom<Hop>("fixed", "recursive");
const localOperand = fc
  .constantFrom(...LOCAL_ALIASES)
  .map((alias): Operand => ({ kind: "local", alias }));
const literalOperand = fc
  .constantFrom(5, 10, 12, 15, 20)
  .map((value): Operand => ({ kind: "literal", value }));

const caseArbitrary: fc.Arbitrary<Case> = fc
  .record({
    subquery: fc.boolean(),
    outerAlias: fc.constantFrom("p", "__tg_sq_1_a0"),
    shape: fc.record({ first: hopArbitrary, second: hopArbitrary }),
    target: fc.constantFrom(...LOCAL_ALIASES),
    form: fc.constantFrom<Form>("expression", "field"),
    operator: fc.constantFrom<Operator>("eq", "neq", "gt", "lt"),
    left: fc.oneof(localOperand, fc.constant<Operand>({ kind: "outer" })),
    right: fc.oneof(
      localOperand,
      fc.constant<Operand>({ kind: "outer" }),
      literalOperand,
    ),
  })
  .filter((testCase) => {
    const readsOuter =
      testCase.form === "expression" &&
      (testCase.left.kind === "outer" || testCase.right.kind === "outer");
    // An outer reference exists only inside a subquery.
    if (!testCase.subquery) return !readsOuter;
    // An outer reference to an alias spelled like a generated subquery alias
    // compiles to a relation name the subquery's own renamed alias shadows.
    // That is the unreserved `__tg` prefix, not the alias-predicate rule;
    // the raw-field form above still exercises the spelling against the rule.
    return !(readsOuter && testCase.outerAlias.startsWith("__tg"));
  });

type Observed =
  | Readonly<{ kind: "rows"; rows: readonly string[] }>
  | Readonly<{ kind: "cross-alias"; targetAlias: unknown; readAlias: unknown }>
  | Readonly<{ kind: "isolated-stage"; targetAlias: unknown }>
  | Readonly<{ kind: "other-error"; error: string }>;

/**
 * What a run did, in the vocabulary of {@link Expected}: an
 * `UnsupportedPredicateError` naming a read alias is the cross-alias
 * refusal, one naming only its target is the isolated-stage refusal.
 */
async function observe(
  run: () => Promise<readonly string[]>,
): Promise<Observed> {
  try {
    return { kind: "rows", rows: await run() };
  } catch (error) {
    if (!(error instanceof UnsupportedPredicateError))
      return { kind: "other-error", error: String(error) };
    const details = error.details;
    return "readAlias" in details ?
        {
          kind: "cross-alias",
          targetAlias: details["targetAlias"],
          readAlias: details["readAlias"],
        }
      : { kind: "isolated-stage", targetAlias: details["targetAlias"] };
  }
}

export function registerAliasPredicateDifferentialIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Alias predicates against completed-match where()", () => {
    it("refuses with the typed error or returns the where() rows", async () => {
      const store = context.getStore();
      await seedChains(store);

      await fc.assert(
        fc.asyncProperty(caseArbitrary, async (testCase) => {
          const expected = expectedOutcome(testCase);
          const observed = await observe(() =>
            runCase(store, testCase, "alias-predicate"),
          );
          const reference: Observed =
            expected.kind === "rows" ?
              {
                kind: "rows",
                rows: await runCase(store, testCase, "completed-match"),
              }
            : expected;
          expect(observed).toEqual(reference);
        }),
        { numRuns: propertyRuns({ ci: 40, local: 80 }) },
      );
    });
  });
}
