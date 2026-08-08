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
import { ExportStreamCancelledError } from "../errors";
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
 * ## Stopping a stream you will not finish
 *
 * While the stream is open it holds a repeatable-read snapshot transaction, and
 * on a serialized connection it holds that connection's one EXCLUSIVE stream
 * lease with it. Every cooperative exit settles both, because each runs the
 * generator's `finally`: `break` or `throw` out of a `for await`, and an
 * explicit `iterator.return()`.
 *
 * A consumer that pulls `next()` and then simply DROPS the iterator has no
 * cooperative exit — async-generator `finally` blocks do not run on garbage
 * collection — so it must pass {@link ExportOptions.signal} and abort it.
 * Without that, the snapshot transaction stays open for the life of the
 * process and every later interchange stream on that connection is refused on
 * behalf of a stream nobody is reading.
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
 * reads as protection and is not there. The signal is the mechanism, and it is
 * a contract rather than a hint.
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
  const resolved = ExportStreamOptionsSchema.parse(options ?? {});
  const signal = resolved.signal;
  // Refused BEFORE anything is claimed or opened: an already-aborted signal
  // must not open a snapshot transaction and take a connection's lease only to
  // give both back on the next tick.
  if (signal?.aborted === true) {
    throw exportStreamCancelled(store.graphId, signal.reason);
  }
  const channel = createRendezvousChannel<GraphInterchangeChunk>();
  const produce = async (
    target: GraphBackend | TransactionBackend,
  ): Promise<void> => {
    await produceExportChunks(store, target, resolved, (chunk) =>
      channel.push(chunk),
    );
  };
  // On a serialized backend the snapshot transaction below holds the single
  // connection for the whole stream. Claim that connection's one stream lease
  // for the duration so a concurrent import — or a SECOND export, whose
  // snapshot transaction would nest inside this one just as fatally — is
  // refused rather than left to wait for a slot that cannot free up. This is
  // what the stream's consumer identity cannot answer once a caller wraps the
  // iterable. And if another stream already holds that connection, THIS side is
  // the one refused: it is the stream that started second.
  // The claim is deliberately inside the generator body: it must begin when the
  // transaction opens (first pull), not when the iterable is constructed.
  const releaseSnapshotExport =
    backend.capabilities.transactions ?
      claimSnapshotExportLeaseOrRefuse(store.graphId, backend)
    : () => {
        // No snapshot transaction is opened here, so nothing was claimed:
        // a non-transactional export holds nothing against a concurrent
        // stream.
      };
  // `backend.transaction(...)` is a driver call, and a driver can reject
  // SYNCHRONOUSLY — a closed handle, a pool that refuses the checkout — before
  // any promise exists. The release below is installed on the promise it
  // returns, so a synchronous throw would skip it and strand the lease for the
  // life of the process, refusing every later stream on that connection on
  // behalf of one that never started. Releasing here (idempotently) and
  // rethrowing keeps "the lease lives exactly as long as the transaction" true
  // on that path too.
  const beginProducer = (): Promise<void> => {
    try {
      return backend.capabilities.transactions ?
          backend.transaction((target) => produce(target), {
            isolationLevel: "repeatable_read",
            accessMode: "read_only",
          })
        : produce(backend);
    } catch (error) {
      releaseSnapshotExport();
      throw error;
    }
  };
  const producer = beginProducer().then(
    () => {
      releaseSnapshotExport();
      channel.finish();
    },
    (error: unknown) => {
      releaseSnapshotExport();
      channel.fail(error);
    },
  );
  // The signal is subscribed only once the snapshot is actually open, and in
  // the SAME synchronous turn that opened it — nothing above yields, so no
  // abort can be observed in between, and the two paths that throw before this
  // point (the lease refusal, and a driver that rejects `transaction()`
  // synchronously) have already given back everything they took. Subscribing
  // earlier would attach a stream that never started to the caller's signal.
  const abortStream = (): void => {
    channel.abort(exportStreamCancelled(store.graphId, signal?.reason));
  };
  signal?.addEventListener("abort", abortStream, { once: true });

  try {
    for (;;) {
      const delivery = await channel.take();
      if (delivery === undefined) return;
      yield delivery.value;
      delivery.acknowledge();
    }
  } finally {
    // Unsubscribe before unwinding: this stream is settling through a
    // cooperative path, and a signal the caller reuses for its next export must
    // not still reach this one — nor keep this generator's scope alive for as
    // long as the caller holds the signal.
    signal?.removeEventListener("abort", abortStream);
    channel.cancel();
    await producer;
  }
}

/**
 * The single owner of the error an aborted export stream reports, so the
 * pre-flight refusal and the mid-stream abort state the same condition in the
 * same vocabulary — one code, one message, the signal's own reason as `cause`.
 */
function exportStreamCancelled(
  graphId: string,
  cause?: unknown,
): ExportStreamCancelledError {
  return new ExportStreamCancelledError(
    "The graph export stream was aborted through its AbortSignal: its repeatable-read snapshot has been rolled back and the connection it held released.",
    { graphId },
    cause === undefined ? {} : { cause },
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
    // Nothing is held any more: the producer already settled (so the
    // transaction is committed or rolled back and the lease given back), or it
    // is already unwinding for someone else. Either way this abort has nothing
    // to take back and must not restate the outcome. Both arms are defensive
    // rather than reachable today — the rendezvous parks the producer in `push`
    // for exactly as long as the consumer is parked at a `yield`, so a settled
    // producer always means the consumer's pull already resolved and the
    // generator's `finally` already unsubscribed this stream from its signal.
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
