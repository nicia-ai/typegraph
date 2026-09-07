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
 * the same "suspend hazard" the forked-working-copy design documents for a
 * host that drops sessions on idle-compute suspend: whatever is memoized on a
 * live connection does not survive a suspend, so only the write fence and the
 * lock memo — which re-acquire per transaction — may be relied on across one.
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
import { storeBackend } from "../../../src/store/runtime-port";
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

describe.runIf(process.env["POSTGRES_URL"])(
  "forkedWorkingCopyStrategy [postgres, CREATE DATABASE ... TEMPLATE]",
  () => {
    it("forks the base database by template, merges a fork write back to the base", async () => {
      const configuredUrl = process.env["POSTGRES_URL"];
      if (configuredUrl === undefined) throw new Error("unreachable");
      const isolatedDatabase = databaseNameFromUrl(TEST_DATABASE_URL);
      const forkedDatabase = `${isolatedDatabase}_fork`.slice(0, 63);

      async function withAdmin<T>(fn: (admin: Pool) => Promise<T>): Promise<T> {
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
      const widget = await baseStore.nodes.Widget.create({ name: "Original" });

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

      await storeBackend(forkBranch.store).close();
      await swappablePool.current.end();
    });
  },
);
