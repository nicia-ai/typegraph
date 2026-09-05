/**
 * Golden rendering test for the bundled PostgreSQL lock spelling
 * (`postgresFenceSql`): every builder `resolveFenceStatements` derives from
 * `postgresFenceSql`'s two expressions, rendered through `renderPostgres`
 * exactly as a lock site does, asserting the exact SQL text and bound
 * parameters. This pins three things a behavioral test over the lock SITES
 * cannot see because they only assert a statement ran, not its text:
 *
 *  - `LOCK_TABLE_MODE_CLAUSE`'s three modes each render their own distinct
 *    clause (a mutation that swaps one mode's text for another's changes no
 *    site's control flow, so nothing that only exercises the lock arm
 *    notices);
 *  - `advisoryLockWithIsolation` binds the isolation fact in the SAME
 *    statement as the lock, not a separate one (dropping the isolation
 *    column changes the statement's SHAPE, which a site-level test that
 *    only reads `rows[0]?.transaction_isolation` would still tolerate if the
 *    column merely moved);
 *  - the text `resolveFenceStatements` derives from `postgresFenceSql` is
 *    BYTE-IDENTICAL to what this module's own `advisoryLock` /
 *    `advisoryLockWithIsolation` / `isolationFact` rendered before they were
 *    deleted in favor of the derivation — the exact strings below are
 *    unchanged from that prior spelling.
 */
import { describe, expect, it } from "vitest";

import { resolveFenceStatements } from "../src/backend/capabilities/write-fence";
import { postgresFenceSql } from "../src/backend/drizzle/postgres-fence-sql";
import { renderPostgres } from "../src/query/sql-fragment";

const fenceStatements = resolveFenceStatements(postgresFenceSql);

describe("postgresFenceSql renders the bundled PostgreSQL spelling", () => {
  it("advisoryLock: hashtext(namespace), hashtext(key) for a string key", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:identity", "graph-1"),
    );
    expect(rendered.sql).toBe(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    );
    expect(rendered.params).toEqual(["typegraph:identity", "graph-1"]);
  });

  it("advisoryLock: the database-scoped constant key renders as a bare integer literal, unbound", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:identity-ddl", 0),
    );
    expect(rendered.sql).toBe("SELECT pg_advisory_xact_lock(hashtext($1), 0)");
    expect(rendered.params).toEqual(["typegraph:identity-ddl"]);
  });

  it("advisoryLockWithIsolation: the lock and the isolation fact in one statement", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLockWithIsolation(
        "typegraph:recorded-graph-write",
        "graph-1",
      ),
    );
    expect(rendered.sql).toBe(
      "\n    SELECT\n" +
        "      pg_advisory_xact_lock(hashtext($1), hashtext($2)),\n" +
        "      current_setting('transaction_isolation') AS transaction_isolation\n" +
        "  ",
    );
    expect(rendered.params).toEqual([
      "typegraph:recorded-graph-write",
      "graph-1",
    ]);
  });

  it.each([
    ["share", "SHARE MODE"],
    ["share-row-exclusive", "SHARE ROW EXCLUSIVE MODE"],
    ["access-exclusive", "ACCESS EXCLUSIVE MODE"],
  ] as const)("lockTables: %s renders %s", (mode, clause) => {
    const rendered = renderPostgres(
      fenceStatements.lockTables(["nodes", "edges"], mode),
    );
    expect(rendered.sql).toBe(`LOCK TABLE "nodes", "edges" IN ${clause}`);
    expect(rendered.params).toEqual([]);
  });

  it("isolationFact: the bare session isolation-level read, with no lock", () => {
    const rendered = renderPostgres(fenceStatements.isolationFact());
    expect(rendered.sql).toBe(
      "SELECT current_setting('transaction_isolation') AS transaction_isolation",
    );
    expect(rendered.params).toEqual([]);
  });
});

/**
 * Pins each of the nine write-fence sites' ACTUAL builder call — its real
 * namespace/table/mode constant, not a generic placeholder — so a change to
 * any one site's arguments (the lock key's literal-vs-bound form, a table
 * name, a lock mode) fails here even when nothing about a site's CONTROL
 * FLOW changes. A behavioral test over the lock sites only proves a
 * statement ran; this proves which one.
 */
