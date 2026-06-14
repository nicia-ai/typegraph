/**
 * Shared temporal coordinate + validation.
 */
import { ValidationError } from "../errors";
import { validateCanonicalIsoDate } from "../utils/date";
import { type TemporalMode } from "./types";

/**
 * The single opaque temporal coordinate every pinned read is resolved
 * against. Today it carries only the valid-time axis; Unit 2 adds a sibling
 * `recorded` axis here, and because every surface injects the coordinate
 * through one helper ({@link withCoordinate}), a new axis lands on all
 * surfaces at once instead of splitting by surface.
 */
export type ReadCoordinate = Readonly<{
  /**
   * The valid-time axis: a resolved temporal mode and (only for `"asOf"`) the
   * instant it is pinned to.
   */
  valid: Readonly<{
    mode: TemporalMode;
    /** Defined only when `mode` is `"asOf"`. */
    asOf?: string;
  }>;
  // Unit 2 (recorded / system time): recorded?: Readonly<{ asOf?: string }>;
}>;

/**
 * Resolves and validates a `(mode, asOf)` pair into a {@link ReadCoordinate}.
 * Rejects an `asOf` paired with any non-`"asOf"` mode rather than silently
 * dropping it — pinning an instant is only meaningful in `"asOf"` mode, so a
 * `view({ mode: "current", asOf })` is a caller mistake, not a coordinate to
 * quietly discard. Then validates via {@link assertValidAsOf}.
 *
 * @param mode - The temporal mode to pin.
 * @param asOf - The supplied timestamp. Required for `"asOf"`; rejected for
 *   every other mode.
 * @param suggestion - Caller-specific remediation hint for the
 *   missing/invalid-timestamp case.
 */
export function resolveReadCoordinate(
  mode: TemporalMode,
  asOf: string | undefined,
  suggestion?: string,
): ReadCoordinate {
  if (mode !== "asOf" && asOf !== undefined) {
    throw new ValidationError(
      `Temporal mode "${mode}" does not take an asOf timestamp.`,
      {
        issues: [
          {
            path: "asOf",
            message: `asOf is only valid with mode "asOf", not "${mode}"`,
          },
        ],
      },
      {
        suggestion:
          'Pin an instant with store.asOf(timestamp) or store.view({ mode: "asOf", asOf }); drop asOf for other modes.',
      },
    );
  }
  assertValidAsOf(
    mode,
    asOf,
    suggestion === undefined ? undefined : { suggestion },
  );
  return { valid: asOf === undefined ? { mode } : { mode, asOf } };
}

/**
 * Validates the `asOf` coordinate of a temporal read: `"asOf"` mode
 * requires a timestamp, and any supplied timestamp must be a canonical
 * fixed-width UTC ISO-8601 string (`YYYY-MM-DDTHH:mm:ss.sssZ`). The latter
 * is load-bearing — temporal filters compare `asOf` against `valid_from` /
 * `valid_to` as text on SQLite, so a non-canonical value (date-only, an
 * offset, natural language, or variable-width / missing milliseconds like
 * `.1Z`) would sort and compare wrong rather than error. Shared by every
 * temporal read entry point so direct reads, queries, subgraphs, algorithms,
 * and StoreView fail identically.
 *
 * @param mode - The resolved temporal mode.
 * @param asOf - The supplied timestamp (may be `undefined`).
 * @param options.suggestion - A caller-specific remediation hint for the
 *   missing-timestamp case.
 *
 * @throws {ValidationError} when `mode` is `"asOf"` and `asOf` is missing, or
 *   when any supplied `asOf` is not a canonical UTC ISO-8601 timestamp. The
 *   canonical check runs for *every* mode that consumes `asOf` (`current`
 *   compares against it too — it is not exclusive to `"asOf"` mode), so a
 *   non-canonical value can never reach a text comparison.
 */
export function assertValidAsOf(
  mode: TemporalMode,
  asOf: string | undefined,
  options?: Readonly<{ suggestion?: string }>,
): void {
  if (mode === "asOf" && asOf === undefined) {
    throw new ValidationError(
      'Temporal mode "asOf" requires a timestamp',
      {
        issues: [
          { path: "asOf", message: "Timestamp is required for asOf mode" },
        ],
      },
      {
        suggestion:
          options?.suggestion ??
          'Provide an ISO-8601 timestamp for asOf mode, e.g. "2026-01-01T00:00:00.000Z".',
      },
    );
  }
  if (asOf !== undefined) {
    validateCanonicalIsoDate(asOf, "asOf");
  }
}

/**
 * A human-readable description of a coordinate for error messages, e.g.
 * `mode "current"` or `mode "asOf" asOf 2026-01-01T00:00:00.000Z`. Shared by
 * every refusal path (the `StoreView` read-only / current-only / search facades
 * and the sealed-query builder) so they describe a coordinate identically — and
 * a future axis (recorded time) is reflected everywhere from one place.
 */
export function describeCoordinate(coordinate: ReadCoordinate): string {
  const { mode, asOf } = coordinate.valid;
  return asOf === undefined ? `mode "${mode}"` : `mode "${mode}" asOf ${asOf}`;
}

/**
 * The structured error-context fields describing a coordinate, shared by the
 * same refusal paths as {@link describeCoordinate}.
 */
export function coordinateContext(
  coordinate: ReadCoordinate,
): Record<string, unknown> {
  const { mode, asOf } = coordinate.valid;
  return { temporalMode: mode, ...(asOf !== undefined && { asOf }) };
}
