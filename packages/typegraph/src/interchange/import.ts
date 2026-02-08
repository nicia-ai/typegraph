/**
 * Graph data import functionality.
 *
 * Imports nodes and edges from the interchange format into a store,
 * with configurable conflict resolution and validation.
 */
import type { z } from "zod";

import { type GraphBackend, type TransactionBackend } from "../backend/types";
import {
  getEdgeTypeNames,
  getNodeTypeNames,
  type GraphDef,
} from "../core/define-graph";
import { type EdgeRegistration, type NodeRegistration } from "../core/types";
import { type Store } from "../store/store";
import {
  type GraphData,
  type ImportError,
  type ImportOptions,
  type ImportResult,
  type InterchangeEdge,
  type InterchangeNode,
  type UnknownPropertyStrategy,
} from "./types";

// ============================================================
// Import Function
// ============================================================

/**
 * Import graph data into a store.
 *
 * Nodes are imported first to satisfy edge reference validation.
 * The import runs within a transaction for atomicity when supported.
 *
 * @param store - The graph store to import into
 * @param data - Graph data in interchange format
 * @param options - Import configuration
 * @returns Import statistics and any errors
 *
 * @example
 * ```typescript
 * const result = await importGraph(store, data, {
 *   onConflict: "update",
 *   onUnknownProperty: "strip",
 * });
 *
 * console.log(`Created ${result.nodes.created} nodes`);
 * ```
 */
export async function importGraph<G extends GraphDef>(
  store: Store<G>,
  data: GraphData,
  options: ImportOptions,
): Promise<ImportResult> {
  const result: ImportResult = {
    success: true,
    nodes: { created: 0, updated: 0, skipped: 0 },
    edges: { created: 0, updated: 0, skipped: 0 },
    errors: [],
  };

  const errors: ImportError[] = [];
  const graph = store.graph;
  const graphId = store.graphId;
  const backend = store.backend;

  // Build lookup maps for schema validation
  const nodeSchemas = buildNodeSchemaMap(graph);
  const edgeSchemas = buildEdgeSchemaMap(graph);

  // Track imported node IDs for reference validation
  const importedNodeIds = new Set<string>();

  // Process in transaction if supported
  if (backend.capabilities.transactions) {
    await backend.transaction(async (tx) => {
      await processNodes(
        tx,
        graphId,
        data.nodes,
        nodeSchemas,
        options,
        result,
        errors,
        importedNodeIds,
      );
      await processEdges(
        tx,
        graphId,
        data.edges,
        edgeSchemas,
        nodeSchemas,
        options,
        result,
        errors,
        importedNodeIds,
      );
    });
  } else {
    await processNodes(
      backend,
      graphId,
      data.nodes,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
    );
    await processEdges(
      backend,
      graphId,
      data.edges,
      edgeSchemas,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
    );
  }

  return {
    ...result,
    success: errors.length === 0,
    errors,
  };
}

// ============================================================
// Schema Maps
// ============================================================

type NodeSchemaEntry = Readonly<{
  registration: NodeRegistration;
  schema: z.ZodObject<z.ZodRawShape>;
}>;

type EdgeSchemaEntry = Readonly<{
  registration: EdgeRegistration;
  schema: z.ZodObject<z.ZodRawShape>;
  fromKinds: ReadonlySet<string>;
  toKinds: ReadonlySet<string>;
}>;

function buildNodeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, NodeSchemaEntry> {
  const map = new Map<string, NodeSchemaEntry>();

  for (const kindName of getNodeTypeNames(graph)) {
    const registration = graph.nodes[kindName] as NodeRegistration;
    map.set(kindName, {
      registration,
      schema: registration.type.schema,
    });
  }

  return map;
}

function buildEdgeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, EdgeSchemaEntry> {
  const map = new Map<string, EdgeSchemaEntry>();

  for (const kindName of getEdgeTypeNames(graph)) {
    const registration = graph.edges[kindName] as EdgeRegistration;
    map.set(kindName, {
      registration,
      schema: registration.type.schema,
      fromKinds: new Set(registration.from.map((node) => node.name)),
      toKinds: new Set(registration.to.map((node) => node.name)),
    });
  }

  return map;
}

// ============================================================
// Node Processing
// ============================================================

