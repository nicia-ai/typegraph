/**
 * Who allocates recorded-time revisions for a backend: TypeGraph's own
 * capture relations and clock, or the engine itself through
 * `GraphBackend.recordedTime` (`./recorded-time.ts`). Lives in its own
 * module, sibling to `write-fence.ts` and `recorded-time.ts`, because the
 * derivation is a one-line decision that several construction sites read
 * and must never re-spell.
 */
import {
  parseRecordedInstant,
  type RecordedInstant,
} from "../../core/temporal";
import { ConfigurationError } from "../../errors";
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

/**
 * THE one check that an `asOfRecorded` anchor was minted by the SAME
 * ownership form this store reads under: an engine-native store requires an
 * `e1:` instant (one its own `recordedTime.revisionNow` produced), and a
 * TypeGraph-owned store requires an `r1:` instant (one its own capture clock
 * produced). Reusing an anchor across ownership forms — or across two
 * differently-configured stores over the same graph — would otherwise
 * silently source rows through the wrong seam, since `RecordedReadSource`
 * only refuses the mismatch once a read is compiled ({@link
 * CompilerInvariantError} deep in `query/compiler/schema.ts`); this check
 * gives the same mismatch a typed, caller-facing refusal at the point the
 * anchor is supplied.
 */
export function assertRecordedInstantOwnershipMatch(
  ownership: RecordedTimeOwnership,
  instant: RecordedInstant,
  surface: string,
): void {
  const parts = parseRecordedInstant(instant, surface);
  const expectedKind = ownership === "engine-native" ? "engine" : "typegraph";
  if (parts.kind === expectedKind) return;
  throw new ConfigurationError(
    `${surface} requires a recorded instant minted under this store's own recorded-time ownership ("${ownership}"), but got a "${parts.kind}"-form instant.`,
    {
      code: "RECORDED_INSTANT_OWNERSHIP_MISMATCH",
      surface,
      ownership,
      instantKind: parts.kind,
    },
    {
      suggestion:
        ownership === "engine-native" ?
          "Pass an e1: instant read from this store's own recordedNow() — an r1: instant belongs to a TypeGraph-owned recorded-time store."
        : "Pass an r1: instant read from this store's own recordedNow() — an e1: instant belongs to an engine-native recorded-time store.",
    },
  );
}
