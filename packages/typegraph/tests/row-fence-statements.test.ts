/**
 * T15 — the `row` write-fence mechanism's statement derivation.
 *
 * `resolveFenceStatements`'s `row` derivation is dialect-agnostic: an
 * `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING` upsert against the
 * fences relation renders BYTE-IDENTICAL text on both dialects (SQLite has
 * supported `RETURNING` and this `ON CONFLICT` shape since 3.35), unlike the
 * advisory-lock derivation the PostgreSQL-only spelling in
 * `postgres-fence-sql.ts` backs. That identity is asserted directly below,
 * not assumed.
 *
 * Also covers the two construction-time refusals for `row` (`lockTables`
 * missing under `drain: "table-lock"`, the same shape `advisory` already
 * refuses) and the one allowlist refusal for `conflict` declared on a
 * mechanism other than `row`, plus real PGlite and better-sqlite3 sessions
 * proving the acquire statement's own `generation` counter actually advances
 * across two acquisitions of the same key. The bundled SQLite factory has no
 * construction-time refusal for `writeFence.mechanism: "row"`: SQLite's
 * `lockSchemaVersionForWrite` resolves the same plan PostgreSQL's twin does
 * and takes the fence row under it, so a declared `row` mechanism is applied
 * rather than silently dropped. Proving the declaration actually reaches a
 * real session still goes through `deriveEngineProfile` (the bundled
 * factory's own default declaration is `engine-serialized`) — the same route
 * the conformance harness uses to put a `row` declaration on a bundled
 * dialect profile.
 *
 * *Mutation*: in `fenceRowKey` (`src/backend/capabilities/write-fence.ts`),
 * return `String(key)` instead of `` `${namespace}:${key}` `` (dropping the
 * namespace) — the "byte-identical across dialects" test's bound parameter
 * assertion fails (it pins the full `namespace:key` string), and the two
 * generation-sequence acquisitions below (both PGlite and better-sqlite3)
 * would silently collide with any other key sharing the same bare `key`
 * across namespaces. Restore afterward.
 *
 * *Mutation* (the managed-create ordering assertion below): remove the
 * `plan.kind === "row"` arm from SQLite's `lockSchemaVersionForWrite`
 * (`src/backend/drizzle/sqlite.ts`) so it falls back to the unconditional
 * lockless read — the fence-row acquisition never appears in the captured
 * statement list and the `fenceAcquireIndex` assertion fails. Restore
 * afterward.
 */
import { PGlite } from "@electric-sql/pglite";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import {
  resolveFenceStatements,
  resolveWriteFencePlan,
  type WriteFenceTarget,
} from "../src/backend/capabilities/write-fence";
import {
  generateSqliteMigrationSQL,
  generateVectorlessPostgresMigrationSQL,
} from "../src/backend/drizzle/ddl";
import {
  createSqlBackend,
  deriveEngineProfile,
} from "../src/backend/drizzle/engine";
import { postgresFenceSql } from "../src/backend/drizzle/postgres-fence-sql";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import { createPostgresBackend } from "../src/backend/postgres";
import { renderPostgres, renderSqlite } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";

const RowFenceProbePerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const rowFenceProbeGraph = defineGraph({
  id: "row_fence_statements_probe",
  nodes: { Person: { type: RowFenceProbePerson } },
  edges: {},
});

