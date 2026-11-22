/**
 * Driver-level write-shape capture for the write goldens.
 *
 * Every statement is recorded at the DRIVER boundary — better-sqlite3's
 * `prepare`/`exec`, libSQL's `execute`/`batch`/`transaction` and PGlite's
 * `query` plus the simple-protocol messages it sends through
 * `execProtocolStream` (`exec` text and its own BEGIN / COMMIT / ROLLBACK)
 * — so the log is
 * what the engine was actually asked to run, whichever backend member,
 * overlay or cached prepared statement issued it. Store hook events are
 * interleaved into the same timeline, so a trace shows WHEN `onOperationEnd`
 * fires relative to `COMMIT`, not only that it fired.
 *
 * Why not the older recorders (`tests/statement-recorder.ts`,
 * `tests/trace-backend.ts`, `tests/statement-counting-backend.ts`): they
 * observe Drizzle's query logger or wrap backend members, so they miss the
 * transaction-control statements a driver issues itself (PGlite's own
 * BEGIN / COMMIT / ROLLBACK, better-sqlite3's transaction wrapper), and
 * re-executions of a statement the backend prepared once and cached. Both are
 * exactly what a write golden has to see: where the transaction opens, and
 * every round trip. This recorder is scoped to the write golden; the older
 * recorders retain their own test-specific interfaces.
 *
 * The recorder is also where statement-timed faults are injected
 * ({@link WriteShapeEngine.missNextSchemaFence},
 * {@link WriteShapeEngine.retireRowAfterNextRead}), because only the driver
 * boundary sits between the moment a write chose its plan and the moment its
 * statement runs.
 *
 * Capture is off until {@link WriteShapeRecorder.capture} runs a write, so
 * fixture setup (schema commits, seed rows) never reaches a trace.
 *
 * Rendering is deterministic by construction: SQL whitespace is collapsed,
 * wall-clock timestamps collapse to one token, and every caller-named
 * volatile token (a mocked generated id) is renumbered by first appearance
 * within its trace, so a trace does not depend on how many ids the process
 * minted before it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type PGlite, type Transaction } from "@electric-sql/pglite";
import {
  type Client as LibsqlClient,
  createClient,
  type InArgs,
  type InStatement,
  type Transaction as LibsqlTransaction,
  type TransactionMode,
} from "@libsql/client";
import type Database from "better-sqlite3";

import { type GraphBackend, TypeGraphError } from "../../src";
import { detectLibsqlTransactionMode } from "../../src/backend/drizzle/libsql-client";
import { createSqliteBackend } from "../../src/backend/drizzle/sqlite";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLibsqlBackend } from "../../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  type BulkOperationHookContext,
  type HookContext,
  type OperationHookContext,
  type StoreHooks,
} from "../../src/store-entry";

/**
 * Every driver a golden records: better-sqlite3 (`sqlite`), `@libsql/client`
 * (`libsql`, the SQLite driver whose root runs static atomic programs as one
 * `batch()`), and PGlite (`pglite`, PostgreSQL).
 */
export const WRITE_SHAPE_DRIVERS = ["sqlite", "libsql", "pglite"] as const;

export type WriteShapeDriver = (typeof WRITE_SHAPE_DRIVERS)[number];

/**
 * `exchange` lines mark a driver round trip that is not one statement: a
 * libSQL `batch()` bracketing the statements it carries, and the transaction
 * a libSQL client opens and settles itself. `port` lines are a test
 * decorator's own account of a command-port dispatch it answered or passed on
 * (see {@link WriteShapeRecorder.annotate}).
 */
type WriteShapeEvent =
  | Readonly<{ source: "sql"; text: string; params: readonly unknown[] }>
  | Readonly<{ source: "hook" | "fault" | "exchange" | "port"; line: string }>;

type WriteShapeOutcome =
  | Readonly<{ status: "ok"; summary: string | undefined }>
  | Readonly<{ status: "error"; error: string }>;

