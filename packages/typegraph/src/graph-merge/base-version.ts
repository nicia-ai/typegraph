/**
 * `base@V` stamping.
 *
 * A {@link BaseVersion} is the immutable token a branch is forked from. It must
 * change whenever either the schema OR the live content of the base store
 * changes, so that `merge()`'s precondition check (T11) can reject a branch that
 * forked from a divergent base.
 *
 * The token is two stable components joined by a separator:
 *
 *   1. A **schema hash** — `computeSchemaHash(serializeSchema(graph, version))`.
 *      This is content-addressed (the public `computeSchemaHash` deliberately
 *      excludes the version number and `generatedAt`, so it is stable across
 *      re-saves of the same schema).
 *   2. An anchor, chosen by ONE precedence every caller of
 *      {@link computeBaseVersion} shares:
 *      a. A **revision anchor** when the Store has `revisionTracking` (or
 *         `history`) enabled — a durable random per-graph origin plus the
 *         monotonic revision clock. This is O(1) to read and changes after
 *         every successful Store write; the origin prevents independent
 *         stores with coincident timestamps from sharing an anchor.
 *      b. Otherwise, an **engine anchor** when `resolveLineage(store)` yields
 *         a `lineage` (necessarily the BACKEND's own — a store with no
 *         revision tracking never captures history, so the recorded-relations
 *         lineage is unreachable here; see `store/recorded-capture/lineage.ts`).
 *         The anchor pairs the SAME durable per-graph revision-origin nonce
 *         the revision anchor uses (ensured here too, at mint time, on this
 *         store's backend) with the engine's opaque whole-database revision
 *         — origin-namespaced for the identical reason the revision anchor
 *         is: two independent databases whose engines both happen to report
 *         the same revision string (a fresh counter starting at "r1") would
 *         otherwise mint indistinguishable engine anchors, making a branch
 *         forked from one database look mergeable into the other. Both
 *         reads are O(1). It is engine-wide rather than per-graph, which is
 *         why re-validating it (see
 *         `graph-merge/merge.ts`'s `assertTargetUnchanged` and
 *         `assertForkPointUnchanged`) cannot stop at a raw inequality: a
 *         revision bump from a commit to an UNRELATED graph on the same
 *         engine must not fail this graph's merge, so a mismatch is only
 *         a real divergence once `lineage.changesSince` confirms this
 *         graph's own rows moved. `LineageDelta` names only node and edge
 *         keys, not identity assertions: an engine-anchored store that
 *         changes ONLY its current identity assertions between plan and
 *         commit — no node or edge row touched — mints an empty delta and
 *         is tolerated as unchanged. The content-fingerprint fallback below
 *         does not share this gap (its fingerprint folds identity
 *         assertions in directly), and revision-anchored stores do not
 *         either (any Store write, identity-only included, advances the
 *         shared revision clock the anchor reads). Closing it would mean
 *         teaching `LineageDelta` a THIRD dimension, or re-checking
 *         identity assertions on the side the way `assertTargetUnchanged`
 *         already re-checks the schema half — neither is done today.
 *      c. Otherwise, the compatibility fallback: a **content fingerprint**, a
 *         SHA-256 digest (truncated to a fixed-width hex string) of every
 *         LIVE node and edge over the base store (`id`, `updated_at`, the
 *         bitemporal `valid_from`/`valid_to`, and canonicalized `props`;
 *         edges also carry their endpoint ids), sorted by id, so two stores
 *         with identical live content fingerprint identically regardless of
 *         row enumeration order or insertion order. Props AND validity are
 *         folded in so the token changes on a content or validity edit even
 *         when `updated_at` ties at millisecond granularity. Current
 *         identity assertions are folded in too (see
 *         `computeContentComponent`), which is exactly what the engine
 *         anchor above does not do. Hashing keeps the token fixed-width
 *         instead of growing linearly with store size.
 *
 * The token MUST be computed off the ORIGINAL base store, never off a clone:
 * `exportGraph`/`importGraph` regenerate `created_at`/`updated_at`, so a clone's
 * fingerprint would not match its source. (See the working-copy fidelity note in
 * T4.)
 *
 * `computeBaseVersion` is async because schema hashing, revision reads, and the
 * compatibility live-content enumeration go through async TypeGraph internals.
 * The design's synchronous illustrative signature does not survive contact with
 * the real store surface.
 */

