import {
  type GraphBackend,
  type TransactionBackend,
  type TransactionOptions,
} from "../../backend/types";
import {
  ConfigurationError,
  type RecordedCaptureGuardCode,
} from "../../errors";
import { createSqlSchema, type SqlSchema } from "../../query/compiler/schema";
import type { SqlDialect } from "../../query/dialect/types";
import { sql, type SqlFragment } from "../../query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
  type CompiledStatementSql,
} from "../../query/sql-intent";
export { withRecordedRelationsPrecondition } from "../../utils/sql-errors";

type IsolationRow = Readonly<{ transaction_isolation: unknown }>;

const RECORDED_ISOLATION_REQUIRES_POSTGRES_CHECK = {
  postgres: true,
  sqlite: false,
} as const satisfies Record<SqlDialect, boolean>;

/**
 * Resolves the recorded-relation schema for a capture target, failing loud when
 * the backend does not expose `tableNames`. Without this guard a custom backend
 * that omits `tableNames` would silently fall back to {@link createSqlSchema}'s
 * defaults and write/close recorded rows against the wrong tables.
 */
export function requireRecordedSchema(
  target: Pick<GraphBackend, "tableNames" | "dialect">,
): SqlSchema {
  if (target.tableNames === undefined) {
    throw new ConfigurationError(
      "Recorded-time capture requires the backend to expose tableNames.",
      { dialect: target.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or set tableNames on the custom backend so recorded-time capture targets the configured relations.",
      },
    );
  }
  return createSqlSchema(target.tableNames);
}

/**
 * Asserts the transaction target can run capture's non-row-returning
 * statements. Checked once when a capture scope opens so the failure surfaces
 * before any write, not mid-flush after the live row is already written —
 * `assertCapturableBackend` only validates the outer backend, and a custom
 * backend's transaction target can differ from it.
 */
export function requireCaptureStatements(
  target: Pick<GraphBackend, "dialect" | "executeStatement">,
): asserts target is Pick<GraphBackend, "dialect" | "executeStatement"> &
  Readonly<{
    executeStatement: NonNullable<GraphBackend["executeStatement"]>;
  }> {
  if (target.executeStatement === undefined) {
    throw new ConfigurationError(
      "Recorded-time capture requires backend.executeStatement support on the transaction backend.",
      { dialect: target.dialect },
      {
        suggestion:
          "Use the built-in SQLite/PostgreSQL backends or provide executeStatement on the custom backend's transaction target.",
      },
    );
  }
}

export async function executeStatement(
  target: Pick<GraphBackend, "dialect" | "executeStatement">,
  query: SqlFragment,
): Promise<void> {
  requireCaptureStatements(target);
  await target.executeStatement(asCompiledStatementSql(query));
}

function unsupportedPostgresIsolationError(
  isolationLevel: string | undefined,
): ConfigurationError {
  return new ConfigurationError(
    "Recorded-time capture on PostgreSQL requires read_committed isolation.",
    { isolationLevel: isolationLevel ?? "unknown" },
    {
      suggestion:
        "Omit the transaction isolation option or use read_committed. PostgreSQL repeatable_read/serializable snapshots cannot safely allocate the per-graph recorded clock inside the captured transaction.",
    },
  );
}

function isSupportedRecordedIsolationLevel(
  isolationLevel: string | undefined,
): boolean {
  return (
    isolationLevel === undefined ||
    isolationLevel === "read_committed" ||
    isolationLevel === "read_uncommitted"
  );
}

export function assertRequestedRecordedIsolation(
  backend: Pick<GraphBackend, "dialect">,
  options: TransactionOptions | undefined,
): void {
  if (!RECORDED_ISOLATION_REQUIRES_POSTGRES_CHECK[backend.dialect]) return;
  if (options?.accessMode === "read_only") return;
  const isolationLevel = options?.isolationLevel;
  if (isSupportedRecordedIsolationLevel(isolationLevel)) return;

  throw unsupportedPostgresIsolationError(isolationLevel);
}

function normalizeIsolationLevel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replaceAll(" ", "_").toLowerCase();
}

export async function assertRecordedCaptureTransactionIsolation(
  target: Pick<TransactionBackend, "dialect" | "execute">,
  options?: TransactionOptions,
): Promise<void> {
  if (!RECORDED_ISOLATION_REQUIRES_POSTGRES_CHECK[target.dialect]) return;
  if (options?.accessMode === "read_only") return;

  const rows = await target.execute<IsolationRow>(
    asCompiledRowsSql(sql`
      SELECT current_setting('transaction_isolation') AS transaction_isolation
    `),
  );
  const isolationLevel = normalizeIsolationLevel(
    rows[0]?.transaction_isolation,
  );
  if (isSupportedRecordedIsolationLevel(isolationLevel)) return;

  throw unsupportedPostgresIsolationError(isolationLevel);
}

/**
 * The single error raised when a caller tries to adopt a context-returning
 * external transaction while history capture is on — there is no flush point
 * before the caller commits. The branchable `details.code` is set here so no
 * call site can omit it; any extra `details` merge underneath it.
 */
export function recordedCaptureRequiresCallbackTransactionError(
  details: Record<string, unknown> = {},
): ConfigurationError {
  return new ConfigurationError(
    "withTransaction() has no recorded-time capture flush point when history is enabled.",
    {
      ...details,
      code: "RECORDED_CAPTURE_REQUIRES_CALLBACK_TRANSACTION" satisfies RecordedCaptureGuardCode,
    },
    {
      suggestion:
        "Use store.withRecordedTransaction(externalTx, async (tx) => ...) so TypeGraph can flush capture before the caller commits.",
    },
  );
}

