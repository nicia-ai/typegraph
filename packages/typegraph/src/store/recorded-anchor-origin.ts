import {
  assertGraphAllocationOwner,
  type GraphAllocationOwner,
} from "../core/allocation-owner";
import { type RecordedInstantParts } from "../core/temporal";
import { ConfigurationError } from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sha256Hex } from "../utils/hash";

export type RecordedAnchorOwner = GraphAllocationOwner;

/** Parse the ownership contract before any metadata query is attempted. */
export function requireRecordedAnchorOwner(
  parts: RecordedInstantParts,
  graphId: string,
): GraphAllocationOwner | undefined {
  if (parts.kind !== "typegraph") return undefined;
  if (parts.origin === undefined || parts.namespace === undefined)
    throw new ConfigurationError(
      "Legacy recorded anchors have no allocation owner and cannot authorize historical reads.",
      { code: "RECORDED_ANCHOR_UNBOUND", graphId },
      {
        suggestion:
          "Migrate only with independently retained origin evidence, or reacquire the checkpoint from its original graph.",
      },
    );
  return { origin: parts.origin, namespace: parts.namespace };
}

/** One ownership check for every TypeGraph recorded read, including empty reads. */
export function assertRecordedAnchorOrigin(
  parts: RecordedInstantParts,
  owner: RecordedAnchorOwner | undefined,
  graphId: string,
): void {
  const expected = requireRecordedAnchorOwner(parts, graphId);
  if (expected !== undefined)
    assertGraphAllocationOwner(expected, owner, { graphId });
}

/** Namespace distinguishes managed allocations; same-name physical forks must explicitly rotate their origin. */
export async function recordedAnchorOwner(
  schema: SqlSchema,
  origin: string,
): Promise<RecordedAnchorOwner> {
  return {
    origin,
    namespace: await sha256Hex(
      JSON.stringify([schema.tables.nodes, schema.tables.recordedClock]),
      16,
    ),
  };
}
