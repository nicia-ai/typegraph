/**
 * Backend-interaction contracts, asserted by tracing WHERE work happens
 * rather than only what state results:
 *
 * - Read-path contract: the found path of every getOrCreate never opens a
 *   write transaction and never calls a write method.
 * - Atomicity contract: every mutation's row and sidecar writes (uniques,
 *   fulltext) happen inside a transaction, never on the root connection.
 * - Hook contract: an operation whose transaction fails at COMMIT reports
 *   through `onError` and never through `onOperationEnd`, for every hooked
 *   node and edge operation — hooks wrap the transaction, so success means
 *   durably committed.
 * - Batch-hook contract: batch methods remain deliberately hookless, including
 *   when their transaction rolls back at COMMIT.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HookContext,
  type QueryHookContext,
  searchable,
} from "../src";
import {
  type AnySqliteDatabase,
  isBetterSqlite3Client,
  isBunSqliteClient,
  isSqlJsClient,
} from "../src/backend/drizzle/execution/sqlite-execution";
import {
  createPostgresBackend,
  isSerializedPostgresClient,
} from "../src/backend/drizzle/postgres";
import {
  createSqliteBackend,
  isSerializedSqliteClient,
} from "../src/backend/drizzle/sqlite";
import { createGraphBackendProjection } from "../src/backend/graph-backend-projection";
import {
  acquireSerializedStreamLease,
  markSerializedTransactionResource,
  type SerializedStreamKind,
  type SerializedStreamLease,
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../src/backend/transaction-resource";
import {
  createBackendOverlay,
  type GraphBackend,
  type TransactionBackend,
  type TransactionOptions,
} from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";
import { dumpObservableState } from "./state-snapshot";
import { createTestBackend } from "./test-utils";
import {
  createCommitFailingBackend,
  createTracingBackend,
  InjectedCommitFailure,
} from "./trace-backend";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    bio: searchable({ language: "english" }),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ weight: z.number() }),
});

const graph = defineGraph({
  id: "backend_contracts",
  nodes: {
    Person: {
      type: Person,
      onDelete: "cascade",
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

describe("serialized transaction resource ownership", () => {
  it("recognizes distinct backend wrappers sharing one serialized connection", () => {
    const root = createTestBackend();
    const resource = {};
    markSerializedTransactionResource(root, resource);
    const first = createBackendOverlay(root, {});
    const second = createBackendOverlay(root, {});

    expect(first).not.toBe(second);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    expect(sharesSerializedTransactionResource(first, root)).toBe(true);
  });

  it("carries ownership through a GraphBackend projection", () => {
    // A `history: true` store runs on an OVERLAY OVER A PROJECTION of its
    // backend. A projection that dropped the mark left the import guard and
    // the branch cloner unable to see that the store still writes through the
    // source's one connection.
    const root = createTestBackend();
    const resource = {};
    markSerializedTransactionResource(root, resource);

    const projected = createGraphBackendProjection(root);
    const overlaid = createBackendOverlay(projected, {});

    expect(projected).not.toBe(root);
    expect(sharesSerializedTransactionResource(projected, root)).toBe(true);
    expect(sharesSerializedTransactionResource(overlaid, root)).toBe(true);
  });

  it("does not conflate projections of independent backends", () => {
    const root = createTestBackend();
    const projectedRoot = createGraphBackendProjection(root);
    const other = createTestBackend();
    const projectedOther = createGraphBackendProjection(other);

    expect(sharesSerializedTransactionResource(projectedRoot, root)).toBe(true);
    expect(
      sharesSerializedTransactionResource(projectedRoot, projectedOther),
    ).toBe(false);
  });
});

/**
 * Narrows a lease the test expects to have been granted, reporting the actual
 * holder when it was not — a lease refused where the test assumed it was free
 * must not surface as `undefined is not a function`.
 */
function acquiredLease(lease: SerializedStreamLease): () => void {
  if (!lease.acquired) {
    throw new Error(
      `Expected the serialized stream lease to be free, but a ${lease.heldBy} holds it.`,
    );
  }
  return lease.release;
}

describe("serialized stream lease", () => {
  // The lease is what makes "no second long-lived interchange stream may run on
  // this connection" answerable from any wrapper, in either direction. It is
  // registered against the RESOURCE, so the second stream sees the first even
  // though the two hold different backend objects.
  it("publishes a stream against the resource, not the wrapper", () => {
    const root = createTestBackend();
    const resource = {};
    markSerializedTransactionResource(root, resource);
    const importing = createBackendOverlay(root, {});
    const exporting = createBackendOverlay(root, {});

    const release = acquiredLease(
      acquireSerializedStreamLease(importing, "import-stream"),
    );

    expect(acquireSerializedStreamLease(exporting, "export-snapshot")).toEqual({
      acquired: false,
      heldBy: "import-stream",
    });

    release();
    expect(
      acquireSerializedStreamLease(exporting, "export-snapshot").acquired,
    ).toBe(true);
  });

  // All FOUR pairings, because the lease is exclusive rather than a pair of
  // per-kind registries: two exports nest their snapshot transactions on the one
  // connection exactly as an export and an import do, and a refcounted lease
  // admitted both same-kind rows until the driver failed on them mid-stream.
  it.each([
    ["export-snapshot", "import-stream"],
    ["import-stream", "export-snapshot"],
    ["import-stream", "import-stream"],
    ["export-snapshot", "export-snapshot"],
  ] as const satisfies readonly (readonly [
    SerializedStreamKind,
    SerializedStreamKind,
  ])[])("refuses a %s the connection a %s already holds", (second, holder) => {
    const root = createTestBackend();
    markSerializedTransactionResource(root, {});
    const first = createBackendOverlay(root, {});
    const other = createBackendOverlay(root, {});

    const release = acquiredLease(acquireSerializedStreamLease(first, holder));

    expect(acquireSerializedStreamLease(other, second)).toEqual({
      acquired: false,
      heldBy: holder,
    });

    // Scoped to a RUNNING stream: a lease left behind would refuse every
    // later stream on that connection.
    release();
    expect(acquireSerializedStreamLease(other, second).acquired).toBe(true);
  });

  it("releases only its own claim, however often it is called", () => {
    const root = createTestBackend();
    markSerializedTransactionResource(root, {});

    const finished = acquiredLease(
      acquireSerializedStreamLease(root, "import-stream"),
    );
    finished();
    const running = acquiredLease(
      acquireSerializedStreamLease(root, "export-snapshot"),
    );

    // Idempotent: a second release from the stream that is OVER must not hand
    // the connection away while the new holder is still on it.
    finished();

    expect(acquireSerializedStreamLease(root, "import-stream")).toEqual({
      acquired: false,
      heldBy: "export-snapshot",
    });
    running();
  });

  it("does not conflate independent resources", () => {
    const first = createTestBackend();
    const second = createTestBackend();
    markSerializedTransactionResource(first, {});
    markSerializedTransactionResource(second, {});

    const release = acquiredLease(
      acquireSerializedStreamLease(first, "import-stream"),
    );

    expect(acquireSerializedStreamLease(second, "import-stream").acquired).toBe(
      true,
    );
    release();
  });

  it("is inert for a backend with no known serialized connection", () => {
    // The CORRECT case, not the residual gap: a default `pg` Pool hands out an
    // independent connection per checkout, so two streams over it genuinely run
    // on two connections and refusing either would refuse work that succeeds.
    // The pool is therefore deliberately unmarked, and an unmarked backend can
    // hold no lease. (The residual gap is a different population — drivers that
    // ARE serialized but cannot be positively identified; nothing here stands in
    // for those.)
    const pool = new Pool({
      connectionString: "postgres://user@127.0.0.1:1/typegraph_lease",
    });

    try {
      const unmarked = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });

      const release = acquiredLease(
        acquireSerializedStreamLease(unmarked, "import-stream"),
      );

      expect(
        acquireSerializedStreamLease(unmarked, "export-snapshot").acquired,
      ).toBe(true);
      release();
    } finally {
      void pool.end();
    }
  });
});

