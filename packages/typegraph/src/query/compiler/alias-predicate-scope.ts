import { UnsupportedPredicateError } from "../../errors";
import type { FieldRef, PredicateExpression, QueryAst } from "../ast";
import type { DatabaseExpression } from "../expressions";
import { visitExpressionChildren } from "./expression-inspection";
import { visitCorrelatedExpressionFields } from "./expression-subquery-scope";

/**
 * Refuses a `whereNode()` / `whereEdge()` predicate that reads a field of an
 * alias other than its target.
 *
 * An alias predicate compiles inside the CTE that produces its target alias,
 * where a field is written as that CTE's own raw column: a read of another
 * alias would compile as the target's column and silently compare the target
 * with itself. Comparisons between aliases belong in the completed-match
 * `where()`; a subquery reads its enclosing statement through the correlated
 * `$exists()` / `$scalar()` helpers, whose outer references this check does
 * not count as reads of the statement being compiled.
 */
export function assertAliasPredicatesReadOnlyTheirTarget(ast: QueryAst): void {
  for (const predicate of ast.predicates) {
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
