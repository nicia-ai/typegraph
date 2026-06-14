/**
 * Shared temporal read-parameter resolution for collection reads.
 */
import { assertValidAsOf, type ReadCoordinate } from "../../core/temporal";
import { type TemporalMode } from "../../core/types";
import { nowIso } from "../../utils/date";
import { type QueryOptions } from "../types";

/**
 * Flattens a {@link ReadCoordinate} into the `QueryOptions` temporal argument
 * every pinned read accepts. The single point that knows the wire shape of the
 * temporal axis: a `StoreView` injects its coordinate by passing this as a
 * read's trailing temporal argument (or spreading it into an algorithm /
 * subgraph option object). When a new axis (recorded time) is added to
 * {@link ReadCoordinate}, only this function and the backend params change —
 * never the call sites.
 */
export function withCoordinate(coordinate: ReadCoordinate): QueryOptions {
  const { mode, asOf } = coordinate.valid;
  return asOf === undefined ?
      { temporalMode: mode }
    : { temporalMode: mode, asOf };
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
 * soft-deletes are excluded except under `includeTombstones`; and `asOf`
 * defaults to "now" for the window-filtered modes (`current` / `asOf`).
 *
 * Single source of truth for `find` / `count` / endpoint reads across the
 * node and edge collections, so the resolution rules cannot drift between
 * them.
 */
export function resolveTemporalReadParams(
  options: Readonly<{ temporalMode?: TemporalMode; asOf?: string }> | undefined,
  defaultTemporalMode: TemporalMode,
): TemporalReadParams {
  const mode = options?.temporalMode ?? defaultTemporalMode;
  assertValidAsOf(mode, options?.asOf);
  const base = {
    excludeDeleted: mode !== "includeTombstones",
    temporalMode: mode,
  } as const;
  if (mode === "current" || mode === "asOf") {
    return { ...base, asOf: options?.asOf ?? nowIso() };
  }
  return base;
}
