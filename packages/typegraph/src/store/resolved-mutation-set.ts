import {
  type AtomicEdgeMutationProgramExecutor,
  type AtomicNodeResolvedMutationSetExecutor,
  resolveAtomicMutationPrograms,
} from "../backend/capabilities/atomic-mutation-program";
import type { GraphBackend, TransactionBackend } from "../backend/types";
import { DatabaseOperationError } from "../errors";

type ResolvedMutationSetExecutor =
  AtomicNodeResolvedMutationSetExecutor | AtomicEdgeMutationProgramExecutor;

/**
 * An operation-level atomic attempt. `unsupported` is emitted only before the
 * operation executor is invoked, so it is affirmative evidence that the
 * attempt executed no SQL and the caller may enter the complete portable path.
 */
export type ResolvedMutationSetAttempt<T> =
  | Readonly<{ outcome: "applied"; value: T }>
  | Readonly<{ outcome: "unsupported" }>;

/** Constructs the only successful operation-level attempt verdict. */
export function appliedResolvedMutationSet<T>(
  value: T,
): ResolvedMutationSetAttempt<T> {
  return { outcome: "applied", value };
}

/** Constructs the no-SQL fallback verdict. */
export function unsupportedResolvedMutationSet<
  T,
>(): ResolvedMutationSetAttempt<T> {
  return { outcome: "unsupported" };
}

/**
 * Internal retry signal for a resolved mutation set whose authoritative
 * preconditions moved before its atomic program ran. The collection owns the
 * create/update partition, so only it can honestly re-read and rebuild the
 * complete set; store/backend layers must not reinterpret one stale member in
 * isolation.
 */
export class ResolvedMutationSetMoved extends Error {
  constructor(
    entity: "node" | "edge",
    private readonly executor: ResolvedMutationSetExecutor,
  ) {
    super(`Resolved ${entity} mutation set moved before execution.`);
    this.name = "ResolvedMutationSetMoved";
  }

  /** Only the exact bundled root/executor that minted the signal may retry. */
  isOwnedBy(
    entity: "node" | "edge",
    backend: GraphBackend | TransactionBackend,
  ): boolean {
    const profile = resolveAtomicMutationPrograms(backend);
    return (
      (entity === "node" ? profile?.mutateNodes : profile?.mutateEdges) ===
      this.executor
    );
  }
}

const RESOLVED_MUTATION_SET_ATTEMPTS = 2;

/** Rebuilds the collection-owned partition once after authoritative movement. */
export async function runResolvedMutationSetConverging<T>(
  entity: "node" | "edge",
  backend: GraphBackend | TransactionBackend,
  run: () => Promise<T>,
  options?: Readonly<{ isMovement?: (error: unknown) => boolean }>,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= RESOLVED_MUTATION_SET_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await run();
    } catch (error) {
      const isOwnedAtomicMovement =
        error instanceof ResolvedMutationSetMoved &&
        error.isOwnedBy(entity, backend);
      if (!isOwnedAtomicMovement && options?.isMovement?.(error) !== true) {
        throw error;
      }
      if (attempt === RESOLVED_MUTATION_SET_ATTEMPTS) {
        throw new DatabaseOperationError(
          `Atomic ${entity} upsert set could not be applied to stable rows after ${RESOLVED_MUTATION_SET_ATTEMPTS} attempts.`,
          { operation: "update", entity },
          { cause: error },
        );
      }
    }
  }
  throw new DatabaseOperationError(
    `Atomic ${entity} upsert set exhausted its retry budget.`,
    { operation: "update", entity },
  );
}
