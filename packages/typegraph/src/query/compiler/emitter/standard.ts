import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import { type LogicalPlan } from "../plan";
import { inspectStandardProjectPlan } from "./plan-inspector";

export type StandardQueryEmitterInput = Readonly<{
  ctes: readonly SQL[];
  fromClause: SQL;
  groupBy?: SQL;
  having?: SQL;
  limitOffset?: SQL;
  logicalPlan: LogicalPlan;
  orderBy?: SQL;
  projection: SQL;
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
  const expectsOrderBy = planShape.hasSort || planShape.hasVectorKnn;
  if (expectsOrderBy && input.orderBy === undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter expected ORDER BY clause for plan containing a sort or vector_knn node",
      { component: "standard-emitter" },
    );
  }
  if (!expectsOrderBy && input.orderBy !== undefined) {
    throw new CompilerInvariantError(
      "Standard SQL emitter received ORDER BY clause for a plan without sort or vector_knn nodes",
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

export function emitStandardQuerySql(input: StandardQueryEmitterInput): SQL {
  assertStandardEmitterClauseAlignment(input.logicalPlan, input);

  const parts: SQL[] = [];
  if (input.ctes.length > 0) {
    parts.push(sql`WITH ${sql.join([...input.ctes], sql`, `)}`);
  }

  parts.push(sql`SELECT ${input.projection}`, input.fromClause);

  if (input.groupBy !== undefined) {
    parts.push(input.groupBy);
  }
  if (input.having !== undefined) {
    parts.push(input.having);
  }
  if (input.orderBy !== undefined) {
    parts.push(input.orderBy);
  }
  if (input.limitOffset !== undefined) {
    parts.push(input.limitOffset);
  }

  return sql.join(parts, sql` `);
}
