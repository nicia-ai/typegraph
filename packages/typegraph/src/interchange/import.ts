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
  createNodeBatchValidationBackend,
  type NodeCreateDraft,
  primeBatchValidationCaches,
} from "../store/operations/node-operations";
import {
  applyNodeInsertSideEffects,
  applyNodeInsertSideEffectsBatch,
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
  ImportOptionsSchema,
  type ImportResult,
  type InterchangeEdge,
  type InterchangeNode,
  type ResolvedImportOptions,
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
  rawOptions: ImportOptions,
): Promise<ImportResult> {
  // Parse ONCE at the public boundary: schema defaults (batchSize, ...)
  // only exist after parsing, and every internal stage reads them
  // directly.
  const options = ImportOptionsSchema.parse(rawOptions);
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
  //
  // Best-effort: by this point the import is committed, so a failed
  // statistics refresh must not convert the completed (non-atomic on some
  // backends, non-retryable) import into a thrown failure — it degrades to
  // a warning, and the caller can run `store.refreshStatistics()`.
  const mutationCount =
    result.nodes.created +
    result.nodes.updated +
    result.edges.created +
    result.edges.updated;
  if ((options.refreshStatistics ?? true) && mutationCount > 0) {
    try {
      await store.refreshStatistics();
    } catch (error) {
      if (
        typeof console !== "undefined" &&
        typeof console.warn === "function"
      ) {
        console.warn(
          "[typegraph] importGraph committed its rows but the follow-up " +
            "statistics refresh failed; run store.refreshStatistics() to " +
            "give the planner fresh statistics.",
          error,
        );
      }
    }
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
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
  lock: GraphWriteLock,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < nodes.length; index += batchSize) {
    const batch = nodes.slice(index, index + batchSize);
    await processNodeSlice(
      backend,
      graphId,
      registry,
      batch,
      schemas,
      options,
      result,
      errors,
      importedNodeIds,
      lock,
    );
  }
}

function recordNodeOutcome(
  node: InterchangeNode,
  outcome: ProcessResult,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): void {
  switch (outcome.status) {
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
      if (outcome.liveTarget) {
        importedNodeIds.add(makeNodeKey(node.kind, node.id));
      }
      break;
    }
    case "error": {
      errors.push({
        entityType: "node",
        kind: node.kind,
        id: node.id,
        error: outcome.error,
      });
      break;
    }
  }
}

type NodeImportCandidate = Readonly<{
  node: InterchangeNode;
  schemaEntry: NodeSchemaEntry;
  props: Record<string, unknown>;
  draft: NodeCreateDraft;
}>;

/**
 * Processes one batchSize slice of nodes with batched round trips:
 * one `getNodes` per kind for existence, one `checkUniqueBatch` per
 * (constraint, kind) for uniqueness pre-checks (both priming the shared
 * batch validation caches), then one multi-row insert and one batched
 * side-effect pass for the accepted creates. Per-row semantics are
 * unchanged — conflicts route by `onConflict`, a uniqueness conflict is a
 * per-row error entry, and rows repeating an id already seen in the slice
 * defer to the per-row path after the flush (so they observe the first
 * occurrence's row exactly as the sequential implementation did).
 */
