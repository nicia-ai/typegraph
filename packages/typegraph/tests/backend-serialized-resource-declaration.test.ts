/**
 * The `serializedResource` declaration: what a caller can tell TypeGraph about
 * the connection its backend runs on, and what TypeGraph refuses to be told.
 *
 * Serialized-resource detection is a duck-type over driver internals, so it is
 * deliberately conservative: a driver it cannot positively identify is left
 * unmarked (`sqlite-proxy`, `pg-proxy`, Bun `SQL`, `expo-sqlite`, a postgres-js
 * client capped through a string the driver does not coerce). The declaration
 * is the seam for exactly that gap — a claim the caller can make and this
 * package cannot — and for the reverse case, a detection that is wrong for the
 * caller's topology.
 *
 * Three properties, one per arm, because an accepted option is applied or
 * refused and never ignored:
 *
 * - `{ mode: "shared", resource }` marks a backend detection could not see, and
 *   two wrappers naming the same object are one serialized resource.
 * - `{ mode: "shared", resource }` naming something detection disagrees with is
 *   REFUSED, not silently preferred — and the refusal describes the two
 *   handles rather than carrying them, because its `details` are logged.
 * - `{ mode: "independent" }` lifts the shared-resource arm of
 *   `snapshotExportContention` — and only that arm. One SQLite backend object
 *   exporting into itself stays refused, because that arm is a driver fact
 *   rather than a claim about connection topology.
 */
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../src/backend/derive-backend";
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  acquireSerializedStreamLease,
  backendResourceProvenance,
  serializedResourceConflict,
  type SerializedStreamKind,
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../src/backend/transaction-resource";
import {
  exportGraph,
  exportGraphStream,
  importGraphStream,
  ImportOptionsSchema,
} from "../src/interchange";
import { createTestDatabase } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const sourceGraph = defineGraph({
  id: "declared_resource_source",
  nodes: { Person: { type: Person } },
  edges: {},
});