/**
 * A SQLite driver that records every statement and can be told to reject one of
 * them. `sqlite-proxy` is the sanctioned bring-your-own-driver adapter, so the
 * frame statements (BEGIN / COMMIT / ROLLBACK) arrive here as plain text with no
 * real database involved.
 */
function createFrameRecordingDatabase(
  statements: string[],
  failing: Readonly<{ prefix: string; error: Error }>,
): AnySqliteDatabase {
  return drizzleSqliteProxy((query: string) => {
    statements.push(query);
    if (query.startsWith(failing.prefix)) return Promise.reject(failing.error);
    return Promise.resolve({ rows: [] });
  });
}

describe("SQLite manual transaction frames", () => {
  // Both manually framed paths ("sql" transaction mode): the business
  // transaction and the schema write. Each one used to `await ROLLBACK; throw
  // error` — so a ROLLBACK that rejected replaced the caller's actionable error
  // with a secondary one AND skipped its own rethrow. SQLite auto-rolls-back on
  // SQLITE_FULL / SQLITE_IOERR / SQLITE_NOMEM, which is exactly when the
  // original error matters most and exactly when ROLLBACK answers "cannot
  // rollback - no transaction is active".
  it.each([
    [
      "a business transaction",
      (backend: GraphBackend, failure: Error): Promise<unknown> =>
        backend.transaction(() => {
          throw failure;
        }),
    ],
    [
      "a schema write",
      (backend: GraphBackend, failure: Error): Promise<unknown> =>
        requireDefined(backend.schemaWriteTransaction)(graph.id, () => {
          throw failure;
        }),
    ],
  ])(
    "rethrows the original failure when ROLLBACK fails in %s",
    async (_frame, runFrame) => {
      const statements: string[] = [];
      const rollbackFailure = new Error(
        "cannot rollback - no transaction is active",
      );
      const backend = createSqliteBackend(
        createFrameRecordingDatabase(statements, {
          prefix: "ROLLBACK",
          error: rollbackFailure,
        }),
        { executionProfile: { isSync: false, transactionMode: "sql" } },
      );
      const diskFailure = new Error("database disk image is malformed");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {
        // The rollback failure is reported, not thrown; keep it out of the
        // suite's output.
      });

      try {
        await expect(runFrame(backend, diskFailure)).rejects.toBe(diskFailure);

        // The frame was opened and the rollback WAS attempted — the original
        // error survives because the attempt is reported, not because it was
        // skipped.
        expect(
          statements.filter((query) => !query.startsWith("PRAGMA")),
        ).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    },
  );
});

describe("snapshot export contention", () => {
  it("allows a pooled Postgres backend to import its own export stream", () => {
    // A default-size pool hands out an INDEPENDENT connection per checkout, so
    // an export snapshot held on one checkout does not hold the connection the
    // import writes through — even when one backend object is passed as both
    // sides, which is exactly what `store.import(store.export())` looks like.
    // Object identity alone would refuse that legitimate work; the dialect
    // check is what confines the identity arm to SQLite, where one backend
    // object really is one connection.
    const pool = new Pool({
      connectionString: "postgres://user@127.0.0.1:1/typegraph_contention",
    });

    try {
      const backend = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });

      expect(backend.dialect).toBe("postgres");
      // Preconditions for the arm under test: transactions are on, so the
      // guard does not short-circuit before the identity check; and the pool is
      // deliberately unmarked, so the shared-resource arm cannot be what
      // answers.
      expect(backend.capabilities.transactions).toBe(true);
      // Not marked because a pool is genuinely concurrent — the correct
      // classification for this driver, not an unidentified one.
      expect(sharesSerializedTransactionResource(backend, backend)).toBe(false);

      expect(snapshotExportContention(backend, backend)).toBeUndefined();
    } finally {
      void pool.end();
    }
  });

  it("refuses one SQLite backend exporting into itself", () => {
    const backend = createTestBackend();

    expect(backend.dialect).toBe("sqlite");
    // The marked resource would also answer "shared-resource", so this pins
    // that the more specific detector is the one reported.
    expect(snapshotExportContention(backend, backend)).toBe(
      "same-sqlite-backend",
    );
  });
});