async function processNodeSlice(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  batch: readonly InterchangeNode[],
  schemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
  lock: GraphWriteLock,
): Promise<void> {
  const record = (node: InterchangeNode, outcome: ProcessResult): void => {
    recordNodeOutcome(node, outcome, result, errors, importedNodeIds);
  };

  // Pass 1 (synchronous): kind + property + validity validation, and
  // in-slice duplicate deferral.
  const candidates: NodeImportCandidate[] = [];
  const deferred: InterchangeNode[] = [];
  const seenKeys = new Set<string>();
  for (const node of batch) {
    const schemaEntry = schemas.get(node.kind);
    if (!schemaEntry) {
      record(node, {
        status: "error",
        error: `Unknown node kind: ${node.kind}`,
      });
      continue;
    }
    const propsResult = validateProperties(
      node.properties,
      schemaEntry.schema,
      options.onUnknownProperty,
    );
    if (!propsResult.success) {
      record(node, { status: "error", error: propsResult.error });
      continue;
    }
    const validityError = validateValidityWindow(node);
    if (validityError !== undefined) {
      record(node, { status: "error", error: validityError });
      continue;
    }
    const key = makeNodeKey(node.kind, node.id);
    if (seenKeys.has(key)) {
      deferred.push(node);
      continue;
    }
    seenKeys.add(key);
    candidates.push({
      node,
      schemaEntry,
      props: propsResult.data,
      draft: {
        kind: node.kind,
        id: node.id,
        nodeKind: schemaEntry.registration.type,
        uniqueConstraints: schemaEntry.registration.unique ?? [],
        validatedProps: propsResult.data,
        // NodeCreateDraft.validFrom is string | undefined (never null) — it
        // only feeds batch validation-cache priming, which never inspects
        // it, so normalizing the explicit-NULL sentinel away here is inert.
        // The actual insert (buildImportInsertParams) reads node.validFrom
        // directly and preserves the null.
        validFrom: node.validFrom ?? undefined,
        validTo: node.validTo,
      },
    });
  }

  // Prime the validation caches with batched reads, then route each row
  // against memory in input order.
  const {
    backend: validationBackend,
    registerPendingNode,
    registerPendingUniqueEntries,
    seedNodeRow,
    seedUniqueRow,
  } = createNodeBatchValidationBackend(graphId, registry, backend);
  await primeBatchValidationCaches(
    { graphId, registry },
    candidates.map((candidate) => candidate.draft),
    backend,
    { seedNodeRow, seedUniqueRow },
  );

  const writeContext = { graphId, registry, lock };
  const accepted: NodeImportCandidate[] = [];
  for (const candidate of candidates) {
    const { node, schemaEntry, props } = candidate;
    const uniqueConstraints = schemaEntry.registration.unique ?? [];
    const existing = await validationBackend.getNode(
      graphId,
      node.kind,
      node.id,
    );

    if (existing) {
      switch (options.onConflict) {
        case "skip": {
          record(node, {
            status: "skipped",
            liveTarget: isLiveNodeRow(existing),
          });
          break;
        }
        case "error": {
          record(node, {
            status: "error",
            error: `Node already exists: ${node.kind}:${node.id}`,
          });
          break;
        }
        case "update": {
          if (!isLiveNodeRow(existing)) {
            // Import never resurrects a tombstone — see processNode.
            record(node, { status: "skipped", liveTarget: false });
            break;
          }
          const updateResult = await catchUniquenessError(() =>
            applyNodeUpdate(
              writeContext,
              {
                existing,
                schema: schemaEntry.registration.type.schema,
                validatedProps: props,
                uniqueConstraints,
                ...(node.validTo !== undefined && { validTo: node.validTo }),
              },
              backend,
            ),
          );
          record(
            node,
            updateResult.ok ?
              { status: "updated" }
            : { status: "error", error: updateResult.error },
          );
          break;
        }
      }
      continue;
    }

    const uniquenessResult = await catchUniquenessError(() =>
      checkUniquenessConstraints(
        { graphId, registry, backend: validationBackend },
        node.kind,
        node.id,
        props,
        uniqueConstraints,
      ),
    );
    if (!uniquenessResult.ok) {
      record(node, { status: "error", error: uniquenessResult.error });
      continue;
    }

    registerPendingNode(buildImportInsertParams(graphId, candidate));
    registerPendingUniqueEntries(node.kind, node.id, props, uniqueConstraints);
    accepted.push(candidate);
  }

  // Flush the accepted creates: one multi-row insert, then the batched
  // side effects (uniqueness entries, fulltext, embeddings).
  if (accepted.length > 0) {
    const insertParamsList = accepted.map((candidate) =>
      buildImportInsertParams(graphId, candidate),
    );
    if (backend.insertNodesBatch === undefined) {
      for (const params of insertParamsList) {
        await backend.insertNode(params);
      }
    } else {
      await backend.insertNodesBatch(insertParamsList);
    }
    await applyNodeInsertSideEffectsBatch(
      writeContext,
      accepted.map((candidate) => ({
        kind: candidate.node.kind,
        id: candidate.node.id,
        schema: candidate.schemaEntry.registration.type.schema,
        props: candidate.props,
        uniqueConstraints: candidate.schemaEntry.registration.unique ?? [],
      })),
      backend,
    );
    for (const candidate of accepted) {
      record(candidate.node, { status: "created" });
    }
  }

  // In-slice duplicate ids run per-row AFTER the flush so they observe the
  // first occurrence's committed row, exactly as the sequential path did.
  for (const node of deferred) {
    record(
      node,
      await processNode(
        backend,
        graphId,
        registry,
        node,
        schemas,
        options,
        lock,
      ),
    );
  }
}

