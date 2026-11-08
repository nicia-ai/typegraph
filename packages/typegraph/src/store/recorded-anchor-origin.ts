import { type RecordedInstantParts } from "../core/temporal";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sha256Hex } from "../utils/hash";

export type RecordedAnchorOwner = Readonly<{
  origin: string;
  namespace: string;
}>;

/** One ownership check for every TypeGraph recorded read, including empty reads. */
export function assertRecordedAnchorOrigin(
  parts: RecordedInstantParts,
  owner: RecordedAnchorOwner | undefined,
  graphId: string,
): void {
  if (parts.kind !== "typegraph") return;
  if (parts.origin === undefined || parts.namespace === undefined)
    throw new ConfigurationError(
      "Legacy recorded anchors have no graph origin and cannot authorize historical reads.",
      { code: "RECORDED_ANCHOR_UNBOUND", graphId },
      {
        suggestion:
          "Reacquire the anchor from its original graph, or migrate it using independently retained origin evidence.",
      },
    );
  if (parts.origin !== owner?.origin || parts.namespace !== owner.namespace)
    throw new ConfigurationError(
      "Recorded anchor belongs to a different or retired graph origin.",
      { code: "RECORDED_ANCHOR_ORIGIN_MISMATCH", graphId },
    );
}

/** Physical forks can copy the revision-origin row; bind its recording namespace too. */
export async function recordedAnchorOwner(
  schema: SqlSchema,
  origin: string,
): Promise<RecordedAnchorOwner> {
  return {
    origin,
    namespace: await sha256Hex(schema.tables.recordedClock, 16),
  };
}
