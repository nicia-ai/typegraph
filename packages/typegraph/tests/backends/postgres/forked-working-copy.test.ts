/**
 * `forkedWorkingCopyStrategy` over a real PostgreSQL host-level fork:
 * `CREATE DATABASE ... TEMPLATE`.
 *
 * No dump-and-restore test harness exists in this repo for PGlite (checked:
 * `rg -n "pgDump|dump" tests/` turns up nothing relevant), so this suite adds
 * the fork mechanism itself, on the real server lane only. Skipped
 * automatically when `POSTGRES_URL` is unset.
 *
 * PostgreSQL refuses `CREATE DATABASE ... TEMPLATE` while ANY other session —
 * active or merely idle-in-pool — is connected to the template database (this
 * was verified directly against the running server before writing this
 * suite). The base store's own connection pool is therefore ended for the
 * instant of the copy and a fresh one opened right after, inside `fork()`.
 * `SwappablePool` is what lets `baseStore` — the exact `Store` object handed
 * to `branch()` — survive that reconnection as the SAME object: Drizzle's
 * node-postgres driver dispatches on `client instanceof Pool` OR a
 * constructor name containing "Pool" (see its `NodePgDriver.connect()`), so a
 * class named `SwappablePool` that forwards `query`/`connect`/`end` to a
 * swappable underlying `pg.Pool` is treated exactly like a real one — the
 * `Store`/backend built on top of it never has to be reconstructed. This is
 * the same hazard as a fork-capable host that suspends idle compute and drops
 * its sessions: whatever is memoized on a live connection does not survive a
 * suspend, so only the write fence and the lock memo — which re-acquire per
 * transaction — may be relied on across one.
 *
 * The two `DROP DATABASE` statements this suite needs — clearing residue from
 * an earlier run, and releasing the fork — run in `beforeAll`/`afterAll`, not
 * in the test body, for the reason `HOST_DDL_TIMEOUT_MS` documents below.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { wrapWithManagedClose } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { branch } from "../../../src/graph-merge/branch";
import { merge } from "../../../src/graph-merge/merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import type { GraphBranch } from "../../../src/graph-merge/types";
import {
  forkedWorkingCopyStrategy,
  type ForkHandle,
} from "../../../src/graph-merge/working-copy";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Widget = defineNode("Widget", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "forked-working-copy-postgres-test",
  nodes: { Widget: { type: Widget } },
  edges: {},
});
type G = typeof graph;

/**
 * `branch()`'s `makeBackend` parameter is documented as "ignored when an
 * explicit strategy is supplied" — this proves it by rejecting if called.
 */
function rejectMakeBackend(): Promise<never> {
  return Promise.reject(
    new Error("makeBackend must not be called when a strategy is supplied"),
  );
}

/**
 * A `pg.Pool`-shaped forwarder whose underlying pool can be swapped out.
 * Drizzle's node-postgres driver picks its `isPool` transaction strategy from
 * `client instanceof Pool || constructor.name.includes("Pool")` — this class's
 * own name satisfies the second test — so `drizzle(swappable)` behaves exactly
 * as `drizzle(realPool)` would, while `swappable.current` can be replaced
 * underneath the SAME `db`/backend/`Store` objects.
 */
