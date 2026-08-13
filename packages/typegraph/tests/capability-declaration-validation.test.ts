/**
 * T12 (partial): `assertBundledCapabilityDeclarations` runs inside both
 * bundled factories, so a contradictory `recursiveTraversal` declaration is
 * refused at construction — before any caller can hold a backend built from
 * it — on SQLite and PostgreSQL alike.
 *
 * Construction only: no query runs, so a `drizzle-orm/sqlite-proxy` stub
 * suffices for SQLite and one shared PGlite client (no Docker lane) for
 * PostgreSQL.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type RecursiveTraversalCapability } from "../src/backend/capabilities/recursive-traversal";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { type BackendCapabilities } from "../src/backend/types";
import { ConfigurationError } from "../src/errors";

function buildSqlite(
  recursiveTraversal: RecursiveTraversalCapability,
): BackendCapabilities {
  return createSqliteBackend(
    drizzleSqliteProxy(() => Promise.resolve({ rows: [] })),
    { capabilities: { recursiveTraversal } },
  ).capabilities;
}

function buildPostgres(
  pgliteClient: PGlite,
  recursiveTraversal: RecursiveTraversalCapability,
): BackendCapabilities {
  return createPostgresBackend(drizzlePglite(pgliteClient), {
    capabilities: { recursiveTraversal },
  }).capabilities;
}

describe("bundled capability declaration validation", () => {
  let pgliteClient: PGlite;

  beforeAll(async () => {
    pgliteClient = await PGlite.create();
  });

  afterAll(async () => {
    await pgliteClient.close();
  });

  describe.each([
    { name: "createSqliteBackend", build: buildSqlite },
    {
      name: "createPostgresBackend",
      build: (recursiveTraversal: RecursiveTraversalCapability) =>
        buildPostgres(pgliteClient, recursiveTraversal),
    },
  ])("$name", ({ build }) => {
    it("refuses { supported: false } with no reason", () => {
      const caught = ((): unknown => {
        try {
          build({ supported: false });
          return undefined;
        } catch (error) {
          return error;
        }
      })();

      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "CAPABILITY_DECLARATION_CONTRADICTION",
      );
    });

    it("refuses { supported: true, reason } as a dangling reason", () => {
      const caught = ((): unknown => {
        try {
          build({ supported: true, reason: "x" });
          return undefined;
        } catch (error) {
          return error;
        }
      })();

      expect(caught).toBeInstanceOf(ConfigurationError);
      expect((caught as ConfigurationError).details["code"]).toBe(
        "CAPABILITY_DECLARATION_CONTRADICTION",
      );
    });

    it("constructs a refusing backend for { supported: false, reason }", () => {
      const capabilities = build({ supported: false, reason: "x" });

      expect(capabilities.recursiveTraversal).toEqual({
        supported: false,
        reason: "x",
      });
    });
  });
});