async function processNodes(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  nodes: readonly InterchangeNode[],
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);

    for (const node of batch) {
      const importResult = await processNode(
        backend,
        graphId,
        node,
        schemas,
        options,
      );

      switch (importResult.status) {
        case "created": {
          result.nodes.created++;
          importedNodeIds.add(makeNodeKey(node.kind, node.id));
          break;
        }
        case "updated": {
          result.nodes.updated++;
          importedNodeIds.add(makeNodeKey(node.kind, node.id));
          break;
        }
        case "skipped": {
          result.nodes.skipped++;
          // Still track as available for edge references
          importedNodeIds.add(makeNodeKey(node.kind, node.id));
          break;
        }
        case "error": {
          errors.push({
            entityType: "node",
            kind: node.kind,
            id: node.id,
            error: importResult.error,
          });
          break;
        }
      }
    }
  }
}

type ProcessResult =
  | { status: "created" }
  | { status: "updated" }
  | { status: "skipped" }
  | { status: "error"; error: string };

async function processNode(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  node: InterchangeNode,
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
): Promise<ProcessResult> {
  // Validate kind exists
  const schemaEntry = schemas.get(node.kind);
  if (!schemaEntry) {
    return { status: "error", error: `Unknown node kind: ${node.kind}` };
  }

  // Validate and transform properties
  const propsResult = validateProperties(
    node.properties,
    schemaEntry.schema,
    options.onUnknownProperty,
  );

  if (!propsResult.success) {
    return { status: "error", error: propsResult.error };
  }

  // Check if node already exists
  const existing = await backend.getNode(graphId, node.kind, node.id);

  if (existing) {
    switch (options.onConflict) {
      case "skip": {
        return { status: "skipped" };
      }
      case "error": {
        return {
          status: "error",
          error: `Node already exists: ${node.kind}:${node.id}`,
        };
      }
      case "update": {
        await backend.updateNode({
          graphId,
          kind: node.kind,
          id: node.id,
          props: propsResult.data,
          incrementVersion: true,
          ...(node.validTo !== undefined && { validTo: node.validTo }),
        });
        return { status: "updated" };
      }
    }
  }

  // Create new node
  await backend.insertNode({
    graphId,
    kind: node.kind,
    id: node.id,
    props: propsResult.data,
    ...(node.validFrom !== undefined && { validFrom: node.validFrom }),
    ...(node.validTo !== undefined && { validTo: node.validTo }),
  });

  return { status: "created" };
}

// ============================================================
// Edge Processing
// ============================================================

async function processEdges(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  edges: readonly InterchangeEdge[],
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < edges.length; index += batchSize) {
    const batch = edges.slice(index, index + batchSize);

    for (const edge of batch) {
      const importResult = await processEdge(
        backend,
        graphId,
        edge,
        edgeSchemas,
        nodeSchemas,
        options,
        importedNodeIds,
      );

      switch (importResult.status) {
        case "created": {
          result.edges.created++;
          break;
        }
        case "updated": {
          result.edges.updated++;
          break;
        }
        case "skipped": {
          result.edges.skipped++;
          break;
        }
        case "error": {
          errors.push({
            entityType: "edge",
            kind: edge.kind,
            id: edge.id,
            error: importResult.error,
          });
          break;
        }
      }
    }
  }
}

