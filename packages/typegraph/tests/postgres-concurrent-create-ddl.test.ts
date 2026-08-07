/**
 * Concurrent CREATE DDL on PostgreSQL.
 *
 * `CREATE TABLE ... IF NOT EXISTS` is not a concurrency primitive on Postgres:
 * the existence check cannot see another session's uncommitted pg_class /
 * pg_type row, so the loser of a race waits for the winner and then receives
 * SQLSTATE 23505 instead of the harmless "already exists" notice. Every create
 * site in the Postgres backend therefore goes through one retry helper.
 *
 * `bootstrapTables` is the site two replicas booting simultaneously hit first,
 * and it is the one that ran a bare loop: the whole base-table DDL, issued at
 * cold boot, with no retry.
 *
 * No server needed: the driver seam is a stub, so the retry is observed
 * directly instead of raced for.
 */
import { describe, expect, it } from "vitest";

import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { requireDefined } from "../src/utils/presence";

/**
 * The shape node-postgres reports for a duplicate-key failure, carrying the
 * `code` field `isPostgresUniqueViolationError` classifies on. A looser stub
 * would leave the real detector untested.
 */
function duplicateKeyError(): Error {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "pg_type_typname_nsp_index"',
    ),
    {
      code: "23505",
      constraint: "pg_type_typname_nsp_index",
      severity: "ERROR",
    },
  );
}

/** The raw text of a `sql.raw()` statement, without a dialect to compile it. */
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

/**
 * A Drizzle-shaped Postgres handle whose `execute` fails the FIRST attempt at
 * each distinct statement with 23505 and succeeds on the retry — exactly what
 * the loser of a concurrent CREATE observes.
 */
function stubPostgresDatabase(
  options: Readonly<{ failFirstAttempt: boolean }>,
): Readonly<{ db: AnyPgDatabase; attempts: readonly string[] }> {
  const attempts: string[] = [];
  const failed = new Set<string>();
  const db = {
    $client: { query: () => Promise.resolve({ rows: [] }) },
    dialect: {
      sqlToQuery: () => ({ params: [] as readonly unknown[], sql: "SELECT 1" }),
    },
    // The contribution materializer's marker table: absent rows on read, a
    // no-op on write. Enough for `ensureRuntimeContributions` to reach its DDL.
    select: () => ({
      from: () => ({ where: () => Promise.resolve([] as readonly unknown[]) }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve(undefined) }),
    }),
    execute(statement: unknown) {
      const text = statementText(statement);
      attempts.push(text);
      if (!options.failFirstAttempt || failed.has(text)) {
        return Promise.resolve({ rows: [] as readonly unknown[] });
      }
      failed.add(text);
      return Promise.reject(duplicateKeyError());
    },
  } as unknown as AnyPgDatabase;
  return { db, attempts };
}

function attemptCounts(
  attempts: readonly string[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const statement of attempts) {
    counts.set(statement, (counts.get(statement) ?? 0) + 1);
  }
  return counts;
}

describe("Postgres concurrent CREATE DDL", () => {
  it("completes bootstrapTables when a concurrent creator wins the catalog race", async () => {
    const { db, attempts } = stubPostgresDatabase({ failFirstAttempt: true });
    const backend = createPostgresBackend(db, { vector: false });

    await expect(
      requireDefined(backend.bootstrapTables)(),
    ).resolves.toBeUndefined();

    // Every statement was issued twice: once for the 23505, once for the retry
    // that observes the winner's committed table.
    const counts = attemptCounts(attempts);
    expect(counts.size).toBeGreaterThan(0);
    expect([...counts.values()]).toEqual(
      Array.from({ length: counts.size }, () => 2),
    );
  });

  it("issues each bootstrap statement once when nothing is racing it", async () => {
    const { db, attempts } = stubPostgresDatabase({ failFirstAttempt: false });
    const backend = createPostgresBackend(db, { vector: false });

    await requireDefined(backend.bootstrapTables)();

    expect([...attemptCounts(attempts).values()]).toEqual(
      Array.from({ length: attempts.length }, () => 1),
    );
  });

  it("completes contribution materialization when a concurrent creator wins the race", async () => {
    const { db } = stubPostgresDatabase({ failFirstAttempt: true });
    const backend = createPostgresBackend(db, { vector: false });

    // Unretried, the 23505 does not even surface as a race: the materializer
    // catches it, stamps the marker row with `lastError`, and reports a failed
    // materialization for a table the winner has already created.
    await expect(
      requireDefined(backend.ensureRuntimeContributions)("graph"),
    ).resolves.toBeUndefined();
  });

  it("still surfaces a uniqueness failure the retry cannot clear", async () => {
    const db = {
      $client: { query: () => Promise.resolve({ rows: [] }) },
      execute: () => Promise.reject(duplicateKeyError()),
    } as unknown as AnyPgDatabase;
    const backend = createPostgresBackend(db, { vector: false });

    await expect(requireDefined(backend.bootstrapTables)()).rejects.toThrow(
      /duplicate key value/,
    );
  });
});