/** Stands in for a driver's query method on a hand-built client. */
function resolveNoRows(): Promise<readonly unknown[]> {
  return Promise.resolve([]);
}

/**
 * A tagged-template driver's client is a FUNCTION, so every stand-in for one is
 * built on its OWN callable: assigning driver markers onto a shared function
 * would leak them into the next case and make an abstention look like a match.
 */
function createCallableClient(
  properties: Readonly<Record<string, unknown>>,
): unknown {
  // `bind` yields a fresh function object, so the driver markers land on this
  // stand-in only.
  return Object.assign(resolveNoRows.bind(undefined), properties);
}

/**
 * A postgres-js-shaped client: callable, with the `unsafe` raw executor and the
 * `begin` transaction starter the driver detection reads, plus the resolved
 * `options` postgres-js exposes on the callable (postgres@3.x). Hand-built
 * because postgres-js is not a dependency of this package — the shape under test
 * is the shape the predicate reads.
 */
function createPostgresJsClient(
  options: Readonly<{ max?: number }> | undefined,
): unknown {
  return createCallableClient({
    unsafe: resolveNoRows,
    begin: resolveNoRows,
    ...(options === undefined ? {} : { options }),
  });
}

describe("serialized Postgres client detection", () => {
  // The marking predicate decides whether two backends over one client are
  // treated as a single serialized connection. It runs against real `pg`
  // objects here: a connection is never opened, so no server is required, but
  // the shapes are the driver's own rather than a hand-written stand-in.
  const CONNECTION_STRING = "postgres://user@127.0.0.1:1/typegraph_probe";

  it("marks a bare pg Client", () => {
    const client = new Client({ connectionString: CONNECTION_STRING });

    expect(isSerializedPostgresClient(client)).toBe(true);
  });

  it("does not mark a default pg Pool", () => {
    const pool = new Pool({ connectionString: CONNECTION_STRING });

    try {
      expect(isSerializedPostgresClient(pool)).toBe(false);
    } finally {
      void pool.end();
    }
  });

  it("marks a pg Pool explicitly capped at one connection", () => {
    // An export checks out the pool's only connection for the whole stream, so
    // a concurrent import waits for a connection that never comes back.
    const pool = new Pool({ connectionString: CONNECTION_STRING, max: 1 });

    try {
      expect(isSerializedPostgresClient(pool)).toBe(true);
    } finally {
      void pool.end();
    }
  });

  it("abstains on clients it cannot positively identify", () => {
    // A postgres-js client that states no connection cap is at the driver
    // default (10) and hands each `begin` its own connection; neon-http is
    // callable too, and an arbitrary object proves nothing. Marking any of them
    // would refuse legitimate concurrent work, so the predicate declines.
    const taggedTemplate = createCallableClient({
      unsafe: resolveNoRows,
      begin: resolveNoRows,
      query: resolveNoRows,
    });

    expect(isSerializedPostgresClient(taggedTemplate)).toBe(false);
    expect(isSerializedPostgresClient({ query: resolveNoRows })).toBe(false);
    expect(isSerializedPostgresClient({})).toBe(false);
  });

  it("marks a postgres-js client capped at one connection", () => {
    // `postgres(url, { max: 1 })`: every statement — and every `begin`, which
    // reserves the sole connection for the transaction — runs on one connection,
    // so an export snapshot on one wrapper holds the connection another
    // wrapper's import needs. The client is CALLABLE, and the resolver used to
    // drop callables before reading their cap.
    const client = createPostgresJsClient({ max: 1 });

    expect(isSerializedPostgresClient(client)).toBe(true);
  });

  it("does not mark a postgres-js client that states no single-connection cap", () => {
    // postgres-js's `max` defaults to 10, so an absent option is a POOL and an
    // explicit larger cap is a pool too. Either would be refused work that
    // succeeds.
    expect(isSerializedPostgresClient(createPostgresJsClient({}))).toBe(false);
    expect(
      isSerializedPostgresClient(createPostgresJsClient({ max: 10 })),
    ).toBe(false);
    expect(isSerializedPostgresClient(createPostgresJsClient(undefined))).toBe(
      false,
    );
  });

  it("does not mark an unrecognized callable client capped at one connection", () => {
    // `options.max === 1` on a callable we cannot attribute to a known driver
    // (no postgres-js `unsafe` + `begin`/`savepoint` surface) is not evidence
    // about how that driver dispatches statements — e.g. Bun's `SQL`, which
    // nothing in the package positively identifies, stays a declared gap rather
    // than becoming a guess.
    const unknownCallable = createCallableClient({ options: { max: 1 } });
    // neon-http is callable and has `unsafe`, but its `unsafe` is a fragment
    // builder and it starts transactions with `transaction`, not `begin` — so it
    // is not postgres-js and its options say nothing about statement dispatch.
    const neonHttpShaped = createCallableClient({
      unsafe: resolveNoRows,
      transaction: resolveNoRows,
      options: { max: 1 },
    });

    expect(isSerializedPostgresClient(unknownCallable)).toBe(false);
    expect(isSerializedPostgresClient(neonHttpShaped)).toBe(false);
  });
});

