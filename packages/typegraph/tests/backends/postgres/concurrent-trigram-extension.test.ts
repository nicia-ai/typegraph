/**
 * Issue #446: two materializers building DIFFERENT trigram indexes install
 * `pg_trgm` at the same moment, on a real PostgreSQL server.
 *
 * `gin_trgm_ops` lives in the extension, the extension is database-global, and
 * the claim that serializes an index build is keyed per index
 * (`typegraph_index_materializations` PK on `index_name`). Two indexes are two
 * claims, so the claim protocol admits both builders to the install — and
 * `CREATE EXTENSION IF NOT EXISTS` is not a concurrency primitive: the
 * existence check cannot see another session's uncommitted `pg_extension` row,
 * so the loser waits for the winner and is then handed SQLSTATE 23505 on
 * `pg_extension_name_index` instead of a notice. Untreated, that surfaces as
 * the loser's index reporting `failed` for a resource the winner installed.
 *
 * ## Two fences, therefore two cases
 *
 * `ensureExtension` composes both halves of the answer, and each case pins one:
 *
 *  - **lock serialization** — a per-extension `pg_advisory_xact_lock` keeps two
 *    installers of the same extension from reaching the catalog together at
 *    all, so the common case never raises (#475);
 *  - **retry tolerance** — the one-shot retry clears the 23505 an installer
 *    that did NOT take that lock can still hand us: a peer on an older release
 *    whose lock key differs, or a `transactions: false` backend with no
 *    transaction to hang the lock on (#446).
 *
 * Keeping them apart matters for what a failure means. The first case ends its
 * holder with `ROLLBACK`, so the winner's `CREATE EXTENSION` succeeds on its
 * own merits and the case cannot lean on the retry; the second commits an
 * unlocked install underneath a builder that is already inside `CREATE
 * EXTENSION`, which is the only way to hand the retry the error it exists for.
 *
 * ## Why this suite exists alongside the in-process ones
 *
 * `tests/postgres-concurrent-create-ddl.test.ts` pins the RETRY on a driver
 * stub, `tests/postgres-trigram-extension-lock.test.ts` pins the LOCK on one,
 * and `tests/materialize-trigram-extension.test.ts` pins the CALL SITE's choice
 * of primitive on PGlite. None can pin the outcome: PGlite carries no contrib
 * extensions and a stub is not a catalog. This suite is the other half — real
 * connections against one database, asserting that every builder reports a
 * built index.
 *
 * ## The overlap is arranged and observed, not hoped for
 *
 * A third session opens a transaction, creates the extension, and holds it, so
 * the builder that wins the advisory lock parks inside `CREATE EXTENSION` and
 * cannot release the lock. `pg_locks` then shows the second builder queued on
 * *that same* advisory lock — matched by key against the one its blocked peer
 * holds, so an unrelated advisory lock elsewhere in the materialization path
 * cannot stand in for it. Observing that before the holder ends its
 * transaction is what makes the case fail loudly if the contention it depends
 * on never happened, rather than pass for the wrong reason.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { defineEdgeIndex, defineNodeIndex } from "../../../src/indexes";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";
import { runServerSuiteSetup } from "./server-suite-setup";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

/**
 * Every builder parks behind the holder's open transaction, so a regression
 * that never releases them would stall the run rather than report; the timeout
 * turns a hang into a failure.
 */
const CONTENTION_TIMEOUT_MS = 30_000;

/** How long a case gives the contention it is about to become observable. */
const OVERLAP_WAIT_MS = 10_000;
const OVERLAP_POLL_MS = 50;

/**
 * Teardown settles parked builders before closing pools, and a builder is only
 * released once the holder's transaction ends — generous enough that a slow
 * `CREATE INDEX CONCURRENTLY` finishes, short enough to report a stall.
 */
const CLEANUP_TIMEOUT_MS = 30_000;

/**
 * `application_name` is how the probes tell this suite's sessions from every
 * other connection to the database. The pid keeps two workers that somehow
 * share a database (`TYPEGRAPH_TEST_SHARED_DATABASE=1`) from reading each
 * other's contention as their own.
 */
const FIRST_APPLICATION_NAME = `tg446-first-${String(process.pid)}`;
const SECOND_APPLICATION_NAME = `tg446-second-${String(process.pid)}`;
const HOLDER_APPLICATION_NAME = `tg446-holder-${String(process.pid)}`;
const BUILDER_APPLICATION_NAMES = [
  FIRST_APPLICATION_NAME,
  SECOND_APPLICATION_NAME,
];

