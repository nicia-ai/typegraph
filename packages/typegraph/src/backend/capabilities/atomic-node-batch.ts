/** Exact-root registration for the atomic node batch SQL program. */
import type {
  GraphBackend,
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
  /**
   * The one claim this row owes in the constrained native shape. Absence is
   * the existing claim-free program. The store proves the supported claim is
   * generated-id, same-kind uniqueness with one canonical probe axis; the
   * backend treats anything else as ineligible rather than re-deriving it.
   */
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

const ROOT_ATOMIC_NODE_BATCH_EXECUTORS = new WeakMap<
  object,
  AtomicNodeBatchExecutor
>();

/** @internal Called only by bundled root backend factories. */
export function markBundledRootAtomicNodeBatch<T extends object>(
  target: T,
  executor: AtomicNodeBatchExecutor | undefined,
): T {
  ROOT_ATOMIC_NODE_BATCH_EXECUTORS.delete(target);
  if (executor !== undefined) {
    ROOT_ATOMIC_NODE_BATCH_EXECUTORS.set(target, executor);
  }
  return target;
}

/** Resolves the operation only for the exact bundled root that owns it. */
export function resolveBundledRootAtomicNodeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicNodeBatchExecutor | undefined {
  return ROOT_ATOMIC_NODE_BATCH_EXECUTORS.get(target);
}
