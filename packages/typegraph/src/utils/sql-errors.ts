/**
 * Cross-dialect detection of "this relation does not exist yet" errors.
 *
 * Shared so the schema bootstrap (`loadActiveSchemaWithBootstrap`) and
 * the durable contribution-materialization gate (#135) agree on what a
 * missing-table failure looks like, and — critically — so neither one
 * swallows a genuine system fault (connection/permission/driver error)
 * as a benign "not bootstrapped yet".
 *
 * Detection walks the error's `cause` chain because Drizzle (>= the
 * `DrizzleQueryError` era, drizzle-orm ≥ 0.36) wraps every failure from a
 * query-builder call (`db.select()`, `db.insert()`, …): the wrapper's
 * `.message` becomes the failed query text and the real driver error —
 * which carries both the missing-relation text and the SQLSTATE — is
 * preserved on `.cause`. node-postgres / postgres-js nest the pg error
 * one link deep; better-sqlite3 throws it unwrapped; raw `client.query()`
 * fast paths surface it directly. Walking the chain makes the check
 * wrapper- and driver-agnostic instead of only matching the outermost
 * `.message`, which on Postgres is just the SQL string.
 */

import { ConfigurationError } from "../errors";

const SQLITE_MISSING_TABLE_PATTERN = "no such table";
const SQLITE_GENERIC_ERROR_CODE = "SQLITE_ERROR";
const SQLITE_NOT_AUTHORIZED_CODE = "SQLITE_AUTH";

/**
 * SQLite's EXTENDED result code for "this read transaction cannot become a
 * write transaction": the connection began a DEFERRED transaction, took a read
 * snapshot, and another connection has committed since. SQLite refuses the
 * upgrade because honoring it would let the writer act on a stale view; the
 * only recovery is `ROLLBACK` and a fresh transaction (SQLite's own rule — the
 * failure is not retryable in place).
 *
 * It is the one code that names the DEFERRED frame itself. A transaction opened
 * `BEGIN IMMEDIATE` holds the writer slot from the start and can never produce
 * it, and plain `SQLITE_BUSY` says something else entirely ("another writer
 * holds the slot right now"), so this code alone can be attributed to how the
 * transaction was begun. The numeric spelling is accepted for libSQL, which
 * surfaces only `rawCode`/`extendedCode` over a remote connection.
 */
const SQLITE_STALE_SNAPSHOT_CODE = "SQLITE_BUSY_SNAPSHOT";
const SQLITE_STALE_SNAPSHOT_EXTENDED_CODE = 517;
const DRIZZLE_QUERY_ERROR_PREFIX = "Failed query:";
const POSTGRES_UNDEFINED_RELATION_PATTERN =
  /\b(?:relation|table)\s+"[^"]+"\s+does not exist\b/i;

/**
 * SQLSTATE for PostgreSQL `undefined_table`. Preferred over the
 * human-readable message: it is locale-independent (the "... does not
 * exist" text is translated under a non-English `lc_messages`) and is
 * preserved on the underlying driver error even when Drizzle overwrites
 * `.message` with the query text.
 */
const POSTGRES_UNDEFINED_TABLE_CODE = "42P01";
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const POSTGRES_NOT_NULL_VIOLATION_CODE = "23502";

/**
 * SQLSTATEs a racing IDEMPOTENT DDL statement loses with — the ones that mean
 * "another session is committing the very thing this statement asks for", not
 * "this statement is wrong".
 *
 * PostgreSQL's `IF NOT EXISTS` is not a concurrency primitive: the existence
 * check cannot see another session's uncommitted catalog rows, so the loser
 * waits for the winner and is then handed the conflict the winner's commit
 * produced — `unique_violation` (23505) from `pg_type`/`pg_class` for a racing
 * CREATE, `duplicate_column` (42701) for a racing `ALTER TABLE ... ADD COLUMN
 * IF NOT EXISTS`, and `duplicate_object` (42710) for a racing named constraint.
 * Retrying once after that wait observes the committed object and succeeds; a
 * failure the retry cannot clear stays loud.
 */
const POSTGRES_CONCURRENT_DDL_RACE_SQL_STATES = [
  POSTGRES_UNIQUE_VIOLATION_CODE,
  "42701",
  "42710",
] as const;

