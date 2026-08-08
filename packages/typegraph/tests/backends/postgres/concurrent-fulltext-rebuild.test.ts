/**
 * `store.rebuildContribution("fulltext")` under GENUINE contention with a
 * writer from another graph, on a real PostgreSQL server.
 *
 * The fulltext table is one physical relation holding every graph's rows, and
 * the rebuild decides whether it may `DROP TABLE` it by probing for another
 * graph's rows. That probe is an ordinary SELECT and ordinary fulltext DML
 * takes no advisory lock, so the contribution's constant-keyed advisory lock
 * excludes other REBUILDS and nothing else. Without a lock whose scope matches
 * the decision's resource, a neighbouring graph's INSERT commits between the
 * probe and the drop and is destroyed by a verdict computed before it existed —
 * the graph's whole search index silently emptied, while its durable marker
 * (keyed by `graph_id`) still reports `ready`.
 *
 * ## Why this suite exists alongside the in-process one
 *
 * `tests/contribution-rebuild-lock.test.ts` pins the MECHANISM on PGlite — that
 * `ACCESS EXCLUSIVE` is taken on the shared table, after the contribution
 * advisory lock, before the probe that authorizes the drop, and NOT at all on
 * the graph-scoped path. It cannot pin the outcome: PGlite is single-connection
 * and serial, so a writer can never actually overlap a rebuild there. This
 * suite is the other half. It runs two independent connections against one
 * database and asserts only the OUTCOME — that the neighbouring graph's
 * searchable content is still there — never which of the two went first, which
 * is what makes it stable whichever way the lock is granted.
 *
 * The interleaving is arranged rather than hoped for: the neighbour's INSERT is
 * held open in an uncommitted transaction, so it is invisible to any probe yet
 * blocks the relation lock. The rebuild therefore reaches its teardown decision
 * with the row still uncommitted — exactly the window the fix closes. With the
 * `ACCESS EXCLUSIVE` lock the rebuild waits for that transaction and re-reads
 * the table under exclusion, sees the neighbour, and keeps its rows; without it
 * the rebuild's probe sees an empty table, and its `DROP TABLE` — which waits
 * for the same transaction — destroys the row the moment it commits.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  searchable,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/**
 * The rebuild parks in `LOCK TABLE` while the neighbour's transaction is held
 * open, so a lock-order regression would stall the run rather than report; the
 * timeout turns a hang into a failure.
 */
const CONTENTION_TIMEOUT_MS = 20_000;

/**
 * How long the rebuild is given to reach its teardown decision while the
 * neighbour's INSERT is uncommitted. Generous, and only a lower bound on the
 * strength of the interleaving: if the rebuild had not got that far, its probe
 * would run after the commit and see the neighbour anyway, so a slow machine
 * weakens this test rather than making it flaky.
 */
const REBUILD_HEADSTART_MS = 750;

const Article = defineNode("Article", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const Note = defineNode("Note", {
  schema: z.object({ body: searchable({ language: "english" }) }),
});

/** The graph whose rebuild runs. */
const rebuildingGraph = defineGraph({
  id: "concurrent-fulltext-rebuild-alpha",
  nodes: { Article: { type: Article } },
  edges: {},
});
/** The neighbour: same database, same fulltext table, different rows. */
const neighborGraph = defineGraph({
  id: "concurrent-fulltext-rebuild-beta",
  nodes: { Note: { type: Note } },
  edges: {},
});

/**
 * TWO pools, not one with a larger `max`. The rebuild parks inside
 * `LOCK TABLE` while holding its connection, and that wait must not sit behind
 * the neighbour's own connection in a shared checkout queue — that would be a
 * self-deadlock of the harness rather than a product result.
 */
let rebuildPool: Pool | undefined;
let writerPool: Pool | undefined;
let rebuildDb: NodePgDatabase | undefined;
let writerDb: NodePgDatabase | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Readonly<{
  rebuild: NodePgDatabase;
  writer: NodePgDatabase;
}> {
  if (
    !isPostgresAvailable ||
    rebuildDb === undefined ||
    writerDb === undefined
  ) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return { rebuild: rebuildDb, writer: writerDb };
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
  try {
    await first.query("SELECT 1");
    await second.query("SELECT 1");
    await first.query(generatePostgresMigrationSQL());
    rebuildPool = first;
    writerPool = second;
    rebuildDb = drizzle(first);
    writerDb = drizzle(second);
    isPostgresAvailable = true;
  } catch (error) {
    console.error(
      "concurrent-fulltext-rebuild: Postgres setup failed; skipping suite.",
      error,
    );
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await first.end().catch(() => {});
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    await second.end().catch(() => {});
  }
});

