/**
 * Who allocates recorded-time revisions for a backend: TypeGraph's own
 * capture relations and clock, or the engine itself through
 * `GraphBackend.recordedTime` (`./recorded-time.ts`). Lives in its own
 * module, sibling to `write-fence.ts` and `recorded-time.ts`, because the
 * derivation is a one-line decision that several construction sites read
 * and must never re-spell.
 */
import { type GraphBackend } from "../types";

/** Who allocates recorded-time revisions for a backend. See {@link resolveRecordedTimeOwnership}. */
export type RecordedTimeOwnership = "typegraph-relations" | "engine-native";

/**
 * THE one reader of backend recorded-time ownership: `"engine-native"` when
 * the backend declares `recordedTime`, `"typegraph-relations"` otherwise —
 * today's behavior for every existing backend. There is no separate
 * declared flag to fall out of sync with the member: a backend that
 * supplies `recordedTime` IS engine-native, by construction.
 */
export function resolveRecordedTimeOwnership(
  backend: Pick<GraphBackend, "recordedTime">,
): RecordedTimeOwnership {
  return backend.recordedTime === undefined ?
      "typegraph-relations"
    : "engine-native";
}