describe("row-mechanism fence statements: portable across dialects", () => {
  const statements = resolveFenceStatements(
    {},
    { mechanism: "row", fencesTableName: "typegraph_fences" },
  );

  it("acquireKeyed renders the same statement shape and params on both dialects, pinned", () => {
    const fragment = statements.acquireKeyed("typegraph:identity", "graph-1");
    const postgres = renderPostgres(fragment);
    const sqlite = renderSqlite(fragment);
    // Byte-identical apart from each dialect's own placeholder convention
    // (`$1` vs `?`) — the ON CONFLICT/RETURNING shape itself never diverges.
    expect(postgres.sql.replaceAll("$1", "?")).toBe(sqlite.sql);
    expect(postgres.params).toEqual(sqlite.params);
    expect(postgres.sql).toBe(
      '\n    INSERT INTO "typegraph_fences" (key, generation)\n    VALUES ($1, 1)\n    ON CONFLICT (key) DO UPDATE SET generation = "typegraph_fences".generation + 1\n    RETURNING generation\n  ',
    );
    // The bound composite key: namespace and key joined verbatim, never the
    // bare key alone — see this file's mutation check.
    expect(postgres.params).toEqual(["typegraph:identity:graph-1"]);
  });

  it("acquireKeyedWithIsolation adds the isolation column to the SAME RETURNING clause when isolationFactExpression is supplied", () => {
    const withIsolation = resolveFenceStatements(postgresFenceSql, {
      mechanism: "row",
      fencesTableName: "typegraph_fences",
    });
    const rendered = renderPostgres(
      withIsolation.acquireKeyedWithIsolation(
        "typegraph:recorded-graph-write",
        "graph-1",
      ),
    );
    expect(rendered.sql).toBe(
      '\n    INSERT INTO "typegraph_fences" (key, generation)\n    VALUES ($1, 1)\n    ON CONFLICT (key) DO UPDATE SET generation = "typegraph_fences".generation + 1\n    RETURNING generation, current_setting(\'transaction_isolation\') AS transaction_isolation\n  ',
    );
    expect(rendered.params).toEqual(["typegraph:recorded-graph-write:graph-1"]);
  });

  it("acquireKeyedWithIsolation omits the isolation column (but still returns generation) when isolationFactExpression is absent", () => {
    const rendered = renderPostgres(
      statements.acquireKeyedWithIsolation("typegraph:identity", "graph-1"),
    );
    expect(rendered.sql).toBe(
      '\n    INSERT INTO "typegraph_fences" (key, generation)\n    VALUES ($1, 1)\n    ON CONFLICT (key) DO UPDATE SET generation = "typegraph_fences".generation + 1\n    RETURNING generation\n  ',
    );
  });

  it("isolationFact() yields a no-row statement when isolationFactExpression is absent — the same 'unknown fact' shape a real read produces", () => {
    const rendered = renderPostgres(statements.isolationFact());
    expect(rendered.sql).toBe(
      "SELECT NULL AS transaction_isolation WHERE 1 = 0",
    );
    expect(rendered.params).toEqual([]);
  });

  it("the database-scoped constant key (0) renders as a bound parameter, coerced to its string form", () => {
    const rendered = renderPostgres(
      statements.acquireKeyed("typegraph:identity-ddl", 0),
    );
    expect(rendered.params).toEqual(["typegraph:identity-ddl:0"]);
  });
});

function writeFenceTestTarget(
  overrides: Partial<WriteFenceTarget>,
): WriteFenceTarget {
  return {
    dialect: "postgres",
    capabilities: { execution: { interactiveTransactions: true } } as never,
    ...overrides,
  };
}