class SwappablePool {
  current: Pool;
  constructor(initial: Pool) {
    this.current = initial;
  }
  // The only two shapes Drizzle's node-postgres session actually calls (see
  // its `session.js`: `client.query(text, params)` for a direct statement,
  // `client.connect()` to check a dedicated client out for a transaction).
  query<R extends QueryResultRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.current.query<R>(text, params as unknown[] | undefined);
  }
  connect(): Promise<PoolClient> {
    return this.current.connect();
  }
  async end(): Promise<void> {
    await this.current.end();
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** The bare database name `provisionPostgresTestDatabase` chose. */
function databaseNameFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

function urlForDatabase(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${encodeURIComponent(databaseName)}`;
  return url.toString();
}

/** PostgreSQL's maximum unquoted identifier length (`NAMEDATALEN` - 1). */
const POSTGRES_IDENTIFIER_LIMIT = 63;
const FORK_SUFFIX = "_fork";

/**
 * The forked database's name: the STEM truncated to leave room for
 * `FORK_SUFFIX`, then the suffix appended. Truncating the already-suffixed
 * string instead (`` `${isolatedDatabase}${FORK_SUFFIX}`.slice(0, LIMIT) ``)
 * can chop the suffix off entirely and collapse the result onto
 * `isolatedDatabase` when the stem is within `FORK_SUFFIX.length` of the
 * limit — the DROP below would then target the suite's own live database.
 */
function forkedDatabaseNameFor(isolatedDatabase: string): string {
  return `${isolatedDatabase.slice(0, POSTGRES_IDENTIFIER_LIMIT - FORK_SUFFIX.length)}${FORK_SUFFIX}`;
}

it("forkedDatabaseNameFor never collapses onto its stem, even at the identifier limit", () => {
  const maximalStem = "a".repeat(POSTGRES_IDENTIFIER_LIMIT);
  const forked = forkedDatabaseNameFor(maximalStem);
  expect(forked).not.toBe(maximalStem);
  expect(forked.length).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_LIMIT);
  expect(forked.endsWith(FORK_SUFFIX)).toBe(true);
});

/**
 * Budget for this suite's host-level DDL hooks.
 *
 * `DROP DATABASE` forces an IMMEDIATE cluster-wide checkpoint and waits for it
 * — PostgreSQL has to know the checkpointer has forgotten the dropped
 * database's sync requests before the files go away — so how long it takes is
 * set by how much every OTHER suite in the lane has written since the last
 * checkpoint, not by the size of the database being dropped. Measured on the
 * PostgreSQL 18 lane server mid-run: 13.7 s to drop a 7 MB database freshly
 * copied from a template, of which 12.3 s was that checkpoint's fsync phase
 * (`pg_stat_checkpointer.sync_time` rose by 12,253 ms and `num_requested` by
 * one), against 0.6 s for the next DROP moments later with the cluster already
 * flushed, and 0.1 s for the same DROP on an idle server.
 *
 * That is why both drops live in `beforeAll`/`afterAll` under this budget and
 * NOT in the test body: the body measures the fork mechanism — `CREATE
 * DATABASE ... TEMPLATE`, which costs 43-73 ms on the same loaded server — and
 * a cluster-wide fsync is no part of it. Budgeting the test body instead would
 * only move the same unbounded wait behind a larger number.
 */
const HOST_DDL_TIMEOUT_MS = 120_000;

const ISOLATED_DATABASE = databaseNameFromUrl(TEST_DATABASE_URL);

/**
 * The database `branch()`'s `CREATE DATABASE ... TEMPLATE` produces and both of
 * this suite's drops target. Guarded here rather than only inside
 * `forkedDatabaseNameFor`'s own unit test above: this is the CONCRETE name a
 * `DROP DATABASE` is about to be issued against, and if it ever collapsed onto
 * the suite's own live database the drop would take that with it. A guard, not
 * an `expect`, because it protects the statement rather than reporting on it.
 */
const FORKED_DATABASE = forkedDatabaseNameFor(ISOLATED_DATABASE);
if (FORKED_DATABASE === ISOLATED_DATABASE)
  throw new Error(
    `forkedDatabaseNameFor collapsed onto "${ISOLATED_DATABASE}" — refusing to ` +
      `drop this suite's own database`,
  );

/**
 * `POSTGRES_URL` is read lazily: a skipped suite's body is still collected, so
 * nothing outside a hook or a test may require it.
 */
async function withAdmin<T>(fn: (admin: Pool) => Promise<T>): Promise<T> {
  const configuredUrl = process.env["POSTGRES_URL"];
  if (configuredUrl === undefined) throw new Error("unreachable");
  const admin = new Pool({ connectionString: configuredUrl, max: 1 });
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

async function forkedDatabaseExists(): Promise<boolean> {
  return await withAdmin(async (admin) => {
    const found = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [FORKED_DATABASE],
    );
    return found.rowCount === 1;
  });
}

async function dropForkedDatabase(): Promise<void> {
  await withAdmin(async (admin) => {
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(FORKED_DATABASE)} WITH (FORCE)`,
    );
  });
}

describe.runIf(process.env["POSTGRES_URL"])(
  "forkedWorkingCopyStrategy [postgres, CREATE DATABASE ... TEMPLATE]",
  () => {
    let forkBranch: GraphBranch<G> | undefined;
    let basePool: SwappablePool | undefined;

    // Residue from an earlier run of this suite — a crash between the copy and
    // the teardown leaves the forked database behind. Clearing it is harness
    // setup, not part of the fork mechanism, so it runs here under the
    // host-DDL budget rather than inside the timed test body.
    beforeAll(async () => {
      await dropForkedDatabase();
    }, HOST_DDL_TIMEOUT_MS);

    // `close()` is what runs the fork handle's `dispose`, i.e. the DROP that
    // releases the forked database, so it is teardown and carries the host-DDL
    // budget. The surviving-database check keeps `dispose` PROVEN rather than
    // merely invoked; it throws instead of asserting because `expect` outside a
    // test block reports nothing useful when it fails in a hook.
    afterAll(async () => {
      await forkBranch?.close();
      await basePool?.end();
      if (await forkedDatabaseExists())
        throw new Error(
          `close() did not run the fork handle's dispose: "${FORKED_DATABASE}" survived`,
        );
    }, HOST_DDL_TIMEOUT_MS);

    it("forks the base database by template, merges a fork write back to the base", async () => {
      const swappablePool = new SwappablePool(
        new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }),
      );
      basePool = swappablePool;
      // Cast: SwappablePool duck-types the subset of `Pool` Drizzle's
      // node-postgres driver actually calls (see the class doc comment).
      const baseDb = drizzle(
        swappablePool as unknown as Pool,
      ) as NodePgDatabase;
      const baseBackend = createPostgresBackend(baseDb);
      const [baseStore] = await createStoreWithSchema(graph, baseBackend);
      const widget = await baseStore.nodes.Widget.create({ name: "Original" });

      type PgTemplateFork = ForkHandle & Readonly<{ database: string }>;

      const strategy = forkedWorkingCopyStrategy<G, PgTemplateFork>({
        fork: async () => {
          // No other session — active or idle-in-pool — may be connected to
          // the template database while it is copied. The forked database
          // itself cannot already exist: `beforeAll` dropped any residue.
          await swappablePool.current.end();
          await withAdmin(async (admin) => {
            await admin.query(
              `CREATE DATABASE ${quoteIdentifier(FORKED_DATABASE)} TEMPLATE ${quoteIdentifier(ISOLATED_DATABASE)}`,
            );
          });
          // Reconnect the base's pool now that the template copy is done —
          // `baseStore` keeps working, unchanged, for the rest of the test.
          swappablePool.current = new Pool({
            connectionString: TEST_DATABASE_URL,
            max: 1,
          });
          return { database: FORKED_DATABASE, dispose: dropForkedDatabase };
        },
        connect: (fork) => {
          const pool = new Pool({
            connectionString: urlForDatabase(TEST_DATABASE_URL, fork.database),
            max: 1,
          });
          const forkBackend = createPostgresBackend(drizzle(pool));
          return Promise.resolve(
            wrapWithManagedClose(forkBackend, async () => {
              await pool.end();
            }),
          );
        },
      });

      const branchResult = await branch<G>(
        baseStore,
        rejectMakeBackend,
        undefined,
        strategy,
      );
      expect(isOk(branchResult)).toBe(true);
      const forked = unwrap(branchResult);
      forkBranch = forked;
      // The host-level copy really happened — `afterAll` proves `dispose`
      // removes this same database again.
      expect(await forkedDatabaseExists()).toBe(true);

      await forked.store.nodes.Widget.update(widget.id, {
        name: "Forked Edit",
      });

      // The base is unaffected before the merge commits.
      const beforeCommit = await baseStore.nodes.Widget.getById(widget.id);
      expect(beforeCommit?.name).toBe("Original");

      const mergeResult = await merge<G>(baseStore, [forked], {});
      expect(isOk(mergeResult)).toBe(true);

      // The base sees the fork's write after commit.
      const afterCommit = await baseStore.nodes.Widget.getById(widget.id);
      expect(afterCommit?.name).toBe("Forked Edit");
    });
  },
);
