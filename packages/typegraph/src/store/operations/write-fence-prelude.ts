/**
 * The store's canonical write-fence prelude for a caller that reads, decides
 * and then writes inside one transaction: graph merge, durable store
 * operations and `tx.assertUnchangedSince()`. Each acquires the same fences in
 * the same schema-first order the write pipeline does, so none of them can
 * deadlock against an ordinary store write or against each other.
 */
import {
  resolveWriteFencePlan,
  serializesWriters,
} from "../../backend/capabilities/write-fence";
import {
  graphCommandCoordinationAcquisition,
  observesEveryEarlierFenceHolder,
} from "../../backend/command-contract";
import {
  type GraphCommandIsolation,
  type TransactionBackend,
} from "../../backend/types";
import {
  TypeGraphError,
  UnsupportedBackendCapabilityError,
} from "../../errors";
import { lockRecordedGraphWrite } from "../recorded-capture";
import { type GraphWriteLock } from "../recorded-capture/clock";
import { lockSchemaVersionForStoreWrite } from "./write-transaction";

const STALE_SCHEMA_VERSION_CODE = "STALE_SCHEMA_VERSION";

/** The capability a {@link freshSnapshotUnprovableError} names. */
const OBSERVED_READ_COMMITTED_ISOLATION_CAPABILITY =
  "observedReadCommittedIsolation";

/**
 * What {@link lockStoreWriteFence} acquires and how it reports a refusal.
 * `requireFreshSnapshot` demands proof that the session reads a snapshot
 * taken after the graph write lock, and so needs the graph lock; a caller
 * that demands it names the error to raise when the session cannot give it.
 */
export type StoreWriteFenceInput = Readonly<{
  graphId: string;
  schemaVersion: number | undefined;
  staleSchemaError: (cause: TypeGraphError) => TypeGraphError;
}> &
  (
    | Readonly<{
        graphLock: "required" | "not-required";
        requireFreshSnapshot?: false;
        freshSnapshotError?: never;
      }>
    | Readonly<{
        graphLock: "required";
        requireFreshSnapshot: true;
        /** Builds the refusal from the isolation the fence acquisition observed. */
        freshSnapshotError: (
          isolation: GraphCommandIsolation | undefined,
        ) => TypeGraphError;
      }>
  );

/**
 * Acquires the schema-version fence, then (when `graphLock` is `"required"`)
 * the per-graph write fence, in the store's canonical order.
 *
 * A stale schema version surfaces as `staleSchemaError(cause)`; every other
 * failure propagates unchanged.
 *
 * With `requireFreshSnapshot`, the prelude also demands evidence that every
 * read after it observes every earlier holder of the graph write fence: a
 * serialized engine, or a keyed acquisition whose session runs at read
 * committed. The caller's reads span more than one lock-only decision, so the
 * fence row (which tells a session only about the holders that advanced it)
 * would not make a snapshot-isolated session safe. Without that evidence the
 * prelude throws `freshSnapshotError(isolation)`.
 */
export async function lockStoreWriteFence(
  txBackend: TransactionBackend,
  input: StoreWriteFenceInput,
): Promise<void> {
  try {
    await lockSchemaVersionForStoreWrite(
      { graphId: input.graphId, schemaVersion: input.schemaVersion },
      txBackend,
    );
  } catch (error) {
    if (
      !(error instanceof TypeGraphError) ||
      error.code !== STALE_SCHEMA_VERSION_CODE
    ) {
      throw error;
    }
    throw input.staleSchemaError(error);
  }
  if (input.graphLock === "not-required") return;

  const lock = await lockRecordedGraphWrite(txBackend, input.graphId);
  if (input.requireFreshSnapshot !== true) return;
  requireFreshSnapshotAfterGraphLock(
    txBackend,
    input.graphId,
    lock,
    input.freshSnapshotError,
    "evidence",
  );
}

/**
 * Which write fences {@link requireFreshSnapshotAfterGraphLock} admits
 * without lock evidence. `"evidence"` admits only a serialized engine;
 * `"serialized-or-evidence"` admits every plan that serializes writers.
 */
export type FreshSnapshotAdmission = "evidence" | "serialized-or-evidence";

