import type {
  BackendCapabilities,
  BackendExecutionCapabilities,
} from "../types";

/**
 * THE one derivation of `execution.unitOfWork` from the two execution facts
 * plus one optional root-backend fact. An engine that can hold an open
 * callback transaction groups a write that way regardless of whether it also
 * exposes an atomic batch primitive — unless `fenceConflict` is
 * `"commit-time"`, meaning the caller resolved this backend's write-fence
 * plan to mechanism `row` with an engine that lets two acquirers of one fence
 * row both proceed and fails the loser's COMMIT: the interactive transaction
 * alone is not enough on that fence, and the tier becomes `"optimistic-retry"`
 * instead. With no interactive transaction, a closed atomic program is the
 * unit when one exists, and there is none at all when neither does. Every
 * place that changes `atomicBatch` — the capability tail and the two
 * boundaries below — re-derives through this function, so the facts can
 * never disagree on one object.
 *
 * `fenceConflict` is resolved once, in `createSqlBackend`, from the root
 * profile's declared write-fence capability — it is a root-backend fact, not
 * something a derived or session-scoped capabilities object can re-resolve
 * for itself (see `downgradeAtomicBatch` and `scopeAtomicBatchToSession`
 * below). Omitting it here always answers `"interactive"` or `"batch"`/`"none"`,
 * never `"optimistic-retry"`.
 */
export function deriveUnitOfWork(
  execution: Pick<
    BackendExecutionCapabilities,
    "interactiveTransactions" | "atomicBatch"
  > &
    Readonly<{
      /**
       * The resolved write-fence plan's `conflict` fact when that plan's
       * `kind` is `"row"`, `undefined` otherwise or when the caller has no
       * way to know it. Only `finalizeEngineCapabilities` — the sole caller
       * that resolves a root profile's write-fence plan — ever supplies
       * this; every other caller omits it and so can never derive
       * `"optimistic-retry"`.
       */
      fenceConflict?: "wait" | "commit-time";
    }>,
): NonNullable<BackendExecutionCapabilities["unitOfWork"]> {
  if (execution.interactiveTransactions) {
    return execution.fenceConflict === "commit-time" ?
        "optimistic-retry"
      : "interactive";
  }
  return execution.atomicBatch === "none" ? "none" : "batch";
}

/**
 * Removes exact atomic execution evidence at a backend derivation or session
 * boundary, and re-derives `unitOfWork` with it: a derived object with no
 * atomic batch is not a batch-tier backend, whatever its source was.
 *
 * Retry ownership under `"optimistic-retry"` is a root-backend fact: it
 * comes from the write-fence plan `createSqlBackend` resolves once for the
 * profile's own connection, not from anything a derived `BackendCapabilities`
 * carries. `withUnitOfWork` below re-derives through `deriveUnitOfWork` with
 * no `fenceConflict`, so a source that was `"optimistic-retry"` downgrades to
 * `"interactive"` here rather than surviving by accident — a derived object
 * cannot know the conflict the source resolved, so it must not claim the
 * tier that conflict alone justifies.
 *
 * Derived/projection constructors and transaction factories share this owner
 * so a new backend construction seam cannot accidentally retain execution
 * authority earned by another exact object.
 */
export function downgradeAtomicBatch(
  capabilities: BackendCapabilities,
): BackendCapabilities {
  return {
    ...capabilities,
    execution: withUnitOfWork({
      ...capabilities.execution,
      atomicBatch: "none",
    }),
  };
}

function withUnitOfWork(
  execution: BackendExecutionCapabilities,
): BackendExecutionCapabilities {
  return { ...execution, unitOfWork: deriveUnitOfWork(execution) };
}

/**
 * Declares atomic authority for one already-open transaction session.
 *
 * Session authority is earned independently of the root verdict: a root may
 * be unable to own a multi-statement atomic boundary while its transaction
 * factory can still prove one pinned open session. The session must register
 * its own exact-resource transport and semantic profile; this declaration
 * alone never authorizes execution.
 *
 * Like `downgradeAtomicBatch` above, `withUnitOfWork` re-derives with no
 * `fenceConflict`: retry ownership under `"optimistic-retry"` is a
 * root-backend fact this session-scoped capabilities object has no way to
 * re-resolve, so a source that carried it downgrades to `"interactive"`
 * here instead.
 */
export function scopeAtomicBatchToSession(
  capabilities: BackendCapabilities,
  available: boolean,
): BackendCapabilities {
  return {
    ...capabilities,
    execution: withUnitOfWork({
      ...capabilities.execution,
      atomicBatch: available ? "session" : "none",
    }),
  };
}