describe("row-mechanism fence: construction-time refusals", () => {
  it('refuses conflict declared on "advisory" with WRITE_FENCE_DECLARATION_INVALID', () => {
    let caught: unknown;
    try {
      resolveWriteFencePlan(
        writeFenceTestTarget({
          fenceSql: postgresFenceSql,
          capabilities: {
            execution: { interactiveTransactions: true },
            writeFence: {
              mechanism: "advisory",
              drain: "table-lock",
              conflict: "wait",
            },
          } as never,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_DECLARATION_INVALID",
          field: "conflict",
          mechanism: "advisory",
        }) as unknown,
      }),
    );
  });

  it('refuses row + drain: "table-lock" with a fenceSql missing lockTables, naming that member', () => {
    let caught: unknown;
    try {
      resolveWriteFencePlan(
        writeFenceTestTarget({
          fenceSql: {},
          tableNames: { fences: "typegraph_fences" } as never,
          capabilities: {
            execution: { interactiveTransactions: true },
            writeFence: {
              mechanism: "row",
              drain: "table-lock",
              conflict: "wait",
            },
          } as never,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_SQL_UNAVAILABLE",
          member: "lockTables",
        }) as unknown,
      }),
    );
  });

  it('row + drain: "quiescent" with the SAME missing-lockTables fenceSql does NOT refuse (lockTables is only required by drain: "table-lock")', () => {
    const plan = resolveWriteFencePlan(
      writeFenceTestTarget({
        fenceSql: {},
        tableNames: { fences: "typegraph_fences" } as never,
        capabilities: {
          execution: { interactiveTransactions: true },
          writeFence: {
            mechanism: "row",
            drain: "quiescent",
            conflict: "wait",
          },
        } as never,
      }),
    );
    expect(plan.kind).toBe("row");
  });

  it("row with NO isolationFactExpression does not refuse at construction (isolationFactExpression is optional under row)", () => {
    const plan = resolveWriteFencePlan(
      writeFenceTestTarget({
        fenceSql: {},
        tableNames: { fences: "typegraph_fences" } as never,
        capabilities: {
          execution: { interactiveTransactions: true },
          writeFence: {
            mechanism: "row",
            drain: "none",
            conflict: "commit-time",
          },
        } as never,
      }),
    );
    expect(plan.kind).toBe("row");
  });

  it("row with NO tableNames.fences does not refuse construction (a purely drain-side site never needs the fences name) but refuses with a typed ConfigurationError, not a raw TypeError, the moment acquireKeyed is actually called", () => {
    const plan = resolveWriteFencePlan(
      writeFenceTestTarget({
        fenceSql: {},
        capabilities: {
          execution: { interactiveTransactions: true },
          writeFence: {
            mechanism: "row",
            drain: "quiescent",
            conflict: "wait",
          },
        } as never,
      }),
    );
    expect(plan.kind).toBe("row");
    if (plan.kind !== "row") throw new Error("expected a row plan");
    let caught: unknown;
    try {
      plan.sql.acquireKeyed("typegraph:identity", "graph-1");
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(
      expect.objectContaining({
        details: expect.objectContaining({
          code: "WRITE_FENCE_SQL_UNAVAILABLE",
        }) as unknown,
      }),
    );
  });
});

describe("row-mechanism fence: a real PGlite session's generation counter", () => {
  it("acquires the same key twice in one session and observes generation 1, then 2", async () => {
    const client = await PGlite.create();
    try {
      await client.exec(generateVectorlessPostgresMigrationSQL());
      const backend = createPostgresBackend(drizzlePglite(client), {
        vector: false,
        capabilities: {
          writeFence: {
            mechanism: "row",
            drain: "quiescent",
            conflict: "wait",
          },
        },
      });
      const plan = resolveWriteFencePlan(backend);
      if (plan.kind !== "row") throw new Error("expected a row plan");
      const first = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-x"),
        ),
      );
      expect(Number(first[0]?.generation)).toBe(1);
      const second = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-x"),
        ),
      );
      expect(Number(second[0]?.generation)).toBe(2);
      // A DIFFERENT key under the same namespace starts its own sequence at
      // 1 — the two rows are independent, keyed on the full composite text.
      const otherKey = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-y"),
        ),
      );
      expect(Number(otherKey[0]?.generation)).toBe(1);
    } finally {
      await client.close();
    }
  });
});

