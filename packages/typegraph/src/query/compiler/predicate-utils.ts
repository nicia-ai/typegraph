import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../errors";
import { type NodePredicate, type QueryAst } from "../ast";
import {
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";

const EMPTY_PREDICATES: readonly NodePredicate[] = [];

export type PredicateIndex = Readonly<{
  byAliasAndType: ReadonlyMap<string, readonly NodePredicate[]>;
}>;

function buildPredicateIndexKey(
  alias: string,
  targetType: "node" | "edge",
): string {
  return `${alias}\u0000${targetType}`;
}

function resolvePredicateTargetType(predicate: NodePredicate): "node" | "edge" {
  return predicate.targetType === "edge" ? "edge" : "node";
}

export function buildPredicateIndex(ast: QueryAst): PredicateIndex {
  const byAliasAndType = new Map<string, NodePredicate[]>();
  for (const predicate of ast.predicates) {
    const key = buildPredicateIndexKey(
      predicate.targetAlias,
      resolvePredicateTargetType(predicate),
    );
    const existing = byAliasAndType.get(key);
    if (existing === undefined) {
      byAliasAndType.set(key, [predicate]);
    } else {
      existing.push(predicate);
    }
  }
  return { byAliasAndType };
}

export function getPredicatesForAlias(
  predicateIndex: PredicateIndex,
  alias: string,
  targetType: "node" | "edge",
): readonly NodePredicate[] {
  return (
    predicateIndex.byAliasAndType.get(
      buildPredicateIndexKey(alias, targetType),
    ) ?? EMPTY_PREDICATES
  );
}

export function compilePredicateClauses(
  predicates: readonly NodePredicate[],
  predicateContext: PredicateCompilerContext,
): SQL[] {
  return predicates.map((predicate) =>
    compilePredicateExpression(predicate.expression, predicateContext),
  );
}

export function compileKindFilter(column: SQL, kinds: readonly string[]): SQL {
  if (kinds.length === 0) {
    return sql`1 = 0`;
  }
  if (kinds.length === 1) {
    return sql`${column} = ${kinds[0]}`;
  }
  return sql`${column} IN (${sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

export function getNodeKindsForAlias(
  ast: QueryAst,
  alias: string,
): readonly string[] {
  if (alias === ast.start.alias) {
    return ast.start.kinds;
  }

  for (const traversal of ast.traversals) {
    if (traversal.nodeAlias === alias) {
      return traversal.nodeKinds;
    }
  }

  throw new CompilerInvariantError(`Unknown traversal source alias: ${alias}`);
}
