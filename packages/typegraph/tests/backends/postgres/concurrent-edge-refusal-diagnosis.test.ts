/**
 * Diagnosing an edge create's cardinality refusal must not deadlock a
 * concurrent hard delete of the refused edge's endpoint.
 *
 * A composition kind declares two claims on its part (the part's one whole
 * and the source cardinality), so its create claims them in separate
 * statements before its endpoint-guarded INSERT. A claim refused by a live
 * incumbent leaves the incumbent's claim row locked by the refused statement
 * until the transaction ends. Choosing between `EndpointNotFoundError` and the
 * claim refusal then reads the part. A hard delete of the same part holds the
 * part row `FOR UPDATE` and, removing the incumbent edge, purges that claim
 * row. Were the diagnostic read to lock the part (`FOR KEY SHARE`), the two
 * sessions would wait on each other and PostgreSQL would abort one with
 * `40P01`, so a caller catching the expected refusal could lose its other
 * work.
 *
 * The interleaving is forced: a third session holds the incumbent edge row,
 * so the hard delete parks after it has locked the part and before it
 * reaches the claim row. The create then runs, and the holder releases.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const CASE_TIMEOUT_MS = 20_000;
/** How long a session may take to either settle or park on a lock. */
const SETTLE_OR_BLOCK_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 10;

const Folder = defineNode("Folder", { schema: z.object({ name: z.string() }) });
const Note = defineNode("Note", { schema: z.object({ name: z.string() }) });
const noteOf = defineEdge("noteOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "concurrent-edge-refusal-diagnosis",
  nodes: {
    Folder: { type: Folder },
    Note: { type: Note, onDelete: "cascade" },
  },
  edges: {
    noteOf: { type: noteOf, from: [Note], to: [Folder], cardinality: "one" },
  },
  ontology: [partOf(Note, Folder, { via: noteOf })],
});

type GraphStore = Store<typeof graph>;

const FIRST_FOLDER = "folder-1";
const SECOND_FOLDER = "folder-2";
const THIRD_FOLDER = "folder-3";
const NOTE = "note";

const secondFolder = {
  kind: "Folder",
  id: asNodeId<typeof Folder>(SECOND_FOLDER),
} as const;
const note = { kind: "Note", id: asNodeId<typeof Note>(NOTE) } as const;

let deletePool: Pool | undefined;
let createPool_: Pool | undefined;
let holderPool: Pool | undefined;
let probePool: Pool | undefined;
let stores:
  Readonly<{ deleteStore: GraphStore; createStore: GraphStore }> | undefined;

function requireLive(): Readonly<{
  deleteStore: GraphStore;
  createStore: GraphStore;
  holder: Pool;
  probe: Pool;
}> {
  if (
    stores === undefined ||
    holderPool === undefined ||
    probePool === undefined
  ) {
    throw new Error(
      "concurrent-edge-refusal-diagnosis: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { ...stores, holder: holderPool, probe: probePool };
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
  const pools = [createPool(), createPool(), createPool(), createPool()];
  await runServerSuiteSetup(
    "concurrent-edge-refusal-diagnosis",
    pools,
    async () => {
      const [first, second, holder, probe] = pools;
      if (
        first === undefined ||
        second === undefined ||
        holder === undefined ||
        probe === undefined
      ) {
        throw new Error("Four pools were created above.");
      }
      await probe.query(generatePostgresMigrationSQL());
      deletePool = first;
      createPool_ = second;
      holderPool = holder;
      probePool = probe;
      const [deleteStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(first)),
      );
      const [createStore] = await createStoreWithSchema(
        graph,
        createPostgresBackend(drizzle(second)),
      );
      stores = { deleteStore, createStore };
    },
  );
});

afterAll(async () => {
  for (const pool of [deletePool, createPool_, holderPool, probePool]) {
    if (pool !== undefined) await pool.end();
  }
});

beforeEach(async () => {
  if (probePool === undefined) return;
  await probePool.query(
    "TRUNCATE typegraph_edge_claims, typegraph_node_uniques, typegraph_edges, typegraph_nodes",
  );
  const { deleteStore: setup } = requireLive();
  await setup.nodes.Folder.create({ name: "First" }, { id: FIRST_FOLDER });
  await setup.nodes.Folder.create({ name: "Second" }, { id: SECOND_FOLDER });
  await setup.nodes.Note.create(
    { name: "Note" },
    {
      id: NOTE,
      partOf: {
        whole: { kind: "Folder", id: asNodeId<typeof Folder>(FIRST_FOLDER) },
      },
    },
  );
});

type Outcome = Readonly<
  { status: "ok" } | { status: "error"; name: string; code: string | undefined }
>;

