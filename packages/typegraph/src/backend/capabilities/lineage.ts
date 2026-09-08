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
import { type GraphBackend, type TransactionBackend } from "../types";

declare const ENGINE_REVISION_BRAND: unique symbol;

/**
 * The connection a `revision()`/`changesSince()` read runs on — the
 * narrowest existing execution-target type a root backend and a
 * `transaction()` handle both satisfy. Reused rather than invented: it is
 * the same `Pick<TransactionBackend, "execute" | "executeRaw">` shape the
 * engine assembly layer already threads as `rawSql`/`rawSqlMembers`
 * (`backend/drizzle/engine/profile.ts`, `.../operation-layer.ts`) — a
 * `GraphBackend` is assignable to it for the identical reason those two
 * members are: `TransactionBackend`'s `execute`/`executeRaw` are themselves
 * `Pick<GraphBackend, …>` projections, so the two types share the exact same
 * member signatures.
 */
export type LineageSession = Pick<TransactionBackend, "execute" | "executeRaw">;

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
 * Both members take a {@link LineageSession} as their first argument: the
 * connection the CALLER'S decision is bound to, not a connection `lineage`
 * chooses for itself. A caller planning outside any transaction passes the
 * root backend it holds (`branch()`, `staging.ts`, `base-version.ts`'s
 * `lineageDeltaSinceAnchor` all do exactly this). A commit-time guard that
 * already holds an open transaction passes that transaction handle instead
 * — `graph-merge/merge.ts`'s `assertTargetUnchanged` is the concrete
 * caller this exists for: it reads `lineage` off the pinned transaction
 * handle and invokes both members WITH that same handle as the session, so
 * the read observes the transaction's own snapshot rather than whatever a
 * separately-held connection happens to see. An implementation MUST run its
 * read on the session it is given — one that opens its own connection, or
 * reads through a connection it closed over instead of the argument, is a
 * defect: it answers from a snapshot the caller never asked for, and inside
 * an open transaction it also risks colliding with whatever exclusion the
 * caller's own connection is holding (the bundled caller-serialized SQLite
 * backend's reentrancy guard refuses exactly this collision with a typed
 * `ConfigurationError` rather than hanging — see
 * `tests/graph-merge/base-version-engine-anchor.test.ts`'s
 * ignores-the-session case). A `session` is always either the backend that
 * declared this `lineage` or a `transaction()` handle it built, so an
 * implementation can freely call `session.execute`/`session.executeRaw`
 * without opening anything of its own.
 */
export type LineageMembers = Readonly<{
  /** The engine's current committed revision of the whole database, read on `session`. */
  revision: (this: void, session: LineageSession) => Promise<EngineRevision>;
  /**
   * What changed in `graphId` after `revision`, read on `session`, or
   * `{ kind: "unbounded" }` when the source cannot answer for that revision.
   */
  changesSince: (
    this: void,
    session: LineageSession,
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