describe("serialized SQLite connection detection", () => {
  const openDatabases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const database of openDatabases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  function openDatabase(file: string): Database.Database {
    const database = new Database(file);
    openDatabases.push(database);
    return database;
  }

  it("recognizes two backends over one better-sqlite3 handle", () => {
    const database = openDatabase(":memory:");

    const first = createSqliteBackend(drizzle(database));
    const second = createSqliteBackend(drizzle(database));

    expect(first).not.toBe(second);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
  });

  it("treats separate connections to one file as independent", async () => {
    // better-sqlite3 serializes PER CONNECTION. Two handles on one WAL file are
    // genuinely concurrent, so treating them as one serialized resource would
    // refuse an export/import pair that works.
    const directory = await mkdtemp(path.join(tmpdir(), "typegraph-sqlite-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "graph.db");

    const first = createSqliteBackend(drizzle(openDatabase(file)));
    const second = createSqliteBackend(drizzle(openDatabase(file)));

    expect(sharesSerializedTransactionResource(first, second)).toBe(false);
  });
});

/** A prepared statement of the better-sqlite3 / bun:sqlite shape. */
function createAllBearingStatement(): object {
  return {
    all: (): readonly unknown[] => [],
    run: (): object => ({ changes: 0 }),
  };
}

/**
 * A `bun:sqlite` `Database`, duck-typed to the members `isBunSqliteClient`
 * reads — `query` (bun's cached-statement factory), the `run`/`exec` pair,
 * `serialize`, and the `filename` string — verified against `bun-types` 1.3.x.
 * Hand-built because bun:sqlite exists only inside the Bun runtime, so the
 * shape under test is the shape the predicate reads.
 */
function createBunSqliteClient(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    prepare: (): object => createAllBearingStatement(),
    query: (): object => createAllBearingStatement(),
    run: (): object => ({ changes: 0 }),
    exec: (): object => ({ changes: 0 }),
    serialize: (): Uint8Array => new Uint8Array(),
    close: (): void => {
      // A stand-in never opens anything to close.
    },
    filename: ":memory:",
    ...overrides,
  };
}

/**
 * A `sql.js` `Database`, duck-typed to the members `isSqlJsClient` reads —
 * `export` (dump to bytes) and `getRowsModified`, sql.js's own API, plus the
 * `prepare`/`exec`/`run` trio. Its `prepare` returns a sql.js `Statement`
 * (`bind`/`step`/`getAsObject`/`free`, NO `all`), which is why the compiled
 * execution path must abstain on this client.
 */
function createSqlJsClient(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    prepare: (): object => ({
      bind: (): boolean => true,
      step: (): boolean => false,
      getAsObject: (): object => ({}),
      free: (): boolean => true,
    }),
    exec: (): readonly unknown[] => [],
    run: (): object => ({}),
    each: (): object => ({}),
    export: (): Uint8Array => new Uint8Array(),
    getRowsModified: (): number => 0,
    close: (): void => {
      // A stand-in never opens anything to close.
    },
    ...overrides,
  };
}

/** The same client shape minus one member — a near miss of a driver's shape. */
function withoutMember(
  client: Readonly<Record<string, unknown>>,
  member: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(client).filter(([name]) => name !== member),
  );
}

/** What `drizzle(client)` exposes to the backend factory, for any client. */
function createClientDatabase(client: unknown): AnySqliteDatabase {
  return {
    $client: client,
    get: (): unknown => ({}),
    all: (): readonly unknown[] => [],
    run: (): unknown => ({}),
  } as unknown as AnySqliteDatabase;
}

/**
 * bun:sqlite and sql.js are each ONE connection every wrapper's statements run
 * on, exactly like better-sqlite3 — and until #434 neither was marked, because
 * the only SQLite duck-type was better-sqlite3's `pragma`. An unmarked
 * serialized driver keeps only the identity pre-flight in `importGraphStream`,
 * which a `history: true` store's overlay defeats, so a streaming export/import
 * pair on one bun:sqlite or sql.js connection reached `BEGIN IMMEDIATE`
 * instead of the typed refusal.
 *
 * Each mark rests on POSITIVE structural evidence taken from the driver's own
 * typings; a client carrying only part of a shape must abstain rather than
 * guess, because marking a genuinely concurrent driver refuses work that
 * succeeds.
 */
describe("serialized SQLite client detection", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close();
  });

  /** A REAL better-sqlite3 handle, to check the shapes against each other. */
  function openBetterSqlite3Client(): Database.Database {
    const database = new Database(":memory:");
    openDatabases.push(database);
    return database;
  }

  it("marks a bun:sqlite Database", () => {
    expect(isSerializedSqliteClient(createBunSqliteClient())).toBe(true);
  });

  it("marks a sql.js Database", () => {
    expect(isSerializedSqliteClient(createSqlJsClient())).toBe(true);
  });

  it("recognizes two backends over one bun:sqlite Database", () => {
    const client = createBunSqliteClient();

    const first = createSqliteBackend(createClientDatabase(client));
    const second = createSqliteBackend(createClientDatabase(client));

    expect(first).not.toBe(second);
    // Preconditions for the gap: transactions are on, so the interchange guard
    // does not short-circuit, and the two wrappers are distinct objects, so the
    // identity pre-flight cannot answer either.
    expect(first.capabilities.transactions).toBe(true);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    expect(snapshotExportContention(first, second)).toBe("shared-resource");
  });

  it("recognizes two backends over one sql.js Database", () => {
    const client = createSqlJsClient();

    const first = createSqliteBackend(createClientDatabase(client));
    const second = createSqliteBackend(createClientDatabase(client));

    expect(first.capabilities.transactions).toBe(true);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    expect(snapshotExportContention(first, second)).toBe("shared-resource");
  });

  it("carries the bun:sqlite mark through the wrappers a history store adds", () => {
    const client = createBunSqliteClient();
    const source = createSqliteBackend(createClientDatabase(client));
    const target = createBackendOverlay(
      createGraphBackendProjection(
        createSqliteBackend(createClientDatabase(client)),
      ),
      {},
    );

    expect(snapshotExportContention(source, target)).toBe("shared-resource");
  });

  it("treats separate bun:sqlite and sql.js handles as independent", () => {
    // Two handles are two connections, whatever they point at — marking them
    // as one resource would refuse an export/import pair that works.
    expect(
      sharesSerializedTransactionResource(
        createSqliteBackend(createClientDatabase(createBunSqliteClient())),
        createSqliteBackend(createClientDatabase(createBunSqliteClient())),
      ),
    ).toBe(false);
    expect(
      sharesSerializedTransactionResource(
        createSqliteBackend(createClientDatabase(createSqlJsClient())),
        createSqliteBackend(createClientDatabase(createSqlJsClient())),
      ),
    ).toBe(false);
  });

  it("abstains on prepare-capable clients it cannot attribute to a driver", () => {
    // A client that merely prepares statements says nothing about whether its
    // driver serializes: `sqlite-proxy`, a bespoke adapter, or a pooling
    // wrapper all prepare. Only the named driver shapes are evidence.
    expect(isSerializedSqliteClient({ prepare: (): object => ({}) })).toBe(
      false,
    );
    expect(isSerializedSqliteClient({})).toBe(false);
    expect(isSerializedSqliteClient(undefined)).toBe(false);
  });

  it("abstains on near-miss driver shapes", () => {
    // bun:sqlite without its `query` factory, or without the `filename` string
    // (better-sqlite3 names that property `name`), is not identified as
    // bun:sqlite; sql.js without `export` or without `getRowsModified` is not
    // identified as sql.js. Each removed member is the one that carries the
    // attribution, so dropping it must drop the mark.
    expect(
      isSerializedSqliteClient(withoutMember(createBunSqliteClient(), "query")),
    ).toBe(false);
    expect(
      isSerializedSqliteClient(
        withoutMember(createBunSqliteClient(), "filename"),
      ),
    ).toBe(false);
    expect(
      isSerializedSqliteClient(withoutMember(createSqlJsClient(), "export")),
    ).toBe(false);
    expect(
      isSerializedSqliteClient(
        withoutMember(createSqlJsClient(), "getRowsModified"),
      ),
    ).toBe(false);
  });

  it("does not mistake one identified driver for another", () => {
    // The three prepare-capable shapes are mutually exclusive on the members
    // that identify them, so no client is marked by an arm meant for a
    // different driver.
    const betterSqlite3 = openBetterSqlite3Client();

    expect(isBunSqliteClient(betterSqlite3)).toBe(false);
    expect(isSqlJsClient(betterSqlite3)).toBe(false);
    expect(isBetterSqlite3Client(createBunSqliteClient())).toBe(false);
    expect(isSqlJsClient(createBunSqliteClient())).toBe(false);
    expect(isBetterSqlite3Client(createSqlJsClient())).toBe(false);
    expect(isBunSqliteClient(createSqlJsClient())).toBe(false);
  });
});

