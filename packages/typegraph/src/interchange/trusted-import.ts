import type {
  InsertEdgeParams,
  InsertNodeParams,
  TrustedImportSession,
} from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { getSearchableFields } from "../core/searchable";
import { TrustedImportError } from "../errors";
import { storeBackend } from "../store/runtime-port";
import type { Store } from "../store/store";
import type {
  GraphData,
  GraphInterchangeChunk,
  InterchangeEdge,
  InterchangeNode,
} from "./types";

/** Counts committed by a trusted initial import. */
export type TrustedImportResult = Readonly<{
  nodes: number;
  edges: number;
}>;

function rejectUnsupportedStoreFeatures<G extends GraphDef>(
  store: Store<G>,
): void {
  if (store.historyEnabled) {
    throw new TrustedImportError(
      "Trusted import does not support recorded-time history capture.",
      "history_unsupported",
      { graphId: store.graphId },
    );
  }
  if (store.revisionTrackingEnabled) {
    throw new TrustedImportError(
      "Trusted import does not support revision tracking.",
      "revision_tracking_unsupported",
      { graphId: store.graphId },
    );
  }

  const uniqueKinds = Object.values(store.graph.nodes)
    .filter((registration) => (registration.unique?.length ?? 0) > 0)
    .map((registration) => registration.type.kind);
  if (uniqueKinds.length > 0) {
    throw new TrustedImportError(
      "Trusted import does not maintain node uniqueness sidecars.",
      "uniqueness_unsupported",
      { graphId: store.graphId, nodeKinds: uniqueKinds },
    );
  }

  const searchableKinds = Object.values(store.graph.nodes)
    .filter(
      (registration) =>
        getSearchableFields(registration.type.schema).length > 0,
    )
    .map((registration) => registration.type.kind);
  if (searchableKinds.length > 0) {
    throw new TrustedImportError(
      "Trusted import does not maintain fulltext sidecars.",
      "fulltext_unsupported",
      { graphId: store.graphId, nodeKinds: searchableKinds },
    );
  }

  const vectorSlots = resolveGraphVectorSlots(store.graph);
  if (vectorSlots.length > 0) {
    throw new TrustedImportError(
      "Trusted import does not maintain vector sidecars.",
      "vector_unsupported",
      {
        graphId: store.graphId,
        fields: vectorSlots.map((slot) => `${slot.nodeKind}.${slot.fieldPath}`),
      },
    );
  }
}

function invalidStream(message: string): TrustedImportError {
  return new TrustedImportError(message, "invalid_stream");
}

function nodeParams(graphId: string, node: InterchangeNode): InsertNodeParams {
  return {
    graphId,
    kind: node.kind,
    id: node.id,
    props: node.properties,
    ...(node.validFrom === undefined ? {} : { validFrom: node.validFrom }),
    ...(node.validTo === undefined ? {} : { validTo: node.validTo }),
  };
}

function edgeParams(graphId: string, edge: InterchangeEdge): InsertEdgeParams {
  return {
    graphId,
    id: edge.id,
    kind: edge.kind,
    fromKind: edge.from.kind,
    fromId: edge.from.id,
    toKind: edge.to.kind,
    toId: edge.to.id,
    props: edge.properties,
    ...(edge.validFrom === undefined ? {} : { validFrom: edge.validFrom }),
    ...(edge.validTo === undefined ? {} : { validTo: edge.validTo }),
  };
}