import type { SqlSchema } from "../query/compiler/schema";
import { canonicalizeProps, parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import { enumerateAllEdges, enumerateAllNodes } from "./state-diff";
import type {
  EngineRevision,
  GraphBackend,
  GraphDef,
  IdentityTransferAssertion,
  LineageDelta,
  Store,
  TransactionBackend,
} from "./typegraph-internal";
import { getEdgeKinds, getNodeKinds, sha256Hex } from "./typegraph-internal";
import {
  encodeRecordedLineageRevision,
  ensureRevisionOrigin,
  readRevisionOrigin,
  recordedRelationsLineage,
  recordedRevisionOriginsVerdict,
  resolveLineage,
  storeBackend,
  storeCaptureEnabled,
  storeRuntime,
} from "./typegraph-internal";
import { computeSchemaHash, serializeSchema } from "./typegraph-internal";
import type { BaseVersion } from "./types";
import { asBaseVersion } from "./types";

/**
 * Separator between the schema-hash and revision-or-content token components.
 * The schema hash contains no NUL byte, so one NUL unambiguously delimits the
 * two components.
 */
const TOKEN_SEPARATOR = "\0";

/** Separates the schema hash from the monotonic active schema version. */
const SCHEMA_VERSION_TAG = "#s";
const REVISION_COMPONENT_PREFIX = "revision:";
const REVISION_COMPONENT_SEPARATOR = ":";
const INITIAL_REVISION = "initial";

/**
 * Marks the engine-anchor component form — see the module doc's anchor
 * precedence. Distinct from {@link REVISION_COMPONENT_PREFIX}: a token never
 * carries both, and {@link hasRevisionAnchor} stays true only for the
 * TypeGraph-owned form.
 */
const ENGINE_COMPONENT_PREFIX = "engine:";

/**
 * Falls back to schema version `1` when the backend has not recorded an active
 * schema version. `serializeSchema` only uses the version for the serialized
 * doc; the hash deliberately excludes it, so the exact value never affects the
 * resulting `BaseVersion`.
 */
const FALLBACK_SCHEMA_VERSION = 1;

/**
 * Reads the active schema version from the backend, defaulting when absent. The
 * value is informational for `serializeSchema`; `computeSchemaHash` excludes the
 * version, so this never destabilizes the token.
 *
 * Exported so a caller re-validating the schema half of an already-computed
 * token — `merge.ts`'s `assertTargetUnchanged`, which needs a FRESH read
 * through the pinned transaction backend rather than `computeSchemaComponent`'s
 * root-backend read — shares this one reader instead of re-spelling the
 * `getActiveSchema` fallback. Takes the narrow read surface both a
 * `GraphBackend` and a `TransactionBackend` satisfy.
 */
export async function readActiveSchemaVersion(
  backend: Pick<GraphBackend, "getActiveSchema">,
  graphId: string,
): Promise<number> {
  const active = await backend.getActiveSchema(graphId);
  return active?.version ?? FALLBACK_SCHEMA_VERSION;
}

/**
 * Computes the schema-hash component of the base version token — the SCHEMA half of
 * `base@V`, independent of live content. Exported so `mergeIncremental()` can assert
 * `forkPoint` and `target` share a schema (the hard half of its precondition) without
 * re-parsing the token separator or recomputing the content fingerprint (§6.6).
 */
export async function computeSchemaComponent<G extends GraphDef>(
  store: Store<G>,
): Promise<string> {
  const version = await readActiveSchemaVersion(
    storeBackend(store),
    store.graphId,
  );
  return computeSchemaHash(serializeSchema(store.graph, version));
}

/**
 * Stable TOTAL comparator over `{ kind, id }` digest entries. Keyed on `(kind, id)`
 * because the node primary key is `(graph_id, kind, id)` — two nodes of different
 * kinds may legitimately share an `id` (e.g. `Person:x` and `Company:x`), so an
 * id-only comparator is non-total and would leave same-id/different-kind entries at
 * the mercy of sort stability. `(kind, id)` makes the digest order fully canonical.
 */
function byDigestEntry(
  left: Readonly<{ kind: string; id: string }>,
  right: Readonly<{ kind: string; id: string }>,
): number {
  const byKind = compareStrings(left.kind, right.kind);
  return byKind === 0 ? compareStrings(left.id, right.id) : byKind;
}

/**
 * Number of SHA-256 bytes retained for the content fingerprint. 16 bytes (128
 * bits) makes an accidental collision — which would let a divergent base pass
 * the merge precondition — negligible, while keeping the token fixed-width
 * regardless of store size.
 */
const CONTENT_FINGERPRINT_BYTES = 16;

/**
 * Builds the deterministic content fingerprint over the base store's LIVE rows.
 *
 * Each live node contributes `(id, updatedAt, validFrom, validTo, props)` and
 * each live edge contributes `(id, updatedAt, validFrom, validTo, endpoints,
 * props)`; both lists are sorted by id before serialization so the fingerprint is
 * independent of enumeration order. Props are canonicalized so the token changes
 * whenever live content changes even when two writes land on the same millisecond
 * `updated_at` (timestamp granularity must never be the sole change signal). The
 * bitemporal `valid_from`/`valid_to` are folded in for the same reason — they are
 * user-mutable row content, so a validity-only edit that leaves `updated_at`
 * unchanged must still move the token. Soft-deleted rows are intentionally
 * excluded — the fingerprint describes the live base a branch forks from.
 *
 * Takes the backend rather than a `Store` so the SAME fingerprint can be
 * re-computed inside a commit transaction (via the tx-scoped backend) for the
 * in-transaction `base@V` re-validation — the reads then observe the
 * transaction's snapshot, not whatever a concurrent writer has since committed.
 *
 * `identityAssertions` is REQUIRED (never defaulted): a caller that forgot to
 * read the ledger would silently mint a pre-identity token, so an identity-only
 * divergence would pass the `base@V` precondition. Pass an empty array only when
 * the store genuinely holds no current assertions.
 */
export async function computeContentComponent<G extends GraphDef>(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
  graph: G,
  identityAssertions: readonly IdentityTransferAssertion[],
): Promise<string> {
  const nodeKinds = getNodeKinds(graph);
  const edgeKinds = getEdgeKinds(graph);

  const nodeDigest: Readonly<{
    id: string;
    kind: string;
    updatedAt: string;
    validFrom: string | undefined;
    validTo: string | undefined;
    props: string;
  }>[] = [];
  for (const kind of nodeKinds) {
    const rows = await enumerateAllNodes(backend, graphId, kind);
    for (const row of rows) {
      if (row.deleted_at === undefined) {
        nodeDigest.push({
          id: row.id,
          kind: row.kind,
          updatedAt: row.updated_at,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          props: canonicalizeProps(parseRowProps(row.props)),
        });
      }
    }
  }

  const edgeDigest: Readonly<{
    id: string;
    kind: string;
    fromId: string;
    toId: string;
    updatedAt: string;
    validFrom: string | undefined;
    validTo: string | undefined;
    props: string;
  }>[] = [];
  for (const kind of edgeKinds) {
    const rows = await enumerateAllEdges(backend, graphId, kind);
    for (const row of rows) {
      if (row.deleted_at === undefined) {
        edgeDigest.push({
          id: row.id,
          kind: row.kind,
          fromId: row.from_id,
          toId: row.to_id,
          updatedAt: row.updated_at,
          validFrom: row.valid_from,
          validTo: row.valid_to,
          props: canonicalizeProps(parseRowProps(row.props)),
        });
      }
    }
  }

  // Omit the `identity` key entirely when the assertion list is empty, mirroring
  // the serializer's omit-when-empty convention (schema/serializer.ts). This keeps
  // the content token byte-identical to the pre-identity shape for identity-disabled
  // graphs and stores that carry identity config but zero live assertions — so a
  // pre-upgrade branch does not spuriously fail the base@V precondition.
  return sha256Hex(
    canonicalizeProps({
      nodes: nodeDigest.sort((left, right) => byDigestEntry(left, right)),
      edges: edgeDigest.sort((left, right) => byDigestEntry(left, right)),
      ...(identityAssertions.length === 0 ?
        {}
      : { identity: identityAssertions }),
    }),
    CONTENT_FINGERPRINT_BYTES,
  );
}

/**
 * Computes the immutable `base@V` token for a store. Combines the schema hash
 * with a durable revision anchor when tracking is enabled, otherwise with the
 * compatibility live-content fingerprint.
 *
 * MUST be called on the ORIGINAL base store, not a clone (clones regenerate
 * timestamps and would fingerprint differently when the compatibility path is
 * in use).
 */
export async function computeBaseVersion<G extends GraphDef>(
  store: Store<G>,
): Promise<BaseVersion> {
  if (store.revisionTrackingEnabled) {
    const [schemaComponent, origin, revision, activeVersion] =
      await Promise.all([
        computeSchemaComponent(store),
        store.revisionOriginNow(),
        store.revisionNow(),
        readActiveSchemaVersion(storeBackend(store), store.graphId),
      ]);
    // The document hash is deliberately version-blind, and the revision
    // clock does not advance on schema commits — so a schema ROUND-TRIP
    // (migrate away and back) would otherwise restore the exact token while
    // its preflights mutated identity rows. The active schema version is
    // monotonic, so baking it into the schema half fences the round-trip.
    // The legacy branch below needs no equivalent: its content fingerprint
    // covers the mutated rows directly.
    return asBaseVersion(
      `${schemaComponent}${SCHEMA_VERSION_TAG}${activeVersion}${TOKEN_SEPARATOR}${revisionComponent(origin, revision)}`,
    );
  }
  // Tracking is off, so `resolveLineage` can only ever answer with the
  // BACKEND's own `lineage` (the recorded-relations lineage requires
  // `storeCaptureEnabled`, which implies tracking — see the module doc's
  // anchor precedence). A store with no lineage at all falls through to the
  // compatibility content fingerprint below.
  const lineage = resolveLineage(store);
  if (lineage !== undefined) {
    // The session is the root backend `store` holds: this runs strictly
    // outside any transaction, so the root backend is the only session
    // available, and it is the same object `resolveLineage(store)` just
    // resolved `lineage` off of.
    const backend = storeBackend(store);
    const [schemaComponent, activeVersion, origin, revision] =
      await Promise.all([
        computeSchemaComponent(store),
        readActiveSchemaVersion(backend, store.graphId),
        // The SAME `typegraph_revision_origins` row the TypeGraph revision
        // anchor above binds to — ensured here too, on the store's own
        // graph, so an engine-anchored store (no TypeGraph revision
        // tracking) still gets a durable per-graph namespace to distinguish
        // it from an unrelated database whose engine coincidentally reports
        // the same revision. See `engineComponent`'s own doc.
        ensureRevisionOrigin(
          backend,
          recordedRevisionOriginsVerdict(backend),
          store.revisionSchema,
          store.graphId,
        ),
        lineage.revision(backend),
      ]);
    // Same schema-half shape as the revision-anchor branch, and for the same
    // reason: nothing here guarantees an engine's revision is blind to a
    // schema-only round-trip, so the active version stays folded in.
    //
    // Unlike the content-fingerprint fallback below, this anchor carries no
    // identity-assertion signal at all: `LineageDelta` names only node and
    // edge keys (see the module doc's precedence entry b), so a commit that
    // changes only the graph's current identity assertions is invisible to
    // `lineage.changesSince` and the engine-anchor re-validation guards in
    // `graph-merge/merge.ts` tolerate it as unchanged.
    return asBaseVersion(
      `${schemaComponent}${SCHEMA_VERSION_TAG}${activeVersion}${TOKEN_SEPARATOR}${engineComponent(origin, revision)}`,
    );
  }
  const [schemaComponent, contentComponent] = await Promise.all([
    computeSchemaComponent(store),
    computeStoreContentComponent(store),
  ]);
  return asBaseVersion(
    `${schemaComponent}${TOKEN_SEPARATOR}${contentComponent}`,
  );
}

/**
 * The content component of a live {@link Store}: reads the store's current
 * identity assertions, then fingerprints its live rows alongside them.
 *
 * Exists so {@link computeBaseVersion} can run the schema half and the content
 * half CONCURRENTLY. The identity read must precede the fingerprint (it is an
 * input to it), but that ordering is internal to this half and must not serialize
 * the independent schema hash behind it.
 */
async function computeStoreContentComponent<G extends GraphDef>(
  store: Store<G>,
): Promise<string> {
  const identityAssertions =
    await storeRuntime(store).readCurrentIdentityAssertions("state");
  return computeContentComponent(
    storeBackend(store),
    store.graphId,
    store.graph,
    identityAssertions,
  );
}

/**
 * THE one grammar for an origin-namespaced anchor component: `<prefix>`
 * followed by the durable per-graph origin nonce, the separator, and the
 * revision — shared by both anchor forms that carry an origin (the
 * TypeGraph revision anchor and the engine anchor) so there is exactly one
 * place that encodes and decodes `<origin><sep><revision>`, never two
 * hand-spelled copies drifting apart. The origin itself is a `generateId()`
 * nonce (URL-safe nanoid alphabet), which never contains
 * {@link REVISION_COMPONENT_SEPARATOR}, so the FIRST separator in the
 * encoded string unambiguously ends the origin even when the revision that
 * follows contains separators of its own (a `RecordedInstant` does).
 */
function encodeAnchorComponent(
  prefix: string,
  origin: string,
  revision: string,
): string {
  return `${prefix}${origin}${REVISION_COMPONENT_SEPARATOR}${revision}`;
}

function decodeAnchorComponent(
  prefix: string,
  component: string,
): Readonly<{ origin: string; revision: string }> | undefined {
  if (!component.startsWith(prefix)) return undefined;
  const encoded = component.slice(prefix.length);
  const separator = encoded.indexOf(REVISION_COMPONENT_SEPARATOR);
  if (separator <= 0 || separator === encoded.length - 1) return undefined;
  return {
    origin: encoded.slice(0, separator),
    revision: encoded.slice(separator + 1),
  };
}

function revisionComponent(
  origin: string,
  revision: string | undefined,
): string {
  return encodeAnchorComponent(
    REVISION_COMPONENT_PREFIX,
    origin,
    revision ?? INITIAL_REVISION,
  );
}

/**
 * Builds the engine-anchor component: the store's durable per-graph revision
 * origin (the SAME `typegraph_revision_origins` row the TypeGraph revision
 * anchor uses, ensured at mint time by {@link computeBaseVersion}) alongside
 * the engine's own opaque revision. Without the origin, two independent
 * databases whose engines both happen to report the same revision string
 * (a fresh counter starting at "r1", for instance) would mint identical
 * engine anchors for unrelated graphs — see the module doc's clear()-epoch
 * and cross-database notes.
 */
function engineComponent(origin: string, revision: EngineRevision): string {
  return encodeAnchorComponent(ENGINE_COMPONENT_PREFIX, origin, revision);
}

/** True when a base token uses the O(1) durable revision-anchor component. */
export function hasRevisionAnchor(version: BaseVersion): boolean {
  return contentComponentOf(version).startsWith(REVISION_COMPONENT_PREFIX);
}

function engineAnchorParts(
  version: BaseVersion,
): Readonly<{ origin: string; revision: EngineRevision }> | undefined {
  const parts = decodeAnchorComponent(
    ENGINE_COMPONENT_PREFIX,
    contentComponentOf(version),
  );
  return parts === undefined ? undefined : (
      { origin: parts.origin, revision: parts.revision as EngineRevision }
    );
}

/**
 * Extracts the engine revision from an engine-anchored base token, or
 * `undefined` for any other anchor form. The ONE parser for this component,
 * paired with {@link engineComponent}: `graph-merge/merge.ts`'s
 * `assertTargetUnchanged` and `assertForkPointUnchanged` both call this
 * rather than re-spelling the `"engine:"` prefix.
 */
export function engineAnchorOf(
  version: BaseVersion,
): EngineRevision | undefined {
  return engineAnchorParts(version)?.revision;
}

/**
 * Extracts the durable store-specific origin namespace from an
 * engine-anchored base token, the engine-anchor counterpart of
 * {@link revisionOriginOf}. `undefined` for any other anchor form.
 */
export function engineAnchorOriginOf(version: BaseVersion): string | undefined {
  return engineAnchorParts(version)?.origin;
}

/**
 * Extracts the durable revision from a revision-anchored base token. Undefined
 * represents the stable initial state before the first tracked write.
 */
export function revisionAnchorOf(version: BaseVersion): string | undefined {
  const revision = revisionPartsOf(version)?.revision;
  return revision === undefined || revision === INITIAL_REVISION ?
      undefined
    : revision;
}

/**
 * Extracts the durable store-specific namespace from a revision-anchored base
 * token. Undefined denotes a legacy timestamp-only anchor, which must never
 * be treated as equivalent to a current store's namespaced revision.
 */
export function revisionOriginOf(version: BaseVersion): string | undefined {
  return revisionPartsOf(version)?.origin;
}

/**
 * THE one owner of the origin-match decision for EITHER origin-namespaced
 * anchor form: `expectedVersion`'s origin component — the revision anchor's
 * when it carries one, else the engine anchor's — against the LIVE origin
 * row {@link readRevisionOrigin} reads off `backend` for `graphId`. A token
 * only ever carries one anchor form, so exactly one of the two extractors
 * below answers. `merge.ts`'s `assertTargetUnchanged` (re-validating either
 * anchor form inside the commit transaction) and this module's own
 * `lineageDeltaSinceAnchor` (deciding whether a `base` of either
 * origin-namespaced form can trust a `changesSince` read) both need exactly
 * this comparison; extracted here so neither re-spells it. Returns the two
 * values actually compared alongside the verdict, so a caller that refuses
 * on a mismatch embeds both in its own error `details` without a second
 * read.
 */
export async function revisionOriginMatch(
  backend: Pick<GraphBackend, "execute">,
  schema: SqlSchema,
  graphId: string,
  expectedVersion: BaseVersion,
): Promise<
  Readonly<{
    expectedOrigin: string | undefined;
    liveOrigin: string | undefined;
    matches: boolean;
  }>
> {
  const expectedOrigin =
    revisionOriginOf(expectedVersion) ?? engineAnchorOriginOf(expectedVersion);
  const liveOrigin = await readRevisionOrigin(backend, schema, graphId);
  return { expectedOrigin, liveOrigin, matches: liveOrigin === expectedOrigin };
}

function revisionPartsOf(
  version: BaseVersion,
): Readonly<{ origin: string; revision: string }> | undefined {
  return decodeAnchorComponent(
    REVISION_COMPONENT_PREFIX,
    contentComponentOf(version),
  );
}

/**
 * Extracts the second component from a `base@V` token. The schema component
 * contains no NUL byte, so the substring after the separator is exactly the
 * durable revision or compatibility content fingerprint.
 *
 * Used by both revision-token parsing and legacy in-transaction content
 * re-validation. The schema component is a pure function of the in-memory
 * graph definition, so only the second component needs runtime checking.
 */
export function contentComponentOf(version: BaseVersion): string {
  const separatorIndex = (version as string).indexOf(TOKEN_SEPARATOR);
  return separatorIndex === -1 ? version : (
      (version as string).slice(separatorIndex + 1)
    );
}

/**
 * Extracts the schema-hash component (including the schema-version tag when
 * present) from a `base@V` token — the substring BEFORE the separator, the
 * complement of {@link contentComponentOf}. A caller that must tell a schema
 * change from an anchor-only change — `assertForkPointUnchanged`'s
 * empty-delta acceptance for an engine anchor — compares this independently
 * of the full token rather than assuming a whole-token mismatch is always a
 * real divergence.
 */
export function schemaComponentOf(version: BaseVersion): string {
  const separatorIndex = (version as string).indexOf(TOKEN_SEPARATOR);
  return separatorIndex === -1 ? "" : (
      (version as string).slice(0, separatorIndex)
    );
}

/**
 * Extracts the monotonic active schema version baked into a revision- or
 * engine-anchored token's schema half, or `undefined` for a legacy
 * content-fallback token (which carries no {@link SCHEMA_VERSION_TAG} at
 * all — its content fingerprint covers a schema round-trip's mutated rows
 * directly, see the module doc). The document hash never contains `#s`
 * (hex digits only), so the tag position is unambiguous.
 *
 * Pairs with {@link readActiveSchemaVersion}: a caller re-validating the
 * schema half of an already-computed engine-anchored token — `merge.ts`'s
 * `assertTargetUnchanged`, which has no whole-token recomputation to lean
 * on the way `assertForkPointUnchanged` does — compares this parsed value
 * against a fresh `readActiveSchemaVersion` read instead of re-deriving the
 * split.
 */
export function schemaActiveVersionOf(
  version: BaseVersion,
): number | undefined {
  const component = schemaComponentOf(version);
  const tagIndex = component.indexOf(SCHEMA_VERSION_TAG);
  if (tagIndex === -1) return undefined;
  const parsed = Number(component.slice(tagIndex + SCHEMA_VERSION_TAG.length));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * What changed on `baseStore` after `base` was minted — the BASE-side half of
 * the pruned diff's safety argument (see `state-diff.ts`'s `diffAgainstBase`
 * and `staging.ts`'s `stageBranches`): a key absent from EITHER side's delta
 * is guaranteed identical to what the fork cloned from it, so restricting
 * enumeration to the union of both deltas is lossless. `undefined` means this
 * anchor form has no lineage `baseStore` can consult for it right now, and
 * the caller must fall back to the full diff for this side.
 *
 * Mirrors `merge.ts`'s `assertTargetUnchanged`, NOT `resolveLineage`: a
 * TypeGraph revision anchor is answered directly through the recorded
 * relations, the same way `assertTargetUnchanged` re-reads the clock
 * directly rather than going through `resolveLineage` — that selection is
 * for a store with NO TypeGraph revision anchor at all, which a
 * revision-anchored `base` can never be (see the module doc's precedence).
 * An engine anchor is answered through `resolveLineage(baseStore)` — this is
 * a PLANNING-time call, strictly outside any commit transaction, unlike
 * `assertTargetUnchanged`'s own engine branch, which reads the pinned
 * transaction handle's `lineage` instead (see that function's doc comment).
 *
 * The revision-anchor branch re-checks `assertTargetUnchanged`'s FIRST guard
 * before trusting the numeric revision at all: `revisionOriginOf(base)`
 * against `baseStore`'s LIVE origin row. This early check is no longer the
 * ONLY thing standing between a numerically coincidental anchor and
 * `changesSince` — the bundled `EngineRevision` `recordedRelationsLineage`
 * mints also embeds this same origin, and `changesSince` re-verifies it on
 * whatever session it is given (see that module's own doc, "Token identity
 * is scoped to one graph, not one physical store") — but it stays: it is
 * the cheap early exit that avoids a wasted `changesSince` round trip when
 * the branch clearly forked from an unrelated store, and it is what lets
 * this function reuse `originMatch.liveOrigin` below rather than reading
 * the origin a second time. `encodeRecordedLineageRevision` re-derives the
 * SAME bundled grammar `revision()` mints from the token's already-parsed
 * origin and revision components, rather than asking `recordedRelationsLineage`
 * for a fresh reading — `base`'s revision anchor is a specific PAST
 * revision, not "now".
 *
 * A revision-anchored `base` minted before `baseStore` ever advanced its
 * clock parses to `revisionAnchorOf(base) === undefined` (the "initial"
 * sentinel) even though {@link hasRevisionAnchor} is true for it; this
 * function returns `undefined` for that case too (falls back to the full
 * diff) rather than resolving a genesis token, which costs nothing in
 * practice — a store forked before its first tracked write has no rows to
 * enumerate on the base side either.
 */
export async function lineageDeltaSinceAnchor<G extends GraphDef>(
  baseStore: Store<G>,
  base: BaseVersion,
): Promise<LineageDelta | undefined> {
  const revisionAnchor = revisionAnchorOf(base);
  if (revisionAnchor !== undefined) {
    // `recordedRelationsLineage` below reads TypeGraph's own recorded
    // relations directly, so this gate is `storeCaptureEnabled`, not the
    // public `historyEnabled` getter — a revision anchor is a TypeGraph-
    // owned token to begin with, but an engine-native store's `history:
    // true` must still fall back to the full diff here rather than reading
    // relations the engine never populates.
    if (!storeCaptureEnabled(baseStore)) return undefined;
    const originMatch = await revisionOriginMatch(
      storeBackend(baseStore),
      baseStore.revisionSchema,
      baseStore.graphId,
      base,
    );
    if (!originMatch.matches || originMatch.liveOrigin === undefined) {
      return undefined;
    }
    return recordedRelationsLineage(baseStore).changesSince(
      storeBackend(baseStore),
      encodeRecordedLineageRevision(originMatch.liveOrigin, revisionAnchor),
      baseStore.graphId,
    );
  }
  const engineAnchor = engineAnchorOf(base);
  if (engineAnchor === undefined) return undefined;
  // Same origin re-check as the revision-anchor branch above, and for the
  // same reason: the engine anchor's numeric-looking revision is meaningless
  // against a `baseStore` whose own origin row does not match the one
  // `base` was minted with — see `revisionOriginMatch`'s doc.
  const engineOriginMatch = await revisionOriginMatch(
    storeBackend(baseStore),
    baseStore.revisionSchema,
    baseStore.graphId,
    base,
  );
  if (!engineOriginMatch.matches) return undefined;
  const lineage = resolveLineage(baseStore);
  if (lineage === undefined) return undefined;
  // PLANNING-time call, strictly outside any commit transaction: the root
  // backend `baseStore` holds is the only session available, and the same
  // object `resolveLineage(baseStore)` resolved `lineage` off of.
  return lineage.changesSince(
    storeBackend(baseStore),
    engineAnchor,
    baseStore.graphId,
  );
}
