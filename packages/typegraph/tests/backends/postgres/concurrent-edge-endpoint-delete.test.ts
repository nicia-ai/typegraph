/**
 * Issue #795: an edge written concurrently with a delete of one of its
 * endpoints must never stay live on the deleted node.
 *
 * Every endpoint-guarded edge write checks that both endpoints are live, and
 * every node delete reads the node's connected edges and removes or refuses
 * them by its `onDelete` behavior. Without a lock both reads are plain MVCC
 * reads, so each can miss the other's uncommitted write:
 *
 * - **delete first**: the delete has read the connected edges and tombstoned
 *   the node, but not committed. The edge write's liveness read still sees the
 *   committed (live) node version and commits an edge the delete never saw.
 * - **insert first**: the edge write has inserted, but not committed. The
 *   delete's connected-edge read cannot see it, so the delete commits a
 *   tombstone under an edge that commits a moment later.
 *
 * The fix pairs the locks a foreign key's referential check takes: an edge
 * write locks both endpoint rows `FOR KEY SHARE` in the statement that checks
 * their liveness, and a node delete locks its row(s) `FOR UPDATE` before it
 * reads connected edges. Delete-first then makes the edge write wait and
 * re-evaluate the endpoint after the delete commits (refused at READ
 * COMMITTED, a serialization failure above it); insert-first makes the delete
 * wait, and its next statement's snapshot sees the committed edge.
 *
 * ## The documented residual
 *
 * A REPEATABLE READ or SERIALIZABLE delete whose transaction snapshot predates
 * the edge write's commit still waits on the lock and then proceeds, because
 * the edge write only LOCKED the endpoint row — it never updated it — so
 * PostgreSQL reports no serialization failure and the delete's snapshot never
 * shows the edge. Both writers at SERIALIZABLE close it (SSI sees the
 * read/write cycle). The matrix pins the residual's exact outcome, and the last
 * describe block pins the SERIALIZABLE closure, so the documentation of both
 * stays true.
 *
 * Outcomes only, never which connection PostgreSQL schedules first: each case
 * forces the order by holding the first writer's transaction open on a gate,
 * then observes whether the second writer settled or parked on a lock.
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
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
  inspectGraphStorage,
  RestrictedDeleteError,
  type Store,
  TransactionConflictError,
  type TransactionContext,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import {
  type EdgeRow,
  type GraphBackend,
  type TransactionBackend,
} from "../../../src/backend/types";
import { type GraphData, importGraph } from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;
/** How long the second writer may take to either settle or park on a lock. */
const SETTLE_OR_BLOCK_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10;

/** `onDelete: "cascade"`: a delete removes the node's connected edges. */
const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
/** The default `onDelete: "restrict"`: a connected edge refuses the delete. */
const Tag = defineNode("Tag", { schema: z.object({ label: z.string() }) });

const knows = defineEdge("knows", { schema: z.object({}) });
const mentors = defineEdge("mentors", { schema: z.object({}) });
const tagged = defineEdge("tagged", { schema: z.object({}) });
const primaryTag = defineEdge("primaryTag", { schema: z.object({}) });
/** Durable match identity: creates converge through the identity arbiter. */
const employs = defineEdge("employs", {
  schema: z.object({ role: z.string() }),
});
const labeledAs = defineEdge("labeledAs", {
  schema: z.object({ role: z.string() }),
});

