import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { describe, expect, it, vi } from "vitest";

import {
  type AnySqliteDatabase,
  createSqliteExecutionAdapter,
} from "../../../src/backend/drizzle/execution/sqlite-execution";
import { isLocalLibsqlClient } from "../../../src/backend/drizzle/libsql-client";
import { D1_MAX_BIND_PARAMETERS } from "../../../src/backend/types";
import { CompilerInvariantError } from "../../../src/errors";
import { createTestDatabase } from "../../test-utils";

describe("SQLite native atomic batches", () => {
  it("uses D1 prepare/bind plus batch and normalizes result rows", async () => {
    const bind = vi.fn((...params: readonly unknown[]) => ({ params }));
    const prepare = vi.fn(() => ({ bind }));
    const batch = vi.fn((statements: readonly unknown[]) =>
      statements.map((statement) => ({
        results: [{ statement }],
      })),
    );
    const db = {
      $client: { prepare, batch },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: { sqlToQuery: () => ({ params: [], sql: "SELECT 1" }) },
    } as unknown as AnySqliteDatabase;
    const adapter = createSqliteExecutionAdapter(db);

    expect(adapter.executeAtomicBatch).toBeDefined();
    const executeAtomicBatch = adapter.executeAtomicBatch;
    if (executeAtomicBatch === undefined) {
      throw new Error("Expected D1 atomic batch support");
    }
    await expect(
      executeAtomicBatch([
        { sql: "SELECT ?", params: ["one"] },
        { sql: "SELECT ?", params: ["two"] },
      ]),
    ).resolves.toHaveLength(2);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenNthCalledWith(1, "one");
    expect(bind).toHaveBeenNthCalledWith(2, "two");
    expect(batch).toHaveBeenCalledOnce();
  });

  it("enforces D1's per-statement bind limit before prepare or batch", async () => {
    const prepare = vi.fn(() => ({ bind: vi.fn() }));
    const batch = vi.fn(() => []);
    const db = {
      $client: { prepare, batch },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: { sqlToQuery: () => ({ params: [], sql: "SELECT 1" }) },
    } as unknown as AnySqliteDatabase;
    const adapter = createSqliteExecutionAdapter(db);
    const executeAtomicBatch = adapter.executeAtomicBatch;
    if (executeAtomicBatch === undefined) {
      throw new Error("Expected D1 atomic batch support");
    }

    await expect(
      executeAtomicBatch([
        { sql: "SELECT ?", params: [1] },
        {
          sql: "SELECT many",
          params: Array.from({ length: D1_MAX_BIND_PARAMETERS + 1 }, () => 1),
        },
      ]),
    ).rejects.toMatchObject({
      details: {
        capability: "maxBindParameters",
        maxBindParameters: D1_MAX_BIND_PARAMETERS,
        parameterCount: D1_MAX_BIND_PARAMETERS + 1,
      },
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("fails closed when D1 returns a malformed result slot", async () => {
    const prepare = vi.fn(() => ({ bind: vi.fn() }));
    const batch = vi.fn(() => [undefined]);
    const db = {
      $client: { prepare, batch },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: { sqlToQuery: () => ({ params: [], sql: "SELECT 1" }) },
    } as unknown as AnySqliteDatabase;
    const adapter = createSqliteExecutionAdapter(db);
    const executeAtomicBatch = adapter.executeAtomicBatch;
    if (executeAtomicBatch === undefined) {
      throw new Error("Expected D1 atomic batch support");
    }

    await expect(
      executeAtomicBatch([{ sql: "SELECT 1", params: [] }]),
    ).rejects.toBeInstanceOf(CompilerInvariantError);
  });

  it("fails closed when D1 omits rows from a result slot", async () => {
    const prepare = vi.fn(() => ({ bind: vi.fn() }));
    const batch = vi.fn(() => [{}]);
    const db = {
      $client: { prepare, batch },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: { sqlToQuery: () => ({ params: [], sql: "SELECT 1" }) },
    } as unknown as AnySqliteDatabase;
    const adapter = createSqliteExecutionAdapter(db);
    const executeAtomicBatch = adapter.executeAtomicBatch;
    if (executeAtomicBatch === undefined) {
      throw new Error("Expected D1 atomic batch support");
    }

    await expect(
      executeAtomicBatch([{ sql: "SELECT 1", params: [] }]),
    ).rejects.toThrow("result slot without rows");
  });

  it("propagates a D1 batch rejection without falling back to individual writes", async () => {
    const batchError = new Error("D1 batch failed");
    const prepare = vi.fn(() => ({ bind: vi.fn() }));
    const batch = vi.fn(() => Promise.reject(batchError));
    const db = {
      $client: { prepare, batch },
      session: { constructor: { name: "SQLiteD1Session" } },
      dialect: { sqlToQuery: () => ({ params: [], sql: "SELECT 1" }) },
    } as unknown as AnySqliteDatabase;
    const adapter = createSqliteExecutionAdapter(db);
    const executeAtomicBatch = adapter.executeAtomicBatch;
    if (executeAtomicBatch === undefined) {
      throw new Error("Expected D1 atomic batch support");
    }

    await expect(
      executeAtomicBatch([{ sql: "INSERT", params: [1] }]),
    ).rejects.toBe(batchError);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("commits a real local libSQL batch and rolls it back on failure", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.execute("CREATE TABLE atomic_batch (value TEXT NOT NULL)");
      const db = drizzle(client);
      const adapter = createSqliteExecutionAdapter(db);
      expect(adapter.executeAtomicBatch).toBeDefined();
      const executeAtomicBatch = adapter.executeAtomicBatch;
      if (executeAtomicBatch === undefined) {
        throw new Error("Expected local libSQL atomic batch support");
      }

      await executeAtomicBatch([
        { sql: "INSERT INTO atomic_batch (value) VALUES (?)", params: ["ok"] },
        {
          sql: "INSERT INTO atomic_batch (value) VALUES (?)",
          params: ["also-ok"],
        },
      ]);
      await expect(
        client.execute("SELECT COUNT(*) AS count FROM atomic_batch"),
      ).resolves.toMatchObject({ rows: [{ count: 2 }] });

      await expect(
        executeAtomicBatch([
          {
            sql: "INSERT INTO atomic_batch (value) VALUES (?)",
            params: ["rolled-back"],
          },
          {
            sql: "INSERT INTO missing_atomic_batch (value) VALUES (?)",
            params: ["fail"],
          },
        ]),
      ).rejects.toThrow();
      await expect(
        client.execute("SELECT value FROM atomic_batch ORDER BY rowid"),
      ).resolves.toMatchObject({
        rows: [{ value: "ok" }, { value: "also-ok" }],
      });
    } finally {
      client.close();
    }
  });

  it("does not classify unrelated batch-shaped clients as local libSQL", () => {
    expect(
      isLocalLibsqlClient({
        protocol: "file",
        execute: vi.fn(),
        batch: vi.fn(),
      }),
    ).toBe(false);
    expect(
      isLocalLibsqlClient({
        protocol: 1,
        execute: vi.fn(),
        batch: vi.fn(),
        executeMultiple: vi.fn(),
      }),
    ).toBe(false);

    const adapter = createSqliteExecutionAdapter(createTestDatabase());
    expect(adapter.executeAtomicBatch).toBeUndefined();
  });
});
