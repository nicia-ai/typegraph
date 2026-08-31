import { type TransactionBackend } from "../backend/types";
import { TypeGraphError } from "../errors";
import { lockSchemaVersionForStoreWrite } from "../store/operations/write-transaction";
import { lockRecordedGraphWrite } from "../store/recorded-capture";

/** Acquires merge fences in the Store's canonical schema-first order. */
export async function lockMergeTargetWrite(
  txBackend: TransactionBackend,
  input: Readonly<{
    graphId: string;
    schemaVersion: number | undefined;
    graphLock: "required" | "not-required";
    staleSchemaError: (cause: unknown) => TypeGraphError;
  }>,
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
    await lockRecordedGraphWrite(txBackend, input.graphId);
  }
}