const targetGraph = defineGraph({
  id: "declared_resource_target",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** The second pair on the same handle, so the two halves share no state. */
const declaredSourceGraph = defineGraph({
  id: "declared_resource_source_2",
  nodes: { Person: { type: Person } },
  edges: {},
});

const declaredTargetGraph = defineGraph({
  id: "declared_resource_target_2",
  nodes: { Person: { type: Person } },
  edges: {},
});

const importOptions = ImportOptionsSchema.parse({ onConflict: "error" });

/**
 * A SQLite database whose driver TypeGraph cannot attribute. `sqlite-proxy` is
 * the sanctioned bring-your-own-driver adapter and answers every statement from
 * this callback, so nothing here is a client shape any predicate recognizes.
 */
function createUnidentifiableSqliteDatabase(): AnySqliteDatabase {
  return drizzleSqliteProxy(() => Promise.resolve({ rows: [] }));
}

/**
 * A `pg` Pool that is never dialed. Constructing one opens no socket, and a
 * default-size pool is deliberately unmarked (each checkout is an independent
 * connection), so it stands in for "detection found nothing" on the Postgres
 * factory.
 */
function withUndialedPool<T>(
  options: Readonly<{ max?: number; connectionString?: string }>,
  use: (pool: Pool) => T,
): T {
  const pool = new Pool({
    connectionString: "postgres://user@127.0.0.1:1/typegraph_declaration",
    ...options,
  });
  try {
    return use(pool);
  } finally {
    void pool.end();
  }
}

/** The error a call threw, or `undefined` when it returned normally. */
function captureThrow(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The rejection a promise settled with, or `undefined` when it resolved. */
async function captureRejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The details of a refusal, once it is known to be the typed one. */
function conflictDetails(error: unknown): Record<string, unknown> {
  expect(error).toBeInstanceOf(ConfigurationError);
  const configurationError = error as ConfigurationError;
  expect(configurationError.details["reason"]).toBe(
    "serialized-resource-conflict",
  );
  return configurationError.details;
}

describe("declaring a serialized resource", () => {
  it("marks a SQLite backend whose driver detection cannot identify", () => {
    // The escape hatch's primary case: the caller knows this proxy dispatches
    // onto one connection, and nothing in the client's shape says so.
    const connection = { name: "the caller's one connection" };
    const db = createUnidentifiableSqliteDatabase();

    const declared = createSqliteBackend(db, {
      serializedResource: { mode: "shared", resource: connection },
    });
    const alsoDeclared = createSqliteBackend(
      createUnidentifiableSqliteDatabase(),
      { serializedResource: { mode: "shared", resource: connection } },
    );
    const detected = createSqliteBackend(db);

    expect(backendResourceProvenance(declared)).toBe("serialized");
    // Two wrappers naming the same object are ONE resource, exactly as two
    // wrappers over a detected client are — that is what makes the guards see
    // them as a pair.
    expect(declared).not.toBe(alsoDeclared);
    expect(sharesSerializedTransactionResource(declared, alsoDeclared)).toBe(
      true,
    );
    // Without the declaration the same database is unmarked, so the option is
    // what carried the verdict here and not the driver.
    expect(backendResourceProvenance(detected)).toBe("independent");
    expect(sharesSerializedTransactionResource(declared, detected)).toBe(false);
  });

  it("marks a Postgres backend whose driver detection cannot identify", () => {
    // Same arm on the other factory: the declaration is resolved by one shared
    // function, so both factories mean the same thing by it.
    const connection = { name: "the caller's one connection" };

    withUndialedPool({}, (pool) => {
      const declared = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
        serializedResource: { mode: "shared", resource: connection },
      });
      const alsoDeclared = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
        serializedResource: { mode: "shared", resource: connection },
      });
      const detected = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });

      expect(backendResourceProvenance(declared)).toBe("serialized");
      expect(sharesSerializedTransactionResource(declared, alsoDeclared)).toBe(
        true,
      );
      expect(backendResourceProvenance(detected)).toBe("independent");
    });
  });

  it("accepts a SQLite declaration that names the detected connection", () => {
    // Not a conflict: the caller spelled out what detection already found, so
    // there is one resource and one verdict.
    const db = createTestDatabase();
    const handle = (db as unknown as Readonly<{ $client: object }>).$client;

    const declared = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      serializedResource: { mode: "shared", resource: handle },
    });
    const detected = createSqliteBackend(db, {
      executionProfile: { isSync: true },
    });

    expect(sharesSerializedTransactionResource(declared, detected)).toBe(true);
  });

  it("refuses a SQLite declaration that contradicts detection", () => {
    // Silently preferring the declaration would let two wrappers over one
    // better-sqlite3 handle be handed two different sentinels, and the guards
    // would stop seeing them as one connection.
    const db = createTestDatabase();

    const refusal = captureThrow(() =>
      createSqliteBackend(db, {
        executionProfile: { isSync: true },
        serializedResource: {
          mode: "shared",
          resource: { notTheHandle: true },
        },
      }),
    );

    expect(conflictDetails(refusal)).toBeDefined();
  });

  it("refuses a Postgres declaration that contradicts detection", () => {
    // A pool capped at one connection IS detected, so a declaration naming
    // anything else is the same contradiction on the other factory.
    withUndialedPool({ max: 1 }, (pool) => {
      const refusal = captureThrow(() =>
        createPostgresBackend(drizzlePostgres(pool), {
          vector: false,
          serializedResource: {
            mode: "shared",
            resource: { notThePool: true },
          },
        }),
      );

      expect(conflictDetails(refusal)).toBeDefined();
      expect(serializedResourceConflict(refusal)?.detected).toBe(pool);
    });
  });

  it("reports both sides of a contradicted declaration", () => {
    // The refusal names the two objects it could not reconcile, so the caller
    // can see WHICH connection they were expected to declare.
    const db = createTestDatabase();
    const handle = (db as unknown as Readonly<{ $client: object }>).$client;
    const declared = { notTheHandle: true };

    const refusal = captureThrow(() =>
      createSqliteBackend(db, {
        executionProfile: { isSync: true },
        serializedResource: { mode: "shared", resource: declared },
      }),
    );

    expect((refusal as ConfigurationError).code).toBe("CONFIGURATION_ERROR");
    // What goes in `details` is a DESCRIPTION of each side, because `details`
    // is logged verbatim (see the next test).
    expect(conflictDetails(refusal)["declaredKind"]).toBe("Object");
    expect(conflictDetails(refusal)["detectedKind"]).toBe("Database");
    // The identities themselves are reachable by asking, because the caller
    // needs to see WHICH objects could not be reconciled when several of one
    // kind are in play.
    expect(serializedResourceConflict(refusal)).toEqual({
      declared,
      detected: handle,
    });
  });

  it("keeps the handles it could not reconcile out of what it logs", () => {
    // `toLogString()` JSON.stringifies `details` and the documented handler
    // pattern is `console.error(error.toLogString())`, so a driver handle in
    // `details` writes that driver's stored credentials into the caller's
    // logs: a `pg.Pool` keeps the whole connection string, password included.
    withUndialedPool(
      {
        max: 1,
        connectionString:
          "postgres://user:s3cr3t@127.0.0.1:1/typegraph_declaration",
      },
      (pool) => {
        const refusal = captureThrow(() =>
          createPostgresBackend(drizzlePostgres(pool), {
            vector: false,
            serializedResource: {
              mode: "shared",
              resource: { notThePool: true },
            },
          }),
        );

        const logged = (refusal as ConfigurationError).toLogString();
        expect(logged).not.toContain("s3cr3t");
        // Not vacuous: the refusal really is the one carrying both sides, and
        // it still says what kind of thing each side was.
        expect(logged).toContain("serialized-resource-conflict");
        expect(logged).toContain(pool.constructor.name);
        expect(serializedResourceConflict(refusal)?.detected).toBe(pool);
      },
    );
  });
});