/**
 * The one concurrent-DDL race PostgreSQL reports with no SQLSTATE of its own:
 * `heap_update` losing a catalog row to a concurrent updater raises
 * `elog(ERROR, "tuple concurrently updated")`, which carries the catch-all
 * `internal_error` (XX000).
 *
 * XX000 alone is far too broad to retry on — it covers genuine server faults —
 * so this shape is identified by SQLSTATE AND message together. Matching the
 * message is sound here specifically because `elog` emits it through
 * `errmsg_internal`, which is NOT run through gettext: unlike an `ereport`
 * message, it reads identically under every `lc_messages`.
 */
const POSTGRES_INTERNAL_ERROR_CODE = "XX000";
const POSTGRES_CONCURRENT_TUPLE_UPDATE_MESSAGE = "tuple concurrently updated";

/**
 * PostgreSQL failures that mean a temporary table cannot be created here:
 * `read_only_sql_transaction` (a replica or otherwise read-only execution
 * context) and `insufficient_privilege` (a role without the database `TEMP`
 * privilege).
 */
const POSTGRES_TEMPORARY_TABLE_UNAVAILABLE_SQL_STATES = [
  "25006",
  "42501",
] as const;

/**
 * PostgreSQL failures that mean the read-write transaction hosting temporary
 * tables cannot even start. A standby rejects the read-write access mode in
 * the `BEGIN` itself with `feature_not_supported` ("cannot set transaction
 * read-write mode during recovery"), so the failure never reaches a
 * `CREATE TEMP TABLE`; a session pinned read-only by a proxy or by
 * `default_transaction_read_only` reports `read_only_sql_transaction`.
 */
const POSTGRES_READ_WRITE_REFUSED_SQL_STATES = ["0A000", "25006"] as const;

export type PostgresTemporaryTableUnavailableSqlState =
  (typeof POSTGRES_TEMPORARY_TABLE_UNAVAILABLE_SQL_STATES)[number];

export type PostgresReadWriteRefusedSqlState =
  (typeof POSTGRES_READ_WRITE_REFUSED_SQL_STATES)[number];

/**
 * Yields an error and each error reachable by following `.cause`,
 * outermost first. `seen` guards the pathological cyclic-cause case so a
 * self-referential chain can't spin forever.
 *
 * The walk intentionally follows `.cause` through *non-`Error`* links, not just
 * `Error` instances: postgres-js surfaces its driver error as a plain object
 * (message + SQLSTATE `code`) on a Drizzle wrapper's `.cause`, so stopping at
 * the first non-`Error` link would miss it (see the postgres-js test). A plain
 * object is classified by its locale-independent SQLSTATE alone
 * ({@link isPostgresUndefinedTable}); the looser SQLite message substring is
 * consulted only for `Error` instances and raw strings
 * ({@link missingTableMessage}), so an unrelated object in a cause chain that
 * merely mentions one of those phrases is not mistaken for a missing table.
 */
export function* errorChain(error: unknown): Generator<unknown, void, void> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    yield current;
    current =
      canReadProperty(current) ? Reflect.get(current, "cause") : undefined;
  }
}

