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
import { getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { requireDefined } from "../src/utils/presence";

/**
 * The shape node-postgres reports for a duplicate-key failure, carrying the
 * `code` field `isPostgresConcurrentDdlRaceError` classifies on. A looser stub
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
 * The shape node-postgres reports when an `ALTER TABLE ... ADD COLUMN IF NOT
 * EXISTS` loses the catalog race: `duplicate_column`, not `unique_violation`.
 * The additive columns on the index-materialization table are issued by exactly
 * this statement at every boot (#445).
 */
function duplicateColumnError(): Error {
  return Object.assign(
    new Error(
      'column "claim_token" of relation "typegraph_index_materializations" already exists',
    ),
    { code: "42701", severity: "ERROR" },
  );
}

/**
 * The other shape the same race takes: `heap_update` losing a catalog row
 * raises `elog(ERROR, "tuple concurrently updated")`, which carries only the
 * catch-all internal SQLSTATE.
 */
function concurrentTupleUpdateError(): Error {
  return Object.assign(new Error("tuple concurrently updated"), {
    code: "XX000",
    severity: "ERROR",
  });
}

/**
 * A Drizzle-shaped Postgres handle whose `execute` fails the FIRST attempt at
 * each distinct statement with `error()` (23505 by default) and succeeds on the
 * retry — exactly what the loser of a concurrent CREATE observes.
 */
function stubPostgresDatabase(
  options: Readonly<{
    failFirstAttempt: boolean;
    error?: () => Error;
  }>,
): Readonly<{ db: AnyPgDatabase; attempts: readonly string[] }> {
  const attempts: string[] = [];
  const failed = new Set<string>();
  let baseSchemaVersion: number | undefined;
  const db = {
    $client: { query: () => Promise.resolve({ rows: [] }) },
    dialect: {
      sqlToQuery: () => ({ params: [] as readonly unknown[], sql: "SELECT 1" }),
    },
    // The base-schema marker participates in bootstrap; all other marker
    // tables remain empty so their materializers still reach the DDL seam.
    select: (selection?: Readonly<Record<string, unknown>>) => ({
      from: (table: Table) => ({
        where: () =>
          Promise.resolve(
            (
              getTableName(table) === "typegraph_base_schema_versions" &&
                selection !== undefined &&
                Object.keys(selection).length === 1 &&
                selection["version"] !== undefined &&
                baseSchemaVersion !== undefined
            ) ?
              [{ version: baseSchemaVersion }]
            : [],
          ),
      }),
    }),
    insert: () => ({
      values: (values: Readonly<Record<string, unknown>>) => ({
        onConflictDoUpdate: () => {
          if (
            values["installation"] === 1 &&
            typeof values["version"] === "number"
          ) {
            baseSchemaVersion = values["version"];
          }
          return Promise.resolve(undefined);
        },
      }),
    }),
    execute(statement: unknown) {
      const text = statementText(statement);
      attempts.push(text);
      if (!options.failFirstAttempt || failed.has(text)) {
        return Promise.resolve({ rows: [] as readonly unknown[] });
      }
      failed.add(text);
      return Promise.reject((options.error ?? duplicateKeyError)());
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

  it.each([
    { name: "a duplicate key (23505)", error: duplicateKeyError },
    { name: "a duplicate column (42701)", error: duplicateColumnError },
    {
      name: "a concurrently updated catalog tuple (XX000)",
      error: concurrentTupleUpdateError,
    },
  ])(
    "completes ensureIndexMaterializationsTable when a concurrent booter wins with $name",
    async ({ error }) => {
      // #445: the CREATE was retried but the two additive ALTERs were bare, so
      // a second replica booting at the same moment failed the boot on a
      // statement that is a no-op by construction.
      const { db, attempts } = stubPostgresDatabase({
        failFirstAttempt: true,
        error,
      });
      const backend = createPostgresBackend(db, { vector: false });

      await expect(
        requireDefined(backend.ensureIndexMaterializationsTable)(),
      ).resolves.toBeUndefined();

      // Both ALTERs were issued, and each statement twice: the loss and the
      // retry that observes the winner's committed column.
      const counts = attemptCounts(attempts);
      const alters = [...counts.keys()].filter((statement) =>
        statement.includes("ADD COLUMN IF NOT EXISTS"),
      );
      expect(alters).toHaveLength(2);
      expect([...counts.values()]).toEqual(
        Array.from({ length: counts.size }, () => 2),
      );
    },
  );

  it("still surfaces a uniqueness failure the retry cannot clear", async () => {
    const db = {
      $client: { query: () => Promise.resolve({ rows: [] }) },
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([] as readonly unknown[]),
        }),
      }),
      execute: () => Promise.reject(duplicateKeyError()),
    } as unknown as AnyPgDatabase;
    const backend = createPostgresBackend(db, { vector: false });

    await expect(requireDefined(backend.bootstrapTables)()).rejects.toThrow(
      /duplicate key value/,
    );
  });

  // #446: `CREATE EXTENSION IF NOT EXISTS` loses the same catalog race the
  // CREATEs above do — the loser waits for the winner and is handed 23505 on
  // `pg_extension_name_index` — but the resource is database-global while the
  // index-materialization claim protecting it is per-index, so two
  // materializers building DIFFERENT trigram indexes both reach it.
  //
  // These cases run on a `transactions: false` backend, which is the shape that
  // has no transaction to hang the advisory-lock fence on and therefore relies
  // on the retry alone. The locked shape is
  // `tests/postgres-trigram-extension-lock.test.ts`.
  it("installs an extension when a concurrent installer wins the catalog race", async () => {
    const { db, attempts } = stubPostgresDatabase({ failFirstAttempt: true });
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: false },
      vector: false,
    });

    await expect(
      requireDefined(backend.ensureExtension)("pg_trgm"),
    ).resolves.toBeUndefined();

    expect(attempts).toEqual([
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm";',
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm";',
    ]);
  });

  it("issues the extension statement once when nothing is racing it", async () => {
    const { db, attempts } = stubPostgresDatabase({ failFirstAttempt: false });
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: false },
      vector: false,
    });

    await requireDefined(backend.ensureExtension)("vector");

    expect(attempts).toEqual(['CREATE EXTENSION IF NOT EXISTS "vector";']);
  });

  it("refuses an extension outside the allowlist without issuing DDL", async () => {
    const { db, attempts } = stubPostgresDatabase({ failFirstAttempt: false });
    const backend = createPostgresBackend(db, { vector: false });

    // The name reaches DDL by interpolation, so an unvalidated caller — a
    // JavaScript consumer the union type cannot reach — must be refused
    // before the statement is built, not quoted into it.
    await expect(
      requireDefined(backend.ensureExtension)(
        'pg_trgm"; DROP TABLE typegraph_nodes; --' as never,
      ),
    ).rejects.toThrow(/Unsupported database extension/);
    expect(attempts).toEqual([]);
  });

  it("still surfaces an extension failure the retry cannot clear", async () => {
    const attempts: string[] = [];
    const db = {
      $client: { query: () => Promise.resolve({ rows: [] }) },
      execute: (statement: unknown) => {
        attempts.push(statementText(statement));
        return Promise.reject(
          Object.assign(new Error("permission denied to create extension"), {
            code: "42501",
            severity: "ERROR",
          }),
        );
      },
    } as unknown as AnyPgDatabase;
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: false },
      vector: false,
    });

    await expect(
      requireDefined(backend.ensureExtension)("pg_trgm"),
    ).rejects.toThrow(/permission denied/);
    // A permission failure is not a race, so it is not retried — it keeps
    // surfacing as the requesting index's `failed` entry.
    expect(attempts).toHaveLength(1);
  });
});
