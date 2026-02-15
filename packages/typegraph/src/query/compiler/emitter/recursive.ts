import { type SQL, sql } from "drizzle-orm";

import { type LogicalPlan } from "../plan";
import { inspectRecursiveProjectPlan } from "./plan-inspector";

export type RecursiveQueryEmitterInput = Readonly<{
  depthFilter: SQL;
  limitOffset?: SQL;
  logicalPlan: LogicalPlan;
  orderBy?: SQL;
  projection: SQL;
  recursiveCte: SQL;
}>;

function assertRecursiveEmitterClauseAlignment(
  logicalPlan: LogicalPlan,
  input: RecursiveQueryEmitterInput,
): void {
  const planShape = inspectRecursiveProjectPlan(logicalPlan);
  if (planShape.hasSort && input.orderBy === undefined) {
    throw new Error(
      "Recursive SQL emitter expected ORDER BY clause for plan containing a sort node",
    );
  }
  if (!planShape.hasSort && input.orderBy !== undefined) {
    throw new Error(
      "Recursive SQL emitter received ORDER BY clause for a plan without sort nodes",
    );
  }
  if (planShape.hasLimitOffset && input.limitOffset === undefined) {
    throw new Error(
      "Recursive SQL emitter expected LIMIT/OFFSET clause for plan containing a limit_offset node",
    );
  }
  if (!planShape.hasLimitOffset && input.limitOffset !== undefined) {
    throw new Error(
      "Recursive SQL emitter received LIMIT/OFFSET clause for a plan without limit_offset nodes",
    );
  }
}

export function emitRecursiveQuerySql(input: RecursiveQueryEmitterInput): SQL {
  assertRecursiveEmitterClauseAlignment(input.logicalPlan, input);

  const parts: SQL[] = [
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
