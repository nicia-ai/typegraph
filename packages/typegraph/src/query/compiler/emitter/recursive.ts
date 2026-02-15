import { type SQL, sql } from "drizzle-orm";

import { type LogicalPlan } from "../plan";

export type RecursiveQueryEmitterInput = Readonly<{
  depthFilter: SQL;
  limitOffset?: SQL;
  logicalPlan: LogicalPlan;
  orderBy?: SQL;
  projection: SQL;
  recursiveCte: SQL;
}>;

function assertRecursivePlanRoot(logicalPlan: LogicalPlan): void {
  if (logicalPlan.root.op !== "project") {
    throw new Error(
      `Recursive SQL emitter expected logical plan root to be "project", got "${logicalPlan.root.op}"`,
    );
  }
}

export function emitRecursiveQuerySql(input: RecursiveQueryEmitterInput): SQL {
  assertRecursivePlanRoot(input.logicalPlan);

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
