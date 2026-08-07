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

import { defineGraph, defineNode } from "../src";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "pglite_identity_upgrade",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const SEPARATION_TABLE = "typegraph_identity_separation";

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
});
