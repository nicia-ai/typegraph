/**
 * The SQL-execution primitives every identity relation writer shares: the
 * target type identity statements run against, the bind-budget chunk math, and
 * the statement runner.
 *
 * Extracted so the derived-relation writers (`separation.ts`) and the identity
 * service can both use them without importing each other.
 */
import {
  type BackendIdentity,
  type GraphBackend,
  type GraphEntityReadBackend,
  type QueryExecutionBackend,
  type RawQueryExecutionBackend,
  type SchemaReadBackend,
  type SqlCompilationBackend,
} from "../backend/types";
import { ConfigurationError } from "../errors";
import { type SqlFragment } from "../query/sql-fragment";
import { asCompiledStatementSql } from "../query/sql-intent";
import { recordedBindParamBudget } from "../store/recorded-capture/relations";
import { isSqliteStaleSnapshotError } from "../utils/sql-errors";

/**
 * What an identity statement runs against: reads, compiled execution, and the
 * optional raw-statement port {@link executeIdentityStatement} refuses without.
 *
 * An EXPLICIT FACET COMPOSITION rather than `GraphBackend | TransactionBackend`,
 * for the same reason `TransactionBackend` is one: identity writes touch the
 * identity relations through `executeStatement`, never through a graph-entity
 * write member, so naming the members states what identity may reach instead of
 * inheriting every mutation port a backend happens to expose.
 *
 * Both backend shapes are still assignable to it, so no existing caller
 * changes. What the composition additionally admits is the write pipeline's
 * row-work projection (`WriteTarget`): the store's identity fold and detach run
 * inside a write frame, whose handle exposes reads only, and `executeStatement`
 * is optional here exactly as it is on `GraphBackend` — so a target that cannot
 * run statements is refused by {@link executeIdentityStatement} with a named
 * error rather than excluded by a type nobody in row work can produce.
 */
export type IdentityTarget = Readonly<
  BackendIdentity &
    GraphEntityReadBackend &
    SchemaReadBackend &
    QueryExecutionBackend &
    SqlCompilationBackend &
    RawQueryExecutionBackend &
    Pick<GraphBackend, "executeStatement">
>;

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

/**
 * The refusal an identity write raises when SQLite would not let the enclosing
 * transaction become a writer (#447).
 *
 * The per-graph identity locks (`lockIdentityGraph`, `lockIdentityDdl`) are
 * no-ops on SQLite, on the premise that TypeGraph's own transactions open
 * `BEGIN IMMEDIATE` and therefore hold the database's single writer slot for
 * the whole read→write identity fold. `adoptTransaction` breaks exactly that
 * premise: it adopts a transaction the CALLER began, which may be DEFERRED, and
 * the adoption seam cannot observe how — SQLite exposes no frame-kind query
 * through any bundled driver. A deferred frame is a reader until its first
 * write, so the fold's write can find the snapshot stale and lose the upgrade.
 *
 * SQLite renders that as `SQLITE_BUSY_SNAPSHOT` / "database is locked", which
 * says nothing about the cause and names no remedy. It is not retryable in
 * place either — SQLite's own contract is that the transaction must be rolled
 * back — and the transaction boundary belongs to the caller, so identity cannot
 * restart it. What identity CAN guarantee is that the failure never surfaces as
 * a raw driver error: it names the adopted deferred frame and the fix.
 */
function identityWriterSlotError(cause: unknown): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity could not take the SQLite writer slot: this transaction was begun DEFERRED and another connection committed before the identity write, so its read snapshot is stale.",
    {
      code: "IDENTITY_TRANSACTION_NOT_WRITE_FENCED",
      sqliteCode: "SQLITE_BUSY_SNAPSHOT",
    },
    {
      cause,
      suggestion:
        "Roll back and re-run the transaction (SQLite cannot upgrade a stale snapshot in place). Identity mutations serialize on the writer slot, so an adopted transaction must be opened with BEGIN IMMEDIATE — or run the writes through store.transaction(), which already does.",
    },
  );
}

/** Runs one write statement against an identity target. */
export async function executeIdentityStatement(
  target: IdentityTarget,
  statement: SqlFragment,
): Promise<void> {
  requireStatementTarget(target);
  try {
    await target.executeStatement(asCompiledStatementSql(statement));
  } catch (error) {
    // Every identity relation writer runs through here, so translating at this
    // one seam covers the whole surface — the fold, the derived-relation
    // writers, maintenance and the schema transition alike.
    if (!isSqliteStaleSnapshotError(error)) throw error;
    throw identityWriterSlotError(error);
  }
}
