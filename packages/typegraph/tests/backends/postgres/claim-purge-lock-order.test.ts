/**
 * Lock order between a two-claim edge create and a concurrent claim purge, on
 * a real PostgreSQL server.
 *
 * An edge kind that bounds both endpoints (`cardinality: "one"` and
 * `targetCardinality: "one"`) claims two rows per edge, one statement each, in
 * claim-target order (`compareClaimTargets`: code point on axis, then key), and
 * takes over a row whose holder is tombstoned. A hard delete that removes
 * those tombstoned holders purges their claim rows. When the purge locks the
 * rows in a different order, each session can hold the row the other waits
 * for, and PostgreSQL aborts one of them with `40P01`.
 *
 * The interleaving is forced, not hoped for: the creating session is paused
 * on a gate after its first claim and before its second, the deleting session
 * runs until it queues on a lock (or finishes), then the gate opens. The two
 * tombstoned holders hang off one hub node, so the node hard delete reaches
 * them through its cascade, and the edge `bulkHardDelete` reaches them by id;
 * the creator never touches the hub. The holders are created so that the
 * purge's physical scan (by `edge_id` index and by heap alike) meets them in
 * the reverse of claim-target order.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  type ClaimEdgeCardinalityParams,
  type GraphBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { readEdgeClaimRows } from "../../edge-claim-rows";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 30_000;
/** How long the deleter is given to queue on a lock before it is said not to. */
const QUEUE_BUDGET_MS = 3000;

const LoNode = defineNode("LoNode", { schema: z.object({ name: z.string() }) });

/** Bounds both endpoints: every edge holds a source and a target claim. */
const loPairs = defineEdge("loPairs", { schema: z.object({}) });

const graph = defineGraph({
  id: "claim-purge-lock-order",
  nodes: { LoNode: { type: LoNode, onDelete: "cascade" } },
  edges: {
    loPairs: {
      type: loPairs,
      from: [LoNode],
      to: [LoNode],
      cardinality: "one",
      targetCardinality: "one",
    },
  },
});

/** One pool per session, so neither session queues behind the other's checkout. */
let pools: Readonly<{ creator: Pool; deleter: Pool; setup: Pool }> | undefined;

function requirePools(): NonNullable<typeof pools> {
  if (pools === undefined) {
    throw new Error(
      "claim-purge-lock-order: PostgreSQL pools are unavailable after setup reported success.",
    );
  }
  return pools;
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
  const created = [createPool(), createPool(), createPool()] as const;
  await runServerSuiteSetup("claim-purge-lock-order", created, async () => {
    const [creator, deleter, setup] = created;
    await setup.query(generatePostgresMigrationSQL());
    await creator.query("SELECT 1");
    await deleter.query("SELECT 1");
    pools = { creator, deleter, setup };
  });
});

afterAll(async () => {
  if (pools === undefined) return;
  for (const pool of Object.values(pools)) await pool.end();
});

beforeEach(async () => {
  if (pools === undefined) return;
  await pools.setup.query(
    "TRUNCATE typegraph_edge_claims, typegraph_edges, typegraph_nodes, typegraph_node_uniques",
  );
});

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((settle) => {
    handle.resolve = settle;
  });
  return {
    promise,
    resolve: () => {
      requireDefined(handle.resolve)();
    },
  };
}

/**
 * The creating session's backend: every transaction target's claim members
 * are counted, and the second claim waits on `opened` (signalling `reached`
 * first) before it runs.
 */
function gatedCreatorBackend(
  base: GraphBackend,
  reached: Deferred,
  opened: Deferred,
): GraphBackend {
  let claims = 0;
  async function gate(): Promise<void> {
    claims += 1;
    if (claims === 2) {
      reached.resolve();
      await opened.promise;
    }
  }
  function gated(target: TransactionBackend): TransactionBackend {
    const guarded = target.claimEdgeCardinalityGuarded;
    const plain = target.claimEdgeCardinality;
    return deriveBackend(target, {
      ...(guarded === undefined ?
        {}
      : {
          claimEdgeCardinalityGuarded: async (
            params: ClaimEdgeCardinalityParams,
          ) => {
            await gate();
            return guarded(params);
          },
        }),
      ...(plain === undefined ?
        {}
      : {
          claimEdgeCardinality: async (params: ClaimEdgeCardinalityParams) => {
            await gate();
            return plain(params);
          },
        }),
    } as never);
  }
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction((tx) => fn(gated(tx)), options),
  });
}

/** Sessions of this database currently waiting on a heavyweight lock. */
async function lockWaiters(pool: Pool): Promise<number> {
  const result = await pool.query<{ waiting: string }>(
    `SELECT count(*) AS waiting FROM pg_stat_activity
     WHERE datname = current_database() AND wait_event_type = 'Lock'`,
  );
  return Number(result.rows[0]?.waiting ?? 0);
}

/**
 * Resolves `"queued"` once a session waits on a lock, or `"settled"` when
 * `settled` resolves first; `"neither"` after {@link QUEUE_BUDGET_MS}.
 */