const graph = defineGraph({
  id: "concurrent-edge-endpoint-delete",
  nodes: {
    Person: { type: Person, onDelete: "cascade" },
    Tag: { type: Tag },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    mentors: {
      type: mentors,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
    tagged: { type: tagged, from: [Person], to: [Tag] },
    primaryTag: {
      type: primaryTag,
      from: [Person],
      to: [Tag],
      cardinality: "one",
    },
    employs: {
      type: employs,
      from: [Person],
      to: [Person],
      matchIdentity: { name: "role", fields: ["role"] },
    },
    labeledAs: {
      type: labeledAs,
      from: [Person],
      to: [Tag],
      matchIdentity: { name: "role", fields: ["role"] },
    },
  },
});

type GraphStore = Store<typeof graph>;
type WriteSurface = Pick<TransactionContext<typeof graph>, "edges" | "nodes">;
type IsolationLevel = "read_committed" | "repeatable_read" | "serializable";

const ISOLATION_LEVELS: readonly IsolationLevel[] = [
  "read_committed",
  "repeatable_read",
  "serializable",
];

const CLEARED_GRAPH_ID = "concurrent-edge-endpoint-delete-cleared";

const ALICE = "alice";
const BOB = "bob";
const TAG = "tag";

type Target = "Person" | "Tag";

/**
 * One endpoint-guarded edge write, aimed at the node the delete removes.
 * `seed` runs before the race — a resurrection needs its tombstoned edge.
 */
type EdgeWrite = Readonly<{
  name: string;
  seed?: (surface: WriteSurface, target: Target) => Promise<unknown>;
  run: (surface: WriteSurface, target: Target) => Promise<unknown>;
}>;

const REVIVED_ID = "revived";

/** Creates the edge the resurrecting writes revive, then tombstones it. */
async function seedTombstonedEdge(
  surface: WriteSurface,
  target: Target,
): Promise<void> {
  if (target === "Person") {
    const edge = await surface.edges.knows.create(
      alice,
      bob,
      {},
      { id: REVIVED_ID },
    );
    await surface.edges.knows.delete(edge.id);
    return;
  }
  const edge = await surface.edges.tagged.create(
    alice,
    tag,
    {},
    { id: REVIVED_ID },
  );
  await surface.edges.tagged.delete(edge.id);
}

async function seedTombstonedDurableEdge(
  surface: WriteSurface,
  target: Target,
): Promise<void> {
  if (target === "Person") {
    const edge = await surface.edges.employs.create(alice, bob, {
      role: "lead",
    });
    await surface.edges.employs.delete(edge.id);
    return;
  }
  const edge = await surface.edges.labeledAs.create(alice, tag, {
    role: "lead",
  });
  await surface.edges.labeledAs.delete(edge.id);
}

const alice = { kind: "Person", id: ALICE } as const;
const bob = { kind: "Person", id: BOB } as const;
const tag = { kind: "Tag", id: TAG } as const;

const EDGE_WRITES: readonly EdgeWrite[] = [
  {
    name: "create",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.create(alice, bob, {})
      : surface.edges.tagged.create(alice, tag, {}),
  },
  {
    name: "create (cardinality one)",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.mentors.create(alice, bob, {})
      : surface.edges.primaryTag.create(alice, tag, {}),
  },
  {
    name: "bulkCreate",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.bulkCreate([{ from: alice, to: bob, props: {} }])
      : surface.edges.tagged.bulkCreate([{ from: alice, to: tag, props: {} }]),
  },
  {
    name: "bulkInsert",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.bulkInsert([{ from: alice, to: bob, props: {} }])
      : surface.edges.tagged.bulkInsert([{ from: alice, to: tag, props: {} }]),
  },
  {
    name: "getOrCreateByEndpoints",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.getOrCreateByEndpoints(alice, bob, {})
      : surface.edges.tagged.getOrCreateByEndpoints(alice, tag, {}),
  },
  {
    name: "bulkGetOrCreateByEndpoints",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.bulkGetOrCreateByEndpoints([
          { from: alice, to: bob, props: {} },
        ])
      : surface.edges.tagged.bulkGetOrCreateByEndpoints([
          { from: alice, to: tag, props: {} },
        ]),
  },
  {
    name: "create (durable identity)",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.employs.create(alice, bob, { role: "lead" })
      : surface.edges.labeledAs.create(alice, tag, { role: "lead" }),
  },
  {
    name: "getOrCreateByEndpoints (durable identity)",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.employs.getOrCreateByEndpoints(alice, bob, {
          role: "lead",
        })
      : surface.edges.labeledAs.getOrCreateByEndpoints(alice, tag, {
          role: "lead",
        }),
  },
  {
    name: "bulkGetOrCreateByEndpoints (durable identity)",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.employs.bulkGetOrCreateByEndpoints([
          { from: alice, to: bob, props: { role: "lead" } },
        ])
      : surface.edges.labeledAs.bulkGetOrCreateByEndpoints([
          { from: alice, to: tag, props: { role: "lead" } },
        ]),
  },
  {
    name: "getOrCreateByEndpoints (resurrect)",
    seed: seedTombstonedEdge,
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.getOrCreateByEndpoints(alice, bob, {})
      : surface.edges.tagged.getOrCreateByEndpoints(alice, tag, {}),
  },
  {
    name: "bulkUpsertById (resurrect)",
    seed: seedTombstonedEdge,
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.bulkUpsertById([
          {
            id: asEdgeId<typeof knows>(REVIVED_ID),
            from: alice,
            to: bob,
            props: {},
          },
        ])
      : surface.edges.tagged.bulkUpsertById([
          {
            id: asEdgeId<typeof tagged>(REVIVED_ID),
            from: alice,
            to: tag,
            props: {},
          },
        ]),
  },
  {
    name: "getOrCreateByEndpoints (durable identity, resurrect)",
    seed: seedTombstonedDurableEdge,
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.employs.getOrCreateByEndpoints(alice, bob, {
          role: "lead",
        })
      : surface.edges.labeledAs.getOrCreateByEndpoints(alice, tag, {
          role: "lead",
        }),
  },
  {
    name: "bulkGetOrCreateByEndpoints (durable identity, resurrect)",
    seed: seedTombstonedDurableEdge,
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.employs.bulkGetOrCreateByEndpoints([
          { from: alice, to: bob, props: { role: "lead" } },
        ])
      : surface.edges.labeledAs.bulkGetOrCreateByEndpoints([
          { from: alice, to: tag, props: { role: "lead" } },
        ]),
  },
  {
    name: "bulkUpsertById",
    run: (surface, target) =>
      target === "Person" ?
        surface.edges.knows.bulkUpsertById([
          {
            id: asEdgeId<typeof knows>("upserted"),
            from: alice,
            to: bob,
            props: {},
          },
        ])
      : surface.edges.tagged.bulkUpsertById([
          {
            id: asEdgeId<typeof tagged>("upserted"),
            from: alice,
            to: tag,
            props: {},
          },
        ]),
  },
];

/**
 * One node delete of the edge's target endpoint. `purgesTombstones`: a hard
 * delete also removes the node's tombstoned edges, so it writes the very row a
 * concurrent resurrection updates.
 */
type NodeDelete = Readonly<{
  name: string;
  target: Target;
  purgesTombstones?: true;
  run: (surface: WriteSurface) => Promise<unknown>;
}>;

const NODE_DELETES: readonly NodeDelete[] = [
  {
    name: "delete (cascade)",
    target: "Person",
    run: (surface) => surface.nodes.Person.delete(asNodeId<typeof Person>(BOB)),
  },
  {
    name: "bulkDelete (cascade)",
    target: "Person",
    run: (surface) =>
      surface.nodes.Person.bulkDelete([asNodeId<typeof Person>(BOB)]),
  },
  {
    name: "hardDelete (cascade)",
    target: "Person",
    purgesTombstones: true,
    run: (surface) =>
      surface.nodes.Person.hardDelete(asNodeId<typeof Person>(BOB)),
  },
  {
    name: "delete (restrict)",
    target: "Tag",
    run: (surface) => surface.nodes.Tag.delete(asNodeId<typeof Tag>(TAG)),
  },
  {
    name: "bulkDelete (restrict)",
    target: "Tag",
    run: (surface) => surface.nodes.Tag.bulkDelete([asNodeId<typeof Tag>(TAG)]),
  },
];

let deletePool: Pool | undefined;
let edgePool: Pool | undefined;
let probePool: Pool | undefined;

/**
 * Schema-managed stores take the schema-fenced fused statements and atomic
 * programs; unmanaged stores take the unfenced fused statements. Both must
 * hold the invariant.
 */
type StoreMode = "managed" | "unmanaged";

type StorePair = Readonly<{ deleteStore: GraphStore; edgeStore: GraphStore }>;

const storePairs = new Map<StoreMode, StorePair>();
let activeMode: StoreMode = "managed";

function requireLive(): StorePair & Readonly<{ probe: Pool }> {
  const pair = storePairs.get(activeMode);
  if (pair === undefined || probePool === undefined) {
    throw new Error(
      "concurrent-edge-endpoint-delete: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { ...pair, probe: probePool };
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
    "concurrent-edge-endpoint-delete",
    pools,
    async () => {
      const [first, second, probe] = pools;
      await probe.query(generatePostgresMigrationSQL());
      deletePool = first;
      edgePool = second;
      probePool = probe;
      const [managedDeleteStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(first)),
      );
      const [managedEdgeStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(second)),
      );
      storePairs.set("managed", {
        deleteStore: managedDeleteStore,
        edgeStore: managedEdgeStore,
      });
      storePairs.set("unmanaged", {
        deleteStore: createStore(graph, createPostgresBackend(drizzle(first))),
        edgeStore: createStore(graph, createPostgresBackend(drizzle(second))),
      });
    },
  );
});

