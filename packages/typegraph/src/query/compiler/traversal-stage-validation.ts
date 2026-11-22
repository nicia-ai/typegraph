import { UnsupportedPredicateError } from "../../errors";
import type { QueryAst, Traversal } from "../ast";
import { visitPredicateFields } from "./standard-pass-pipeline";

/** Refuses predicates that an independently compiled traversal stage cannot evaluate. */
export function assertTraversalStagePredicatesSupported(
  ast: QueryAst,
  traversal: Traversal,
  index: number,
): void {
  const stageTargets = new Set([
    traversal.edgeAlias,
    traversal.nodeAlias,
    ...(index === 0 ? [ast.start.alias] : []),
  ]);

  for (const predicate of ast.predicates) {
    if (!stageTargets.has(predicate.targetAlias)) continue;
    visitPredicateFields(predicate.expression, (field) => {
      if (field.alias !== predicate.targetAlias) {
        throw new UnsupportedPredicateError(
          `Traversal stage predicate for alias "${predicate.targetAlias}" cannot evaluate cross-alias reference "${field.alias}"; use completed where() for comparisons between aliases.`,
        );
      }
    });
  }
}
