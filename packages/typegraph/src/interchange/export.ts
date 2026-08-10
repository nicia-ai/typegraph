/**
 * Graph data export functionality.
 *
 * Exports nodes and edges from a store to the interchange format.
 */
import { acquireSerializedStreamLease } from "../backend/transaction-resource";
import {
  type GraphBackend,
  rowPropsToObject,
  type TransactionBackend,
} from "../backend/types";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import {
  ConfigurationError,
  ExportStreamCancelledError,
  ExportStreamIdleTimeoutError,
} from "../errors";
import { storeBackend, storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import { serializedStreamRefusal } from "./import";
import { markExportStreamBackend } from "./stream-source";
import {
  type ExportOptionsInput,
  type ExportStreamOptionsInput,
  ExportStreamOptionsSchema,
  FORMAT_VERSION,
  type GraphData,
  type GraphDataHeader,
  type GraphInterchangeChunk,
  type InterchangeEdge,
  type InterchangeIdentityAssertion,
  type InterchangeNode,
} from "./types";

// ============================================================
// Export Function
// ============================================================

/**
 * Export graph data from a store.
 *
 * @param store - The graph store to export from
 * @param options - Export configuration
 * @returns Graph data in interchange format
 *
 * @example
 * ```typescript
 * const data = await exportGraph(store, {
 *   nodeKinds: ["Person", "Organization"],
 *   includeMeta: true,
 * });
 *
 * // Write to file
 * await fs.writeFile("backup.json", JSON.stringify(data, null, 2));
 * ```
 */
export async function exportGraph<G extends GraphDef>(
  store: Store<G>,
  options?: ExportOptionsInput,
): Promise<GraphData> {
  const nodes: InterchangeNode[] = [];
  const edges: InterchangeEdge[] = [];
  const identityAssertions: InterchangeIdentityAssertion[] = [];
  let header: GraphDataHeader | undefined;
  for await (const chunk of exportGraphStream(store, options)) {
    switch (chunk.type) {
      case "header": {
        header = chunk.header;
        break;
      }
      case "nodes": {
        nodes.push(...chunk.nodes);
        break;
      }
      case "edges": {
        edges.push(...chunk.edges);
        break;
      }
      case "identity": {
        identityAssertions.push(...chunk.assertions);
        break;
      }
    }
  }
  if (header === undefined) {
    throw new Error("Graph export stream ended before emitting its header.");
  }
  const { identity, ...headerWithoutIdentity } = header;
  return {
    ...headerWithoutIdentity,
    nodes,
    edges,
    ...(identity === undefined ?
      {}
    : {
        identity: { ...identity, assertions: identityAssertions },
      }),
  };
}

/**
 * Exports a graph as bounded node and edge chunks. The stream always yields one
 * header, then every node chunk, then every edge chunk. Consumers that write to
 * a network, file, or fresh working copy can process one chunk at a time rather
 * than materializing a graph-sized {@link GraphData} value.
 *
 * ## One snapshot, WHERE THE BACKEND HAS TRANSACTIONS
 *
 * On a backend reporting `capabilities.transactions`, the whole export —
 * header, every node page, every edge page, every identity page — is read
 * inside ONE `repeatable_read` / `read_only` transaction, so a slow consumer
 * still gets one point in time rather than a mixture of the graph as it was at
 * the first chunk and as it is at the last.
 *
 * A backend WITHOUT transactions (SQLite `transactionMode: "none"`, the
 * session-less HTTP Postgres drivers) opens no such transaction: its export
 * paginates statement by statement, and a write committed mid-stream can appear
 * in the pages that follow. There is no way to offer the guarantee on an engine
 * that cannot frame the reads, so it is a declared capability gap rather than
 * something the stream pretends to. Callers needing a coherent export from such
 * a backend must quiesce writes for its duration.
 *
 * ## Stopping a stream you will not finish
 *
 * While a transactional stream is open it holds that snapshot transaction, and
 * on a serialized connection it holds the connection's one EXCLUSIVE stream
 * lease with it. Every cooperative exit settles both, because each runs the
 * generator's `finally`: `break` or `throw` out of a `for await`, and an
 * explicit `iterator.return()`. (A non-transactional stream holds neither, so
 * it has nothing to strand — but it still owes its consumer an answer, which
 * the same cancellation path gives it.)
 *
 * A consumer that pulls `next()` and then simply DROPS the iterator has no
 * cooperative exit — async-generator `finally` blocks do not run on garbage
 * collection — so it must pass {@link ExportOptions.signal} and abort it, or
 * configure {@link ExportStreamOptions.idleTimeoutMs}. The idle clock covers
 * only time after a chunk is delivered and before the consumer asks for the
 * next one; database read time is not consumer idleness. Without either
 * mechanism, the snapshot transaction stays open for the life of the process
 * and every later interchange stream on that connection is refused on behalf
 * of a stream nobody is reading.
 *
 * ### Why there is no garbage-collection safety net (#429)
 *
 * A `FinalizationRegistry` on the iterable cannot close this: it is not merely
 * unreliable here, it can never fire. The producer is interruptible in exactly
 * one place — it is parked in {@link RendezvousChannel.push} waiting for the
 * consumer, not in the database — so any cleanup state capable of settling an
 * abandoned stream has to reach that channel. A registry holds its held value
 * STRONGLY, and holding anything that reaches the channel's scope keeps the
 * abandoned generator permanently reachable: measured on Node 24, publishing
 * just `channel.abort` is enough to stop the stream being collected, while
 * publishing an unrelated object is not. The net's own bookkeeping would
 * therefore be what kept the entry from ever firing — a safety promise that
 * reads as protection and is not there. Explicit cancellation and the idle
 * timeout are the mechanisms, and they are contracts rather than hints.
 */
export function exportGraphStream<G extends GraphDef>(
  store: Store<G>,
  options?: ExportStreamOptionsInput,
): AsyncIterable<GraphInterchangeChunk> {
  const backend = storeBackend(store);
  return markExportStreamBackend(
    exportGraphStreamFromBackend(store, backend, options),
    backend,
  );
}

async function* exportGraphStreamFromBackend<G extends GraphDef>(
  store: Store<G>,
  backend: GraphBackend,
  options?: ExportStreamOptionsInput,
): AsyncIterable<GraphInterchangeChunk> {
  const parsed = ExportStreamOptionsSchema.parse(options ?? {});
  // Archival identity rows carry their effective-time windows unconditionally.
  // Their endpoint rows must therefore carry temporal bounds too, or the
  // store's own export could not prove on re-import that each endpoint existed
  // throughout an ended assertion's window.
  const explicitlyDisabledTemporalFields = options?.includeTemporal === false;
  if (parsed.identityMode === "archival" && explicitlyDisabledTemporalFields) {
    throw new ConfigurationError(
      "Archival identity export requires temporal endpoint fields.",
      {
        code: "IDENTITY_ARCHIVAL_EXPORT_REQUIRES_TEMPORAL_FIELDS",
        identityMode: parsed.identityMode,
        includeTemporal: false,
      },
      {
        suggestion:
          "Remove includeTemporal or set it to true when identityMode is archival.",
      },
    );
  }
  const resolved =
    parsed.identityMode === "archival" ?
      { ...parsed, includeTemporal: true }
    : parsed;
  const signal = resolved.signal;
  const idleTimeoutMs = resolved.idleTimeoutMs;
  const channel = createRendezvousChannel<GraphInterchangeChunk>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let subscribedToSignal = false;
  function unsubscribeFromSignal(): void {
    if (!subscribedToSignal) return;
    signal?.removeEventListener("abort", abortStream);
    subscribedToSignal = false;
  }
  function clearIdleTimer(): void {
    if (idleTimer === undefined) return;
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
  function armIdleTimer(): void {
    if (idleTimeoutMs === undefined) return;
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      unsubscribeFromSignal();
      channel.abort(
        new ExportStreamIdleTimeoutError(
          store.graphId,
          idleTimeoutMs,
          backend.capabilities.transactions,
        ),
      );
    }, idleTimeoutMs);
    unrefTimer(idleTimer);
  }
  function abortStream(): void {
    clearIdleTimer();
    channel.abort(
      exportStreamCancelled(
        "mid-stream",
        store.graphId,
        signal,
        backend.capabilities.transactions,
      ),
    );
  }
  // REGISTER, THEN RE-CHECK — and in that order, because the two halves cover
  // different instants and neither covers both:
  //
  // - The listener covers every abort from now on, including one raised
  //   SYNCHRONOUSLY by the driver inside `backend.transaction(...)` below. That
  //   is the window this ordering exists for: subscribing after that call
  //   returned meant such an abort was delivered to nobody — an `AbortSignal`
  //   does not replay `abort` to a listener that arrives late — and the export
  //   went on holding its snapshot and its lease with `signal.aborted === true`.
  // - The re-check covers an abort that already happened, which the event will
  //   never deliver at all. It is not ceremonial: `parse` above reads the
  //   caller's options object, and a getter on it can abort the controller
  //   before this line is reached.
  //
  // Nothing between them can yield, so there is no instant at which an abort is
  // neither seen by the re-check nor delivered to the listener.
  signal?.addEventListener("abort", abortStream, { once: true });
  subscribedToSignal = signal !== undefined;
  if (signal?.aborted === true) {
    // Nothing has been claimed or opened yet, so this stream is over before it
    // started rather than cancelled in flight — and it must leave no listener
    // on a signal the caller may hold for the rest of the process.
    unsubscribeFromSignal();
    throw exportStreamCancelled(
      "before-open",
      store.graphId,
      signal,
      backend.capabilities.transactions,
    );
  }
  const produce = async (
    target: GraphBackend | TransactionBackend,
  ): Promise<void> => {
    await produceExportChunks(store, target, resolved, (chunk) =>
      channel.push(chunk),
    );
  };
  /**
   * Opens the snapshot and wires the producer, or gives back EVERYTHING this
   * stream has taken and rethrows.
   *
   * On a serialized backend the snapshot transaction holds the single
   * connection for the whole stream. Claiming that connection's one stream
   * lease for the duration makes a concurrent import — or a SECOND export,
   * whose snapshot transaction would nest inside this one just as fatally —
   * be refused rather than left to wait for a slot that cannot free up. This is
   * what the stream's consumer identity cannot answer once a caller wraps the
   * iterable. And if another stream already holds that connection, THIS side is
   * the one refused: it is the stream that started second. The claim is
   * deliberately inside the generator body: it must begin when the transaction
   * opens (first pull), not when the iterable is constructed.
   *
   * Two things can stop the stream before it starts, and both give back what
   * they took. The lease refusal takes nothing but the signal subscription made
   * above. `backend.transaction(...)` is a driver call, and a driver can reject
   * SYNCHRONOUSLY — a closed handle, a pool that refuses the checkout — before
   * any promise exists; the release is installed on the promise it returns, so
   * a synchronous throw would otherwise skip it and strand the lease for the
   * life of the process, refusing every later stream on that connection on
   * behalf of one that never ran a statement.
   */
  const beginProducer = (): Promise<void> => {
    try {
      const releaseSnapshotExport =
        backend.capabilities.transactions ?
          claimSnapshotExportLeaseOrRefuse(store.graphId, backend)
        : () => {
            // No snapshot transaction is opened here, so nothing was claimed:
            // a non-transactional export holds nothing against a concurrent
            // stream.
          };
      try {
        const started =
          backend.capabilities.transactions ?
            backend.transaction((target) => produce(target), {
              isolationLevel: "repeatable_read",
              accessMode: "read_only",
            })
          : produce(backend);
        return started.then(
          () => {
            releaseSnapshotExport();
            channel.finish();
          },
          (error: unknown) => {
            releaseSnapshotExport();
            channel.fail(error);
          },
        );
      } catch (error) {
        releaseSnapshotExport();
        throw error;
      }
    } catch (error) {
      unsubscribeFromSignal();
      throw error;
    }
  };
  const producer = beginProducer();

  try {
    for (;;) {
      const delivery = await channel.take();
      if (delivery === undefined) return;
      armIdleTimer();
      yield delivery.value;
      clearIdleTimer();
      delivery.acknowledge();
    }
  } finally {
    // Unsubscribe FIRST: this stream is settling through a cooperative path, so
    // an abort arriving during the teardown below must not publish a terminal
    // error in place of the clean end the consumer is owed — and a signal the
    // caller reuses for its next export must not still reach this one, nor keep
    // this generator's scope alive for as long as the caller holds it.
    unsubscribeFromSignal();
    clearIdleTimer();
    channel.cancel();
    await producer;
  }
}

