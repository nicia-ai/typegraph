import { resolveWriteFencePlan } from "../backend/capabilities/write-fence";
import {
  graphCommandCoordinationAcquisition,
  observesEveryEarlierFenceHolder,
} from "../backend/command-contract";
import { type TransactionBackend } from "../backend/types";
import { TypeGraphError } from "../errors";
import { lockSchemaVersionForStoreWrite } from "../store/operations/write-transaction";
import { lockRecordedGraphWrite } from "../store/recorded-capture";
import { MergePlanCapabilityError } from "./errors";

/** Acquires merge fences in the Store's canonical schema-first order. */
export async function lockMergeTargetWrite(
  txBackend: TransactionBackend,
  input: Readonly<{
    graphId: string;
    schemaVersion: number | undefined;
    staleSchemaError: (cause: unknown) => TypeGraphError;
  }> &
    (
      | Readonly<{ graphLock: "required"; requireFreshSnapshot?: boolean }>
      | Readonly<{ graphLock: "not-required"; requireFreshSnapshot?: never }>
    ),
): Promise<void> {
  try {
    await lockSchemaVersionForStoreWrite(
      { graphId: input.graphId, schemaVersion: input.schemaVersion },
      txBackend,
    );
  } catch (error) {
    if (
      !(error instanceof TypeGraphError) ||
      error.code !== "STALE_SCHEMA_VERSION"
    ) {
      throw error;
    }
    throw input.staleSchemaError(error);
  }
  if (input.graphLock === "required") {
    const lock = await lockRecordedGraphWrite(txBackend, input.graphId);
    // Serialized engines already own the writer slot. A keyed acquisition's
    // token carries what the fence statement observed on this session; a plan
    // that yields no token has no evidence to offer.
    //
    // The applier's reads span the whole target, not one lock-only decision,
    // so it must observe EVERY earlier holder of the fence. The fence row
    // tells a session only about the holders that advanced it, so advancing
    // it here would not make a snapshot isolation safe.
    if (
      input.requireFreshSnapshot &&
      resolveWriteFencePlan(txBackend).kind !== "engine-serialized"
    ) {
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
        throw new MergePlanCapabilityError(
          "Composed merge application requires observed read-committed isolation so reads observe the target after acquiring its graph lock.",
          {
            details: {
              capability: "mergeCallbackIsolation",
              isolation: acquisition?.isolation,
            },
          },
        );
      }
    }
  }
}
