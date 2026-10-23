import path from "node:path";

import { DatabaseSync } from "@dolthub/doltlite";

import { ConfigurationError } from "../../errors";
import { type FulltextStrategy } from "../../query/dialect/fulltext-strategy";
import { doltliteVec1Strategy } from "../../query/dialect/vector/doltlite-vec1-strategy";
import { wrapWithManagedClose } from "../derive-backend";
import { doltliteDatabase } from "../drizzle/doltlite-connection";
import {
  createSqliteBackend,
  type SqliteBackendOptions,
  type SqliteTables,
} from "../sqlite";
import { closeAfterFailure } from "../types";
import { registerDoltliteSource } from "./registry";
export { commitDoltlite } from "./version-control";
export { doltliteWorkingCopyStrategy } from "./working-copy";

export type DoltliteBackendOptions = Readonly<{
  path?: string;
  /** Existing branch, pinned for this connection's lifetime. */
  branch?: string;
  busyTimeoutMs?: number;
  tables?: SqliteTables;
  fulltext?: FulltextStrategy | false;
  /** Exact vec1 scans by default. Requires a binding built with vec1 and math functions. */
  vector?: false;
  schemaProvisioning?: SqliteBackendOptions["schemaProvisioning"];
  capabilities?: SqliteBackendOptions["capabilities"];
}>;

/** Refuse bindings that discard native error classifications before opening user data. */
function assertStructuredErrors(): void {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec(
      "CREATE TABLE error_probe(id TEXT PRIMARY KEY); INSERT INTO error_probe VALUES ('a')",
    );
    try {
      probe.prepare("INSERT INTO error_probe VALUES ('a')").run();
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "errcode") === 1555)
        return;
      throw new ConfigurationError(
        "The DoltLite binding must preserve extended SQLite error codes",
        {
          code: "DOLTLITE_STRUCTURED_ERRORS_REQUIRED",
        },
        {
          cause: error,
          suggestion:
            "Install a DoltLite Node binding with structured SQLite errors; see the DoltLite backend setup documentation.",
        },
      );
    }
    throw new ConfigurationError(
      "DoltLite failed the primary-key constraint probe",
    );
  } finally {
    probe.close();
  }
}

export async function createDoltliteBackend(
  options: DoltliteBackendOptions = {},
) {
  assertStructuredErrors();
  const timeout = options.busyTimeoutMs ?? 0;
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new ConfigurationError(
      "busyTimeoutMs must be a nonnegative safe integer",
    );
  }
  if (options.path?.startsWith("file:") === true) {
    throw new ConfigurationError(
      "DoltLite requires a filesystem path, not a SQLite file URI",
    );
  }
  const databasePath =
    options.path === undefined || options.path === ":memory:" ?
      ":memory:"
    : path.resolve(options.path);
  const connection = new DatabaseSync(databasePath);
  try {
    connection.exec(
      `PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${timeout}`,
    );
    if (options.branch !== undefined)
      connection.prepare("SELECT dolt_checkout(?)").get(options.branch);
    if (options.vector !== false) {
      try {
        const vector = new Uint8Array(new Float32Array([1, 0]).buffer);
        connection
          .prepare("SELECT sqrt(vec1_l2_distance(?,?)), vec1_cos_distance(?,?)")
          .get(vector, vector, vector, vector);
      } catch (error) {
        throw new ConfigurationError(
          "DoltLite vector support requires vec1 and SQLite math functions",
          { code: "DOLTLITE_VEC1_REQUIRED" },
          {
            cause: error,
            suggestion:
              "Use a binding built with DOLTLITE_VEC1=1 and SQLITE_ENABLE_MATH_FUNCTIONS, or pass vector: false.",
          },
        );
      }
    }
    const mathFunctions = connection
      .prepare("PRAGMA compile_options")
      .all()
      .some(
        (row) =>
          !Array.isArray(row) &&
          row["compile_options"] === "ENABLE_MATH_FUNCTIONS",
      );
    const db = doltliteDatabase(connection);
    const backend = wrapWithManagedClose(
      createSqliteBackend(db, {
        ...(options.tables === undefined ? {} : { tables: options.tables }),
        ...(options.fulltext === undefined ?
          {}
        : { fulltext: options.fulltext }),
        ...(options.schemaProvisioning === undefined ?
          {}
        : { schemaProvisioning: options.schemaProvisioning }),
        capabilities: {
          ...options.capabilities,
          graphAnalytics: {
            supported: options.capabilities?.graphAnalytics?.supported ?? true,
            mathFunctions:
              options.capabilities?.graphAnalytics?.mathFunctions ??
              mathFunctions,
          },
        },
        ...(options.vector === false ? {} : { vector: doltliteVec1Strategy }),
        executionProfile: { isSync: true, transactionMode: "sql" },
        serializedResource: { mode: "shared", resource: connection },
      }),
      () => {
        connection.close();
      },
    );
    try {
      await backend.bootstrapTables?.();
    } catch (error) {
      return await closeAfterFailure(backend, error);
    }
    registerDoltliteSource(backend, {
      connection,
      options: { ...options, path: databasePath },
    });
    return { backend, db, connection };
  } catch (error) {
    if (connection.isOpen) connection.close();
    throw error;
  }
}
