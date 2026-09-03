import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
import {
  applyMergePlan,
  asBranchId,
  branch,
  isErr,
  MergePlanCapabilityError,
  planMerge,
  StaleMergePlanError,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { requireDefined } from "../../../src/utils/presence";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);
const Resource = defineNode("Resource", {
  schema: z.object({ owner: z.string() }),
});
let pool: Pool | undefined;

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({ connectionString: databaseUrl, max: 2 });
  await runServerSuiteSetup("merge callbacks", [candidate], async () => {
    await candidate.query(generatePostgresMigrationSQL());
  });
  pool = candidate;
});

afterAll(async () => {
  await pool?.end();
});

async function fixture(id: string, history: boolean) {
  const activePool = requireDefined(pool);
  const first = await activePool.connect();
  const second = await activePool.connect();
  const local = createLocalSqliteBackend();
  const graph = defineGraph({
    id,
    nodes: { Resource: { type: Resource } },
    edges: {},
  });
  const options =
    history ? { history: true as const } : { revisionTracking: true };
  try {
    const backend = createPostgresBackend(drizzle(first));
    const [target] = await createStoreWithSchema(graph, backend, options);
    const [writer] = await createStoreWithSchema(
      graph,
      createPostgresBackend(drizzle(second)),
      options,
    );
    const resource = await target.nodes.Resource.create({ owner: "unclaimed" });
    const source = unwrap(
      await branch(target, () => Promise.resolve(local.backend), {
        id: asBranchId("candidate"),
      }),
    );
    await source.store.nodes.Resource.create(
      { owner: "candidate" },
      { id: "candidate" },
    );
    const plan = unwrap(await planMerge(target, [source]));
    return {
      target,
      backend,
      graph,
      writer,
      resource,
      plan,
      close: async () => {
        await local.backend.close();
        first.release();
        second.release();
      },
    };
  } catch (error) {
    await local.backend.close();
    first.release();
    second.release();
    throw error;
  }
}

describe.runIf(process.env["POSTGRES_URL"])(
  "merge callback concurrency",
  () => {
    it.each(["repeatable_read", "serializable"] as const)(
      "refuses effective %s isolation even if read-committed was requested",
      async (isolationLevel) => {
        const { backend, graph, plan, close } = await fixture(
          `callbacks_isolation_${isolationLevel}`,
          false,
        );
        const overriddenBackend = deriveBackend(backend, {
          transaction: (fn, options) =>
            backend.transaction(fn, { ...options, isolationLevel }),
        });
        try {
          const [target] = await createStoreWithSchema(
            graph,
            overriddenBackend,
            { revisionTracking: true },
          );
          const beforeApply = vi.fn(() => Promise.resolve());
          const afterApply = vi.fn(() => Promise.resolve());
          const result = await applyMergePlan(target, plan, {
            beforeApply,
            afterApply,
          });
          expect(isErr(result) && result.error).toBeInstanceOf(
            MergePlanCapabilityError,
          );
          expect(isErr(result) && result.error.details).toMatchObject({
            isolation: isolationLevel,
          });
          expect(beforeApply).not.toHaveBeenCalled();
          expect(afterApply).not.toHaveBeenCalled();
          expect(
            await target.nodes.Resource.getById(asNodeId("candidate")),
          ).toBeUndefined();
        } finally {
          await close();
        }
      },
    );
    for (const history of [false, true]) {
      it(`holds the fence before application reads against an ordinary conditional writer (history=${history})`, async () => {
        const { target, writer, resource, plan, close } = await fixture(
          `callbacks_winner_${history}`,
          history,
        );
        const checked = createGate();
        const release = createGate();
        const applying = applyMergePlan(target, plan, {
          beforeApply: async (reads) => {
            const current = await reads.nodes.Resource.getById(resource.id);
            expect(current?.owner).toBe("unclaimed");
            checked.open();
            await release.opened;
          },
          afterApply: async (tx) => {
            await tx.nodes.Resource.update(resource.id, { owner: "merge" });
          },
        });
        let competing: Promise<boolean> | undefined;
        try {
          expect(await raceTimeout(checked.opened, 3000)).not.toBe(
            TIMEOUT_SENTINEL,
          );
          competing = writer.nodes.Resource.compareAndSet(resource.id, {
            expected: { owner: "unclaimed" },
            patch: { owner: "writer" },
          });
          expect(await raceTimeout(competing, 200)).toBe(TIMEOUT_SENTINEL);
          release.open();
          unwrap(await applying);
          expect(await competing).toBe(false);
          const current = await target.nodes.Resource.getById(resource.id);
          expect(current?.owner).toBe("merge");
        } finally {
          release.open();
          await Promise.allSettled([applying, competing]);
          await close();
        }
      });

      it(`refuses a plan made stale by an ordinary writer before invoking checks (history=${history})`, async () => {
        const { target, writer, resource, plan, close } = await fixture(
          `callbacks_loser_${history}`,
          history,
        );
        const written = createGate();
        const release = createGate();
        const writing = writer.transaction(async (tx) => {
          await tx.nodes.Resource.update(resource.id, { owner: "writer" });
          written.open();
          await release.opened;
        });
        const beforeApply = vi.fn(() => Promise.resolve());
        let applying: ReturnType<typeof applyMergePlan> | undefined;
        try {
          expect(await raceTimeout(written.opened, 3000)).not.toBe(
            TIMEOUT_SENTINEL,
          );
          applying = applyMergePlan(target, plan, { beforeApply });
          expect(await raceTimeout(applying, 200)).toBe(TIMEOUT_SENTINEL);
          expect(beforeApply).not.toHaveBeenCalled();
          release.open();
          await writing;
          const result = await applying;
          expect(isErr(result) && result.error).toBeInstanceOf(
            StaleMergePlanError,
          );
          expect(beforeApply).not.toHaveBeenCalled();
          expect(
            await target.nodes.Resource.getById(asNodeId("candidate")),
          ).toBeUndefined();
        } finally {
          release.open();
          await Promise.allSettled([writing, applying]);
          await close();
        }
      });
    }
  },
);
