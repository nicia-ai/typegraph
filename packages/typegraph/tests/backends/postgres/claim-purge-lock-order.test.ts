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
  type PurgeEdgeClaimsParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { requireDefined } from "../../../src/utils/presence";
import { readEdgeClaimRows } from "../../edge-claim-rows";
import { expectObservation } from "../../helpers/known-defect";
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
 * Whether the purge reaches both holders in one statement (the default bind
 * budget, no other holders) or across several: a bind budget of 32 caps a
 * purge statement at 31 edge ids, and 40 tombstoned filler holders sit
 * between `e-a` and `e-b`, so the lock order must hold across statements,
 * not only within one.
 */
type PurgeBudget = "one statement" | "across statements";

const PURGE_BUDGETS = {
  "one statement": { maxBindParameters: undefined, fillers: 0 },
  "across statements": { maxBindParameters: 32, fillers: 40 },
} as const satisfies Record<
  PurgeBudget,
  Readonly<{ maxBindParameters: number | undefined; fillers: number }>
>;

/**
 * Seeds `x`, `y` and the hub, and two tombstoned `loPairs` edges on the hub:
 * `e-a` from `x` (holding the source claim keyed by x) first, then `e-b` into
 * `y` (holding the target claim keyed by y). The creator's `x -> y` edge
 * claims the target axis before the source axis (the target-axis prefix
 * sorts first), so it locks `e-b`'s row first; the purge meets `e-a`'s first.
 */
async function seed(fillers: number): Promise<readonly string[]> {
  const [setup] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(requirePools().setup)),
  );
  const hub = await setup.nodes.LoNode.create({ name: "hub" }, { id: "hub" });
  const x = await setup.nodes.LoNode.create({ name: "x" }, { id: "x" });
  const y = await setup.nodes.LoNode.create({ name: "y" }, { id: "y" });
  await setup.edges.loPairs.create(x, hub, {}, { id: "e-a" });
  await setup.edges.loPairs.delete("e-a" as never);
  // Each filler points at the hub, so it takes the hub's target claim over
  // from `e-a` and the holder before it; `e-a` keeps x's source claim.
  const fillerIds: string[] = [];
  for (let index = 0; index < fillers; index += 1) {
    const id = `e-filler-${String(index).padStart(3, "0")}`;
    const peer = await setup.nodes.LoNode.create(
      { name: id },
      { id: `peer-${index}` },
    );
    await setup.edges.loPairs.create(peer, hub, {}, { id });
    await setup.edges.loPairs.delete(id as never);
    fillerIds.push(id);
  }
  await setup.edges.loPairs.create(hub, y, {}, { id: "e-b" });
  await setup.edges.loPairs.delete("e-b" as never);
  return ["e-a", ...fillerIds, "e-b"];
}

type Observation = Readonly<{
  /** What the deleter did while the creator held its first claim. */
  deleterWhileGated: "queued" | "settled" | "neither";
  creator: Settled;
  deleter: Settled;
  /** Which edges hold claims after both sessions finish. */
  claimHolders: readonly string[];
}>;