const Article = defineNode("Article", {
  schema: z.object({ title: z.string() }),
});
const Note = defineNode("Note", {
  schema: z.object({ body: z.string() }),
});
const Memo = defineNode("Memo", {
  schema: z.object({ subject: z.string() }),
});
const annotates = defineEdge("annotates", {
  schema: z.object({ comment: z.string() }),
});

/**
 * Two graphs, two DIFFERENT trigram indexes: two claims, one extension.
 *
 * They target different RELATIONS (`typegraph_nodes` and `typegraph_edges`)
 * on purpose. `CREATE INDEX CONCURRENTLY` waits for every transaction holding
 * a lock on its own table, so two concurrent CONCURRENTLY builds against the
 * same table deadlock each other — a harness artifact that would mask the
 * catalog race this case is about.
 */
const firstGraph = defineGraph({
  id: "concurrent_trigram_alpha",
  nodes: { Article: { type: Article } },
  edges: {},
  indexes: [
    defineNodeIndex(Article, {
      fields: ["title"],
      method: "trigram",
      name: "idx_concurrent_trgm_article_title",
    }),
  ],
});
const secondGraph = defineGraph({
  id: "concurrent_trigram_beta",
  nodes: { Note: { type: Note } },
  edges: { annotates: { type: annotates, from: [Note], to: [Note] } },
  indexes: [
    defineEdgeIndex(annotates, {
      fields: ["comment"],
      method: "trigram",
      name: "idx_concurrent_trgm_annotates_comment",
    }),
  ],
});
/**
 * The retry case's own graph. Its predecessor's extension has to be dropped to
 * recreate the race, which takes that case's indexes with it, so this one
 * builds an index no earlier case has claimed.
 */
const retryGraph = defineGraph({
  id: "concurrent_trigram_gamma",
  nodes: { Memo: { type: Memo } },
  edges: {},
  indexes: [
    defineNodeIndex(Memo, {
      fields: ["subject"],
      method: "trigram",
      name: "idx_concurrent_trgm_memo_subject",
    }),
  ],
});

/**
 * THREE pools, not one with a larger `max`: each builder holds its connection
 * parked inside the install, and the holder holds a third across an open
 * transaction. A shared checkout queue would turn that into a self-deadlock of
 * the harness rather than a product result.
 */
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let holderPool: Pool | undefined;
let isPostgresAvailable = false;

/**
 * The materialization promises a case has started.
 *
 * A case that fails its observation leaves builders parked on pooled
 * connections. Closing those pools first turns one honest assertion failure
 * into a cascade of "Cannot use a pool after calling end on the pool"
 * rejections that buries it, so every exit path settles this list before a
 * pool closes. The stored promise absorbs its own rejection: the case awaits
 * (and reports) the real one.
 */
const startedWork: Promise<unknown>[] = [];

function trackWork<Result>(work: Promise<Result>): Promise<Result> {
  // The tracked copy turns a rejection into a value, so settling this list is
  // never itself a failure and never an unhandled rejection.
  startedWork.push(work.catch((error: unknown) => error));
  return work;
}

async function settleStartedWork(): Promise<void> {
  await Promise.all(startedWork);
}

/**
 * The suite is gated on `POSTGRES_URL`, and its setup FAILS rather than
 * skipping (see ./server-suite-setup.ts), so an unpublished handle here means
 * setup reported success without publishing one.
 */
function requirePostgres(): Readonly<{
  first: Pool;
  second: Pool;
  holder: Pool;
}> {
  if (
    !isPostgresAvailable ||
    firstPool === undefined ||
    secondPool === undefined ||
    holderPool === undefined
  ) {
    throw new Error(
      "concurrent-trigram-extension: PostgreSQL connections are unavailable after setup reported success.",
    );
  }
  return { first: firstPool, second: secondPool, holder: holderPool };
}

function createPool(applicationName: string): Pool {
  return new Pool({
    application_name: applicationName,
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
  });
}

/**
 * Removes the extension so the install race exists again.
 *
 * `CASCADE` because the trigram indexes an earlier case built depend on it;
 * each case builds and asserts its own, so nothing downstream needs them.
 */