function canReadProperty(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/**
 * Whether a single chain link is a PostgreSQL `undefined_table` failure,
 * identified by its SQLSTATE rather than a message substring.
 */
function isPostgresUndefinedTable(link: unknown): boolean {
  return (
    canReadProperty(link) &&
    Reflect.get(link, "code") === POSTGRES_UNDEFINED_TABLE_CODE
  );
}

function messageProperty(link: unknown): string | undefined {
  if (typeof link === "string") return link;
  if (link instanceof Error) return link.message;
  const message =
    canReadProperty(link) ?
      (Reflect.get(link, "message") as unknown)
    : undefined;
  return typeof message === "string" ? message : undefined;
}

function errorMessage(link: unknown): string {
  return messageProperty(link) ?? String(link);
}

/**
 * The message a SQLite missing-table substring match may be tested against — but
 * only for `Error` instances and raw `string` links, never an arbitrary plain
 * object.
 *
 * Generic "does not exist" is deliberately not substring-matched: PostgreSQL uses
 * that phrase for undefined columns, functions, types, and relations. PostgreSQL
 * missing tables are classified by SQLSTATE 42P01 when available, or by the
 * narrower driver-message shape `relation/table "..." does not exist` when a
 * bring-your-own driver omits SQLSTATE. SQLite does not expose a portable
 * SQLSTATE here, so the narrow "no such table" engine message is still accepted.
 */
function missingTableMessage(link: unknown): string | undefined {
  return typeof link === "string" || link instanceof Error ?
      messageProperty(link)
    : undefined;
}

function sqliteErrorCode(link: unknown): unknown {
  if (!canReadProperty(link)) return undefined;
  return Reflect.get(link, "code");
}

/**
 * SQLite driver messages normalized independently of transport decoration.
 * Native SQLite usually returns the engine text alone, while libSQL prefixes
 * that same text with its symbolic result code. Classifiers compare the
 * canonical engine message so every SQLite error shape has one owner.
 */
function sqliteErrorMessage(link: unknown): string | undefined {
  const message = messageProperty(link);
  const code = sqliteErrorCode(link);
  if (
    typeof message === "string" &&
    typeof code === "string" &&
    code.startsWith("SQLITE_") &&
    message.startsWith(`${code}: `)
  ) {
    return message.slice(code.length + 2);
  }
  return message;
}

/**
 * Cloudflare D1 / Durable Objects may surface a missing-table failure as the
 * generic SQLite code with no detail. Accept the bare marker, but do not
 * substring-match detailed `SQLITE_ERROR: ...` failures: those include syntax
 * errors and bind-limit faults that must stay loud.
 */
function isBareSqliteErrorMarker(link: unknown): boolean {
  const message = sqliteErrorMessage(link);
  if (message === SQLITE_GENERIC_ERROR_CODE) return true;
  if (sqliteErrorCode(link) !== SQLITE_GENERIC_ERROR_CODE) return false;
  return (
    message === undefined ||
    message === SQLITE_GENERIC_ERROR_CODE ||
    message.includes(SQLITE_MISSING_TABLE_PATTERN)
  );
}

function isPostgresUndefinedRelationMessage(link: unknown): boolean {
  const message = errorMessage(link);
  if (message.startsWith(DRIZZLE_QUERY_ERROR_PREFIX)) return false;
  return POSTGRES_UNDEFINED_RELATION_PATTERN.test(message);
}

/**
 * Whether any link in the cause chain is a PostgreSQL "insufficient
 * resources" failure (SQLSTATE class 53: disk_full, out_of_memory,
 * configuration_limit_exceeded, ...). Parallel index builds surface
 * shared-memory exhaustion this way (53100 from dsm_impl_posix on hosts
 * with a small /dev/shm); callers retry such work with parallelism
 * disabled. Identified by the locale-independent 5-character SQLSTATE
 * prefix only — never by message text.
 */
export function isInsufficientResourcesError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    const code: unknown = Reflect.get(link, "code");
    if (typeof code === "string" && code.length === 5 && code.startsWith("53"))
      return true;
  }
  return false;
}

export function isMissingTableError(error: unknown): boolean {
  // SQLSTATE 42P01 is locale-independent and structural, so it is honored on
  // *every* link — including a plain driver-error object reached only by walking
  // through a non-`Error` `.cause` (postgres-js).
  //
  // The SQLite message substring is honored only while every prior link in the
  // chain was an `Error` (or the top-level string) — the reach of the
  // pre-broadening walk, which stopped at the first non-`Error` `.cause`.
  let everyPriorLinkWasError = true;
  for (const link of errorChain(error)) {
    if (isPostgresUndefinedTable(link)) return true;
    if (isPostgresUndefinedRelationMessage(link)) return true;
    if (isBareSqliteErrorMarker(link)) return true;
    if (everyPriorLinkWasError) {
      const message = missingTableMessage(link);
      if (message?.includes(SQLITE_MISSING_TABLE_PATTERN) === true) {
        return true;
      }
    }
    if (!(link instanceof Error)) everyPriorLinkWasError = false;
  }
  return false;
}

/** Whether one chain link is the un-coded `tuple concurrently updated` race. */
function isPostgresConcurrentTupleUpdate(link: unknown): boolean {
  if (!canReadProperty(link)) return false;
  if (Reflect.get(link, "code") !== POSTGRES_INTERNAL_ERROR_CODE) return false;
  return (
    messageProperty(link)?.includes(
      POSTGRES_CONCURRENT_TUPLE_UPDATE_MESSAGE,
    ) === true
  );
}

