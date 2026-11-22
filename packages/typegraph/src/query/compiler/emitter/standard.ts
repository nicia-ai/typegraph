import { CompilerInvariantError } from "../../../errors";
import { sql, type SqlFragment } from "../../sql-fragment";
import { bindUnresolvedColumnReads } from "../column-reads";
import { type LogicalPlan } from "../plan";
import { inspectStandardProjectPlan } from "./plan-inspector";

/**
 * A FROM clause and the WITH relations it names. An unqualified column
 * reference in the SELECT that owns the clause resolves in those relations.
 */
export type StandardFromClause = Readonly<{
  sql: SqlFragment;
  relations: readonly string[];
}>;

export type StandardQueryEmitterInput = Readonly<{
  ctes: readonly SqlFragment[];
  fromClause: StandardFromClause;
  where?: SqlFragment;
  groupBy?: SqlFragment;
  having?: SqlFragment;
  limitOffset?: SqlFragment;
  logicalPlan: LogicalPlan;
  orderBy?: SqlFragment;
  projection: SqlFragment;
}>;

function assertStandardEmitterClauseAlignment(
  logicalPlan: LogicalPlan,
  input: StandardQueryEmitterInput,
): void {
  const planShape = inspectStandardProjectPlan(logicalPlan);
  if (input.groupBy !== undefined && !planShape.hasAggregate) {
    throw new CompilerInvariantError(
      "Standard SQL emitter received GROUP BY clause for a plan without aggregate nodes",
      { component: "standard-emitter" },
    );
  }
  if (input.having !== undefined && !planShape.hasAggregate) {
    throw new CompilerInvariantError(
      "Standard SQL emitter received HAVING clause for a plan without aggregate nodes",
      { component: "standard-emitter" },
    );
  }
  const expectsOrderBy =
    planShape.hasSort || planShape.hasVectorKnn || planShape.hasFulltextMatch;
  if (expectsOrderBy && input.orderBy === undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter expected ORDER BY clause for plan containing a sort, vector_knn, or fulltext_match node",
      { component: "standard-emitter" },
    );
  }
  if (!expectsOrderBy && input.orderBy !== undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter received ORDER BY clause for a plan without sort, vector_knn, or fulltext_match nodes",
      { component: "standard-emitter" },
    );
  }
  if (planShape.hasLimitOffset && input.limitOffset === undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter expected LIMIT/OFFSET clause for plan containing a limit_offset node",
      { component: "standard-emitter" },
    );
  }
  if (!planShape.hasLimitOffset && input.limitOffset !== undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter received LIMIT/OFFSET clause for a plan without limit_offset nodes",
      { component: "standard-emitter" },
    );
  }
}

export function emitStandardQuerySql(
  input: StandardQueryEmitterInput,
): SqlFragment {
  assertStandardEmitterClauseAlignment(input.logicalPlan, input);

  const parts: SqlFragment[] = [];
  if (input.ctes.length > 0) {
    parts.push(sql`WITH ${sql.join([...input.ctes], sql`, `)}`);
  }

  const select: SqlFragment[] = [
    sql`SELECT ${input.projection}`,
    input.fromClause.sql,
  ];
  for (const clause of [
    input.where,
    input.groupBy,
    input.having,
    input.orderBy,
    input.limitOffset,
  ])
    if (clause !== undefined) select.push(clause);
  // Unqualified references in this SELECT resolve in the relations of its FROM.
  parts.push(
    bindUnresolvedColumnReads(
      sql.join(select, sql` `),
      input.fromClause.relations,
    ),
  );

  return sql.join(parts, sql` `);
}
