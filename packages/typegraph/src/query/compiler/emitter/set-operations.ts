import { type SQL, sql } from "drizzle-orm";

import { CompilerInvariantError } from "../../../errors";
import { type LogicalPlan } from "../plan";
import { inspectSetOperationPlan } from "./plan-inspector";

export type SetOperationQueryEmitterInput = Readonly<{
  baseQuery: SQL;
  ctes?: readonly SQL[];
  logicalPlan: LogicalPlan;
  suffixClauses?: readonly SQL[];
}>;

function assertSetOperationEmitterClauseAlignment(
  logicalPlan: LogicalPlan,
  suffixClauses: readonly SQL[] | undefined,
): void {
  const shape = inspectSetOperationPlan(logicalPlan);
  const hasSuffixClauses =
    suffixClauses !== undefined && suffixClauses.length > 0;

  if (!shape.hasSort && !shape.hasLimitOffset && hasSuffixClauses) {
    throw new CompilerInvariantError(
      "Set-operation SQL emitter received suffix clauses for a plan without top-level sort or limit_offset nodes",
      { component: "set-operation-emitter" },
    );
  }

  if (!hasSuffixClauses) {
    if (shape.hasSort || shape.hasLimitOffset) {
      throw new CompilerInvariantError(
        "Set-operation SQL emitter expected suffix clauses for plan containing top-level sort or limit_offset nodes",
        { component: "set-operation-emitter" },
      );
    }
    return;
  }

  const limitOffsetClauseCount =
    shape.limitOffsetNode === undefined ?
      0
    : (shape.limitOffsetNode.limit === undefined ? 0 : 1) +
      (shape.limitOffsetNode.offset === undefined ? 0 : 1);
  const expectedClauseCount =
    (shape.sortNode === undefined ? 0 : 1) + limitOffsetClauseCount;

  if (suffixClauses.length !== expectedClauseCount) {
    throw new CompilerInvariantError(
      `Set-operation SQL emitter expected ${String(expectedClauseCount)} top-level suffix clause(s) from logical plan, got ${String(suffixClauses.length)}`,
      { component: "set-operation-emitter" },
    );
  }
}

export function emitSetOperationQuerySql(
  input: SetOperationQueryEmitterInput,
): SQL {
  assertSetOperationEmitterClauseAlignment(
    input.logicalPlan,
    input.suffixClauses,
  );

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
