/**
 * PostgreSQL wiring of `tx.assertUnchangedSince()`.
 *
 * Query semantics live in the shared cross-backend suite
 * (`integration/read-set-fence.ts`); this file pins only what needs a real
 * server with two connections:
 *
 * - A snapshot-isolation transaction cannot prove a fresh snapshot after the
 *   fence lock, so the fence refuses it rather than deciding on stale reads.
 * - The fence's lock excludes a concurrent store writer until the holder
 *   commits, which is what makes "unchanged at the check" true at commit.
 * - A writer already in flight when the fence is requested is waited for, and
 *   its committed change is then reported, not missed.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type Store,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  ReadSetChangedError,
  UnsupportedBackendCapabilityError,
} from "../../../src/errors-entry";
import { requireDefined } from "../../../src/utils/presence";
import {
  createGate,
  raceTimeout,
  TIMEOUT_SENTINEL,
} from "../../concurrency-utils";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const BLOCKED_WRITER_PROBE_MS = 200;
const WRITER_COMPLETION_TIMEOUT_MS = 10_000;
const SNAPSHOT_ISOLATION_LEVELS = ["serializable", "repeatable_read"] as const;

const Document = defineNode("Doc", { schema: z.object({ title: z.string() }) });
const graph = defineGraph({
  id: "read_set_fence_postgres",
  nodes: { Doc: { type: Document } },
  edges: {},
});

type FenceStore = Store<typeof graph>;

let holderPool: Pool | undefined;
let writerPool: Pool | undefined;

function requirePools(): Readonly<{ holder: Pool; writer: Pool }> {
  if (holderPool === undefined || writerPool === undefined) {
    throw new Error(
      "read-set-fence: PostgreSQL pools are unavailable after setup reported success.",
    );
  }
  return { holder: holderPool, writer: writerPool };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 2,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const holder = createPool();
  const writer = createPool();
  await runServerSuiteSetup("read-set-fence", [holder, writer], async () => {
    await holder.query(generatePostgresMigrationSQL());
    await writer.query("SELECT 1");
    holderPool = holder;
    writerPool = writer;
  });
});

afterAll(async () => {
  if (holderPool !== undefined) await holderPool.end();
  if (writerPool !== undefined) await writerPool.end();
});

beforeEach(async () => {
  if (holderPool === undefined) return;
  await holderPool.query(
    `TRUNCATE typegraph_edges, typegraph_nodes, typegraph_node_uniques,
              typegraph_schema_versions, typegraph_recorded_clock,
              typegraph_revision_origins`,
  );
});

async function storeOn(pool: Pool): Promise<FenceStore> {
  const [store] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(pool)),
    { revisionTracking: true },
  );
  return store;
}

describe.runIf(process.env["POSTGRES_URL"])(
  "read-set fence wiring (PostgreSQL)",
  () => {
    describe.each(SNAPSHOT_ISOLATION_LEVELS)(
      "a %s transaction on a revision-tracked store",
      (isolationLevel) => {
        it("is refused because a fresh snapshot cannot be proven", async () => {
          const { holder } = requirePools();
          const store = await storeOn(holder);
          await store.nodes.Doc.create({ title: "seed" });
          const anchor = requireDefined(
            await store.lineageRevisionNow(),
            "the revision-tracked store must mint an anchor",
          );

          const error = await store
            .transaction(
              async (tx) => {
                await tx.assertUnchangedSince(anchor, [{ nodeKind: "Doc" }]);
              },
              { isolationLevel },
            )
            .then(
              () => {
                // resolved: no refusal to report
              },
              (error_: unknown) => error_,
            );

          expect(
            error,
            `${isolationLevel} must be refused, not decided from a possibly stale snapshot`,
          ).toBeInstanceOf(UnsupportedBackendCapabilityError);
          expect(
            (error as UnsupportedBackendCapabilityError).details,
          ).toMatchObject({
            operation: "tx.assertUnchangedSince()",
            capability: "observedReadCommittedIsolation",
          });
        });
      },
    );

    it("holds the graph write fence from the assertion until the transaction commits", async () => {
      const { holder, writer } = requirePools();
      const holderStore = await storeOn(holder);
      const writerStore = await storeOn(writer);
      await holderStore.nodes.Doc.create({ title: "seed" });
      const anchor = requireDefined(
        await holderStore.lineageRevisionNow(),
        "the revision-tracked store must mint an anchor",
      );

      const fenceHeld = createGate();
      const releaseFence = createGate();
      const holderTransaction = holderStore.transaction(async (tx) => {
        await tx.assertUnchangedSince(anchor, [{ nodeKind: "Doc" }]);
        fenceHeld.open();
        await releaseFence.opened;
      });
      await fenceHeld.opened;

      const concurrentWrite = writerStore.nodes.Doc.create({
        title: "concurrent",
      });
      expect(
        await raceTimeout(concurrentWrite, BLOCKED_WRITER_PROBE_MS),
        "a store write on another connection must wait while the fence is held",
      ).toBe(TIMEOUT_SENTINEL);

      releaseFence.open();
      await holderTransaction;

      const created = await raceTimeout(
        concurrentWrite,
        WRITER_COMPLETION_TIMEOUT_MS,
      );
      expect(
        created,
        "the blocked write must complete once the holder commits",
      ).not.toBe(TIMEOUT_SENTINEL);
      expect(await writerStore.nodes.Doc.find({})).toHaveLength(2);
    });

    it("waits for a writer already in flight, then reports that writer's committed change", async () => {
      const { holder, writer } = requirePools();
      const fenceStore = await storeOn(holder);
      const writerStore = await storeOn(writer);
      const seeded = await fenceStore.nodes.Doc.create({ title: "seed" });
      const anchor = requireDefined(
        await fenceStore.lineageRevisionNow(),
        "the revision-tracked store must mint an anchor",
      );

      const writeApplied = createGate();
      const commitWriter = createGate();
      const writerTransaction = writerStore.transaction(async (tx) => {
        await tx.nodes.Doc.update(seeded.id, { title: "in flight" });
        writeApplied.open();
        await commitWriter.opened;
      });
      await writeApplied.opened;

      const fence = fenceStore
        .transaction(async (tx) => {
          await tx.assertUnchangedSince(anchor, [{ node: seeded }]);
        })
        .catch((error: unknown) => error);
      expect(
        await raceTimeout(fence, BLOCKED_WRITER_PROBE_MS),
        "the fence must wait for the in-flight writer rather than decide before it commits",
      ).toBe(TIMEOUT_SENTINEL);

      commitWriter.open();
      await writerTransaction;

      const error = await raceTimeout(fence, WRITER_COMPLETION_TIMEOUT_MS);
      expect(error).toBeInstanceOf(ReadSetChangedError);
      expect((error as ReadSetChangedError).details.changes).toMatchObject([
        { index: 0, nodes: [{ kind: "Doc", id: seeded.id }] },
      ]);
    });
  },
);