describe("row-mechanism fence: a real better-sqlite3 session's generation counter", () => {
  it("acquires the same key twice in one session and observes generation 1, then 2 (the qualified ON CONFLICT ... DO UPDATE ... RETURNING form the PostgreSQL case above pins also runs on SQLite, not only on PGlite), and a managed create on this backend emits the fence-row acquisition before its schema-version read", async () => {
    // The bundled factory's own default declaration is `engine-serialized`,
    // so proving a declared `row` mechanism against a real SQLite session
    // goes through `deriveEngineProfile` instead — the same route the
    // conformance harness uses to put a `row` declaration on a bundled
    // dialect profile.
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(generateSqliteMigrationSQL());
      const db = drizzleSqlite(sqlite);
      const profile = buildSqliteEngineProfile(db, {
        executionProfile: { isSync: true },
      });
      const backend = createSqlBackend(
        deriveEngineProfile(profile, {
          declaredCapabilities: {
            ...profile.declaredCapabilities,
            writeFence: {
              mechanism: "row",
              drain: "quiescent",
              conflict: "wait",
            },
          },
        }),
      );
      const plan = resolveWriteFencePlan(backend);
      if (plan.kind !== "row") throw new Error("expected a row plan");

      // Statements are captured by wrapping the `run`/`all`/`get` methods
      // better-sqlite3 hands back from `prepare`, installed BEFORE this
      // connection ever prepares the fence-acquire text: the SQL-text-keyed
      // statement cache (`getOrCreatePreparedStatement`, `src/backend/
      // drizzle/execution/sqlite-execution.ts`) reuses an already-prepared
      // statement object on every later call with the same text, so
      // `prepare` itself is called only once per distinct statement shape
      // for the lifetime of this connection. Wrapping the returned
      // statement's own execution methods survives that reuse: the cache
      // holds the SAME wrapped object, so every actual execution — the
      // generation-counter reads below and the managed create further
      // down — is observed in order, not only the first.
      const executedStatements: string[] = [];
      const originalPrepare = sqlite.prepare.bind(sqlite);
      vi.spyOn(sqlite, "prepare").mockImplementation((sqlText: string) => {
        const statement = originalPrepare(sqlText);
        for (const method of ["run", "all", "get"] as const) {
          const original = statement[method].bind(statement);
          (statement[method] as unknown) = (...args: unknown[]) => {
            executedStatements.push(sqlText);
            return original(...args);
          };
        }
        return statement;
      });

      const first = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-x"),
        ),
      );
      expect(Number(first[0]?.generation)).toBe(1);
      const second = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-x"),
        ),
      );
      expect(Number(second[0]?.generation)).toBe(2);
      // A DIFFERENT key under the same namespace starts its own sequence at
      // 1 — the two rows are independent, keyed on the full composite text.
      const otherKey = await backend.execute<{ generation: unknown }>(
        asCompiledRowsSql(
          plan.sql.acquireKeyed("typegraph:row-fence-test", "graph-y"),
        ),
      );
      expect(Number(otherKey[0]?.generation)).toBe(1);

      // The declaration is applied, not merely spellable: a managed write on
      // this row-mechanism backend reaches `lockSchemaVersionForWrite`
      // through the portable path (a `row` plan is ineligible for the fused
      // schema-fenced INSERT — `markSchemaFencedInsertEligibleUnderFence`),
      // which must take the SAME fence row this test already proved above
      // BEFORE its active-schema-version read, exactly as PostgreSQL's
      // `acquireSchemaWriteFence`/`lockActiveSchemaVersion` pair orders its
      // own acquisition ahead of its `FOR SHARE` read.
      const [store] = await createAdapterStoreWithSchema(
        rowFenceProbeGraph,
        backend,
      );
      // The schema commit above issues its own statements (including this
      // graph's initial version row); only the CREATE's own statements are
      // under test here.
      executedStatements.length = 0;

      await store.nodes.Person.create({ name: "Alice" }, { id: "alice" });

      const fenceAcquireIndex = executedStatements.findIndex((statement) =>
        statement.includes('INSERT INTO "typegraph_fences"'),
      );
      const schemaReadIndex = executedStatements.findIndex((statement) =>
        statement.includes('FROM "typegraph_schema_versions"'),
      );
      expect(fenceAcquireIndex).toBeGreaterThanOrEqual(0);
      expect(schemaReadIndex).toBeGreaterThanOrEqual(0);
      expect(fenceAcquireIndex).toBeLessThan(schemaReadIndex);
    } finally {
      sqlite.close();
    }
  });
});