afterAll(async () => {
  for (const pool of [deletePool, edgePool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  await probePool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
  const { deleteStore: setup } = requireLive();
  await setup.nodes.Person.create({ name: "Alice" }, { id: ALICE });
  await setup.nodes.Person.create({ name: "Bob" }, { id: BOB });
  await setup.nodes.Tag.create({ label: "tag" }, { id: TAG });
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

/** Holds a row lock on one Person row from a separate connection. */
async function holdRowLock(
  probe: Pool,
  id: string,
  strength: "FOR UPDATE" | "FOR KEY SHARE",
): Promise<Readonly<{ release: () => Promise<void> }>> {
  const client = await probe.connect();
  await client.query("BEGIN");
  await client.query(
    `SELECT 1 FROM typegraph_nodes WHERE kind = 'Person' AND id = $1 ${strength}`,
    [id],
  );
  return {
    release: async () => {
      await client.query("ROLLBACK");
      client.release();
    },
  };
}

async function isRowLocked(probe: Pool, id: string): Promise<boolean> {
  const client = await probe.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT 1 FROM typegraph_nodes WHERE kind = 'Person' AND id = $1 FOR UPDATE NOWAIT`,
      [id],
    );
    return false;
  } catch {
    return true;
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

/**
 * Pauses a backend's writer at the two points the stale-preimage resurrection
 * race needs: after the first edge read that returns the tombstoned edge (the
 * read its resurrect decision is made from), and just before the resurrecting
 * UPDATE. Wraps the root and every transaction target, through `deriveBackend`.
 */
function pauseResurrection(
  backend: GraphBackend,
  edgeId: string,
  gates: Readonly<{
    decided: Deferred;
    afterDecision: Deferred;
    beforeWrite: Deferred;
    write: Deferred;
  }>,
): GraphBackend {
  const state = { decided: false, writing: false };
  async function afterRead<T extends EdgeRow | undefined>(
    rows: readonly T[],
  ): Promise<void> {
    if (state.decided) return;
    const tombstone = rows.find(
      (row) => row?.id === edgeId && row.deleted_at !== undefined,
    );
    if (tombstone === undefined) return;
    state.decided = true;
    gates.decided.resolve();
    await gates.afterDecision.promise;
  }
  function overlay<T extends GraphBackend | TransactionBackend>(target: T) {
    const getEdges = target.getEdges;
    return {
      async getEdge(graphId: string, id: string) {
        const row = await target.getEdge(graphId, id);
        await afterRead([row]);
        return row;
      },
      ...(getEdges === undefined ?
        {}
      : {
          async getEdges(graphId: string, ids: readonly string[]) {
            const rows = await getEdges(graphId, ids);
            await afterRead(rows);
            return rows;
          },
        }),
      async updateEdge(params: Parameters<T["updateEdge"]>[0]) {
        if (
          params.id === edgeId &&
          params.clearDeleted === true &&
          !state.writing
        ) {
          state.writing = true;
          gates.beforeWrite.resolve();
          await gates.write.promise;
        }
        return target.updateEdge(params);
      },
    };
  }
  return deriveBackend(backend, {
    ...overlay(backend),
    transaction: (run, options) =>
      backend.transaction(
        (target) => run(deriveBackend(target, overlay(target))),
        options,
      ),
  });
}

/** Live edges whose source or target node is tombstoned or gone. */
async function liveEdgesOnDeletedEndpoints(probe: Pool): Promise<number> {
  const result = await probe.query<{ dangling: number }>(
    `SELECT count(*)::int AS dangling
     FROM typegraph_edges AS e
     LEFT JOIN typegraph_nodes AS f
       ON f.graph_id = e.graph_id AND f.kind = e.from_kind AND f.id = e.from_id
     LEFT JOIN typegraph_nodes AS t
       ON t.graph_id = e.graph_id AND t.kind = e.to_kind AND t.id = e.to_id
     WHERE e.deleted_at IS NULL
       AND (f.id IS NULL OR f.deleted_at IS NOT NULL
         OR t.id IS NULL OR t.deleted_at IS NOT NULL)`,
  );
  return result.rows[0]?.dangling ?? 0;
}

async function liveEdgeCount(probe: Pool): Promise<number> {
  const result = await probe.query<{ live: number }>(
    "SELECT count(*)::int AS live FROM typegraph_edges WHERE deleted_at IS NULL",
  );
  return result.rows[0]?.live ?? 0;
}

async function targetIsLive(probe: Pool, target: Target): Promise<boolean> {
  const id = target === "Person" ? BOB : TAG;
  const result = await probe.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM typegraph_nodes
       WHERE kind = $1 AND id = $2 AND deleted_at IS NULL
     ) AS live`,
    [target, id],
  );
  return result.rows[0]?.live === true;
}

type RaceResult = Readonly<{
  second: "settled" | "blocked";
  deleteOutcome: Outcome;
  edgeOutcome: Outcome;
  dangling: number;
  liveEdges: number;
  targetLive: boolean;
}>;

function describeOutcome(outcome: Outcome): string {
  return outcome.status === "ok" ? "ok" : outcome.name;
}

function describeRace(result: RaceResult): string {
  return [
    `second=${result.second}`,
    `delete=${describeOutcome(result.deleteOutcome)}`,
    `edge=${describeOutcome(result.edgeOutcome)}`,
    `dangling=${result.dangling}`,
    `liveEdges=${result.liveEdges}`,
    `targetLive=${result.targetLive}`,
  ].join(" ");
}

/**
 * The delete runs (edge read, onDelete behavior, tombstone) inside a
 * transaction held open on a gate; the edge write starts on the other
 * connection; then the delete commits.
 */
async function raceDeleteFirst(
  nodeDelete: NodeDelete,
  edgeWrite: EdgeWrite,
  isolationLevel: IsolationLevel,
): Promise<RaceResult> {
  const live = requireLive();
  await edgeWrite.seed?.(live.edgeStore, nodeDelete.target);
  const deleted = deferred();
  const release = deferred();
  const deleteOperation = settle(
    live.deleteStore.transaction(
      async (tx) => {
        await nodeDelete.run(tx);
        deleted.resolve();
        await release.promise;
      },
      { isolationLevel },
    ),
  );
  await Promise.race([deleted.promise, deleteOperation]);
  const edgeOperation = settle(
    edgeWrite.run(live.edgeStore, nodeDelete.target),
  );
  const second = await settledOrBlocked(live.probe, edgeOperation);
  release.resolve();
  const [deleteOutcome, edgeOutcome] = await Promise.all([
    deleteOperation,
    edgeOperation,
  ]);
  return {
    second,
    deleteOutcome,
    edgeOutcome,
    dangling: await liveEdgesOnDeletedEndpoints(live.probe),
    liveEdges: await liveEdgeCount(live.probe),
    targetLive: await targetIsLive(live.probe, nodeDelete.target),
  };
}

/**
 * The edge write runs inside a transaction (at the store default isolation)
 * held open on a gate; the delete starts on the other connection at the given
 * isolation; then the edge write commits. `snapshotFirst` opens the delete's
 * transaction snapshot before the edge write commits — the shape of every
 * REPEATABLE READ delete that has run any statement first.
 */
/**
 * A delete issued straight on the store, with no caller transaction: the
 * shape that runs a plain restricted delete as the closed atomic program.
 */
const ROOT_DELETE = "root";

async function raceInsertFirst(
  nodeDelete: NodeDelete,
  edgeWrite: EdgeWrite,
  isolationLevel: IsolationLevel | typeof ROOT_DELETE,
  edgeIsolationLevel?: IsolationLevel,
): Promise<RaceResult> {
  const live = requireLive();
  await edgeWrite.seed?.(live.edgeStore, nodeDelete.target);
  const inserted = deferred();
  const release = deferred();
  const edgeOperation = settle(
    live.edgeStore.transaction(
      async (tx) => {
        await edgeWrite.run(tx, nodeDelete.target);
        inserted.resolve();
        await release.promise;
      },
      edgeIsolationLevel === undefined ? undefined : (
        { isolationLevel: edgeIsolationLevel }
      ),
    ),
  );
  await Promise.race([inserted.promise, edgeOperation]);
  const deleteOperation = settle(
    isolationLevel === ROOT_DELETE ?
      nodeDelete.run(live.deleteStore)
    : live.deleteStore.transaction((tx) => nodeDelete.run(tx), {
        isolationLevel,
      }),
  );
  const second = await settledOrBlocked(live.probe, deleteOperation);
  release.resolve();
  const [edgeOutcome, deleteOutcome] = await Promise.all([
    edgeOperation,
    deleteOperation,
  ]);
  return {
    second,
    deleteOutcome,
    edgeOutcome,
    dangling: await liveEdgesOnDeletedEndpoints(live.probe),
    liveEdges: await liveEdgeCount(live.probe),
    targetLive: await targetIsLive(live.probe, nodeDelete.target),
  };
}

/** The observable result of one race, in one comparable record. */
type Verdict = Readonly<{
  second: "settled" | "blocked";
  delete: string;
  edge: string;
  dangling: number;
  liveEdges: number;
  targetLive: boolean;
}>;

function verdictOf(result: RaceResult): Verdict {
  return {
    second: result.second,
    delete: describeOutcome(result.deleteOutcome),
    edge: describeOutcome(result.edgeOutcome),
    dangling: result.dangling,
    liveEdges: result.liveEdges,
    targetLive: result.targetLive,
  };
}

/**
 * Delete first, at any delete isolation: the edge write (store default READ
 * COMMITTED) waits on the delete's row lock, re-reads the endpoint once the
 * delete commits, and refuses.
 */
const DELETE_FIRST_VERDICT: Verdict = {
  second: "blocked",
  delete: "ok",
  edge: EndpointNotFoundError.name,
  dangling: 0,
  liveEdges: 0,
  targetLive: false,
};

/**
 * Insert first: the delete waits on the edge write's endpoint lock. At READ
 * COMMITTED its connected-edge read is a later statement whose snapshot sees
 * the committed edge, so `cascade` removes it and `restrict` refuses. Above
 * READ COMMITTED the delete's snapshot predates the edge's commit and nothing
 * the edge write did updated the node row, so the delete commits without
 * seeing it — the documented residual, pinned here so the documentation of
 * it stays exact.
 */
function insertFirstVerdict(
  nodeDelete: NodeDelete,
  edgeWrite: EdgeWrite,
  isolationLevel: IsolationLevel,
): Verdict {
  if (
    isolationLevel !== "read_committed" &&
    nodeDelete.purgesTombstones === true &&
    edgeWrite.seed !== undefined
  ) {
    // The hard delete's tombstone purge writes the row the resurrection
    // updated, which above READ COMMITTED is a serialization failure.
    return {
      second: "blocked",
      delete: TransactionConflictError.name,
      edge: "ok",
      dangling: 0,
      liveEdges: 1,
      targetLive: true,
    };
  }
  if (isolationLevel !== "read_committed") {
    return {
      second: "blocked",
      delete: "ok",
      edge: "ok",
      dangling: 1,
      liveEdges: 1,
      targetLive: false,
    };
  }
  return nodeDelete.target === "Tag" ?
      {
        second: "blocked",
        delete: RestrictedDeleteError.name,
        edge: "ok",
        dangling: 0,
        liveEdges: 1,
        targetLive: true,
      }
    : {
        second: "blocked",
        delete: "ok",
        edge: "ok",
        dangling: 0,
        liveEdges: 0,
        targetLive: false,
      };
}

describe.runIf(process.env["POSTGRES_URL"])(
  "edge writes racing an endpoint delete (PostgreSQL)",
  () => {
    describe.each(["managed", "unmanaged"] as const)("%s store", (mode) => {
      beforeEach(() => {
        activeMode = mode;
      });
      // A hard delete clears fulltext rows, which needs the initialized
      // storage only a schema-managed store provisions.
      const nodeDeletes = NODE_DELETES.filter(
        (nodeDelete) =>
          mode === "managed" || !nodeDelete.name.startsWith("hardDelete"),
      );
      describe.each(ISOLATION_LEVELS)("delete at %s", (isolationLevel) => {
        describe.each(nodeDeletes)("$name", (nodeDelete) => {
          it.each(EDGE_WRITES)(
            "delete first: $name is refused once the delete commits",
            { timeout: CASE_TIMEOUT_MS },
            async (edgeWrite) => {
              const result = await raceDeleteFirst(
                nodeDelete,
                edgeWrite,
                isolationLevel,
              );
              console.log(
                `[delete-first ${isolationLevel}] ${nodeDelete.name} vs ${edgeWrite.name}: ${describeRace(result)}`,
              );
              expect(verdictOf(result)).toEqual(DELETE_FIRST_VERDICT);
            },
          );

          it.each(EDGE_WRITES)(
            "insert first: the delete waits for the committed $name",
            { timeout: CASE_TIMEOUT_MS },
            async (edgeWrite) => {
              const result = await raceInsertFirst(
                nodeDelete,
                edgeWrite,
                isolationLevel,
              );
              console.log(
                `[insert-first ${isolationLevel}] ${nodeDelete.name} vs ${edgeWrite.name}: ${describeRace(result)}`,
              );
              expect(verdictOf(result)).toEqual(
                insertFirstVerdict(nodeDelete, edgeWrite, isolationLevel),
              );
            },
          );
        });
      });

      describe.each(nodeDeletes)(
        "$name with no caller transaction",
        (nodeDelete) => {
          it.each(EDGE_WRITES)(
            "insert first: the delete waits for the committed $name",
            { timeout: CASE_TIMEOUT_MS },
            async (edgeWrite) => {
              const result = await raceInsertFirst(
                nodeDelete,
                edgeWrite,
                ROOT_DELETE,
              );
              console.log(
                `[insert-first root] ${nodeDelete.name} vs ${edgeWrite.name}: ${describeRace(result)}`,
              );
              expect(verdictOf(result)).toEqual(
                insertFirstVerdict(nodeDelete, edgeWrite, "read_committed"),
              );
            },
          );
        },
      );
    });

    describe("writers above READ COMMITTED", () => {
      beforeEach(() => {
        activeMode = "managed";
      });

      it.each(["repeatable_read", "serializable"] as const)(
        "delete first: an edge write at %s fails with a transaction conflict",
        { timeout: CASE_TIMEOUT_MS },
        async (edgeIsolationLevel) => {
          const live = requireLive();
          const deleted = deferred();
          const release = deferred();
          const deleteOperation = settle(
            live.deleteStore.transaction(async (tx) => {
              await tx.nodes.Person.delete(asNodeId<typeof Person>(BOB));
              deleted.resolve();
              await release.promise;
            }),
          );
          await deleted.promise;
          const edgeOperation = settle(
            live.edgeStore.transaction(
              (tx) => tx.edges.knows.create(alice, bob, {}),
              { isolationLevel: edgeIsolationLevel },
            ),
          );
          const second = await settledOrBlocked(live.probe, edgeOperation);
          release.resolve();
          const [deleteOutcome, edgeOutcome] = await Promise.all([
            deleteOperation,
            edgeOperation,
          ]);
          expect({
            second,
            delete: describeOutcome(deleteOutcome),
            edge: describeOutcome(edgeOutcome),
            dangling: await liveEdgesOnDeletedEndpoints(live.probe),
          }).toEqual({
            second: "blocked",
            delete: "ok",
            edge: TransactionConflictError.name,
            dangling: 0,
          });
        },
      );

      it.each(NODE_DELETES)(
        "insert first, both writers at serializable: $name aborts instead of leaking",
        { timeout: CASE_TIMEOUT_MS },
        async (nodeDelete) => {
          const result = await raceInsertFirst(
            nodeDelete,
            requireDefined(EDGE_WRITES[0]),
            "serializable",
            "serializable",
          );
          expect(verdictOf(result)).toEqual({
            second: "blocked",
            delete: TransactionConflictError.name,
            edge: "ok",
            dangling: 0,
            liveEdges: 1,
            targetLive: true,
          });
        },
      );
    });

    describe.each(["managed", "unmanaged"] as const)(
      "%s store: other writers of the same rows",
      (mode) => {
        beforeEach(() => {
          activeMode = mode;
        });

        it(
          "a resurrection decided on a stale tombstone still locks the endpoints it revives onto",
          { timeout: CASE_TIMEOUT_MS },
          async () => {
            // T1 decides to resurrect from a tombstone; T2 revives the edge and
            // commits; T1 re-reads it live; T3 deletes an endpoint, which
            // tombstones the edge again; T1's resurrecting UPDATE — it has no
            // `deleted_at` predicate — revives it. T1 must hold the endpoint
            // lock regardless of what its re-read showed, so T3 waits for T1
            // and then cascades the edge T1 committed.
            const live = requireLive();
            await seedTombstonedEdge(live.edgeStore, "Person");
            const gates = {
              decided: deferred(),
              afterDecision: deferred(),
              beforeWrite: deferred(),
              write: deferred(),
            };
            const pausedBackend = pauseResurrection(
              createPostgresBackend(drizzle(requireDefined(edgePool))),
              REVIVED_ID,
              gates,
            );
            const [resurrector] =
              mode === "managed" ?
                await createStoreWithSchema(graph, pausedBackend)
              : [createStore(graph, pausedBackend)];
            const resurrection = settle(
              resurrector.edges.knows.bulkUpsertById([
                {
                  id: asEdgeId<typeof knows>(REVIVED_ID),
                  from: alice,
                  to: bob,
                  props: {},
                },
              ]),
            );
            await Promise.race([gates.decided.promise, resurrection]);
            const revival = await settle(
              live.deleteStore.edges.knows.getOrCreateByEndpoints(
                alice,
                bob,
                {},
              ),
            );
            gates.afterDecision.resolve();
            await Promise.race([gates.beforeWrite.promise, resurrection]);
            const deletion = settle(
              live.deleteStore.nodes.Person.delete(
                asNodeId<typeof Person>(BOB),
              ),
            );
            const deleteState = await settledOrBlocked(live.probe, deletion);
            gates.write.resolve();
            const [resurrectionOutcome, deleteOutcome] = await Promise.all([
              resurrection,
              deletion,
            ]);
            expect({
              revival: describeOutcome(revival),
              deleteState,
              resurrection: describeOutcome(resurrectionOutcome),
              delete: describeOutcome(deleteOutcome),
              dangling: await liveEdgesOnDeletedEndpoints(live.probe),
              liveEdges: await liveEdgeCount(live.probe),
            }).toEqual({
              revival: "ok",
              deleteState: "blocked",
              resurrection: "ok",
              delete: "ok",
              dangling: 0,
              liveEdges: 0,
            });
          },
        );

        it(
          "batch node updates and cross edge writes do not deadlock",
          { timeout: CASE_TIMEOUT_MS },
          async () => {
            // A batch update locks its rows `FOR NO KEY UPDATE`, which an edge
            // write's `FOR KEY SHARE` on the same rows does not wait on. With
            // `FOR UPDATE` the two transactions below each waited on the
            // other's row and PostgreSQL aborted one as a deadlock.
            const live = requireLive();
            const firstUpdated = deferred();
            const firstGo = deferred();
            const first = settle(
              live.deleteStore.transaction(async (tx) => {
                await tx.nodes.Person.bulkUpsertById([
                  { id: asNodeId<typeof Person>(ALICE), props: { name: "A2" } },
                ]);
                firstUpdated.resolve();
                await firstGo.promise;
                await tx.edges.knows.create(alice, bob, {});
              }),
            );
            await firstUpdated.promise;
            const second = settle(
              live.edgeStore.transaction(async (tx) => {
                await tx.nodes.Person.bulkUpsertById([
                  { id: asNodeId<typeof Person>(BOB), props: { name: "B2" } },
                ]);
                await tx.edges.knows.create(bob, alice, {});
              }),
            );
            const secondState = await settledOrBlocked(live.probe, second);
            firstGo.resolve();
            const [firstOutcome, secondOutcome] = await Promise.all([
              first,
              second,
            ]);
            expect({
              second: secondState,
              first: describeOutcome(firstOutcome),
              secondOutcome: describeOutcome(secondOutcome),
              liveEdges: await liveEdgeCount(live.probe),
            }).toEqual({
              second: "settled",
              first: "ok",
              secondOutcome: "ok",
              liveEdges: 2,
            });
          },
        );

        it.each([
          {
            name: "an ordinary row",
            edges: [
              {
                kind: "knows",
                id: "imported",
                from: { kind: "Person", id: ALICE },
                to: { kind: "Person", id: BOB },
                properties: {},
              },
            ],
          },
          {
            // The second row reuses the first's id, so the import defers it
            // out of the set-oriented slice into its per-row path, which
            // must take the same endpoint lock.
            name: "a deferred duplicate-id row",
            edges: [
              {
                kind: "knows",
                id: "duplicated",
                from: { kind: "Person", id: "missing" },
                to: { kind: "Person", id: ALICE },
                properties: {},
              },
              {
                kind: "knows",
                id: "duplicated",
                from: { kind: "Person", id: ALICE },
                to: { kind: "Person", id: BOB },
                properties: {},
              },
            ],
          },
        ])(
          "delete first: an imported edge to the deleted node ($name) is refused",
          { timeout: CASE_TIMEOUT_MS },
          async ({ edges }) => {
            const live = requireLive();
            const deleted = deferred();
            const release = deferred();
            const deletion = settle(
              live.deleteStore.transaction(async (tx) => {
                await tx.nodes.Person.delete(asNodeId<typeof Person>(BOB));
                deleted.resolve();
                await release.promise;
              }),
            );
            await deleted.promise;
            const data: GraphData = {
              formatVersion: "2.0",
              exportedAt: "2026-01-01T00:00:00.000Z",
              source: { type: "external" },
              nodes: [],
              edges,
            };
            const imported = importGraph(live.edgeStore, data, {
              onConflict: "error",
            });
            const importState = await settledOrBlocked(
              live.probe,
              settle(imported),
            );
            release.resolve();
            const [deleteOutcome, result] = await Promise.all([
              deletion,
              imported,
            ]);
            expect({
              importState,
              delete: describeOutcome(deleteOutcome),
              refusedForDeletedEndpoint: result.errors.some(
                (error) => error.error === `To node not found: Person:${BOB}`,
              ),
              dangling: await liveEdgesOnDeletedEndpoints(live.probe),
              liveEdges: await liveEdgeCount(live.probe),
            }).toEqual({
              importState: "blocked",
              delete: "ok",
              refusedForDeletedEndpoint: true,
              dangling: 0,
              liveEdges: 0,
            });
          },
        );
      },
    );

    describe("store.clear()", () => {
      it.each([
        { name: "an unconstrained edge", constrained: false, claims: 0 },
        // Claims clear before nodes, so a claim the waited-for edge wrote
        // survives; it names a gone edge, so the axis is still takeable.
        { name: "a cardinality-one edge", constrained: true, claims: 1 },
      ])(
        "insert first: clear removes $name committed while it waited",
        { timeout: CASE_TIMEOUT_MS },
        async ({ constrained, claims }) => {
          // A graph of its own: clearing drops the graph's schema rows, which
          // the managed stores every other case uses depend on.
          const clearedGraph = defineGraph({
            id: CLEARED_GRAPH_ID,
            nodes: graph.nodes,
            edges: graph.edges,
          });
          const live = requireLive();
          const clearer = createStore(
            clearedGraph,
            createPostgresBackend(drizzle(requireDefined(deletePool))),
          );
          const writer = createStore(
            clearedGraph,
            createPostgresBackend(drizzle(requireDefined(edgePool))),
          );
          await clearer.nodes.Person.create({ name: "Alice" }, { id: ALICE });
          await clearer.nodes.Person.create({ name: "Bob" }, { id: BOB });
          const inserted = deferred();
          const release = deferred();
          const creation = settle(
            writer.transaction(async (tx) => {
              await (constrained ?
                tx.edges.mentors.create(alice, bob, {})
              : tx.edges.knows.create(alice, bob, {}));
              inserted.resolve();
              await release.promise;
            }),
          );
          await inserted.promise;
          const clearing = settle(clearer.clear());
          const clearState = await settledOrBlocked(live.probe, clearing);
          release.resolve();
          const [edgeOutcome, clearOutcome] = await Promise.all([
            creation,
            clearing,
          ]);
          const remaining = await live.probe.query<{
            edges: number;
            nodes: number;
          }>(
            `SELECT (SELECT count(*)::int FROM typegraph_edges WHERE graph_id = $1) AS edges,
                    (SELECT count(*)::int FROM typegraph_nodes WHERE graph_id = $1) AS nodes`,
            [CLEARED_GRAPH_ID],
          );
          const storage = await inspectGraphStorage(clearer);
          const claimRows =
            storage.relations.find(
              (relation) => relation.relation === "edgeClaims",
            )?.rows ?? 0;
          await clearer.nodes.Person.create({ name: "Alice" }, { id: ALICE });
          await clearer.nodes.Person.create({ name: "Bob" }, { id: BOB });
          const recreated = settle(
            constrained ?
              clearer.edges.mentors.create(alice, bob, {})
            : clearer.edges.knows.create(alice, bob, {}),
          );
          expect({
            clearState,
            edge: describeOutcome(edgeOutcome),
            clear: describeOutcome(clearOutcome),
            remaining: remaining.rows[0],
            claimRows,
            recreated: describeOutcome(await recreated),
          }).toEqual({
            clearState: "blocked",
            edge: "ok",
            clear: "ok",
            remaining: { edges: 0, nodes: 0 },
            claimRows: claims,
            recreated: "ok",
          });
          await clearer.clear();
        },
      );
    });

    describe("lock acquisition order", () => {
      beforeEach(() => {
        activeMode = "managed";
      });

      /**
       * Ids whose code-point order (`"B"` < `"a"`) is the reverse of the test
       * database's linguistic collation order, so a lock statement that fell
       * back to the column collation (or to index order) would lock `"a"`
       * first and these cases would see `"B"` unlocked.
       */
      const LOWER = "a";
      const UPPER = "B";

      /**
       * Skips the case on a database whose default collation already sorts
       * `"B"` before `"a"` (a `C`-collated one): there code-point and
       * collation order agree, so the case cannot tell them apart.
       */
      async function seedOrderedPair(
        skip: (condition: boolean, note?: string) => void,
      ): Promise<void> {
        const live = requireLive();
        const collation = await live.probe.query<{ linguistic: boolean }>(
          `SELECT $1::text < $2::text AS linguistic`,
          [LOWER, UPPER],
        );
        skip(
          collation.rows[0]?.linguistic !== true,
          "The database collation orders ids by code point, so lock order cannot be told apart from collation order.",
        );
        await live.deleteStore.nodes.Person.create(
          { name: "lower" },
          { id: LOWER },
        );
        await live.deleteStore.nodes.Person.create(
          { name: "upper" },
          { id: UPPER },
        );
      }

      it(
        "a bulk delete locks its rows in code-point order",
        { timeout: CASE_TIMEOUT_MS },
        async ({ skip }) => {
          const live = requireLive();
          await seedOrderedPair(skip);
          const holder = await holdRowLock(live.probe, LOWER, "FOR KEY SHARE");
          const deletion = settle(
            live.deleteStore.nodes.Person.bulkDelete([
              asNodeId<typeof Person>(LOWER),
              asNodeId<typeof Person>(UPPER),
            ]),
          );
          const state = await settledOrBlocked(live.probe, deletion);
          const upperLocked = await isRowLocked(live.probe, UPPER);
          await holder.release();
          expect({
            state,
            upperLocked,
            delete: describeOutcome(await deletion),
          }).toEqual({ state: "blocked", upperLocked: true, delete: "ok" });
        },
      );

      it.for([
        { name: "create", cardinalityOne: false },
        { name: "create (cardinality one)", cardinalityOne: true },
      ])(
        "an edge write ($name) locks its endpoints in code-point order",
        { timeout: CASE_TIMEOUT_MS },
        async ({ cardinalityOne }, { skip }) => {
          const live = requireLive();
          await seedOrderedPair(skip);
          const holder = await holdRowLock(live.probe, LOWER, "FOR UPDATE");
          const from = { kind: "Person", id: LOWER } as const;
          const to = { kind: "Person", id: UPPER } as const;
          const creation = settle(
            cardinalityOne ?
              live.edgeStore.edges.mentors.create(from, to, {})
            : live.edgeStore.edges.knows.create(from, to, {}),
          );
          const state = await settledOrBlocked(live.probe, creation);
          const upperLocked = await isRowLocked(live.probe, UPPER);
          await holder.release();
          expect({
            state,
            upperLocked,
            edge: describeOutcome(await creation),
          }).toEqual({ state: "blocked", upperLocked: true, edge: "ok" });
        },
      );
    });
  },
);