async function settle(operation: Promise<unknown>): Promise<Outcome> {
  try {
    await operation;
    return { status: "ok" };
  } catch (error) {
    return { status: "error", name: errorName(error), code: sqlState(error) };
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : String(error);
}

/** The SQLSTATE anywhere on the cause chain (`40P01` is a deadlock). */
function sqlState(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined; depth += 1) {
    if (typeof current === "object" && current !== null) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      current = (current as { cause?: unknown }).cause;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function describeOutcome(outcome: Outcome): string {
  if (outcome.status === "ok") return "ok";
  return outcome.code === undefined ?
      outcome.name
    : `${outcome.name} (${outcome.code})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** How many sessions in this suite's database are waiting on a lock. */
async function lockWaiters(probe: Pool): Promise<number> {
  const result = await probe.query<{ waiters: number }>(
    `SELECT count(*)::int AS waiters FROM pg_stat_activity
     WHERE datname = current_database()
       AND pid <> pg_backend_pid()
       AND wait_event_type = 'Lock'`,
  );
  return result.rows[0]?.waiters ?? 0;
}

/**
 * Whether `operation` settled on its own or became the `waiters`-th session
 * parked on a lock.
 */
async function settledOrBlocked(
  probe: Pool,
  operation: Promise<Outcome>,
  waiters: number,
): Promise<"settled" | "blocked"> {
  const state = { settled: false };
  void operation.then(() => {
    state.settled = true;
  });
  const deadline = Date.now() + SETTLE_OR_BLOCK_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (state.settled) return "settled";
    if ((await lockWaiters(probe)) >= waiters) return "blocked";
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    "The session neither settled nor waited on a lock before the deadline.",
  );
}

async function holdIncumbentEdge(holder: Pool): Promise<PoolClient> {
  const client = await holder.connect();
  await client.query("BEGIN");
  const held = await client.query(
    `SELECT id FROM typegraph_edges
     WHERE kind = 'noteOf' AND from_id = $1 FOR UPDATE`,
    [NOTE],
  );
  expect(held.rowCount).toBe(1);
  return client;
}

type Verdict = Readonly<{
  deleteParked: "settled" | "blocked";
  create: string;
  createBeforeRelease: "settled" | "blocked";
  delete: string;
  noteRows: number;
}>;

async function race(
  create: (store: GraphStore) => Promise<unknown>,
): Promise<Verdict> {
  const live = requireLive();
  const holder = await holdIncumbentEdge(live.holder);
  let released = false;
  try {
    const deleteOperation = settle(
      live.deleteStore.transaction((tx) => tx.nodes.Note.hardDelete(note.id)),
    );
    const deleteParked = await settledOrBlocked(live.probe, deleteOperation, 1);
    const createOperation = settle(create(live.createStore));
    const createBeforeRelease = await settledOrBlocked(
      live.probe,
      createOperation,
      2,
    );
    await holder.query("COMMIT");
    released = true;
    const [deleteOutcome, createOutcome] = await Promise.all([
      deleteOperation,
      createOperation,
    ]);
    const noteRows = await live.probe.query(
      "SELECT 1 FROM typegraph_nodes WHERE kind = 'Note' AND id = $1",
      [NOTE],
    );
    return {
      deleteParked,
      create: describeOutcome(createOutcome),
      createBeforeRelease,
      delete: describeOutcome(deleteOutcome),
      noteRows: noteRows.rowCount ?? 0,
    };
  } finally {
    if (!released) await holder.query("ROLLBACK");
    holder.release();
  }
}

describe.runIf(process.env["POSTGRES_URL"])(
  "a refused edge create beside a hard delete of its endpoint",
  () => {
    // REVERT CHECK: give the refusal diagnosis in
    // `refuseCardinalityAfterEndpoints` (src/store/operations/edge-operations.ts)
    // the locked endpoint read (`assertLiveEdgeEndpoints`) again. Both cases
    // fail: the create parks on the part row the delete holds. Inside the
    // transaction it is then aborted with `40P01` (deadlock detected) and
    // the transaction loses its other work; at the root it waits out the
    // delete and reports the part it found deleted.
    it(
      "at the root: the create refuses without waiting and the delete commits",
      async () => {
        expect(
          await race((store) => store.edges.noteOf.create(note, secondFolder)),
        ).toEqual({
          deleteParked: "blocked",
          createBeforeRelease: "settled",
          create: "CompositionError",
          delete: "ok",
          noteRows: 0,
        });
      },
      CASE_TIMEOUT_MS,
    );

    it(
      "inside a transaction that catches the refusal and commits its other work",
      async () => {
        const caught: string[] = [];
        expect(
          await race((store) =>
            store.transaction(async (tx) => {
              try {
                await tx.edges.noteOf.create(note, secondFolder);
              } catch (error) {
                caught.push(errorName(error));
              }
              await tx.nodes.Folder.create(
                { name: "Third" },
                { id: THIRD_FOLDER },
              );
            }),
          ),
        ).toEqual({
          deleteParked: "blocked",
          createBeforeRelease: "settled",
          create: "ok",
          delete: "ok",
          noteRows: 0,
        });
        expect(caught).toEqual(["CompositionError"]);
        const third = await requireLive().probe.query(
          "SELECT 1 FROM typegraph_nodes WHERE kind = 'Folder' AND id = $1",
          [THIRD_FOLDER],
        );
        expect(third.rowCount).toBe(1);
      },
      CASE_TIMEOUT_MS,
    );
  },
);
