/**
 * A schema commit refuses a database whose base schema is behind this
 * release. A plain `createStore` attach adopts nothing, so without this an
 * upgraded application could commit a schema document through `evolve()` or
 * `withEvolvedTransaction()` onto a database an earlier release still opens,
 * and that release could not parse the document. The refusal is
 * `BaseSchemaMigrationError`, before anything is written; once the database
 * adopts the current base schema the same commit succeeds.
 *
 * Load-bearing: dropping the `assertBaseSchemaCurrent` call from the
 * schema-version members (`schema-version-members.ts`) lets the `evolve()`
 * case commit, and dropping it from the SQLite schema-write adoption
 * (`adoptSchemaWriteTransaction` in `sqlite.ts`) lets the evolved-transaction
 * case run its callback.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStore,
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
} from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { BaseSchemaMigrationError } from "../src/errors";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "schema_commit_base_schema",
  nodes: { Person: { type: Person } },
  edges: {},
});

const petExtension = defineGraphExtension({
  nodes: { Pet: { properties: { name: { type: "string" } } } },
});

const EARLIER_BASE_SCHEMA_VERSION = 5;

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  return (result.db as unknown as { $client: Database.Database }).$client;
}

/** A database this release provisioned, stamped back to an earlier release's version. */
async function databaseStampedEarlier(): Promise<LocalSqliteBackendResult> {
  const result = createLocalSqliteBackend();
  await createStoreWithSchema(graph, result.backend);
  rawClient(result)
    .prepare("UPDATE typegraph_base_schema_versions SET version = ?")
    .run(EARLIER_BASE_SCHEMA_VERSION);
  return result;
}

describe("a schema commit on a database whose base schema is behind", () => {
  it("refuses evolve() before writing, and commits once the base schema is adopted", async () => {
    const result = await databaseStampedEarlier();
    try {
      const store = createStore(graph, result.backend);
      const before = await result.backend.getActiveSchema(graph.id);

      const refusal = await store
        .evolve(petExtension)
        .catch((error: unknown) => error);
      console.info("stale base-schema evolve refusal", refusal);
      expect(refusal).toBeInstanceOf(BaseSchemaMigrationError);
      expect((refusal as BaseSchemaMigrationError).details).toMatchObject({
        installedVersion: EARLIER_BASE_SCHEMA_VERSION,
        reason: "stale",
      });
      const after = await result.backend.getActiveSchema(graph.id);
      expect(after?.version).toBe(before?.version);

      await result.backend.adoptBaseSchema?.();
      const evolved = await store.evolve(petExtension);
      const adopted = await result.backend.getActiveSchema(graph.id);
      expect(adopted?.version).toBe((before?.version ?? 0) + 1);
      expect(evolved).toBeDefined();
    } finally {
      await result.backend.close();
    }
  });

  it("refuses withEvolvedTransaction() before its callback runs", async () => {
    const result = await databaseStampedEarlier();
    try {
      const store = createAdapterStore(graph, result.backend);
      const plan = await store.planEvolution(petExtension);
      const before = await result.backend.getActiveSchema(graph.id);

      let callbackRan = false;
      const refusal = await result.backend
        .transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async () => {
            callbackRan = true;
            await Promise.resolve();
          }),
        )
        .catch((error: unknown) => error);
      console.info("stale base-schema evolved-transaction refusal", refusal);
      expect(refusal).toBeInstanceOf(BaseSchemaMigrationError);
      expect(callbackRan).toBe(false);
      const after = await result.backend.getActiveSchema(graph.id);
      expect(after?.version).toBe(before?.version);
    } finally {
      await result.backend.close();
    }
  });
});
