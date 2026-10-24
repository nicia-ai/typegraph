/**
 * A composition whole's delete cascade against a second, genuinely concurrent
 * PostgreSQL connection.
 *
 * The cascade plans from reads no claim row backs, so two things can go wrong
 * that no single-connection lane can show:
 *
 * - **A stale plan.** A session whose snapshot predates its wait on the
 *   per-graph write fence does not see a part the fence holder just attached.
 *   The attach and the delete both advance the graph's fence row, so such a
 *   session fails there with a serialization failure, before the closure is
 *   read.
 * - **A stale pre-image.** An ordinary property update takes no per-graph
 *   lock, so it can commit between a delete's read of the row and its
 *   tombstone, for a cascade member and a directly deleted node alike. The
 *   delete releases the uniqueness entries of the props the row holds once
 *   it is tombstoned.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type NodeId,
  partOf,
  TransactionConflictError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { isSerializationFailure } from "../../../src/utils/sql-errors";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CONTENTION_TIMEOUT_MS = 20_000;
const FENCE_WAIT_POLL_MS = 20;

const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({ slug: z.string() }) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-composition-cascade",
  nodes: {
    Show: { type: Show },
    Clip: {
      type: Clip,
      unique: [
        {
          name: "clip_slug",
          fields: ["slug"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    clipOf: { type: clipOf, from: [Clip], to: [Show], cardinality: "one" },
  },
  ontology: [partOf(Clip, Show, { via: clipOf, existence: "required" })],
});

let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let firstDb: NodePgDatabase | undefined;
let secondDb: NodePgDatabase | undefined;

function requirePostgres(): Readonly<{
  first: NodePgDatabase;
  second: NodePgDatabase;
  observer: Pool;
}> {
  if (
    firstDb === undefined ||
    secondDb === undefined ||
    firstPool === undefined
  ) {
    throw new Error(
      "concurrent-composition-cascade: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { first: firstDb, second: secondDb, observer: firstPool };
}

function createPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool();
  const second = createPool();
  await runServerSuiteSetup(
    "concurrent-composition-cascade",
    [first, second],
    async () => {
      await first.query(generatePostgresMigrationSQL());
      await second.query("SELECT 1");
      firstPool = first;
      secondPool = second;
      firstDb = drizzle(first);
      secondDb = drizzle(second);
    },
  );
});

afterAll(async () => {
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
});

beforeEach(async () => {
  if (firstPool === undefined) return;
  await firstPool.query(
    "TRUNCATE typegraph_edges, typegraph_nodes, typegraph_node_uniques",
  );
});

type Gate = Readonly<{ opened: Promise<void>; open: () => void }>;

function createGate(): Gate {
  const gate: { open?: () => void } = {};
  const opened = new Promise<void>((resolve) => {
    gate.open = resolve;
  });
  return { opened, open: requireDefined(gate.open) };
}

/**
 * Resolves once some session of THIS database is parked waiting for an
 * advisory lock. `pg_locks` is cluster-wide, so the database filter keeps a
 * suite running against another database from answering for this one.
 */
async function untilSessionWaitsOnFence(observer: Pool): Promise<void> {
  for (;;) {
    const { rows } = await observer.query<{ waiting: string }>(
      `SELECT count(*) AS waiting
       FROM pg_locks
       WHERE locktype = 'advisory'
         AND NOT granted
         AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database()
         )`,
    );
    if (Number(rows[0]?.waiting) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, FENCE_WAIT_POLL_MS));
  }
}

/**
 * A store whose deletes park at the delete-behavior judge's first connected
 * edge read: after the delete (and a cascade's plan) has read the node rows,
 * before any row is written. Only the timing is injected.
 */
