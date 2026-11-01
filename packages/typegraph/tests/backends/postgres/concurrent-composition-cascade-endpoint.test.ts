/**
 * A composition whole's delete cascades to its parts, and each part it deletes
 * owes the same pairing a direct delete of that part takes (issue #795): an
 * edge written concurrently onto a cascaded part must never stay live on it.
 *
 * The cascade reads every part's connected edges while it plans, then
 * tombstones the parts. A soft delete's tombstone is an `UPDATE` that changes
 * no key, so it does not conflict with the `FOR KEY SHARE` an edge write takes
 * on its endpoints; only the cascade's own `FOR UPDATE` on each part does.
 * Without it both orders leave a live edge on a deleted part:
 *
 * - **insert first**: the cascade's connected-edge read cannot see the
 *   uncommitted edge, and its tombstone does not wait for it.
 * - **delete first**: the edge write's liveness read sees the committed, live
 *   part and commits after the cascade.
 *
 * READ COMMITTED only: the higher-isolation residual is the one
 * `concurrent-edge-endpoint-delete.test.ts` pins for every delete.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
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

const Folder = defineNode("Folder", { schema: z.object({ name: z.string() }) });
const Note = defineNode("Note", { schema: z.object({ name: z.string() }) });
const Reader = defineNode("Reader", { schema: z.object({ name: z.string() }) });
const noteOf = defineEdge("noteOf", { schema: z.object({}) });
/** An unconstrained edge: its create takes no per-graph lock. */
const cites = defineEdge("cites", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-composition-cascade-endpoint",
  nodes: {
    Folder: { type: Folder },
    Note: { type: Note, onDelete: "cascade" },
    Reader: { type: Reader },
  },
  edges: {
    noteOf: { type: noteOf, from: [Note], to: [Folder], cardinality: "one" },
    cites: { type: cites, from: [Reader], to: [Note] },
  },
  ontology: [partOf(Note, Folder, { via: noteOf })],
});

type GraphStore = Store<typeof graph>;
type WriteSurface = Pick<TransactionContext<typeof graph>, "edges" | "nodes">;

const FOLDER = "folder";
const NOTE = "note";
const READER = "reader";

const folder = { kind: "Folder", id: asNodeId<typeof Folder>(FOLDER) } as const;
const note = { kind: "Note", id: asNodeId<typeof Note>(NOTE) } as const;
const reader = { kind: "Reader", id: asNodeId<typeof Reader>(READER) } as const;

type WholeDelete = Readonly<{
  name: string;
  run: (surface: WriteSurface) => Promise<unknown>;
}>;

const WHOLE_DELETES: readonly WholeDelete[] = [
  {
    name: "delete",
    run: (surface) => surface.nodes.Folder.delete(folder.id),
  },
  {
    name: "hardDelete",
    run: (surface) => surface.nodes.Folder.hardDelete(folder.id),
  },
  {
    name: "bulkDelete",
    run: (surface) => surface.nodes.Folder.bulkDelete([folder.id]),
  },
];

function createCite(surface: WriteSurface): Promise<unknown> {
  return surface.edges.cites.create(reader, note, {});
}

let deletePool: Pool | undefined;
let edgePool: Pool | undefined;
let probePool: Pool | undefined;
let stores:
  Readonly<{ deleteStore: GraphStore; edgeStore: GraphStore }> | undefined;

