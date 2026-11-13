/**
 * Restoring a tombstoned required part and separating it from its whole,
 * against a second, genuinely concurrent PostgreSQL connection.
 *
 * Both decisions read what no claim row records: a restore reads the part's
 * surviving composition edge and its whole, and a detach (an edge delete, a
 * hard delete, a window end, or the whole's own delete) reads whether the part
 * is live. On a default PostgreSQL store neither read takes a row lock that
 * the other write conflicts with, so without the per-graph write fence each
 * writer judges the committed state the other is about to change, both
 * commit, and a live required part is left with no live whole.
 *
 * The fixture is a part whose tombstone outlived its whole's attachment: the
 * part row is tombstoned directly, as a write outside the store's write path
 * (or a provenance currency close) leaves it, and its composition edge to the
 * live whole survives.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  CompositionExistenceError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
  type TransactionContext,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;
/** How long the second writer may take to either settle or park on a lock. */
const SETTLE_OR_BLOCK_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10;

const Show = defineNode("Show", { schema: z.object({ name: z.string() }) });
const Clip = defineNode("Clip", { schema: z.object({ name: z.string() }) });
const clipOf = defineEdge("clipOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-composition-required-part",
  nodes: {
    Show: { type: Show },
    Clip: { type: Clip },
  },
  edges: {
    // `oneActive`, so ending the window is a detach too.
    clipOf: {
      type: clipOf,
      from: [Clip],
      to: [Show],
      cardinality: "oneActive",
    },
  },
  ontology: [partOf(Clip, Show, { via: clipOf, existence: "required" })],
});

type GraphStore = Store<typeof graph>;
type WriteSurface = Pick<TransactionContext<typeof graph>, "edges" | "nodes">;

const SHOW = "show";
const CLIP = "clip";
const EDGE = "clip-of";

const show = { kind: "Show", id: asNodeId<typeof Show>(SHOW) } as const;
const edgeId = asEdgeId<typeof clipOf>(EDGE);

type Write = Readonly<{
  name: string;
  run: (surface: WriteSurface) => Promise<unknown>;
}>;

const RESTORES: readonly Write[] = [
  {
    name: "upsertById",
    run: (surface) => surface.nodes.Clip.upsertById(CLIP, { name: "Back" }),
  },
  {
    name: "bulkUpsertById",
    run: (surface) =>
      surface.nodes.Clip.bulkUpsertById([
        { id: CLIP, props: { name: "Back" } },
      ]),
  },
  {
    name: "bulkReplaceById",
    run: (surface) =>
      surface.nodes.Clip.bulkReplaceById([
        { id: CLIP, props: { name: "Back" } },
      ]),
  },
];

const DETACHES: readonly Readonly<Write & { separatesByEdge: boolean }>[] = [
  {
    name: "edge delete",
    separatesByEdge: true,
    run: (surface) => surface.edges.clipOf.delete(edgeId),
  },
  {
    name: "edge hardDelete",
    separatesByEdge: true,
    run: (surface) => surface.edges.clipOf.hardDelete(edgeId),
  },
  {
    name: "edge bulkDelete",
    separatesByEdge: true,
    run: (surface) => surface.edges.clipOf.bulkDelete([edgeId]),
  },
  {
    name: "edge window end",
    separatesByEdge: true,
    run: (surface) =>
      surface.edges.clipOf.update(
        edgeId,
        {},
        { validTo: new Date().toISOString() },
      ),
  },
  {
    name: "whole delete",
    separatesByEdge: false,
    run: (surface) => surface.nodes.Show.delete(show.id),
  },
];

let restorePool: Pool | undefined;
let detachPool: Pool | undefined;
let probePool: Pool | undefined;
let stores:
  Readonly<{ restoreStore: GraphStore; detachStore: GraphStore }> | undefined;

function requireLive(): Readonly<{
  restoreStore: GraphStore;
  detachStore: GraphStore;
  probe: Pool;
}> {
  if (stores === undefined || probePool === undefined) {
    throw new Error(
      "concurrent-composition-required-part: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { ...stores, probe: probePool };
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
  const pools = [createPool(), createPool(), createPool()] as const;
  await runServerSuiteSetup(
    "concurrent-composition-required-part",
    pools,
    async () => {
      const [first, second, probe] = pools;
      await probe.query(generatePostgresMigrationSQL());
      restorePool = first;
      detachPool = second;
      probePool = probe;
      const [restoreStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(first)),
      );
      const [detachStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(second)),
      );
      stores = { restoreStore, detachStore };
    },
  );
});

