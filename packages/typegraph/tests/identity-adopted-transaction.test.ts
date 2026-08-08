/**
 * #447: identity mutations inside a transaction TypeGraph did not open.
 *
 * The per-graph identity locks (`lockIdentityGraph`, `lockIdentityDdl`) are
 * no-ops on SQLite because the engine's single writer slot already serializes
 * writers — true for every transaction TypeGraph opens itself, which is
 * `BEGIN IMMEDIATE` and therefore a writer from its first statement.
 * `store.withTransaction(externalTx)` adopts a frame the CALLER began, and a
 * caller's `BEGIN` is DEFERRED: a reader until its first write. An identity
 * fold reads and then writes, so under a deferred frame the write can find the
 * snapshot stale and be refused the upgrade.
 *
 * The invariant this file states: an identity mutation never fails with a raw
 * driver error because of how its transaction was begun. It is serialized (the
 * writer slot was taken first — the IMMEDIATE case below), or refused with a
 * typed error naming the adopted deferred frame and the remedy. It is never
 * retried in place, because SQLite's own contract for a stale snapshot is that
 * the transaction must be rolled back.
 *
 * Determinism comes from two connections to one WAL file (the idiom in
 * `interchange.test.ts`'s two-handle tests) with the racing commit injected at
 * the exact point between the adopted frame's read and its identity write —
 * not raced for.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { getTableName } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AdapterStore,
  createAdapterStoreWithSchema,
  defineGraph,
  defineNode,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables as defaultTables } from "../src/backend/sqlite";
import { ConfigurationError } from "../src/errors";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});

const identityGraph = defineGraph({
  id: "identity_adopted_transaction",
  nodes: { Person: { type: Person }, Author: { type: Author } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
type IdentityGraph = typeof identityGraph;

type Handles = Readonly<{
  store: AdapterStore<IdentityGraph, never>;
  owner: Database.Database;
  ownerDb: ReturnType<typeof drizzle>;
  other: Database.Database;
  directory: string;
}>;

const openHandles: Database.Database[] = [];
const openDirectories: string[] = [];

afterEach(async () => {
  for (const handle of openHandles.splice(0)) {
    try {
      if (handle.inTransaction) handle.exec("ROLLBACK");
    } catch {
      // A connection whose transaction already failed needs no rollback.
    }
    handle.close();
  }
  for (const directory of openDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * One WAL database file with two independent connections: `owner` carries the
 * store (and the transaction under test), `other` is the concurrent writer.
 */
async function openTwoConnections(): Promise<Handles> {
  const directory = await mkdtemp(path.join(tmpdir(), "typegraph-identity-"));
  openDirectories.push(directory);
  const file = path.join(directory, "graph.db");

  const owner = new Database(file);
  openHandles.push(owner);
  owner.pragma("journal_mode = WAL");
  for (const statement of generateSqliteDDL(defaultTables)) {
    owner.exec(statement);
  }
  // No busy timeout: a blocked writer must fail immediately rather than stall
  // the suite waiting for a lock the test is asserting about.
  const other = new Database(file, { timeout: 0 });
  openHandles.push(other);

  const ownerDb = drizzle(owner);
  const backend = createSqliteBackend(ownerDb, {
    executionProfile: { isSync: true },
    tables: defaultTables,
  });
  const [store] = await createAdapterStoreWithSchema(identityGraph, backend);
  await store.nodes.Person.create({ name: "Ada" }, { id: "shared" });
  await store.nodes.Author.create({ penName: "A. L." }, { id: "author" });

  return {
    store: store as unknown as AdapterStore<IdentityGraph, never>,
    owner,
    ownerDb,
    other,
    directory,
  };
}

/** A committed write from the OTHER connection — the racing writer. */
function commitFromOtherConnection(handles: Handles, id: string): void {
  const stamp = "2026-01-01T00:00:00.000Z";
  handles.other
    .prepare(
      `INSERT INTO ${getTableName(defaultTables.nodes)} ` +
        "(graph_id, kind, id, props, created_at, updated_at, version) " +
        "VALUES (?, 'Person', ?, '{\"name\":\"Racer\"}', ?, ?, 1)",
    )
    .run(identityGraph.id, id, stamp, stamp);
}

describe("identity mutations on an adopted SQLite transaction", () => {
  it("refuses with a typed error when a DEFERRED frame lost the writer slot", async () => {
    const handles = await openTwoConnections();

    // The caller's own BEGIN: deferred, which is what `BEGIN` means.
    handles.owner.exec("BEGIN");
    const tx = handles.store.withTransaction(
      handles.ownerDb as unknown as never,
    );
    // A read through the adopted context fixes the frame's snapshot.
    await tx.nodes.Person.find();

    // The window: another connection commits before the identity write.
    commitFromOtherConnection(handles, "racer-1");

    const refusal = await tx.identity
      .assertSame(
        { kind: "Person", id: "shared" },
        { kind: "Author", id: "author" },
      )
      .then(
        (committed): unknown => committed,
        (error: unknown) => error,
      );

    expect(refusal).toBeInstanceOf(ConfigurationError);
    const typed = refusal as ConfigurationError;
    // The refusal names the cause and the remedy. SQLite's own message here is
    // the bare, undiagnosable "database is locked" — the raw error a caller
    // used to get told them neither.
    expect(typed.message).toMatch(/could not take the SQLite writer slot/u);
    expect(typed.message).toMatch(/begun DEFERRED/u);
    expect(typed.details).toMatchObject({
      code: "IDENTITY_TRANSACTION_NOT_WRITE_FENCED",
    });
    expect(typed.suggestion).toContain("BEGIN IMMEDIATE");
    expect(typed.cause).toBeDefined();
  });

  it("serializes the identity mutation when the adopted frame is IMMEDIATE", async () => {
    const handles = await openTwoConnections();

    // The remedy the refusal names. The frame holds the writer slot from the
    // start, so the racing writer is the one refused and the identity fold
    // runs serialized — the premise the SQLite lock no-op assumes.
    handles.owner.exec("BEGIN IMMEDIATE");
    const tx = handles.store.withTransaction(
      handles.ownerDb as unknown as never,
    );
    await tx.nodes.Person.find();

    expect(() => {
      commitFromOtherConnection(handles, "racer-2");
    }).toThrow(/database is locked/u);

    const assertion = await tx.identity.assertSame(
      { kind: "Person", id: "shared" },
      { kind: "Author", id: "author" },
    );
    expect(assertion).toBeDefined();
    handles.owner.exec("COMMIT");

    // Committed and readable from a fresh statement on the owner connection.
    expect(
      await handles.store.identity.assertionsOf({
        kind: "Person",
        id: "shared",
      }),
    ).toHaveLength(1);
  });

  it("commits normally on a DEFERRED frame that nothing raced", async () => {
    const handles = await openTwoConnections();

    // The control: a deferred adopted frame is not refused for BEING deferred.
    // Only a snapshot another connection invalidated is.
    handles.owner.exec("BEGIN");
    const tx = handles.store.withTransaction(
      handles.ownerDb as unknown as never,
    );
    await tx.nodes.Person.find();

    const assertion = await tx.identity.assertSame(
      { kind: "Person", id: "shared" },
      { kind: "Author", id: "author" },
    );
    expect(assertion).toBeDefined();
    handles.owner.exec("COMMIT");
  });
});