function createPausedDeleter(db: NodePgDatabase): Readonly<{
  deleter: ReturnType<typeof createStore<typeof graph>>;
  planned: Gate;
  resume: Gate;
}> {
  const backend = createPostgresBackend(db);
  const planned = createGate();
  const resume = createGate();
  const pausedBackend = deriveBackend(backend, {
    transaction: (fn, options) =>
      backend.transaction(
        (tx) =>
          fn(
            deriveBackend(tx, {
              findEdgesConnectedTo: async (params) => {
                planned.open();
                await resume.opened;
                return tx.findEdgesConnectedTo(params);
              },
            }),
          ),
        options,
      ),
  });
  return { deleter: createStore(graph, pausedBackend), planned, resume };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "composition cascade against a concurrent writer (PostgreSQL)",
  () => {
    it.each(["repeatable_read", "serializable"] as const)(
      "fails a %s whole delete that waited on the fence while a part was attached",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (isolationLevel) => {
        const live = requirePostgres();
        const deleter = createStore(graph, createPostgresBackend(live.first));
        const attacher = createStore(graph, createPostgresBackend(live.second));
        const show = await deleter.nodes.Show.create({}, { id: "show" });

        const attached = createGate();
        const release = createGate();
        let clipId: NodeId<typeof Clip> | undefined;
        const attach = attacher.transaction(async (tx) => {
          const clip = await tx.nodes.Clip.create(
            { slug: "c1" },
            { id: "clip", partOf: { whole: show } },
          );
          clipId = clip.id;
          attached.open();
          await release.opened;
        });
        await attached.opened;

        const deletion = deleter.transaction(
          (tx) => tx.nodes.Show.delete(show.id),
          { isolationLevel },
        );
        // Observed before any await below can let it reject unhandled.
        const deletionOutcome = deletion.then(
          () => "committed" as const,
          (error: unknown) => error,
        );
        await untilSessionWaitsOnFence(live.observer);
        release.open();
        await attach;

        // MUTATION CHECK: acquiring the fence without advancing its fence
        // row (`acquireKeyedWithIsolation` in `acquireRecordedGraphWriteLock`)
        // turns this into a `COMPOSITION_CASCADE_REQUIRES_FRESH_SNAPSHOT`
        // refusal, and additionally answering `true` for a snapshot isolation
        // in `observesPostFenceCommits` lets the delete commit, leaving the
        // show tombstoned under a live required clip — verified and reverted.
        const outcome = await deletionOutcome;
        expect(outcome).toBeInstanceOf(TransactionConflictError);
        expect(isSerializationFailure(outcome)).toBe(true);
        expect(await deleter.nodes.Show.getById(show.id)).toBeDefined();
        expect(
          await deleter.nodes.Clip.getById(requireDefined(clipId)),
        ).toBeDefined();
        expect(await deleter.verifyConstraintFences()).toEqual([]);
      },
    );

    it(
      "holds the per-graph write lock from a transaction's planDelete to its delete, so no part is attached in between",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const deleter = createStore(graph, createPostgresBackend(live.first));
        const attacher = createStore(graph, createPostgresBackend(live.second));
        const show = await deleter.nodes.Show.create({}, { id: "show" });
        await deleter.nodes.Clip.create(
          { slug: "c0" },
          { id: "clip0", partOf: { whole: show } },
        );

        const planned = createGate();
        const proceed = createGate();
        const deletion = deleter.transactionWithReceipt(async (tx) => {
          const plan = await tx.nodes.Show.planDelete(show.id);
          planned.open();
          await proceed.opened;
          await tx.nodes.Show.delete(show.id);
          return requireDefined(plan);
        });
        await planned.opened;

        const attach = attacher.nodes.Clip.create(
          { slug: "c1" },
          { id: "clip1", partOf: { whole: show } },
        );
        const attachOutcome = attach.then(
          () => "committed" as const,
          (error: unknown) => error,
        );
        // MUTATION CHECK: plan with `uncapturedGraphWriteLock()` on the
        // transactional branch of `executeNodeDeletePlan`
        // (src/store/operations/node-operations.ts) and the attach commits
        // here instead of waiting, so the race answers "attach finished" —
        // verified and reverted.
        const firstToSettle = await Promise.race([
          untilSessionWaitsOnFence(live.observer).then(
            () => "attach waiting" as const,
          ),
          attachOutcome.then(() => "attach finished" as const),
        ]);
        expect(firstToSettle).toBe("attach waiting");

        proceed.open();
        const { result: plan, receipt } = await deletion;
        expect(plan.cascadedParts.map((part) => part.id)).toEqual(["clip0"]);
        expect(receipt.cascadedParts).toEqual(plan.cascadedParts);
        // The attach ran only after the delete committed, and found its whole
        // gone.
        expect(await attachOutcome).toBeInstanceOf(Error);
        expect(
          await deleter.nodes.Clip.getById("clip1" as never),
        ).toBeUndefined();
      },
    );

    it(
      "releases the unique key a member holds when its delete runs, not the one the plan read",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { deleter, planned, resume } = createPausedDeleter(live.first);
        const updater = createStore(graph, createPostgresBackend(live.second));
        const show = await updater.nodes.Show.create({}, { id: "show" });
        const other = await updater.nodes.Show.create({}, { id: "other" });
        const clip = await updater.nodes.Clip.create(
          { slug: "old" },
          { id: "clip", partOf: { whole: show } },
        );

        const deletion = deleter.nodes.Show.delete(show.id);
        await planned.opened;
        await updater.nodes.Clip.update(clip.id, { slug: "new" });
        resume.open();
        await deletion;

        // MUTATION CHECK: passing the plan's own row to
        // `deleteNodeRowInFrame` as the member's pre-image leaves "new"
        // claimed by the tombstoned clip, and this create is refused with
        // UniquenessError — verified and reverted.
        expect(await updater.nodes.Clip.getById(clip.id)).toBeUndefined();
        await expect(
          updater.nodes.Clip.create(
            { slug: "new" },
            { id: "clip2", partOf: { whole: other } },
          ),
        ).resolves.toMatchObject({ id: "clip2" });
      },
    );

    it(
      "releases the unique key a directly deleted node holds once it is tombstoned",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const { deleter, planned, resume } = createPausedDeleter(live.first);
        const updater = createStore(graph, createPostgresBackend(live.second));
        const show = await updater.nodes.Show.create({}, { id: "show" });
        const clip = await updater.nodes.Clip.create(
          { slug: "old" },
          { id: "clip", partOf: { whole: show } },
        );

        // Parked after the delete read its pre-image, before the tombstone.
        const deletion = deleter.nodes.Clip.delete(clip.id);
        await planned.opened;
        await updater.nodes.Clip.update(clip.id, { slug: "new" });
        resume.open();
        await deletion;

        // MUTATION CHECK: releasing from the pre-image's props in
        // `applyNodeSoftDelete` leaves "new" claimed by the tombstoned clip,
        // and this create is refused with UniquenessError — verified and
        // reverted.
        expect(await updater.nodes.Clip.getById(clip.id)).toBeUndefined();
        await expect(
          updater.nodes.Clip.create(
            { slug: "new" },
            { id: "clip2", partOf: { whole: show } },
          ),
        ).resolves.toMatchObject({ id: "clip2" });
      },
    );
  },
);
