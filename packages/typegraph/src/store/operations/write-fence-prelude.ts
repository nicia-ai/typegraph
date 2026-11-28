/**
 * The store's canonical write-fence prelude for a caller that reads, decides
 * and then writes inside one transaction: graph merge, durable store
 * operations and `tx.assertUnchangedSince()`. Each acquires the same fences in
 * the same schema-first order the write pipeline does, so none of them can
 * deadlock against an ordinary store write or against each other.
 */
import { resolveWriteFencePlan } from "../../backend/capabilities/write-fence";
import {
  graphCommandCoordinationAcquisition,
  observesEveryEarlierFenceHolder,
} from "../../backend/command-contract";
import { type GraphCommandIsolation } from "../../backend/types";
import { TypeGraphError } from "../../errors";
import type { Operation } from "../operation-scope";
import {
  lockRecordedGraphWrite,
  recordedGraphLockMemoOf,
} from "../recorded-capture";
import { lockSchemaVersionForStoreWrite } from "./write-transaction";

const STALE_SCHEMA_VERSION_CODE = "STALE_SCHEMA_VERSION";

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
  operation: Operation,
  input: StoreWriteFenceInput,
): Promise<void> {
  const txBackend = operation.backend;
  try {
    await lockSchemaVersionForStoreWrite(
      { graphId: input.graphId, schemaVersion: input.schemaVersion },
      operation,
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

  const lock = await lockRecordedGraphWrite(
    txBackend,
    input.graphId,
    recordedGraphLockMemoOf(operation),
  );
  if (input.requireFreshSnapshot !== true) return;
  // Serialized engines already own the writer slot. A keyed acquisition's
  // token carries what the fence statement observed on this session; a plan
  // that yields no token has no evidence to offer.
  if (resolveWriteFencePlan(txBackend).kind === "engine-serialized") return;
  const acquisition =
    lock.coordination === undefined ?
      undefined
    : graphCommandCoordinationAcquisition(
        txBackend.commands,
        lock.coordination,
        input.graphId,
      );
  if (
    acquisition === undefined ||
    !observesEveryEarlierFenceHolder(acquisition)
  ) {
    throw input.freshSnapshotError(acquisition?.isolation);
  }
}
