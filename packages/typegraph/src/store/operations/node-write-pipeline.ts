/**
 * Composable node write steps — the integrity side effects that every node
 * mutation must apply, extracted so there is a single implementation instead of
 * one hand-stitched copy per write path.
 *
 * A node mutation is the core row write plus a fixed set of side effects:
 * uniqueness entries, embedding sync, fulltext sync, and — for deletes —
 * delete-behavior enforcement over connected edges. These steps are shared by
 * the canonical collection operations (create / update / delete) and by
 * provenance retraction, which drives the same close/reopen of a fact node's
 * currency but must treat its own justification edges as non-structural.
 *
 * The steps assume they run inside a write transaction (see
 * {@link runInWriteTransaction}); they perform no transaction management of
 * their own.
 */
import { type z } from "zod";

import {
  type EdgeRow,
  type GraphBackend,
  type NodeRow,
  type TransactionBackend,
} from "../../backend/types";
import { type DeleteBehavior, type UniqueConstraint } from "../../core/types";
import { RestrictedDeleteError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import { deleteNodeEmbeddings, syncEmbeddings } from "../embedding-sync";
import { deleteNodeFulltext, syncFulltext } from "../fulltext-sync";
import {
  checkUniquenessConstraints,
  deleteUniquenessEntries,
  insertUniquenessEntries,
  updateUniquenessEntries,
} from "../uniqueness";

type Backend = GraphBackend | TransactionBackend;

/** The graph-scoped state the node write steps need. */
export type NodeWriteContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
}>;

/** Whether a delete removes the node (`hard`) or tombstones it (`soft`). */
type NodeDeleteMode = "soft" | "hard";

/**
 * Tunes which connected edges delete-behavior enforcement considers.
 *
 * By default every connected edge is structural — it blocks a `restrict` node
 * and is removed under `cascade` / `disconnect`. Provenance retraction supplies
 * {@link NodeDeletePolicy.isNonStructuralEdge} to exclude its own
 * `derives` / `premiseOf` edges, so closing a fact's currency neither trips
 * `restrict` on those edges nor deletes them (they must survive for a later
 * reopen).
 */
export type NodeDeletePolicy = Readonly<{
  isNonStructuralEdge?: (edge: EdgeRow) => boolean;
}>;

function uniquenessContext(ctx: NodeWriteContext, backend: Backend) {
  return { graphId: ctx.graphId, registry: ctx.registry, backend };
}

/**
 * The `(graphId, nodeKind, nodeId, backend)` context shared by the embedding and
 * fulltext sync helpers — `EmbeddingSyncContext` and `FulltextSyncContext` are
 * structurally identical, so one builder serves both.
 */
function nodeSyncContext(
  ctx: NodeWriteContext,
  kind: string,
  id: string,
  backend: Backend,
) {
  return { graphId: ctx.graphId, nodeKind: kind, nodeId: id, backend };
}

/**
 * Enforces a node's delete behavior against its connected edges. Structural
 * edges (per {@link NodeDeletePolicy}) either block the delete (`restrict`) or
 * are removed alongside the node (`cascade` / `disconnect`); non-structural
 * edges are left untouched.
 */
async function enforceNodeDeleteBehavior(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    mode: NodeDeleteMode;
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  const behavior = args.onDelete ?? "restrict";
  const connectedEdges = await backend.findEdgesConnectedTo({
    graphId: ctx.graphId,
    nodeKind: args.kind,
    nodeId: args.id,
  });
  const structuralEdges =
    policy?.isNonStructuralEdge === undefined ?
      connectedEdges
    : connectedEdges.filter((edge) => !policy.isNonStructuralEdge!(edge));

  if (structuralEdges.length === 0) return;

  switch (behavior) {
    case "restrict": {
      throw new RestrictedDeleteError({
        nodeKind: args.kind,
        nodeId: args.id,
        edgeCount: structuralEdges.length,
        edgeKinds: [...new Set(structuralEdges.map((edge) => edge.kind))],
      });
    }

    case "cascade":
    case "disconnect": {
      // Both behaviors remove connected edges. "cascade" signals intent to
      // remove dependent data; "disconnect" signals intent to sever the
      // relationship. The effect is identical because edges cannot exist
      // without both endpoints.
      for (const edge of structuralEdges) {
        await (args.mode === "hard" ?
          backend.hardDeleteEdge({ graphId: ctx.graphId, id: edge.id })
        : backend.deleteEdge({ graphId: ctx.graphId, id: edge.id }));
      }
      break;
    }
  }
}

