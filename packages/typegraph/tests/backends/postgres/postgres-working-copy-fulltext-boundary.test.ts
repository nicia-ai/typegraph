import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, searchable } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import {
  branchDurable,
  computeBaseVersion,
  destroyDurableBranch,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { BranchError } from "../../../src/graph-merge/errors";
import { isErr, isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { tsvectorStrategy } from "../../../src/query/dialect/fulltext-strategy";
import { createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
const Person = defineNode("FulltextPerson", {
  schema: z.object({ name: searchable({ language: "english" }) }),
});
const graph = defineGraph({
  id: "postgres-working-copy-fulltext-boundary",
  nodes: { FulltextPerson: { type: Person } },
  edges: {},
});

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy fulltext ownership",
  () => {
    it("refuses a target without the source's bundled strategy on reopen and allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(graph, control);
        await source.nodes.FulltextPerson.create({ name: "Source" });
        const namesSeen: string[] = [];
        const disabledTarget = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) => {
            namesSeen.push(names.nodes);
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                fulltext: false,
              }),
            );
          },
        });
        const bundledTarget = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            ),
        });
        const created = unwrap(
          await branchDurable(source, bundledTarget.durable, {
            id: asBranchId("fulltext-boundary"),
            allocationId: "fulltext-boundary-allocation",
          }),
        );
        await created.branch.close();
        const reopened = await reopenDurableBranch(
          graph,
          created.descriptor,
          disabledTarget.durable,
        );
        expect(isErr(reopened)).toBe(true);
        const reopenError = isErr(reopened) ? reopened.error : undefined;
        expect(reopenError).toBeInstanceOf(BranchError);
        expect(reopenError?.message).toContain(
          "target requires the bundled tsvector fulltext strategy",
        );
        expect(
          isOk(
            await destroyDurableBranch(
              created.descriptor,
              bundledTarget.durable,
            ),
          ),
        ).toBe(true);
        await expect(
          disabledTarget.ephemeral.create(
            source,
            await computeBaseVersion(source),
          ),
        ).rejects.toThrow(BranchError);
        expect(await disabledTarget.listUnsealedAllocations()).toEqual([]);
        const failedNodes = namesSeen.at(-1);
        if (failedNodes === undefined)
          throw new Error("Missing failed allocation's table name.");
        const leaked = await pool.query<{ present: string | null }>(
          "SELECT to_regclass($1)::text AS present",
          [`"${failedNodes}"`],
        );
        expect(leaked.rows[0]?.present).toBeNull();
      } finally {
        await pool.end();
      }
    });

    it("refuses a custom source strategy before creating an allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
      try {
        const customStrategy = {
          ...tsvectorStrategy,
          name: "custom-tsvector",
        };
        const control = createPostgresBackend(drizzle(pool), {
          fulltext: customStrategy,
        });
        const [source] = await createStoreWithSchema(graph, control);
        const manager = createPostgresWorkingCopyManager<typeof graph>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                fulltext: customStrategy,
              }),
            ),
        });
        await expect(
          manager.ephemeral.create(source, await computeBaseVersion(source)),
        ).rejects.toThrow(
          "source requires the bundled tsvector fulltext strategy",
        );
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  },
);