/**
 * The `ctx.storage` object a Durable Object hands to `drizzle()`: the async and
 * sync transaction runners plus the SQL API, which together are the evidence
 * `getDurableObjectStorageClient` requires.
 */
function createStorageClient(): object {
  return {
    sql: {
      exec: (): readonly unknown[] => [],
    },
    transaction: <T>(run: () => Promise<T>): Promise<T> => run(),
    transactionSync: <T>(run: () => T): T => run(),
  };
}

/** What `drizzle(ctx.storage)` exposes to the backend factory. */
function createDurableObjectDatabase(storage: object): AnySqliteDatabase {
  return { $client: storage } as unknown as AnySqliteDatabase;
}

/**
 * Cloudflare Durable Object storage (`drizzle(ctx.storage)`) is ONE connection
 * whose transaction frame is ambient on the storage object, so a second
 * wrapper's import writes land inside the first wrapper's open export snapshot.
 * Nothing else abstains for it: the DO backend reports
 * `capabilities.transactions: true`, so the interchange guard reaches the
 * shared-resource question and needs an answer.
 *
 * A real Durable Object cannot run here (no workerd), so the storage client is
 * duck-typed to the shape `getDurableObjectStorageClient` requires — which is
 * also the shape `transactionMode: "do-sqlite"` drives at runtime, so a stand-in
 * the detector accepts is a stand-in the transaction runner would accept.
 */
describe("Durable Object storage serialized-resource detection", () => {
  it("recognizes two backends over one storage object", () => {
    const storage = createStorageClient();

    const first = createSqliteBackend(createDurableObjectDatabase(storage));
    const second = createSqliteBackend(createDurableObjectDatabase(storage));

    expect(first).not.toBe(second);
    // Precondition for the gap: transactions are on, so the guard does not
    // short-circuit and the mark is the only thing that can refuse the import.
    expect(first.capabilities.transactions).toBe(true);
    expect(sharesSerializedTransactionResource(first, second)).toBe(true);
    expect(snapshotExportContention(first, second)).toBe("shared-resource");
  });

  it("carries the mark through the wrappers a history store adds", () => {
    const storage = createStorageClient();
    const source = createSqliteBackend(createDurableObjectDatabase(storage));
    const target = createBackendOverlay(
      createGraphBackendProjection(
        createSqliteBackend(createDurableObjectDatabase(storage)),
      ),
      {},
    );

    expect(snapshotExportContention(source, target)).toBe("shared-resource");
  });

  it("treats separate storage objects as independent", () => {
    const first = createSqliteBackend(
      createDurableObjectDatabase(createStorageClient()),
    );
    const second = createSqliteBackend(
      createDurableObjectDatabase(createStorageClient()),
    );

    expect(sharesSerializedTransactionResource(first, second)).toBe(false);
  });

  it("does not adopt a client with only part of the storage shape", () => {
    // better-sqlite3's `db.transaction(fn)` is a wrapper FACTORY, not the DO
    // async runner; the full shape (async + sync runners plus the SQL API) is
    // what distinguishes them, and a partial match must abstain rather than mark
    // an unknown client.
    const partialStorage = {
      transaction: <T>(run: () => Promise<T>): Promise<T> => run(),
    };

    const first = createSqliteBackend(
      createDurableObjectDatabase(partialStorage),
    );
    const second = createSqliteBackend(
      createDurableObjectDatabase(partialStorage),
    );

    expect(sharesSerializedTransactionResource(first, second)).toBe(false);
  });
});

const WRITE_METHOD_PATTERN =
  /insertNode|updateNode|deleteNode|hardDeleteNode|insertEdge|updateEdge|deleteEdge|hardDeleteEdge|insertUnique|deleteUnique|upsertFulltext|deleteFulltext|upsertEmbedding|deleteEmbedding/;

function writeCalls(calls: readonly string[]): string[] {
  return calls.filter((call) => WRITE_METHOD_PATTERN.test(call));
}

async function seedPair(store: {
  nodes: {
    Person: {
      create: (
        props: { name: string; email: string; bio: string },
        options: { id: string },
      ) => Promise<unknown>;
    };
  };
}) {
  await store.nodes.Person.create(
    { name: "A", email: "a@example.com", bio: "alpha" },
    { id: "person-a" },
  );
  await store.nodes.Person.create(
    { name: "B", email: "b@example.com", bio: "beta" },
    { id: "person-b" },
  );
}

