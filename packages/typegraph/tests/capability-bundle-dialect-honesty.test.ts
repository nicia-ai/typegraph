/**
 * T9c — per bundle, per dialect named in `dialects` (default: both), a
 * DEFAULT factory backend of that dialect implements every core member (for
 * a gated bundle) or every extra member (for a graduated bundle, whose
 * default-configured factory should implement every measured pilot member —
 * the pilot's graduated bundles are all cross-dialect).
 *
 * Construction only, so a `drizzle-orm/sqlite-proxy` stub suffices for
 * SQLite and one shared PGlite client (no Docker lane) for PostgreSQL — the
 * precedent is `tests/capability-declaration-validation.test.ts:1-38`.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPABILITY_BUNDLES } from "../src/backend/capabilities/bundle-registry";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type GraphBackend } from "../src/backend/types";
import { type SqlDialect } from "../src/query/dialect/types";

describe("capability bundle dialect honesty (T9c)", () => {
  let pgliteClient: PGlite;
  let sqliteBackend: GraphBackend;
  let postgresBackend: GraphBackend;

  beforeAll(async () => {
    pgliteClient = await PGlite.create();
    sqliteBackend = createSqliteBackend(
      drizzleSqliteProxy(() => Promise.resolve({ rows: [] })),
    );
    postgresBackend = createPostgresBackend(drizzlePglite(pgliteClient));
  });

  afterAll(async () => {
    await pgliteClient.close();
  });

  function backendFor(dialect: SqlDialect): GraphBackend {
    return dialect === "sqlite" ? sqliteBackend : postgresBackend;
  }

  for (const bundle of CAPABILITY_BUNDLES) {
    const declaredDialects = (
      bundle as Readonly<{ dialects?: readonly SqlDialect[] }>
    ).dialects;
    const dialects: readonly SqlDialect[] = declaredDialects ?? [
      "sqlite",
      "postgres",
    ];
    for (const dialect of dialects) {
      it(`${bundle.id} — ${dialect} default factory implements every declared member`, () => {
        const backend = backendFor(dialect);
        const required: string[] = "core" in bundle ? [...bundle.core] : [];
        if ("extras" in bundle) {
          for (const extra of bundle.extras) required.push(...extra.members);
        }
        const missing = required.filter(
          (member) =>
            (backend as Record<string, unknown>)[member] === undefined,
        );
        expect(missing, `${bundle.id} on ${dialect}`).toEqual([]);
      });
    }
  }
});