type WriteShapeCapture = Readonly<{
  events: readonly WriteShapeEvent[];
  outcome: WriteShapeOutcome;
}>;

type WriteShapeRecorder = Readonly<{
  /** Store hooks whose events join the timeline while a capture runs. */
  hooks: StoreHooks;
  /**
   * Records every statement and hook event `run` causes, and how it settled.
   * `run` resolves to an optional one-line summary of its result. A fault
   * still armed when `run` settles — the recorder's own schema-fence miss, or
   * one `pendingFaults` names — is recorded as not reached, so a trace never
   * passes an ordinary write off as a faulted one.
   */
  capture: (
    run: () => Promise<string | undefined>,
    pendingFaults?: () => readonly string[],
  ) => Promise<WriteShapeCapture>;
  /**
   * Adds a line to the timeline of the capture in progress, where it falls
   * between the statements around it; outside a capture it is dropped. A
   * command-port decorator uses it to show a dispatch it declined, which runs
   * no statement and would otherwise leave no trace.
   */
  annotate: (line: string) => void;
}>;

export type WriteShapeEngine = Readonly<{
  driver: WriteShapeDriver;
  /** The bundled factory's root, over the recorded driver. */
  root: GraphBackend;
  /**
   * A root over the same database that declares no interactive transactions
   * (`transactionMode: "none"`), or `undefined` where the driver has no such
   * profile. PGlite always runs interactive transactions. Over libSQL this
   * is the batch tier: its store-owned units run as one atomic `batch()`.
   */
  nonInteractiveRoot: GraphBackend | undefined;
  recorder: WriteShapeRecorder;
  /**
   * Arms a one-shot fault for the current capture: the next schema-fenced
   * statement that runs OUTSIDE a transaction finds no active schema row for
   * `graphId`, and the row is active again as soon as that statement returns.
   * The statement's in-statement fence therefore misses while the diagnosis
   * that follows sees the fence hold — the state a bundled root's autocommit
   * recovery exists for. The trace records where the fault fired, or that
   * it never did.
   */
  missNextSchemaFence: (graphId: string) => void;
  /**
   * Arms a one-shot fault for the current capture: the next statement run
   * OUTSIDE a transaction that reads the row (a SELECT on its entity's table
   * carrying the graph id and the row id) is followed at once by a tombstone
   * on that row. A write that gates on the row before opening its hooked
   * write therefore sees it live, and then finds it retired — the race that
   * leaves a hooked delete with nothing to write. The trace records where the
   * fault fired, or that it never did.
   */
  retireRowAfterNextRead: (row: RetiredRow) => void;
  close: () => Promise<void>;
}>;

/** A token a trace renumbers by first appearance, e.g. a mocked generated id. */
type VolatileToken = Readonly<{ pattern: RegExp; label: string }>;

type EventSink = (event: WriteShapeEvent) => void;

const ISO_TIMESTAMP_PATTERN =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/gu;
const TIMESTAMP_TOKEN = "<timestamp>";

/** The SQL a fault's own, unrecorded, statements are written in. */
type FaultDialect = "sqlite" | "pglite";

type FaultStatement = Readonly<{ sql: string; params: readonly unknown[] }>;

/**
 * The unrecorded statements a fired fault runs around the one recorded
 * statement it fires on: `before` it runs, and `after` it returns or throws.
 */
type StatementFault = Readonly<{
  before: readonly FaultStatement[];
  after: readonly FaultStatement[];
}>;

/**
 * Decides, once per recorded statement, whether the armed fault fires on it,
 * and answers the statements to run around it when it does. A fault fires
 * only outside a transaction: its statements run on the same database, and
 * from inside a transaction they would wait on that transaction's own locks.
 */
type StatementFaultTrigger = (
  text: string,
  params: readonly unknown[],
  inTransaction: boolean,
) => StatementFault | undefined;

/** The row {@link WriteShapeEngine.retireRowAfterNextRead} retires. */
type RetiredRow = Readonly<{
  entity: "node" | "edge";
  graphId: string;
  id: string;
}>;