async function queuedOrSettled(
  pool: Pool,
  settled: Promise<unknown>,
): Promise<"queued" | "settled" | "neither"> {
  const state = { done: false };
  void settled.then(() => {
    state.done = true;
  });
  const deadline = Date.now() + QUEUE_BUDGET_MS;
  while (Date.now() < deadline) {
    if (state.done) return "settled";
    if ((await lockWaiters(pool)) >= 1) return "queued";
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return "neither";
}

type Settled = "ok" | Readonly<{ error: string; sqlState?: string }>;

/** The SQLSTATE anywhere in an error's cause chain. */
function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  while (current !== undefined && current !== null) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function settle(promise: Promise<unknown>): Promise<Settled> {
  return promise.then(
    () => "ok" as const,
    (error: unknown) => {
      const sqlState = sqlStateOf(error);
      return {
        error: error instanceof Error ? error.name : String(error),
        ...(sqlState === undefined ? {} : { sqlState }),
      };
    },
  );
}

type DeletePath = "edge bulkHardDelete" | "node hardDelete";

/**
 * Seeds `x`, `y` and the hub, and two tombstoned `loPairs` edges on the hub:
 * `e-a` from `x` (holding the source claim keyed by x) first, then `e-b` into
 * `y` (holding the target claim keyed by y). The creator's `x -> y` edge
 * claims the target axis before the source axis (the target-axis prefix
 * sorts first), so it locks `e-b`'s row first; the purge meets `e-a`'s first.
 */
async function seed(): Promise<void> {
  const [setup] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(requirePools().setup)),
  );
  const hub = await setup.nodes.LoNode.create({ name: "hub" }, { id: "hub" });
  const x = await setup.nodes.LoNode.create({ name: "x" }, { id: "x" });
  const y = await setup.nodes.LoNode.create({ name: "y" }, { id: "y" });
  await setup.edges.loPairs.create(x, hub, {}, { id: "e-a" });
  await setup.edges.loPairs.create(hub, y, {}, { id: "e-b" });
  await setup.edges.loPairs.delete("e-a" as never);
  await setup.edges.loPairs.delete("e-b" as never);
}

type Observation = Readonly<{
  /** What the deleter did while the creator held its first claim. */
  deleterWhileGated: "queued" | "settled" | "neither";
  creator: Settled;
  deleter: Settled;
  /** Which edges hold claims after both sessions finish. */
  claimHolders: readonly string[];
}>;

async function observe(path: DeletePath): Promise<Observation> {
  const live = requirePools();
  await seed();

  const reached = deferred();
  const opened = deferred();
  const [creator] = await createStoreWithSchema(
    graph,
    gatedCreatorBackend(
      createPostgresBackend(drizzle(live.creator)),
      reached,
      opened,
    ),
  );
  const [deleter] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(live.deleter)),
  );

  // One transaction each, so neither outcome is hidden by the store's
  // top-level retry of a deadlock victim.
  const creation = settle(
    creator.transaction(async (tx) => {
      await tx.edges.loPairs.create(
        { kind: "LoNode", id: "x" } as never,
        { kind: "LoNode", id: "y" } as never,
        {},
        { id: "e-new" },
      );
    }),
  );
  await reached.promise;

  const deletion = settle(
    deleter.transaction(async (tx) => {
      await (path === "edge bulkHardDelete" ?
        tx.edges.loPairs.bulkHardDelete(["e-a", "e-b"] as never)
      : tx.nodes.LoNode.hardDelete("hub" as never));
    }),
  );
  const deleterWhileGated = await queuedOrSettled(live.setup, deletion);

  opened.resolve();
  const [creatorOutcome, deleterOutcome] = await Promise.all([
    creation,
    deletion,
  ]);
  const claims = await readEdgeClaimRows(
    createPostgresBackend(drizzle(live.setup)),
    graph.id,
  );
  return {
    deleterWhileGated,
    creator: creatorOutcome,
    deleter: deleterOutcome,
    claimHolders: claims.map((claim) => claim.edge_id).toSorted(),
  };
}

// MUTATION CHECK: restore the unordered `DELETE ... WHERE edge_id IN (...)`
// in `buildPurgeEdgeClaims` — both cases end with the deleter aborted by
// `40P01` (`TransactionConflictError`). Before the node cascade released
// claims at all, the node case settled without waiting and left the removed
// holders' hub-side claim rows behind.
describe.runIf(process.env["POSTGRES_URL"])(
  "two-claim edge create against a concurrent claim purge (PostgreSQL)",
  () => {
    for (const path of [
      "edge bulkHardDelete",
      "node hardDelete",
    ] as const satisfies readonly DeletePath[]) {
      it(
        `${path} purging tombstoned holders while a create takes their claims over`,
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          // The deleter waits for the creator instead of holding a row it
          // needs: both commit, the purge skips the two rows the creator took
          // over, and the hub-side claims of the removed holders are gone.
          expect(await observe(path)).toEqual({
            deleterWhileGated: "queued",
            creator: "ok",
            deleter: "ok",
            claimHolders: ["e-new", "e-new"],
          });
        },
      );
    }
  },
);
