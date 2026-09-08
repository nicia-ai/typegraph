/**
 * The backend's optional lineage capability: an opaque, whole-database
 * revision an engine can report and compare, plus the delta of one graph's
 * rows that changed since an earlier revision.
 *
 * This is a query surface only — nothing here writes a graph row, a
 * sidecar row, or a status row. A caller uses it to avoid a full-graph scan
 * when it already holds an earlier revision it trusts: `changesSince`
 * either names exactly what changed or admits it cannot and asks the
 * caller to fall back to scanning everything.
 */
import { ConfigurationError } from "../../errors";
import { type GraphBackend } from "../types";

declare const ENGINE_REVISION_BRAND: unique symbol;

/**
 * An opaque token identifying the engine's current committed state of the
 * whole database — comparable only by equality, never parsed or ordered by
 * a caller. Two backends never share a comparable revision space; a
 * revision is only ever compared against another revision the SAME
 * `lineage` produced.
 */
export type EngineRevision = string &
  Readonly<{ [ENGINE_REVISION_BRAND]: "EngineRevision" }>;

/** One node or edge row, identified the way every lineage delta names a row. */
export type EntityKey = Readonly<{ kind: string; id: string }>;

/**
 * What changed in one graph since a given revision, or an admission that
 * the source cannot answer.
 *
 * `"keys"` lists every node and edge inserted, updated, deleted, or
 * resurrected after the anchored revision — deduplicated, and covering a
 * hard delete the same as any other change (a row's disappearance is still
 * a change a caller must not miss). `"unbounded"` means the source cannot
 * bound the change set for the given revision — the anchor is unknown, or
 * older than what the source retains — and the caller must fall back to a
 * full comparison rather than guess.
 */
export type LineageDelta =
  | Readonly<{
      kind: "keys";
      nodes: readonly EntityKey[];
      edges: readonly EntityKey[];
    }>
  | Readonly<{ kind: "unbounded" }>;

/**
 * The backend's lineage surface. Optional: a custom backend that omits it
 * loses only the callers that consult it directly, all of which already
 * fall back to a full scan when it is absent — see {@link requireLineage}.
 *
 * Both members MUST be safe to call from inside an open transaction on the
 * SAME backend the `lineage` was read off. `graph-merge`'s engine-anchor
 * re-validation (`assertTargetUnchanged` in `graph-merge/merge.ts`) is the
 * concrete caller: it resolves `lineage` off the target's own root backend
 * and then invokes `revision()`/`changesSince()` from strictly inside that
 * same target's open commit transaction, because no advisory lock pins an
 * engine-anchored store's write path the way a revision-anchored one is
 * pinned. An implementation that issues its own transaction, or that
 * assumes exclusive use of a single connection/session, can hang or error
 * under that call pattern — the bundled caller-serialized SQLite backend's
 * own reentrancy guard refuses this exact reentry with a typed
 * `ConfigurationError` rather than hanging (see
 * `tests/graph-merge/base-version-engine-anchor.test.ts`'s real-backend-read
 * case), but a `lineage` MUST NOT rely on running under a backend that
 * happens to detect its own reentrancy: it must instead use a connection
 * independent of the caller's open transaction, or otherwise tolerate being
 * invoked while one is open.
 */
export type LineageMembers = Readonly<{
  /** The engine's current committed revision of the whole database. */
  revision: (this: void) => Promise<EngineRevision>;
  /**
   * What changed in `graphId` after `revision`, or `{ kind: "unbounded" }`
   * when the source cannot answer for that revision.
   */
  changesSince: (
    this: void,
    revision: EngineRevision,
    graphId: string,
  ) => Promise<LineageDelta>;
}>;

/**
 * THE refusal for a caller that needs the backend's lineage capability and
 * finds it absent, naming the missing member so a caller can add it — or
 * fall back to the full comparison every lineage-aware caller already
 * knows how to run — instead of chasing a `TypeError` deep into a diff.
 */
export function requireLineage(
  backend: Pick<GraphBackend, "lineage">,
  operation: string,
): LineageMembers {
  const lineage = backend.lineage;
  if (lineage === undefined) {
    throw new ConfigurationError(
      `${operation} requires the backend's lineage capability, but this backend declares no \`lineage\`.`,
      { code: "LINEAGE_UNAVAILABLE", operation },
      {
        suggestion:
          "Implement `lineage` on this backend, or accept the full comparison this caller falls back to without it.",
      },
    );
  }
  return lineage;
}
