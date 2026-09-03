import { graphCommandCoordinationIsolation } from "../backend/command-contract";
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
    // Serialized engines already own the writer slot. An advisory-lock token
    // carries the isolation observed by the lock statement on this session.
    if (input.requireFreshSnapshot && lock.coordination !== undefined) {
      const isolation = graphCommandCoordinationIsolation(
        txBackend.commands,
        input.graphId,
        lock.coordination,
      );
      if (isolation !== "read_committed") {
        throw new MergePlanCapabilityError(
          "Merge callbacks require read-committed isolation so their reads observe the target after acquiring its graph lock.",
          { details: { capability: "mergeCallbackIsolation", isolation } },
        );
      }
    }
  }
}