/**
 * Whether PostgreSQL refused an IDEMPOTENT DDL statement because another
 * session was concurrently committing the same catalog change — the single
 * owner of "this DDL lost a race and is worth one retry".
 *
 * Every idempotent-DDL site in the codebase classifies through this one
 * function: the Postgres backend's `executeConcurrentCreateDdl` (bootstrap
 * tables, contribution materialization, identity relations, the index
 * materialization table and its additive columns) and the identity
 * schema-transition retry. A second copy of the predicate would drift the
 * moment one site learned about a new race SQLSTATE — as `ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS` (42701) did (#445).
 *
 * Callers MUST use it only around DDL that is a no-op when the object already
 * exists. On any other statement 23505/42701 are real defects, and retrying
 * them would hide a duplicate write.
 */
export function isPostgresConcurrentDdlRaceError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    if (
      isSqlStateIn(
        Reflect.get(link, "code"),
        POSTGRES_CONCURRENT_DDL_RACE_SQL_STATES,
      )
    ) {
      return true;
    }
    if (isPostgresConcurrentTupleUpdate(link)) return true;
  }
  return false;
}

/**
 * The PostgreSQL error fields naming the violated constraint and its relation.
 * Both spellings are read because the drivers disagree: node-postgres and
 * PGlite expose the protocol fields as `constraint` / `table`, while
 * postgres-js exposes them as `constraint_name` / `table_name`. Reading only
 * one spelling would silently classify nothing on the other driver.
 */
const POSTGRES_CONSTRAINT_FIELDS = ["constraint", "constraint_name"] as const;
const POSTGRES_RELATION_FIELDS = ["table", "table_name"] as const;
const POSTGRES_COLUMN_FIELDS = ["column", "column_name"] as const;

/**
 * SQLite's EXTENDED result code for a primary-key duplicate, in both spellings a
 * driver reports it: the symbolic name (better-sqlite3 `code`, and the
 * `SqliteError` the libSQL client nests on its own error's `.cause`) and the
 * numeric value (libSQL `rawCode` / `extendedCode`, the only form a remote
 * connection surfaces).
 *
 * The extended code — not the base `SQLITE_CONSTRAINT` — is what makes the
 * classification possible at all: SQLite distinguishes a PRIMARY KEY duplicate
 * (1555) from any other unique-index duplicate (`SQLITE_CONSTRAINT_UNIQUE`,
 * 2067) in the code itself, so nothing has to read the message, which names the
 * columns rather than the constraint.
 */
const SQLITE_PRIMARY_KEY_VIOLATION_CODE = "SQLITE_CONSTRAINT_PRIMARYKEY";
const SQLITE_PRIMARY_KEY_VIOLATION_EXTENDED_CODE = 1555;
const SQLITE_UNIQUE_VIOLATION_CODE = "SQLITE_CONSTRAINT_UNIQUE";
const SQLITE_UNIQUE_VIOLATION_EXTENDED_CODE = 2067;
const SQLITE_NOT_NULL_VIOLATION_CODE = "SQLITE_CONSTRAINT_NOTNULL";
const SQLITE_NOT_NULL_VIOLATION_EXTENDED_CODE = 1299;
const SQLITE_EXTENDED_CODE_FIELDS = ["rawCode", "extendedCode"] as const;

/**
 * A relation plus the names its PRIMARY KEY constraint can carry — how far a
 * duplicate-key classification is allowed to reach on an engine that reports the
 * violated constraint by name. See {@link isDuplicatePrimaryKeyError}.
 */
export type PrimaryKeyRelation = Readonly<{
  table: string;
  constraintNames: readonly string[];
  /** SQLite/libSQL's remote protocol reports the violated key by columns. */
  sqliteColumns: readonly string[];
}>;