/** Do not let an opt-in safety timer keep a Node.js process alive by itself. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (
    typeof timer === "object" &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref();
  }
}

/**
 * How far the stream had got when the abort landed. Every phase ends the same
 * way for the caller — nothing is held, start a new export — so they share one
 * error class and ONE `code`; only the message differs, because a refusal that
 * claimed nothing must not claim to have rolled anything back.
 *
 * - `before-open` — the abort was already visible when the stream was asked for
 *   its first chunk. No transaction was opened and no lease claimed, whatever
 *   the backend can do.
 * - `mid-stream` — the abort arrived from the moment the stream began opening
 *   onward, INCLUDING synchronously inside `backend.transaction(...)`. What was
 *   given back depends on what was taken, which is why this phase needs the
 *   backend's capability to describe itself honestly.
 */
type ExportAbortPhase = "before-open" | "mid-stream";

/**
 * The single owner of the error an aborted export stream reports, so the
 * pre-flight refusal and the mid-stream abort state the same condition in the
 * same vocabulary — one code, the signal's own reason as `cause`, and a message
 * that is true of the phase AND of the backend it describes.
 *
 * `framed` is `backend.capabilities.transactions`. A non-transactional export
 * opened no snapshot and claimed no lease, so telling its consumer that a
 * snapshot was rolled back and a connection released would describe work that
 * never happened — and would hide the thing that consumer actually needs to
 * know, which is that the chunks it did receive were never one point in time.
 */
