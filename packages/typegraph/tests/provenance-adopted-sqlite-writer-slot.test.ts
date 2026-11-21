/**
 * Provenance's support reads in an ADOPTED SQLite transaction.
 *
 * SQLite's write fence is `engine-serialized`: a transaction TypeGraph opens
 * is `BEGIN IMMEDIATE`, so it holds the single writer slot before its first
 * read, and no other connection can commit while it decides. A transaction
 * the caller began and handed to `withRecordedTransaction` may instead be
 * DEFERRED: in WAL mode it is a reader until its first write, and another
 * connection can commit after its read snapshot was fixed. A retraction verb
 * that read support from that snapshot could decide on a graph that no longer
 * exists — and, when the stale snapshot says there is nothing to write, return
 * success without a write that would have exposed it.
 *
 * The verb therefore takes the writer slot on an adopted session before its
 * first support read (`ensureAdoptedWriterSlot`, the store's one owner of that
 * step, shared with constrained writes). Taking the slot either succeeds,
 * and then no commit can land after this point and the snapshot is current,
 * or SQLite refuses the upgrade of a snapshot another connection has since
 * overtaken (`SQLITE_BUSY_SNAPSHOT`), which the verb reports as a
 * `TransactionConflictError`: the caller rolls back and re-runs the
 * transaction. `withRecordedTransaction` itself reads at adoption (its schema
 * fence), so an adopted recorded transaction always has a snapshot by the
 * time the verb runs.
 *
 * Determinism: two connections to one WAL file, with the competing commit made
 * from the second connection at the exact point between the adopted
 * transaction's snapshot and the verb.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type Client,
  createClient,
  type InStatement,
  type Transaction,
} from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables } from "../src/backend/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { TransactionConflictError } from "../src/errors";
import { createRetractionCapability } from "../src/provenance";
import type { AdapterHistoryStore } from "../src/store/store";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "provenance_adopted_writer_slot",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const SOURCE = { kind: "Source", id: "source" } as const;
const FACT = { kind: "Fact", id: "fact" } as const;

/** The zero-row UPDATE that takes SQLite's writer slot. */
const WRITER_SLOT_STATEMENT = "SET graph_id = graph_id WHERE 0";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function temporaryDatabaseFile(): Promise<string> {
  const directory = await mkdtemp(
    path.join(tmpdir(), "typegraph-provenance-writer-slot-"),
  );
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "graph.db");
}

/**
 * A store of {@link graph} whose adopted transactions take whatever native
 * handle the harness passes; each harness builds the handle its driver
 * adopts.
 */
type WriterSlotStore = AdapterHistoryStore<typeof graph, never>;

type AdoptedTransaction = Parameters<
  Parameters<WriterSlotStore["withRecordedTransaction"]>[1]
>[0];

type AdoptedWork<T> = (tx: AdoptedTransaction) => Promise<T>;

/**
 * One driver's two connections to one WAL database: the `owner` store, whose
 * adopted DEFERRED transaction is under test, and a `competitor` store on a
 * second connection that commits between that transaction's snapshot and
 * the verb.
 */
type Harness = Readonly<{
  store: WriterSlotStore;
  competitor: WriterSlotStore;
  /**
   * Every statement the owner connection prepared, in order (better-sqlite3),
   * or every statement the adopted transaction executed (libSQL).
   */
  ownerStatements: string[];
  /**
   * Runs `work` in a DEFERRED transaction the caller began on the owner
   * connection and adopted through `withRecordedTransaction`, committing it
   * when `work` resolves and rolling it back when it rejects.
   */
  inAdoptedDeferredTransaction: <T>(work: AdoptedWork<T>) => Promise<T>;
}>;

