import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import type { PostgresTableNames } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { computeBaseVersion } from "../../../src/graph-merge";
import { storeBackend } from "../../../src/store/runtime-port";
import { createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "audit-fixed-schema-preflight",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe.runIf(process.env["POSTGRES_URL"])("audit: fixed-schema copy", () => {
  it("fixed-schema-set-active-with-preflight", async () => {
    const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
    try {
      const control = createPostgresBackend(drizzle(pool));
      const [source] = await createStoreWithSchema(graph, control, {
        revisionTracking: true,
      });
      const manager = createPostgresWorkingCopyManager<typeof graph>({
        control,
        connect: (names: PostgresTableNames) =>
          Promise.resolve(
            createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
            }),
          ),
      });
      const copy = await manager.ephemeral.create(
        source,
        await computeBaseVersion(source),
      );
      const copyBackend = storeBackend(copy);
      expect(copyBackend.setActiveVersionWithPreflight).toBeDefined();
      let preflightRan = false;
      await expect(
        copyBackend.setActiveVersionWithPreflight!(
          {
            graphId: graph.id,
            expected: { kind: "active", version: 1 },
            version: 1,
          },
          () => {
            preflightRan = true;
            return Promise.resolve();
          },
        ),
      ).rejects.toThrow(/fixed schema/);
      expect(preflightRan).toBe(false);
    } finally {
      await pool.end();
    }
  }, 60_000);
});
