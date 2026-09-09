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
import { type RecordedReadBinding } from "../../query/compiler/schema";
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
 * THE one check for "is this recorded read reached under engine-native
 * ownership," for the callers that hold a read binding rather than a
 * backend: the query compiler's historical identity traversal
 * (`query/compiler/identity-traversal.ts`) only ever sees
 * `ctx.recordedReadBinding`, never the store or its backend.
 *
 * A binding of kind `"engine-native"` implies that
 * {@link resolveRecordedTimeOwnership} answered `"engine-native"` for the
 * backend it was built from: `Store`'s constructor builds that binding kind
 * (`createEngineRecordedReadBinding`) only after the derivation already
 * held. The converse does not hold: an engine-native backend constructed
 * with neither `history` nor `recordedRead` binds nothing at all, so
 * ownership is engine-native while no binding exists — but `asOfRecorded()`
 * refuses such a store before any recorded read can reach this check. `Store.
 * identityAtCoordinate` — the other entry point a recorded identity read can
 * reach — therefore calls this same function over its own bound binding
 * rather than re-deriving the ownership from `#recordedTimeOwnership`, so
 * the two entry points cannot drift into disagreeing about which reads this
 * refuses.
 */
export function isEngineNativeRecordedReadBinding(
  binding: RecordedReadBinding | undefined,
): boolean {
  return binding?.kind === "engine-native";
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
  throw recordedInstantOwnershipMismatch(ownership, parts.kind, surface);
}

/**
 * The TypeGraph-owned numeric revision behind `instant`, for the surfaces
 * whose storage IS a TypeGraph relation keyed by that number — today the
 * identity transition log's replay window and its retention watermark. Those
 * surfaces are reachable only from a capture-enabled (`historyEnabled`)
 * context, which exists only under `"typegraph-relations"` ownership, so an
 * `e1:` anchor there is a caller error rather than an unreachable state, and
 * it is refused through {@link recordedInstantOwnershipMismatch} — the same
 * typed refusal {@link assertRecordedInstantOwnershipMatch} raises, so the
 * two entry points cannot drift into two different mismatch errors. They
 * differ only in what they hand back: the assertion returns nothing, this
 * returns the narrowed revision its callers came for.
 */
export function requireTypeGraphRecordedRevision(
  instant: string,
  surface: string,
): number {
  const parts = parseRecordedInstant(instant, surface);
  if (parts.kind === "typegraph") return parts.revision;
  throw recordedInstantOwnershipMismatch(
    "typegraph-relations",
    parts.kind,
    surface,
  );
}

/**
 * The one refusal for "this recorded instant was minted under the other
 * ownership form", shared by {@link assertRecordedInstantOwnershipMatch} and
 * {@link requireTypeGraphRecordedRevision}.
 */
function recordedInstantOwnershipMismatch(
  ownership: RecordedTimeOwnership,
  instantKind: "typegraph" | "engine",
  surface: string,
): ConfigurationError {
  return new ConfigurationError(
    `${surface} requires a recorded instant minted under this store's own recorded-time ownership ("${ownership}"), but got a "${instantKind}"-form instant.`,
    {
      code: "RECORDED_INSTANT_OWNERSHIP_MISMATCH",
      surface,
      ownership,
      instantKind,
    },
    {
      suggestion:
        ownership === "engine-native" ?
          "Pass an e1: instant read from this store's own recordedNow() — an r1: instant belongs to a TypeGraph-owned recorded-time store."
        : "Pass an r1: instant read from this store's own recordedNow() — an e1: instant belongs to an engine-native recorded-time store.",
    },
  );
}
