import { UnsupportedPredicateError } from "../../errors";
import type { QueryAst } from "../ast";
import type { DatabaseExpression } from "../expressions";

/**
 * Refuses an alias predicate that reads an enclosing query when the statement
 * evaluating it is compiled in isolation.
 *
 * A recursive traversal chain compiles each fixed stage, and the start-alias
 * source of an optional first traversal, as a separate statement with no
 * enclosing query in scope, so an outer reference there has nothing to read.
 * Recursive stages compile in the chain's own scope and are not checked.
 *
 * Which aliases a predicate may read of its own statement is decided by
 * `assertAliasPredicatesReadOnlyTheirTarget`; this check only answers whether
 * the enclosing scope is available.
 */
export function assertIsolatedStageReadsNoEnclosingQuery(
  isolated: QueryAst,
  callerAlias: (alias: string) => string = (alias) => alias,
): void {
  for (const predicate of isolated.predicates) {
    if (!readsEnclosingQuery(predicate.expression, isolated.expressionScope))
      continue;
    const targetAlias = callerAlias(predicate.targetAlias);
    throw new UnsupportedPredicateError(
      `The predicate on alias "${targetAlias}" reads an enclosing query, which this stage of a recursive traversal chain is compiled without; correlate on a recursive stage, or compare in where().`,
      { targetAlias },
      {
        suggestion:
          "A query with a recursive traversal compiles its fixed stages, and the start of an optional first recursive traversal, as separate statements. Correlate through a predicate on a recursive stage's alias, or in the subquery's where(), which filters completed matches.",
      },
    );
  }
}

/**
 * Whether a predicate holds an outer reference to a scope that is neither the
 * isolated statement's own nor one of the subqueries nested inside it.
 */
function readsEnclosingQuery(
  expression: unknown,
  ownScope: symbol | undefined,
): boolean {
  const localScopes = new Set<symbol>();
  if (ownScope !== undefined) localScopes.add(ownScope);
  const referencedScopes: symbol[] = [];
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
    // A database expression of an object field is a proxy that refuses
    // keys its schema does not declare; only its node is read.
    if (type === "database_expression") {
      walkExpressionNode((value as DatabaseExpression).node);
      return;
    }
    for (const entry of Object.values(record)) walk(entry);
  }
  function walkExpressionNode(node: DatabaseExpression["node"]): void {
    if (node.kind === "literal") return;
    if (node.kind === "outer_reference")
      referencedScopes.push(node.outerScopeIdentity);
    if (node.kind === "exists_subquery" || node.kind === "scalar_subquery") {
      const scope = node.subquery.expressionScope;
      if (scope !== undefined) localScopes.add(scope);
    }
    for (const entry of Object.values(node)) walk(entry);
  }
  walk(expression);
  return referencedScopes.some((scope) => !localScopes.has(scope));
}