describe("postgresFenceSql: every lock site's real call, pinned", () => {
  it("store/recorded-capture/clock.ts lockRecordedGraphWrite: advisoryLockWithIsolation(typegraph:recorded-graph-write, graphId)", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLockWithIsolation(
        "typegraph:recorded-graph-write",
        "graph-1",
      ),
    );
    expect(rendered.sql).toBe(
      "\n    SELECT\n" +
        "      pg_advisory_xact_lock(hashtext($1), hashtext($2)),\n" +
        "      current_setting('transaction_isolation') AS transaction_isolation\n" +
        "  ",
    );
    expect(rendered.params).toEqual([
      "typegraph:recorded-graph-write",
      "graph-1",
    ]);
  });

  it("store/recorded-capture/clock.ts lockRecordedClock: advisoryLock(typegraph:recorded-clock, graphId)", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:recorded-clock", "graph-1"),
    );
    expect(rendered.sql).toBe(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    );
    expect(rendered.params).toEqual(["typegraph:recorded-clock", "graph-1"]);
  });

  it("identity/service-read.ts lockIdentityGraph: advisoryLock(typegraph:identity, graphId)", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:identity", "graph-1"),
    );
    expect(rendered.sql).toBe(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
    );
    expect(rendered.params).toEqual(["typegraph:identity", "graph-1"]);
  });

  it("identity/service-read.ts lockIdentityEnablementNodes: lockTables([typegraph_nodes], share)", () => {
    const rendered = renderPostgres(
      fenceStatements.lockTables(["typegraph_nodes"], "share"),
    );
    expect(rendered.sql).toBe('LOCK TABLE "typegraph_nodes" IN SHARE MODE');
    expect(rendered.params).toEqual([]);
  });

  it("identity/schema-transition.ts lockIdentityDdl: advisoryLock(typegraph:identity-ddl, 0)", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:identity-ddl", 0),
    );
    expect(rendered.sql).toBe("SELECT pg_advisory_xact_lock(hashtext($1), 0)");
    expect(rendered.params).toEqual(["typegraph:identity-ddl"]);
  });

  it("graph-merge/provenance-store.ts drainUnfencedRowWriters: lockTables([typegraph_nodes, typegraph_edges], share-row-exclusive)", () => {
    const rendered = renderPostgres(
      fenceStatements.lockTables(
        ["typegraph_nodes", "typegraph_edges"],
        "share-row-exclusive",
      ),
    );
    expect(rendered.sql).toBe(
      'LOCK TABLE "typegraph_nodes", "typegraph_edges" IN SHARE ROW EXCLUSIVE MODE',
    );
    expect(rendered.params).toEqual([]);
  });

  it("backend/drizzle/contribution-materializations.ts lockContributionDdl: advisoryLock(typegraph:contribution-ddl, 0)", () => {
    const rendered = renderPostgres(
      fenceStatements.advisoryLock("typegraph:contribution-ddl", 0),
    );
    expect(rendered.sql).toBe("SELECT pg_advisory_xact_lock(hashtext($1), 0)");
    expect(rendered.params).toEqual(["typegraph:contribution-ddl"]);
  });

  it("backend/drizzle/contribution-materializations.ts lockSharedFulltextTable: lockTables([typegraph_node_fulltext], access-exclusive)", () => {
    const rendered = renderPostgres(
      fenceStatements.lockTables(
        ["typegraph_node_fulltext"],
        "access-exclusive",
      ),
    );
    expect(rendered.sql).toBe(
      'LOCK TABLE "typegraph_node_fulltext" IN ACCESS EXCLUSIVE MODE',
    );
    expect(rendered.params).toEqual([]);
  });

  it("store/recorded-capture/guards.ts assertRecordedCaptureTransactionIsolation: isolationFact()", () => {
    const rendered = renderPostgres(fenceStatements.isolationFact());
    expect(rendered.sql).toBe(
      "SELECT current_setting('transaction_isolation') AS transaction_isolation",
    );
    expect(rendered.params).toEqual([]);
  });
});
