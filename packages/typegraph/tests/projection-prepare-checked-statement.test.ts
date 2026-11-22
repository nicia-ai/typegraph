/**
 * A prepared projection checks the generated SQL names of the statement its
 * executions send: inside `withCheckedReads()` that is the projection envelope
 * the checked read wraps and reads back by name, not the bare projection. The
 * query is ordered: only then does the envelope differ from the bare
 * projection (it carries the ordering column).
 * Every name-checked compile is observed through `compileNameCheckedQuery`,
 * the one function each entry point checks through. Runs on SQLite, PGlite
 * and, when `POSTGRES_URL` is set, server PostgreSQL.
 */
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  param as parameter,
} from "../src";
import { generatePostgresMigrationSQL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { GraphBackend } from "../src/backend/types";
import type * as Compiler from "../src/query/compiler";
import { provisionPostgresTestDatabase } from "./postgres-test-database";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

const checks = vi.hoisted(() => [] as { usage: unknown; sql: unknown }[]);

vi.mock("../src/query/compiler", async (importOriginal) => {
  const actual = await importOriginal<typeof Compiler>();
  return {
    ...actual,
    compileNameCheckedQuery: (
      ...args: Parameters<typeof actual.compileNameCheckedQuery>
    ) => {
      const compiled = actual.compileNameCheckedQuery(...args);
      checks.push({
        usage: args[3],
        sql: compiled,
      });
      return compiled;
    },
  };
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), age: z.number().optional() }),
});
const graph = defineGraph({
  id: "projection_prepare_checked_statement",
  nodes: { Person: { type: Person } },
  edges: {},
});

afterEach(() => {
  checks.length = 0;
});

// Resolving this suite's own PostgreSQL database needs a top-level await.
const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const close of closers) await close();
});

const POSTGRES_BACKEND: Readonly<{
  label: string;
  dialect: "sqlite" | "postgres";
  create: () => Promise<GraphBackend>;
}> = {
  label: "postgres",
  dialect: "postgres",
  async create() {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL });
    closers.push(() => pool.end());
    await pool.query(generatePostgresMigrationSQL());
    return createPostgresBackend(drizzleNodePostgres(pool), {
      vector: false,
    });
  },
};

const BACKENDS: readonly Readonly<{
  label: string;
  dialect: "sqlite" | "postgres";
  create: () => Promise<GraphBackend>;
}>[] = [
  {
    label: "sqlite",
    dialect: "sqlite",
    create: () => Promise.resolve(createTestBackend()),
  },
  {
    label: "pglite",
    dialect: "postgres",
    async create() {
      const pglite = await createLocalPgliteBackend({ vector: false });
      closers.push(() => pglite.backend.close());
      return createPostgresBackend(pglite.db, { vector: false });
    },
  },
  // Server PostgreSQL joins when the lane provides one.
  ...(process.env["POSTGRES_URL"] ? [POSTGRES_BACKEND] : []),
];

describe.each(BACKENDS)(
  "a prepared projection inside withCheckedReads() on $label",
  ({ create, dialect }) => {
    it("checks at prepare() the statement each execute() sends", async () => {
      const backend = await create();
      const [store] = await createStoreWithSchema(graph, backend);
      await store.nodes.Person.create({ name: "Alice", age: 30 });
      const active = await backend.getActiveSchema(store.graphId);
      const version = active?.version;
      const { prepared, executed } = await store.withCheckedReads(
        version,
        async (reads) => {
          const query = reads
            .query()
            .from("Person", "p")
            .whereNode("p", (person) => person.name.eq(parameter("name")))
            // Ordered, so the checked read sends the projection envelope that
            // carries the ordering column, not the bare projection.
            .orderBy("p", "age")
            .project((fields) => ({ name: fields.p.name, age: fields.p.age }));
          checks.length = 0;
          const preparedQuery = query.prepare();
          const preparedChecks = checks.map((check) => ({
            usage: check.usage,
            sql: toSqlWithParams(check.sql as never, dialect).sql,
          }));
          checks.length = 0;
          const rows = await preparedQuery.execute({ name: "Alice" });
          expect(rows).toEqual([{ name: "Alice", age: 30 }]);
          const executedChecks = checks.map((check) => ({
            usage: check.usage,
            sql: toSqlWithParams(check.sql as never, dialect).sql,
          }));
          return { prepared: preparedChecks, executed: executedChecks };
        },
      );
      expect(prepared.map((check) => check.usage)).toEqual(["wrapped"]);
      expect(executed.map((check) => check.usage)).toEqual(["wrapped"]);
      // The same statement up to its bound value: the envelope, which selects
      // the ordering column under the reserved `__tg_order_` prefix.
      expect(prepared[0]?.sql).toEqual(executed[0]?.sql);
      expect(executed[0]?.sql).toContain("__tg_order_0");
    });
  },
);