/** A one-shot fault armed for the running capture. */
type ArmedFault = Readonly<{
  /** Rendered as `fault <description>` where it fires, or as not reached. */
  description: string;
  firesOn: (text: string, params: readonly unknown[]) => boolean;
  statements: StatementFault;
}>;

const SCHEMA_FENCE_ALIAS = `"schema_fence"`;

const ENTITY_TABLES = {
  node: "typegraph_nodes",
  edge: "typegraph_edges",
} as const;

/** The tombstone instant a retired row carries; traces never render it. */
const RETIRED_AT = "2000-01-01T00:00:00.000Z";

const SELECT_STATEMENT_PATTERN = /^\s*SELECT\b/iu;

/**
 * The fault SQL, per dialect. Every statement takes its parameters in the
 * same order on both, so a fault builds one parameter list.
 */
const FAULT_SQL = {
  sqlite: {
    hideSchema: `UPDATE "typegraph_schema_versions" SET "is_active" = 0
                  WHERE "graph_id" = ? AND "is_active" = 1`,
    restoreSchema: `UPDATE "typegraph_schema_versions" SET "is_active" = 1
                     WHERE "graph_id" = ? AND "version" =
                       (SELECT MAX("version") FROM "typegraph_schema_versions"
                         WHERE "graph_id" = ?)`,
    retire: (table: string) =>
      `UPDATE "${table}" SET "deleted_at" = ?
        WHERE "graph_id" = ? AND "id" = ? AND "deleted_at" IS NULL`,
  },
  pglite: {
    hideSchema: `UPDATE "typegraph_schema_versions" SET "is_active" = FALSE
                  WHERE "graph_id" = $1 AND "is_active" = TRUE`,
    restoreSchema: `UPDATE "typegraph_schema_versions" SET "is_active" = TRUE
                     WHERE "graph_id" = $1 AND "version" =
                       (SELECT MAX("version") FROM "typegraph_schema_versions"
                         WHERE "graph_id" = $2)`,
    retire: (table: string) =>
      `UPDATE "${table}" SET "deleted_at" = $1
        WHERE "graph_id" = $2 AND "id" = $3 AND "deleted_at" IS NULL`,
  },
} as const satisfies Readonly<Record<FaultDialect, unknown>>;

/**
 * Hides the graph's active schema row for exactly the next schema-fenced
 * statement, then brings back its newest version.
 */
function schemaFenceMiss(dialect: FaultDialect, graphId: string): ArmedFault {
  return {
    description: "the next statement misses its schema fence",
    firesOn: (text) => text.includes(SCHEMA_FENCE_ALIAS),
    statements: {
      before: [{ sql: FAULT_SQL[dialect].hideSchema, params: [graphId] }],
      after: [
        { sql: FAULT_SQL[dialect].restoreSchema, params: [graphId, graphId] },
      ],
    },
  };
}

/** Tombstones a row right after the next statement that reads it returns. */
function rowRetiredAfterRead(
  dialect: FaultDialect,
  row: RetiredRow,
): ArmedFault {
  const table = ENTITY_TABLES[row.entity];
  return {
    description: `the next statement reading ${row.entity} ${row.id} retires it once it returns`,
    firesOn: (text, params) =>
      SELECT_STATEMENT_PATTERN.test(text) &&
      text.includes(`"${table}"`) &&
      params.includes(row.graphId) &&
      params.includes(row.id),
    statements: {
      before: [],
      after: [
        {
          sql: FAULT_SQL[dialect].retire(table),
          params: [RETIRED_AT, row.graphId, row.id],
        },
      ],
    },
  };
}

/**
 * The capture state one engine's driver recording shares with its recorder:
 * the event sink, and the fault armed for the running capture.
 */
type EngineRecording = Readonly<{
  sink: EventSink;
  recorder: WriteShapeRecorder;
  missNextSchemaFence: (graphId: string) => void;
  retireRowAfterNextRead: (row: RetiredRow) => void;
  faultTrigger: StatementFaultTrigger;
}>;