afterAll(async () => {
  for (const pool of [restorePool, detachPool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  await probePool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
  const { restoreStore: setup, probe } = requireLive();
  await setup.nodes.Show.create({ name: "Show" }, { id: SHOW });
  await setup.nodes.Clip.create(
    { name: "Clip" },
    { id: CLIP, partOf: { whole: show } },
  );
  const attached = await probe.query(
    "UPDATE typegraph_edges SET id = $1 WHERE kind = 'clipOf' AND from_id = $2",
    [EDGE, CLIP],
  );
  const tombstoned = await probe.query(
    "UPDATE typegraph_nodes SET deleted_at = now() WHERE kind = 'Clip' AND id = $1",
    [CLIP],
  );
  if (attached.rowCount !== 1 || tombstoned.rowCount !== 1) {
    throw new Error(
      "concurrent-composition-required-part: the tombstoned-part fixture did not apply.",
    );
  }
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

type Outcome = Readonly<
  { status: "ok" } | { status: "error"; error: unknown; name: string }
>;

async function settle(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return { status: "ok" };
  } catch (error) {
    return {
      status: "error",
      error,
      name: error instanceof Error ? error.name : String(error),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether the second writer settled on its own or parked on a lock held by the
 * first writer's open transaction. Only the two stores' connections run in this
 * suite's database, so any lock waiter is the second writer.
 */
async function settledOrBlocked(
  probe: Pool,
  operation: Promise<Outcome>,
): Promise<"settled" | "blocked"> {
  const state = { settled: false };
  void operation.then(() => {
    state.settled = true;
  });
  const deadline = Date.now() + SETTLE_OR_BLOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (state.settled) return "settled";
    const waiters = await probe.query<{ waiters: number }>(
      `SELECT count(*)::int AS waiters FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND wait_event_type = 'Lock'`,
    );
    if ((waiters.rows[0]?.waiters ?? 0) > 0) return "blocked";
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    "The second writer neither settled nor waited on a lock before the deadline.",
  );
}

type Verdict = Readonly<{
  second: "settled" | "blocked";
  restore: string;
  detach: string;
  violations: readonly string[];
}>;

function describeOutcome(outcome: Outcome): string {
  return outcome.status === "ok" ? "ok" : outcome.name;
}

async function verdictOf(
  second: "settled" | "blocked",
  restoreOutcome: Outcome,
  detachOutcome: Outcome,
): Promise<Verdict> {
  const violations = await requireLive().restoreStore.verifyConstraintFences();
  return {
    second,
    restore: describeOutcome(restoreOutcome),
    detach: describeOutcome(detachOutcome),
    violations: violations.map((violation) => violation.family),
  };
}

/**
 * `first` runs inside a transaction held open on a gate; `second` starts on the
 * other connection; then `first` commits.
 */
async function race(
  first: Readonly<{ store: GraphStore; write: Write }>,
  second: Readonly<{ store: GraphStore; write: Write }>,
): Promise<
  Readonly<{
    second: "settled" | "blocked";
    first: Outcome;
    secondOutcome: Outcome;
  }>
> {
  const live = requireLive();
  const wrote = deferred();
  const release = deferred();
  const firstOperation = settle(
    first.store.transaction(async (tx) => {
      await first.write.run(tx);
      wrote.resolve();
      await release.promise;
    }),
  );
  await Promise.race([wrote.promise, firstOperation]);
  const secondOperation = settle(
    second.store.transaction((tx) => second.write.run(tx)),
  );
  const waited = await settledOrBlocked(live.probe, secondOperation);
  release.resolve();
  const [firstOutcome, secondOutcome] = await Promise.all([
    firstOperation,
    secondOperation,
  ]);
  return { second: waited, first: firstOutcome, secondOutcome };
}

async function raceRestoreFirst(
  restore: Write,
  detach: Write,
): Promise<Verdict> {
  const live = requireLive();
  const outcome = await race(
    { store: live.restoreStore, write: restore },
    { store: live.detachStore, write: detach },
  );
  return verdictOf(outcome.second, outcome.first, outcome.secondOutcome);
}

async function raceDetachFirst(
  restore: Write,
  detach: Write,
): Promise<Verdict> {
  const live = requireLive();
  const outcome = await race(
    { store: live.detachStore, write: detach },
    { store: live.restoreStore, write: restore },
  );
  return verdictOf(outcome.second, outcome.secondOutcome, outcome.first);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "restoring a required part against a concurrent detach (PostgreSQL)",
  () => {
    // MUTATION CHECK: answer `undefined` from
    // `nodeRestoreNeedsConstraintFence` and `edgeDetachNeedsConstraintFence`
    // (src/store/constraints.ts). Every edge-detach case then lets both
    // writers commit without waiting (`second: "settled"`) and leaves the
    // restored clip with no live whole (`violations:
    // ["compositionExistence"]`); the whole-delete cases do the same, since
    // the whole's fence alone does not exclude an unfenced restore.
    for (const restore of RESTORES) {
      for (const detach of DETACHES) {
        it(
          `${restore.name} first, ${detach.name} second: the detach waits and sees the restored part`,
          async () => {
            expect(await raceRestoreFirst(restore, detach)).toEqual({
              second: "blocked",
              restore: "ok",
              // A whole's delete cascades to the restored part; an edge
              // detach of a live required part is refused.
              detach:
                detach.separatesByEdge ? CompositionExistenceError.name : "ok",
              violations: [],
            });
          },
          CASE_TIMEOUT_MS,
        );

        it(
          `${detach.name} first, ${restore.name} second: the restore waits and refuses the detached part`,
          async () => {
            expect(await raceDetachFirst(restore, detach)).toEqual({
              second: "blocked",
              restore: CompositionExistenceError.name,
              detach: "ok",
              violations: [],
            });
          },
          CASE_TIMEOUT_MS,
        );
      }
    }
  },
);
