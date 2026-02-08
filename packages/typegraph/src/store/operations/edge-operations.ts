/**
 * Edge Operations for Store
 *
 * Handles edge CRUD operations: create, update, delete.
 */
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { validateEdgeEndpoints } from "../../constraints";
import { type GraphDef } from "../../core/define-graph";
import { type EdgeRegistration, type EdgeType } from "../../core/types";
import {
  EdgeNotFoundError,
  EndpointNotFoundError,
  KindNotFoundError,
} from "../../errors";
import { validateEdgeProps } from "../../errors/validation";
import { type KindRegistry } from "../../registry/kind-registry";
import { validateOptionalIsoDate } from "../../utils/date";
import { generateId } from "../../utils/id";
import {
  checkCardinalityConstraint,
  type ConstraintContext,
} from "../constraints";
import { type EdgeRow, rowToEdge } from "../row-mappers";
import {
  type CreateEdgeInput,
  type Edge,
  type OperationHookContext,
} from "../types";

// ============================================================
// Types
// ============================================================

/**
 * Context for edge operations.
 */
export type EdgeOperationContext<G extends GraphDef> = Readonly<{
  graph: G;
  graphId: string;
  registry: KindRegistry;
  createOperationContext: (
    operation: "create" | "update" | "delete",
    entity: "node" | "edge",
    kind: string,
    id: string,
  ) => OperationHookContext;
  withOperationHooks: <T>(
    ctx: OperationHookContext,
    fn: () => Promise<T>,
  ) => Promise<T>;
}>;

// ============================================================
// Helper Functions
// ============================================================

function hasEdgeType<G extends GraphDef>(graph: G, kind: string): boolean {
  return kind in graph.edges;
}

function getEdgeRegistration<G extends GraphDef>(
  graph: G,
  kind: string,
): EdgeRegistration {
  if (!hasEdgeType(graph, kind)) {
    throw new KindNotFoundError(kind, "edge");
  }
  // Safe to use non-null assertion after the check above
  return graph.edges[kind] as EdgeRegistration;
}

// ============================================================
// Edge Operations
// ============================================================

/**
 * Executes an edge create operation.
 */
export async function executeEdgeCreate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: CreateEdgeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "edge", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    const fromKind = input.fromKind;
    const toKind = input.toKind;

    // Validate kind exists and get registration
    const registration = getEdgeRegistration(ctx.graph, kind);
    const edgeKind = registration.type as EdgeType;

    // Validate endpoint types
    const endpointError = validateEdgeEndpoints(
      kind,
      fromKind,
      toKind,
      registration,
      ctx.registry,
    );
    if (endpointError) throw endpointError;

    // Validate source node exists
    const fromNode = await backend.getNode(ctx.graphId, fromKind, input.fromId);
    if (!fromNode || fromNode.deleted_at) {
      throw new EndpointNotFoundError({
        edgeKind: kind,
        endpoint: "from",
        nodeKind: fromKind,
        nodeId: input.fromId,
      });
    }

    // Validate target node exists
    const toNode = await backend.getNode(ctx.graphId, toKind, input.toId);
    if (!toNode || toNode.deleted_at) {
      throw new EndpointNotFoundError({
        edgeKind: kind,
        endpoint: "to",
        nodeKind: toKind,
        nodeId: input.toId,
      });
    }

    // Validate props with full context
    const validatedProps = validateEdgeProps(edgeKind.schema, input.props, {
      kind,
      operation: "create",
    });

    // Validate temporal fields
    const validFrom = validateOptionalIsoDate(input.validFrom, "validFrom");
    const validTo = validateOptionalIsoDate(input.validTo, "validTo");

    // Check cardinality constraints
    const cardinality = registration.cardinality ?? "many";
    const constraintContext: ConstraintContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await checkCardinalityConstraint(
      constraintContext,
      kind,
      cardinality,
      fromKind,
      input.fromId,
      toKind,
      input.toId,
      input.validTo,
    );

    // Insert edge - conditionally include optional temporal fields
    const insertParams: {
      graphId: string;
      id: string;
      kind: string;
      fromKind: string;
      fromId: string;
      toKind: string;
      toId: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    } = {
      graphId: ctx.graphId,
      id,
      kind,
      fromKind,
      fromId: input.fromId,
      toKind,
      toId: input.toId,
      props: validatedProps,
    };
    if (validFrom !== undefined) insertParams.validFrom = validFrom;
    if (validTo !== undefined) insertParams.validTo = validTo;

    const row = await backend.insertEdge(insertParams);

    return rowToEdge(row as EdgeRow);
  });
}

/**
 * Executes an edge update operation.
 */
export async function executeEdgeUpdate<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  input: {
    id: string;
    props: Partial<Record<string, unknown>>;
    validTo?: string;
  },
  backend: GraphBackend | TransactionBackend,
): Promise<Edge> {
  const id = input.id;

  // Get existing edge first to get the kind for the hook context
  const existing = await backend.getEdge(ctx.graphId, id);
  if (!existing || existing.deleted_at) {
    throw new EdgeNotFoundError("unknown", id);
  }

  const opContext = ctx.createOperationContext(
    "update",
    "edge",
    existing.kind,
    id,
  );

  return ctx.withOperationHooks(opContext, async () => {
    // Get registration for schema validation
    const registration = getEdgeRegistration(ctx.graph, existing.kind);
    const edgeKind = registration.type as EdgeType;

    // Merge props
    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;
    const mergedProps = { ...existingProps, ...input.props };

    // Validate merged props with full context
    const validatedProps = validateEdgeProps(edgeKind.schema, mergedProps, {
      kind: existing.kind,
      operation: "update",
      id,
    });

    // Validate temporal fields
    const validTo = validateOptionalIsoDate(input.validTo, "validTo");

    // Update edge - conditionally include optional fields
    const updateParams: {
      graphId: string;
      id: string;
      props: Record<string, unknown>;
      validTo?: string;
    } = {
      graphId: ctx.graphId,
      id,
      props: validatedProps,
    };
    if (validTo !== undefined) updateParams.validTo = validTo;

    const row = await backend.updateEdge(updateParams);

    return rowToEdge(row as EdgeRow);
  });
}

/**
 * Executes an edge delete operation.
 */
export async function executeEdgeDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Get edge first to know the kind for the hook context
  const existing = await backend.getEdge(ctx.graphId, id);
  if (!existing || existing.deleted_at) {
    // Already deleted - nothing to do
    return;
  }

  const opContext = ctx.createOperationContext(
    "delete",
    "edge",
    existing.kind,
    id,
  );

  return ctx.withOperationHooks(opContext, async () => {
    await backend.deleteEdge({
      graphId: ctx.graphId,
      id,
    });
  });
}

/**
 * Executes an edge hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the edge from the database.
 */
export async function executeEdgeHardDelete<G extends GraphDef>(
  ctx: EdgeOperationContext<G>,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  // Get edge first to know the kind for the hook context
  const existing = await backend.getEdge(ctx.graphId, id);
  if (!existing) {
    // Doesn't exist - nothing to do
    return;
  }

  const opContext = ctx.createOperationContext(
    "delete",
    "edge",
    existing.kind,
    id,
  );

  return ctx.withOperationHooks(opContext, async () => {
    await backend.hardDeleteEdge({
      graphId: ctx.graphId,
      id,
    });
  });
}