describe("read-path contract: found paths perform no write work", () => {
  it("node getOrCreateByConstraint found path opens no transaction", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);
    await seedPair(store);

    trace.reset();
    const result = await store.nodes.Person.getOrCreateByConstraint(
      "person_email",
      { name: "A", email: "a@example.com", bio: "alpha" },
    );
    expect(result.action).toBe("found");
    expect(trace.calls.filter((call) => call.includes("transaction"))).toEqual(
      [],
    );
    expect(writeCalls(trace.calls)).toEqual([]);
  });

  it("edge getOrCreateByEndpoints found path opens no transaction", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);
    await seedPair(store);
    await store.edges.knows.getOrCreateByEndpoints(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
    );

    trace.reset();
    const found = await store.edges.knows.getOrCreateByEndpoints(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
    );
    expect(found.action).toBe("found");
    expect(trace.calls.filter((call) => call.includes("transaction"))).toEqual(
      [],
    );
    expect(writeCalls(trace.calls)).toEqual([]);
  });
});

describe("atomicity contract: writes happen only inside transactions", () => {
  it("row and sidecar writes for every mutation carry the tx prefix", async () => {
    const trace = createTracingBackend(createTestBackend());
    const [store] = await createStoreWithSchema(graph, trace.backend);

    trace.reset();
    const created = await store.nodes.Person.create(
      { name: "A", email: "a@example.com", bio: "alpha" },
      { id: "person-a" },
    );
    await store.nodes.Person.create(
      { name: "B", email: "b@example.com", bio: "beta" },
      { id: "person-b" },
    );
    await store.nodes.Person.update(created.id, { name: "A2" });
    await store.edges.knows.create(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
      { id: "knows-1" },
    );
    await store.edges.knows.update("knows-1" as never, { weight: 2 });
    await store.edges.knows.delete("knows-1" as never);
    await store.nodes.Person.delete(created.id);

    const rootWrites = writeCalls(trace.calls).filter(
      (call) => !call.startsWith("tx."),
    );
    expect(rootWrites).toEqual([]);
    // Sanity: the trace actually observed sidecar writes inside transactions.
    expect(writeCalls(trace.calls).includes("tx.insertUnique")).toBe(true);
  });
});