async function consumeTrustedChunks<G extends GraphDef>(
  store: Store<G>,
  session: TrustedImportSession,
  chunks:
    AsyncIterable<GraphInterchangeChunk> | Iterable<GraphInterchangeChunk>,
): Promise<TrustedImportResult> {
  const nodeKinds = new Set(
    Object.values(store.graph.nodes).map(
      (registration) => registration.type.kind,
    ),
  );
  const edgeKinds = new Set(
    Object.values(store.graph.edges).map(
      (registration) => registration.type.kind,
    ),
  );
  let receivedHeader = false;
  let receivedEdges = false;
  let nodeCount = 0;
  let edgeCount = 0;

  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "header": {
        if (receivedHeader) {
          throw invalidStream(
            "Trusted graph interchange stream emitted more than one header.",
          );
        }
        receivedHeader = true;
        break;
      }
      case "nodes": {
        if (!receivedHeader) {
          throw invalidStream(
            "Trusted graph interchange stream must start with a header.",
          );
        }
        if (receivedEdges) {
          throw invalidStream(
            "Trusted graph interchange stream cannot emit nodes after edges.",
          );
        }
        const unknownKind = chunk.nodes.find(
          (node) => !nodeKinds.has(node.kind),
        )?.kind;
        if (unknownKind !== undefined) {
          throw invalidStream(
            `Unknown node kind in trusted import: ${unknownKind}`,
          );
        }
        await session.insertNodes(
          chunk.nodes.map((node) => nodeParams(store.graphId, node)),
        );
        nodeCount += chunk.nodes.length;
        break;
      }
      case "edges": {
        if (!receivedHeader) {
          throw invalidStream(
            "Trusted graph interchange stream must start with a header.",
          );
        }
        receivedEdges = true;
        const invalidEdge = chunk.edges.find(
          (edge) =>
            !edgeKinds.has(edge.kind) ||
            !nodeKinds.has(edge.from.kind) ||
            !nodeKinds.has(edge.to.kind),
        );
        if (invalidEdge !== undefined) {
          throw invalidStream(
            `Unknown edge or endpoint kind in trusted import: ${invalidEdge.kind}`,
          );
        }
        await session.insertEdges(
          chunk.edges.map((edge) => edgeParams(store.graphId, edge)),
        );
        edgeCount += chunk.edges.length;
        break;
      }
      case "identity": {
        // The trusted session writes only the node and edge relations, so it
        // has no way to persist assertions or materialize the derived closure.
        // Refuse rather than drop identity truth from an identity-enabled
        // export: `importGraph` / `importGraphStream` carry it correctly.
        throw invalidStream(
          "Trusted graph interchange import does not support identity assertions. " +
            "Use importGraphStream() for an export that carries identity truth.",
        );
      }
    }
  }

  if (!receivedHeader) {
    throw invalidStream(
      "Trusted graph interchange stream ended before emitting a header.",
    );
  }
  return { nodes: nodeCount, edges: edgeCount };
}

/**
 * Atomically imports a header-first stream into a fresh, dedicated database.
 *
 * This is an intentionally trusted path. It checks stream ordering and kind
 * names, but it does not validate properties, references, cardinality, or
 * conflicts. The caller must guarantee those invariants. Use
 * {@link importGraphStream} for untrusted data.
 */
export async function trustedImportGraphStream<G extends GraphDef>(
  store: Store<G>,
  chunks:
    AsyncIterable<GraphInterchangeChunk> | Iterable<GraphInterchangeChunk>,
): Promise<TrustedImportResult> {
  rejectUnsupportedStoreFeatures(store);
  const backend = storeBackend(store);
  const trustedImport = backend.trustedImport;
  if (trustedImport === undefined) {
    throw new TrustedImportError(
      `The ${backend.dialect} backend does not support trusted import.`,
      "backend_unsupported",
      { dialect: backend.dialect },
    );
  }
  return trustedImport((session) =>
    consumeTrustedChunks(store, session, chunks),
  );
}

function* graphDataChunks(data: GraphData): Iterable<GraphInterchangeChunk> {
  const { nodes, edges, ...header } = data;
  yield { type: "header", header };
  yield { type: "nodes", nodes };
  yield { type: "edges", edges };
}

/** In-memory convenience wrapper around {@link trustedImportGraphStream}. */
export function trustedImportGraph<G extends GraphDef>(
  store: Store<G>,
  data: GraphData,
): Promise<TrustedImportResult> {
  return trustedImportGraphStream(store, graphDataChunks(data));
}
