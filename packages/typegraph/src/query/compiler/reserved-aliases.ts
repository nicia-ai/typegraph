import type { QueryAst } from "../ast";
import { visitNestedSubqueries } from "./alias-predicate-scope";
import { isReservedSqlName, reservedAliasRefusal } from "./sql-name-registry";

/** Every alias a statement declares: its start, each traversal's edge and node, and a recursive walk's depth and path. */
function declaredAliases(ast: QueryAst): readonly string[] {
  return [
    ast.start.alias,
    ...ast.traversals.flatMap((traversal) => [
      traversal.edgeAlias,
      traversal.nodeAlias,
      ...(traversal.variableLength?.depthAlias === undefined ?
        []
      : [traversal.variableLength.depthAlias]),
      ...(traversal.variableLength?.pathAlias === undefined ?
        []
      : [traversal.variableLength.pathAlias]),
    ]),
  ];
}

/**
 * Refuses a query whose statement, or any subquery nested anywhere in it,
 * declares an alias in the reserved `__tg` namespace. Builders refuse such an
 * alias where they accept it; this covers an AST built another way.
 *
 * It runs on the tree as the caller built it, before the compiler renames a
 * subquery's aliases into that namespace, so it must not run again on the
 * parts of a statement the compiler compiles on its own.
 */
export function refuseReservedQueryAliases(ast: QueryAst): void {
  for (const alias of declaredAliases(ast)) {
    if (isReservedSqlName(alias)) throw reservedAliasRefusal(alias);
  }
  visitNestedSubqueries(ast, (subquery) => {
    refuseReservedQueryAliases(subquery);
  });
}
