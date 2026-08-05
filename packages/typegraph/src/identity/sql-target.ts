/**
 * The SQL-execution primitives every identity relation writer shares: the
 * target type identity statements run against, the bind-budget chunk math, and
 * the statement runner.
 *
 * Extracted so the derived-relation writers (`separation.ts`) and the identity
 * service can both use them without importing each other.
 */
import { type GraphBackend, type TransactionBackend } from "../backend/types";
import { ConfigurationError } from "../errors";
import { type SqlFragment } from "../query/sql-fragment";
import { asCompiledStatementSql } from "../query/sql-intent";
import { recordedBindParamBudget } from "../store/recorded-capture/relations";

/** A top-level backend or a transaction-scoped one; identity writes accept both. */
export type IdentityTarget = GraphBackend | TransactionBackend;

/** A node reference stripped to the two columns identity relations store. */
export type PlainNodeRef = Readonly<{ kind: string; id: string }>;

/**
 * Upper bound on how many node references one identity statement names. Kept
 * well below every backend's bind budget so the chunk math below, not the
 * driver, decides statement size on generous engines.
 */
export const MAX_REFERENCE_CHUNK_SIZE = 200;

/**
 * How many items fit in one statement given the target's bind-parameter
 * budget, capped at `maxItems`.
 *
 * @throws {ConfigurationError} when even a single item cannot fit.
 */
export function identityChunkSize(
  target: IdentityTarget,
  input: Readonly<{
    fixedParameters: number;
    maxItems: number;
    parametersPerItem: number;
  }>,
): number {
  const parameterLimit = recordedBindParamBudget(target);
  const chunkSize = Math.floor(
    (parameterLimit - input.fixedParameters) / input.parametersPerItem,
  );
  if (chunkSize < 1) {
    throw new ConfigurationError(
      "Operational Identity cannot fit this statement within the backend bind-parameter limit.",
      {
        code: "IDENTITY_BIND_BUDGET_TOO_SMALL",
        parameterLimit,
        fixedParameters: input.fixedParameters,
        parametersPerItem: input.parametersPerItem,
      },
    );
  }
  return Math.min(input.maxItems, chunkSize);
}

function requireStatementTarget(
  target: IdentityTarget,
): asserts target is IdentityTarget & {
  executeStatement: NonNullable<GraphBackend["executeStatement"]>;
} {
  if (target.executeStatement === undefined) {
    throw new ConfigurationError(
      "Operational Identity requires statement execution support.",
      { code: "IDENTITY_REQUIRES_STATEMENT_EXECUTION" },
      {
        suggestion:
          "Use a built-in transactional SQLite or PostgreSQL backend.",
      },
    );
  }
}

/** Runs one write statement against an identity target. */
export async function executeIdentityStatement(
  target: IdentityTarget,
  statement: SqlFragment,
): Promise<void> {
  requireStatementTarget(target);
  await target.executeStatement(asCompiledStatementSql(statement));
}
