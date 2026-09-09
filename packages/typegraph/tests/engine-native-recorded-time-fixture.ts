/**
 * Attaches BOTH co-required engine-native members onto a bundled profile's
 * provisioning object in place. Mutates the SAME `provisioning` object
 * rather than going through `deriveEngineProfile`, because `provisioning`
 * is not one of that helper's derivable keys (see `tests/recorded-time-
 * transaction-threading.test.ts`'s own doc comment, which scripts `lineage`
 * alone the identical way, and `tests/engine-native-recorded-time.test.ts`'s
 * module doc for the full rationale).
 *
 * Shared by every suite that scripts a bundled profile into an
 * engine-native one: `tests/engine-native-recorded-time.test.ts` and
 * `tests/backends/postgres/engine-native-recorded-time-simulation.ts` — one
 * seam so the two never drift on how a co-requirement is attached.
 */
import { type EngineRecordedTimeMembers } from "../src/backend/capabilities/recorded-time";
import { type LineageMembers } from "../src/backend/types";

export function attachEngineNativeRecordedTime(
  provisioning: object,
  recordedTime: EngineRecordedTimeMembers,
  lineage: LineageMembers,
): void {
  const target = provisioning as {
    recordedTime?: EngineRecordedTimeMembers;
    lineage?: LineageMembers;
  };
  target.recordedTime = recordedTime;
  target.lineage = lineage;
}