describe("declaring a backend independent", () => {
  it("lifts the shared-resource refusal between two backends over one handle", async () => {
    // Detection marks both of these — they really are one better-sqlite3 handle
    // — and the declaration is what makes the guard let them past. The pair is
    // then the DRIVER's problem: this fixture declares `independent` about a
    // connection that genuinely is shared, because better-sqlite3 is the one
    // driver on which both halves of the option's contract (the arm it lifts
    // and the arm it cannot) are reachable from one handle. The real user of
    // this arm is a topology TypeGraph mis-read, where nothing downstream
    // fails.
    const db = createTestDatabase();
    const detectedSource = createSqliteBackend(db, {
      executionProfile: { isSync: true },
    });
    const detectedTarget = createSqliteBackend(db, {
      executionProfile: { isSync: true },
    });
    expect(snapshotExportContention(detectedSource, detectedTarget)).toBe(
      "shared-resource",
    );
    // The contrast, on the very same handle: undeclared, this pair is refused
    // before the export ever opens its snapshot.
    const [detectedSourceStore] = await createStoreWithSchema(
      sourceGraph,
      detectedSource,
    );
    const [detectedTargetStore] = await createStoreWithSchema(
      targetGraph,
      detectedTarget,
    );
    await detectedSourceStore.nodes.Person.create(
      { name: "Alice" },
      { id: "detected" },
    );
    const refusedExport = vi.spyOn(detectedSource, "transaction");
    await expect(
      importGraphStream(
        detectedTargetStore,
        exportGraphStream(detectedSourceStore),
        importOptions,
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT" },
    });
    expect(refusedExport).not.toHaveBeenCalled();

    const sourceBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const targetBackend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });

    expect(
      sharesSerializedTransactionResource(sourceBackend, targetBackend),
    ).toBe(false);
    expect(
      snapshotExportContention(sourceBackend, targetBackend),
    ).toBeUndefined();

    const [source] = await createStoreWithSchema(
      declaredSourceGraph,
      sourceBackend,
    );
    const [target] = await createStoreWithSchema(
      declaredTargetGraph,
      targetBackend,
    );
    await source.nodes.Person.create({ name: "Alice" }, { id: "declared" });
    const beginExport = vi.spyOn(sourceBackend, "transaction");

    const settled = await captureRejection(
      importGraphStream(target, exportGraphStream(source), importOptions),
    );

    // The pre-flight let the pair through: the export opened its snapshot,
    // which is exactly what the refused pairing never reaches (the
    // shared-resource refusal fires before the first transaction). Whatever
    // the driver then did, TypeGraph did not refuse this — the settled value is
    // either nothing or the driver's own error, never an interchange guard
    // code.
    expect(beginExport).toHaveBeenCalled();
    expect(
      settled instanceof ConfigurationError ?
        settled.details["code"]
      : undefined,
    ).toBeUndefined();
  });

  it("does not lift the same-backend refusal for a SQLite self-import", async () => {
    // The arm the declaration cannot reach, and must not: ONE backend object
    // exporting into ITSELF holds the one snapshot transaction its own import
    // writes through. That is a driver fact about a single handle, not a claim
    // about connection topology, so no declaration makes it false.
    const db = createTestDatabase();
    const backend = createSqliteBackend(db, {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const [store] = await createStoreWithSchema(sourceGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "self-import" });

    expect(snapshotExportContention(backend, backend)).toBe(
      "same-sqlite-backend",
    );
    await expect(
      importGraphStream(store, exportGraphStream(store), importOptions),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "INTERCHANGE_SAME_SQLITE_BACKEND_SNAPSHOT",
        graphId: sourceGraph.id,
      },
    });
  });

  it("keeps one independently declared SQLite backend exclusively leased", () => {
    const backend = createSqliteBackend(createTestDatabase(), {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const first = acquireSerializedStreamLease(backend, "export-snapshot");

    expect(first.acquired).toBe(true);
    expect(acquireSerializedStreamLease(backend, "export-snapshot")).toEqual({
      acquired: false,
      heldBy: "export-snapshot",
    });

    if (!first.acquired)
      throw new Error("Expected the first lease to succeed.");
    first.release();
  });

  it("does not serialize a SQLite backend merely because detection found no shared resource", () => {
    const backend = createSqliteBackend(createUnidentifiableSqliteDatabase());
    const first = acquireSerializedStreamLease(backend, "export-snapshot");
    const second = acquireSerializedStreamLease(backend, "export-snapshot");

    expect(first).toMatchObject({ acquired: true, resource: undefined });
    expect(second).toMatchObject({ acquired: true, resource: undefined });
    if (first.acquired) first.release();
    if (second.acquired) second.release();
  });

  it.each([
    ["export-snapshot", "import-stream"],
    ["import-stream", "export-snapshot"],
    ["import-stream", "import-stream"],
    ["export-snapshot", "export-snapshot"],
  ] as const satisfies readonly (readonly [
    SerializedStreamKind,
    SerializedStreamKind,
  ])[])(
    "carries an independent SQLite identity lease from %s to a derived %s",
    (holder, requested) => {
      const root = createSqliteBackend(createTestDatabase(), {
        executionProfile: { isSync: true },
        serializedResource: { mode: "independent" },
      });
      const derived = deriveBackend(projectGraphBackend(root), {});
      const other = createSqliteBackend(createTestDatabase(), {
        executionProfile: { isSync: true },
        serializedResource: { mode: "independent" },
      });
      const first = acquireSerializedStreamLease(root, holder);

      expect(acquireSerializedStreamLease(derived, requested)).toEqual({
        acquired: false,
        heldBy: holder,
      });
      const independent = acquireSerializedStreamLease(other, requested);
      expect(independent.acquired).toBe(true);

      if (!first.acquired)
        throw new Error("Expected the root lease to succeed.");
      first.release();
      if (independent.acquired) independent.release();
      const retried = acquireSerializedStreamLease(derived, requested);
      expect(retried.acquired).toBe(true);
      if (retried.acquired) retried.release();
    },
  );

  it("refuses concurrent exports on one independently declared SQLite backend", async () => {
    const backend = createSqliteBackend(createTestDatabase(), {
      executionProfile: { isSync: true },
      serializedResource: { mode: "independent" },
    });
    const [store] = await createStoreWithSchema(sourceGraph, backend);
    await store.nodes.Person.create({ name: "Alice" }, { id: "two-exports" });
    const first = exportGraphStream(store)[Symbol.asyncIterator]();
    const header = await first.next();

    expect(header.done).toBe(false);
    try {
      await expect(exportGraph(store)).rejects.toMatchObject({
        name: "ConfigurationError",
        details: {
          code: "INTERCHANGE_SHARED_SERIALIZED_BACKEND_SNAPSHOT",
          requested: "export-snapshot",
          heldBy: "export-snapshot",
        },
      });
    } finally {
      await first.return?.();
    }
  });
});