function firstStringField(
  link: object,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value: unknown = Reflect.get(link, field);
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Whether PostgreSQL reported this link as a duplicate of `relation`'s PRIMARY
 * KEY: SQLSTATE, relation, and constraint name must all agree on the SAME link
 * (the driver error), so a 23505 raised by an unrelated statement deeper in the
 * chain cannot be attributed to this relation.
 */
function isPostgresPrimaryKeyViolation(
  link: object,
  relation: PrimaryKeyRelation,
): boolean {
  if (Reflect.get(link, "code") !== POSTGRES_UNIQUE_VIOLATION_CODE)
    return false;
  if (firstStringField(link, POSTGRES_RELATION_FIELDS) !== relation.table) {
    return false;
  }
  const constraint = firstStringField(link, POSTGRES_CONSTRAINT_FIELDS);
  return (
    constraint !== undefined && relation.constraintNames.includes(constraint)
  );
}

/**
 * Whether SQLite reported this link as a PRIMARY KEY duplicate. Native SQLite
 * reports an extended code; remote libSQL reports only the generic constraint
 * code and the complete violated-column message, so the relation's columns
 * are also checked for that transport shape.
 */
function isSqlitePrimaryKeyViolation(
  link: object,
  relation: PrimaryKeyRelation,
): boolean {
  if (Reflect.get(link, "code") === SQLITE_PRIMARY_KEY_VIOLATION_CODE) {
    return true;
  }
  for (const field of SQLITE_EXTENDED_CODE_FIELDS) {
    const value: unknown = Reflect.get(link, field);
    if (
      typeof value === "number" &&
      value === SQLITE_PRIMARY_KEY_VIOLATION_EXTENDED_CODE
    ) {
      return true;
    }
  }
  if (Reflect.get(link, "code") !== "SQLITE_CONSTRAINT") return false;
  const message = sqliteErrorMessage(link);
  const expectedColumns = relation.sqliteColumns
    .map((column) => `${relation.table}.${column}`)
    .join(", ");
  return message === `UNIQUE constraint failed: ${expectedColumns}`;
}

/**
 * Whether the engine refused a statement because it duplicated a PRIMARY KEY —
 * on PostgreSQL, `relation`'s specifically.
 *
 * Classification is structural: SQLSTATE and SQLite extended result codes, plus
 * the PostgreSQL protocol's own constraint and relation fields. Never message
 * text, which is translated under a non-English `lc_messages`, is overwritten
 * with the query string by Drizzle's wrapper, and on SQLite names the key's
 * COLUMNS rather than the constraint. The `.cause` chain is walked because every
 * driver here nests the real error under at least one wrapper.
 *
 * Narrowing to the primary key is the whole point. A `unique: true` index
 * declaration materializes a UNIQUE INDEX on the same relation, and violating
 * THAT is a declared-uniqueness failure about the row's VALUES, not a duplicate
 * identity. PostgreSQL reports it under the index's own name and SQLite under a
 * different extended code, so it never matches here and keeps surfacing as it
 * did before.
 *
 * `relation` scopes the PostgreSQL arm, which is the one that can see a
 * constraint name. SQLite reports no relation at all, so its scope comes from
 * the CALL SITE instead: callers must invoke this only for a statement that
 * writes exactly one relation — the node or edge insert — where a primary-key
 * duplicate can only be that relation's. Applying it to a multi-relation
 * statement would attribute the wrong table's collision.
 */
export function isDuplicatePrimaryKeyError(
  error: unknown,
  relation: PrimaryKeyRelation,
): boolean {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    if (isPostgresPrimaryKeyViolation(link, relation)) return true;
    if (isSqlitePrimaryKeyViolation(link, relation)) return true;
  }
  return false;
}

/**
 * Whether the engine refused a known NOT NULL sentinel emitted by a write
 * program. PostgreSQL supplies relation and column protocol fields; SQLite
 * supplies a NOT NULL extended code and identifies the column in its stable
 * constraint report. No other failure is allowed to trigger a specialized
 * write diagnostic.
 */
