/**
 * Issue #446: two materializers building DIFFERENT trigram indexes install
 * `pg_trgm` at the same moment, on a real PostgreSQL server.
 *
 * `gin_trgm_ops` lives in the extension, the extension is database-global, and
 * the claim that serializes an index build is keyed per index
 * (`typegraph_index_materializations` PK on `index_name`). Two indexes are two
 * claims, so the claim protocol admits both builders to `CREATE EXTENSION IF
 * NOT EXISTS pg_trgm` concurrently — and that statement is not a concurrency
 * primitive: the existence check cannot see another session's uncommitted
 * `pg_extension` row, so the loser waits for the winner and is then handed
 * SQLSTATE 23505 on `pg_extension_name_index` instead of a notice. Today that
 * surfaces as the loser's index reporting `failed` for a resource the winner
 * already installed.
 *
 * ## Why this suite exists alongside the in-process ones
 *
 * `tests/postgres-concurrent-create-ddl.test.ts` pins the RETRY on a driver
 * stub, and `tests/materialize-trigram-extension.test.ts` pins the CALL SITE's
 * choice of primitive on PGlite. Neither can pin the outcome: PGlite carries no
 * contrib extensions and a stub is not a catalog. This suite is the other half
 * — three real connections against one database, asserting only that both
 * materializers report a built index.
 *
 * ## The overlap is arranged, not hoped for
 *
 * A third session opens a transaction, creates the extension, and holds it.
 * Both materializers then block inside `CREATE EXTENSION` — verified through
 * `pg_stat_activity` before the holder commits, so the case fails loudly if the
 * contention it depends on never happened rather than passing for the wrong
 * reason. When the holder commits, both waiters receive the 23505 the retry
 * exists to absorb.
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
 * Both materializers park inside `CREATE EXTENSION` while the holder's
 * transaction is open, so a regression that never releases them would stall
 * the run rather than report; the timeout turns a hang into a failure.
 */
const CONTENTION_TIMEOUT_MS = 20_000;

/** How long both builders are given to reach the blocked `CREATE EXTENSION`. */
const OVERLAP_WAIT_MS = 10_000;
const OVERLAP_POLL_MS = 50;

const Article = defineNode("Article", {
  schema: z.object({ title: z.string() }),
});
const Note = defineNode("Note", {
  schema: z.object({ body: z.string() }),
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
 * THREE pools, not one with a larger `max`: each materializer holds its
 * connection parked inside `CREATE EXTENSION`, and the holder holds a third
 * across an open transaction. A shared checkout queue would turn that into a
 * self-deadlock of the harness rather than a product result.
 */
let firstPool: Pool | undefined;
let secondPool: Pool | undefined;
let holderPool: Pool | undefined;
let isPostgresAvailable = false;

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
  const holder = createPool();
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
      await first.query("DROP EXTENSION IF EXISTS pg_trgm CASCADE");
      firstPool = first;
      secondPool = second;
      holderPool = holder;
      isPostgresAvailable = true;
    },
  );
});

afterAll(async () => {
  if (firstPool !== undefined) await firstPool.end();
  if (secondPool !== undefined) await secondPool.end();
  if (holderPool !== undefined) await holderPool.end();
});

/**
 * Waits until `expected` other backends are executing `CREATE EXTENSION`.
 *
 * They can only linger there while the holder's transaction is open, so this
 * is a direct observation of the overlap rather than a sleep. `pg_backend_pid`
 * excludes the poll itself, whose own text carries the pattern.
 */
async function waitForBlockedExtensionCreates(
  probe: Pool,
  expected: number,
): Promise<void> {
  const deadline = Date.now() + OVERLAP_WAIT_MS;
  for (;;) {
    const blocked = await probe.query<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
       WHERE datname = current_database()
         AND pid <> pg_backend_pid()
         AND state = 'active'
         AND query ILIKE $1`,
      ["%CREATE EXTENSION%"],
    );
    if ((blocked.rows[0]?.waiting ?? 0) >= expected) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `concurrent-trigram-extension: only ${String(
          blocked.rows[0]?.waiting ?? 0,
        )} of ${String(expected)} materializers reached a blocked CREATE EXTENSION within ${String(
          OVERLAP_WAIT_MS,
        )}ms; the case would pass without the contention it is about.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, OVERLAP_POLL_MS));
  }
}

describe.runIf(process.env["POSTGRES_URL"])(
  "concurrent trigram materialization (PostgreSQL)",
  () => {
    it(
      "builds both indexes when two materializers install pg_trgm at once",
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

        // The winner of the catalog race, held open so both materializers are
        // guaranteed to be inside `CREATE EXTENSION` when it commits.
        const holderClient: PoolClient = await live.holder.connect();
        const materializations = (async () => {
          try {
            await holderClient.query("BEGIN");
            await holderClient.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
            const pending = Promise.all([
              firstStore.materializeIndexes(),
              secondStore.materializeIndexes(),
            ]);
            await waitForBlockedExtensionCreates(live.first, 2);
            await holderClient.query("COMMIT");
            return await pending;
          } finally {
            holderClient.release();
          }
        })();

        const [firstResult, secondResult] = await materializations;

        // Both builders report a built index: the loser recognized the 23505
        // as the concurrent-install race and retried through IF NOT EXISTS.
        expect(firstResult.results.map((entry) => entry.status)).toEqual([
          "created",
        ]);
        expect(secondResult.results.map((entry) => entry.status)).toEqual([
          "created",
        ]);

        const indexes = await live.first.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE indexname IN ($1, $2) ORDER BY indexname`,
          [
            "idx_concurrent_trgm_article_title",
            "idx_concurrent_trgm_annotates_comment",
          ],
        );
        expect(indexes.rows.map((row) => row.indexname)).toEqual([
          "idx_concurrent_trgm_annotates_comment",
          "idx_concurrent_trgm_article_title",
        ]);
      },
    );
  },
);