async function dropTrigramExtension(pool: Pool): Promise<void> {
  await pool.query("DROP EXTENSION IF EXISTS pg_trgm CASCADE");
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const first = createPool(FIRST_APPLICATION_NAME);
  const second = createPool(SECOND_APPLICATION_NAME);
  const holder = createPool(HOLDER_APPLICATION_NAME);
  await runServerSuiteSetup(
    "concurrent-trigram-extension",
    [first, second, holder],
    async () => {
      await first.query("SELECT 1");
      await second.query("SELECT 1");
      await holder.query("SELECT 1");
      await first.query(generatePostgresMigrationSQL());
      // The race only exists while the extension is absent. A provisioned
      // database starts without it; this keeps the premise true under
      // `TYPEGRAPH_TEST_SHARED_DATABASE=1` as well.
      await dropTrigramExtension(first);
      firstPool = first;
      secondPool = second;
      holderPool = holder;
      isPostgresAvailable = true;
    },
  );
});

afterAll(async () => {
  // Before `end()`, never after: see `startedWork`.
  await settleStartedWork();
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
  if (holderPool !== undefined) await holderPool.end();
}, CLEANUP_TIMEOUT_MS);

/**
 * Runs `body` with a holder connection whose transaction is guaranteed to end.
 *
 * Both cases park a builder behind this transaction, so a body that throws
 * must still release it: a connection returned to the pool with its
 * transaction open keeps the `pg_extension` row pinned, the builders stay
 * blocked forever, and `end()` in teardown waits on connections that never
 * come back — a hook timeout hiding the assertion that actually failed. The
 * rollback is unconditional; "there is no transaction in progress" after a
 * committed body is a notice, not an error.
 */
async function withHolder<Result>(
  holder: Pool,
  body: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const client = await holder.connect();
  try {
    return await body(client);
  } finally {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The case's own error is the diagnosis and must not be replaced by a
      // failure to unwind the connection that carried it.
    }
    client.release();
    await settleStartedWork();
  }
}

/**
 * Polls `observe` until it reports at least one occurrence, or fails saying
 * what never happened.
 *
 * The failure is the point: every case here is only meaningful while the
 * contention it arranges is real, so "not observed" must be a red test rather
 * than a case that quietly proceeds to assert something easy.
 */