export function isNotNullColumnViolation(
  error: unknown,
  relation: Readonly<{ table: string; column: string }>,
): boolean {
  const expectedSqliteMessage = `NOT NULL constraint failed: ${relation.table}.${relation.column}`;
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    if (
      Reflect.get(link, "code") === POSTGRES_NOT_NULL_VIOLATION_CODE &&
      firstStringField(link, POSTGRES_RELATION_FIELDS) === relation.table &&
      firstStringField(link, POSTGRES_COLUMN_FIELDS) === relation.column
    ) {
      return true;
    }
    const code: unknown = Reflect.get(link, "code");
    const isSqliteNotNullViolation =
      code === SQLITE_NOT_NULL_VIOLATION_CODE ||
      code === "SQLITE_CONSTRAINT" ||
      SQLITE_EXTENDED_CODE_FIELDS.some(
        (field) =>
          Reflect.get(link, field) === SQLITE_NOT_NULL_VIOLATION_EXTENDED_CODE,
      );
    if (
      sqliteErrorMessage(link) === expectedSqliteMessage &&
      (isSqliteNotNullViolation || code === undefined)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the engine reported a duplicate of one unique index.
 *
 * PostgreSQL identifies the index directly. SQLite exposes only its extended
 * result code and ordered column list, so both must match; the result code by
 * itself would misclassify every other unique index on the relation.
 */
export function isDuplicateUniqueIndexError(
  error: unknown,
  relation: Readonly<{
    table: string;
    indexName: string;
    sqliteColumns: readonly string[];
  }>,
): boolean {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    if (
      Reflect.get(link, "code") === POSTGRES_UNIQUE_VIOLATION_CODE &&
      firstStringField(link, POSTGRES_RELATION_FIELDS) === relation.table &&
      firstStringField(link, POSTGRES_CONSTRAINT_FIELDS) === relation.indexName
    ) {
      return true;
    }
    const isSqliteUniqueViolation =
      Reflect.get(link, "code") === SQLITE_UNIQUE_VIOLATION_CODE ||
      Reflect.get(link, "code") === "SQLITE_CONSTRAINT" ||
      SQLITE_EXTENDED_CODE_FIELDS.some(
        (field) =>
          Reflect.get(link, field) === SQLITE_UNIQUE_VIOLATION_EXTENDED_CODE,
      );
    const message = sqliteErrorMessage(link);
    const expectedColumns = relation.sqliteColumns
      .map((column) => `${relation.table}.${column}`)
      .join(", ");
    if (
      isSqliteUniqueViolation &&
      message === `UNIQUE constraint failed: ${expectedColumns}`
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a durable convergence statement proved that the adapter's static
 * capability declaration has not been provisioned in this database yet.
 *
 * This predicate is intentionally consumed only by the durable convergence
 * command, whose conflict target and two identity columns are known. SQLSTATE
 * 42P10 structurally identifies a missing PostgreSQL conflict arbiter; the
 * remaining messages are SQLite's only structured-enough reports for the same
 * missing index/column states.
 */
export function isEdgeMatchIdentityStorageUnavailableError(
  error: unknown,
): boolean {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    const code: unknown = Reflect.get(link, "code");
    if (code === "42P10") return true;
    const message = sqliteErrorMessage(link);
    if (code === "42703") {
      const column = firstStringField(link, ["column"]);
      if (column === "match_identity_name" || column === "match_identity_key") {
        return true;
      }
      if (
        typeof message === "string" &&
        /\bmatch_identity_(?:name|key)\b/i.test(message)
      ) {
        return true;
      }
    }
    if (typeof message !== "string") continue;
    if (
      code === "SQLITE_ERROR" &&
      message ===
        "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint"
    ) {
      return true;
    }
    if (
      code === "SQLITE_ERROR" &&
      /^(?:no such column: (?:[^.]+\.)?|table .+ has no column named |no column named )match_identity_(?:name|key)$/.test(
        message,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isSqlStateIn<SqlState extends string>(
  code: unknown,
  states: readonly SqlState[],
): code is SqlState {
  const known: readonly string[] = states;
  return typeof code === "string" && known.includes(code);
}

/**
 * The first SQLSTATE in the error's cause chain that belongs to `states`. The
 * walk handles both direct driver errors and wrappers such as
 * DrizzleQueryError, which keeps the SQLSTATE-bearing error on `.cause`.
 */
function matchSqlState<SqlState extends string>(
  error: unknown,
  states: readonly SqlState[],
): SqlState | undefined {
  for (const link of errorChain(error)) {
    if (!canReadProperty(link)) continue;
    const code: unknown = Reflect.get(link, "code");
    if (isSqlStateIn(code, states)) return code;
  }
  return undefined;
}

/**
 * Returns the PostgreSQL SQLSTATE that prevented temporary-table creation.
 *
 * Callers must use this only at a `CREATE TEMP TABLE` execution seam: 42501
 * is otherwise a generic permission failure, and translating it elsewhere
 * would hide a different authorization problem.
 */
export function postgresTemporaryTableUnavailableSqlState(
  error: unknown,
): PostgresTemporaryTableUnavailableSqlState | undefined {
  return matchSqlState(error, POSTGRES_TEMPORARY_TABLE_UNAVAILABLE_SQL_STATES);
}

/**
 * Returns the PostgreSQL SQLSTATE with which the server refused to open a
 * read-write transaction.
 *
 * Callers must use this only for a failure raised while opening such a
 * transaction — 0A000 is otherwise a generic "unsupported feature" report
 * that any statement can raise.
 */
export function postgresReadWriteRefusedSqlState(
  error: unknown,
): PostgresReadWriteRefusedSqlState | undefined {
  return matchSqlState(error, POSTGRES_READ_WRITE_REFUSED_SQL_STATES);
}

/**
 * Whether SQLite rejected a statement through its authorizer. Cloudflare D1
 * and Durable Objects surface this as `not authorized: SQLITE_AUTH`, usually on
 * a Drizzle wrapper's `.cause`; native drivers may instead expose
 * `code: "SQLITE_AUTH"`. Both shapes are structural enough to distinguish from
 * an unrelated permission or connection failure.
 */
export function isSqliteNotAuthorizedError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (sqliteErrorCode(link) === SQLITE_NOT_AUTHORIZED_CODE) return true;
    const message = messageProperty(link);
    if (
      message?.includes(SQLITE_NOT_AUTHORIZED_CODE) === true &&
      message.toLowerCase().includes("not authorized")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether SQLite refused a write because the enclosing DEFERRED transaction's
 * read snapshot went stale before it could take the writer slot
 * ({@link SQLITE_STALE_SNAPSHOT_CODE}).
 *
 * Classified structurally — the extended result code in either spelling a
 * driver reports it (better-sqlite3's symbolic `code`, libSQL's numeric
 * `rawCode`/`extendedCode`) — and never by message: SQLite renders this as the
 * bare, indistinguishable "database is locked".
 */
export function isSqliteStaleSnapshotError(error: unknown): boolean {
  for (const link of errorChain(error)) {
    if (sqliteErrorCode(link) === SQLITE_STALE_SNAPSHOT_CODE) return true;
    if (!canReadProperty(link)) continue;
    for (const field of SQLITE_EXTENDED_CODE_FIELDS) {
      if (Reflect.get(link, field) === SQLITE_STALE_SNAPSHOT_EXTENDED_CODE) {
        return true;
      }
    }
  }
  return false;
}

function historyMissingRecordedRelationsError(
  details: Record<string, unknown>,
  cause: unknown,
): ConfigurationError {
  return new ConfigurationError(
    "history: true requires the recorded-time relations to exist, but a recorded relation is missing.",
    details,
    {
      cause,
      suggestion:
        "Create the recorded-time relations (typegraph_recorded_nodes, typegraph_recorded_edges, typegraph_recorded_clock) — e.g. re-run the generated migration SQL — on this database before enabling history capture.",
    },
  );
}

/**
 * Converts missing recorded-relation failures into the actionable precondition
 * error used by construction-time history checks. Capture paths use this after
 * the live write has already succeeded inside the same transaction; recorded
 * read paths use it when query/schema swapping reaches a recorded table that
 * has not been materialized yet.
 */
export async function withRecordedRelationsPrecondition<T>(
  promise: Promise<T>,
  details: Record<string, unknown>,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (!isMissingTableError(error)) throw error;
    throw historyMissingRecordedRelationsError(
      { ...details, code: "RECORDED_RELATIONS_MISSING" },
      error,
    );
  }
}

/**
 * Engine "vector dimension mismatch" message shapes. pgvector:
 * `expected 384 dimensions, not 512`; libSQL / sqlite-vec surface a similar
 * `expected N … got/not M`. The first capture is the dimension the *stored*
 * column expects; the optional second is the dimension that was *attempted*.
 */
const DIMENSION_MISMATCH_PATTERN =
  /expected (\d+) dimensions(?:[,\s]+(?:not|got|but got|but)\s*(\d+))?/i;

/**
 * Parses an engine vector-dimension-mismatch error into `{ expected, actual }`
 * by walking the `.cause` chain (drivers wrap the real error). `expected` is
 * the stored column's dimension; `actual` (when the message includes it) is the
 * attempted vector's dimension. Returns `undefined` for unrelated errors.
 */
export function parseDimensionMismatch(
  error: unknown,
): { expected: number; actual: number | undefined } | undefined {
  for (const link of errorChain(error)) {
    const message = errorMessage(link);
    const match = DIMENSION_MISMATCH_PATTERN.exec(message);
    if (match) {
      return {
        expected: Number(match[1]),
        actual: match[2] === undefined ? undefined : Number(match[2]),
      };
    }
  }
  return undefined;
}