/**
 * Raw SQL surfaces (`tx.sql`, `backend.executeStatement`) write relational rows
 * without advancing recorded-time capture, so they are disabled on a
 * history-enabled store. `surface` names the escape the caller reached for.
 */
function historyUnsafeRawWriteError(surface: string): ConfigurationError {
  return new ConfigurationError(
    `${surface} is not available when history capture is enabled because raw SQL writes bypass recorded-time capture.`,
    {
      code: "RECORDED_CAPTURE_RAW_SQL_DISABLED" satisfies RecordedCaptureGuardCode,
    },
    {
      suggestion:
        "Run graph writes through store.nodes/store.edges (or tx.nodes/tx.edges inside a transaction), or perform raw relational writes outside a history-enabled TypeGraph store.",
    },
  );
}

function revisionTrackingUnsafeRawWriteError(
  surface: string,
): ConfigurationError {
  return new ConfigurationError(
    `${surface} is not available when revision tracking is enabled because raw SQL writes bypass the revision anchor.`,
    {
      code: "REVISION_TRACKING_RAW_SQL_DISABLED" satisfies RecordedCaptureGuardCode,
    },
    {
      suggestion:
        "Run graph writes through store.nodes/store.edges (or tx.nodes/tx.edges inside a transaction), so TypeGraph can advance the revision anchor.",
    },
  );
}

export function throwHistoryUnsafeSqlAccess(): never {
  throw historyUnsafeRawWriteError("tx.sql");
}

export function throwRevisionTrackingUnsafeSqlAccess(): never {
  throw revisionTrackingUnsafeRawWriteError("tx.sql");
}

/**
 * Disables the raw, non-row-returning write escapes on a history-enabled
 * backend: `executeStatement` and `executeDdl` both return `Promise<void>` and
 * exist solely to run relational writes/DDL that would bypass recorded-time
 * capture. The row-returning raw read path (`executeRaw`, the prepared-query
 * fast path) and `execute` are left intact — they are read contracts, treated
 * identically, and must not be used to route writes (e.g. `DELETE ...
 * RETURNING`); that invariant is documented, not policed by inspecting SQL text.
 */
export function rawWriteGuards(
  target: Pick<GraphBackend, "executeStatement" | "executeDdl">,
  prefix: string,
): Pick<Partial<GraphBackend>, "executeStatement" | "executeDdl"> {
  return {
    ...(target.executeStatement === undefined ?
      {}
    : {
        executeStatement(_query: CompiledStatementSql): Promise<void> {
          return Promise.reject(
            historyUnsafeRawWriteError(`${prefix}.executeStatement`),
          );
        },
      }),
    ...(target.executeDdl === undefined ?
      {}
    : {
        executeDdl(_ddl: string): Promise<void> {
          return Promise.reject(
            historyUnsafeRawWriteError(`${prefix}.executeDdl`),
          );
        },
      }),
  };
}

export function assertCapturableBackend(backend: GraphBackend): void {
  if (!backend.capabilities.transactions) {
    throw new ConfigurationError(
      "history: true requires a backend with transaction support.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a transactional SQLite/PostgreSQL backend or disable recorded-time capture for this store.",
      },
    );
  }
  if (backend.executeStatement === undefined) {
    throw new ConfigurationError(
      "history: true requires a backend that supports executeStatement.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or implement executeStatement on the custom backend so recorded-time capture can write history rows.",
      },
    );
  }
  if (backend.capabilities.returning === false) {
    throw new ConfigurationError(
      "history: true requires a backend that supports UPDATE … RETURNING.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or run recorded-time capture on a backend whose engine supports UPDATE … RETURNING — capture closes recorded intervals with a RETURNING statement on its hot path.",
      },
    );
  }
  if (backend.tableNames === undefined) {
    throw new ConfigurationError(
      "history: true requires a backend that exposes tableNames.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or set tableNames on the custom backend so recorded-time capture can resolve the recorded relations instead of silently falling back to defaults.",
      },
    );
  }
}

/**
 * Verifies the narrower backend contract for live-store revision tracking.
 * Unlike recorded-time history, a revision anchor does not capture after-images
 * and therefore does not require `UPDATE … RETURNING`.
 */
export function assertRevisionTrackableBackend(backend: GraphBackend): void {
  if (!backend.capabilities.transactions) {
    throw new ConfigurationError(
      "revisionTracking: true requires a backend with transaction support.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a transactional SQLite/PostgreSQL backend or leave revision tracking disabled.",
      },
    );
  }
  if (backend.executeStatement === undefined) {
    throw new ConfigurationError(
      "revisionTracking: true requires a backend that supports executeStatement.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or implement executeStatement so TypeGraph can advance the revision clock.",
      },
    );
  }
  if (backend.tableNames === undefined) {
    throw new ConfigurationError(
      "revisionTracking: true requires a backend that exposes tableNames.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or set tableNames so TypeGraph can address the revision clock relation.",
      },
    );
  }
  if (backend.ensureRevisionOriginsTable === undefined) {
    throw new ConfigurationError(
      "revisionTracking: true requires a backend that can bootstrap revision origins.",
      { dialect: backend.dialect },
      {
        suggestion:
          "Use a built-in SQLite/PostgreSQL backend, or implement ensureRevisionOriginsTable so TypeGraph can durably namespace revision anchors.",
      },
    );
  }
}
