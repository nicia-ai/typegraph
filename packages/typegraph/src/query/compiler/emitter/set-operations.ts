import { type SQL, sql } from "drizzle-orm";

import { type LogicalPlan, type LogicalPlanNode } from "../plan";

export type SetOperationQueryEmitterInput = Readonly<{
  baseQuery: SQL;
  ctes?: readonly SQL[];
  logicalPlan: LogicalPlan;
  suffixClauses?: readonly SQL[];
}>;

function planContainsSetOperation(node: LogicalPlanNode): boolean {
  switch (node.op) {
    case "set_op": {
      return true;
    }
    case "aggregate":
    case "filter":
    case "join":
    case "limit_offset":
    case "project":
    case "recursive_expand":
    case "sort":
    case "vector_knn": {
      return planContainsSetOperation(node.input);
    }
    case "scan": {
      return false;
    }
  }
}

function assertSetOperationPlan(logicalPlan: LogicalPlan): void {
  if (!planContainsSetOperation(logicalPlan.root)) {
    throw new Error(
      'Set-operation SQL emitter expected logical plan to contain a "set_op" node',
    );
  }
}

export function emitSetOperationQuerySql(
  input: SetOperationQueryEmitterInput,
): SQL {
  assertSetOperationPlan(input.logicalPlan);

  const parts: SQL[] = [];
  if (input.ctes !== undefined && input.ctes.length > 0) {
    parts.push(sql`WITH ${sql.join([...input.ctes], sql`, `)}`);
  }

  parts.push(input.baseQuery);

  if (input.suffixClauses !== undefined && input.suffixClauses.length > 0) {
    parts.push(...input.suffixClauses);
  }

  return sql.join(parts, sql` `);
}