function createEngineRecording(dialect: FaultDialect): EngineRecording {
  let capturing = false;
  let armed: ArmedFault | undefined;
  const events: WriteShapeEvent[] = [];
  const sink: EventSink = (event) => {
    if (capturing) events.push(event);
  };
  const recorder: WriteShapeRecorder = {
    hooks: createTimelineHooks(sink),
    async capture(run, pendingFaults = () => []) {
      events.length = 0;
      capturing = true;
      const outcome = await settleCapture(run);
      const unreached = [
        ...(armed === undefined ? [] : [armed.description]),
        ...pendingFaults(),
      ];
      for (const fault of unreached) {
        sink({ source: "fault", line: `fault not reached: ${fault}` });
      }
      capturing = false;
      armed = undefined;
      return { events: [...events], outcome };
    },
    annotate: (line) => {
      sink({ source: "port", line });
    },
  };
  const faultTrigger: StatementFaultTrigger = (text, params, inTransaction) => {
    if (armed === undefined || inTransaction || !armed.firesOn(text, params)) {
      return;
    }
    const fired = armed;
    armed = undefined;
    sink({ source: "fault", line: `fault ${fired.description}` });
    return fired.statements;
  };
  return {
    sink,
    recorder,
    missNextSchemaFence: (graphId) => {
      armed = schemaFenceMiss(dialect, graphId);
    },
    retireRowAfterNextRead: (row) => {
      armed = rowRetiredAfterRead(dialect, row);
    },
    faultTrigger,
  };
}

async function settleCapture(
  run: () => Promise<string | undefined>,
): Promise<WriteShapeOutcome> {
  try {
    return { status: "ok", summary: await run() };
  } catch (error: unknown) {
    return { status: "error", error: describeError(error) };
  }
}

export async function openWriteShapeEngine(
  driver: WriteShapeDriver,
): Promise<WriteShapeEngine> {
  switch (driver) {
    case "sqlite": {
      return openSqliteEngine(createEngineRecording("sqlite"));
    }
    case "libsql": {
      return openLibsqlEngine(createEngineRecording("sqlite"));
    }
    case "pglite": {
      return openPgliteEngine(createEngineRecording("pglite"));
    }
  }
}

/** The capture and fault controls every engine hands its golden. */
function engineControls(
  recording: EngineRecording,
): Pick<
  WriteShapeEngine,
  "recorder" | "missNextSchemaFence" | "retireRowAfterNextRead"
> {
  return {
    recorder: recording.recorder,
    missNextSchemaFence: recording.missNextSchemaFence,
    retireRowAfterNextRead: recording.retireRowAfterNextRead,
  };
}

function openSqliteEngine(recording: EngineRecording): WriteShapeEngine {
  const { backend, db } = createLocalSqliteBackend();
  const client = sqliteClientOf(db);
  recordSqliteDriver(client, recording.sink, recording.faultTrigger);
  return {
    driver: "sqlite",
    root: backend,
    nonInteractiveRoot: createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: true },
    }),
    ...engineControls(recording),
    close: () => backend.close(),
  };
}

/**
 * libSQL over a file of its own: an in-memory libSQL database is one per
 * pooled connection, so a second connection would open an empty database.
 */
