/**
 * Issue #795, SQLite half: an edge write and a delete of one of its endpoints
 * cannot interleave on SQLite, so the race PostgreSQL needed row locks for
 * (see `tests/backends/postgres/concurrent-edge-endpoint-delete.test.ts`)
 * never opens here.
 *
 * Every store write transaction takes SQLite's single writer slot before its
 * first read, so while one of the two writes holds an open transaction the
 * other cannot even begin: it is refused with `SQLITE_BUSY` (the second
 * connection's busy timeout is zero, so the refusal is immediate instead of a
 * wait that would block this single-threaded test). Once the first commits,
 * the second runs against the committed state and reaches the same verdict a
 * serial execution does.
 *
 * Two better-sqlite3 handles on one WAL file are the honest construction: a
 * second store on the SAME handle would queue behind the first's transaction
 * rather than contend with it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  EndpointNotFoundError,
  type Store,
} from "../../../src";
import { generateSqliteDDL } from "../../../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import { requireDefined } from "../../../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: "sqlite_concurrent_edge_endpoint_delete",
  nodes: { Person: { type: Person, onDelete: "cascade" } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

const alice = { kind: "Person", id: "alice" } as const;
const bob = { kind: "Person", id: "bob" } as const;

type GraphStore = Store<typeof graph>;

type Deferred = Readonly<{ promise: Promise<void>; resolve: () => void }>;

function deferred(): Deferred {
  const handle: { resolve?: () => void } = {};
  const promise = new Promise<void>((settle) => {
    handle.resolve = settle;
  });
  return {
    promise,
    resolve: () => {
      requireDefined(handle.resolve)();
    },
  };
}

async function rejection(operation: Promise<unknown>): Promise<unknown> {
  return operation.then(
    () => {
      throw new Error("Expected the concurrent write to be refused.");
    },
    (error: unknown) => error,
  );
}

/** SQLite reports the occupied writer slot as `SQLITE_BUSY`, maybe wrapped. */
function isBusy(error: unknown): boolean {
  for (
    let current: unknown = error;
    current instanceof Error;
    current = current.cause
  ) {
    if ((current as { code?: unknown }).code === "SQLITE_BUSY") return true;
    if (/database is locked/i.test(current.message)) return true;
  }
  return false;
}

describe("edge writes racing an endpoint delete (SQLite, two WAL connections)", () => {
  const openDatabases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const database of openDatabases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function openStores(): Promise<
    Readonly<{ first: GraphStore; second: GraphStore }>
  > {
    const directory = await mkdtemp(
      path.join(tmpdir(), "typegraph-endpoint-delete-"),
    );
    temporaryDirectories.push(directory);
    const file = path.join(directory, "graph.db");
    const firstDatabase = new Database(file);
    openDatabases.push(firstDatabase);
    firstDatabase.pragma("journal_mode = WAL");
    for (const statement of generateSqliteDDL()) firstDatabase.exec(statement);
    const secondDatabase = new Database(file);
    openDatabases.push(secondDatabase);
    secondDatabase.pragma("busy_timeout = 0");
    const first = createStore(
      graph,
      createSqliteBackend(drizzle(firstDatabase)),
    );
    const second = createStore(
      graph,
      createSqliteBackend(drizzle(secondDatabase)),
    );
    await first.nodes.Person.create({ name: "Alice" }, { id: alice.id });
    await first.nodes.Person.create({ name: "Bob" }, { id: bob.id });
    return { first, second };
  }

  it("delete first: the edge write cannot start, then refuses the tombstoned endpoint", async () => {
    const { first, second } = await openStores();
    const deleted = deferred();
    const release = deferred();
    const deletion = first.transaction(async (tx) => {
      await tx.nodes.Person.delete(asNodeId<typeof Person>(bob.id));
      deleted.resolve();
      await release.promise;
    });
    await deleted.promise;

    const blocked = await rejection(second.edges.knows.create(alice, bob, {}));
    expect({ busy: isBusy(blocked), error: String(blocked) }).toMatchObject({
      busy: true,
    });

    release.resolve();
    await deletion;
    const refused = await rejection(second.edges.knows.create(alice, bob, {}));
    expect(refused).toBeInstanceOf(EndpointNotFoundError);
    expect(await first.edges.knows.findFrom(alice)).toEqual([]);
  });

  it("insert first: the delete cannot start, then cascades the committed edge", async () => {
    const { first, second } = await openStores();
    const inserted = deferred();
    const release = deferred();
    const creation = first.transaction(async (tx) => {
      await tx.edges.knows.create(alice, bob, {});
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;

    const blocked = await rejection(
      second.nodes.Person.delete(asNodeId<typeof Person>(bob.id)),
    );
    expect({ busy: isBusy(blocked), error: String(blocked) }).toMatchObject({
      busy: true,
    });

    release.resolve();
    await creation;
    await second.nodes.Person.delete(asNodeId<typeof Person>(bob.id));
    expect(await first.nodes.Person.getById(asNodeId(bob.id))).toBeUndefined();
    expect(await first.edges.knows.findFrom(alice)).toEqual([]);
  });
});