async function betterSqlite3Harness(): Promise<Harness> {
  const file = await temporaryDatabaseFile();
  const ownerStatements: string[] = [];
  const owner = new Database(file, {
    verbose: (statement) => ownerStatements.push(String(statement)),
  });
  owner.pragma("journal_mode = WAL");
  for (const statement of generateSqliteDDL(tables)) owner.exec(statement);
  const other = new Database(file, { timeout: 0 });
  cleanups.push(() => {
    if (owner.inTransaction) owner.exec("ROLLBACK");
    owner.close();
    other.close();
  });
  const ownerDb = drizzle(owner);
  const ownerBackend = createSqliteBackend(ownerDb, {
    executionProfile: { isSync: true },
    tables,
  });
  const otherBackend = createSqliteBackend(drizzle(other), {
    executionProfile: { isSync: true },
    tables,
  });
  const [store] = await createAdapterStoreWithSchema(graph, ownerBackend, {
    history: true,
  });
  const [competitor] = await createAdapterStoreWithSchema(graph, otherBackend, {
    history: true,
  });
  return {
    store: store as unknown as WriterSlotStore,
    competitor: competitor as unknown as WriterSlotStore,
    ownerStatements,
    inAdoptedDeferredTransaction: async (work) => {
      owner.exec("BEGIN");
      try {
        const outcome = await (
          store as unknown as WriterSlotStore
        ).withRecordedTransaction(ownerDb as never, work);
        owner.exec("COMMIT");
        return outcome.result;
      } catch (error) {
        if (owner.inTransaction) owner.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

async function libsqlHarness(): Promise<Harness> {
  const file = await temporaryDatabaseFile();
  const ownerClient = createClient({ url: `file:${file}` });
  await ownerClient.execute("PRAGMA journal_mode = WAL");
  const otherClient = createClient({ url: `file:${file}` });
  cleanups.push(() => {
    ownerClient.close();
    otherClient.close();
  });
  const owner = await createLibsqlBackend(ownerClient, { tables });
  const other = await createLibsqlBackend(otherClient, { tables });
  const [store] = await createAdapterStoreWithSchema(graph, owner.backend, {
    history: true,
  });
  const [competitor] = await createAdapterStoreWithSchema(
    graph,
    other.backend,
    { history: true },
  );
  const ownerStatements: string[] = [];
  return {
    store: store as unknown as WriterSlotStore,
    competitor: competitor as unknown as WriterSlotStore,
    ownerStatements,
    // Drizzle's libSQL `db.transaction()` always begins `IMMEDIATE` (it
    // drops its `behavior` option), so a deferred adopted transaction is the
    // caller's own: a client transaction begun DEFERRED, with a Drizzle
    // database over that transaction's dedicated connection.
    inAdoptedDeferredTransaction: async (work) => {
      const deferred = await ownerClient.transaction("deferred");
      try {
        const outcome = await (
          store as unknown as WriterSlotStore
        ).withRecordedTransaction(
          drizzleLibsql(
            recordingTransactionClient(deferred, ownerStatements),
          ) as never,
          work,
        );
        await deferred.commit();
        return outcome.result;
      } catch (error) {
        await deferred.rollback();
        throw error;
      } finally {
        deferred.close();
      }
    },
  };
}

function statementText(statement: InStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

/**
 * A client whose every statement runs on `transaction`'s connection and is
 * recorded first: libSQL has no statement hook, and Drizzle reaches the
 * connection only through `execute` and `batch`.
 */
function recordingTransactionClient(
  transaction: Transaction,
  statements: string[],
): Client {
  const client: Pick<Client, "execute" | "batch"> = {
    execute: (statement: InStatement) => {
      statements.push(statementText(statement));
      return transaction.execute(statement);
    },
    batch: (batch: InStatement[]) => {
      for (const statement of batch) statements.push(statementText(statement));
      return transaction.batch(batch);
    },
  };
  return client as Client;
}

const DRIVERS = [
  { driver: "better-sqlite3", harness: betterSqlite3Harness },
  { driver: "libSQL", harness: libsqlHarness },
] as const;

async function seed(harness: Harness) {
  const { store } = harness;
  const source = await store.nodes.Source.create(
    { label: "source", retracted: false },
    { id: SOURCE.id },
  );
  const fact = await store.nodes.Fact.create(
    { label: "fact" },
    { id: FACT.id },
  );
  const justification = await store.nodes.Justification.create(
    { label: "justification" },
    { id: "justification" },
  );
  await store.edges.premiseOf.create(source, justification);
  await store.edges.derives.create(justification, fact);
  return {
    provenance: createRetractionCapability(store, config),
    competitorProvenance: createRetractionCapability(
      harness.competitor,
      config,
    ),
  };
}

/**
 * The committed state, read on the competitor's connection. The owner's own
 * connection is not a reliable witness after a refusal on libSQL: its pooled
 * client keeps the refused transaction's stale read snapshot on that
 * connection even after `ROLLBACK` (observed with the bare client, without
 * TypeGraph), so a later autocommit read there can still see the old rows.
 */
async function sourceRetracted(harness: Harness): Promise<boolean> {
  const row = await harness.competitor.nodes.Source.getById(
    asNodeId<typeof Source>(SOURCE.id),
  );
  return row?.retracted === true;
}

async function factLive(harness: Harness): Promise<boolean> {
  const row = await harness.competitor.nodes.Fact.getById(
    asNodeId<typeof Fact>(FACT.id),
  );
  return row !== undefined;
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error,
  );
}

describe.each(DRIVERS)(
  "provenance verbs in an adopted DEFERRED SQLite transaction ($driver)",
  ({ harness: createHarness }) => {
    it("retract(source, tx) refuses a snapshot another connection overtook with a TransactionConflictError, instead of reporting a retraction that never happened", async () => {
      const harness = await createHarness();
      const { provenance, competitorProvenance } = await seed(harness);
      await provenance.retract(SOURCE);

      const error = await rejection(
        harness.inAdoptedDeferredTransaction(async (tx) => {
          // The adopted snapshot sees the source retracted.
          const seen = await tx.nodes.Source.getById(
            asNodeId<typeof Source>(SOURCE.id),
          );
          expect(seen?.retracted).toBe(true);
          // Another connection restores it and commits.
          await competitorProvenance.unRetract(SOURCE);
          return provenance.retract(SOURCE, tx);
        }),
      );

      expect(error).toBeInstanceOf(TransactionConflictError);
      expect((error as TransactionConflictError).details).toMatchObject({
        operation: "provenance.retract(source, tx)",
      });
      // The competitor's restore stands; nothing claims it was retracted.
      await expect(sourceRetracted(harness)).resolves.toBe(false);
      await expect(factLive(harness)).resolves.toBe(true);
    });

    it("assertHolds(tx) refuses a snapshot another connection overtook, instead of judging the fact it can no longer see", async () => {
      const harness = await createHarness();
      const { provenance, competitorProvenance } = await seed(harness);

      const error = await rejection(
        harness.inAdoptedDeferredTransaction(async (tx) => {
          await tx.nodes.Fact.getById(asNodeId<typeof Fact>(FACT.id));
          await competitorProvenance.retract(SOURCE);
          return provenance.assertHolds(tx, [FACT]);
        }),
      );

      expect(error).toBeInstanceOf(TransactionConflictError);
      expect((error as TransactionConflictError).details).toMatchObject({
        operation: "provenance.assertHolds()",
      });
    });

    it("holding(tx) in a writable adopted transaction refuses a snapshot another connection overtook", async () => {
      const harness = await createHarness();
      const { provenance, competitorProvenance } = await seed(harness);

      const error = await rejection(
        harness.inAdoptedDeferredTransaction(async (tx) => {
          await tx.nodes.Fact.getById(asNodeId<typeof Fact>(FACT.id));
          await competitorProvenance.retract(SOURCE);
          return provenance.holding(tx);
        }),
      );

      expect(error).toBeInstanceOf(TransactionConflictError);
      expect((error as TransactionConflictError).details).toMatchObject({
        operation: "provenance.holding(tx)",
      });
    });

    it("takes the writer slot before the first support read when nothing overtook the snapshot, and commits the retraction", async () => {
      const harness = await createHarness();
      const { provenance } = await seed(harness);

      harness.ownerStatements.length = 0;
      const report = await harness.inAdoptedDeferredTransaction(async (tx) =>
        provenance.retract(SOURCE, tx),
      );

      expect(report.died).toEqual([FACT]);
      await expect(sourceRetracted(harness)).resolves.toBe(true);
      await expect(factLive(harness)).resolves.toBe(false);
      const slot = harness.ownerStatements.findIndex((statement) =>
        statement.includes(WRITER_SLOT_STATEMENT),
      );
      // The first read of a graph row in the transaction — the verb's source
      // and support reads; the adoption itself reads only the schema row.
      const firstGraphRead = harness.ownerStatements.findIndex(
        (statement) =>
          !statement.includes(WRITER_SLOT_STATEMENT) &&
          /"typegraph_(?:nodes|edges)"/u.test(statement),
      );
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(firstGraphRead).toBeGreaterThan(slot);
    });
  },
);

describe("provenance verbs in a transaction TypeGraph opened on SQLite (better-sqlite3)", () => {
  it("issue no writer-slot statement: BEGIN IMMEDIATE already holds the slot", async () => {
    const harness = await betterSqlite3Harness();
    const { provenance } = await seed(harness);

    harness.ownerStatements.length = 0;
    await harness.store.transaction(async (tx) => {
      await provenance.assertHolds(tx, [FACT]);
      await provenance.holding(tx);
      await provenance.retract(SOURCE, tx);
    });
    await provenance.unRetract(SOURCE);

    expect(
      harness.ownerStatements.filter((statement) =>
        statement.includes(WRITER_SLOT_STATEMENT),
      ),
    ).toEqual([]);
  });
});
