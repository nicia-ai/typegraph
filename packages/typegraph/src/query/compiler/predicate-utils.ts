import type { KindEntity } from "../../core/types";
import { CompilerInvariantError } from "../../errors";
import {
  type FulltextMatchPredicate,
  type NodePredicate,
  type QueryAst,
  type VectorSimilarityPredicate,
} from "../ast";
import { sql, type SqlFragment } from "../sql-fragment";
import {
  compilePredicateExpression,
  type PredicateCompilerContext,
} from "./predicates";

const EMPTY_PREDICATES: readonly NodePredicate[] = [];

/**
 * Builds a comma-separated bound-parameter list for an `IN (...)` clause. Each
 * value is parameterized, never interpolated.
 */
export function sqlValueList(values: readonly string[]): SqlFragment {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  );
}

export type PredicateIndex = Readonly<{
  byAliasAndType: ReadonlyMap<string, readonly NodePredicate[]>;
}>;

function buildPredicateIndexKey(alias: string, targetType: KindEntity): string {
  return `${alias}\u0000${targetType}`;
}

function resolvePredicateTargetType(predicate: NodePredicate): KindEntity {
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
  targetType: KindEntity,
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
): SqlFragment[] {
  return predicates.map((predicate) =>
    compilePredicateExpression(predicate.expression, predicateContext),
  );
}

export function compileKindFilter(
  column: SqlFragment,
  kinds: readonly string[],
): SqlFragment {
  if (kinds.length === 0) {
    return sql`1 = 0`;
  }
  if (kinds.length === 1) {
    return sql`${column} = ${kinds[0]}`;
  }
  return sql`${column} IN (${sqlValueList(kinds)})`;
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

/**
 * Returns the shared alias when a hybrid (vector + fulltext) query has
 * both predicates targeting the same alias — that's the case where the
 * emitter can fuse ranks via `HYBRID_CANDIDATES_CTE_ALIAS` / RRF.
 * Returns `undefined` when either predicate is missing or the two
 * predicates target different aliases.
 */
export function getHybridTargetAlias(
  vectorPredicate: VectorSimilarityPredicate | undefined,
  fulltextPredicate: FulltextMatchPredicate | undefined,
): string | undefined {
  if (!vectorPredicate || !fulltextPredicate) return undefined;
  return vectorPredicate.field.alias === fulltextPredicate.field.alias ?
      vectorPredicate.field.alias
    : undefined;
}