async function openLibsqlEngine(
  recording: EngineRecording,
): Promise<WriteShapeEngine> {
  const directory = mkdtempSync(path.join(tmpdir(), "typegraph-write-shape-"));
  const client = createClient({
    url: `file:${path.join(directory, "graph.db")}`,
  });
  await assertClientTransactionsAreScoped(client);
  recordLibsqlClient(client, recording.sink, recording.faultTrigger);
  const { backend, db } = await createLibsqlBackend(client);
  return {
    driver: "libsql",
    root: backend,
    nonInteractiveRoot: createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: false },
    }),
    ...engineControls(recording),
    async close() {
      await backend.close();
      client.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * The libSQL recorder fires faults only on `client.execute` and
 * `client.batch`, as statements outside any transaction. That holds when the
 * backend frames each transaction through `client.transaction()` — the
 * `drizzle` mode `@libsql/client` 0.18 local clients select. A client whose
 * raw BEGIN / COMMIT run through `client.execute` (the `sql` mode) would let
 * a fault fire inside a transaction, so the recorder refuses to open on one.
 */
async function assertClientTransactionsAreScoped(
  client: LibsqlClient,
): Promise<void> {
  const mode = await detectLibsqlTransactionMode(client);
  if (mode !== "drizzle") {
    throw new Error(
      `The libSQL write-shape recorder needs client-scoped transactions ("drizzle" mode); this client frames them as "${mode}".`,
    );
  }
}

async function openPgliteEngine(
  recording: EngineRecording,
): Promise<WriteShapeEngine> {
  const { backend, client } = await createLocalPgliteBackend({ vector: false });
  recordPgliteDriver(client, recording.sink, recording.faultTrigger);
  return {
    driver: "pglite",
    root: backend,
    nonInteractiveRoot: undefined,
    ...engineControls(recording),
    close: () => backend.close(),
  };
}

/** Renders one capture as golden text lines. */
export function renderWriteShape(
  capture: WriteShapeCapture,
  volatileTokens: readonly VolatileToken[],
): readonly string[] {
  const canonicalize = createCanonicalizer(volatileTokens);
  const lines = capture.events.flatMap((event) => {
    if (event.source !== "sql") return [canonicalize(event.line)];
    const statement = `sql ${canonicalize(collapseWhitespace(event.text))}`;
    return event.params.length === 0 ?
        [statement]
      : [statement, `    ${canonicalize(renderParams(event.params))}`];
  });
  const { outcome } = capture;
  const settled =
    outcome.status === "error" ? outcome.error
    : outcome.summary === undefined ? "ok"
    : `ok ${outcome.summary}`;
  return [...lines, `=> ${canonicalize(settled)}`];
}

/**
 * `Name[CODE]`, plus the details code when it refines the class code. An
 * untyped error that escapes from a driver renders the engine's own code
 * (a PostgreSQL SQLSTATE, a SQLite result code) when it or its cause chain
 * carries one, so a change that lets a different raw error escape moves the
 * trace.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return `non-error ${String(error)}`;
  if (!(error instanceof TypeGraphError)) return describeDriverError(error);
  const detailCode = error.details["code"];
  return typeof detailCode === "string" && detailCode !== error.code ?
      `${error.name}[${error.code}:${detailCode}]`
    : `${error.name}[${error.code}]`;
}

function describeDriverError(error: Error): string {
  const code = engineCodeOf(error);
  return code === undefined ? error.name : `${error.name}[${code}]`;
}

/**
 * The engine code the error, or the first error in its cause chain, carries.
 * Drizzle wraps a driver's error in a `DrizzleQueryError` whose cause holds
 * the code.
 */
function engineCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : engineCodeOf(error.cause);
}

function createTimelineHooks(sink: EventSink): StoreHooks {
  return {
    onOperationStart(context: OperationHookContext) {
      sink({ source: "hook", line: `hook start ${operationLabel(context)}` });
    },
    onOperationEnd(context, result) {
      sink({
        source: "hook",
        line: `hook end ${operationLabel(context)} ${result.outcome}`,
      });
    },
    onBulkOperationStart(context: BulkOperationHookContext) {
      sink({ source: "hook", line: `hook bulk-start ${bulkLabel(context)}` });
    },
    onBulkOperationEnd(context, result) {
      sink({
        source: "hook",
        line: `hook bulk-end ${bulkLabel(context)} affected=${result.affectedCount}`,
      });
    },
    onError(context: HookContext, error: Error) {
      const subject =
        "operation" in context && "entity" in context ?
          `${String(context.operation)} ${String(context.entity)} `
        : "";
      sink({
        source: "hook",
        line: `hook error ${subject}${describeError(error)}`,
      });
    },
  };
}

