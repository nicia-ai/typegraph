/**
 * Exact-root registration for the atomic edge-create batch program.
 *
 * The backend owns lowering and transport dispatch; the store owns the
 * eligibility proof. Keeping the registration out-of-band is intentional:
 * derived backends and transaction-scoped handles must not inherit a native
 * program whose atomicity contract belongs to the bundled root.
 */
import type {
  EdgeRow,
  GraphBackend,
  InsertEdgeParams,
  SchemaWriteFenceParams,
  TransactionBackend,
} from "../types";

export type AtomicEdgeBatchCountInput = Readonly<{
  params: readonly InsertEdgeParams[];
  resultMode: "count";
  schemaFence: SchemaWriteFenceParams;
}>;

export type AtomicEdgeBatchRowsInput = Readonly<{
  params: readonly InsertEdgeParams[];
  resultMode: "rows";
  schemaFence: SchemaWriteFenceParams;
}>;

/**
 * Native result modes needed by the two public edge batch shapes:
 * `bulkInsert` needs only the affected count, while `bulkCreate` needs the
 * authoritative inserted rows.
 */
export interface AtomicEdgeBatchExecutor {
  (input: AtomicEdgeBatchCountInput): Promise<number>;
  (input: AtomicEdgeBatchRowsInput): Promise<readonly EdgeRow[]>;
}

/** Internal proof that the closed SQL program rejected a missing endpoint. */
export class AtomicEdgeBatchEndpointRefusalError extends Error {
  constructor(cause: unknown) {
    super("Atomic edge batch endpoint validation failed", { cause });
    this.name = "AtomicEdgeBatchEndpointRefusalError";
  }
}

const ROOT_ATOMIC_EDGE_BATCH_EXECUTORS = new WeakMap<
  object,
  AtomicEdgeBatchExecutor
>();

/** @internal Called only by bundled root backend factories. */
export function markBundledRootAtomicEdgeBatch<T extends object>(
  target: T,
  executor: AtomicEdgeBatchExecutor | undefined,
): T {
  ROOT_ATOMIC_EDGE_BATCH_EXECUTORS.delete(target);
  if (executor !== undefined) {
    ROOT_ATOMIC_EDGE_BATCH_EXECUTORS.set(target, executor);
  }
  return target;
}

/** Resolves the program only for the exact bundled root that owns it. */
export function resolveBundledRootAtomicEdgeBatch(
  target: GraphBackend | TransactionBackend,
): AtomicEdgeBatchExecutor | undefined {
  return ROOT_ATOMIC_EDGE_BATCH_EXECUTORS.get(target);
}