function exportStreamCancelled(
  phase: ExportAbortPhase,
  graphId: string,
  signal: AbortSignal | undefined,
  framed: boolean,
): ExportStreamCancelledError {
  const message =
    phase === "before-open" ?
      "The graph export stream was aborted through its AbortSignal before it opened: no snapshot transaction was started and no database connection claimed."
    : framed ?
      "The graph export stream was aborted through its AbortSignal: its repeatable-read snapshot has been rolled back and the connection it held released."
    : "The graph export stream was aborted through its AbortSignal: its remaining reads were abandoned. This backend does not support transactions, so the export held no snapshot and no connection — and the chunks already delivered were never guaranteed to agree with one another.";
  const cause: unknown = signal?.reason;
  // The suggestion must be capability-aware for the same reason the message is:
  // the class default claims a snapshot rollback, which is false on the
  // non-transactional arm and for a stream that never opened.
  const suggestion =
    phase === "before-open" ?
      "Start a new export; the aborted one claimed nothing."
    : framed ?
      "Start a new export; the aborted one released its snapshot transaction and the connection it held."
    : "Start a new export; nothing was held, but discard the chunks already delivered unless partial, mutually-inconsistent data is acceptable.";
  return new ExportStreamCancelledError(
    message,
    { graphId },
    {
      suggestion,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * Claims the serialized connection for this export's snapshot transaction, or
 * refuses because another long-lived stream — a streaming import, or another
 * snapshot export — is already using it.
 *
 * The check and the claim are one synchronous section inside
 * {@link acquireSerializedStreamLease}, which offers no way to ask without
 * claiming. On a single-threaded event loop that makes "no other stream held
 * this connection when the snapshot opened" true for the whole stream: nobody
 * can slip a claim in between, and two streams cannot both conclude the
 * connection was free.
 *
 * Only called when the backend is transactional: a `transactionMode: "none"`
 * export holds nothing open, interleaves harmlessly, and must not be refused —
 * nor refuse anyone.
 */
function claimSnapshotExportLeaseOrRefuse(
  graphId: string,
  backend: GraphBackend,
): () => void {
  const lease = acquireSerializedStreamLease(backend, "export-snapshot");
  if (!lease.acquired) {
    throw serializedStreamRefusal({
      graphId,
      requested: "export-snapshot",
      heldBy: lease.heldBy,
    });
  }
  return lease.release;
}

async function produceExportChunks<G extends GraphDef>(
  store: Store<G>,
  backend: GraphBackend | TransactionBackend,
  options: ExportOptions_ & Readonly<{ batchSize: number }>,
  emit: (chunk: GraphInterchangeChunk) => Promise<void>,
): Promise<void> {
  const graphId = store.graphId;
  const nodeKinds = options.nodeKinds ?? getNodeKinds(store.graph);
  const edgeKinds = options.edgeKinds ?? getEdgeKinds(store.graph);
  const schemaVersion = await backend.getActiveSchema(graphId);

  await emit({
    type: "header",
    header: {
      formatVersion: FORMAT_VERSION,
      exportedAt: nowIso(),
      source: {
        type: "typegraph-export",
        graphId,
        schemaVersion: schemaVersion?.version ?? 1,
      },
      ...(store.graph.identity === undefined ?
        {}
      : {
          identity: {
            profile: "typegraph-identity-v1" as const,
            mode: options.identityMode,
          },
        }),
    },
  });

  for (const kind of nodeKinds) {
    for await (const chunk of exportNodeChunks(
      backend,
      graphId,
      kind,
      options,
    )) {
      await emit(chunk);
    }
  }
  for (const kind of edgeKinds) {
    for await (const chunk of exportEdgeChunks(
      backend,
      graphId,
      kind,
      options,
    )) {
      await emit(chunk);
    }
  }
  if (store.graph.identity === undefined) return;

  let after: string | undefined;
  for (;;) {
    const page = await storeRuntime(store).readIdentityAssertionPageAtTarget(
      backend,
      options.identityMode,
      {
        ...(options.nodeKinds === undefined ? {} : { nodeKinds }),
        includeDeleted: options.includeDeleted,
        ...(after === undefined ? {} : { after }),
        limit: options.batchSize,
      },
    );
    if (page.assertions.length > 0) {
      await emit({ type: "identity", assertions: [...page.assertions] });
    }
    if (page.done) return;
    after = requireDefined(page.nextAfter);
  }
}

type ExportOptions_ = Readonly<{
  includeTemporal: boolean;
  includeMeta: boolean;
  includeDeleted: boolean;
  identityMode: "state" | "archival";
  nodeKinds?: readonly string[] | undefined;
  edgeKinds?: readonly string[] | undefined;
}>;

type RendezvousDelivery<T> = Readonly<{
  value: T;
  acknowledge: () => void;
}>;

type RendezvousChannel<T> = Readonly<{
  push: (value: T) => Promise<void>;
  take: () => Promise<RendezvousDelivery<T> | undefined>;
  finish: () => void;
  fail: (error: unknown) => void;
  /** The consumer left through a cooperative path; the stream simply ends. */
  cancel: () => void;
  /**
   * Nobody is coming back for this stream. Unwinds the producer — which rolls
   * the snapshot transaction back and releases the connection's lease on its
   * way out — AND makes `error` the channel's terminal state, so a consumer
   * that is waiting on `next()`, or that asks again later, is told why rather
   * than handed a silent end of stream it would read as a complete export.
   */
  abort: (error: Error) => void;
}>;

function createRendezvousChannel<T>(): RendezvousChannel<T> {
  type PendingPush = Readonly<{
    delivery: RendezvousDelivery<T>;
    reject: (error: unknown) => void;
  }>;
  type PendingTake = Readonly<{
    resolve: (delivery: RendezvousDelivery<T> | undefined) => void;
    reject: (error: unknown) => void;
  }>;

  const consumerCancelledError = new Error("Export stream consumer cancelled.");
  let pendingPush: PendingPush | undefined;
  let pendingTake: PendingTake | undefined;
  let inFlightReject: ((error: unknown) => void) | undefined;
  let terminal: Readonly<{ error?: Error }> | undefined;
  /**
   * Why the producer is being torn down, once something decided to tear it
   * down — a cooperative consumer exit ({@link cancel}) or a cancellation
   * ({@link abort}).
   *
   * The single owner of "this stream is unwinding": it is what every pending
   * and future push rejects with, so the producer always unwinds through one
   * rejection whichever side started it, and it is how {@link fail} recognizes
   * the failure this channel caused itself.
   */
  let producerUnwindError: Error | undefined;

  function push(value: T): Promise<void> {
    if (producerUnwindError !== undefined) {
      return Promise.reject(producerUnwindError);
    }
    if (terminal !== undefined || pendingPush !== undefined) {
      return Promise.reject(
        new Error("Cannot push to a completed or occupied export channel."),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const delivery = {
        value,
        acknowledge: () => {
          inFlightReject = undefined;
          resolve();
        },
      };
      if (pendingTake !== undefined) {
        const take = pendingTake;
        pendingTake = undefined;
        inFlightReject = reject;
        take.resolve(delivery);
        return;
      }
      pendingPush = { delivery, reject };
    });
  }

  function take(): Promise<RendezvousDelivery<T> | undefined> {
    if (pendingPush !== undefined) {
      const push = pendingPush;
      pendingPush = undefined;
      inFlightReject = push.reject;
      return Promise.resolve(push.delivery);
    }
    if (terminal !== undefined) {
      return terminal.error === undefined ?
          Promise.resolve(undefined)
        : Promise.reject(terminal.error);
    }
    if (pendingTake !== undefined) {
      return Promise.reject(
        new Error("Export channel already has a consumer."),
      );
    }
    return new Promise<RendezvousDelivery<T> | undefined>((resolve, reject) => {
      pendingTake = { resolve, reject };
    });
  }

  function finish(): void {
    if (producerUnwindError !== undefined) return;
    terminal = {};
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.resolve(undefined);
    }
  }

  function fail(error: unknown): void {
    // The producer failed with the very rejection this channel handed it in
    // order to unwind: that is this channel's own doing, not a new outcome to
    // report. Compared against a DEFINED unwind error only — a producer that
    // rejects with `undefined` is a real failure and must still reach the
    // consumer.
    if (producerUnwindError !== undefined && error === producerUnwindError) {
      return;
    }
    // An abort already published the terminal state the consumer must see; the
    // producer's own unwinding failure must not overwrite it.
    if (terminal !== undefined) return;
    const exportError =
      error instanceof Error ? error : (
        new Error("Graph export failed.", { cause: error })
      );
    terminal = { error: exportError };
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.reject(exportError);
    }
  }

  function cancel(): void {
    if (producerUnwindError !== undefined) return;
    producerUnwindError = consumerCancelledError;
    if (pendingPush !== undefined) {
      const push = pendingPush;
      pendingPush = undefined;
      push.reject(consumerCancelledError);
    }
    if (inFlightReject !== undefined) {
      const reject = inFlightReject;
      inFlightReject = undefined;
      reject(consumerCancelledError);
    }
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.resolve(undefined);
    }
  }

  function abort(error: Error): void {
    // Nothing is held any more, so this abort has nothing to take back and must
    // not restate the outcome. The two arms are NOT alike in how they are
    // reached:
    //
    // - `terminal !== undefined` IS reachable. The producer settles
    //   (`finish`/`fail`) and resolves the consumer's pending take, but the
    //   generator only resumes to run its `finally` — and unsubscribe — in a
    //   later microtask. An abort landing in that window finds the outcome
    //   already published and must leave it alone: the export really did end
    //   the way `terminal` says, and the consumer has already been handed that
    //   answer.
    // - `producerUnwindError !== undefined` is defensive. `cancel()` sets it
    //   from the generator's `finally`, which unsubscribes BEFORE calling it,
    //   and the listener is `{ once: true }`, so there is no path today that
    //   calls `abort` twice or calls it after `cancel`.
    if (terminal !== undefined || producerUnwindError !== undefined) return;
    producerUnwindError = error;
    terminal = { error };
    if (pendingPush !== undefined) {
      const push = pendingPush;
      pendingPush = undefined;
      push.reject(error);
    }
    if (inFlightReject !== undefined) {
      const reject = inFlightReject;
      inFlightReject = undefined;
      reject(error);
    }
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.reject(error);
    }
  }

  return { push, take, finish, fail, cancel, abort };
}