function operationLabel(context: OperationHookContext): string {
  return `${context.operation} ${context.entity}:${context.kind} ${context.id}`;
}

function bulkLabel(context: BulkOperationHookContext): string {
  return `${context.operation} ${context.entity}:${context.kind}`;
}

/** The better-sqlite3 client Drizzle exposes as `$client` at runtime. */
function sqliteClientOf(db: object): Database.Database {
  const client: unknown = Reflect.get(db, "$client");
  if (client === undefined || client === null) {
    throw new Error("The local SQLite database exposes no driver client.");
  }
  return client as Database.Database;
}

/**
 * Wraps `prepare` so every statement object it returns records each
 * execution. The backend caches prepared statements by SQL text, so the
 * execution — not the preparation — is the unit a trace needs.
 */
function recordSqliteDriver(
  client: Database.Database,
  sink: EventSink,
  faultTrigger: StatementFaultTrigger,
): void {
  const prepare = client.prepare.bind(client);
  const exec = client.exec.bind(client);
  function runFaultStatements(statements: readonly FaultStatement[]): void {
    for (const statement of statements) {
      prepare(statement.sql).run(...statement.params);
    }
  }
  const execute: StatementExecutor = (source, params, run) => {
    const fault = faultTrigger(source, params, client.inTransaction);
    sink({ source: "sql", text: source, params });
    if (fault === undefined) return run();
    runFaultStatements(fault.before);
    try {
      return run();
    } finally {
      runFaultStatements(fault.after);
    }
  };
  const recordedPrepare = (source: string): Database.Statement =>
    recordSqliteStatement(prepare(source), source, execute);
  client.prepare = recordedPrepare as typeof client.prepare;
  client.exec = (source: string): Database.Database => {
    sink({ source: "sql", text: source, params: [] });
    return exec(source);
  };
}

const SQLITE_EXECUTING_METHODS = new Set(["run", "get", "all", "iterate"]);

/** Runs one statement execution, applying any fault armed for it. */
type StatementExecutor = (
  source: string,
  params: readonly unknown[],
  run: () => unknown,
) => unknown;

function recordSqliteStatement(
  statement: Database.Statement,
  source: string,
  execute: StatementExecutor,
): Database.Statement {
  const recorded: Database.Statement = new Proxy(statement, {
    get(target, property): unknown {
      // The statement itself, not the proxy, is the receiver native
      // accessors and methods require.
      const value: unknown = Reflect.get(target, property);
      if (typeof property !== "string" || typeof value !== "function") {
        return value;
      }
      const method = value as (...args: readonly unknown[]) => unknown;
      return (...args: readonly unknown[]): unknown => {
        if (!SQLITE_EXECUTING_METHODS.has(property)) {
          const result = Reflect.apply(method, target, args);
          return result === target ? recorded : result;
        }
        return execute(source, args, () => Reflect.apply(method, target, args));
      };
    },
  });
  return recorded;
}

/**
 * Patches the libSQL client's entry points. A `batch()` is one round trip that the client runs as its own
 * transaction, so it is bracketed by `exchange` lines around the statements
 * it carries; a fault armed for any of them runs around the whole batch. A
 * `transaction()` runs its statements through the `Transaction` it answers,
 * so that object is wrapped too; faults never fire there (see
 * {@link assertClientTransactionsAreScoped}).
 */
