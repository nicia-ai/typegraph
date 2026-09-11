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
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../../src";
import { wrapWithManagedClose } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { branch } from "../../../src/graph-merge/branch";
import { merge } from "../../../src/graph-merge/merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
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

/**
 * How long to wait for the template database's last session to be reaped.
 *
 * `pg.Pool.end()` resolves when the client sockets are closed; the server-side
 * backends exit independently and, on a loaded machine, a little later.
 * `CREATE DATABASE ... TEMPLATE` refuses to copy a database that any other
 * session is connected to, and its own tolerance for this is a FIXED
 * five-second poll (`CountOtherDBBackends`) after which it fails with
 * SQLSTATE 55006 — measured directly against the server: holding one idle
 * connection open makes the statement stall 5122 ms and then error.
 *
 * So the interval between `end()` resolving and the backend exiting is a race
 * this suite would otherwise run against a deadline it does not control, with
 * a hard failure rather than a slow one on the losing side. Waiting for the
 * observable condition instead makes the fork deterministic, costs nothing
 * when the reap is prompt (the normal case), and outlasts PostgreSQL's own
 * five seconds when the machine is busy.
 */
const TEMPLATE_DRAIN_TIMEOUT_MS = 30_000;
const TEMPLATE_DRAIN_POLL_MS = 25;

/**
 * Resolves once no session other than this one is connected to `database`.
 *
 * Fails by naming the sessions that would not leave, which is the diagnosis
 * PostgreSQL's own "is being accessed by other users" withholds.
 */
async function waitForNoOtherSessions(
  admin: Pool,
  database: string,
  timeoutMs: number = TEMPLATE_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await admin.query<{
      pid: number;
      application_name: string;
      state: string;
    }>(
      `SELECT pid, application_name, state
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    if (rows.length === 0) return;
    if (Date.now() >= deadline) {
      const holders = rows
        .map(
          (row) =>
            `pid ${row.pid} (${row.application_name || "?"}, ${row.state})`,
        )
        .join(", ");
      throw new Error(
        `Sessions still connected to template database "${database}" after ` +
          `${timeoutMs} ms: ${holders}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TEMPLATE_DRAIN_POLL_MS));
  }
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

