import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { computeBaseVersion } from "../../../src/graph-merge";
import { createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "audit-allocation-names",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe.runIf(process.env["POSTGRES_URL"])("audit: working-copy names", () => {
  it("working-copy-allocation-name-collision", async () => {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    const connected: PostgresTableNames[] = [];
    try {
      const control = createPostgresBackend(drizzle(pool));
      const [source] = await createStoreWithSchema(graph, control, {
        revisionTracking: true,
      });
      const manager = createPostgresWorkingCopyManager<typeof graph>({
        control,
        connect: (names) => {
          connected.push(names);
          return Promise.resolve(
            createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
            }),
          );
        },
      });
      await manager.ephemeral.create(source, await computeBaseVersion(source));
      const [names] = connected;
      expect(names).toBeDefined();
      const physical = Object.values(names ?? {});
      expect(new Set(physical).size).toBe(physical.length);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
