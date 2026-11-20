/**
 * The derived-relation upgrade path on a REAL Postgres engine.
 *
 * `store-identity-provisioning.test.ts` asserts the structure of the fix on
 * SQLite — the CREATE and the fill are one schema-write transaction. The
 * mechanism differs enough on Postgres to be worth running there too: the
 * fence is a per-graph advisory lock rather than SQLite's serialized writer,
 * the DDL travels through the transaction-scoped `executeSchemaDdl`, and
 * Postgres is the engine where a created-but-empty relation would actually be
 * visible to a second connection.
 *
 * What this guards, precisely: that the FENCED path — create through
 * `executeSchemaDdl`, fill in the same transaction, commit — actually publishes
 * a filled relation on Postgres. It is not a second proof of the ordering (the
 * old create-early/fill-late path also ends boot with the rows in place); the
 * ordering proof is the SQLite fence test.
 *
 * PGlite boots Postgres in-process, so this runs in plain `pnpm test` with no
 * Docker (same rationale as `backends/postgres/pglite-backend.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type GraphBackend } from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { type CompiledRowsSql } from "../../../src/query/sql-intent";
import { createStoreWithSchema } from "../../../src/store";
import { requireDefined } from "../../../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "pglite_identity_upgrade",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * A SECOND identity-enabled graph in the same database. The identity relations
 * are shared by both; only the rows are per graph.
 */
const otherGraph = defineGraph({
  id: "pglite_identity_upgrade_other",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const SEPARATION_TABLE = "typegraph_identity_separation";

async function separationRowCount(backend: GraphBackend): Promise<number> {
  const rows = await requireDefined(backend.executeRaw)<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM ${SEPARATION_TABLE}`,
    [],
  );
  return Number(requireDefined(rows[0]).n);
}

describe("Operational Identity derived-relation upgrade on Postgres", () => {
  it("republishes a dropped separation relation already carrying its rows", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const [seeded] = await createStoreWithSchema(graph, backend);
      const alice = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const bob = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(alice, bob);

      // A database provisioned before the separation relation existed.
      await requireDefined(backend.executeDdl)(
        `DROP TABLE ${SEPARATION_TABLE}`,
      );

      const [reopened] = await createStoreWithSchema(graph, backend);

      const rows = await requireDefined(backend.executeRaw)(
        `SELECT class_key_low, class_key_high FROM ${SEPARATION_TABLE}`,
        [],
      );
      expect(rows).toHaveLength(1);

      // The published relation reports the separation, so the fuse an empty
      // one would have allowed is refused.
      expect(await reopened.identity.areSame(alice, bob)).toBe(false);
      await expect(reopened.identity.assertSame(alice, bob)).rejects.toThrow();
    } finally {
      await backend.close();
    }
  });

  it("fills one graph's rows after another graph created the shared relation", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const [seeded] = await createStoreWithSchema(graph, backend);
      const alice = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const bob = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(alice, bob);

      // Back to the pre-upgrade shape, for BOTH graphs at once: identity DDL is
      // database-global while the assertion ledger is per graph.
      await requireDefined(backend.executeDdl)(
        `DROP TABLE ${SEPARATION_TABLE}`,
      );

      // The second graph upgrades first. It has no `different` assertion, so an
      // empty relation is its correct content — and it is now PRESENT.
      await createStoreWithSchema(otherGraph, backend);
      expect(await separationRowCount(backend)).toBe(0);

      // The first graph opens second. Under a table-existence check its fill is
      // suppressed outright — the table another graph created answers "not
      // separated" for a pair its own ledger separates, forever, because
      // nothing will ever see the table missing again.
      const [reopened] = await createStoreWithSchema(graph, backend);

      expect(await separationRowCount(backend)).toBe(1);
      expect(await reopened.identity.areDifferent(alice, bob)).toBe(true);
      await expect(reopened.identity.assertSame(alice, bob)).rejects.toThrow();
    } finally {
      await backend.close();
    }
  });

  it("serializes the fenced CREATE behind a database-scoped advisory lock", async () => {
    const { backend } = await createLocalPgliteBackend({ vector: false });
    try {
      const [seeded] = await createStoreWithSchema(graph, backend);
      const alice = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const bob = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(alice, bob);
      await requireDefined(backend.executeDdl)(
        `DROP TABLE ${SEPARATION_TABLE}`,
      );

      // The per-graph schema fence does not serialize this at all: the relation
      // is shared, the fence is not. Two graphs upgrading at once race the
      // CREATE, and on Postgres the loser gets 23505 inside a transaction that
      // cannot retry in place. The lock has to be taken INSIDE the fence and
      // BEFORE the DDL, which is what this observes.
      const fence = requireDefined(backend.schemaWriteTransaction);
      const statements: string[] = [];
      const observed: GraphBackend = deriveBackend(backend, {
        schemaWriteTransaction: <T>(
          graphId: string,
          fn: (tx: Parameters<Parameters<typeof fence>[1]>[0]) => Promise<T>,
        ): Promise<T> =>
          fence(graphId, async (target) => {
            const compileSql = requireDefined(target.compileSql);
            const executeSchemaDdl = target.executeSchemaDdl;
            return fn({
              ...target,
              execute: <R>(query: CompiledRowsSql) => {
                statements.push(compileSql(query).sql);
                return target.execute<R>(query);
              },
              executeSchemaDdl: async (ddl: string) => {
                statements.push(ddl);
                await executeSchemaDdl(ddl);
              },
            });
          }),
      });

      await createStoreWithSchema(graph, observed);

      const lockIndex = statements.findIndex((statement) =>
        statement.includes("pg_advisory_xact_lock"),
      );
      const createIndex = statements.findIndex((statement) =>
        statement.includes(`CREATE TABLE IF NOT EXISTS "${SEPARATION_TABLE}"`),
      );
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      expect(createIndex).toBeGreaterThan(lockIndex);
      expect(await separationRowCount(backend)).toBe(1);
    } finally {
      await backend.close();
    }
  });
});