// ============================================================
// Node Export
// ============================================================

async function* exportNodeChunks(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
  options: ExportOptions_ & Readonly<{ batchSize: number }>,
): AsyncIterable<GraphInterchangeChunk> {
  let after: string | undefined;
  for (;;) {
    const rows = await backend.findNodesByKind({
      graphId,
      kind,
      excludeDeleted: !options.includeDeleted,
      orderBy: "id",
      limit: options.batchSize,
      ...(after === undefined ? {} : { after }),
    });
    if (rows.length === 0) return;
    const nodes = rows.map((row) => {
      const node: InterchangeNode = {
        kind: row.kind,
        id: row.id,
        properties: rowPropsToObject(row.props),
      };

      if (options.includeTemporal) {
        // validFrom is always emitted (as `null` when the row has no lower
        // bound) so import can tell "confirmed open-left" apart from "not
        // requested" and preserve it instead of defaulting to import time —
        // see the schema doc on InterchangeNodeSchema.validFrom. validTo has
        // no such ambiguity (it was never defaulted), so it stays gated.
        // `null` (not `undefined`) is the wire-protocol signal here — JSON has
        // no other way to say "explicitly cleared" vs. "field absent".
        const validFrom =
          // eslint-disable-next-line unicorn/no-null
          row.valid_from ?? null;
        (node as { validFrom?: string | null }).validFrom = validFrom;
        if (row.valid_to) {
          (node as { validTo?: string }).validTo = row.valid_to;
        }
      }

      if (options.includeMeta) {
        (node as { meta?: InterchangeNode["meta"] }).meta = {
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      return node;
    });
    yield { type: "nodes", nodes };
    if (rows.length < options.batchSize) return;
    after = requireDefined(rows.at(-1)).id;
  }
}

// ============================================================
// Edge Export
// ============================================================

async function* exportEdgeChunks(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  kind: string,
  options: ExportOptions_ & Readonly<{ batchSize: number }>,
): AsyncIterable<GraphInterchangeChunk> {
  let after: string | undefined;
  for (;;) {
    const rows = await backend.findEdgesByKind({
      graphId,
      kind,
      excludeDeleted: !options.includeDeleted,
      orderBy: "id",
      limit: options.batchSize,
      ...(after === undefined ? {} : { after }),
    });
    if (rows.length === 0) return;
    const edges = rows.map((row) => {
      const edge: InterchangeEdge = {
        kind: row.kind,
        id: row.id,
        from: {
          kind: row.from_kind,
          id: row.from_id,
        },
        to: {
          kind: row.to_kind,
          id: row.to_id,
        },
        properties: rowPropsToObject(row.props),
      };

      if (options.includeTemporal) {
        // See exportNodesOfKind's validFrom comment: always emitted (as
        // `null` when open-left) so import can distinguish "confirmed no
        // lower bound" from "not requested".
        const validFrom =
          // eslint-disable-next-line unicorn/no-null
          row.valid_from ?? null;
        (edge as { validFrom?: string | null }).validFrom = validFrom;
        if (row.valid_to) {
          (edge as { validTo?: string }).validTo = row.valid_to;
        }
      }

      if (options.includeMeta) {
        (edge as { meta?: InterchangeEdge["meta"] }).meta = {
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      }

      return edge;
    });
    yield { type: "edges", edges };
    if (rows.length < options.batchSize) return;
    after = requireDefined(rows.at(-1)).id;
  }
}
