import { CompilerInvariantError } from "../../../errors";
import { sql, type SqlFragment } from "../../sql-fragment";
import { type LogicalPlan } from "../plan";
import { inspectRecursiveProjectPlan } from "./plan-inspector";

export type RecursiveQueryEmitterInput = Readonly<{
  depthFilter: SqlFragment;
  limitOffset?: SqlFragment;
  logicalPlan: LogicalPlan;
  orderBy?: SqlFragment;
  projection: SqlFragment;
  recursiveCte: SqlFragment;
}>;

function assertRecursiveEmitterClauseAlignment(
  logicalPlan: LogicalPlan,
  input: RecursiveQueryEmitterInput,
): void {
  const planShape = inspectRecursiveProjectPlan(logicalPlan);
  if (planShape.hasSort && input.orderBy === undefined) {
    throw new CompilerInvariantError(
      "Recursive SQL emitter expected ORDER BY clause for plan containing a sort node",
      { component: "recursive-emitter" },
    );
  }
  if (!planShape.hasSort && input.orderBy !== undefined) {
    throw new CompilerInvariantError(
      "Recursive SQL emitter received ORDER BY clause for a plan without sort nodes",
      { component: "recursive-emitter" },
    );
  }
  if (planShape.hasLimitOffset && input.limitOffset === undefined) {
    throw new CompilerInvariantError(
      "Recursive SQL emitter expected LIMIT/OFFSET clause for plan containing a limit_offset node",
      { component: "recursive-emitter" },
    );
  }
  if (!planShape.hasLimitOffset && input.limitOffset !== undefined) {
    throw new CompilerInvariantError(
      "Recursive SQL emitter received LIMIT/OFFSET clause for a plan without limit_offset nodes",
      { component: "recursive-emitter" },
    );
  }
}

export function emitRecursiveQuerySql(
  input: RecursiveQueryEmitterInput,
): SqlFragment {
  assertRecursiveEmitterClauseAlignment(input.logicalPlan, input);

  const parts: SqlFragment[] = [
    sql`WITH RECURSIVE`,
    input.recursiveCte,
    sql`SELECT ${input.projection}`,
    sql`FROM recursive_cte`,
    input.depthFilter,
  ];

  if (input.orderBy !== undefined) {
    parts.push(input.orderBy);
  }
  if (input.limitOffset !== undefined) {
    parts.push(input.limitOffset);
  }

  return sql.join(parts, sql` `);
}
