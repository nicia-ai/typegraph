/**
 * Connection-pragma defaults for createLocalSqliteBackend.
 *
 * The local backend owns its better-sqlite3 connection, so it is responsible
 * for the standard local-SQLite performance baseline: WAL journaling,
 * synchronous=NORMAL, and a busy timeout. These tests pin the defaults, the
 * per-value override, and the `pragmas: false` opt-out against a real
 * file-backed database (":memory:" databases always report journal_mode
 * "memory", so WAL is only observable on disk).
 */
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../../../src/backend/sqlite/local";
import { ConfigurationError } from "../../../src/errors";

const SYNCHRONOUS_NORMAL = 1;
const SYNCHRONOUS_FULL = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

const temporaryFiles: string[] = [];
const openBackends: LocalSqliteBackendResult[] = [];

function createTemporaryDbPath(): string {
  const dbPath = path.join(
    tmpdir(),
    `typegraph-pragmas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
  );
  temporaryFiles.push(dbPath);
  return dbPath;
}

function openBackend(
  options: Parameters<typeof createLocalSqliteBackend>[0],
): LocalSqliteBackendResult {
  const result = createLocalSqliteBackend(options);
  openBackends.push(result);
  return result;
}

function readPragma(result: LocalSqliteBackendResult, name: string): unknown {
  // Pragmas like synchronous/busy_timeout are connection-scoped, so they
  // must be read through the backend's own connection. Drizzle attaches the
  // raw better-sqlite3 handle as `$client` at runtime; the published type
  // omits it.
  const client = (result.db as unknown as { $client: Database.Database })
    .$client;
  return client.pragma(name, { simple: true });
}

afterEach(async () => {
  for (const { backend } of openBackends.splice(0)) {
    await backend.close();
  }
  for (const dbPath of temporaryFiles.splice(0)) {
    for (const suffix of ["", "-wal", "-shm"]) {
      const filePath = dbPath + suffix;
      if (existsSync(filePath)) unlinkSync(filePath);
    }
  }
});

describe("createLocalSqliteBackend pragma defaults", () => {
  it("applies WAL, synchronous=NORMAL, and a busy timeout to file databases", () => {
    const result = openBackend({ path: createTemporaryDbPath() });

    expect(readPragma(result, "journal_mode")).toBe("wal");
    expect(readPragma(result, "synchronous")).toBe(SYNCHRONOUS_NORMAL);
    expect(readPragma(result, "busy_timeout")).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  it("applies synchronous and busy timeout to in-memory databases without touching journal_mode", () => {
    const result = openBackend({});

    // ":memory:" databases always journal in memory; the WAL default must
    // not error against them.
    expect(readPragma(result, "journal_mode")).toBe("memory");
    expect(readPragma(result, "synchronous")).toBe(SYNCHRONOUS_NORMAL);
    expect(readPragma(result, "busy_timeout")).toBe(DEFAULT_BUSY_TIMEOUT_MS);
  });

  it("leaves driver defaults untouched with pragmas: false", () => {
    const result = openBackend({
      path: createTemporaryDbPath(),
      pragmas: false,
    });

    expect(readPragma(result, "journal_mode")).toBe("delete");
    expect(readPragma(result, "synchronous")).toBe(SYNCHRONOUS_FULL);
    // better-sqlite3 itself applies busy_timeout=5000 at open (its `timeout`
    // constructor default), so opting out still reports the driver's value.
    expect(readPragma(result, "busy_timeout")).toBe(5000);
  });

  it("merges per-value overrides over the defaults", () => {
    const result = openBackend({
      path: createTemporaryDbPath(),
      pragmas: { journalMode: "truncate", busyTimeoutMs: 1000 },
    });

    expect(readPragma(result, "journal_mode")).toBe("truncate");
    expect(readPragma(result, "synchronous")).toBe(SYNCHRONOUS_NORMAL);
    expect(readPragma(result, "busy_timeout")).toBe(1000);
  });

  it("rejects a non-integer or negative busy timeout", () => {
    expect(() => openBackend({ pragmas: { busyTimeoutMs: -1 } })).toThrow(
      ConfigurationError,
    );
    expect(() => openBackend({ pragmas: { busyTimeoutMs: 1.5 } })).toThrow(
      ConfigurationError,
    );
  });

  it("applies cacheSizeKib and mmapSizeBytes when explicitly set", () => {
    const result = openBackend({
      path: createTemporaryDbPath(),
      pragmas: { cacheSizeKib: -131_072, mmapSizeBytes: 268_435_456 },
    });

    expect(readPragma(result, "cache_size")).toBe(-131_072);
    expect(readPragma(result, "mmap_size")).toBe(268_435_456);
  });

  it("leaves cacheSizeKib and mmapSizeBytes at SQLite's own defaults when unset", () => {
    const withDefaults = openBackend({ path: createTemporaryDbPath() });
    const withoutPragmas = openBackend({
      path: createTemporaryDbPath(),
      pragmas: false,
    });

    expect(readPragma(withDefaults, "cache_size")).toBe(
      readPragma(withoutPragmas, "cache_size"),
    );
    expect(readPragma(withDefaults, "mmap_size")).toBe(
      readPragma(withoutPragmas, "mmap_size"),
    );
  });

  it("rejects a non-integer cacheSizeKib or a negative mmapSizeBytes", () => {
    expect(() => openBackend({ pragmas: { cacheSizeKib: 1.5 } })).toThrow(
      ConfigurationError,
    );
    expect(() => openBackend({ pragmas: { mmapSizeBytes: -1 } })).toThrow(
      ConfigurationError,
    );
    expect(() => openBackend({ pragmas: { mmapSizeBytes: 1.5 } })).toThrow(
      ConfigurationError,
    );
  });

  it("rejects a non-negative cacheSizeKib — SQLite reads a positive value as a page count, not KiB", () => {
    expect(() => openBackend({ pragmas: { cacheSizeKib: 131_072 } })).toThrow(
      ConfigurationError,
    );
    expect(() => openBackend({ pragmas: { cacheSizeKib: 0 } })).toThrow(
      ConfigurationError,
    );
  });

  it("supports writes and reads on a WAL file database end to end", async () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const graph = defineGraph({
      id: "pragma-smoke",
      nodes: { Person: { type: Person } },
      edges: {},
    });

    const result = openBackend({ path: createTemporaryDbPath() });
    const store = createStore(graph, result.backend);

    const created = await store.nodes.Person.create({ name: "Ada" });
    const found = await store.nodes.Person.getById(created.id);

    expect(found?.name).toBe("Ada");
    expect(readPragma(result, "journal_mode")).toBe("wal");
  });
});
