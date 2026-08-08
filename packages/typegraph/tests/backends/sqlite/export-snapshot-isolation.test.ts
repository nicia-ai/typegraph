/**
 * The export snapshot, demonstrated against a concurrent writer (#432).
 *
 * `exportGraphStream` opens ONE `repeatable_read` / `read_only` transaction and
 * paginates every node, edge, and identity page inside it. The contract that
 * buys is: a consumer that reads the stream slowly still gets ONE point in time,
 * not a mixture of the graph as it was at chunk 1 and as it is at chunk 5 —
 * which is what makes a streamed export a usable backup or a working-copy seed.
 *
 * Until now that contract was guarded only by a spy asserting the transaction
 * was REQUESTED with those options. That proves nothing about what the engine
 * does with them. These tests commit a real write between two chunks and assert
 * the remaining chunks still report the pre-write graph.
 *
 * ## Why two connections
 *
 * The concurrent writer has to be genuinely independent. A write through the
 * SAME serialized connection is now REFUSED by the exclusive stream lease (that
 * is the #427/#429 guard doing its job), and a write through the same
 * better-sqlite3 handle would in any case queue behind the export's own
 * transaction rather than race it. Two better-sqlite3 handles on one WAL file
 * are the honest construction: SQLite's own concurrency model, one writer
 * alongside any number of readers, each reader pinned to the snapshot its
 * transaction began on.
 *
 * The PostgreSQL half of this pair lives in
 * `tests/backends/postgres/export-snapshot-isolation.test.ts` and runs in the
 * server lane (`pnpm test:postgres`); PGlite cannot express it at all, being a
 * single connection.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineGraph, defineNode } from "../../../src";
import { generateSqliteDDL } from "../../../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import {
  exportGraphStream,
  type GraphInterchangeChunk,
  type InterchangeNode,
} from "../../../src/interchange";
import { createStore } from "../../../src/store";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "export_snapshot_isolation",
  nodes: { Person: { type: Person } },
  edges: {},
});

/**
 * Ids are exported in `ORDER BY id`, so zero-padding makes "which page is a row
 * on" a property of the test rather than of insertion order: with
 * `batchSize: 2`, `person-05` is on the third page and is therefore still
 * unread when the concurrent write lands.
 */
const SEEDED_IDS = [
  "person-01",
  "person-02",
  "person-03",
  "person-04",
  "person-05",
  "person-06",
] as const;

/** The row the concurrent writer changes: on a page the export has NOT reached. */
const LATE_PAGE_ID = "person-05";
/** The row the concurrent writer inserts: sorts last, so also on a later page. */
const INSERTED_ID = "person-99";

async function seed(
  store: ReturnType<typeof createStore<typeof graph>>,
): Promise<void> {
  for (const id of SEEDED_IDS) {
    await store.nodes.Person.create({ name: `original ${id}` }, { id });
  }
}

function exportedNodes(
  chunks: readonly GraphInterchangeChunk[],
): InterchangeNode[] {
  return chunks.flatMap((chunk) =>
    chunk.type === "nodes" ? [...chunk.nodes] : [],
  );
}