async function processEdge(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  edge: InterchangeEdge,
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
  importedNodeIds: Set<string>,
): Promise<ProcessResult> {
  // Validate edge kind exists
  const schemaEntry = edgeSchemas.get(edge.kind);
  if (!schemaEntry) {
    return { status: "error", error: `Unknown edge kind: ${edge.kind}` };
  }

  // Validate endpoint kinds
  if (!nodeSchemas.has(edge.from.kind)) {
    return {
      status: "error",
      error: `Unknown from node kind: ${edge.from.kind}`,
    };
  }
  if (!nodeSchemas.has(edge.to.kind)) {
    return { status: "error", error: `Unknown to node kind: ${edge.to.kind}` };
  }

  // Validate endpoint kinds are allowed for this edge type
  if (!schemaEntry.fromKinds.has(edge.from.kind)) {
    return {
      status: "error",
      error: `Edge ${edge.kind} does not allow from kind: ${edge.from.kind}`,
    };
  }
  if (!schemaEntry.toKinds.has(edge.to.kind)) {
    return {
      status: "error",
      error: `Edge ${edge.kind} does not allow to kind: ${edge.to.kind}`,
    };
  }

  // Validate references exist (in DB or in import batch)
  if (options.validateReferences) {
    const fromKey = makeNodeKey(edge.from.kind, edge.from.id);
    const toKey = makeNodeKey(edge.to.kind, edge.to.id);

    // Check import batch first, then DB
    if (!importedNodeIds.has(fromKey)) {
      const fromExists = await backend.getNode(
        graphId,
        edge.from.kind,
        edge.from.id,
      );
      if (!fromExists) {
        return {
          status: "error",
          error: `From node not found: ${edge.from.kind}:${edge.from.id}`,
        };
      }
    }

    if (!importedNodeIds.has(toKey)) {
      const toExists = await backend.getNode(graphId, edge.to.kind, edge.to.id);
      if (!toExists) {
        return {
          status: "error",
          error: `To node not found: ${edge.to.kind}:${edge.to.id}`,
        };
      }
    }
  }

  // Validate and transform properties
  const propsResult = validateProperties(
    edge.properties,
    schemaEntry.schema,
    options.onUnknownProperty,
  );

  if (!propsResult.success) {
    return { status: "error", error: propsResult.error };
  }

  // Check if edge already exists
  const existing = await backend.getEdge(graphId, edge.id);

  if (existing) {
    switch (options.onConflict) {
      case "skip": {
        return { status: "skipped" };
      }
      case "error": {
        return { status: "error", error: `Edge already exists: ${edge.id}` };
      }
      case "update": {
        await backend.updateEdge({
          graphId,
          id: edge.id,
          props: propsResult.data,
          ...(edge.validTo !== undefined && { validTo: edge.validTo }),
        });
        return { status: "updated" };
      }
    }
  }

  // Create new edge
  await backend.insertEdge({
    graphId,
    id: edge.id,
    kind: edge.kind,
    fromKind: edge.from.kind,
    fromId: edge.from.id,
    toKind: edge.to.kind,
    toId: edge.to.id,
    props: propsResult.data,
    ...(edge.validFrom !== undefined && { validFrom: edge.validFrom }),
    ...(edge.validTo !== undefined && { validTo: edge.validTo }),
  });

  return { status: "created" };
}

// ============================================================
// Property Validation
// ============================================================

type ValidationResult =
  | { success: true; data: Record<string, unknown> }
  | { success: false; error: string };

function validateProperties(
  properties: Record<string, unknown>,
  schema: z.ZodObject<z.ZodRawShape>,
  unknownStrategy: UnknownPropertyStrategy,
): ValidationResult {
  try {
    // Get the schema's known keys
    const knownKeys = new Set(Object.keys(schema.shape));

    // Check for unknown properties
    const unknownKeys = Object.keys(properties).filter(
      (key) => !knownKeys.has(key),
    );

    if (unknownKeys.length > 0) {
      switch (unknownStrategy) {
        case "error": {
          return {
            success: false,
            error: `Unknown properties: ${unknownKeys.join(", ")}`,
          };
        }
        case "strip": {
          // Remove unknown properties
          const stripped: Record<string, unknown> = {};
          for (const key of knownKeys) {
            if (key in properties) {
              stripped[key] = properties[key];
            }
          }
          // Validate stripped properties
          const result = schema.safeParse(stripped);
          if (!result.success) {
            return {
              success: false,
              error: formatZodError(result.error),
            };
          }
          return {
            success: true,
            data: result.data,
          };
        }
        case "allow": {
          // Validate but allow extra properties through
          const result = schema.safeParse(properties);
          if (!result.success) {
            return {
              success: false,
              error: formatZodError(result.error),
            };
          }
          // Return original properties (including unknown ones)
          return { success: true, data: properties };
        }
      }
    }

    // No unknown properties - standard validation
    const result = schema.safeParse(properties);
    if (!result.success) {
      return { success: false, error: formatZodError(result.error) };
    }

    return { success: true, data: result.data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: `Validation error: ${message}` };
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}

// ============================================================
// Helpers
// ============================================================

function makeNodeKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}