function buildImportInsertParams(
  graphId: string,
  candidate: NodeImportCandidate,
): Parameters<GraphBackend["insertNode"]>[0] {
  const { node, props } = candidate;
  return {
    graphId,
    kind: node.kind,
    id: node.id,
    props,
    ...(node.validFrom !== undefined && { validFrom: node.validFrom }),
    ...(node.validTo !== undefined && { validTo: node.validTo }),
  };
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
    validFrom?: string | null | undefined;
    validTo?: string | undefined;
  }>,
): string | undefined {
  try {
    // null is a confirmed open-left window (see InterchangeNodeSchema's
    // validFrom doc), not a value to format-check — treat it like
    // "not provided" here, same as the canonical-date validator does.
    validateOptionalCanonicalIsoDate(
      entity.validFrom ?? undefined,
      "validFrom",
    );
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
  options: ResolvedImportOptions,
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
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const batchSize = options.batchSize;

  for (let index = 0; index < edges.length; index += batchSize) {
    const batch = edges.slice(index, index + batchSize);
    await processEdgeSlice(
      backend,
      graphId,
      registry,
      batch,
      edgeSchemas,
      nodeSchemas,
      options,
      result,
      errors,
      importedNodeIds,
    );
  }
}

function recordEdgeOutcome(
  edge: InterchangeEdge,
  outcome: ProcessResult,
  result: ImportResult,
  errors: ImportError[],
): void {
  switch (outcome.status) {
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
        error: outcome.error,
      });
      break;
    }
  }
}

type EdgeImportCandidate = Readonly<{
  edge: InterchangeEdge;
  props: Record<string, unknown>;
}>;

/**
 * Processes one batchSize slice of edges with batched round trips: one
 * `getNodes` per endpoint kind for reference liveness, one `getEdges` for
 * existence, and one multi-row insert for the accepted creates. Per-row
 * semantics are unchanged; duplicate ids within a slice defer to the
 * per-row path after the flush.
 */
