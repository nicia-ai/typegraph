import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { branchDurable } from "../../../src/graph-merge";
import { isOk } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const URL_ = await provisionPostgresTestDatabase(import.meta.url);
const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({ id: "probe-clone-alloc-names", nodes: { Person: { type: Person } }, edges: {} });

describe.runIf(process.env["POSTGRES_URL"])("working-copy allocation names", () => {
  it("clone-allocation-name-collision: a durable working copy allocates distinct physical names for every graph relation and leaves no tables behind when it cannot", async () => {
    const pool = new Pool({ connectionString: URL_, max: 6 });
    try {
      const control = createPostgresBackend(drizzle(pool));
      const [source] = await createStoreWithSchema(graph, control, { history: true, revisionTracking: true });
      await source.nodes.Person.create({ name: "a" });
      const manager = createPostgresWorkingCopyManager<typeof graph>({
        control,
        connect: (names) =>
          Promise.resolve(createPostgresBackend(drizzle(pool), { tables: createPostgresTables(names) })),
      });
      const result = await branchDurable(source, manager.durable, {
        id: asBranchId("c1"),
        allocationId: "clone-alloc-names",
      });
      const leftovers = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'tgw\\_%'",
      );
      expect(isOk(result) || leftovers.rows.length === 0).toBe(true);
      expect(isOk(result) ? undefined : (result as { error: Error }).error.cause).toBeUndefined();
    } finally {
      await pool.end();
    }
  });
});
