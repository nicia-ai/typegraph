/**
 * Graph data import functionality.
 *
 * Imports nodes and edges from the interchange format into a store,
 * with configurable conflict resolution and validation.
 */
import type { z } from "zod";

import {
  type GraphBackend,
  isLiveNodeRow,
  type TransactionBackend,
} from "../backend/types";
import { validateEdgeEndpoints } from "../constraints";
import {
  getEdgeKinds,
  getNodeKinds,
  type GraphDef,
} from "../core/define-graph";
import { type EdgeRegistration, type NodeRegistration } from "../core/types";
import { UniquenessError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import {
  applyNodeInsertSideEffects,
  applyNodeUpdate,
} from "../store/operations/node-write-pipeline";
import { runInWriteTransaction } from "../store/operations/write-transaction";
import { type GraphWriteLock } from "../store/recorded-capture/clock";
import { type Store } from "../store/store";
import { checkUniquenessConstraints } from "../store/uniqueness";
import { validateOptionalCanonicalIsoDate } from "../utils/date";
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
  const registry = store.registry;

  // Build lookup maps for schema validation
  const nodeSchemas = buildNodeSchemaMap(graph);
  const edgeSchemas = buildEdgeSchemaMap(graph);

  // Track imported node IDs for reference validation
  const importedNodeIds = new Set<string>();

  // One transaction on a transactional backend; runs directly otherwise, with
  // the per-graph write lock taken before any row work — see
  // runInWriteTransaction for the shared lock-before-rows contract every
  // writer follows.
  await runInWriteTransaction(store, backend, async (target, lock) => {
    await processNodes(
      target,
      graphId,
      registry,
      data.nodes,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
      lock,
    );
    await processEdges(
      target,
      graphId,
      registry,
      data.edges,
      edgeSchemas,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
    );
  });

  // A bulk load runs against stale planner statistics until ANALYZE runs
  // (documented regressions: 0.5ms → 5ms traversals on Postgres, 0.9ms →
  // 23ms fulltext on SQLite), so a mutating import refreshes them once,
  // after the transaction commits.
  const mutationCount =
    result.nodes.created +
    result.nodes.updated +
    result.edges.created +
    result.edges.updated;
  if ((options.refreshStatistics ?? true) && mutationCount > 0) {
    await store.refreshStatistics();
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
}>;

function buildNodeSchemaMap(
  graph: GraphDef,
): ReadonlyMap<string, NodeSchemaEntry> {
  const map = new Map<string, NodeSchemaEntry>();

  for (const kindName of getNodeKinds(graph)) {
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

  for (const kindName of getEdgeKinds(graph)) {
    const registration = graph.edges[kindName] as EdgeRegistration;
    map.set(kindName, {
      registration,
      schema: registration.type.schema,
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
  registry: KindRegistry,
  nodes: readonly InterchangeNode[],
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
  lock: GraphWriteLock,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);

    for (const node of batch) {
      const importResult = await processNode(
        backend,
        graphId,
        registry,
        node,
        schemas,
        options,
        lock,
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
          // A live skipped row is still a valid edge endpoint; a tombstone
          // is not.
          if (importResult.liveTarget) {
            importedNodeIds.add(makeNodeKey(node.kind, node.id));
          }
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
  /**
   * `liveTarget` distinguishes "skipped because a LIVE row already exists"
   * (a valid edge endpoint) from "skipped because the row is a tombstone"
   * (which must NOT be recorded as available — a live edge pointing at a
   * soft-deleted node violates the endpoint-liveness invariant the
   * collection API enforces).
   */
  | { status: "skipped"; liveTarget: boolean }
  | { status: "error"; error: string };

type UniquenessGuardResult<T> =
  Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string }>;

/**
 * Runs `fn` and reports a `UniquenessError` as a per-row result instead of
 * letting it abort the whole import — the same recovery both the node
 * uniqueness pre-check and the update path need. Any other error still
 * propagates.
 */
async function catchUniquenessError<T>(
  fn: () => Promise<T>,
): Promise<UniquenessGuardResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (error instanceof UniquenessError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Validates an entity's validity-window timestamps against the canonical
 * fixed-width UTC ISO-8601 contract that `create` / `update` enforce, so no
 * import write path can persist a non-canonical `valid_from` / `valid_to` that
 * later mis-sorts as text against an `asOf` read coordinate. The interchange
 * schema enforces the same contract at the parse boundary, but `importGraph`
 * accepts a pre-typed `GraphData` and does not re-parse it, so this is the
 * guarantee for callers that bypass the schema. Returns a per-row error message
 * (recorded in the import result) instead of throwing, so one malformed row
 * does not abort the whole import.
 */
function validateValidityWindow(
  entity: Readonly<{
    validFrom?: string | undefined;
    validTo?: string | undefined;
  }>,
): string | undefined {
  try {
    validateOptionalCanonicalIsoDate(entity.validFrom, "validFrom");
    validateOptionalCanonicalIsoDate(entity.validTo, "validTo");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function processNode(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  node: InterchangeNode,
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ImportOptions,
  lock: GraphWriteLock,
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

  const validityError = validateValidityWindow(node);
  if (validityError !== undefined) {
    return { status: "error", error: validityError };
  }

  const { registration } = schemaEntry;
  const uniqueConstraints = registration.unique ?? [];
  const writeContext = { graphId, registry, lock };

  // Check if node already exists
  const existing = await backend.getNode(graphId, node.kind, node.id);

  if (existing) {
    switch (options.onConflict) {
      case "skip": {
        return { status: "skipped", liveTarget: isLiveNodeRow(existing) };
      }
      case "error": {
        return {
          status: "error",
          error: `Node already exists: ${node.kind}:${node.id}`,
        };
      }
      case "update": {
        if (!isLiveNodeRow(existing)) {
          // A soft-deleted node is not updatable: import never resurrects a
          // tombstone, and running the live-row update pipeline here would
          // recreate uniqueness/embedding/fulltext rows for a node that
          // stays invisible — a uniqueness reservation held by a tombstoned
          // node would block live creates of the same value.
          return { status: "skipped", liveTarget: false };
        }
        // Route through the shared write step so the update maintains
        // uniqueness entries, embeddings, and fulltext — the collection API's
        // integrity, which a raw backend.updateNode would skip. A uniqueness
        // conflict is reported per-row (updateUniquenessEntries throws before
        // the row is written, so no partial write escapes).
        const updateResult = await catchUniquenessError(() =>
          applyNodeUpdate(
            writeContext,
            {
              existing,
              schema: registration.type.schema,
              validatedProps: propsResult.data,
              uniqueConstraints,
              ...(node.validTo !== undefined && { validTo: node.validTo }),
            },
            backend,
          ),
        );
        if (!updateResult.ok) {
          return { status: "error", error: updateResult.error };
        }
        return { status: "updated" };
      }
    }
  }

  // Create new node. Pre-check uniqueness (as the collection create does) so a
  // conflict is a per-row error rather than an orphaned node row, then apply the
  // integrity side effects the raw backend.insertNode would otherwise bypass.
  const uniquenessResult = await catchUniquenessError(() =>
    checkUniquenessConstraints(
      { graphId, registry, backend },
      node.kind,
      node.id,
      propsResult.data,
      uniqueConstraints,
    ),
  );
  if (!uniquenessResult.ok) {
    return { status: "error", error: uniquenessResult.error };
  }

  await backend.insertNode({
    graphId,
    kind: node.kind,
    id: node.id,
    props: propsResult.data,
    ...(node.validFrom !== undefined && { validFrom: node.validFrom }),
    ...(node.validTo !== undefined && { validTo: node.validTo }),
  });
  await applyNodeInsertSideEffects(
    writeContext,
    {
      kind: node.kind,
      id: node.id,
      schema: registration.type.schema,
      props: propsResult.data,
      uniqueConstraints,
    },
    backend,
  );

  return { status: "created" };
}

// ============================================================
// Edge Processing
// ============================================================

async function processEdges(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
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
        registry,
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
  registry: KindRegistry,
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

  // Validate endpoint kinds exist
  if (!nodeSchemas.has(edge.from.kind)) {
    return {
      status: "error",
      error: `Unknown from node kind: ${edge.from.kind}`,
    };
  }
  if (!nodeSchemas.has(edge.to.kind)) {
    return { status: "error", error: `Unknown to node kind: ${edge.to.kind}` };
  }

  // Validate endpoint kinds are allowed for this edge type. Uses the shared,
  // subclass-aware check (registry.isAssignableTo) that the collection API uses,
  // so an edge whose endpoint is a subclass of a declared kind — legal in the
  // store and emitted verbatim by export — imports cleanly instead of being
  // rejected by an exact-kind comparison.
  const endpointError = validateEdgeEndpoints(
    edge.kind,
    edge.from.kind,
    edge.to.kind,
    schemaEntry.registration,
    registry,
  );
  if (endpointError !== undefined) {
    return { status: "error", error: endpointError.message };
  }

  // Validate references exist (in DB or in import batch)
  if (options.validateReferences) {
    const fromKey = makeNodeKey(edge.from.kind, edge.from.id);
    const toKey = makeNodeKey(edge.to.kind, edge.to.id);

    // Check import batch first, then DB. The DB row must be LIVE: getNode
    // returns tombstones, and inserting an edge whose endpoint is
    // soft-deleted would bypass the endpoint-liveness invariant the
    // collection API enforces.
    if (!importedNodeIds.has(fromKey)) {
      const fromExists = await backend.getNode(
        graphId,
        edge.from.kind,
        edge.from.id,
      );
      if (fromExists === undefined || !isLiveNodeRow(fromExists)) {
        return {
          status: "error",
          error: `From node not found: ${edge.from.kind}:${edge.from.id}`,
        };
      }
    }

    if (!importedNodeIds.has(toKey)) {
      const toExists = await backend.getNode(graphId, edge.to.kind, edge.to.id);
      if (toExists === undefined || !isLiveNodeRow(toExists)) {
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

  const validityError = validateValidityWindow(edge);
  if (validityError !== undefined) {
    return { status: "error", error: validityError };
  }

  // Check if edge already exists
  const existing = await backend.getEdge(graphId, edge.id);

  if (existing) {
    switch (options.onConflict) {
      case "skip": {
        return {
          status: "skipped",
          liveTarget: existing.deleted_at === undefined,
        };
      }
      case "error": {
        return { status: "error", error: `Edge already exists: ${edge.id}` };
      }
      case "update": {
        // Same contract as nodes: import never resurrects a tombstone, and
        // the backend's update targets live rows only.
        if (existing.deleted_at !== undefined) {
          return { status: "skipped", liveTarget: false };
        }
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
          // Validate the known fields, then return the ORIGINAL properties
          // verbatim — unknown keys preserved, known values byte-for-byte.
          // Exported data already carries post-transform values, so
          // re-applying schema transforms here would corrupt every
          // export→import round trip whose transforms are not idempotent.
          // "allow" is the fidelity-preserving strategy; "strip" (and the
          // create path) remain the normalizing ones.
          const result = schema.safeParse(properties);
          if (!result.success) {
            return {
              success: false,
              error: formatZodError(result.error),
            };
          }
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
