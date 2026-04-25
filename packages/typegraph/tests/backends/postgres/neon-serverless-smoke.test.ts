/**
 * Neon serverless smoke test.
 *
 * @neondatabase/serverless drives PostgreSQL over WebSockets, which is
 * the only transport that works on Cloudflare Workers / Vercel Edge /
 * Netlify Edge — runtimes without raw TCP sockets. We can't reach a
 * real Neon database from CI without a live account, and we can't
 * easily emulate the WebSocket protocol locally, so this test instead
 * verifies the *integration shape*:
 *
 *   1. The `drizzle-orm/neon-serverless` package + `Pool` from
 *      `@neondatabase/serverless` import without error (i.e. the path
 *      we advertise in our docs is reachable from this codebase).
 *   2. `createPostgresBackend` accepts a Drizzle db wrapped around the
 *      Neon `Pool`, with no Node-only module imports failing.
 *   3. The execution adapter's driver detection routes Neon's
 *      pg-Pool-compatible `$client` through the wrapped node-postgres
 *      fast path (named server-side prepared statements + Date→string
 *      row normalization).
 *   4. The resulting backend has the expected GraphBackend interface.
 *
 * That's enough to catch a refactor that would, e.g., introduce a
 * static `node:` import that crashes in edge runtimes — which is what
 * the original P1 review item was about.
 */
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { describe, expect, it, vi } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";

describe("@nicia-ai/typegraph/postgres on @neondatabase/serverless", () => {
  it("wires drizzle-orm/neon-serverless through createPostgresBackend", () => {
    // Construct a Neon Pool. We never .connect() so no WebSocket
    // attempt happens; we just verify the constructor runs and the
    // resulting db has the shape our adapter expects.
    const pool = new NeonPool({
      connectionString: "postgresql://test:test@invalid.neon.tech/test",
    });
    const db = drizzleNeon(pool);

    const backend = createPostgresBackend(db);

    expect(backend.dialect).toBe("postgres");
    expect(backend.capabilities.cte).toBe(true);
    expect(backend.capabilities.jsonb).toBe(true);
    // Vector / pgvector capability is declared at backend-construction
    // time and doesn't depend on a live connection. It's the same on
    // every PostgreSQL driver we support.
    expect(backend.capabilities.vector?.supported).toBe(true);
    expect(backend.tableNames?.nodes).toBe("typegraph_nodes");

    // Sanity: the fast path execute / prepare functions exist
    // (i.e. driver detection succeeded). Under the hood this means
    // the Neon `Pool.query({name, text, values})` shape is being
    // routed through `wrapNodePgClient`.
    expect(typeof backend.execute).toBe("function");
    expect(typeof backend.executeRaw).toBe("function");
    expect(typeof backend.refreshStatistics).toBe("function");
  });

  it("invokes neon Pool.query via the named-statement fast path", async () => {
    // Replace the Pool's query method with a spy so we can observe
    // exactly what shape the adapter sends. This confirms the
    // server-side prepared-statement payload reaches the driver
    // (named, with text + values), which is the perf-relevant
    // optimization documented in this release.
    const queryRows = [{ result: 1 }];
    const queryFunction = vi.fn().mockResolvedValue({ rows: queryRows });

    const pool = new NeonPool({
      connectionString: "postgresql://test:test@invalid.neon.tech/test",
    }) as unknown as { query: typeof queryFunction };
    pool.query = queryFunction;

    const db = drizzleNeon(pool as unknown as NeonPool);
    const backend = createPostgresBackend(db);

    if (backend.executeRaw === undefined) {
      throw new Error(
        "executeRaw should be available on Neon serverless backends",
      );
    }

    const rows = await backend.executeRaw<{ result: number }>(
      "SELECT $1::int AS result",
      [1],
    );
    expect(rows).toEqual(queryRows);

    expect(queryFunction).toHaveBeenCalledTimes(1);
    expect(queryFunction).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^tg_\d+$/) as unknown,
        text: "SELECT $1::int AS result",
        values: [1],
      }),
    );
  });

  it("normalizes Date columns to ISO strings on the way out", async () => {
    // Neon (like node-postgres) returns timestamp columns as Date
    // objects by default. The adapter's row normalizer converts them
    // to ISO strings so downstream row mappers see the same shape
    // they would through Drizzle's session.
    const sampleDate = new Date("2026-04-25T12:00:00.000Z");
    const queryFunction = vi.fn().mockResolvedValue({
      rows: [{ created_at: sampleDate, name: "Alice" }],
    });
    const pool = new NeonPool({
      connectionString: "postgresql://test:test@invalid.neon.tech/test",
    }) as unknown as { query: typeof queryFunction };
    pool.query = queryFunction;

    const db = drizzleNeon(pool as unknown as NeonPool);
    const backend = createPostgresBackend(db);

    const rows = await backend.executeRaw!<{
      created_at: string;
      name: string;
    }>("SELECT created_at, name FROM t WHERE id = $1", ["x"]);

    expect(rows[0]?.created_at).toBe("2026-04-25T12:00:00.000Z");
    expect(typeof rows[0]?.created_at).toBe("string");
    expect(rows[0]?.name).toBe("Alice");
  });
});
