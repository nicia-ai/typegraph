/**
 * Cancelling a graph export stream that nobody is going to finish pulling.
 *
 * An async generator's `finally` runs on `return()`, on `break`, and on
 * `throw` — and on nothing else. A consumer that pulls `next()` and then drops
 * the iterator (`Promise.race([iterator.next(), timeout])`, then move on) never
 * reaches any of them, so before #429 the export's repeatable-read snapshot
 * transaction stayed open for the life of the process. On a serialized
 * connection that also stranded the connection's EXCLUSIVE stream lease, so
 * every later export and every later import on it was refused — typed, correct,
 * and permanent — on behalf of a stream nobody was reading.
 *
 * `ExportStreamOptions.signal` is the contract-grade answer, and these are its
 * invariants:
 *
 * 1. Aborting settles the producer: the snapshot transaction is rolled back and
 *    the serialized connection's lease released, whether or not anyone is
 *    waiting on `next()`.
 * 2. The consumer is told, not left hanging: whoever is waiting on `next()`
 *    when the abort lands — and a consumer that walked away and comes back —
 *    gets `ExportStreamCancelledError` (code
 *    `INTERCHANGE_EXPORT_STREAM_ABORTED`), carrying the signal's own reason as
 *    `cause`.
 * 3. An already-aborted signal refuses the export outright — no transaction is
 *    opened and no lease is claimed, so there is nothing to give back.
 * 4. Cancellation is scoped to the cancelled stream: the connection is
 *    immediately usable by the next export, the next import, and ordinary
 *    writes.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { acquireSerializedStreamLease } from "../src/backend/transaction-resource";
import { type GraphBackend } from "../src/backend/types";
import {
  exportGraph,
  exportGraphStream,
  type GraphInterchangeChunk,
  importGraphStream,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore } from "../src/store";
import { raceTimeout, TIMEOUT_SENTINEL } from "./concurrency-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const sourceGraph = defineGraph({
  id: "export_cancellation_source",
  nodes: { Person: { type: Person } },
  edges: {},
});

/** A second graph on the SAME connection: the import target and the write probe. */
const targetGraph = defineGraph({
  id: "export_cancellation_target",
  nodes: { Person: { type: Person } },
  edges: {},
});

const importOptions = ImportOptionsSchema.parse({ onConflict: "error" });

/**
 * A leaked snapshot does not fail — it WAITS, on a connection that never frees
 * up. Every assertion about a cancelled stream is therefore bounded: a
 * regression must report itself as a failure rather than hang the suite.
 */
const SETTLE_TIMEOUT_MS = 5000;

/**
 * Lets the already-scheduled work run without pulling the stream: the abort's
 * rollback and lease release are the producer's own continuations, so they need
 * a turn of the loop and nothing else.
 */
async function drainMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function withinBudget<T>(work: Promise<T>, what: string): Promise<T> {
  const settled = await raceTimeout(work, SETTLE_TIMEOUT_MS);
  if (settled === TIMEOUT_SENTINEL) {
    throw new Error(
      `${what} did not settle within ${SETTLE_TIMEOUT_MS}ms: the cancelled export is still holding its snapshot transaction.`,
    );
  }
  return settled;
}

/**
 * Whether the connection's one interchange-stream lease is free right now.
 *
 * Asked by claiming and giving straight back — the lease offers no way to look
 * without claiming, by design (see `acquireSerializedStreamLease`). A cancelled
 * export that failed to release would be reported here as `false`.
 */
function streamLeaseIsFree(backend: GraphBackend): boolean {
  const lease = acquireSerializedStreamLease(backend, "export-snapshot");
  if (!lease.acquired) return false;
  lease.release();
  return true;
}

