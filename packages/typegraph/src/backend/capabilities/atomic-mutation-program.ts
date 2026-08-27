/**
 * Exact-root execution profile for closed semantic mutation programs.
 *
 * The transport-level atomic SQL executor answers only "can this exact root
 * submit a closed statement sequence atomically?" This profile is the next
 * layer up: it names the TypeGraph mutations the backend can lower onto that
 * transport. Keeping every mutation family in one exact-root registration
 * prevents each new operation from inventing another provenance WeakMap.
 */
import type {
  ClaimEdgeCardinalityParams,
  EdgeRow,
  GraphBackend,
  InsertEdgeParams,
  InsertNodeParams,
  NodeInsertClaim,
  NodeRow,
  SchemaWriteFenceParams,
  TransactionBackend,
} from "../types";

type AtomicNodeBatchIdSource = "generated" | "caller";
export type AtomicNodeBatchResultMode = "count" | "rows";

export type AtomicNodeBatchEntry = Readonly<{
  idSource: AtomicNodeBatchIdSource;
  params: InsertNodeParams;
  /** The one claim this row owes in the currently supported native shape. */
  claim?: NodeInsertClaim;
}>;

export type AtomicNodeBatchInput = Readonly<{
  entries: readonly AtomicNodeBatchEntry[];
  resultMode: AtomicNodeBatchResultMode;
  schemaFence: SchemaWriteFenceParams;
}>;

export interface AtomicNodeBatchExecutor {
  /** Maximum constrained members the backend can gate in one statement. */
  readonly maxClaimedEntries?: number;
  (
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "count" }>,
  ): Promise<number>;
  (
    input: AtomicNodeBatchInput & Readonly<{ resultMode: "rows" }>,
  ): Promise<readonly NodeRow[]>;
}

export type AtomicEdgeBatchCountInput = Readonly<{
  claims: readonly ClaimEdgeCardinalityParams[];
  params: readonly InsertEdgeParams[];
  resultMode: "count";
  schemaFence: SchemaWriteFenceParams;
}>;

export type AtomicEdgeBatchRowsInput = Readonly<{
  claims: readonly ClaimEdgeCardinalityParams[];
  params: readonly InsertEdgeParams[];
  resultMode: "rows";
  schemaFence: SchemaWriteFenceParams;
}>;

export interface AtomicEdgeBatchExecutor {
  (input: AtomicEdgeBatchCountInput): Promise<number>;
  (input: AtomicEdgeBatchRowsInput): Promise<readonly EdgeRow[]>;
}

export type AtomicEdgeDeleteBatchInput = Readonly<{
  graphId: string;
  expectedKind: string;
  ids: readonly string[];
  schemaFence: SchemaWriteFenceParams;
}>;

export type AtomicDeleteBatchResult = Readonly<{
  affectedCount: number;
  schemaFenceMatched: boolean;
}>;

export type AtomicEdgeDeleteBatchExecutor = (
  input: AtomicEdgeDeleteBatchInput,
) => Promise<AtomicDeleteBatchResult>;

export type AtomicNodeDeleteBatchInput = Readonly<{
  graphId: string;
  kind: string;
  ids: readonly string[];
  schemaFence: SchemaWriteFenceParams;
}>;

export type AtomicNodeDeleteBatchExecutor = (
  input: AtomicNodeDeleteBatchInput,
) => Promise<AtomicDeleteBatchResult>;

/** Internal proof that the closed SQL program rejected a missing endpoint. */
export class AtomicEdgeBatchEndpointRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge batch endpoint validation failed", { cause });
    this.name = "AtomicEdgeBatchEndpointRefusalError";
  }
}

/** Internal proof that the closed SQL program refused a cardinality claim. */
export class AtomicEdgeBatchCardinalityRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge batch cardinality validation failed", { cause });
    this.name = "AtomicEdgeBatchCardinalityRefusalError";
  }
}

/** Internal proof that an edge-delete input belongs to another collection. */
export class AtomicEdgeDeleteIdentityRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge delete batch identity validation failed", { cause });
    this.name = "AtomicEdgeDeleteIdentityRefusalError";
  }
}

/** Internal proof that a restricted node still has a live connected edge. */
export class AtomicNodeDeleteRestrictedRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic node delete batch restriction validation failed", { cause });
    this.name = "AtomicNodeDeleteRestrictedRefusalError";
  }
}

/**
 * The semantic mutation families one exact bundled root can lower today.
 * New families extend this profile instead of adding another root registry.
 */
export type AtomicMutationProgramExecutor = Readonly<{
  createNodes?: AtomicNodeBatchExecutor;
  createEdges?: AtomicEdgeBatchExecutor;
  deleteNodes?: AtomicNodeDeleteBatchExecutor;
  deleteEdges?: AtomicEdgeDeleteBatchExecutor;
}>;

const ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS = new WeakMap<
  object,
  AtomicMutationProgramExecutor
>();

/** @internal Called only by bundled root backend factories. */
export function markBundledRootAtomicMutationPrograms<T extends object>(
  target: T,
  executor: Readonly<{
    createNodes?: AtomicNodeBatchExecutor | undefined;
    createEdges?: AtomicEdgeBatchExecutor | undefined;
    deleteNodes?: AtomicNodeDeleteBatchExecutor | undefined;
    deleteEdges?: AtomicEdgeDeleteBatchExecutor | undefined;
  }>,
): T {
  ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.set(target, {
    ...(executor.createNodes === undefined ?
      {}
    : {
        createNodes: executor.createNodes,
      }),
    ...(executor.createEdges === undefined ?
      {}
    : {
        createEdges: executor.createEdges,
      }),
    ...(executor.deleteNodes === undefined ?
      {}
    : {
        deleteNodes: executor.deleteNodes,
      }),
    ...(executor.deleteEdges === undefined ?
      {}
    : {
        deleteEdges: executor.deleteEdges,
      }),
  });
  return target;
}

/** Resolves semantic mutation programs only for their exact bundled root. */
export function resolveBundledRootAtomicMutationPrograms(
  target: GraphBackend | TransactionBackend,
): AtomicMutationProgramExecutor | undefined {
  return ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function markBundledRootAtomicNodeBatch<T extends object>(
  target: T,
  executor: AtomicNodeBatchExecutor,
): T {
  const existing = ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
  return markBundledRootAtomicMutationPrograms(target, {
    ...existing,
    createNodes: executor,
  });
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function markBundledRootAtomicEdgeBatch<T extends object>(
  target: T,
  executor: AtomicEdgeBatchExecutor,
): T {
  const existing = ROOT_ATOMIC_MUTATION_PROGRAM_EXECUTORS.get(target);
  return markBundledRootAtomicMutationPrograms(target, {
    ...existing,
    createEdges: executor,
  });
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function resolveBundledRootAtomicNodeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicNodeBatchExecutor | undefined {
  return resolveBundledRootAtomicMutationPrograms(target)?.createNodes;
}

/** @internal Narrow test seam over the single mutation-program registry. */
export function resolveBundledRootAtomicEdgeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicEdgeBatchExecutor | undefined {
  return resolveBundledRootAtomicMutationPrograms(target)?.createEdges;
}