describe.runIf(process.env["POSTGRES_URL"])(
  "forkedWorkingCopyStrategy [postgres, CREATE DATABASE ... TEMPLATE]",
  () => {
    /**
     * A budget sized for HOST latency, not for TypeGraph work (#655).
     *
     * The measured costs here are small — an 8.7 MB template copies in ~11 ms
     * idle and ~130 ms under saturating concurrent write load — so the copy
     * itself was never what pushed this past the project's 15 s default. What
     * scales with how busy the machine is, is the waiting: `DROP DATABASE ...
     * WITH (FORCE)` terminates and reaps the fork's backends, and the copy
     * waits on the template's. This suite is the only one in the default
     * project that asks the server to do either, so it gets the same 60 s
     * allowance the other host-lifecycle projects (`pglite`, `graph-merge`)
     * already give themselves, for the same reason: normal provisioning
     * latency must not report as a correctness failure.
     */
    const FORK_TEST_TIMEOUT_MS = 60_000;

    /**
     * The drain is the difference between a deterministic fork and a race
     * against PostgreSQL's own five-second poll, so it is asserted directly:
     * a helper that returned immediately would resolve here instead of
     * reporting the session that is still attached.
     */
    it("waits for the template's other sessions, and names them if they stay", async () => {
      const configuredUrl = process.env["POSTGRES_URL"];
      if (configuredUrl === undefined) throw new Error("unreachable");
      const isolatedDatabase = databaseNameFromUrl(TEST_DATABASE_URL);
      const admin = new Pool({ connectionString: configuredUrl, max: 1 });
      const lingering = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 1,
        application_name: "lingering-template-session",
      });
      // `pg.Pool.end()` refuses a second call, and the happy path below ends
      // this pool mid-test, so the cleanup tracks whether it still owns it.
      let lingeringOpen = true;
      async function endLingering(): Promise<void> {
        if (!lingeringOpen) return;
        lingeringOpen = false;
        await lingering.end();
      }
      try {
        await lingering.query("SELECT 1");
        await expect(
          waitForNoOtherSessions(admin, isolatedDatabase, 250),
        ).rejects.toThrow(/lingering-template-session/);

        await endLingering();
        // Now it resolves — within PostgreSQL's own tolerance, without having
        // spent it.
        await expect(
          waitForNoOtherSessions(admin, isolatedDatabase, 5000),
        ).resolves.toBeUndefined();
      } finally {
        await endLingering();
        await admin.end();
      }
    });

    it(
      "forks the base database by template, merges a fork write back to the base",
      async () => {
        const configuredUrl = process.env["POSTGRES_URL"];
        if (configuredUrl === undefined) throw new Error("unreachable");
        const isolatedDatabase = databaseNameFromUrl(TEST_DATABASE_URL);
        // `branch()`'s own DROP/CREATE DATABASE ... TEMPLATE calls target this
        // name — assert it before any DROP runs, not only inside
        // `forkedDatabaseNameFor`'s own unit test above.
        const forkedDatabase = forkedDatabaseNameFor(isolatedDatabase);
        expect(forkedDatabase).not.toBe(isolatedDatabase);

        async function withAdmin<T>(
          fn: (admin: Pool) => Promise<T>,
        ): Promise<T> {
          const admin = new Pool({ connectionString: configuredUrl, max: 1 });
          try {
            return await fn(admin);
          } finally {
            await admin.end();
          }
        }

        const swappablePool = new SwappablePool(
          new Pool({ connectionString: TEST_DATABASE_URL, max: 1 }),
        );
        // Cast: SwappablePool duck-types the subset of `Pool` Drizzle's
        // node-postgres driver actually calls (see the class doc comment).
        const baseDb = drizzle(
          swappablePool as unknown as Pool,
        ) as NodePgDatabase;
        const baseBackend = createPostgresBackend(baseDb);
        const [baseStore] = await createStoreWithSchema(graph, baseBackend);
        const widget = await baseStore.nodes.Widget.create({
          name: "Original",
        });

        type PgTemplateFork = ForkHandle & Readonly<{ database: string }>;

        const strategy = forkedWorkingCopyStrategy<G, PgTemplateFork>({
          fork: async () => {
            // No other session — active or idle-in-pool — may be connected to
            // the template database while it is copied.
            await swappablePool.current.end();
            await withAdmin(async (admin) => {
              await admin.query(
                `DROP DATABASE IF EXISTS ${quoteIdentifier(forkedDatabase)} WITH (FORCE)`,
              );
              // `end()` above closed the sockets; wait for the server to finish
              // reaping the backends before asking it to copy the database they
              // were attached to (see TEMPLATE_DRAIN_TIMEOUT_MS).
              await waitForNoOtherSessions(admin, isolatedDatabase);
              await admin.query(
                `CREATE DATABASE ${quoteIdentifier(forkedDatabase)} TEMPLATE ${quoteIdentifier(isolatedDatabase)}`,
              );
            });
            // Reconnect the base's pool now that the template copy is done —
            // `baseStore` keeps working, unchanged, for the rest of the test.
            swappablePool.current = new Pool({
              connectionString: TEST_DATABASE_URL,
              max: 1,
            });
            return {
              database: forkedDatabase,
              dispose: async () => {
                await withAdmin(async (admin) => {
                  await admin.query(
                    `DROP DATABASE IF EXISTS ${quoteIdentifier(forkedDatabase)} WITH (FORCE)`,
                  );
                });
              },
            };
          },
          connect: (fork) => {
            const pool = new Pool({
              connectionString: urlForDatabase(
                TEST_DATABASE_URL,
                fork.database,
              ),
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
        const forkBranch = unwrap(branchResult);

        await forkBranch.store.nodes.Widget.update(widget.id, {
          name: "Forked Edit",
        });

        // The base is unaffected before the merge commits.
        const beforeCommit = await baseStore.nodes.Widget.getById(widget.id);
        expect(beforeCommit?.name).toBe("Original");

        const mergeResult = await merge<G>(baseStore, [forkBranch], {});
        expect(isOk(mergeResult)).toBe(true);

        // The base sees the fork's write after commit.
        const afterCommit = await baseStore.nodes.Widget.getById(widget.id);
        expect(afterCommit?.name).toBe("Forked Edit");

        await forkBranch.close();
        await swappablePool.current.end();
      },
      FORK_TEST_TIMEOUT_MS,
    );
  },
);
