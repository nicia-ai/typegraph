/**
 * `createVerifiedStore` must reject a materialized identity closure that has
 * drifted from the current assertions.
 *
 * `validateIdentity` used to validate only the assertions/disjointness over
 * freshly computed components — it never read the closure table — so a
 * corrupted or stale closure (the relation every current identity read depends
 * on) passed the startup gate unnoticed. The fix recomputes the canonical
 * closure through the engine's rebuild inside a rolled-back transaction and
 * compares it against the persisted rows.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  createVerifiedStore,
  defineGraph,
  defineNode,
  rebuildIdentityClosure,
} from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { matchingObject } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const graph = defineGraph({
  id: "identity_closure_validation",
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

const schemaContradiction: unknown = expect.objectContaining({
  name: "ConfigurationError",
  details: matchingObject({ code: "IDENTITY_SCHEMA_CONTRADICTION" }),
});

describe("identity closure validation on createVerifiedStore", () => {
  it("rejects a corrupted closure and accepts it once rebuilt", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, result.backend);
      const person = await store.nodes.Person.create({ name: "Alice" });
      const author = await store.nodes.Author.create({ penName: "A." });
      await store.identity.assertSame(person, author);

      // Sanity: the closure genuinely holds the folded class before corruption.
      const rowsBefore = rawClient(result)
        .prepare("SELECT COUNT(*) AS n FROM typegraph_identity_closure")
        .get() as { n: number };
      expect(rowsBefore.n).toBeGreaterThan(0);

      // A verified store opens cleanly while the closure is consistent.
      await expect(
        createVerifiedStore(graph, result.backend),
      ).resolves.toBeDefined();

      // Corrupt the closure: flip every class label so it no longer matches
      // the canonical (code-point-min) member the assertions imply.
      rawClient(result).exec(
        "UPDATE typegraph_identity_closure SET class_id = class_id || '_corrupt'",
      );

      await expect(createVerifiedStore(graph, result.backend)).rejects.toThrow(
        schemaContradiction,
      );

      // Repairing the closure restores a clean verified open.
      const repairStore = createStore(graph, result.backend);
      await rebuildIdentityClosure(repairStore);

      await expect(
        createVerifiedStore(graph, result.backend),
      ).resolves.toBeDefined();
    } finally {
      await result.backend.close();
    }
  });
});
