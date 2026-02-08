/**
 * Node Operations for Store
 *
 * Handles node CRUD operations: create, update, delete.
 */
import {
  type GraphBackend,
  type TransactionBackend,
} from "../../backend/types";
import { type GraphDef } from "../../core/define-graph";
import { type NodeType } from "../../core/types";
import {
  KindNotFoundError,
  NodeNotFoundError,
  RestrictedDeleteError,
  ValidationError,
} from "../../errors";
import { validateNodeProps } from "../../errors/validation";
import { type KindRegistry } from "../../registry/kind-registry";
import { validateOptionalIsoDate } from "../../utils/date";
import { generateId } from "../../utils/id";
import {
  checkDisjointnessConstraint,
  type ConstraintContext,
} from "../constraints";
import {
  deleteNodeEmbeddings,
  type EmbeddingSyncContext,
  syncEmbeddings,
} from "../embedding-sync";
import { type NodeRow, rowToNode } from "../row-mappers";
import {
  type CreateNodeInput,
  type Node,
  type OperationHookContext,
  type UpdateNodeInput,
} from "../types";
import {
  checkUniquenessConstraints,
  deleteUniquenessEntries,
  insertUniquenessEntries,
  type UniquenessContext,
  updateUniquenessEntries,
} from "../uniqueness";

// ============================================================
// Types
// ============================================================

/**
 * Context for node operations.
 */
export type NodeOperationContext<G extends GraphDef> = Readonly<{
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

function hasNodeType<G extends GraphDef>(graph: G, kind: string): boolean {
  return kind in graph.nodes;
}

function getNodeRegistration<G extends GraphDef>(graph: G, kind: string) {
  if (!hasNodeType(graph, kind)) {
    throw new KindNotFoundError(kind, "node");
  }
  // Safe to use non-null assertion after the check above
  return graph.nodes[kind]!;
}

// ============================================================
// Node Operations
// ============================================================

/**
 * Executes a node create operation.
 */
export async function executeNodeCreate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: CreateNodeInput,
  backend: GraphBackend | TransactionBackend,
): Promise<Node> {
  const kind = input.kind;
  const id = input.id ?? generateId();
  const opContext = ctx.createOperationContext("create", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Validate props with full context
    const nodeKind = registration.type as NodeType;
    const validatedProps = validateNodeProps(nodeKind.schema, input.props, {
      kind,
      operation: "create",
    });

    // Validate temporal fields
    const validFrom = validateOptionalIsoDate(input.validFrom, "validFrom");
    const validTo = validateOptionalIsoDate(input.validTo, "validTo");

    // Check if node with this kind:id already exists
    const existingNode = await backend.getNode(ctx.graphId, kind, id);
    if (existingNode && !existingNode.deleted_at) {
      throw new ValidationError(
        `Node already exists: ${kind}/${id}`,
        {
          entityType: "node",
          kind,
          operation: "create",
          id,
          issues: [
            { path: "id", message: "A node with this ID already exists" },
          ],
        },
        { suggestion: `Use a different ID or update the existing node.` },
      );
    }

    // Check disjointness constraints (for multi-kind nodes with same ID)
    const constraintContext: ConstraintContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await checkDisjointnessConstraint(constraintContext, kind, id);

    // Check uniqueness constraints
    const uniquenessContext: UniquenessContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await checkUniquenessConstraints(
      uniquenessContext,
      kind,
      id,
      validatedProps,
      registration.unique ?? [],
    );

    // Insert node - conditionally include optional temporal fields
    const insertParams: {
      graphId: string;
      kind: string;
      id: string;
      props: Record<string, unknown>;
      validFrom?: string;
      validTo?: string;
    } = {
      graphId: ctx.graphId,
      kind,
      id,
      props: validatedProps,
    };
    if (validFrom !== undefined) insertParams.validFrom = validFrom;
    if (validTo !== undefined) insertParams.validTo = validTo;

    const row = await backend.insertNode(insertParams);

    // Insert uniqueness entries
    await insertUniquenessEntries(
      uniquenessContext,
      kind,
      id,
      validatedProps,
      registration.unique ?? [],
    );

    // Sync embeddings
    const embeddingSyncContext: EmbeddingSyncContext = {
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
      backend,
    };
    await syncEmbeddings(embeddingSyncContext, nodeKind.schema, validatedProps);

    return rowToNode(row as NodeRow);
  });
}

/**
 * Executes a node update operation.
 */
