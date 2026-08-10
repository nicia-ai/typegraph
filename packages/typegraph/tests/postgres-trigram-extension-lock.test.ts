/**
 * The pg_trgm prerequisite is database-global, unlike the per-index build
 * claims held by materializeIndexes. Verify the PostgreSQL backend fences the
 * extension install on one transaction-bound connection without a live server.
 */
import { describe, expect, it } from "vitest";

import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { requireDefined } from "../src/utils/presence";

function statementText(statement: unknown): string {
  const chunks =
    (statement as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : String(value ?? chunk);
    })
    .join("");
}

function stubTransactionalDatabase(): Readonly<{
  db: AnyPgDatabase;
  statements: readonly string[];
}> {
  const statements: string[] = [];
  const transaction = {
    execute(
      statement: unknown,
    ): Promise<Readonly<{ rows: readonly unknown[] }>> {
      statements.push(statementText(statement));
      return Promise.resolve({ rows: [] });
    },
  };
  const db = {
    $client: { query: () => Promise.resolve({ rows: [] }) },
    transaction<T>(fn: (tx: typeof transaction) => Promise<T>): Promise<T> {
      return fn(transaction);
    },
  } as unknown as AnyPgDatabase;
  return { db, statements };
}

function duplicateKeyError(): Error {
  return Object.assign(new Error("duplicate extension catalog row"), {
    code: "23505",
  });
}

describe("Postgres pg_trgm extension prerequisite", () => {
  it("takes a constant transaction advisory lock before installing the extension", async () => {
    const { db, statements } = stubTransactionalDatabase();
    const backend = createPostgresBackend(db, { vector: false });

    await requireDefined(backend.ensureTrigramExtension)();

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements[0]).toContain("typegraph:pg-trgm-ddl");
    expect(statements[1]).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  });

  it("retries a concurrent extension catalog race without transaction support", async () => {
    const statements: string[] = [];
    const db = {
      $client: { query: () => Promise.resolve({ rows: [] }) },
      execute(
        statement: unknown,
      ): Promise<Readonly<{ rows: readonly unknown[] }>> {
        statements.push(statementText(statement));
        if (statements.length === 1) return Promise.reject(duplicateKeyError());
        return Promise.resolve({ rows: [] });
      },
    } as unknown as AnyPgDatabase;
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: false },
      vector: false,
    });

    await requireDefined(backend.ensureTrigramExtension)();

    expect(statements).toHaveLength(2);
    expect(new Set(statements)).toEqual(
      new Set(["CREATE EXTENSION IF NOT EXISTS pg_trgm;"]),
    );
  });
});
