/**
 * Shared temporal coordinate + validation.
 */
import { ValidationError } from "../errors";
import { validateCanonicalIsoDate } from "../utils/date";
import { type TemporalMode } from "./types";

const RECORDED_INSTANT_VERSION = "r1";
const ENGINE_INSTANT_VERSION = "e1";
const RECORDED_REVISION_WIDTH = 16;
/** Open interval ceiling for numeric recorded-revision columns. */
export const RECORDED_MAX_REVISION = Number.MAX_SAFE_INTEGER;
const RECORDED_INSTANT_PATTERN =
  /^r1:(\d{16}):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;
/**
 * Engine-native form: `e1:<opaque engine revision>:<canonical ISO instant>`.
 * The revision is whatever URL-safe token the engine itself hands back from
 * `EngineRecordedTimeMembers.revisionNow` — never parsed as a number, so the
 * charset is deliberately the unreserved RFC 3986 set rather than digits.
 */
const ENGINE_INSTANT_PATTERN =
  /^e1:([A-Za-z0-9._~-]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

declare const RECORDED_INSTANT_BRAND: unique symbol;

/**
 * A versioned recorded-time anchor, in one of two forms sharing one grammar:
 * `<version>:<revision>:<recordedAt>`.
 *
 * - `r1:0000000000000001:YYYY-MM-DDTHH:mm:ss.sssZ` — TypeGraph's own form. The
 *   fixed-width logical revision is strictly monotonic per graph and makes
 *   every commit addressable even when many commits share one wall-clock
 *   millisecond.
 * - `e1:<engine revision>:YYYY-MM-DDTHH:mm:ss.sssZ` — engine-native form,
 *   minted by a backend that supplies `GraphBackend.recordedTime`. The
 *   revision is an opaque token the engine itself assigns, never a TypeGraph
 *   counter; ordering between two engine-native anchors compares the
 *   timestamp only (see {@link compareRecordedInstants}).
 *
 * Either form's timestamp is a non-decreasing physical wall-time high-water
 * mark used by diagonal valid-time reads: same-millisecond commits repeat it,
 * and backward clock corrections hold it at the previous value until wall
 * time catches up. The string round-trips through plain string checkpoint
 * columns without a custom serializer.
 */
export type RecordedInstant = string & {
  readonly [RECORDED_INSTANT_BRAND]: "RecordedInstant";
};

/**
 * The parsed halves of a TypeGraph-owned (`r1:`) recorded instant. Not
 * exported on its own — callers narrow {@link RecordedInstantParts} by
 * `kind` rather than naming either variant directly.
 */
type TypeGraphRecordedInstantParts = Readonly<{
  kind: "typegraph";
  revision: number;
  recordedAt: string;
}>;

/**
 * The parsed halves of an engine-native (`e1:`) recorded instant. Not
 * exported on its own — see {@link TypeGraphRecordedInstantParts}.
 */
type EngineRecordedInstantParts = Readonly<{
  kind: "engine";
  revision: string;
  recordedAt: string;
}>;

/**
 * The parsed halves of a {@link RecordedInstant}, discriminated by which
 * ownership form minted it. {@link parseRecordedInstant} is the one owner of
 * this grammar for both forms — a caller that needs the TypeGraph-only
 * numeric revision (or the engine-only opaque one) narrows on `kind` rather
 * than re-deriving the parse.
 */
export type RecordedInstantParts =
  TypeGraphRecordedInstantParts | EngineRecordedInstantParts;

function invalidRecordedInstant(value: string, path: string): ValidationError {
  return new ValidationError(
    `${path} must be a canonical versioned recorded instant.`,
    {
      issues: [
        {
          path,
          message: `Expected ${RECORDED_INSTANT_VERSION}:<${RECORDED_REVISION_WIDTH}-digit revision>:YYYY-MM-DDTHH:mm:ss.sssZ or ${ENGINE_INSTANT_VERSION}:<engine revision>:YYYY-MM-DDTHH:mm:ss.sssZ, got "${value}"`,
        },
      ],
    },
    {
      suggestion:
        "Persist the exact string returned by store.recordedNow(); migrate preview-schema checkpoints with migrateLegacyRecordedTime() and migrateRecordedAnchor().",
    },
  );
}

export function parseRecordedInstant(
  value: string,
  path = "RecordedInstant",
): RecordedInstantParts {
  const typeGraphMatch = RECORDED_INSTANT_PATTERN.exec(value);
  if (typeGraphMatch !== null) {
    const revisionText = typeGraphMatch[1];
    const recordedAt = typeGraphMatch[2];
    if (revisionText === undefined || recordedAt === undefined) {
      throw invalidRecordedInstant(value, path);
    }
    const revision = Number(revisionText);
    if (
      !Number.isSafeInteger(revision) ||
      revision < 1 ||
      revision >= RECORDED_MAX_REVISION
    ) {
      throw invalidRecordedInstant(value, path);
    }
    validateCanonicalIsoDate(recordedAt, path);
    return { kind: "typegraph", revision, recordedAt };
  }
  const engineMatch = ENGINE_INSTANT_PATTERN.exec(value);
  if (engineMatch !== null) {
    const revision = engineMatch[1];
    const recordedAt = engineMatch[2];
    if (revision === undefined || recordedAt === undefined) {
      throw invalidRecordedInstant(value, path);
    }
    validateCanonicalIsoDate(recordedAt, path);
    return { kind: "engine", revision, recordedAt };
  }
  throw invalidRecordedInstant(value, path);
}

export function assertValidRecordedInstant(value: string, path: string): void {
  parseRecordedInstant(value, path);
}

/**
 * Splits an optional recorded anchor into its parsed halves — the revision
 * (a numeric TypeGraph counter or an opaque engine token, discriminated by
 * `kind`) that a recorded read narrows to, and the wall time that valid-time
 * windows are measured against. Compilers that consult both halves parse once
 * through this instead of per predicate.
 */
export function optionalRecordedInstantParts(
  value: string | undefined,
  path = "RecordedInstant",
): RecordedInstantParts | undefined {
  return value === undefined ? undefined : parseRecordedInstant(value, path);
}

/** Mints TypeGraph's own (`r1:`) form of a recorded instant. */
export function createRecordedInstant(
  revision: number,
  recordedAt: string,
): RecordedInstant {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision >= RECORDED_MAX_REVISION
  ) {
    throw new ValidationError(
      "createRecordedInstant revision must be a valid recorded revision.",
      {
        issues: [
          {
            path: "createRecordedInstant.revision",
            message: `Expected a safe integer from 1 through ${String(RECORDED_MAX_REVISION - 1)}, got ${String(revision)}`,
          },
        ],
      },
    );
  }
  const revisionText = revision
    .toString()
    .padStart(RECORDED_REVISION_WIDTH, "0");
  return asRecordedInstant(
    `${RECORDED_INSTANT_VERSION}:${revisionText}:${recordedAt}`,
  );
}