/**
 * Applies the side effects that follow a node insert: uniqueness entries, then
 * embedding and fulltext sync. Uniqueness has already been *checked* during
 * create preparation; this writes the entries.
 */
export async function applyNodeInsertSideEffects(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    props: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
  }>,
  backend: Backend,
): Promise<void> {
  await insertUniquenessEntries(
    uniquenessContext(ctx, backend),
    args.kind,
    args.id,
    args.props,
    args.uniqueConstraints,
  );
  await syncEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.props,
  );
  await syncFulltext(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.props,
  );
}

/**
 * Applies a node update: diff-based uniqueness maintenance, the core row
 * update, then embedding and fulltext sync. Returns the updated row.
 */
export async function applyNodeUpdate(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    existingProps: Record<string, unknown>;
    validatedProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
    validTo?: string;
    clearDeleted?: boolean;
  }>,
  backend: Backend,
): Promise<NodeRow> {
  await updateUniquenessEntries(
    uniquenessContext(ctx, backend),
    args.kind,
    args.id,
    args.existingProps,
    args.validatedProps,
    args.uniqueConstraints,
  );

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
    kind: args.kind,
    id: args.id,
    props: args.validatedProps,
    incrementVersion: true,
  };
  if (args.validTo !== undefined) updateParams.validTo = args.validTo;
  if (args.clearDeleted) updateParams.clearDeleted = true;

  const row = await backend.updateNode(updateParams);

  await syncEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.validatedProps,
  );
  await syncFulltext(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.validatedProps,
  );

  return row;
}

/**
 * Applies a node soft delete: delete-behavior enforcement, the tombstone
 * write, then removal of uniqueness entries, embeddings, and fulltext.
 */
export async function applyNodeSoftDelete(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    existingProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  await enforceNodeDeleteBehavior(
    ctx,
    { kind: args.kind, id: args.id, mode: "soft", onDelete: args.onDelete },
    backend,
    policy,
  );
  await backend.deleteNode({
    graphId: ctx.graphId,
    kind: args.kind,
    id: args.id,
  });
  await deleteUniquenessEntries(
    uniquenessContext(ctx, backend),
    args.kind,
    args.existingProps,
    args.uniqueConstraints,
  );
  await deleteNodeEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
  );
  await deleteNodeFulltext(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
  );
}

/**
 * Applies a node hard delete: delete-behavior enforcement, permanent removal,
 * then embedding cleanup. Uniqueness and fulltext rows are removed by the
 * backend's `hardDeleteNode` cascade; embeddings live in strategy-owned
 * per-`(kind, field)` tables the graph-agnostic cascade cannot reach, so they
 * are cleaned here.
 */
export async function applyNodeHardDelete(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  await enforceNodeDeleteBehavior(
    ctx,
    { kind: args.kind, id: args.id, mode: "hard", onDelete: args.onDelete },
    backend,
    policy,
  );
  await backend.hardDeleteNode({
    graphId: ctx.graphId,
    kind: args.kind,
    id: args.id,
  });
  await deleteNodeEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
  );
}

/**
 * Reopens a soft-deleted node with a known set of props (no merge, no
 * re-validation): re-checks and re-inserts uniqueness entries (the delete
 * removed them), clears the tombstone, then re-syncs embeddings and fulltext.
 * Used by provenance to reinstate a fact whose currency is restored. Returns
 * the reopened row.
 *
 * @throws {UniquenessError} when a unique key the node held was taken by
 *   another node while it was tombstoned.
 */
export async function applyNodeResurrect(
  ctx: NodeWriteContext,
  args: Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    props: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
  }>,
  backend: Backend,
): Promise<NodeRow> {
  await checkUniquenessConstraints(
    uniquenessContext(ctx, backend),
    args.kind,
    args.id,
    args.props,
    args.uniqueConstraints,
  );
  await insertUniquenessEntries(
    uniquenessContext(ctx, backend),
    args.kind,
    args.id,
    args.props,
    args.uniqueConstraints,
  );
  const row = await backend.updateNode({
    graphId: ctx.graphId,
    kind: args.kind,
    id: args.id,
    props: args.props,
    incrementVersion: true,
    clearDeleted: true,
  });
  await syncEmbeddings(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.props,
  );
  await syncFulltext(
    nodeSyncContext(ctx, args.kind, args.id, backend),
    args.schema,
    args.props,
  );
  return row;
}