async function waitForContention(
  observe: () => Promise<number>,
  expectation: string,
): Promise<void> {
  const deadline = Date.now() + OVERLAP_WAIT_MS;
  for (;;) {
    const observed = await observe();
    if (observed > 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `concurrent-trigram-extension: ${expectation} was never observed within ${String(
          OVERLAP_WAIT_MS,
        )}ms; the case would pass without the contention it is about.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, OVERLAP_POLL_MS));
  }
}

/**
 * Counts builder sessions queued on an advisory lock that ANOTHER builder
 * session holds while it sits inside `CREATE EXTENSION`.
 *
 * Matching the waiter's lock to the holder's by key (`classid`, `objid`,
 * `objsubid`) is what makes this an observation of the extension fence
 * specifically: any other advisory lock taken along the materialization path
 * is held by nobody who is installing an extension, so it cannot satisfy the
 * join. `pg_locks` rather than `pg_stat_activity.wait_event` for the same
 * reason — the wait event says "advisory", not which one.
 */
async function countSerializedInstallers(probe: Pool): Promise<number> {
  const result = await probe.query<{ serialized: number }>(
    `SELECT count(*)::int AS serialized
       FROM pg_locks waiter
       JOIN pg_stat_activity waiting_session
         ON waiting_session.pid = waiter.pid
       JOIN pg_locks lock_holder
         ON lock_holder.locktype = 'advisory'
        AND lock_holder.granted
        AND lock_holder.pid <> waiter.pid
        AND lock_holder.database = waiter.database
        AND lock_holder.classid = waiter.classid
        AND lock_holder.objid = waiter.objid
        AND lock_holder.objsubid = waiter.objsubid
       JOIN pg_stat_activity installing_session
         ON installing_session.pid = lock_holder.pid
      WHERE waiter.locktype = 'advisory'
        AND NOT waiter.granted
        AND waiting_session.application_name = ANY($1::text[])
        AND installing_session.application_name = ANY($1::text[])
        AND installing_session.state = 'active'
        AND installing_session.query ILIKE '%CREATE EXTENSION%'`,
    [BUILDER_APPLICATION_NAMES],
  );
  return result.rows[0]?.serialized ?? 0;
}

/**
 * Counts builder sessions blocked on a lock from inside `CREATE EXTENSION`.
 *
 * That is the only state in which committing the holder's unlocked install
 * hands the builder the 23505 the retry exists to absorb; reaching the commit
 * without it would test nothing.
 */
async function countBlockedExtensionInstalls(
  probe: Pool,
  applicationName: string,
): Promise<number> {
  const result = await probe.query<{ blocked: number }>(
    `SELECT count(*)::int AS blocked
       FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND application_name = $1
        AND state = 'active'
        AND wait_event_type = 'Lock'
        AND query ILIKE '%CREATE EXTENSION%'`,
    [applicationName],
  );
  return result.rows[0]?.blocked ?? 0;
}

async function trigramIndexNames(
  probe: Pool,
  names: readonly string[],
): Promise<readonly string[]> {
  const result = await probe.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE indexname = ANY($1::text[]) ORDER BY indexname`,
    [names],
  );
  return result.rows.map((row) => row.indexname);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "concurrent trigram materialization (PostgreSQL)",
  () => {
    it(
      "serializes two materializers installing pg_trgm on the extension advisory lock",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        const [firstStore] = await createStoreWithSchema(
          firstGraph,
          createPostgresBackend(drizzle(live.first)),
        );
        const [secondStore] = await createStoreWithSchema(
          secondGraph,
          createPostgresBackend(drizzle(live.second)),
        );

        const [firstResult, secondResult] = await withHolder(
          live.holder,
          async (holderClient) => {
            // Pins the catalog row so whichever builder takes the advisory
            // lock parks inside `CREATE EXTENSION` still holding it — the
            // state in which the other builder's wait is observable.
            await holderClient.query("BEGIN");
            await holderClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
            const pending = trackWork(
              Promise.all([
                firstStore.materializeIndexes(),
                secondStore.materializeIndexes(),
              ]),
            );

            await waitForContention(
              () => countSerializedInstallers(live.holder),
              "a materializer queued on the advisory lock its peer holds inside CREATE EXTENSION",
            );

            // ROLLBACK, not COMMIT: this case is about the lock, so the
            // winner's `CREATE EXTENSION` must succeed on its own rather than
            // lean on the retry the next case pins.
            await holderClient.query("ROLLBACK");
            return await pending;
          },
        );

        // Serialized, not raced: each builder reports a built index.
        expect(firstResult.results.map((entry) => entry.status)).toEqual([
          "created",
        ]);
        expect(secondResult.results.map((entry) => entry.status)).toEqual([
          "created",
        ]);
        expect(
          await trigramIndexNames(live.first, [
            "idx_concurrent_trgm_article_title",
            "idx_concurrent_trgm_annotates_comment",
          ]),
        ).toEqual([
          "idx_concurrent_trgm_annotates_comment",
          "idx_concurrent_trgm_article_title",
        ]);
      },
    );

    it(
      "builds the index when an installer that skipped the lock wins the catalog race",
      { timeout: CONTENTION_TIMEOUT_MS },
      async () => {
        const live = requirePostgres();
        // The previous case left the extension installed; the race only
        // exists while it is absent.
        await dropTrigramExtension(live.first);
        const [retryStore] = await createStoreWithSchema(
          retryGraph,
          createPostgresBackend(drizzle(live.first)),
        );

        const result = await withHolder(live.holder, async (holderClient) => {
          await holderClient.query("BEGIN");
          // Raw `CREATE EXTENSION` with no advisory lock: the mixed-version
          // peer the fence cannot reach — an older release keyed
          // differently, or a `transactions: false` backend with no
          // transaction to hold a lock in.
          await holderClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
          const pending = trackWork(retryStore.materializeIndexes());

          await waitForContention(
            () =>
              countBlockedExtensionInstalls(
                live.holder,
                FIRST_APPLICATION_NAME,
              ),
            "the materializer blocked inside CREATE EXTENSION behind an unlocked peer",
          );

          // COMMIT, not ROLLBACK: the waiter is now handed 23505 on
          // `pg_extension_name_index` for an extension that exists.
          await holderClient.query("COMMIT");
          return await pending;
        });

        // `created`, not `failed`: the builder recognized the 23505 as the
        // concurrent-install race and retried through IF NOT EXISTS.
        expect(result.results.map((entry) => entry.status)).toEqual([
          "created",
        ]);
        expect(
          await trigramIndexNames(live.first, [
            "idx_concurrent_trgm_memo_subject",
          ]),
        ).toEqual(["idx_concurrent_trgm_memo_subject"]);
      },
    );
  },
);