describe("hook contract: success is reported only after COMMIT", () => {
  type HookEvents = string[];

  async function buildStore() {
    const failing = createCommitFailingBackend(createTestBackend());
    const events: HookEvents = [];
    const [store] = await createStoreWithSchema(graph, failing.backend, {
      hooks: {
        onOperationStart: (ctx) => {
          events.push(`start:${ctx.operation}:${ctx.entity}`);
        },
        onOperationEnd: (ctx) => {
          events.push(`end:${ctx.operation}:${ctx.entity}`);
        },
        onBulkOperationStart: (ctx) => {
          events.push(`bulk-start:${ctx.operation}:${ctx.entity}`);
        },
        onBulkOperationEnd: (ctx, result) => {
          events.push(
            `bulk-end:${ctx.operation}:${ctx.entity}:${result.affectedCount}`,
          );
        },
        onError: (ctx, error) => {
          events.push(`error:${error.name}`);
        },
      },
    });
    await seedPair(store);
    await store.edges.knows.create(
      { kind: "Person", id: "person-a" } as never,
      { kind: "Person", id: "person-b" } as never,
      { weight: 1 },
      { id: "knows-1" },
    );
    return { store, failing, events };
  }

  type Matrix = readonly Readonly<{
    name: string;
    run: (
      store: Awaited<ReturnType<typeof buildStore>>["store"],
    ) => Promise<unknown>;
  }>[];

  const operations: Matrix = [
    {
      name: "node create",
      run: (store) =>
        store.nodes.Person.create(
          { name: "C", email: "c@example.com", bio: "gamma" },
          { id: "person-c" },
        ),
    },
    {
      name: "node update",
      run: (store) =>
        store.nodes.Person.update("person-a" as never, { name: "A2" }),
    },
    {
      name: "node delete",
      run: (store) => store.nodes.Person.delete("person-a" as never),
    },
    {
      name: "node hardDelete",
      run: (store) => store.nodes.Person.hardDelete("person-a" as never),
    },
    {
      name: "node getOrCreateByConstraint (creating)",
      run: (store) =>
        store.nodes.Person.getOrCreateByConstraint("person_email", {
          name: "D",
          email: "d@example.com",
          bio: "delta",
        }),
    },
    {
      name: "edge create",
      run: (store) =>
        store.edges.knows.create(
          { kind: "Person", id: "person-b" } as never,
          { kind: "Person", id: "person-a" } as never,
          { weight: 3 },
          { id: "knows-2" },
        ),
    },
    {
      name: "edge update",
      run: (store) =>
        store.edges.knows.update("knows-1" as never, { weight: 9 }),
    },
    {
      name: "edge delete",
      run: (store) => store.edges.knows.delete("knows-1" as never),
    },
    {
      name: "edge hardDelete",
      run: (store) => store.edges.knows.hardDelete("knows-1" as never),
    },
    {
      name: "edge getOrCreateByEndpoints (creating)",
      run: (store) =>
        store.edges.knows.getOrCreateByEndpoints(
          { kind: "Person", id: "person-b" } as never,
          { kind: "Person", id: "person-a" } as never,
          { weight: 5 },
        ),
    },
  ];

  it("operations inside store.transaction defer success hooks to COMMIT", async () => {
    const { store, failing, events } = await buildStore();
    events.length = 0;

    failing.arm();
    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Person.create(
          { name: "C", email: "c@example.com", bio: "gamma" },
          { id: "person-c" },
        );
      }),
    ).rejects.toThrow(InjectedCommitFailure);
    failing.disarm();

    // The nested create completed inside the transaction, but the commit
    // failed: its success must be converted into onError, never reported as
    // onOperationEnd.
    expect(events).toContain("start:create:node");
    expect(events.some((event) => event.startsWith("end:"))).toBe(false);
    expect(events).toContain("error:InjectedCommitFailure");

    events.length = 0;
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create(
        { name: "C", email: "c@example.com", bio: "gamma" },
        { id: "person-c" },
      );
      // Completed inside the callback, but not yet committed: no end event.
      expect(events.some((event) => event.startsWith("end:"))).toBe(false);
    });
    expect(events).toContain("end:create:node");
  });

  it("set updates inside store.transaction defer success hooks to COMMIT", async () => {
    const { store, failing, events } = await buildStore();
    events.length = 0;

    failing.arm();
    await expect(
      store.transaction(async (tx) => {
        await tx.nodes.Person.updateWhere({
          patch: { name: "Changed" },
          all: true,
        });
        expect(events.some((event) => event.startsWith("bulk-end:"))).toBe(
          false,
        );
      }),
    ).rejects.toThrow(InjectedCommitFailure);
    failing.disarm();

    expect(events).toContain("bulk-start:updateWhere:node");
    expect(events.some((event) => event.startsWith("bulk-end:"))).toBe(false);
    expect(events).toContain("error:InjectedCommitFailure");
    const rolledBackPerson = await store.nodes.Person.getById(
      "person-a" as never,
    );
    expect(rolledBackPerson?.name).toBe("A");

    events.length = 0;
    await store.transaction(async (tx) => {
      await tx.nodes.Person.updateWhere({
        patch: { name: "Changed" },
        all: true,
      });
      expect(events).toEqual(["bulk-start:updateWhere:node"]);
    });
    expect(events).toEqual([
      "bulk-start:updateWhere:node",
      "bulk-end:updateWhere:node:2",
    ]);
  });

  for (const batchDelete of [
    {
      name: "node bulkDelete",
      run: (store: Awaited<ReturnType<typeof buildStore>>["store"]) =>
        store.nodes.Person.bulkDelete(["person-a" as never]),
    },
    {
      name: "edge bulkDelete",
      run: (store: Awaited<ReturnType<typeof buildStore>>["store"]) =>
        store.edges.knows.bulkDelete(["knows-1" as never]),
    },
  ] as const) {
    it(`${batchDelete.name}: remains hookless and rolls back on commit failure`, async () => {
      const { store, failing, events } = await buildStore();
      const before = await dumpObservableState(store);
      events.length = 0;

      failing.arm();
      await expect(batchDelete.run(store)).rejects.toThrow(
        InjectedCommitFailure,
      );
      failing.disarm();

      // Batch methods deliberately skip per-item hooks. In particular, no
      // item may report success from inside the transaction before the outer
      // COMMIT fails.
      expect(events).toEqual([]);
      expect(await dumpObservableState(store)).toEqual(before);

      await batchDelete.run(store);
      expect(events).toEqual([]);
      expect(await dumpObservableState(store)).not.toEqual(before);
    });
  }

  it("edge bulkDelete fires zero per-item hooks, unlike a single delete", async () => {
    // `executeEdgeDeleteBatch` (src/store/operations/edge-operations.ts)
    // deliberately skips `withOperationHooks` for batch throughput. Asserted
    // as EXACTLY zero events against a single `delete` baseline: a hooked
    // per-item loop would silently restore per-item hooks and still pass
    // every other suite.
    const { store, events } = await buildStore();
    await store.edges.knows.create(
      { kind: "Person", id: "person-b" } as never,
      { kind: "Person", id: "person-a" } as never,
      { weight: 2 },
      { id: "knows-2" },
    );
    events.length = 0;

    await store.edges.knows.delete("knows-1" as never);
    expect(events).toEqual(["start:delete:edge", "end:delete:edge"]);

    events.length = 0;
    await store.edges.knows.bulkDelete(["knows-2" as never]);
    expect(events).toEqual([]);

    const deleted = await store.edges.knows.getById("knows-2" as never, {
      temporalMode: "includeTombstones",
    });
    expect(deleted?.meta.deletedAt).toBeDefined();
  });

  for (const operation of operations) {
    it(`${operation.name}: commit failure reports onError, never onOperationEnd, and rolls back`, async () => {
      const { store, failing, events } = await buildStore();
      const before = await dumpObservableState(store);
      events.length = 0;

      failing.arm();
      await expect(operation.run(store)).rejects.toThrow(InjectedCommitFailure);
      failing.disarm();

      expect(events.some((event) => event.startsWith("start:"))).toBe(true);
      expect(events.some((event) => event.startsWith("end:"))).toBe(false);
      expect(events).toContain("error:InjectedCommitFailure");

      // The rollback was real: nothing observable changed.
      const after = await dumpObservableState(store);
      expect(after).toEqual(before);
    });
  }
});

// ============================================================
// Edge-identity contract
// ============================================================

type EdgeWriteCall = Readonly<{
  method: string;
  params: Readonly<Record<string, unknown>>;
}>;

/** Edge write members whose params carry an optional expected `kind`. */
const KIND_PREDICATED_EDGE_WRITES = new Set([
  "updateEdge",
  "deleteEdge",
  "hardDeleteEdge",
]);

/** Edge write members that are deliberately kind-blind. */
const KIND_BLIND_EDGE_WRITES = new Set([
  "deleteEdgesBatch",
  "hardDeleteEdgesBatch",
]);

/**
 * Records the params the store hands each edge write, on the TRANSACTION
 * target — which is where a managed write actually runs.
 *
 * This is a duck-typed stand-in for a CUSTOM backend: a third-party
 * implementation only ever sees these params objects, so what the store puts
 * in them is the whole of the contract it can honor.
 */
function isRecordedEdgeWrite(property: string | symbol): property is string {
  return (
    typeof property === "string" &&
    (KIND_PREDICATED_EDGE_WRITES.has(property) ||
      KIND_BLIND_EDGE_WRITES.has(property))
  );
}

