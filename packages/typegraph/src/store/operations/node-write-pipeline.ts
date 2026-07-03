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
 * currency but skips delete-behavior enforcement so every connected edge
 * survives for a later reopen.
 *
 * The steps assume they run inside a write transaction (see
 * {@link runInWriteTransaction}); they perform no transaction management of
 * their own.
 */
import { type z } from "zod";

import {
  type GraphBackend,
  type LiveNodeRow,
  type NodeRow,
  type TombstonedNodeRow,
  type TransactionBackend,
} from "../../backend/types";
import { type DeleteBehavior, type UniqueConstraint } from "../../core/types";
import { RestrictedDeleteError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";
import {
  deleteNodeEmbeddings,
  syncEmbeddings,
  syncEmbeddingsBatchForKind,
} from "../embedding-sync";
import {
  deleteNodeFulltext,
  syncFulltext,
  syncFulltextBatchForKind,
} from "../fulltext-sync";
import { type GraphWriteLock } from "../recorded-capture/clock";
import {
  checkUniquenessConstraints,
  createUniquenessContext,
  deleteUniquenessEntries,
  insertUniquenessEntries,
  insertUniquenessEntriesBatch,
  updateUniquenessEntries,
} from "../uniqueness";

type Backend = GraphBackend | TransactionBackend;

/**
 * The graph-scoped state the node write steps need. `lock` is compile-time
 * evidence that the per-graph write-lock discipline was satisfied BEFORE any
 * row work (see {@link GraphWriteLock}): the pipeline performs no locking of
 * its own, so requiring the token here makes "sidecar write before lock" a
 * type error at the call site instead of a lock-order inversion in review.
 */
export type NodeWriteContext = Readonly<{
  graphId: string;
  registry: KindRegistry;
  lock: GraphWriteLock;
}>;

/** Builds a {@link NodeWriteContext} — the one constructor every call site shares. */
export function createNodeWriteContext(
  graphId: string,
  registry: KindRegistry,
  lock: GraphWriteLock,
): NodeWriteContext {
  return { graphId, registry, lock };
}

/** Whether a delete removes the node (`hard`) or tombstones it (`soft`). */
type NodeDeleteMode = "soft" | "hard";

/**
 * Tunes how a delete treats the node's connected edges.
 *
 * By default delete behavior is enforced: connected edges block a `restrict`
 * node and are removed under `cascade` / `disconnect`. Provenance retraction
 * passes `enforceDeleteBehavior: false` — closing a fact's currency is a
 * belief-status change, not a domain delete, so its edges neither block the
 * close nor get removed; they survive untouched so a later reopen is an exact
 * inverse.
 */
export type NodeDeletePolicy = Readonly<{
  enforceDeleteBehavior: boolean;
}>;

function uniquenessContext(ctx: NodeWriteContext, backend: Backend) {
  return createUniquenessContext(ctx.graphId, ctx.registry, backend);
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
 * Enforces a node's delete behavior against its connected edges: they block
 * the delete (`restrict`) or are removed alongside the node (`cascade` /
 * `disconnect`). Skipped entirely when the caller's {@link NodeDeletePolicy}
 * disables enforcement.
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
  if (policy?.enforceDeleteBehavior === false) return;
  const behavior = args.onDelete ?? "restrict";
  const connectedEdges = await backend.findEdgesConnectedTo({
    graphId: ctx.graphId,
    nodeKind: args.kind,
    nodeId: args.id,
  });

  if (connectedEdges.length === 0) return;

  switch (behavior) {
    case "restrict": {
      throw new RestrictedDeleteError({
        nodeKind: args.kind,
        nodeId: args.id,
        edgeCount: connectedEdges.length,
        edgeKinds: [...new Set(connectedEdges.map((edge) => edge.kind))],
      });
    }

    case "cascade":
    case "disconnect": {
      // Both behaviors remove connected edges. "cascade" signals intent to
      // remove dependent data; "disconnect" signals intent to sever the
      // relationship. The effect is identical because edges cannot exist
      // without both endpoints.
      for (const edge of connectedEdges) {
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
  await Promise.all([
    syncEmbeddings(
      nodeSyncContext(ctx, args.kind, args.id, backend),
      args.schema,
      args.props,
    ),
    syncFulltext(
      nodeSyncContext(ctx, args.kind, args.id, backend),
      args.schema,
      args.props,
    ),
  ]);
}

/**
 * Batched {@link applyNodeInsertSideEffects}: one uniqueness batch across
 * every item, then one embedding batch per (kind, field) and one fulltext
 * batch per kind — instead of the per-row statement fan the single-op path
 * issues. Ordering matches the single-op path (uniqueness first, then the
 * sync fans).
 */
export async function applyNodeInsertSideEffectsBatch(
  ctx: NodeWriteContext,
  items: readonly Readonly<{
    kind: string;
    id: string;
    schema: z.ZodType;
    props: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
  }>[],
  backend: Backend,
): Promise<void> {
  if (items.length === 0) return;

  await insertUniquenessEntriesBatch(
    uniquenessContext(ctx, backend),
    items.map((item) => ({
      kind: item.kind,
      id: item.id,
      props: item.props,
      constraints: item.uniqueConstraints,
    })),
  );

  interface KindGroup {
    schema: z.ZodType;
    rows: { nodeId: string; props: Record<string, unknown> }[];
  }
  const byKind = new Map<string, KindGroup>();
  for (const item of items) {
    const group = byKind.get(item.kind) ?? { schema: item.schema, rows: [] };
    group.rows.push({ nodeId: item.id, props: item.props });
    byKind.set(item.kind, group);
  }

  await Promise.all(
    [...byKind.entries()].flatMap(([kind, group]) => {
      const syncArguments = { graphId: ctx.graphId, nodeKind: kind, backend };
      return [
        syncEmbeddingsBatchForKind(syncArguments, group.schema, group.rows),
        syncFulltextBatchForKind(syncArguments, group.schema, group.rows),
      ];
    }),
  );
}

function parseRowProps(row: NodeRow): Record<string, unknown> {
  return JSON.parse(row.props) as Record<string, unknown>;
}

/**
 * The row a node update targets. A plain update runs live-row side effects
 * (uniqueness diff, embedding/fulltext sync), so it must be handed a
 * {@link LiveNodeRow}; only an explicit `clearDeleted: true` resurrecting
 * upsert may target a possibly-tombstoned row. Encoding the pairing as a
 * union makes "live-row update pipeline on a tombstoned row" a type error.
 */
export type NodeUpdateTarget =
  | Readonly<{ existing: LiveNodeRow; clearDeleted?: false }>
  | Readonly<{ existing: NodeRow; clearDeleted: true }>;

/**
 * Applies a node update: uniqueness maintenance (diff-based for a live row;
 * check-and-reinsert for a resurrecting update, whose entries the soft delete
 * removed), the core row update, then embedding and fulltext sync. Returns
 * the updated row.
 */
export async function applyNodeUpdate(
  ctx: NodeWriteContext,
  args: Readonly<{
    schema: z.ZodType;
    validatedProps: Record<string, unknown>;
    uniqueConstraints: readonly UniqueConstraint[];
    validTo?: string;
  }> &
    NodeUpdateTarget,
  backend: Backend,
): Promise<NodeRow> {
  const { kind, id } = args.existing;
  if (args.existing.deleted_at === undefined) {
    await updateUniquenessEntries(
      uniquenessContext(ctx, backend),
      kind,
      id,
      parseRowProps(args.existing),
      args.validatedProps,
      args.uniqueConstraints,
    );
  } else {
    // Resurrecting update (clearDeleted on a tombstoned row): the soft delete
    // already removed this node's uniqueness entries, so the diff-based path
    // would skip an unchanged key entirely and the resurrected node would
    // hold NO reservation — a later create could then silently duplicate the
    // value. Re-check and re-insert for the new props instead, exactly as
    // applyNodeResurrect does.
    await checkUniquenessConstraints(
      uniquenessContext(ctx, backend),
      kind,
      id,
      args.validatedProps,
      args.uniqueConstraints,
    );
    await insertUniquenessEntries(
      uniquenessContext(ctx, backend),
      kind,
      id,
      args.validatedProps,
      args.uniqueConstraints,
    );
  }

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
    props: args.validatedProps,
    incrementVersion: true,
  };
  if (args.validTo !== undefined) updateParams.validTo = args.validTo;
  if (args.clearDeleted) updateParams.clearDeleted = true;

  const row = await backend.updateNode(updateParams);

  await Promise.all([
    syncEmbeddings(
      nodeSyncContext(ctx, kind, id, backend),
      args.schema,
      args.validatedProps,
    ),
    syncFulltext(
      nodeSyncContext(ctx, kind, id, backend),
      args.schema,
      args.validatedProps,
    ),
  ]);

  return row;
}

/**
 * Applies a node soft delete: delete-behavior enforcement, the tombstone
 * write, then removal of uniqueness entries, embeddings, and fulltext.
 * Requires a {@link LiveNodeRow}: deleting an already-tombstoned row would
 * re-run sidecar cleanup against entries the first delete already removed.
 */
export async function applyNodeSoftDelete(
  ctx: NodeWriteContext,
  args: Readonly<{
    existing: LiveNodeRow;
    schema: z.ZodType;
    uniqueConstraints: readonly UniqueConstraint[];
    onDelete: DeleteBehavior | undefined;
  }>,
  backend: Backend,
  policy?: NodeDeletePolicy,
): Promise<void> {
  const { kind, id } = args.existing;
  await enforceNodeDeleteBehavior(
    ctx,
    { kind, id, mode: "soft", onDelete: args.onDelete },
    backend,
    policy,
  );
  await backend.deleteNode({
    graphId: ctx.graphId,
    kind,
    id,
  });
  await deleteUniquenessEntries(
    uniquenessContext(ctx, backend),
    kind,
    parseRowProps(args.existing),
    args.uniqueConstraints,
  );
  await deleteNodeEmbeddings(
    nodeSyncContext(ctx, kind, id, backend),
    args.schema,
  );
  await deleteNodeFulltext(
    nodeSyncContext(ctx, kind, id, backend),
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
): Promise<void> {
  await enforceNodeDeleteBehavior(
    ctx,
    { kind: args.kind, id: args.id, mode: "hard", onDelete: args.onDelete },
    backend,
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
 * Reopens a soft-deleted node with its stored props (no merge, no
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
    existing: TombstonedNodeRow;
    schema: z.ZodType;
    uniqueConstraints: readonly UniqueConstraint[];
  }>,
  backend: Backend,
): Promise<NodeRow> {
  const { kind, id } = args.existing;
  const props = parseRowProps(args.existing);
  await checkUniquenessConstraints(
    uniquenessContext(ctx, backend),
    kind,
    id,
    props,
    args.uniqueConstraints,
  );
  await insertUniquenessEntries(
    uniquenessContext(ctx, backend),
    kind,
    id,
    props,
    args.uniqueConstraints,
  );
  const row = await backend.updateNode({
    graphId: ctx.graphId,
    kind,
    id,
    props,
    incrementVersion: true,
    clearDeleted: true,
  });
  await Promise.all([
    syncEmbeddings(nodeSyncContext(ctx, kind, id, backend), args.schema, props),
    syncFulltext(nodeSyncContext(ctx, kind, id, backend), args.schema, props),
  ]);
  return row;
}