export async function executeNodeUpdate<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  input: UpdateNodeInput,
  backend: GraphBackend | TransactionBackend,
  options?: Readonly<{ clearDeleted?: boolean }>,
): Promise<Node> {
  const kind = input.kind;
  const id = input.id as string;
  const opContext = ctx.createOperationContext("update", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Get existing node
    const existing = await backend.getNode(ctx.graphId, kind, id);
    // If clearDeleted is set, allow updating deleted nodes (used by upsert)
    if (!existing || (existing.deleted_at && !options?.clearDeleted)) {
      throw new NodeNotFoundError(kind, id);
    }

    // Merge props
    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;
    const mergedProps = { ...existingProps, ...input.props };

    // Validate merged props with full context
    const nodeKind = registration.type as NodeType;
    const validatedProps = validateNodeProps(nodeKind.schema, mergedProps, {
      kind,
      operation: "update",
      id,
    });

    // Validate temporal fields
    const validTo = validateOptionalIsoDate(input.validTo, "validTo");

    // Handle uniqueness constraint changes
    const uniquenessContext: UniquenessContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await updateUniquenessEntries(
      uniquenessContext,
      kind,
      id,
      existingProps,
      validatedProps,
      registration.unique ?? [],
    );

    // Update node - conditionally include optional fields
    const updateParams: {
      graphId: string;
      kind: string;
      id: string;
      props: Record<string, unknown>;
      validTo?: string;
      incrementVersion?: boolean;
      clearDeleted?: boolean;
    } = {
      graphId: ctx.graphId,
      kind,
      id,
      props: validatedProps,
      incrementVersion: true,
    };
    if (validTo !== undefined) updateParams.validTo = validTo;
    if (options?.clearDeleted) updateParams.clearDeleted = true;

    const row = await backend.updateNode(updateParams);

    // Sync embeddings with updated props
    const embeddingSyncContext: EmbeddingSyncContext = {
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
      backend,
    };
    await syncEmbeddings(embeddingSyncContext, nodeKind.schema, validatedProps);

    return rowToNode(row as NodeRow);
  });
}

/**
 * Executes a node delete operation.
 */
export async function executeNodeDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Fetch node props BEFORE soft-delete so we can compute unique keys
    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing || existing.deleted_at) {
      // Node already deleted or doesn't exist - nothing to do
      return;
    }
    const existingProps = JSON.parse(existing.props) as Record<string, unknown>;

    // Check delete behavior
    const deleteBehavior = registration.onDelete ?? "restrict";
    const connectedEdges = await backend.findEdgesConnectedTo({
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
    });

    if (connectedEdges.length > 0) {
      switch (deleteBehavior) {
        case "restrict": {
          // Block deletion if edges exist
          const edgeKinds = [
            ...new Set(connectedEdges.map((edge) => edge.kind)),
          ];
          throw new RestrictedDeleteError({
            nodeKind: kind,
            nodeId: id,
            edgeCount: connectedEdges.length,
            edgeKinds,
          });
        }

        case "cascade": {
          // Delete all connected edges
          for (const edge of connectedEdges) {
            await backend.deleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }

        case "disconnect": {
          // Soft-delete edges (they become orphaned references)
          for (const edge of connectedEdges) {
            await backend.deleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }
      }
    }

    await backend.deleteNode({
      graphId: ctx.graphId,
      kind,
      id,
    });

    // Delete uniqueness entries
    const uniquenessContext: UniquenessContext = {
      graphId: ctx.graphId,
      registry: ctx.registry,
      backend,
    };
    await deleteUniquenessEntries(
      uniquenessContext,
      kind,
      existingProps,
      registration.unique ?? [],
    );

    // Delete embeddings
    const nodeKind = registration.type as NodeType;
    const embeddingSyncContext: EmbeddingSyncContext = {
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
      backend,
    };
    await deleteNodeEmbeddings(embeddingSyncContext, nodeKind.schema);
  });
}

/**
 * Executes a node hard delete operation (permanent removal).
 *
 * Unlike soft delete, this permanently removes the node and all
 * associated data (uniqueness entries, embeddings) from the database.
 */
export async function executeNodeHardDelete<G extends GraphDef>(
  ctx: NodeOperationContext<G>,
  kind: string,
  id: string,
  backend: GraphBackend | TransactionBackend,
): Promise<void> {
  const opContext = ctx.createOperationContext("delete", "node", kind, id);

  return ctx.withOperationHooks(opContext, async () => {
    // Validate kind exists and get registration
    const registration = getNodeRegistration(ctx.graph, kind);

    // Check if node exists (we don't care about deleted_at for hard delete)
    const existing = await backend.getNode(ctx.graphId, kind, id);
    if (!existing) {
      // Node doesn't exist - nothing to do
      return;
    }

    // Check delete behavior for connected edges
    const deleteBehavior = registration.onDelete ?? "restrict";
    const connectedEdges = await backend.findEdgesConnectedTo({
      graphId: ctx.graphId,
      nodeKind: kind,
      nodeId: id,
    });

    if (connectedEdges.length > 0) {
      switch (deleteBehavior) {
        case "restrict": {
          // Block deletion if edges exist
          const edgeKinds = [
            ...new Set(connectedEdges.map((edge) => edge.kind)),
          ];
          throw new RestrictedDeleteError({
            nodeKind: kind,
            nodeId: id,
            edgeCount: connectedEdges.length,
            edgeKinds,
          });
        }

        case "cascade": {
          // Hard delete all connected edges
          for (const edge of connectedEdges) {
            await backend.hardDeleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }

        case "disconnect": {
          // Hard delete edges (they would be orphaned anyway)
          for (const edge of connectedEdges) {
            await backend.hardDeleteEdge({
              graphId: ctx.graphId,
              id: edge.id,
            });
          }
          break;
        }
      }
    }

    // Hard delete the node (backend handles uniqueness entries and embeddings)
    await backend.hardDeleteNode({
      graphId: ctx.graphId,
      kind,
      id,
    });
  });
}