/**
 * Mints an engine-native (`e1:`) recorded instant from the revision an
 * `EngineRecordedTimeMembers.revisionNow` call returned. `revision` is opaque
 * and never parsed as a number, but it must still be non-empty and safe to
 * embed in the colon-delimited grammar, so it is restricted to the RFC 3986
 * unreserved charset (letters, digits, `. _ ~ -`).
 */
export function createEngineRecordedInstant(
  revision: string,
  recordedAt: string,
): RecordedInstant {
  if (!/^[A-Za-z0-9._~-]+$/.test(revision)) {
    throw new ValidationError(
      "createEngineRecordedInstant revision must be a non-empty URL-safe token.",
      {
        issues: [
          {
            path: "createEngineRecordedInstant.revision",
            message: `Expected one or more of [A-Za-z0-9._~-], got ${JSON.stringify(revision)}`,
          },
        ],
      },
    );
  }
  return asRecordedInstant(
    `${ENGINE_INSTANT_VERSION}:${revision}:${recordedAt}`,
  );
}

/**
 * Returns the canonical UTC wall-time component of a recorded anchor. Works
 * for both ownership forms — every {@link RecordedInstantParts} variant
 * carries `recordedAt`.
 *
 * The value is non-decreasing per graph, but it is not the commit-order key;
 * use the complete {@link RecordedInstant} when ordering or replaying commits.
 */
export function recordedInstantWallTime(instant: RecordedInstant): string {
  return parseRecordedInstant(instant).recordedAt;
}

/**
 * Returns the strict per-graph logical revision carried by a TypeGraph-owned
 * (`r1:`) anchor. TypeGraph's numeric revision is meaningless for an
 * engine-native (`e1:`) anchor, so this refuses one rather than returning a
 * number parsed from an opaque token.
 *
 * @throws {ValidationError} when `instant` is an engine-native anchor.
 */
export function recordedInstantRevision(instant: RecordedInstant): number {
  const parts = parseRecordedInstant(instant);
  if (parts.kind !== "typegraph") {
    throw new ValidationError(
      "recordedInstantRevision requires a TypeGraph-owned (r1) recorded instant.",
      {
        issues: [
          {
            path: "recordedInstantRevision.instant",
            message: `Expected an r1 anchor, got an engine-native (e1) anchor with opaque revision "${parts.revision}"`,
          },
        ],
      },
      {
        suggestion:
          "Use recordedInstantWallTime(instant) for a value that works on both anchor forms.",
      },
    );
  }
  return parts.revision;
}

/**
 * Compares two recorded anchors of the SAME ownership form.
 *
 * For TypeGraph-owned (`r1:`) anchors, comparison is by logical revision:
 * revisions are local to a graph, so only compare anchors produced by the
 * same graph, and the physical wall-time component deliberately does not
 * participate. For engine-native (`e1:`) anchors there is no shared numeric
 * counter to compare — the engine's revision token is opaque — so comparison
 * falls back to the canonical ISO timestamp, which is lexicographically
 * ordered.
 *
 * Caveat for engine-native anchors: the timestamp has millisecond
 * resolution, so two distinct engine revisions minted within the same
 * millisecond compare equal here even though they are not the same commit.
 * TypeGraph-owned anchors have no such gap — their logical revision is a
 * strict per-commit counter — so this caveat is specific to the
 * timestamp-only fallback, not a general property of recorded-instant
 * comparison.
 *
 * @throws {ValidationError} when the two anchors were minted by different
 *   ownership forms — there is no shared axis to compare them on.
 */
