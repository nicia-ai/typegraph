/**
 * Graph data export functionality.
 *
 * Exports nodes and edges from a store to the interchange format.
 */
import { type GraphBackend, rowPropsToObject } from "../backend/types";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import { type Store } from "../store/store";
import { nowIso } from "../utils/date";
import {
  type ExportOptionsInput,
  type ExportStreamOptionsInput,
  ExportStreamOptionsSchema,
  FORMAT_VERSION,
  type GraphData,
  type GraphDataHeader,
  type GraphInterchangeChunk,
  type InterchangeEdge,
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
    }
  }
  if (header === undefined) {
    throw new Error("Graph export stream ended before emitting its header.");
  }
  return { ...header, nodes, edges };
}

/**
 * Exports a graph as bounded node and edge chunks. The stream always yields one
 * header, then every node chunk, then every edge chunk. Consumers that write to
 * a network, file, or fresh working copy can process one chunk at a time rather
 * than materializing a graph-sized {@link GraphData} value.
 */
export async function* exportGraphStream<G extends GraphDef>(
  store: Store<G>,
  options?: ExportStreamOptionsInput,
): AsyncIterable<GraphInterchangeChunk> {
  const resolved = ExportStreamOptionsSchema.parse(options ?? {});
  const graphId = store.graphId;
  const backend = store.backend;
  const nodeKinds = resolved.nodeKinds ?? getNodeKinds(store.graph);
  const edgeKinds = resolved.edgeKinds ?? getEdgeKinds(store.graph);
  const schemaVersion = await backend.getActiveSchema(graphId);

  yield {
    type: "header",
    header: {
      formatVersion: FORMAT_VERSION,
      exportedAt: nowIso(),
      source: {
        type: "typegraph-export",
        graphId,
        schemaVersion: schemaVersion?.version ?? 1,
      },
    },
  };

  for (const kind of nodeKinds) {
    yield* exportNodeChunks(backend, graphId, kind, resolved);
  }
  for (const kind of edgeKinds) {
    yield* exportEdgeChunks(backend, graphId, kind, resolved);
  }
}

// ============================================================
// Node Export
// ============================================================

type ExportOptions_ = Readonly<{
  includeTemporal: boolean;
  includeMeta: boolean;
  includeDeleted: boolean;
}>;

async function* exportNodeChunks(
  backend: GraphBackend,
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
    after = rows.at(-1)!.id;
  }
}

// ============================================================
// Edge Export
// ============================================================

async function* exportEdgeChunks(
  backend: GraphBackend,
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
    after = rows.at(-1)!.id;
  }
}
