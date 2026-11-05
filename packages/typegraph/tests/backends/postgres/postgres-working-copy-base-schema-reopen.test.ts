/**
 * A durable allocation keeps the base schema of the release that provisioned
 * it. Reopening it under a later release adopts the base-schema steps it is
 * missing in place, before any store reads or writes it; an allocation stamped
 * by a newer release is refused.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BaseSchemaMigrationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../../src";
import { CURRENT_BASE_SCHEMA_VERSION } from "../../../src/backend/drizzle/base-schema";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { allocationNames } from "../../../src/backend/drizzle/postgres-working-copy-names";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { branchDurable, reopenDurableBranch } from "../../../src/graph-merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/** The last base-schema version before the identity transition log. */
const VERSION_BEFORE_TRANSITION_LOG = 5;

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person }, Author: { type: Author } },
    edges: {},
    identity: { sameIdAcrossKinds: "fold" },
  });
}

async function sealAllocation(pool: Pool, allocationId: string) {
  const graph = buildGraph(`working_copy_base_schema_${allocationId}`);
  const control = createPostgresBackend(drizzle(pool));
  const [source] = await createStoreWithSchema(graph, control, {
    history: true,
  });
  await source.nodes.Person.create({ name: "Source" }, { id: "source" });
  const manager = createPostgresWorkingCopyManager<typeof graph>({
    control,
    connect: (names) =>
      Promise.resolve(
        createPostgresBackend(drizzle(pool), {
          tables: createPostgresTables(names),
        }),
      ),
  });
  const created = await branchDurable(source, manager.durable, {
    id: asBranchId(allocationId),
    allocationId,
  });
  if (!isOk(created)) throw created.error;
  const { branch, descriptor } = unwrap(created);
  await branch.close();

  const ledger = await pool.query<{ schema_name: string | null }>(
    "SELECT schema_name FROM typegraph_working_copy_allocations WHERE allocation_id = $1",
    [allocationId],
  );
  const schema = ledger.rows[0]?.schema_name ?? "public";
  return {
    pool,
    graph,
    manager,
    descriptor,
    names: await allocationNames(allocationId),
    qualified: (table: string) => `"${schema}"."${table}"`,
  };
}

type Allocation = Awaited<ReturnType<typeof sealAllocation>>;

async function withSealedAllocation(
  allocationId: string,
  scenario: (allocation: Allocation) => Promise<void>,
): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
  try {
    await scenario(await sealAllocation(pool, allocationId));
  } finally {
    await pool.end();
  }
}

function causeOfType<T extends Error>(
  error: unknown,
  type: abstract new (...args: never[]) => T,
): T | undefined {
  let link: unknown = error;
  while (link instanceof Error) {
    if (link instanceof type) return link;
    link = link.cause;
  }
  return undefined;
}

async function markerVersion(allocation: Allocation): Promise<number> {
  const marker = await allocation.pool.query<{ version: number }>(
    `SELECT version FROM ${allocation.qualified(allocation.names.baseSchemaVersions)} WHERE installation = 1`,
  );
  return Number(marker.rows[0]?.version);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "reopening a durable allocation provisioned by an earlier release",
  () => {
    it("adopts the identity transition log in place and records identity history", async () => {
      await withSealedAllocation("base-schema-adopt", async (allocation) => {
        const { pool, names, qualified } = allocation;
        // The allocation an earlier release provisioned: no transition-log
        // relations, its marker at the version before them.
        await pool.query(
          `DROP TABLE ${qualified(names.identityTransitions)}; DROP TABLE ${qualified(names.identityTransitionRetention)}; UPDATE ${qualified(names.baseSchemaVersions)} SET version = ${String(VERSION_BEFORE_TRANSITION_LOG)} WHERE installation = 1`,
        );

        const reopened = unwrap(
          await reopenDurableBranch(
            allocation.graph,
            allocation.descriptor,
            allocation.manager.durable,
          ),
        );
        try {
          expect(await markerVersion(allocation)).toBe(
            CURRENT_BASE_SCHEMA_VERSION,
          );
          await reopened.store.nodes.Person.create(
            { name: "Ada" },
            { id: "ada" },
          );
          // A same-id fold writes a transition-log row.
          await reopened.store.nodes.Author.create(
            { penName: "A." },
            { id: "ada" },
          );
          const { transitions } = await reopened.store.identity.transitionsOf({
            kind: "Person",
            id: "ada",
          });
          expect(transitions.map((transition) => transition.cause)).toEqual([
            "fold",
          ]);
        } finally {
          await reopened.close();
        }
      });
    }, 120_000);

    it("refuses an allocation stamped by a newer release before attaching a store", async () => {
      await withSealedAllocation("base-schema-newer", async (allocation) => {
        const { pool, names, qualified } = allocation;
        await pool.query(
          `UPDATE ${qualified(names.baseSchemaVersions)} SET version = ${String(CURRENT_BASE_SCHEMA_VERSION + 1)} WHERE installation = 1`,
        );

        const outcome = await reopenDurableBranch(
          allocation.graph,
          allocation.descriptor,
          allocation.manager.durable,
        ).then(
          (result) => (isOk(result) ? result : result.error),
          (error: unknown) => error,
        );
        // The reopen reports its own failure and carries the refusal as cause.
        const refusal = causeOfType(outcome, BaseSchemaMigrationError);
        expect(refusal?.details).toMatchObject({
          reason: "newer",
          installedVersion: CURRENT_BASE_SCHEMA_VERSION + 1,
        });
      });
    }, 120_000);
  },
);
