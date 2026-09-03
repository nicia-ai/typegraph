/**
 * The `fulltext` capability: whether this backend has an active fulltext
 * strategy at all.
 *
 * `resolveBackendFulltext` is THE one owner of "is fulltext available on
 * this backend" — the query compiler's dialect resolution and the store's
 * fulltext/hybrid search validation both consume it instead of re-deriving
 * the same decision from `capabilities.fulltext` or `fulltextStrategy`
 * separately.
 */
import type { FulltextStrategy } from "../../query/dialect/fulltext-strategy";
import type { GraphBackend } from "../types";

/**
 * Resolves what a backend's active fulltext strategy is, distinguishing a
 * backend built with `fulltext: false` from one that simply carries no
 * override.
 *
 * - `false` — the backend declares no `capabilities.fulltext` at all (built
 *   with `fulltext: false`). Every fulltext-touching call site refuses.
 * - `FulltextStrategy` — the backend's active strategy.
 * - `undefined` — the backend declares `capabilities.fulltext` but carries
 *   no `fulltextStrategy` override, which keeps today's "use the dialect's
 *   own default" meaning.
 *
 * An omitted `capabilities.fulltext` is read as "no fulltext", never as "use
 * the dialect default": a backend that supports fulltext but leaves the
 * strategy at the dialect's default must still declare `capabilities.fulltext`
 * for that default to be reachable through this function.
 */
export function resolveBackendFulltext(
  backend: Pick<GraphBackend, "capabilities" | "fulltextStrategy">,
): FulltextStrategy | false | undefined {
  if (backend.capabilities.fulltext === undefined) return false;
  return backend.fulltextStrategy;
}
