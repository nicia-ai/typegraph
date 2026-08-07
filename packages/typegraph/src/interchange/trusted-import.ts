import { snapshotExportContention } from "../backend/transaction-resource";
import type {
  InsertEdgeParams,
  InsertNodeParams,
  TrustedImportOptions,
  TrustedImportSession,
} from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { getSearchableFields } from "../core/searchable";
import { TrustedImportError } from "../errors";
import { storeBackend } from "../store/runtime-port";
import type { Store } from "../store/store";
import { isCanonicalIsoDate, isInvertedValidityWindow } from "../utils/date";
import { serializedStreamRefusal, withImportStreamLease } from "./import";
import { exportStreamBackend } from "./stream-source";
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
  if (store.graph.identity !== undefined) {
    throw new TrustedImportError(
      "Trusted import does not maintain Operational Identity assertions or closure.",
      "identity_unsupported",
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

/** The stated validity window of a streamed node or edge. */
type StatedValidityWindow = Readonly<{
  validFrom?: string | null | undefined;
  validTo?: string | undefined;
}>;

type ValidityWindowField = "validFrom" | "validTo";

/** A stated window field that is not canonical, with the offending value. */
type NonCanonicalWindow = Readonly<{
  field: ValidityWindowField;
  value: string;
}>;

/**
 * The first window field of `entity` stating a timestamp that is not canonical
 * fixed-width UTC ISO 8601 — with the offending value — or `undefined` when
 * every stated one is canonical.
 *
 * A trusted stream is never re-parsed, so this is the only place its timestamps
 * are held to the format the rest of the system assumes. It is deliberately
 * format-ONLY — the same {@link isCanonicalIsoDate} decision the untrusted
 * path's schema and the store's own write validation make, and nothing more —
 * because a non-canonical instant is not merely ugly: every temporal filter
 * compares these values AS TEXT against an `asOf` coordinate, so a variable-width
 * one (`...:00.1Z`, an offset, date-only) mis-sorts and silently includes or
 * excludes the wrong rows once stored, and it would mis-decide the negative-width
 * check below on the way in. Two field tests per row costs about a microsecond
 * against the ~4µs an in-memory SQLite row already costs — the price of the
 * stream's ordering claims meaning anything.
 *
 * An absent field states nothing, and a `null` validFrom is a confirmed
 * open-left window (see {@link nodeParams}) — neither is a timestamp to check.
 */
function nonCanonicalWindowOf(
  entity: StatedValidityWindow,
): NonCanonicalWindow | undefined {
  const { validFrom, validTo } = entity;
  if (typeof validFrom === "string" && !isCanonicalIsoDate(validFrom)) {
    return { field: "validFrom", value: validFrom };
  }
  if (typeof validTo === "string" && !isCanonicalIsoDate(validTo)) {
    return { field: "validTo", value: validTo };
  }
  return undefined;
}

/**
 * The first entity in `entities` stating a non-canonical window timestamp, with
 * the offending field and value. Allocates only on the failing path, so a clean
 * chunk pays one predicate per stated timestamp and nothing else.
 */
function findNonCanonicalWindow<Entity extends StatedValidityWindow>(
  entities: readonly Entity[],
): (NonCanonicalWindow & Readonly<{ entity: Entity }>) | undefined {
  for (const entity of entities) {
    const nonCanonical = nonCanonicalWindowOf(entity);
    if (nonCanonical !== undefined) return { entity, ...nonCanonical };
  }
  return undefined;
}

/** The refusal message for a non-canonical window timestamp on `subject`. */
function nonCanonicalWindowMessage(
  subject: string,
  field: ValidityWindowField,
  value: string,
): string {
  return (
    `Non-canonical ${field} in trusted import: ${subject} states "${value}". ` +
    `Expected canonical fixed-width UTC ISO 8601 (YYYY-MM-DDTHH:mm:ss.sssZ), ` +
    `which is what makes a stored timestamp sort chronologically against an asOf ` +
    `coordinate. Convert with new Date(value).toISOString().`
  );
}

/**
 * An entity whose stated window has negative width. Trusted import writes
 * straight to SQL and skips schema validation for throughput, but a row that
 * stopped being true before it started is a stream SHAPE fault rather than a
 * policy check: it is unobservable at every `asOf` coordinate, and no later
 * write repairs it. `null` validFrom is a confirmed open-left window, so there
 * is no lower bound to invert against; zero width is legal (see
 * {@link isInvertedValidityWindow}).
 *
 * Only ever reached for a chunk whose timestamps {@link findNonCanonicalWindow}
 * has already accepted, which is what makes the lexicographic compare inside a
 * chronological one.
 */
function hasInvertedWindow(entity: StatedValidityWindow): boolean {
  return isInvertedValidityWindow(
    entity.validFrom ?? undefined,
    entity.validTo,
  );
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
        if (chunk.header.identity !== undefined) {
          throw invalidStream(
            "Trusted graph interchange import does not support identity data. " +
              "Use importGraphStream() for an identity export.",
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
        const nonCanonicalNode = findNonCanonicalWindow(chunk.nodes);
        if (nonCanonicalNode !== undefined) {
          const { entity, field, value } = nonCanonicalNode;
          throw invalidStream(
            nonCanonicalWindowMessage(
              `${entity.kind} "${entity.id}"`,
              field,
              value,
            ),
          );
        }
        const invertedNode = chunk.nodes.find((node) =>
          hasInvertedWindow(node),
        );
        if (invertedNode !== undefined) {
          throw invalidStream(
            `Inverted validity window in trusted import: ${invertedNode.kind} "${invertedNode.id}" ends at ` +
              `"${String(invertedNode.validTo)}", before its validFrom "${String(invertedNode.validFrom)}".`,
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
        const nonCanonicalEdge = findNonCanonicalWindow(chunk.edges);
        if (nonCanonicalEdge !== undefined) {
          const { entity, field, value } = nonCanonicalEdge;
          throw invalidStream(
            nonCanonicalWindowMessage(
              `${entity.kind} edge "${entity.id}"`,
              field,
              value,
            ),
          );
        }
        const invertedEdge = chunk.edges.find((edge) =>
          hasInvertedWindow(edge),
        );
        if (invertedEdge !== undefined) {
          throw invalidStream(
            `Inverted validity window in trusted import: ${invertedEdge.kind} edge "${invertedEdge.id}" ends at ` +
              `"${String(invertedEdge.validTo)}", before its validFrom "${String(invertedEdge.validFrom)}".`,
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
 *
 * Trusted of the DATA, not of the connection: this holds ONE write transaction
 * open for the entire stream, which makes it a long-lived import holder exactly
 * like {@link importGraphStream}, and it is guarded the same way — the source
 * stream's own backend is checked against the target before the first chunk, and
 * the target connection's exclusive stream lease is held for the whole import.
 * `trustedImportGraphStream(target, exportGraphStream(source))` over one
 * serialized connection is therefore refused with the shared typed
 * {@link ConfigurationError} (codes and `details.heldBy` / `details.requested`
 * as documented on `importGraphStream`) rather than reaching the driver as a
 * nested BEGIN.
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
  // The same pre-flight `importGraphStream` runs, through the same owner of
  // "would this export hold the connection that write needs": a synchronous
  // iterable was materialized by its producer and holds nothing, so only an
  // async stream can name a source backend.
  const sourceBackend =
    Symbol.asyncIterator in chunks ? exportStreamBackend(chunks) : undefined;
  const contention =
    sourceBackend === undefined ? undefined : (
      snapshotExportContention(sourceBackend, backend)
    );
  if (contention !== undefined) {
    throw serializedStreamRefusal({
      graphId: store.graphId,
      requested: "import-stream",
      heldBy: "export-snapshot",
      detector: contention,
    });
  }
  const schemaVersion = store.introspect().schemaVersion;
  const options: TrustedImportOptions | undefined =
    schemaVersion === undefined ? undefined : (
      {
        schemaWrite: {
          graphId: store.graphId,
          expectedVersion: schemaVersion,
        },
      }
    );
  return withImportStreamLease(store, () =>
    trustedImport(
      (session) => consumeTrustedChunks(store, session, chunks),
      options,
    ),
  );
}

function* graphDataChunks(data: GraphData): Iterable<GraphInterchangeChunk> {
  const { nodes, edges, identity, ...header } = data;
  yield {
    type: "header",
    header:
      identity === undefined ? header : (
        {
          ...header,
          identity: { profile: identity.profile, mode: identity.mode },
        }
      ),
  };
  yield { type: "nodes", nodes };
  yield { type: "edges", edges };
  if (identity !== undefined) {
    yield { type: "identity", assertions: identity.assertions };
  }
}

/** In-memory convenience wrapper around {@link trustedImportGraphStream}. */
export function trustedImportGraph<G extends GraphDef>(
  store: Store<G>,
  data: GraphData,
): Promise<TrustedImportResult> {
  return trustedImportGraphStream(store, graphDataChunks(data));
}
