import { UnsupportedPredicateError } from "../../errors";
import type {
  FieldRef,
  NodePredicate,
  PredicateExpression,
  QueryAst,
} from "../ast";
import type { DatabaseExpression } from "../expressions";
import { visitExpressionChildren } from "./expression-inspection";
import { visitCorrelatedExpressionFields } from "./expression-subquery-scope";

/**
 * Decides whether an alias predicate may read a field of the statement it
 * compiles in: only a field of its own target alias.
 *
 * An alias predicate compiles inside the CTE that produces its target alias,
 * where a field is written as that CTE's own raw column: a read of another
 * alias would compile as the target's column and silently compare the target
 * with itself. Comparisons between aliases belong in the completed-match
 * `where()`; a subquery reads its enclosing statement through the correlated
 * `$exists()` / `$scalar()` helpers, whose outer references read that
 * statement, not this one, and are not visited here.
 *
 * This is the one owner of the rule. Whether a compile step that evaluates
 * the predicate can reach an enclosing statement at all is a separate
 * question (`traversal-stage-validation.ts`).
 */
function assertAliasPredicateReadsOnlyItsTarget(
  predicate: NodePredicate,
): void {
  visitAliasPredicateFields(predicate.expression, (field) => {
    if (field.alias === predicate.targetAlias) return;
    throw new UnsupportedPredicateError(
      `The predicate on alias "${predicate.targetAlias}" reads alias "${field.alias}"; a whereNode() or whereEdge() predicate can read only its own alias.`,
      { targetAlias: predicate.targetAlias, readAlias: field.alias },
      {
        suggestion:
          "Compare aliases in where((ctx) => ...), which filters completed matches. A subquery that needs an outer field correlates through $exists() or $scalar() and their outer context.",
      },
    );
  });
}

/**
 * Applies {@link assertAliasPredicateReadsOnlyItsTarget} to every alias
 * predicate of a statement and of every subquery nested anywhere in it.
 *
 * It runs on the tree as the caller built it, before the compiler renames a
 * subquery's aliases: a rename can make a read of an outer alias spelled like
 * a generated name look like a read of the target, and a refusal must name
 * the caller's aliases.
 */
export function assertAliasPredicatesReadOnlyTheirTarget(ast: QueryAst): void {
  for (const predicate of ast.predicates)
    assertAliasPredicateReadsOnlyItsTarget(predicate);
  visitNestedSubqueries(ast, (subquery) => {
    assertAliasPredicatesReadOnlyTheirTarget(subquery);
  });
}

/**
 * Visits each subquery directly nested in a statement (legacy `exists()` /
 * `inSubquery()` and expression `$exists()` / `$scalar()`), wherever in the
 * statement it appears. Subqueries nested in those are not visited.
 */
export function visitNestedSubqueries(
  ast: QueryAst,
  visit: (subquery: QueryAst) => void,
): void {
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== "object" || value === null || value instanceof Date)
      return;
    const record = value as Readonly<Record<string, unknown>>;
    const type = record["__type"];
    if (type === "literal") return;
    if (type === "exists" || type === "in_subquery") {
      visit(record["subquery"] as QueryAst);
      return;
    }
    // A database expression of an object field is a proxy that refuses
    // keys its schema does not declare; only its node is read.
    if (type === "database_expression") {
      walkExpressionNode((value as DatabaseExpression).node);
      return;
    }
    for (const entry of Object.values(record)) walk(entry);
  }
  function walkExpressionNode(node: DatabaseExpression["node"]): void {
    if (node.kind === "exists_subquery" || node.kind === "scalar_subquery") {
      visit(node.subquery);
      return;
    }
    if (node.kind === "literal") return;
    for (const entry of Object.values(node)) walk(entry);
  }
  for (const entry of Object.values(ast)) walk(entry);
}

/** Visits every field of its own statement that a predicate reads. */
function visitAliasPredicateFields(
  expression: PredicateExpression,
  visit: (field: FieldRef) => void,
): void {
  switch (expression.__type) {
    case "comparison": {
      visit(expression.left);
      if (
        !Array.isArray(expression.right) &&
        expression.right.__type === "field_ref"
      )
        visit(expression.right);
      return;
    }
    case "tuple_comparison": {
      for (const field of expression.fields) visit(field);
      return;
    }
    case "string_op":
    case "null_check":
    case "between":
    case "array_op":
    case "object_op":
    case "in_subquery":
    case "vector_similarity":
    case "fulltext_match": {
      visit(expression.field);
      return;
    }
    case "aggregate_comparison": {
      visit(expression.aggregate.field);
      return;
    }
    case "and":
    case "or": {
      for (const operand of expression.predicates)
        visitAliasPredicateFields(operand, visit);
      return;
    }
    case "not": {
      visitAliasPredicateFields(expression.predicate, visit);
      return;
    }
    case "exists": {
      // The legacy subquery compiles as its own statement and is checked
      // there; it reads nothing of this one.
      return;
    }
    case "database_expression_predicate": {
      visitStatementExpressionFields(expression.expression, visit);
      return;
    }
  }
}

function visitStatementExpressionFields(
  expression: DatabaseExpression,
  visit: (field: FieldRef) => void,
): void {
  const node = expression.node;
  if (node.kind === "field") {
    visit(node.field);
    return;
  }
  // An outer reference reads the enclosing statement, which compiles it
  // against its own relations; nothing of this statement is read.
  if (node.kind === "outer_reference") return;
  if (node.kind === "exists_subquery" || node.kind === "scalar_subquery") {
    // The nested statement's outer references into this statement.
    visitCorrelatedExpressionFields(
      node.subquery,
      expression.scopeIdentity,
      visit,
    );
    return;
  }
  visitExpressionChildren(expression, (operand) => {
    visitStatementExpressionFields(operand, visit);
  });
}
