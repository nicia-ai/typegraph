import { type SQL, sql } from "drizzle-orm";

import { type LogicalPlan } from "../plan";

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

function assertStandardPlanRoot(logicalPlan: LogicalPlan): void {
  if (logicalPlan.root.op !== "project") {
    throw new Error(
      `Standard SQL emitter expected logical plan root to be "project", got "${logicalPlan.root.op}"`,
    );
  }
}

export function emitStandardQuerySql(input: StandardQueryEmitterInput): SQL {
  assertStandardPlanRoot(input.logicalPlan);

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
