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
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
  type GraphBackend,
  IdentityContradictionError,
  MigrationError,
  rebuildIdentityClosure,
  StaleVersionError,
} from "../src";
import {
  createLocalSqliteBackend,
  type LocalSqliteBackendResult,
} from "../src/backend/sqlite/local";
import { ensureIdentitySchemaStorage } from "../src/identity/schema-transition";
import { rebuildIdentityClosureForContext } from "../src/identity/service";
import { type IdentityTarget } from "../src/identity/sql-target";
import { createSqlSchema, type SqlSchema } from "../src/query/compiler/schema";
import { buildKindRegistry } from "../src/registry/builders";
import {
  ensureSchema,
  getActiveSchema,
  initializeSchema,
  migrateSchema,
} from "../src/schema";
import { storeRuntime } from "../src/store/runtime-port";
import { requireDefined } from "../src/utils/presence";
import { matchingObject } from "./test-utils";

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

const ignoredGraph = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

/** A profile flip PLUS a dropped kind — two breaking changes in one diff. */
const foldGraphWithoutAuthor = defineGraph({
  id: GRAPH_ID,
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const alice = { kind: "Person", id: "alice" } as const;
const aliceAuthor = { kind: "Author", id: "alice" } as const;

async function activeVersion(backend: GraphBackend): Promise<number> {
  const row = await getActiveSchema(backend, GRAPH_ID);
  return row?.version ?? 0;
}

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

function existingIdentityTables(
  result: LocalSqliteBackendResult,
): readonly string[] {
  const placeholders = IDENTITY_TABLES.map(() => "?").join(", ");
  const rows = rawClient(result)
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) ORDER BY name`,
    )
    .all(...IDENTITY_TABLES) as { name: string }[];
  return rows.map((row) => row.name);
}

const SEPARATION_TABLE = "typegraph_identity_separation";

function separationTableExists(result: LocalSqliteBackendResult): boolean {
  const rows = rawClient(result)
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .all(SEPARATION_TABLE) as { name: string }[];
  return rows.length > 0;
}

function readSeparationRows(
  result: LocalSqliteBackendResult,
): readonly Readonly<{ class_key_low: string; class_key_high: string }>[] {
  return rawClient(result)
    .prepare(
      `SELECT class_key_low, class_key_high FROM ${SEPARATION_TABLE} ORDER BY class_key_low`,
    )
    .all() as { class_key_low: string; class_key_high: string }[];
}

/** The SQL schema the store itself derives for this backend's table names. */
function identitySchema(result: LocalSqliteBackendResult): SqlSchema {
  return createSqlSchema(result.backend.tableNames);
}

/**
 * The fill a boot supplies to `ensureIdentitySchemaStorage`: the same
 * ledger-driven rebuild `createStoreWithSchema` passes, against whichever
 * target the provisioning path can offer.
 */
async function rebuildSeparationFromLedger(
  result: LocalSqliteBackendResult,
  target: IdentityTarget,
): Promise<void> {
  await rebuildIdentityClosureForContext<typeof enabledGraph>({
    backend: target,
    graphId: GRAPH_ID,
    registry: buildKindRegistry(enabledGraph),
    schema: identitySchema(result),
    sameIdAcrossKinds: "fold",
  });
}

/** The same backend with one optional port withheld, as a custom backend may. */
function backendWithoutPort(
  backend: GraphBackend,
  port: "schemaWriteTransaction" | "identityTableDdl",
): GraphBackend {
  const withheld: Record<string, unknown> = { ...backend };
  Reflect.deleteProperty(withheld, port);
  return withheld as unknown as GraphBackend;
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

  it("provisions the effective Store schema's identity table names", async () => {
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
      const schema = createSqlSchema({
        identityAssertions: "custom_identity_assertions",
        recordedIdentityAssertions: "custom_recorded_identity_assertions",
        identityClosure: "custom_identity_closure",
      });

      const [enabledStore] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        { schema },
      );
      expect(
        await enabledStore.identity.areSame(
          { kind: "Person", id: "alice" },
          { kind: "Author", id: "alice" },
        ),
      ).toBe(true);
      const names = rawClient(result)
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'custom_%identity%' ORDER BY name",
        )
        .all() as { name: string }[];
      expect(names.map((row) => row.name)).toEqual([
        "custom_identity_assertions",
        "custom_identity_closure",
        "custom_recorded_identity_assertions",
      ]);
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
          details: matchingObject({
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

  it("fails loudly when an enabled graph has lost identity storage", async () => {
    const result = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(enabledGraph, result.backend);
      dropIdentityTables(result);

      await expect(
        createStoreWithSchema(enabledGraph, result.backend),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({ code: "IDENTITY_STORAGE_MISSING" }),
        }),
      );
      expect(existingIdentityTables(result)).toEqual([]);
      await expect(
        createStoreWithSchema(enabledGraph, result.backend),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({ code: "IDENTITY_STORAGE_MISSING" }),
        }),
      );
    } finally {
      await result.backend.close();
    }
  });

  it("provisions and backfills a derived relation a newer version added", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [seeded] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      const first = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(first, second);
      const expected = readSeparationRows(result);
      expect(expected).toHaveLength(1);

      // A database provisioned before the separation relation existed: the
      // ledger and closure are intact, only the newer derived relation is
      // absent. That is an upgrade, not the data loss the refusal above
      // guards — the open must provision it AND recompute it from the ledger.
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);

      const [reopened] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );

      expect(readSeparationRows(result)).toEqual(expected);
      await expect(
        storeRuntime(reopened).validateIdentity(),
      ).resolves.toBeUndefined();
    } finally {
      await result.backend.close();
    }
  });

  it("creates and fills the new derived relation inside one schema-write fence", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [seeded] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      const first = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(first, second);
      const expected = readSeparationRows(result);
      expect(expected).toHaveLength(1);
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);
      expect(separationTableExists(result)).toBe(false);

      // The window this asserts against: create the relation now, fill it at
      // the END of boot. In between sit the schema commit, the history
      // assertion, the contribution/vector materializers and a system-index
      // build — and for all of it the relation is present, readable and EMPTY,
      // so `isSeparated` answers "not separated" for the pair a live
      // `different` assertion separates. There is no timing to reproduce: the
      // structural claim is that no observer can ever be in that state, because
      // the CREATE and the fill are one transaction.
      const fenceObservations: {
        separationExistsAtEntry: boolean;
        inTransactionAtEntry: boolean;
        rowsAtExit: number;
        inTransactionAtExit: boolean;
      }[] = [];
      const provisionMissingFlags: boolean[] = [];

      const baseEnsureIdentityTables = requireDefined(
        result.backend.ensureIdentityTables,
      );
      vi.spyOn(result.backend, "ensureIdentityTables").mockImplementation(
        async (tableNames, options) => {
          provisionMissingFlags.push(options.provisionMissing);
          return baseEnsureIdentityTables(tableNames, options);
        },
      );

      const baseFence = requireDefined(result.backend.schemaWriteTransaction);
      vi.spyOn(result.backend, "schemaWriteTransaction").mockImplementation(
        async (graphId, fn) =>
          baseFence(graphId, async (target) => {
            const separationExistsAtEntry = separationTableExists(result);
            const inTransactionAtEntry = rawClient(result).inTransaction;
            const value = await fn(target);
            fenceObservations.push({
              separationExistsAtEntry,
              inTransactionAtEntry,
              rowsAtExit:
                separationTableExists(result) ?
                  readSeparationRows(result).length
                : -1,
              inTransactionAtExit: rawClient(result).inTransaction,
            });
            return value;
          }),
      );

      const [reopened] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );

      // Nothing provisioned the relation on the top-level backend: the old
      // create-early path called `ensureIdentityTables(provisionMissing: true)`
      // outside any transaction, which is exactly the visibility this forbids.
      expect(provisionMissingFlags).not.toContain(true);

      // Exactly one fence saw the relation appear, and by the time that fence
      // returned — still inside its transaction — the rows were already there.
      const upgradeFences = fenceObservations.filter(
        (observation) => !observation.separationExistsAtEntry,
      );
      expect(upgradeFences).toEqual([
        {
          separationExistsAtEntry: false,
          inTransactionAtEntry: true,
          rowsAtExit: expected.length,
          inTransactionAtExit: true,
        },
      ]);

      // And the published state is the correct one: the pair reads as
      // separated, so the merge the empty window would have allowed is refused.
      expect(readSeparationRows(result)).toEqual(expected);
      await expect(
        reopened.identity.assertSame(first, second),
      ).rejects.toBeInstanceOf(IdentityContradictionError);
      await expect(
        storeRuntime(reopened).validateIdentity(),
      ).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await result.backend.close();
    }
  });

  it("owes the commit nothing when it filled the derived relation itself", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [seeded] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      const first = await seeded.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const second = await seeded.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await seeded.identity.assertDifferent(first, second);
      const expected = readSeparationRows(result);
      expect(expected).toHaveLength(1);
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);

      const outcome = await ensureIdentitySchemaStorage(
        result.backend,
        identitySchema(result),
        {
          graphId: GRAPH_ID,
          enablement: false,
          registry: buildKindRegistry(enabledGraph),
          recomputeDerivedRelations: (target) =>
            rebuildSeparationFromLedger(result, target),
        },
      );

      // `provisionInCommit` is the DDL a schema commit must issue inside its
      // own transaction. Having created AND filled the relation inside its own
      // fence, this call owes that commit nothing — handing back DDL here would
      // re-issue a CREATE for a relation that is already published and filled.
      expect(outcome.provisionInCommit).toEqual([]);
      expect(readSeparationRows(result)).toEqual(expected);
    } finally {
      await result.backend.close();
    }
  });

  for (const port of ["schemaWriteTransaction", "identityTableDdl"] as const) {
    it(`refuses the derived-relation upgrade without ${port}`, async () => {
      const result = createLocalSqliteBackend();
      try {
        const [seeded] = await createStoreWithSchema(
          enabledGraph,
          result.backend,
        );
        const first = await seeded.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const second = await seeded.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        await seeded.identity.assertDifferent(first, second);
        expect(readSeparationRows(result)).toHaveLength(1);
        rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);

        // The atomic upgrade needs BOTH ports: the fence to hold the CREATE and
        // the fill together, and the DDL-as-data to issue inside it without
        // re-entering the backend's serialized statement queue. A backend
        // missing either cannot publish the two as one commit, and the
        // degraded alternative it used to take — create, then fill — leaves the
        // relation readable and EMPTY in between, where every pair reads as
        // "not separated". That is refused, loudly and by capability name,
        // rather than performed with a weaker guarantee than the invariant
        // requires.
        const withheld = backendWithoutPort(result.backend, port);

        await expect(
          ensureIdentitySchemaStorage(withheld, identitySchema(result), {
            graphId: GRAPH_ID,
            enablement: false,
            registry: buildKindRegistry(enabledGraph),
            recomputeDerivedRelations: (target) =>
              rebuildSeparationFromLedger(result, target),
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            name: "ConfigurationError",
            details: matchingObject({
              code: "IDENTITY_UPGRADE_REQUIRES_ATOMIC_DDL",
              graphId: GRAPH_ID,
              missingPorts: [port],
            }),
          }),
        );

        // A refusal, not a partial attempt: the relation stays ABSENT, which is
        // the one non-answering state. Every read of it raises
        // IDENTITY_STORAGE_MISSING instead of quietly reporting no separations.
        expect(separationTableExists(result)).toBe(false);
      } finally {
        await result.backend.close();
      }
    });
  }

  it("provisions without the atomic ports when the graph owes no rows", async () => {
    const result = createLocalSqliteBackend();
    try {
      // Same upgrade, same missing ports — but this graph has never asserted a
      // `different`, so its separation projection is EMPTY. Creating the
      // relation empty is not a compromise here, it is the correct content, so
      // there is nothing for the fence to make atomic and the refusal above
      // would be gratuitous.
      await createStoreWithSchema(enabledGraph, result.backend);
      rawClient(result).exec(`DROP TABLE ${SEPARATION_TABLE}`);

      const withheld = backendWithoutPort(
        backendWithoutPort(result.backend, "schemaWriteTransaction"),
        "identityTableDdl",
      );
      const outcome = await ensureIdentitySchemaStorage(
        withheld,
        identitySchema(result),
        {
          graphId: GRAPH_ID,
          enablement: false,
          registry: buildKindRegistry(enabledGraph),
          recomputeDerivedRelations: (target) =>
            rebuildSeparationFromLedger(result, target),
        },
      );

      expect(outcome.provisionInCommit).toEqual([]);
      expect(separationTableExists(result)).toBe(true);
      expect(readSeparationRows(result)).toEqual([]);
    } finally {
      await result.backend.close();
    }
  });

  it("gates a same-id folding flip behind an explicit migration that rebuilds the closure", async () => {
    const result = createLocalSqliteBackend();
    try {
      const [ignoredStore] = await createStoreWithSchema(
        ignoredGraph,
        result.backend,
      );
      await ignoredStore.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      await ignoredStore.nodes.Author.create(
        { penName: "A." },
        { id: "alice" },
      );
      expect(await ignoredStore.identity.areSame(alice, aliceAuthor)).toBe(
        false,
      );

      // A `sameIdAcrossKinds` flip is a breaking change, so it never
      // auto-migrates — and the identity-specific code wins over the generic
      // MigrationError because identity is the only breaking change here.
      await expect(
        createStoreWithSchema(enabledGraph, result.backend),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({
            code: "IDENTITY_PROFILE_MIGRATION_PENDING",
          }),
        }),
      );
      // The same refusal with autoMigrate disabled: the flip is unapplied
      // either way.
      await expect(
        createStoreWithSchema(enabledGraph, result.backend, {
          autoMigrate: false,
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          name: "ConfigurationError",
          details: matchingObject({
            code: "IDENTITY_PROFILE_MIGRATION_PENDING",
          }),
        }),
      );

      // Follow the error's own advice. `migrateSchema` commits the flip and
      // rebuilds the closure in the same transaction, so the next open is
      // clean rather than "migrated".
      await migrateSchema(
        result.backend,
        enabledGraph,
        await activeVersion(result.backend),
      );
      const [foldedStore, migration] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      expect(migration.status).toBe("unchanged");
      expect(await foldedStore.identity.areSame(alice, aliceAuthor)).toBe(true);

      await migrateSchema(
        result.backend,
        ignoredGraph,
        await activeVersion(result.backend),
      );
      const [ignoredAgain] = await createStoreWithSchema(
        ignoredGraph,
        result.backend,
      );
      expect(await ignoredAgain.identity.areSame(alice, aliceAuthor)).toBe(
        false,
      );

      await expect(rebuildIdentityClosure(foldedStore)).rejects.toBeInstanceOf(
        StaleVersionError,
      );
    } finally {
      await result.backend.close();
    }
  });

  it("keeps the generic MigrationError when the diff has other breaking changes", async () => {
    const result = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(ignoredGraph, result.backend);

      // Identity flip AND a dropped kind. The identity error names only the
      // identity change, so the generic error — which enumerates the whole
      // diff — has to win.
      const error = await createStoreWithSchema(
        foldGraphWithoutAuthor,
        result.backend,
      ).then(
        () => {
          throw new Error("expected a breaking-change refusal");
        },
        (error_: unknown) => error_,
      );

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      expect(details).toMatchObject({ reason: "breaking-change" });
      const diff = "diff" in details ? details.diff : undefined;
      expect(diff?.identity).toMatchObject({
        type: "modified",
        severity: "breaking",
      });
      expect(diff?.nodes).toContainEqual(
        expect.objectContaining({
          kind: "Author",
          type: "removed",
          severity: "breaking",
        }),
      );
    } finally {
      await result.backend.close();
    }
  });
});

describe("identity on the first schema commit", () => {
  const contradictionGraph = defineGraph({
    id: GRAPH_ID,
    nodes: { Person: { type: Person }, Author: { type: Author } },
    edges: {},
    ontology: [disjointWith(Person, Author)],
    identity: { sameIdAcrossKinds: "fold" },
  });

  it("materializes legacy same-id folds when initialization enables identity", async () => {
    const { backend } = createLocalSqliteBackend();
    // Legacy deployment: an unmanaged, identity-DISABLED Store wrote rows
    // without ever committing a schema version, so no closure exists and no
    // fold was ever recorded for the shared id.
    const legacy = createStore(disabledGraph, backend);
    const person = await legacy.nodes.Person.create(
      { name: "Shared" },
      { id: "shared" },
    );
    await legacy.nodes.Author.create({ penName: "Shared" }, { id: "shared" });

    const [store, validation] = await createStoreWithSchema(
      enabledGraph,
      backend,
    );
    expect(validation.status).toBe("initialized");
    expect(
      await store.identity.areSame(person, {
        kind: "Author",
        id: "shared",
      }),
    ).toBe(true);
    expect(await store.identity.membersOf(person)).toEqual([
      { kind: "Author", id: "shared" },
      { kind: "Person", id: "shared" },
    ]);
    await expect(
      storeRuntime(store).validateIdentity(),
    ).resolves.toBeUndefined();
  });

  it("builds the version-1 closure in the Store's custom identity tables", async () => {
    const result = createLocalSqliteBackend();
    try {
      const legacy = createStore(disabledGraph, result.backend);
      await legacy.nodes.Person.create({ name: "Shared" }, { id: "custom" });
      await legacy.nodes.Author.create({ penName: "S." }, { id: "custom" });
      const schema = createSqlSchema({
        identityAssertions: "custom_v1_identity_assertions",
        recordedIdentityAssertions: "custom_v1_recorded_identity_assertions",
        identityClosure: "custom_v1_identity_closure",
      });

      const [store, validation] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        { schema },
      );
      expect(validation.status).toBe("initialized");
      // The enablement fold must land in the tables the returned Store
      // reads — a preflight derived from backend.tableNames would build the
      // closure in the default tables and answer false here.
      expect(
        await store.identity.areSame(
          { kind: "Person", id: "custom" },
          { kind: "Author", id: "custom" },
        ),
      ).toBe(true);
      const closureRows = rawClient(result)
        .prepare("SELECT COUNT(*) AS n FROM custom_v1_identity_closure")
        .get() as { n: number };
      expect(closureRows.n).toBeGreaterThan(0);
    } finally {
      await result.backend.close();
    }
  });

  it("runs the enablement preflight from the public low-level commit paths too", async () => {
    // Direct initializeSchema(): the preflight is derived internally, so a
    // caller who never goes through createStoreWithSchema cannot commit
    // version 1 over a never-built closure.
    const direct = createLocalSqliteBackend();
    const directLegacy = createStore(disabledGraph, direct.backend);
    await directLegacy.nodes.Person.create({ name: "Shared" }, { id: "dup" });
    await directLegacy.nodes.Author.create({ penName: "S." }, { id: "dup" });
    await initializeSchema(direct.backend, enabledGraph);
    const [directStore] = await createStoreWithSchema(
      enabledGraph,
      direct.backend,
    );
    expect(
      await directStore.identity.areSame(
        { kind: "Person", id: "dup" },
        { kind: "Author", id: "dup" },
      ),
    ).toBe(true);

    // Bare ensureSchema(): same guarantee for the other public first-commit
    // path — the later createStoreWithSchema open sees a matching hash and
    // returns "unchanged", so the closure MUST already be right.
    const ensured = createLocalSqliteBackend();
    const ensuredLegacy = createStore(disabledGraph, ensured.backend);
    await ensuredLegacy.nodes.Person.create({ name: "Shared" }, { id: "dup" });
    await ensuredLegacy.nodes.Author.create({ penName: "S." }, { id: "dup" });
    const ensureResult = await ensureSchema(ensured.backend, enabledGraph);
    expect(ensureResult.status).toBe("initialized");
    const [ensuredStore, reopened] = await createStoreWithSchema(
      enabledGraph,
      ensured.backend,
    );
    expect(reopened.status).toBe("unchanged");
    expect(
      await ensuredStore.identity.areSame(
        { kind: "Person", id: "dup" },
        { kind: "Author", id: "dup" },
      ),
    ).toBe(true);
  });

  it("cannot be talked out of the version-1 closure build", async () => {
    // The old shape accepted a caller preflight that REPLACED the identity
    // work, so a no-op callback committed version 1 over populated peers and
    // every later open accepted the hash as "unchanged". The preflight is now
    // derived internally; a stray callback argument (what a pre-fix caller
    // would pass) is ignored rather than honored.
    const result = createLocalSqliteBackend();
    try {
      const legacy = createStore(disabledGraph, result.backend);
      await legacy.nodes.Person.create({ name: "Shared" }, { id: "noop" });
      await legacy.nodes.Author.create({ penName: "S." }, { id: "noop" });

      const noopCallback = (() => Promise.resolve()) as never;
      await initializeSchema(result.backend, enabledGraph, noopCallback);

      const [store, reopened] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
      );
      expect(reopened.status).toBe("unchanged");
      expect(
        await store.identity.areSame(
          { kind: "Person", id: "noop" },
          { kind: "Author", id: "noop" },
        ),
      ).toBe(true);
    } finally {
      await result.backend.close();
    }
  });

  it("derives the version-1 preflight over a custom schema on the bare path too", async () => {
    const result = createLocalSqliteBackend();
    try {
      const legacy = createStore(disabledGraph, result.backend);
      await legacy.nodes.Person.create({ name: "Shared" }, { id: "bare" });
      await legacy.nodes.Author.create({ penName: "S." }, { id: "bare" });
      const schema = createSqlSchema({
        identityAssertions: "bare_v1_identity_assertions",
        recordedIdentityAssertions: "bare_v1_recorded_identity_assertions",
        identityClosure: "bare_v1_identity_closure",
      });

      await initializeSchema(result.backend, enabledGraph, { schema });

      const closureRows = rawClient(result)
        .prepare("SELECT COUNT(*) AS n FROM bare_v1_identity_closure")
        .get() as { n: number };
      expect(closureRows.n).toBeGreaterThan(0);
      const [store] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        {
          schema,
        },
      );
      expect(
        await store.identity.areSame(
          { kind: "Person", id: "bare" },
          { kind: "Author", id: "bare" },
        ),
      ).toBe(true);
    } finally {
      await result.backend.close();
    }
  });

  it("rebuilds the custom-schema closure through explicit migrateSchema()", async () => {
    const result = createLocalSqliteBackend();
    try {
      const schema = createSqlSchema({
        identityAssertions: "flip_identity_assertions",
        recordedIdentityAssertions: "flip_recorded_identity_assertions",
        identityClosure: "flip_identity_closure",
      });
      const [foldStore] = await createStoreWithSchema(
        enabledGraph,
        result.backend,
        { schema },
      );
      await foldStore.nodes.Person.create({ name: "F" }, { id: "flip" });
      await foldStore.nodes.Author.create({ penName: "F." }, { id: "flip" });
      expect(
        await foldStore.identity.areSame(
          { kind: "Person", id: "flip" },
          { kind: "Author", id: "flip" },
        ),
      ).toBe(true);

      await migrateSchema(
        result.backend,
        ignoredGraph,
        await activeVersion(result.backend),
        { schema },
      );

      const [ignoreStore] = await createStoreWithSchema(
        ignoredGraph,
        result.backend,
        { schema },
      );
      // The flip's closure rebuild must land in the custom tables the Store
      // reads: under "ignore" the same-id pair no longer folds.
      expect(
        await ignoreStore.identity.areSame(
          { kind: "Person", id: "flip" },
          { kind: "Author", id: "flip" },
        ),
      ).toBe(false);
    } finally {
      await result.backend.close();
    }
  });

  it("refuses initialization when legacy rows contradict the identity profile", async () => {
    const { backend } = createLocalSqliteBackend();
    const legacy = createStore(disabledGraph, backend);
    await legacy.nodes.Person.create({ name: "Clash" }, { id: "clash" });
    await legacy.nodes.Author.create({ penName: "Clash" }, { id: "clash" });

    await expect(
      createStoreWithSchema(contradictionGraph, backend),
    ).rejects.toMatchObject({
      details: matchingObject({ code: "IDENTITY_SCHEMA_CONTRADICTION" }),
    });
    // The refused commit must not leave a schema row behind.
    expect(await getActiveSchema(backend, GRAPH_ID)).toBeUndefined();
  });
});