/**
 * THE one decision whether every read after a held per-graph write lock
 * observes every writer that committed before this transaction could read.
 *
 * `admits` is the caller's rule for a plan with no lock evidence:
 *
 * - `"evidence"` — `lockStoreWriteFence`'s `requireFreshSnapshot` (graph merge
 *   applied in a caller's transaction, `tx.assertUnchangedSince()`). Admits a
 *   serialized engine, which takes its single writer slot before the
 *   transaction's first statement; a `caller-serialized` plan, which yields
 *   no coordination token, is refused, as it always has been on these paths.
 * - `"serialized-or-evidence"` — provenance's support reads, through
 *   {@link refuseWriterBetweenSnapshotAndGraphLock}. Admits every plan that
 *   serializes writers ({@link serializesWriters}): `engine-serialized`, and a
 *   `caller-serialized` deployment, whose in-process queue runs every write
 *   unit alone and which refuses adopted transactions. No second writer can
 *   commit while such a transaction runs, so there is nothing to observe.
 *
 * Every other plan is keyed (`lock`, `row`): other sessions can commit while
 * this one waits for the lock. It is admitted only on the evidence of a keyed
 * acquisition bound to this graph and transaction whose own statement
 * observed read committed on this session. Refused with
 * `freshSnapshotError(isolation)`: no coordination token, an acquisition
 * minted for another graph or session, an isolation the acquisition could not
 * observe (`unknown`), and a snapshot isolation, whose snapshot can predate a
 * holder it then waited for. The fact is the isolation the fence statement
 * observed on the pinned session — never the isolation the transaction
 * requested, nor the server's default. This is the same per-profile rule the
 * store's lock-only decisions (an edge-acyclicity probe, a match-key
 * convergence) apply.
 *
 * `lock` is the evidence the graph-lock acquisition returned.
 */
function requireFreshSnapshotAfterGraphLock(
  txBackend: TransactionBackend,
  graphId: string,
  lock: GraphWriteLock,
  freshSnapshotError: (
    isolation: GraphCommandIsolation | undefined,
  ) => TypeGraphError,
  admits: FreshSnapshotAdmission,
): void {
  const plan = resolveWriteFencePlan(txBackend);
  if (plan.kind === "engine-serialized") return;
  if (admits === "serialized-or-evidence" && serializesWriters(plan)) return;
  const acquisition =
    lock.coordination === undefined ?
      undefined
    : graphCommandCoordinationAcquisition(
        txBackend.commands,
        lock.coordination,
        graphId,
      );
  if (
    acquisition === undefined ||
    !observesEveryEarlierFenceHolder(acquisition)
  ) {
    throw freshSnapshotError(acquisition?.isolation);
  }
}

/**
 * Refuses, before any read, a transaction whose reads after the per-graph
 * write lock could miss a writer that committed between its snapshot and that
 * lock — the hazard provenance's support reads must exclude (retraction
 * transitions, `assertHolds(tx)`, a writable `holding(tx)`).
 * {@link requireFreshSnapshotAfterGraphLock} with `"serialized-or-evidence"`.
 */
export function refuseWriterBetweenSnapshotAndGraphLock(
  txBackend: TransactionBackend,
  graphId: string,
  lock: GraphWriteLock,
  freshSnapshotError: (
    isolation: GraphCommandIsolation | undefined,
  ) => TypeGraphError,
): void {
  requireFreshSnapshotAfterGraphLock(
    txBackend,
    graphId,
    lock,
    freshSnapshotError,
    "serialized-or-evidence",
  );
}

/**
 * The refusal {@link requireFreshSnapshotAfterGraphLock} raises for a caller
 * that has no refusal of its own: `operation` names the caller, and
 * `isolation` is what the fence statement observed (absent when the
 * write-fence plan yields no evidence at all). `admits` is the rule that
 * refused, so the suggestion names only remedies that rule accepts.
 */
export function freshSnapshotUnprovableError(
  operation: string,
  graphId: string,
  isolation: GraphCommandIsolation | undefined,
  admits: FreshSnapshotAdmission,
): UnsupportedBackendCapabilityError {
  return new UnsupportedBackendCapabilityError(
    operation,
    OBSERVED_READ_COMMITTED_ISOLATION_CAPABILITY,
    { graphId, isolation },
    admits === "evidence" ?
      "On PostgreSQL, run the transaction at read committed isolation so reads after the graph write lock observe every earlier writer. A backend whose write fence is caller-serialized cannot provide this evidence; use an engine-serialized or advisory-lock write fence."
    : "On PostgreSQL, run the transaction at read committed isolation so reads after the graph write lock observe every earlier writer. A keyed write fence whose acquisition cannot report the session's isolation cannot provide this evidence; use a write fence that serializes writers (engine-serialized or caller-serialized) or one that reports read committed.",
  );
}