function recordEdgeWriteParams(target: GraphBackend): Readonly<{
  backend: GraphBackend;
  calls: EdgeWriteCall[];
}> {
  const calls: EdgeWriteCall[] = [];

  function record<T extends object>(inner: T, wrapTransaction: boolean): T {
    return new Proxy(inner, {
      get(source, property, receiver): unknown {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;

        if (wrapTransaction && property === "transaction") {
          const transaction = value as GraphBackend["transaction"];
          const recording: GraphBackend["transaction"] = <R>(
            fn: (tx: TransactionBackend) => Promise<R>,
            options: TransactionOptions | undefined,
          ): Promise<R> => transaction((tx) => fn(record(tx, false)), options);
          return recording;
        }

        if (!isRecordedEdgeWrite(property)) return value;
        const method = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]): unknown => {
          calls.push({
            method: property,
            params: (args[0] ?? {}) as Readonly<Record<string, unknown>>,
          });
          return Reflect.apply(method, source, args);
        };
      },
    });
  }

  return { backend: record(target, true), calls };
}

function paramsFor(
  calls: readonly EdgeWriteCall[],
  method: string,
): Readonly<Record<string, unknown>> {
  const call = calls.find((entry) => entry.method === method);
  return requireDefined(call, `no ${method} call recorded`).params;
}

/**
 * The contract a CUSTOM backend has to honor, asserted from the store side.
 *
 * `UpdateEdgeParams` / `DeleteEdgeParams` / `HardDeleteEdgeParams` carry an
 * optional `kind`, and a backend that receives it MUST put it in the write
 * statement's own `WHERE` — `... AND kind = ?`. Edge ids are graph-global while
 * collections are kind-scoped, so a write keyed on `(graph_id, id)` alone can
 * land on a row a concurrent `hardDelete` + recreate re-pointed the id at, and
 * a backend that silently drops the predicate re-opens exactly the window the
 * store stated it to close. A backend that ignores it looks correct until it is
 * raced, which is why the built-in backends' behavior is pinned separately in
 * `tests/edge-write-self-verification.test.ts` — what THIS file pins is the
 * other half: that the store actually supplies the kind, so a custom backend
 * has something to honor.
 *
 * The cascade is the deliberate exception and is asserted alongside: it removes
 * every connected edge whatever its kind, so it must state none.
 */
async function seedRecordedEdge() {
  const recorder = recordEdgeWriteParams(createTestBackend());
  const [store] = await createStoreWithSchema(graph, recorder.backend);
  await seedPair(store);
  const edge = await store.edges.knows.create(
    { kind: "Person", id: "person-a" } as never,
    { kind: "Person", id: "person-b" } as never,
    { weight: 1 },
    { id: "knows-1" },
  );
  recorder.calls.length = 0;
  return { calls: recorder.calls, store, edgeId: edge.id };
}

describe("edge-identity contract: kind-scoped writes state their expected kind", () => {
  const seedEdge = seedRecordedEdge;

  it("passes the collection's kind to updateEdge", async () => {
    const { calls, store, edgeId } = await seedEdge();
    await store.edges.knows.update(edgeId, { weight: 2 });
    expect(paramsFor(calls, "updateEdge")["kind"]).toBe("knows");
  });

  it("passes the collection's kind to deleteEdge", async () => {
    const { calls, store, edgeId } = await seedEdge();
    await store.edges.knows.delete(edgeId);
    expect(paramsFor(calls, "deleteEdge")["kind"]).toBe("knows");
  });

  it("passes the collection's kind to hardDeleteEdge", async () => {
    const { calls, store, edgeId } = await seedEdge();
    await store.edges.knows.hardDelete(edgeId);
    expect(paramsFor(calls, "hardDeleteEdge")["kind"]).toBe("knows");
  });

  it("passes the collection's kind on the batch delete path", async () => {
    const { calls, store, edgeId } = await seedEdge();
    await store.edges.knows.bulkDelete([edgeId]);
    expect(paramsFor(calls, "deleteEdge")["kind"]).toBe("knows");
  });

  it("states NO kind on the node delete cascade", async () => {
    const { calls, store } = await seedEdge();
    // `Person` is `onDelete: "cascade"`, so this removes the connected edge by
    // ENDPOINT across every edge kind. A kind predicate leaking in here would
    // strand edges of the kinds the cascade did not name.
    await store.nodes.Person.delete("person-a" as never);

    const cascadeCalls = calls.filter(
      (call) =>
        KIND_BLIND_EDGE_WRITES.has(call.method) ||
        KIND_PREDICATED_EDGE_WRITES.has(call.method),
    );
    expect(cascadeCalls.length).toBeGreaterThan(0);
    for (const call of cascadeCalls) {
      expect(call.params["kind"]).toBeUndefined();
    }
  });
});

describe("query hook contract: each submitted statement is observable", () => {
  it("observes statements executed through store.batch()", async () => {
    const starts: QueryHookContext[] = [];
    const [store] = await createStoreWithSchema(graph, createTestBackend(), {
      hooks: {
        onQueryStart: (ctx) => {
          starts.push(ctx);
        },
      },
    });
    await seedPair(store);

    await store.batch(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.id),
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p.name),
    );

    expect(starts).toHaveLength(2);
  });

  it("reports statement failures through onError without firing onQueryEnd", async () => {
    const backend = createTestBackend();
    const projected = createGraphBackendProjection(backend);
    const executeRaw = projected.executeRaw;
    if (executeRaw === undefined)
      throw new Error("SQLite must expose executeRaw");
    const injectedFailure = new Error("injected query failure");
    let failQueries = false;
    const failingBackend: GraphBackend = createBackendOverlay(projected, {
      executeRaw: <T>(sqlText: string, params: readonly unknown[]) =>
        failQueries ?
          Promise.reject(injectedFailure)
        : executeRaw<T>(sqlText, params),
    });
    const errors: Readonly<{ ctx: HookContext; error: Error }>[] = [];
    const ends: QueryHookContext[] = [];
    const [store] = await createStoreWithSchema(graph, failingBackend, {
      hooks: {
        onQueryEnd: (ctx) => {
          ends.push(ctx);
        },
        onError: (ctx, error) => {
          errors.push({ ctx, error });
        },
      },
    });
    failQueries = true;

    await expect(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .execute(),
    ).rejects.toBe(injectedFailure);

    expect(ends).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.ctx.graphId).toBe(graph.id);
    expect(errors[0]?.error).toBe(injectedFailure);
  });
});
