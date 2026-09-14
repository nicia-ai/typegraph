import type { FieldRef, QueryAst } from "../ast";
import type { DatabaseExpression } from "../expressions";

const ALIAS_KEYS = new Set([
  "alias",
  "depthAlias",
  "edgeAlias",
  "fromAlias",
  "joinFromAlias",
  "nodeAlias",
  "pathAlias",
  "startAlias",
  "targetAlias",
]);
export type ExpressionAliasScope = ReadonlyMap<string, string>;

export function namespaceExpressionSubquery(
  ast: QueryAst,
  prefix: string,
): Readonly<{ ast: QueryAst; aliases: ExpressionAliasScope }> {
  const rewrittenAliases = new Map<string, string>([
    [ast.start.alias, `${prefix}a0`],
  ]);
  const physicalAliases = new Map(rewrittenAliases);
  for (const [index, traversal] of ast.traversals.entries()) {
    const edgeAlias = `${prefix}e${index}`;
    const nodeAlias = `${prefix}a${index + 1}`;
    rewrittenAliases.set(traversal.edgeAlias, edgeAlias);
    rewrittenAliases.set(traversal.nodeAlias, nodeAlias);
    physicalAliases.set(traversal.edgeAlias, nodeAlias);
    physicalAliases.set(traversal.nodeAlias, nodeAlias);
  }
  function rewrite(value: unknown, key?: string): unknown {
    if (typeof value === "string" && key !== undefined && ALIAS_KEYS.has(key))
      return rewrittenAliases.get(value) ?? value;
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry));
    if (typeof value !== "object" || value === null || value instanceof Date)
      return value;
    const record = value as Readonly<Record<string, unknown>>;
    if (
      record["__type"] === "literal" ||
      record["kind"] === "literal" ||
      record["kind"] === "outer_reference" ||
      record["kind"] === "exists_subquery" ||
      record["kind"] === "scalar_subquery"
    )
      return value;
    return Object.fromEntries(
      Object.entries(record).map(([entryKey, entry]) => [
        entryKey,
        rewrite(entry, entryKey),
      ]),
    );
  }
  return { aliases: physicalAliases, ast: rewrite(ast) as QueryAst };
}

/** Visits enclosing fields referenced anywhere in a nested query, without lifting its local fields. */
export function visitCorrelatedExpressionFields(
  ast: QueryAst,
  scopeIdentity: symbol,
  visit: (field: FieldRef) => void,
): void {
  function walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== "object" || value === null || value instanceof Date)
      return;
    const record = value as Readonly<Record<string, unknown>>;
    if (record["__type"] === "literal" || record["kind"] === "literal") return;
    if (record["__type"] === "database_expression") {
      const expression = value as DatabaseExpression;
      if (expression.node.kind === "outer_reference") {
        const { outerScopeIdentity, expression: outer } = expression.node;
        if (outerScopeIdentity === scopeIdentity && outer.node.kind === "field")
          visit(outer.node.field);
        return;
      }
    }
    for (const entry of Object.values(record)) walk(entry);
  }
  walk(ast);
}