describe("SQLite export snapshot isolation across two WAL connections", () => {
  const openDatabases: Database.Database[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const database of openDatabases.splice(0)) database.close();
    for (const directory of temporaryDirectories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * One WAL database file with TWO independent connections on it: the reader
   * the export streams from, and a writer that is not queued behind it.
   */
  async function openWalPair(): Promise<{
    readerDatabase: Database.Database;
    writerDatabase: Database.Database;
  }> {
    const directory = await mkdtemp(path.join(tmpdir(), "typegraph-snapshot-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "graph.db");
    const readerDatabase = new Database(file);
    openDatabases.push(readerDatabase);
    readerDatabase.pragma("journal_mode = WAL");
    readerDatabase.pragma("busy_timeout = 5000");
    for (const statement of generateSqliteDDL()) readerDatabase.exec(statement);
    const writerDatabase = new Database(file);
    openDatabases.push(writerDatabase);
    writerDatabase.pragma("busy_timeout = 5000");
    return { readerDatabase, writerDatabase };
  }

  it("keeps a mid-stream write out of the pages the export has not read yet", async () => {
    const { readerDatabase, writerDatabase } = await openWalPair();
    const reader = createStore(
      graph,
      createSqliteBackend(drizzle(readerDatabase)),
    );
    const writer = createStore(
      graph,
      createSqliteBackend(drizzle(writerDatabase)),
    );
    await seed(reader);

    const iterator = exportGraphStream(reader, {
      batchSize: 2,
    })[Symbol.asyncIterator]();
    const delivered: GraphInterchangeChunk[] = [];
    // Header + the first page. The snapshot transaction is open and has read
    // person-01/02; person-05 and everything after it are still to come.
    const header = await iterator.next();
    expect(header.value).toMatchObject({ type: "header" });
    const firstPage = await iterator.next();
    expect(firstPage.value).toMatchObject({ type: "nodes" });
    delivered.push(firstPage.value as GraphInterchangeChunk);

    // The concurrent writer commits BOTH kinds of change the snapshot has to
    // hide: a modification to a row on a page the export has not reached, and
    // a brand-new row that would otherwise appear in one.
    await writer.nodes.Person.update(asNodeId(LATE_PAGE_ID), {
      name: "MUTATED",
    });
    await writer.nodes.Person.create(
      { name: "inserted mid-export" },
      { id: INSERTED_ID },
    );
    // ...and the write really did land, on the file the export is reading.
    const rewritten = await writer.nodes.Person.getById(asNodeId(LATE_PAGE_ID));
    expect(rewritten?.name).toBe("MUTATED");
    expect(await writer.nodes.Person.count()).toBe(SEEDED_IDS.length + 1);

    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      delivered.push(next.value);
    }

    const nodes = exportedNodes(delivered);
    // Exactly the pre-write graph: the inserted row is absent...
    expect(nodes.map((node) => node.id)).toEqual([...SEEDED_IDS]);
    // ...and the modified row still reads as it did when the snapshot opened,
    // even though its page was fetched after the commit.
    expect(
      nodes.find((node) => node.id === LATE_PAGE_ID)?.properties["name"],
    ).toBe(`original ${LATE_PAGE_ID}`);
  });

  it("shows the same interleaving WITHOUT a snapshot, so the snapshot is what makes the difference", async () => {
    // The control. A `transactionMode: "none"` backend declares it cannot open
    // the export's snapshot transaction, so its export paginates statement by
    // statement — and then the very same interleaving DOES leak the concurrent
    // writer into later pages. This is the behaviour the first test's contract
    // exists to exclude, pinned so a regression that quietly drops the snapshot
    // cannot look like a passing suite.
    const { readerDatabase, writerDatabase } = await openWalPair();
    const readerBackend = createSqliteBackend(drizzle(readerDatabase), {
      executionProfile: { transactionMode: "none", isSync: true },
    });
    expect(readerBackend.capabilities.transactions).toBe(false);
    const reader = createStore(graph, readerBackend);
    const writer = createStore(
      graph,
      createSqliteBackend(drizzle(writerDatabase)),
    );
    await seed(reader);

    const iterator = exportGraphStream(reader, {
      batchSize: 2,
    })[Symbol.asyncIterator]();
    const delivered: GraphInterchangeChunk[] = [];
    await iterator.next();
    const firstPage = await iterator.next();
    delivered.push(firstPage.value as GraphInterchangeChunk);

    await writer.nodes.Person.update(asNodeId(LATE_PAGE_ID), {
      name: "MUTATED",
    });
    await writer.nodes.Person.create(
      { name: "inserted mid-export" },
      { id: INSERTED_ID },
    );

    for (;;) {
      const next = await iterator.next();
      if (next.done === true) break;
      delivered.push(next.value);
    }

    const nodes = exportedNodes(delivered);
    expect(nodes.map((node) => node.id)).toContain(INSERTED_ID);
    expect(
      nodes.find((node) => node.id === LATE_PAGE_ID)?.properties["name"],
    ).toBe("MUTATED");
  });
});
