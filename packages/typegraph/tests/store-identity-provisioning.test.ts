/**
 * Provisioning + enablement-gating for Operational Identity on databases that
 * were not created with identity already present.
 *
 * Two review findings on PR #268:
 *
 *  - First enablement on an EXISTING populated deployment attaches through
 *    createStore / createSqliteBackend, which run no DDL, so the identity
 *    relations the enablement preflight reads/writes may not exist yet.
 *    `backend.ensureIdentityTables()` (called before the enablement locks)
 *    must create them idempotently, so enablement succeeds and membersOf
 *    reflects folded same-id pairs.
 *
 *  - With autoMigrate disabled, enabling identity leaves the schema "pending"
 *    WITHOUT running the enablement preflight — so returning a store would
 *    expose store.identity over an empty/unmaterialized closure. That must be
 *    refused with a typed ConfigurationError, not silently returned.
 */
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const GRAPH_ID = "identity_provisioning";

/** Identity-disabled graph — the "already deployed" shape. */
const disabledGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
});

/** Same graph with Operational Identity enabled (folds same id across kinds). */
const enabledGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const IDENTITY_TABLES = [
  "typegraph_identity_assertions",
  "typegraph_recorded_identity_assertions",
  "typegraph_identity_closure",
] as const;

function rawClient(result: LocalSqliteBackendResult): Database.Database {
  // Drizzle attaches the raw better-sqlite3 handle as `$client` at runtime;
  // the published type omits it (same access pattern as
  // refresh-statistics-scope.test.ts).
  return (result.db as unknown as { $client: Database.Database }).$client;
}

function dropIdentityTables(result: LocalSqliteBackendResult): void {
  for (const table of IDENTITY_TABLES) {
    rawClient(result).exec(`DROP TABLE IF EXISTS ${table}`);
  }
}

describe("Operational Identity provisioning + enablement gating", () => {
  it("provisions identity tables and folds same-id pairs when enabling on an existing DB", async () => {
    const result = createLocalSqliteBackend();
    try {
      // 1. Deploy the identity-disabled schema and populate a same-id pair
      //    across kinds (alice as both Person and Author).
      const [disabledStore] = await createStoreWithSchema(
        disabledGraph,
        result.backend,
      );
      await disabledStore.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      await disabledStore.nodes.Author.create(
        { penName: "A." },
        { id: "alice" },
      );

      // 2. Simulate a deployment whose identity relations were never created
      //    (bring-your-own-connection: no DDL re-run) by dropping them.
      dropIdentityTables(result);

      // 3. Reopen with the identity-enabled graph. Without ensureIdentityTables
      //    the enablement preflight would fail with a raw "no such table"
      //    error inside the schema-commit transaction.
      const [enabledStore, migration] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      expect(migration.status).toBe("migrated");

      const members = await enabledStore.identity.membersOf({
        kind: "Person",
        id: "alice",
      });
      expect(members).toEqual(
        expect.arrayContaining([
          { kind: "Person", id: "alice" },
          { kind: "Author", id: "alice" },
        ]),
      );
      expect(members).toHaveLength(2);
    } finally {
      await result.backend.close();
    }
  });

  it("refuses to open an identity store when enablement is pending (autoMigrate off)", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [disabledStore] = await createStoreWithSchema(
        disabledGraph,
        result.backend,
      );
      await disabledStore.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      await disabledStore.nodes.Author.create(
        { penName: "A." },
        { id: "alice" },
      );

      // autoMigrate disabled: the identity-enabling change is pending and the
      // enablement preflight never runs, so the store must be refused rather
      // than expose an unmaterialized identity surface.
      await expect(
        createStoreWithSchema(enabledGraph, result.backend, {
          autoMigrate: false,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: expect.objectContaining({
            code: "IDENTITY_ENABLEMENT_PENDING",
          }),
        }),
      );

      // With autoMigrate on, the same enablement commits and works.
      const [enabledStore] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      expect(
        await enabledStore.identity.areSame(
          { kind: "Person", id: "alice" },
          { kind: "Author", id: "alice" },
        ),
      ).toBe(true);
    } finally {
      await result.backend.close();
    }
  });
});
