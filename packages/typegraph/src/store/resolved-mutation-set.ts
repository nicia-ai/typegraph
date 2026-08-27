import { DatabaseOperationError } from "../errors";

/**
 * Internal retry signal for a resolved mutation set whose authoritative
 * preconditions moved before its atomic program ran. The collection owns the
 * create/update partition, so only it can honestly re-read and rebuild the
 * complete set; store/backend layers must not reinterpret one stale member in
 * isolation.
 */
export class ResolvedMutationSetMoved extends Error {
  constructor(entity: "node" | "edge") {
    super(`Resolved ${entity} mutation set moved before execution.`);
    this.name = "ResolvedMutationSetMoved";
  }
}

const RESOLVED_MUTATION_SET_ATTEMPTS = 2;

/** Rebuilds the collection-owned partition once after authoritative movement. */
export async function runResolvedMutationSetConverging<T>(
  entity: "node" | "edge",
  run: () => Promise<T>,
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= RESOLVED_MUTATION_SET_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ResolvedMutationSetMoved)) throw error;
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
