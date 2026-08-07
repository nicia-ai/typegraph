/**
 * Graph data export functionality.
 *
 * Exports nodes and edges from a store to the interchange format.
 */
import { beginSerializedSnapshotExport } from "../backend/transaction-resource";
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
import { storeBackend, storeRuntime } from "../store/runtime-port";
import { type Store } from "../store/store";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
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
  const channel = createRendezvousChannel<GraphInterchangeChunk>();
  const produce = async (
    target: GraphBackend | TransactionBackend,
  ): Promise<void> => {
    await produceExportChunks(store, target, resolved, (chunk) =>
      channel.push(chunk),
    );
  };
  // On a serialized backend the snapshot transaction below holds the single
  // connection for the whole stream. Publish that fact for the duration so a
  // concurrent import into the same connection is refused rather than left to
  // wait for a writer slot that cannot free up — this is what the stream's
  // consumer identity cannot answer once a caller wraps the iterable.
  // Registration is deliberately inside the generator body: it must begin when
  // the transaction opens (first pull), not when the iterable is constructed.
  const releaseSnapshotExport =
    backend.capabilities.transactions ?
      beginSerializedSnapshotExport(backend)
    : () => {
        // No snapshot transaction is opened here, so none was registered:
        // a non-transactional export holds nothing against a concurrent
        // import.
      };
  const producer = (
    backend.capabilities.transactions ?
      backend.transaction((target) => produce(target), {
        isolationLevel: "repeatable_read",
        accessMode: "read_only",
      })
    : produce(backend)).then(
    () => {
      releaseSnapshotExport();
      channel.finish();
    },
    (error: unknown) => {
      releaseSnapshotExport();
      channel.fail(error);
    },
  );

  try {
    for (;;) {
      const delivery = await channel.take();
      if (delivery === undefined) return;
      yield delivery.value;
      delivery.acknowledge();
    }
  } finally {
    channel.cancel();
    await producer;
  }
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
  cancel: () => void;
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

  const cancelledError = new Error("Export stream consumer cancelled.");
  let pendingPush: PendingPush | undefined;
  let pendingTake: PendingTake | undefined;
  let inFlightReject: ((error: unknown) => void) | undefined;
  let terminal: Readonly<{ error?: Error }> | undefined;
  let cancelled = false;

  function push(value: T): Promise<void> {
    if (cancelled) return Promise.reject(cancelledError);
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
    if (cancelled) return;
    terminal = {};
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.resolve(undefined);
    }
  }

  function fail(error: unknown): void {
    if (cancelled && error === cancelledError) return;
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
    if (cancelled) return;
    cancelled = true;
    if (pendingPush !== undefined) {
      const push = pendingPush;
      pendingPush = undefined;
      push.reject(cancelledError);
    }
    if (inFlightReject !== undefined) {
      const reject = inFlightReject;
      inFlightReject = undefined;
      reject(cancelledError);
    }
    if (pendingTake !== undefined) {
      const take = pendingTake;
      pendingTake = undefined;
      take.resolve(undefined);
    }
  }

  return { push, take, finish, fail, cancel };
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
