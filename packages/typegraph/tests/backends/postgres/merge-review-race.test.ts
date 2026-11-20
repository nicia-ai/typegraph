import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  applyMergePlan,
  captureCandidateWriteSetTarget,
  isErr,
  isOk,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
  StaleMergePlanError,
  unwrap,
} from "../../../src/graph-merge";
import { requireDefined } from "../../../src/utils/presence";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const databaseUrl = await provisionPostgresTestDatabase(import.meta.url);
const Item = defineNode("Item", { schema: z.object({ value: z.string() }) });
const Artifact = defineNode("Artifact", {
  schema: z.object({ content: z.string() }),
});
const policy = { id: "append-v1", context: {} } as const;
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;

async function setup(id: string) {
  const graph = defineGraph({
    id,
    nodes: { Item: { type: Item }, Artifact: { type: Artifact } },
    edges: {},
  });
  const [first] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(requireDefined(firstPool))),
    { history: true },
  );
  const [second] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(requireDefined(secondPool))),
    { history: true },
  );
  const args = {
    target: first,
    makeBackend: () => Promise.resolve(createLocalSqliteBackend().backend),
    policy,
    writeSet: {
      formatVersion: 1 as const,
      sourceId: "source",
      target: await captureCandidateWriteSetTarget(first),
      nodes: [
        {
          kind: "Item",
          id: "candidate",
          properties: { value: "approved" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    },
  };
  const review = unwrap(await planCandidateWriteSetReview(args));
  await second.nodes.Artifact.create({ content: JSON.stringify(review) });
  const revalidated = unwrap(
    await revalidateCandidateWriteSetReview({ ...args, review }),
  );
  if (revalidated.status !== "compatible")
    throw new Error("Expected a compatible execution plan");
  return { first, second, plan: revalidated.plan };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "durable merge review with independent PostgreSQL sessions",
  () => {
    beforeAll(async () => {
      const first = new Pool({ connectionString: databaseUrl, max: 1 });
      const second = new Pool({ connectionString: databaseUrl, max: 1 });
      await runServerSuiteSetup("merge review", [first, second], async () => {
        await first.query(generatePostgresMigrationSQL());
        const [left, right] = await Promise.all([
          first.query<{ pid: number }>("select pg_backend_pid() as pid"),
          second.query<{ pid: number }>("select pg_backend_pid() as pid"),
        ]);
        if (
          requireDefined(left.rows[0]).pid === requireDefined(right.rows[0]).pid
        )
          throw new Error("Expected independent PostgreSQL sessions");
      });
      firstPool = first;
      secondPool = second;
    });

    afterAll(async () => {
      await Promise.all([firstPool?.end(), secondPool?.end()]);
    });

    it("allows only one concurrent application of the fresh execution plan", async () => {
      const { first, second, plan } = await setup("review_concurrent_apply");
      const results = await Promise.all([
        applyMergePlan(first, plan),
        applyMergePlan(second, plan),
      ]);
      expect(results.filter((result) => isOk(result))).toHaveLength(1);
      const failure = results.find((result) => isErr(result));
      expect(failure).toBeDefined();
      expect(failure?.error).toBeInstanceOf(StaleMergePlanError);
      expect(await first.nodes.Item.count()).toBe(1);
    }, 20_000);

    it("rechecks the fence after waiting for an in-flight writer and leaves no candidate writes", async () => {
      const { first, second, plan } = await setup("review_waiting_apply");
      const writerReady = createGate();
      const releaseWriter = createGate();
      const writing = second.transaction(async (tx) => {
        await tx.nodes.Artifact.create({ content: "concurrent decision" });
        writerReady.open();
        await releaseWriter.opened;
      });
      try {
        expect(await raceTimeout(writerReady.opened, 5000)).not.toBe(
          TIMEOUT_SENTINEL,
        );
        const applying = applyMergePlan(first, plan);
        try {
          expect(await raceTimeout(applying, 200)).toBe(TIMEOUT_SENTINEL);
        } finally {
          releaseWriter.open();
        }
        await writing;
        const afterWriter = await first.revisionNow();
        const result = await applying;
        if (!isErr(result)) throw new Error("Expected a stale-plan refusal");
        expect(result.error).toBeInstanceOf(StaleMergePlanError);
        expect(await first.nodes.Item.count()).toBe(0);
        expect(await first.revisionNow()).toBe(afterWriter);
      } finally {
        releaseWriter.open();
        await writing;
      }
    }, 20_000);
  },
);