afterAll(async () => {
  if (rebuildPool !== undefined) await rebuildPool.end();
  if (writerPool !== undefined) await writerPool.end();
});

beforeEach(async () => {
  if (rebuildPool === undefined) return;
  // The fulltext table is recreated by the rebuild under test, so it is
  // dropped rather than truncated: every case here provisions it from the
  // current DDL through the two stores' boot.
  await rebuildPool.query("DROP TABLE IF EXISTS typegraph_node_fulltext");
  await rebuildPool.query(
    "TRUNCATE typegraph_contribution_materializations, typegraph_node_uniques, " +
      "typegraph_edges, typegraph_nodes, typegraph_schema_versions",
  );
});

/** A promise plus the handle that settles it, for arranging the overlap. */
function createGate(): Readonly<{
  promise: Promise<void>;
  open: () => void;
}> {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    handle.resolve = resolve;
  });
  return {
    promise,
    open: () => {
      handle.resolve?.();
    },
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe.runIf(process.env["POSTGRES_URL"])(
  "fulltext rebuild under genuine contention (PostgreSQL)",
  () => {
    it(
      "does not destroy a neighbouring graph's rows committed while it decides",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const [rebuilding] = await createStoreWithSchema(
          rebuildingGraph,
          createPostgresBackend(live.rebuild),
        );
        const [neighbor] = await createStoreWithSchema(
          neighborGraph,
          createPostgresBackend(live.writer),
        );
        await rebuilding.nodes.Article.create({ title: "Alpha content" });

        // The neighbour's INSERT is executed but NOT committed: invisible to
        // any probe, and holding the row lock that a `DROP TABLE` must wait
        // for. This is the window the fix closes.
        const inserted = createGate();
        const release = createGate();
        const neighborWrite = neighbor.transaction(async (tx) => {
          await tx.nodes.Note.create({ body: "Beta content that must live" });
          inserted.open();
          await release.promise;
        });
        await inserted.promise;

        // Start the rebuild and give it time to reach its teardown decision
        // while the neighbour's row is still uncommitted.
        const rebuild = rebuilding.rebuildContribution("fulltext");
        await delay(REBUILD_HEADSTART_MS);
        release.open();

        await neighborWrite;
        await rebuild;

        // The outcome, and the only thing asserted: the neighbour's content
        // survived. Which of the two went first is arbitrary — either the
        // rebuild saw the committed row and kept the table, or it waited for
        // the lock and then saw it — and both orders satisfy the invariant.
        const hits = await neighbor.search.fulltext("Note", {
          query: "Beta",
          limit: 10,
        });
        expect(hits).toHaveLength(1);
        const probed = await neighbor.probeContributions();
        expect(
          probed.entries.find((entry) => entry.contribution === "fulltext"),
        ).toEqual({ contribution: "fulltext", state: "ready" });

        // ...and the graph that asked for the rebuild got one.
        const rebuilt = await rebuilding.search.fulltext("Article", {
          query: "Alpha",
          limit: 10,
        });
        expect(rebuilt).toHaveLength(1);
      },
    );

    it(
      "still recreates the storage when it genuinely is the only graph in the table",
      { timeout: CONTENTION_TIMEOUT_MS },
      async (ctx) => {
        const live = requirePostgres(ctx);
        const [rebuilding] = await createStoreWithSchema(
          rebuildingGraph,
          createPostgresBackend(live.rebuild),
        );
        await rebuilding.nodes.Article.create({ title: "Alpha content" });

        // No neighbour: the exclusion the rebuild takes must not turn the
        // ordinary single-graph repair into a refusal or a no-op.
        const result = await rebuilding.rebuildContribution("fulltext");
        expect(result.rebuilt).toEqual(["typegraph_node_fulltext"]);
        expect(result.repopulated).toBeGreaterThanOrEqual(1);

        const hits = await rebuilding.search.fulltext("Article", {
          query: "Alpha",
          limit: 10,
        });
        expect(hits).toHaveLength(1);
      },
    );
  },
);
