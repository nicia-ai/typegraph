/**
 * Shared temporal read-parameter resolution for collection reads.
 */
import {
  type ReadCoordinate,
  type RecordedInstant,
  resolveReadCoordinate,
} from "../../core/temporal";
import { type TemporalMode } from "../../core/types";
import { nowIso } from "../../utils/date";
import { assertNoRecordedCoordinate } from "../recorded-coordinate-guard";
import { type QueryOptions } from "../types";

type ValidReadParams = Omit<QueryOptions, "recordedAsOf">;

export type InternalReadParams = ValidReadParams &
  Readonly<{ recordedAsOf?: RecordedInstant }>;

function validReadParams(coordinate: ReadCoordinate): ValidReadParams {
  const { mode, asOf } = coordinate.valid;
  return asOf === undefined ?
      { temporalMode: mode }
    : { temporalMode: mode, asOf };
}

export function withValidCoordinate(coordinate: ReadCoordinate): QueryOptions {
  assertNoRecordedCoordinate(
    coordinate.recorded === undefined ?
      undefined
    : { recordedAsOf: coordinate.recorded.asOf },
    {
      code: "RECORDED_COLLECTION_READ_UNSUPPORTED",
      message:
        "Collection reads on StoreView cannot carry recorded-time coordinates.",
    },
  );
  return validReadParams(coordinate);
}

/**
 * Flattens a {@link ReadCoordinate} into the `QueryOptions` temporal argument
 * every pinned read accepts. The single point that knows the wire shape of the
 * temporal axis: a `StoreView` injects its coordinate by passing this as a
 * read's trailing temporal argument (or spreading it into an algorithm /
 * subgraph option object). When a new axis (recorded time) is added to
 * {@link ReadCoordinate}, only this function and the backend params change —
 * never the call sites.
 */
export function withCoordinate(coordinate: ReadCoordinate): InternalReadParams {
  const valid = validReadParams(coordinate);
  return coordinate.recorded === undefined ?
      valid
    : { ...valid, recordedAsOf: coordinate.recorded.asOf };
}

/**
 * The temporal slice of a `findNodesByKind` / `findEdgesByKind` /
 * `count*` parameter object.
 */
export type TemporalReadParams = Readonly<{
  excludeDeleted: boolean;
  temporalMode: TemporalMode;
  asOf?: string;
}>;

/**
 * Resolves the temporal portion of a collection read's backend params:
 * the per-call `temporalMode` wins, falling back to the graph default;
 * soft-deletes are excluded except under `includeTombstones`. An `asOf` is
 * rejected unless the mode is `"asOf"` (via {@link resolveReadCoordinate}), so
 * a pinned `current + asOf` is a caller error here exactly as it is on the
 * query, subgraph, algorithm, and StoreView paths — never a silent pin. The
 * backend filter still needs a concrete instant for `current`, so this defaults
 * it to "now" once the coordinate is validated.
 *
 * Single source of truth for `find` / `count` / endpoint reads across the
 * node and edge collections, so the resolution rules cannot drift between
 * them.
 */
export function resolveTemporalReadParams(
  options: InternalReadParams | undefined,
  defaultTemporalMode: TemporalMode,
): TemporalReadParams {
  assertNoRecordedCoordinate(options, {
    code: "RECORDED_COLLECTION_READ_UNSUPPORTED",
    message: "Broad collection reads cannot honor recorded-time coordinates.",
    suggestion:
      "Use store.asOfRecorded(...).nodes.Kind.getById/getByIds for point reads, or query() for recorded-time scans.",
  });

  const { valid } = resolveReadCoordinate(
    options?.temporalMode ?? defaultTemporalMode,
    options?.asOf,
  );
  const { mode, asOf } = valid;
  const base = {
    excludeDeleted: mode !== "includeTombstones",
    temporalMode: mode,
  } as const;
  if (mode === "current" || mode === "asOf") {
    return {
      ...base,
      asOf: asOf ?? nowIso(),
    };
  }
  return base;
}