async function observe(
  path: DeletePath,
  budget: PurgeBudget,
): Promise<Observation> {
  const live = requirePools();
  const { maxBindParameters, fillers } = PURGE_BUDGETS[budget];
  const holderIds = await seed(fillers);

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
    createPostgresBackend(
      drizzle(live.deleter),
      maxBindParameters === undefined ?
        {}
      : { capabilities: { maxBindParameters } },
    ),
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
        tx.edges.loPairs.bulkHardDelete(holderIds as never)
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
    for (const [path, budget] of [
      ["edge bulkHardDelete", "one statement"],
      ["node hardDelete", "one statement"],
      ["edge bulkHardDelete", "across statements"],
      ["node hardDelete", "across statements"],
    ] as const satisfies readonly (readonly [DeletePath, PurgeBudget])[]) {
      it(
        `${path} purging tombstoned holders (${budget}) while a create takes their claims over`,
        { timeout: CASE_TIMEOUT_MS },
        async () => {
          // The deleter waits for the creator instead of holding a row it
          // needs: both commit, the purge skips the two rows the creator took
          // over, and the hub-side claims of the removed holders are gone.
          expect(await observe(path, budget)).toEqual({
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

/**
 * The deleting session's backend for the id-reuse case: every transaction
 * target's `purgeEdgeClaims` waits on `opened` (signalling `reached` first),
 * so the edge row is gone, uncommitted, before its claims are released.
 */
function gatedPurgeBackend(
  base: GraphBackend,
  reached: Deferred,
  opened: Deferred,
): GraphBackend {
  function gated(target: TransactionBackend): TransactionBackend {
    const purge = requireDefined(target.purgeEdgeClaims);
    return deriveBackend(target, {
      purgeEdgeClaims: async (params: PurgeEdgeClaimsParams) => {
        reached.resolve();
        await opened.promise;
        return purge(params);
      },
    } as never);
  }
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction((tx) => fn(gated(tx)), options),
  });
}

/**
 * KNOWN DEFECT (edge-id-reuse-purge-deadlock): a hard delete releases claims
 * after it removes the edge row, keyed by the ids the DELETE returned. A
 * concurrent create that reuses the removed edge's id from a surviving
 * constrained endpoint finds the claim row still naming that id, claims it as
 * its own (locking the row), then waits for the deleter's uncommitted DELETE
 * on the edges primary key — while the deleter's purge waits for that claim
 * row. PostgreSQL aborts one of the two with `40P01`.
 *
 * Present on main for an edge `hardDelete`, which is the path pinned here
 * (its purge is a separate member, so the gate can sit between the two
 * statements); a node hard delete's cascade has the same DELETE-then-release
 * order. The fix is outside the purge's lock order: either release before the
 * edge row goes (which a statement-returned key forbids) or have the create
 * take the edges primary-key wait before it locks a claim row whose holder
 * shares its id.
 */
describe.runIf(process.env["POSTGRES_URL"])(
  "edge id reuse against a concurrent hard delete (PostgreSQL)",
  () => {
    it(
      "a create reusing a hard-deleted edge's id while the delete releases its claims",
      { timeout: CASE_TIMEOUT_MS },
      async () => {
        const live = requirePools();
        const [setup] = await createStoreWithSchema(
          graph,
          createPostgresBackend(drizzle(live.setup)),
        );
        const x = await setup.nodes.LoNode.create({ name: "x" }, { id: "x" });
        const y = await setup.nodes.LoNode.create({ name: "y" }, { id: "y" });
        await setup.nodes.LoNode.create({ name: "z" }, { id: "z" });
        await setup.edges.loPairs.create(x, y, {}, { id: "e-r" });
        // Tombstoned: its claim rows survive until a hard delete releases
        // them, and no live edge refuses the reusing create's probe.
        await setup.edges.loPairs.delete("e-r" as never);

        const reached = deferred();
        const opened = deferred();
        const [deleter] = await createStoreWithSchema(
          graph,
          gatedPurgeBackend(
            createPostgresBackend(drizzle(live.deleter)),
            reached,
            opened,
          ),
        );
        const [creator] = await createStoreWithSchema(
          graph,
          createPostgresBackend(drizzle(live.creator)),
        );

        const deletion = settle(
          deleter.transaction(async (tx) => {
            await tx.edges.loPairs.hardDelete("e-r" as never);
          }),
        );
        await reached.promise;
        const creation = settle(
          creator.transaction(async (tx) => {
            await tx.edges.loPairs.create(
              { kind: "LoNode", id: "x" } as never,
              { kind: "LoNode", id: "z" } as never,
              {},
              { id: "e-r" },
            );
          }),
        );
        const creatorWhileGated = await queuedOrSettled(live.setup, creation);
        opened.resolve();
        const outcomes = await Promise.all([deletion, creation]);

        expect(creatorWhileGated).toBe("queued");
        expectObservation({
          lane: { server: "postgresql" },
          observed: {
            deadlockVictims: outcomes.filter(
              (outcome) => outcome !== "ok" && outcome.sqlState === "40P01",
            ).length,
          },
          correct: { deadlockVictims: 0 },
          defects: [
            {
              label: "edge-id-reuse-purge-deadlock",
              on: {},
              today: { deadlockVictims: 1 },
            },
          ],
        });
      },
    );
  },
);