export function compareRecordedInstants(
  left: RecordedInstant,
  right: RecordedInstant,
): -1 | 0 | 1 {
  const leftParts = parseRecordedInstant(left);
  const rightParts = parseRecordedInstant(right);
  if (leftParts.kind !== rightParts.kind) {
    throw new ValidationError(
      "compareRecordedInstants requires both anchors to share the same recorded-time ownership form.",
      {
        issues: [
          {
            path: "compareRecordedInstants",
            message: `Got a "${leftParts.kind}" anchor and a "${rightParts.kind}" anchor.`,
          },
        ],
      },
    );
  }
  if (leftParts.kind === "typegraph" && rightParts.kind === "typegraph") {
    if (leftParts.revision < rightParts.revision) return -1;
    if (leftParts.revision > rightParts.revision) return 1;
    return 0;
  }
  if (leftParts.recordedAt < rightParts.recordedAt) return -1;
  if (leftParts.recordedAt > rightParts.recordedAt) return 1;
  return 0;
}

/**
 * Brands a canonical versioned anchor string as a {@link RecordedInstant}.
 *
 * The escape hatch for an instant that round-trips through untyped storage:
 * captured from {@link Store.recordedNow}, persisted as a plain string, read
 * back, and replayed into `asOfRecorded`. Validates the canonical form eagerly —
 * the same check `asOfRecorded` applies — so a malformed value fails here, at the
 * brand site, rather than deeper in a read. Does *not* assert the instant is a
 * real captured commit; it only guarantees the value is well-formed enough to
 * compare correctly against the recorded relations.
 *
 * @throws {ValidationError} when `value` is not a canonical versioned anchor.
 */
export function asRecordedInstant(value: string): RecordedInstant {
  assertValidRecordedInstant(value, "asRecordedInstant");
  return value as RecordedInstant;
}

/**
 * The single opaque temporal coordinate every pinned read is resolved
 * against. It carries the valid-time axis plus an optional recorded/system-time
 * axis, so every surface can inject one coordinate object instead of threading
 * each temporal dimension separately.
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
  /** The recorded/system-time axis. Defined only for recorded-pinned views. */
  recorded?: Readonly<{ asOf: RecordedInstant }>;
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
 * Adds a recorded/system-time pin to an existing valid-time coordinate.
 * Direct `store.asOfRecorded(T)` passes the diagonal valid-time coordinate
 * (`mode: "asOf", asOf: T`); `store.asOf(vt).asOfRecorded(rt)` passes the
 * already-resolved valid coordinate and adds the recorded sibling.
 */
export function withRecordedCoordinate(
  coordinate: ReadCoordinate,
  recordedAsOf: RecordedInstant,
): ReadCoordinate {
  assertValidRecordedInstant(recordedAsOf, "asOfRecorded");
  return {
    ...coordinate,
    recorded: { asOf: recordedAsOf },
  };
}

/**
 * Validates the `asOf` coordinate of a temporal read: `"asOf"` mode
 * requires a timestamp, and any supplied timestamp must be a canonical
 * fixed-width UTC ISO-8601 string (`YYYY-MM-DDTHH:mm:ss.sssZ`). The latter
 * is load-bearing — temporal filters compare `asOf` against `valid_from` /
 * `valid_to` as text on SQLite, so a non-canonical value (date-only, an
 * offset, natural language, or variable-width / missing milliseconds like
 * `.1Z`) would sort and compare wrong rather than error. Reached only through
 * {@link resolveReadCoordinate}, which every temporal read entry point routes
 * through (direct reads, queries, subgraphs, algorithms, and StoreView), so
 * they all fail identically.
 *
 * @param mode - The resolved temporal mode.
 * @param asOf - The supplied timestamp (may be `undefined`).
 * @param options.suggestion - A caller-specific remediation hint for the
 *   missing-timestamp case.
 *
 * @throws {ValidationError} when `mode` is `"asOf"` and `asOf` is missing, or
 *   when any supplied `asOf` is not a canonical UTC ISO-8601 timestamp. The
 *   canonical check runs for *every* mode that consumes `asOf`, so a
 *   non-canonical value can never reach a text comparison.
 */
function assertValidAsOf(
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
  const valid =
    asOf === undefined ? `mode "${mode}"` : `mode "${mode}" asOf ${asOf}`;
  return coordinate.recorded === undefined ?
      valid
    : `${valid}, recorded asOf ${coordinate.recorded.asOf}`;
}

/**
 * The structured error-context fields describing a coordinate, shared by the
 * same refusal paths as {@link describeCoordinate}.
 */
export function coordinateContext(
  coordinate: ReadCoordinate,
): Record<string, unknown> {
  const { mode, asOf } = coordinate.valid;
  return {
    temporalMode: mode,
    ...(asOf !== undefined && { asOf }),
    ...(coordinate.recorded === undefined ?
      {}
    : { recordedAsOf: coordinate.recorded.asOf }),
  };
}
