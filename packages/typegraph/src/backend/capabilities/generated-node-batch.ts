/**
 * Exact-root registration for the first operation lowered to an atomic SQL
 * program. The operation stays separate from the portable program executor:
 * the dialect backend owns SQL lowering, while the executor owns dispatch.
 */
import type {
  GraphBackend,
  InsertNodeParams,
  SchemaWriteFenceParams,
  TransactionBackend,
} from "../types";

export type GeneratedNodeBatchInput = Readonly<{
  params: readonly InsertNodeParams[];
  schemaFence: SchemaWriteFenceParams;
}>;

export type GeneratedNodeBatchExecutor = (
  input: GeneratedNodeBatchInput,
) => Promise<number>;

const ROOT_GENERATED_NODE_BATCH_EXECUTORS = new WeakMap<
  object,
  GeneratedNodeBatchExecutor
>();

/** @internal Called only by bundled root backend factories. */
export function markBundledRootGeneratedNodeBatch<T extends object>(
  target: T,
  executor: GeneratedNodeBatchExecutor | undefined,
): T {
  ROOT_GENERATED_NODE_BATCH_EXECUTORS.delete(target);
  if (executor !== undefined) {
    ROOT_GENERATED_NODE_BATCH_EXECUTORS.set(target, executor);
  }
  return target;
}

/** Resolves the operation only for the exact bundled root that owns it. */
export function resolveBundledRootGeneratedNodeBatch(
  target: GraphBackend | TransactionBackend,
): GeneratedNodeBatchExecutor | undefined {
  return ROOT_GENERATED_NODE_BATCH_EXECUTORS.get(target);
}
