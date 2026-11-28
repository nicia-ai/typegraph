/**
 * A stand-in for a remote `@libsql/client` (`ws:` / `http:`), for wiring tests
 * that need its transaction semantics without a server.
 *
 * Over one SQLite file, through better-sqlite3 connections:
 *
 * - `execute` / `batch` / `executeMultiple` on the client run on the root
 *   connection, as a remote client runs each on a stream of its own; `batch`
 *   wraps its statements in a transaction, as the client does.
 * - `transaction(mode)` opens a stream: a connection of its own, which sends
 *   `BEGIN` with its first statement (as a remote client does), not when the
 *   transaction is opened.
 * - A stream's `closed` reports whether the stream was closed (by `commit`,
 *   `rollback` or `close`), never whether the engine still has its
 *   transaction open: a statement that ends the transaction in the engine (a
 *   trigger's `RAISE(ROLLBACK)`) leaves the stream open, and a statement sent
 *   afterwards runs in autocommit — the Hrana protocol-2 behaviour; protocol 3
 *   servers refuse it instead.
 *
 * Every statement is recorded in `trace` with the connection it reached.
 */
import Database from "better-sqlite3";

type RemoteLibsqlTraceEntry = Readonly<{
  /** `"root"`, or `"stream <n>"` for the n-th transaction opened. */
  connection: string;
  sql: string;
}>;

type Statement = string | Readonly<{ sql: string; args?: readonly unknown[] }>;

type ResultSet = Readonly<{
  columns: readonly string[];
  columnTypes: readonly string[];
  rows: readonly object[];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
  toJSON: () => unknown;
}>;

export type RemoteLibsqlDouble = Readonly<{
  /** The client to hand to `createLibsqlBackend`. */
  client: object;
  trace: RemoteLibsqlTraceEntry[];
  /** Closes every connection the double opened. */
  close: () => void;
}>;

/** An error shaped as the libSQL client raises it. */
function libsqlError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function toSqlValue(value: unknown): unknown {
  // eslint-disable-next-line unicorn/no-null -- better-sqlite3 binds SQL NULL only from null
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return value;
}

function fromSqlValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) {
    return value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength,
    );
  }
  return value;
}

/** A row as the libSQL client returns it: named columns, indexed values. */
function libsqlRow(columns: readonly string[], values: readonly unknown[]) {
  const row: Record<string, unknown> = {};
  for (const [index, value] of values.entries()) {
    Object.defineProperty(row, index, {
      value: fromSqlValue(value),
      enumerable: false,
    });
  }
  for (const [index, column] of columns.entries()) {
    Object.defineProperty(row, column, {
      value: fromSqlValue(values[index]),
      enumerable: true,
    });
  }
  Object.defineProperty(row, "length", {
    value: values.length,
    enumerable: false,
  });
  return row;
}

function runStatement(
  connection: Database.Database,
  statement: Statement,
): ResultSet {
  const sql = typeof statement === "string" ? statement : statement.sql;
  const args = (
    typeof statement === "string" ?
      []
    : (statement.args ?? [])).map((argument) => toSqlValue(argument));
  const prepared = connection.prepare(sql);
  if (prepared.reader) {
    const columns = prepared.columns().map((column) => column.name);
    const rows = (prepared.raw(true).all(...args) as unknown[][]).map(
      (values) => libsqlRow(columns, values),
    );
    return {
      columns,
      columnTypes: columns.map(() => ""),
      rows,
      rowsAffected: 0,
      lastInsertRowid: undefined,
      toJSON: () => ({ columns, rows }),
    };
  }
  const info = prepared.run(...args);
  return {
    columns: [],
    columnTypes: [],
    rows: [],
    rowsAffected: info.changes,
    lastInsertRowid: BigInt(info.lastInsertRowid),
    toJSON: () => ({ rowsAffected: info.changes }),
  };
}

function beginFor(mode: string): string {
  return mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN DEFERRED";
}

/** The client's own `close`: the double's connections close with the double. */
function closeNothing(): void {
  // Intentionally empty: see above.
}

export function createRemoteLibsqlDouble(path: string): RemoteLibsqlDouble {
  const trace: RemoteLibsqlTraceEntry[] = [];
  const connections: Database.Database[] = [];
  function open(): Database.Database {
    const connection = new Database(path);
    connection.pragma("busy_timeout = 5000");
    connections.push(connection);
    return connection;
  }
  const root = open();
  root.pragma("journal_mode = WAL");
  let streams = 0;

  function traced(
    connection: Database.Database,
    label: string,
    statement: Statement,
  ): ResultSet {
    trace.push({
      connection: label,
      sql: typeof statement === "string" ? statement : statement.sql,
    });
    return runStatement(connection, statement);
  }

  function openStream(mode: string) {
    streams += 1;
    const label = `stream ${streams}`;
    const connection = open();
    let started = false;
    let closed = false;
    function close(): void {
      if (closed) return;
      closed = true;
      connection.close();
    }
    function execute(statement: Statement): ResultSet {
      if (closed) {
        throw libsqlError(
          "Cannot execute statements because the transaction is closed",
          "TRANSACTION_CLOSED",
        );
      }
      if (!started) {
        try {
          traced(connection, label, beginFor(mode));
        } catch (error) {
          close();
          throw error;
        }
        started = true;
      }
      return traced(connection, label, statement);
    }
    return {
      execute: (statement: Statement) =>
        Promise.resolve().then(() => execute(statement)),
      batch: async (statements: readonly Statement[]) => {
        const results: ResultSet[] = [];
        for (const statement of statements) {
          results.push(await Promise.resolve().then(() => execute(statement)));
        }
        return results;
      },
      executeMultiple: (sql: string) =>
        Promise.resolve().then(() => {
          execute("SELECT 1");
          trace.push({ connection: label, sql });
          connection.exec(sql);
        }),
      commit: async () => {
        await Promise.resolve();
        if (closed) {
          throw libsqlError(
            "Cannot commit the transaction because it is already closed",
            "TRANSACTION_CLOSED",
          );
        }
        try {
          if (started) traced(connection, label, "COMMIT");
        } finally {
          close();
        }
      },
      rollback: async () => {
        await Promise.resolve();
        if (closed) return;
        try {
          if (started) traced(connection, label, "ROLLBACK");
        } finally {
          close();
        }
      },
      close,
      get closed() {
        return closed;
      },
    };
  }

  const client = {
    protocol: "ws",
    closed: false,
    execute: (statement: Statement, args?: readonly unknown[]) =>
      Promise.resolve().then(() =>
        traced(
          root,
          "root",
          typeof statement === "string" && args !== undefined ?
            { sql: statement, args }
          : statement,
        ),
      ),
    batch: async (statements: readonly Statement[], mode = "deferred") => {
      await Promise.resolve();
      traced(root, "root", beginFor(mode));
      try {
        const results = statements.map((statement) =>
          traced(root, "root", statement),
        );
        traced(root, "root", "COMMIT");
        return results;
      } catch (error) {
        if (root.inTransaction) traced(root, "root", "ROLLBACK");
        throw error;
      }
    },
    migrate: async (statements: readonly Statement[]) =>
      client.batch(statements, "deferred"),
    executeMultiple: async (sql: string) => {
      await Promise.resolve();
      trace.push({ connection: "root", sql });
      root.exec(sql);
    },
    transaction: async (mode = "write") => {
      await Promise.resolve();
      return openStream(mode);
    },
    sync: () => Promise.resolve(undefined),
    close: closeNothing,
  };

  return {
    client,
    trace,
    close: () => {
      for (const connection of connections) {
        if (connection.open) connection.close();
      }
    },
  };
}
