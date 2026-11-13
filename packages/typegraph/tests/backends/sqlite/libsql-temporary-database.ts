/**
 * Temporary database files for the libSQL suites.
 *
 * Temp files exercise the persistent-file layout the shared suites assume.
 * (In-memory databases also work — see the libsql-specific tests and
 * libsql-client-versions.test.ts for how each client version frames them.)
 * CI uses a RAM-backed directory for these disposable files. Keep file-client
 * semantics and default SQLite pragmas without paying the runner's disk fsync
 * latency on every schema statement and autocommit write.
 *
 * Vitest evaluates modules once per test file, so each file that imports this
 * tracks — and removes — only the databases it created.
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DATABASE_FILE_SUFFIXES = ["", "-wal", "-shm"] as const;

const temporaryFiles: string[] = [];

export function createTemporaryDbPath(): string {
  const dbPath = path.join(
    process.env["TYPEGRAPH_LIBSQL_TMPDIR"] ?? tmpdir(),
    `typegraph-libsql-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

export function cleanupTemporaryFiles(): void {
  for (const dbPath of temporaryFiles.splice(0)) {
    for (const suffix of DATABASE_FILE_SUFFIXES) {
      const filePath = dbPath + suffix;
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
}
