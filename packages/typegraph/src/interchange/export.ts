/**
 * Graph data export functionality.
 *
 * Exports nodes and edges from a store to the interchange format.
 */
import { type GraphBackend } from "../backend/types";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import { type Store } from "../store/store";
import { nowIso } from "../utils/date";
import {
  type ExportOptionsInput,
  FORMAT_VERSION,
  type GraphData,
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
  const options_ = {
    nodeKinds: options?.nodeKinds,
    edgeKinds: options?.edgeKinds,
    includeTemporal: options?.includeTemporal ?? false,
    includeMeta: options?.includeMeta ?? false,
    includeDeleted: options?.includeDeleted ?? false,
  };

  const graph = store.graph;
  const graphId = store.graphId;
  const backend = store.backend;

  // Determine which kinds to export
  const nodeKindsToExport = options_.nodeKinds ?? getNodeKinds(graph);
  const edgeKindsToExport = options_.edgeKinds ?? getEdgeKinds(graph);

  // Export nodes
  const nodes: InterchangeNode[] = [];
  for (const kind of nodeKindsToExport) {
    const kindNodes = await exportNodesOfKind(backend, graphId, kind, options_);
    nodes.push(...kindNodes);
  }

  // Export edges
  const edges: InterchangeEdge[] = [];
  for (const kind of edgeKindsToExport) {
    const kindEdges = await exportEdgesOfKind(backend, graphId, kind, options_);
    edges.push(...kindEdges);
  }

  // Get current schema version
  const schemaVersion = await backend.getActiveSchema(graphId);

  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: nowIso(),
    source: {
      type: "typegraph-export",
      graphId,
      schemaVersion: schemaVersion?.version ?? 1,
    },
    nodes,
    edges,
  };
}

// ============================================================
// Node Export
// ============================================================

type ExportOptions_ = Readonly<{
  includeTemporal: boolean;
  includeMeta: boolean;
  includeDeleted: boolean;
}>;

async function exportNodesOfKind(
  backend: GraphBackend,
  graphId: string,
  kind: string,
  options: ExportOptions_,
): Promise<InterchangeNode[]> {
  const rows = await backend.findNodesByKind({
    graphId,
    kind,
    excludeDeleted: !options.includeDeleted,
  });

  return rows.map((row) => {
    const node: InterchangeNode = {
      kind: row.kind,
      id: row.id,
      properties: JSON.parse(row.props) as Record<string, unknown>,
    };

    if (options.includeTemporal) {
      if (row.valid_from) {
        (node as { validFrom?: string }).validFrom = row.valid_from;
      }
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
}

// ============================================================
// Edge Export
// ============================================================

async function exportEdgesOfKind(
  backend: GraphBackend,
  graphId: string,
  kind: string,
  options: ExportOptions_,
): Promise<InterchangeEdge[]> {
  const rows = await backend.findEdgesByKind({
    graphId,
    kind,
    excludeDeleted: !options.includeDeleted,
  });

  return rows.map((row) => {
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
      properties: JSON.parse(row.props) as Record<string, unknown>,
    };

    if (options.includeTemporal) {
      if (row.valid_from) {
        (edge as { validFrom?: string }).validFrom = row.valid_from;
      }
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
}