describe("Export stream cancellation", () => {
  const openDatabases: Database.Database[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) database.close();
  });

  function openMigratedDatabase(): Database.Database {
    const database = new Database(":memory:");
    openDatabases.push(database);
    for (const statement of generateSqliteDDL()) database.exec(statement);
    return database;
  }

  async function seedSource(nodeCount: number): Promise<{
    database: Database.Database;
    sourceBackend: GraphBackend;
    targetBackend: GraphBackend;
    source: ReturnType<typeof createStore<typeof sourceGraph>>;
    target: ReturnType<typeof createStore<typeof targetGraph>>;
  }> {
    const database = openMigratedDatabase();
    const sourceBackend = createSqliteBackend(drizzle(database));
    const targetBackend = createSqliteBackend(drizzle(database));
    const source = createStore(sourceGraph, sourceBackend);
    const target = createStore(targetGraph, targetBackend);
    for (let index = 0; index < nodeCount; index++) {
      await source.nodes.Person.create(
        { name: `Person ${index}` },
        { id: `person-${index}` },
      );
    }
    return { database, sourceBackend, targetBackend, source, target };
  }

  it("settles the snapshot and frees the connection when an abandoned stream is aborted", async () => {
    // The exact #429 reproduction: pull one chunk, drop the iterator without
    // calling return(), and abort instead. Before the signal existed there was
    // no way to reach the generator's finally from here at all.
    const { sourceBackend, source, target } = await seedSource(4);
    const controller = new AbortController();
    const iterator = exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    const header = await withinBudget(iterator.next(), "the first pull");
    expect(header.done).toBe(false);
    const firstNodes = await withinBudget(iterator.next(), "the second pull");
    expect(firstNodes.value).toMatchObject({ type: "nodes" });
    // The snapshot is open and the connection is spoken for.
    expect(streamLeaseIsFree(sourceBackend)).toBe(false);

    controller.abort();
    // Nothing is pulled here — an abandoned consumer never pulls again, and
    // that is the whole point. The producer unwinds through the driver's
    // ROLLBACK, so the release lands a turn later rather than synchronously
    // with abort().
    await withinBudget(drainMicrotasks(), "the abort's rollback");

    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
    // ...and the transaction is really closed: better-sqlite3 refuses a nested
    // BEGIN, so a write that succeeds proves the snapshot was rolled back.
    await withinBudget(
      target.nodes.Person.create({ name: "After" }, { id: "after-abort" }),
      "a write on the freed connection",
    );
    const reexported = await withinBudget(
      exportGraph(source),
      "a fresh export on the freed connection",
    );
    expect(reexported.nodes).toHaveLength(4);
  });

  it("rejects the in-flight and every later next() with a typed cancellation", async () => {
    const { source } = await seedSource(4);
    const controller = new AbortController();
    const iterator = exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await withinBudget(iterator.next(), "the header pull");

    // In flight: the consumer is parked in next() when the abort lands.
    const inFlight = iterator.next();
    await Promise.resolve();
    controller.abort(new Error("the caller gave up"));

    await expect(
      withinBudget(inFlight, "the in-flight pull"),
    ).rejects.toMatchObject({
      name: "ExportStreamCancelledError",
      code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
      details: { graphId: sourceGraph.id },
    });
    // The signal's own reason is preserved rather than replaced.
    await expect(inFlight).rejects.toMatchObject({
      cause: { message: "the caller gave up" },
    });
    // Throwing out of an async generator terminates it, so the pull AFTER the
    // rejection reports a finished iterator rather than repeating the error.
    // That is the language's contract for every generator, cancelled or not —
    // pinned here so "the consumer is told once" is stated rather than assumed.
    expect(
      await withinBudget(iterator.next(), "a pull after the abort"),
    ).toEqual({ value: undefined, done: true });
  });

  it("tells a consumer that comes back to an abandoned stream why it ended", async () => {
    // The other half of invariant 2: when the abort lands there is NO pending
    // next() to reject — the consumer walked away mid-stream. The cancellation
    // has to be waiting for it if it ever returns, or a consumer that raced a
    // timeout and then retried would read a truncated export as a complete one.
    const { source } = await seedSource(4);
    const controller = new AbortController();
    const iterator = exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await withinBudget(iterator.next(), "the header pull");
    await withinBudget(iterator.next(), "the first node pull");

    controller.abort();

    const reported = await withinBudget(
      iterator.next().then(
        () => new Error("the export was not cancelled"),
        (error: unknown) => error,
      ),
      "the pull after the abandoned abort",
    );

    expect(reported).toMatchObject({
      name: "ExportStreamCancelledError",
      code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
    });
    // The transactional arm of the capability-scoped message: this backend DID
    // hold a snapshot and a connection, and the consumer is told both were
    // given back. The non-transactional arm below says something different,
    // because for it neither was ever true.
    expect((reported as Error).message).toContain(
      "repeatable-read snapshot has been rolled back",
    );
  });

  it("refuses an already-aborted export without opening a transaction", async () => {
    const { sourceBackend, source, target } = await seedSource(2);
    const controller = new AbortController();
    controller.abort();
    const beginExport = vi.spyOn(sourceBackend, "transaction");

    await expect(
      withinBudget(
        // Through the NON-streaming surface: `signal` lives on the shared
        // export options, so both surfaces accept it and both honour it.
        exportGraph(source, { signal: controller.signal }),
        "the pre-aborted export",
      ),
    ).rejects.toMatchObject({
      name: "ExportStreamCancelledError",
      code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
    });

    // Nothing was opened, so there is nothing to give back — and nothing was
    // taken from the next stream either.
    expect(beginExport).not.toHaveBeenCalled();
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
    const imported = await withinBudget(
      importGraphStream(
        target,
        collectedChunks(await collectChunks(exportGraphStream(source))),
        importOptions,
      ),
      "an import after the refused export",
    );
    expect(imported.success).toBe(true);
  });

  it("settles an abort raised synchronously by the driver while the transaction is opening", async () => {
    // P1-3. The abort lands in the ONE window a listener registered after
    // `backend.transaction(...)` returned could not see: inside that call,
    // synchronously, before it produced a promise. An `AbortSignal` does not
    // replay `abort` to a listener that arrives late, so the event was
    // delivered to nobody — the export went on to deliver its header with
    // `signal.aborted === true`, holding the snapshot AND the connection's
    // lease for the life of the process.
    const { sourceBackend, source, target } = await seedSource(4);
    const controller = new AbortController();
    const runTransaction = sourceBackend.transaction;
    vi.spyOn(sourceBackend, "transaction").mockImplementation(
      (run, options) => {
        // The driver's own wrapper aborting mid-open: a deadline enforced around
        // connection checkout, a pool shutting down, a caller's cancellation
        // plumbed into the adapter.
        controller.abort(
          new Error("aborted while the transaction was opening"),
        );
        return runTransaction(run, options);
      },
    );

    const iterator = exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();

    // Captured rather than asserted, so the LEASE is checked first: the leak
    // is the symptom that outlives the process, and it must be the assertion
    // that reports the regression. (With the subscription made after
    // `transaction()` returns, this pull resolves with the header instead.)
    const outcome = await withinBudget(
      iterator.next().then(
        (delivered) => ({ delivered }),
        (error: unknown) => ({ error }),
      ),
      "the pull that opens the transaction",
    );

    // The lease is released: the connection is free for the next stream, even
    // though this consumer never pulled again.
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
    // ...and the consumer is told, rather than handed a header from a snapshot
    // that was already cancelled.
    expect(outcome).toMatchObject({
      error: {
        name: "ExportStreamCancelledError",
        code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
        details: { graphId: sourceGraph.id },
      },
    });
    // ...and the snapshot really settled — better-sqlite3 refuses a nested
    // BEGIN, so a write that succeeds proves the rollback ran.
    vi.restoreAllMocks();
    await withinBudget(
      target.nodes.Person.create({ name: "After" }, { id: "after-open-abort" }),
      "a write on the freed connection",
    );
    const imported = await withinBudget(
      importGraphStream(
        target,
        collectedChunks(await collectChunks(exportGraphStream(source))),
        importOptions,
      ),
      "an import after the aborted open",
    );
    expect(imported.success).toBe(true);
  });

  it("settles a non-transactional export aborted during its first read", async () => {
    // The other branch of the same ordering. A `transactionMode: "none"` export
    // opens no transaction and claims no lease, so it has nothing to strand —
    // but it still has to TELL its consumer, and its first read is the same
    // kind of pre-subscription window the transactional branch had. One
    // subscription placed before `beginProducer` covers both branches, which is
    // why there is no second arm here to keep in step.
    const database = openMigratedDatabase();
    const backend = createSqliteBackend(drizzle(database), {
      executionProfile: { transactionMode: "none", isSync: true },
    });
    expect(backend.capabilities.transactions).toBe(false);
    const source = createStore(sourceGraph, backend);
    await source.nodes.Person.create({ name: "Alice" }, { id: "no-tx-abort" });
    const controller = new AbortController();
    const readActiveSchema = backend.getActiveSchema;
    vi.spyOn(backend, "getActiveSchema").mockImplementation((graphId) => {
      controller.abort(new Error("aborted during the first read"));
      return readActiveSchema(graphId);
    });

    const reported = await withinBudget(
      collectChunks(
        exportGraphStream(source, { signal: controller.signal }),
      ).then(
        () => new Error("the export was not cancelled"),
        (error: unknown) => error,
      ),
      "the aborted non-transactional export",
    );

    expect(reported).toMatchObject({
      name: "ExportStreamCancelledError",
      code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
    });
    // The message is CAPABILITY-scoped: this export never opened a snapshot and
    // never claimed a connection, so it must not report rolling one back (the
    // transactional arm above does) — and it owes the consumer what IS true of
    // it, which is that the chunks delivered were never one point in time.
    expect((reported as Error).message).toContain(
      "does not support transactions",
    );
    expect((reported as Error).message).not.toContain("has been rolled back");

    // Nothing was ever held, so nothing had to be given back.
    expect(streamLeaseIsFree(backend)).toBe(true);
  });

  it("refuses an export whose options getter aborts during parsing", async () => {
    // The mirror window, on the other side of the subscription: `parse` reads
    // the caller's options object BEFORE any listener exists, so a getter that
    // aborts there raises an event the stream can never be told about. Only
    // re-checking `signal.aborted` after subscribing catches it — which is why
    // the re-check is not ceremony.
    const { sourceBackend, source } = await seedSource(2);
    const controller = new AbortController();
    const beginExport = vi.spyOn(sourceBackend, "transaction");
    const options = {
      signal: controller.signal,
      get batchSize(): number {
        controller.abort(new Error("aborted from an options getter"));
        return 2;
      },
    };

    await expect(
      withinBudget(
        collectChunks(exportGraphStream(source, options)),
        "the export whose parse aborted",
      ),
    ).rejects.toMatchObject({
      name: "ExportStreamCancelledError",
      code: "INTERCHANGE_EXPORT_STREAM_ABORTED",
    });

    expect(beginExport).not.toHaveBeenCalled();
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
  });

  it("releases the caller's signal when a refused stream never opens", async () => {
    // Both give-back paths through `beginProducer` run with the subscription
    // already made, so both owe the caller's signal its listener back. The
    // lease refusal is the one that takes nothing else.
    const { sourceBackend, source } = await seedSource(2);
    const controller = new AbortController();
    const unsubscribe = vi.spyOn(controller.signal, "removeEventListener");
    // A stream already holds this connection, so the export below is refused
    // before it opens anything.
    const holder = acquireSerializedStreamLease(sourceBackend, "import-stream");
    expect(holder.acquired).toBe(true);

    try {
      await expect(
        withinBudget(
          collectChunks(
            exportGraphStream(source, { signal: controller.signal }),
          ),
          "the refused export",
        ),
      ).rejects.toMatchObject({ name: "ConfigurationError" });
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      if (holder.acquired) holder.release();
    }
  });

  it("releases the caller's signal when the stream settles on its own", async () => {
    // The signal belongs to the CALLER and routinely outlives one stream (one
    // controller per job, several exports inside it). A settled stream that
    // stayed subscribed would keep its generator's scope reachable from that
    // signal for as long as the caller held it — the very retention this
    // module is about, moved one level out.
    const { sourceBackend, source } = await seedSource(2);
    const controller = new AbortController();
    const subscribe = vi.spyOn(controller.signal, "addEventListener");
    const unsubscribe = vi.spyOn(controller.signal, "removeEventListener");

    const chunks = await withinBudget(
      collectChunks(
        exportGraphStream(source, { signal: controller.signal, batchSize: 1 }),
      ),
      "the complete export",
    );
    expect(chunks.filter((chunk) => chunk.type === "nodes")).toHaveLength(2);

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribe.mock.calls[0]?.[1]).toBe(subscribe.mock.calls[0]?.[1]);

    // And a late abort on that reused controller reports nothing: the export
    // finished, so there is no cancellation to manufacture for it.
    controller.abort();
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
    const reexported = await withinBudget(
      exportGraph(source),
      "an export after the late abort",
    );
    expect(reexported.nodes).toHaveLength(2);
  });

  it("reports the producer's own failure, not a cancellation, when a signal is armed", async () => {
    // A signal must not change what a FAILING export tells its consumer. The
    // rendezvous makes the two outcomes mutually exclusive by construction —
    // the producer is blocked in `push` whenever the consumer is parked at a
    // yield, so it can only fail while the consumer is waiting for it, and the
    // failure reaches that waiting pull directly.
    const { sourceBackend, source } = await seedSource(4);
    const readFailure = new Error("snapshot read failed mid-stream");
    failNodeReadsAfter(sourceBackend, 1, readFailure);
    const controller = new AbortController();
    const iterator = exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    await withinBudget(iterator.next(), "the header pull");
    await withinBudget(iterator.next(), "the first node pull");

    await expect(
      withinBudget(iterator.next(), "the pull that fails"),
    ).rejects.toBe(readFailure);

    // The failed export gave the connection back, exactly as an aborted one
    // does, so the signal is left with nothing to cancel.
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
    controller.abort();
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
  });

  it("leaves a cooperative exit reporting a clean end, not a cancellation", async () => {
    // break out of `for await` already settled correctly; the signal must not
    // change what that path reports.
    const { sourceBackend, source } = await seedSource(4);
    const controller = new AbortController();
    const seen: GraphInterchangeChunk[] = [];

    for await (const chunk of exportGraphStream(source, {
      batchSize: 1,
      signal: controller.signal,
    })) {
      seen.push(chunk);
      if (seen.length === 2) break;
    }

    expect(seen).toHaveLength(2);
    expect(streamLeaseIsFree(sourceBackend)).toBe(true);
  });
});

/**
 * Makes the snapshot transaction's node reads fail once `deliveredReads` of
 * them have answered, so the export's producer fails MID-STREAM: chunks already
 * handed to the consumer, and the failure still to be delivered.
 */
function failNodeReadsAfter(
  backend: GraphBackend,
  deliveredReads: number,
  error: unknown,
): void {
  const runTransaction = backend.transaction;
  const failing: GraphBackend["transaction"] = (run, options) => {
    let reads = 0;
    return runTransaction(
      (target) =>
        run({
          ...target,
          findNodesByKind: async (params) => {
            reads += 1;
            if (reads > deliveredReads) throw error;
            return target.findNodesByKind(params);
          },
        }),
      options,
    );
  };
  vi.spyOn(backend, "transaction").mockImplementation(failing);
}

async function collectChunks(
  chunks: AsyncIterable<GraphInterchangeChunk>,
): Promise<GraphInterchangeChunk[]> {
  const collected: GraphInterchangeChunk[] = [];
  for await (const chunk of chunks) collected.push(chunk);
  return collected;
}

/** Replays already-collected chunks, so no export transaction is open. */
async function* collectedChunks(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) yield await Promise.resolve(chunk);
}
