/**
 * The `recordedTimeOwnership` capability: who allocates recorded-time
 * revisions. Lives in its own module, sibling to `write-fence.ts`, because
 * the interim refusal below is not about locking (§5.3.1 is emphatic that
 * `engine-native` is exempt from the fence gate) and the absent ⇒
 * `"typegraph-relations"` default needs one owner.
 */
import { ConfigurationError } from "../../errors";
import { type BackendCapabilities } from "../types";

/**
 * THE one reader of `capabilities.recordedTimeOwnership`. Absent means
 * `"typegraph-relations"` — today's behavior for every existing backend.
 */
export function resolveRecordedTimeOwnership(
  capabilities: BackendCapabilities,
): NonNullable<BackendCapabilities["recordedTimeOwnership"]> {
  return capabilities.recordedTimeOwnership ?? "typegraph-relations";
}

/**
 * THE refusal for a backend that declares `recordedTimeOwnership:
 * "engine-native"` while constructing a store that allocates the
 * TypeGraph-owned recorded clock (`history` / `revisionTracking`).
 *
 * TODAY THE ENGINE-NATIVE READ/WRITE PATH DOES NOT EXIST YET (follow-up
 * F8, owned by WS9). The capture path allocates the TypeGraph clock
 * unconditionally, so this configuration is refused at construction by its
 * own typed error naming the interim state — never admitted and left to
 * throw mid-flush inside `lockRecordedClock` (critique B3). This refusal
 * fires regardless of the write-fence plan: it is about the missing
 * read/write path, not about locking, and a SEPARATELY-named gate handles
 * the fence (§5.3.1, R-2).
 *
 * @throws {ConfigurationError} always.
 */
export function refuseEngineNativeRecordedTimeNotYetImplemented(): never {
  throw new ConfigurationError(
    'This backend declares `recordedTimeOwnership: "engine-native"`, but ' +
      "TypeGraph still allocates its own recorded clock for `history` / " +
      "`revisionTracking`; the engine-native path lands with a later " +
      "release. Construct the store without `history` / `revisionTracking`, " +
      'or declare `recordedTimeOwnership: "typegraph-relations"` and let ' +
      "TypeGraph own the clock.",
    { code: "ENGINE_NATIVE_RECORDED_TIME_NOT_IMPLEMENTED" },
    {
      suggestion:
        'Construct the store without `history`/`revisionTracking`, or declare `recordedTimeOwnership: "typegraph-relations"`.',
    },
  );
}