function recordLibsqlClient(
  client: LibsqlClient,
  sink: EventSink,
  faultTrigger: StatementFaultTrigger,
): void {
  const execute = client.execute.bind(client);
  const batch = client.batch.bind(client);
  // The recorder forwards whatever mode its caller passed — Drizzle passes
  // none — so it must reach the overload that accepts none.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const transaction = client.transaction.bind(client);
  const executeMultiple = client.executeMultiple.bind(client);
  async function runFaultStatements(
    statements: readonly FaultStatement[],
  ): Promise<void> {
    for (const statement of statements) {
      await execute({ sql: statement.sql, args: statement.params as InArgs });
    }
  }
  async function withStatementFault<T>(
    statements: readonly LibsqlStatement[],
    run: () => Promise<T>,
  ): Promise<T> {
    // The trigger disarms on the first statement it fires on.
    const fault = statements
      .map((statement) =>
        faultTrigger(statement.sql, libsqlParams(statement.args), false),
      )
      .find((triggered) => triggered !== undefined);
    if (fault === undefined) return run();
    await runFaultStatements(fault.before);
    try {
      return await run();
    } finally {
      await runFaultStatements(fault.after);
    }
  }
  client.execute = (statementOrText: InStatement, args?: InArgs) => {
    const statement = libsqlStatement(statementOrText, args);
    return withStatementFault([statement], () => {
      sink({
        source: "sql",
        text: statement.sql,
        params: libsqlParams(statement.args),
      });
      return execute(statement);
    });
  };
  client.batch = (
    statements: readonly (InStatement | [string, InArgs?])[],
    mode?: TransactionMode,
  ) => {
    const carried = statements.map((statement) =>
      Array.isArray(statement) ?
        libsqlStatement(statement[0], statement[1])
      : libsqlStatement(statement),
    );
    return withStatementFault(carried, async () => {
      sink({ source: "exchange", line: `libsql batch ${mode ?? "default"}` });
      for (const statement of carried) {
        sink({
          source: "sql",
          text: statement.sql,
          params: libsqlParams(statement.args),
        });
      }
      try {
        return await batch(carried, mode);
      } finally {
        sink({ source: "exchange", line: "libsql batch end" });
      }
    });
  };
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  client.transaction = async (mode?: TransactionMode) => {
    sink({
      source: "exchange",
      line: `libsql transaction ${mode ?? "default"}`,
    });
    return recordLibsqlTransaction(await transaction(mode), sink);
  };
  client.executeMultiple = (text: string) => {
    sink({ source: "sql", text, params: [] });
    return executeMultiple(text);
  };
}

type LibsqlStatement = Readonly<{ sql: string; args: InArgs }>;

function libsqlStatement(
  statement: InStatement,
  args?: InArgs,
): LibsqlStatement {
  return typeof statement === "string" ?
      { sql: statement, args: args ?? [] }
    : { sql: statement.sql, args: statement.args ?? [] };
}

/** Positional arguments as they are; named arguments render as one object. */
function libsqlParams(args: InArgs): readonly unknown[] {
  return Array.isArray(args) ? args : [args];
}

function recordLibsqlTransaction(
  tx: LibsqlTransaction,
  sink: EventSink,
): LibsqlTransaction {
  return {
    execute: (statementOrText: InStatement, args?: InArgs) => {
      const statement = libsqlStatement(statementOrText, args);
      sink({
        source: "sql",
        text: statement.sql,
        params: libsqlParams(statement.args),
      });
      return tx.execute(statement);
    },
    batch: (statements) => {
      for (const statement of statements) {
        const { sql, args } = libsqlStatement(statement);
        sink({ source: "sql", text: sql, params: libsqlParams(args) });
      }
      return tx.batch(statements);
    },
    executeMultiple: (text) => {
      sink({ source: "sql", text, params: [] });
      return tx.executeMultiple(text);
    },
    commit: () => {
      sink({ source: "exchange", line: "libsql commit" });
      return tx.commit();
    },
    rollback: () => {
      sink({ source: "exchange", line: "libsql rollback" });
      return tx.rollback();
    },
    close: () => {
      tx.close();
    },
    get closed() {
      return tx.closed;
    },
  };
}

/** The frontend message type byte of a simple-protocol `Query` ('Q'). */
const SIMPLE_QUERY_MESSAGE = 0x51;
/** The type byte and the int32 length that precede a message's body. */
const MESSAGE_HEADER_BYTES = 5;

/**
 * The SQL text of a simple-protocol `Query` message — a type byte, an int32
 * length, then NUL-terminated text — or `undefined` for any other message.
 */
