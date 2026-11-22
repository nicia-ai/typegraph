import type { QueryAst } from "../ast";
import { expressionContainsAggregate } from "./expression-inspection";

/**
 * Whether the statement's result rows are groups rather than matches: it
 * groups, filters groups, or projects an aggregate (an ungrouped aggregate
 * folds every match into one row). The one owner of "this statement
 * aggregates": a per-match value read in such a statement's SELECT or ORDER
 * BY must itself be aggregated, its rows cannot be truncated before they are
 * folded, and the column-pruning, rowset-collapse, late-materialization,
 * logical-plan and recursive-output decisions all read it.
 */
export function isAggregatedStatement(ast: QueryAst): boolean {
  if (ast.groupBy !== undefined || ast.having !== undefined) {
    return true;
  }
  return ast.projection.fields.some(
    (field) =>
      field.source.__type === "aggregate" ||
      (field.source.__type === "database_expression" &&
        expressionContainsAggregate(field.source)),
  );
}