async function processEdgeSlice(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  batch: readonly InterchangeEdge[],
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
  result: ImportResult,
  errors: ImportError[],
  importedNodeIds: Set<string>,
): Promise<void> {
  const record = (edge: InterchangeEdge, outcome: ProcessResult): void => {
    recordEdgeOutcome(edge, outcome, result, errors);
  };

  // Pass 1 (synchronous): kind, endpoint-kind, endpoint-assignability,
  // property, and validity validation, plus in-slice duplicate deferral.
  const candidates: EdgeImportCandidate[] = [];
  const deferred: InterchangeEdge[] = [];
  const seenIds = new Set<string>();
  for (const edge of batch) {
    const schemaEntry = edgeSchemas.get(edge.kind);
    if (!schemaEntry) {
      record(edge, {
        status: "error",
        error: `Unknown edge kind: ${edge.kind}`,
      });
      continue;
    }
    if (!nodeSchemas.has(edge.from.kind)) {
      record(edge, {
        status: "error",
        error: `Unknown from node kind: ${edge.from.kind}`,
      });
      continue;
    }
    if (!nodeSchemas.has(edge.to.kind)) {
      record(edge, {
        status: "error",
        error: `Unknown to node kind: ${edge.to.kind}`,
      });
      continue;
    }
    const endpointError = validateEdgeEndpoints(
      edge.kind,
      edge.from.kind,
      edge.to.kind,
      schemaEntry.registration,
      registry,
    );
    if (endpointError !== undefined) {
      record(edge, { status: "error", error: endpointError.message });
      continue;
    }
    const propsResult = validateProperties(
      edge.properties,
      schemaEntry.schema,
      options.onUnknownProperty,
    );
    if (!propsResult.success) {
      record(edge, { status: "error", error: propsResult.error });
      continue;
    }
    const validityError = validateValidityWindow(edge);
    if (validityError !== undefined) {
      record(edge, { status: "error", error: validityError });
      continue;
    }
    if (seenIds.has(edge.id)) {
      deferred.push(edge);
      continue;
    }
    seenIds.add(edge.id);
    candidates.push({ edge, props: propsResult.data });
  }

  // Batch the endpoint-liveness reads: one getNodes per endpoint kind for
  // every key the import itself didn't create. Falls back to per-row
  // getNode inside the routing loop when the backend lacks getNodes.
  const liveEndpointKeys = new Set<string>();
  const checkedEndpointKeys = new Set<string>();
  if (options.validateReferences && backend.getNodes !== undefined) {
    const idsByKind = new Map<string, Set<string>>();
    for (const { edge } of candidates) {
      for (const endpoint of [edge.from, edge.to]) {
        const key = makeNodeKey(endpoint.kind, endpoint.id);
        if (importedNodeIds.has(key) || checkedEndpointKeys.has(key)) continue;
        checkedEndpointKeys.add(key);
        const ids = idsByKind.get(endpoint.kind) ?? new Set<string>();
        ids.add(endpoint.id);
        idsByKind.set(endpoint.kind, ids);
      }
    }
    for (const [kind, ids] of idsByKind) {
      const rows = await backend.getNodes(graphId, kind, [...ids]);
      for (const row of rows) {
        if (isLiveNodeRow(row)) {
          liveEndpointKeys.add(makeNodeKey(kind, row.id));
        }
      }
    }
  }

  const endpointIsLive = async (endpoint: {
    kind: string;
    id: string;
  }): Promise<boolean> => {
    const key = makeNodeKey(endpoint.kind, endpoint.id);
    if (importedNodeIds.has(key)) return true;
    if (checkedEndpointKeys.has(key)) return liveEndpointKeys.has(key);
    const row = await backend.getNode(graphId, endpoint.kind, endpoint.id);
    return row !== undefined && isLiveNodeRow(row);
  };

  // Batch the existence reads. Falls back to per-row getEdge when the
  // backend lacks getEdges.
  const existingById = new Map<
    string,
    Awaited<ReturnType<GraphBackend["getEdge"]>>
  >();
  if (candidates.length > 0 && backend.getEdges !== undefined) {
    const rows = await backend.getEdges(
      graphId,
      candidates.map((candidate) => candidate.edge.id),
    );
    for (const row of rows) {
      existingById.set(row.id, row);
    }
    for (const { edge } of candidates) {
      if (!existingById.has(edge.id)) existingById.set(edge.id, undefined);
    }
  }

  const accepted: EdgeImportCandidate[] = [];
  for (const candidate of candidates) {
    const { edge, props } = candidate;

    if (options.validateReferences) {
      if (!(await endpointIsLive(edge.from))) {
        record(edge, {
          status: "error",
          error: `From node not found: ${edge.from.kind}:${edge.from.id}`,
        });
        continue;
      }
      if (!(await endpointIsLive(edge.to))) {
        record(edge, {
          status: "error",
          error: `To node not found: ${edge.to.kind}:${edge.to.id}`,
        });
        continue;
      }
    }

    const existing =
      existingById.has(edge.id) ?
        existingById.get(edge.id)
      : await backend.getEdge(graphId, edge.id);

    if (existing) {
      switch (options.onConflict) {
        case "skip": {
          record(edge, {
            status: "skipped",
            liveTarget: existing.deleted_at === undefined,
          });
          break;
        }
        case "error": {
          record(edge, {
            status: "error",
            error: `Edge already exists: ${edge.id}`,
          });
          break;
        }
        case "update": {
          if (existing.deleted_at !== undefined) {
            record(edge, { status: "skipped", liveTarget: false });
            break;
          }
          await backend.updateEdge({
            graphId,
            id: edge.id,
            props,
            ...(edge.validTo !== undefined && { validTo: edge.validTo }),
          });
          record(edge, { status: "updated" });
          break;
        }
      }
      continue;
    }

    accepted.push(candidate);
  }

  if (accepted.length > 0) {
    const insertParamsList = accepted.map(({ edge, props }) => ({
      graphId,
      id: edge.id,
      kind: edge.kind,
      fromKind: edge.from.kind,
      fromId: edge.from.id,
      toKind: edge.to.kind,
      toId: edge.to.id,
      props,
      ...(edge.validFrom !== undefined && { validFrom: edge.validFrom }),
      ...(edge.validTo !== undefined && { validTo: edge.validTo }),
    }));
    if (backend.insertEdgesBatch === undefined) {
      for (const params of insertParamsList) {
        await backend.insertEdge(params);
      }
    } else {
      await backend.insertEdgesBatch(insertParamsList);
    }
    for (const candidate of accepted) {
      record(candidate.edge, { status: "created" });
    }
  }

  for (const edge of deferred) {
    record(
      edge,
      await processEdge(
        backend,
        graphId,
        registry,
        edge,
        edgeSchemas,
        nodeSchemas,
        options,
        importedNodeIds,
      ),
    );
  }
}

async function processEdge(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  registry: KindRegistry,
  edge: InterchangeEdge,
  edgeSchemas: ReadonlyMap<string, EdgeSchemaEntry>,
  nodeSchemas: ReadonlyMap<string, NodeSchemaEntry>,
  options: ResolvedImportOptions,
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