function requireLive(): Readonly<{
  deleteStore: GraphStore;
  edgeStore: GraphStore;
  probe: Pool;
}> {
  if (stores === undefined || probePool === undefined) {
    throw new Error(
      "concurrent-composition-cascade-endpoint: PostgreSQL connections are unavailable after setup reported success.",
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
    "concurrent-composition-cascade-endpoint",
    pools,
    async () => {
      const [first, second, probe] = pools;
      await probe.query(generatePostgresMigrationSQL());
      deletePool = first;
      edgePool = second;
      probePool = probe;
      const [deleteStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(first)),
      );
      const [edgeStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(second)),
      );
      stores = { deleteStore, edgeStore };
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
  await setup.nodes.Folder.create({ name: "Folder" }, { id: FOLDER });
  await setup.nodes.Note.create(
    { name: "Note" },
    { id: NOTE, partOf: { whole: folder } },
  );
  await setup.nodes.Reader.create({ name: "Reader" }, { id: READER });
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

async function noteIsLive(probe: Pool): Promise<boolean> {
  const result = await probe.query<{ live: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM typegraph_nodes
       WHERE kind = 'Note' AND id = $1 AND deleted_at IS NULL
     ) AS live`,
    [NOTE],
  );
  return result.rows[0]?.live === true;
}

type Verdict = Readonly<{
  second: "settled" | "blocked";
  delete: string;
  edge: string;
  dangling: number;
  noteLive: boolean;
}>;

function describeOutcome(outcome: Outcome): string {
  return outcome.status === "ok" ? "ok" : outcome.name;
}

async function verdictOf(
  probe: Pool,
  second: "settled" | "blocked",
  deleteOutcome: Outcome,
  edgeOutcome: Outcome,
): Promise<Verdict> {
  return {
    second,
    delete: describeOutcome(deleteOutcome),
    edge: describeOutcome(edgeOutcome),
    dangling: await liveEdgesOnDeletedEndpoints(probe),
    noteLive: await noteIsLive(probe),
  };
}

/**
 * The whole's delete runs inside a transaction held open on a gate; the edge
 * write starts on the other connection; then the delete commits.
 */
async function raceDeleteFirst(wholeDelete: WholeDelete): Promise<Verdict> {
  const live = requireLive();
  const deleted = deferred();
  const release = deferred();
  const deleteOperation = settle(
    live.deleteStore.transaction(async (tx) => {
      await wholeDelete.run(tx);
      deleted.resolve();
      await release.promise;
    }),
  );
  await Promise.race([deleted.promise, deleteOperation]);
  const edgeOperation = settle(createCite(live.edgeStore));
  const second = await settledOrBlocked(live.probe, edgeOperation);
  release.resolve();
  const [deleteOutcome, edgeOutcome] = await Promise.all([
    deleteOperation,
    edgeOperation,
  ]);
  return verdictOf(live.probe, second, deleteOutcome, edgeOutcome);
}

/**
 * The edge write runs inside a transaction held open on a gate; the whole's
 * delete starts on the other connection; then the edge write commits.
 */
async function raceInsertFirst(wholeDelete: WholeDelete): Promise<Verdict> {
  const live = requireLive();
  const inserted = deferred();
  const release = deferred();
  const edgeOperation = settle(
    live.edgeStore.transaction(async (tx) => {
      await createCite(tx);
      inserted.resolve();
      await release.promise;
    }),
  );
  await Promise.race([inserted.promise, edgeOperation]);
  const deleteOperation = settle(
    live.deleteStore.transaction((tx) => wholeDelete.run(tx)),
  );
  const second = await settledOrBlocked(live.probe, deleteOperation);
  release.resolve();
  const [edgeOutcome, deleteOutcome] = await Promise.all([
    edgeOperation,
    deleteOperation,
  ]);
  return verdictOf(live.probe, second, deleteOutcome, edgeOutcome);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "a composition cascade and a concurrent edge onto a cascaded part",
  () => {
    // MUTATION CHECK: drop the `lockCascadeMembers` call from
    // `planCascadingNodeDelete` (src/store/operations/node-operations.ts).
    // Five of the six cases then leave the edge live on the deleted note
    // (`dangling: 1`). Only hard delete-first still holds without it: the
    // part's row `DELETE` itself conflicts with the edge write's endpoint
    // lock.
    for (const wholeDelete of WHOLE_DELETES) {
      it(
        `${wholeDelete.name}, delete first: the edge write waits and refuses the deleted part`,
        async () => {
          expect(await raceDeleteFirst(wholeDelete)).toEqual({
            second: "blocked",
            delete: "ok",
            edge: EndpointNotFoundError.name,
            dangling: 0,
            noteLive: false,
          });
        },
        CASE_TIMEOUT_MS,
      );

      it(
        `${wholeDelete.name}, insert first: the cascade waits and removes the committed edge`,
        async () => {
          expect(await raceInsertFirst(wholeDelete)).toEqual({
            second: "blocked",
            delete: "ok",
            edge: "ok",
            dangling: 0,
            noteLive: false,
          });
        },
        CASE_TIMEOUT_MS,
      );
    }
  },
);
