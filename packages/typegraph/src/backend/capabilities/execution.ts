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
 * for itself. `downgradeAtomicBatch` and `scopeAtomicBatchToSession` below
 * never have it to hand, but they are not blind to it either: the source
 * object they derive from already carries the ROOT's answer in its own
 * `execution.unitOfWork`, so they read `"optimistic-retry"` back off that
 * field as their `fenceConflict` input rather than rediscovering it.
 * Omitting `fenceConflict` altogether — a capabilities object with no
 * established `unitOfWork` yet — always answers `"interactive"` or
 * `"batch"`/`"none"`, never `"optimistic-retry"`.
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
      fenceConflict?: "wait" | "commit-time" | undefined;
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
 * profile's own connection, not from anything this function computes fresh.
 * `withUnitOfWork` below carries it forward instead of rediscovering it: it
 * reads `capabilities.execution.unitOfWork` — the source's own, already
 * resolved answer — and passes `"commit-time"` through as `fenceConflict`
 * exactly when that source was `"optimistic-retry"`, so a derived object
 * built through this function keeps the tier for as long as
 * `interactiveTransactions` stays `true`, and falls back to `"interactive"`
 * only where the source never carried the tier to begin with.
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
  return {
    ...execution,
    unitOfWork: deriveUnitOfWork({
      ...execution,
      fenceConflict:
        execution.unitOfWork === "optimistic-retry" ? "commit-time" : undefined,
    }),
  };
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
 * Like `downgradeAtomicBatch` above, `withUnitOfWork` carries retry
 * ownership forward rather than re-resolving it: `"optimistic-retry"` is a
 * root-backend fact this session-scoped capabilities object has no way to
 * re-resolve for itself, but it reads the source's own `unitOfWork` for the
 * answer and keeps the tier for as long as `interactiveTransactions` stays
 * `true`.
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
