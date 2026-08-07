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
import { Client, Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
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
import { type AnySqliteDatabase } from "../src/backend/drizzle/execution/sqlite-execution";
import {
  createPostgresBackend,
  isSerializedPostgresClient,
} from "../src/backend/drizzle/postgres";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { createGraphBackendProjection } from "../src/backend/graph-backend-projection";
import {
  beginSerializedImport,
  beginSerializedSnapshotExport,
  hasActiveSerializedImport,
  hasActiveSerializedSnapshotExport,
  markSerializedTransactionResource,
  sharesSerializedTransactionResource,
  snapshotExportContention,
} from "../src/backend/transaction-resource";
import { createBackendOverlay, type GraphBackend } from "../src/backend/types";
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

describe("serialized import lease", () => {
  // The lease is what makes "an export snapshot may not open while a streaming
  // import is writing through this connection" answerable from any wrapper, in
  // either direction. It is registered against the RESOURCE, so the export side
  // sees it even though it holds a different backend object.
  it("publishes an import against the resource, not the wrapper", () => {
    const root = createTestBackend();
    const resource = {};
    markSerializedTransactionResource(root, resource);
    const importing = createBackendOverlay(root, {});
    const exporting = createBackendOverlay(root, {});

    const release = beginSerializedImport(importing);

    expect(hasActiveSerializedImport(exporting)).toBe(true);
    // The two registries are separate facts: an import in flight must not read
    // as an open export snapshot, or an import would refuse itself.
    expect(hasActiveSerializedSnapshotExport(exporting)).toBe(false);

    release();
    expect(hasActiveSerializedImport(exporting)).toBe(false);
  });

  it("keeps the lease until the last holder releases it", () => {
    const root = createTestBackend();
    markSerializedTransactionResource(root, {});

    const first = beginSerializedImport(root);
    const second = beginSerializedImport(root);

    first();
    expect(hasActiveSerializedImport(root)).toBe(true);
    // Idempotent: a repeated release must not decrement the other holder's
    // count away.
    first();
    expect(hasActiveSerializedImport(root)).toBe(true);

    second();
    expect(hasActiveSerializedImport(root)).toBe(false);
  });

  it("does not conflate independent resources", () => {
    const first = createTestBackend();
    const second = createTestBackend();
    markSerializedTransactionResource(first, {});
    markSerializedTransactionResource(second, {});

    const release = beginSerializedImport(first);

    expect(hasActiveSerializedImport(second)).toBe(false);
    release();
  });

  it("is inert for a backend with no known serialized connection", () => {
    // A default `pg` Pool hands out an independent connection per checkout, so it
    // is deliberately unmarked — and an unmarked backend can hold no lease. That
    // is the documented residual gap (a driver we cannot positively identify
    // keeps only the identity-based pre-flight), asserted here so it stays
    // deliberate rather than becoming an accident.
    const pool = new Pool({
      connectionString: "postgres://user@127.0.0.1:1/typegraph_lease",
    });

    try {
      const unmarked = createPostgresBackend(drizzlePostgres(pool), {
        vector: false,
      });

      const release = beginSerializedImport(unmarked);

      expect(hasActiveSerializedImport(unmarked)).toBe(false);
      release();
    } finally {
      void pool.end();
    }
  });

  it("reports an export snapshot and an import independently", () => {
    const root = createTestBackend();
    markSerializedTransactionResource(root, {});

    const releaseExport = beginSerializedSnapshotExport(root);

    expect(hasActiveSerializedSnapshotExport(root)).toBe(true);
    expect(hasActiveSerializedImport(root)).toBe(false);

    releaseExport();
    expect(hasActiveSerializedSnapshotExport(root)).toBe(false);
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