function simpleQueryText(message: Uint8Array): string | undefined {
  if (message[0] !== SIMPLE_QUERY_MESSAGE) return undefined;
  const terminator = message.indexOf(0, MESSAGE_HEADER_BYTES);
  return new TextDecoder().decode(
    message.subarray(
      MESSAGE_HEADER_BYTES,
      terminator === -1 ? message.length : terminator,
    ),
  );
}

/**
 * Patches the client's own entry points. Parameterized statements are
 * recorded where they are called: `client.query`, and the `query` of the
 * `Transaction` object PGlite hands a transaction's callback, which bypasses
 * `client.query`. Everything PGlite runs through the simple query protocol —
 * `exec` text and the BEGIN / COMMIT / ROLLBACK its `transaction` issues
 * internally — is recorded at `execProtocolStream`, the protocol seam PGlite
 * itself calls with each message, so a transaction-control line in a trace is
 * one PGlite actually sent, at the point it sent it. Only `client.query` runs
 * outside a transaction, so it is the one entry point a fault can fire on: a
 * fault's own statements, run from inside a transaction, would wait on the
 * transaction's own lock.
 */
function recordPgliteDriver(
  client: PGlite,
  sink: EventSink,
  faultTrigger: StatementFaultTrigger,
): void {
  const query = client.query.bind(client);
  const transaction = client.transaction.bind(client);
  const execProtocolStream = client.execProtocolStream.bind(client);
  async function runFaultStatements(
    statements: readonly FaultStatement[],
  ): Promise<void> {
    for (const statement of statements) {
      await query(statement.sql, [...statement.params]);
    }
  }
  client.execProtocolStream = (message, options) => {
    const text = simpleQueryText(message);
    if (text !== undefined) sink({ source: "sql", text, params: [] });
    return execProtocolStream(message, options);
  };
  client.query = (async (
    text: string,
    params?: unknown[],
    options?: unknown,
  ) => {
    const fault = faultTrigger(text, params ?? [], false);
    sink({ source: "sql", text, params: params ?? [] });
    const run = () =>
      query(text, params, options as Parameters<typeof query>[2]);
    if (fault === undefined) return run();
    await runFaultStatements(fault.before);
    try {
      return await run();
    } finally {
      await runFaultStatements(fault.after);
    }
  }) as typeof client.query;
  client.transaction = <T>(
    callback: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    transaction((tx) => callback(recordPgliteTransaction(tx, sink)));
}

function recordPgliteTransaction(
  tx: Transaction,
  sink: EventSink,
): Transaction {
  return {
    ...tx,
    get closed() {
      return tx.closed;
    },
    query: ((text: string, params?: unknown[], options?: unknown) => {
      sink({ source: "sql", text, params: params ?? [] });
      return tx.query(
        text,
        params,
        options as Parameters<Transaction["query"]>[2],
      );
    }) as Transaction["query"],
  };
}

function collapseWhitespace(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

function renderParams(params: readonly unknown[]): string {
  return JSON.stringify(params, (_key, value: unknown) => {
    if (typeof value === "bigint") return `${value}n`;
    if (value === undefined) return "<undefined>";
    if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
    return value;
  });
}

function createCanonicalizer(
  volatileTokens: readonly VolatileToken[],
): (text: string) => string {
  const assigned = new Map<string, string>();
  const counts = new Map<string, number>();
  function renumber(label: string, token: string): string {
    const known = assigned.get(token);
    if (known !== undefined) return known;
    const ordinal = (counts.get(label) ?? 0) + 1;
    counts.set(label, ordinal);
    const replacement = `<${label}${ordinal}>`;
    assigned.set(token, replacement);
    return replacement;
  }
  return (text) => {
    let canonical = text.replaceAll(ISO_TIMESTAMP_PATTERN, TIMESTAMP_TOKEN);
    for (const token of volatileTokens) {
      canonical = canonical.replaceAll(token.pattern, (match) =>
        renumber(token.label, match),
      );
    }
    return canonical;
  };
}
