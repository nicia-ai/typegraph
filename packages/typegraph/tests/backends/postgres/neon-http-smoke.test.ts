/**
 * Neon HTTP smoke test.
 *
 * `@neondatabase/serverless`'s `neon(url)` HTTP-only driver works in
 * Cloudflare Workers and serves a real production deployment (Nicia).
 * Distinct from the WebSocket `Pool` (covered in
 * `neon-serverless-smoke.test.ts`), the HTTP driver:
 *
 *   - Cannot hold a session across statements, so multi-statement
 *     transactions are unavailable.
 *   - Has a `.unsafe()` that builds SQL fragments rather than executing
 *     queries, and a `.query()` that doesn't accept the
 *     `{name, text, values}` config object form. The fast path can't
 *     drive it; we route through `db.execute` (Drizzle's neon-http
 *     session) instead.
 *
 * This test verifies:
 *
 *   1. Driver detection identifies neon-http (callable + `.transaction`,
 *      no `.begin`) and skips the broken pg fast path.
 *   2. `capabilities.transactions` is auto-set to `false` so callers'
 *      transaction-aware code paths fall through to non-transactional
 *      execution rather than throwing.
 *   3. The explicit `capabilities` override option still wins over the
 *      auto-detection so users can opt back in (or further constrain).
 */
import { neon } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { describe, expect, it } from "vitest";

import { createPostgresBackend } from "../../../src/backend/postgres";

describe("@nicia-ai/typegraph/postgres on @neondatabase/serverless (HTTP)", () => {
  it("auto-disables transactions when neon-http is detected", () => {
    // `neon()` doesn't validate the URL until the first request, so we
    // can construct it safely. We never run a query, so no HTTP traffic
    // happens.
    const sql = neon("postgresql://test:test@invalid.neon.tech/test");
    const db = drizzleNeonHttp({ client: sql });

    const backend = createPostgresBackend(db);

    expect(backend.dialect).toBe("postgres");
    // The headline behavior: HTTP can't hold a session, so transactions
    // are off. Callers like `setActiveSchema` and `store.transaction`
    // check this capability and fall through to sequential execution
    // when it's false.
    expect(backend.capabilities.transactions).toBe(false);
    // Other capabilities are unchanged.
    expect(backend.capabilities.cte).toBe(true);
    expect(backend.capabilities.jsonb).toBe(true);
    expect(backend.capabilities.vector?.supported).toBe(true);
  });

  it("does not expose the executeRaw fast path for neon-http", () => {
    // The fast path's prepared-statement `.query({name, text, values})`
    // form is incompatible with neon-http. By skipping it, we route
    // every query through Drizzle's neon-http session, which uses the
    // correct HTTP request shape. `executeRaw` should be undefined,
    // signaling to higher layers (like PreparedQuery) to use the slow
    // path.
    const sql = neon("postgresql://test:test@invalid.neon.tech/test");
    const db = drizzleNeonHttp({ client: sql });
    const backend = createPostgresBackend(db);

    expect(backend.executeRaw).toBeUndefined();
    // `execute` is always defined; it routes through db.execute for
    // neon-http.
    expect(typeof backend.execute).toBe("function");
  });

  it("respects an explicit capabilities override", () => {
    // The auto-detection sets `transactions: false`, but if the user
    // explicitly opts back in (e.g. via a wsproxy that does support
    // sessions, or for testing), the override wins.
    const sql = neon("postgresql://test:test@invalid.neon.tech/test");
    const db = drizzleNeonHttp({ client: sql });
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: true },
    });

    expect(backend.capabilities.transactions).toBe(true);
  });
});
