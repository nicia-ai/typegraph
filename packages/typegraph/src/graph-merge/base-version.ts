/**
 * `base@V` stamping.
 *
 * A {@link BaseVersion} is the immutable token a branch is forked from. It must
 * change whenever either the schema OR the live content of the base store
 * changes, so that `merge()`'s precondition check (T11) can reject a branch that
 * forked from a divergent base.
 *
 * The token is two stable components joined by `|`:
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
 *      b. Otherwise, a **content fingerprint**, a
 *         SHA-256 digest (truncated to a fixed-width hex string) of every
 *         LIVE node and edge over the base store (`id`, `updated_at`, the
 *         bitemporal `valid_from`/`valid_to`, and canonicalized `props`;
 *         edges also carry their endpoint ids), sorted by id, so two stores
 *         with identical live content fingerprint identically regardless of
 *         row enumeration order or insertion order. Props AND validity are
 *         folded in so the token changes on a content or validity edit even
 *         when `updated_at` ties at millisecond granularity. Current
 *         identity assertions are folded in too (see
 *         `computeContentComponent`). A lineage-capable backend with revision
 *         origin support also carries the graph's durable origin beside the
 *         fingerprint, preserving the clear and cross-store fence. Hashing
 *         keeps the content digest fixed-width regardless of store size.
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
 * The schema component is a hex digest plus an optional `#s<version>` tag, so
 * it never contains `|`: the FIRST `|` delimits the two components even when
 * an engine revision after it contains one. Printable, so a token survives
 * every text store an application persists it in; PostgreSQL `text` and
 * `jsonb` both reject NUL.
 */
const TOKEN_SEPARATOR = "|";

/** The separator tokens were minted with before it became printable. */
const LEGACY_TOKEN_SEPARATOR = "\0";

/** Separates the schema hash from the monotonic active schema version. */
const SCHEMA_VERSION_TAG = "#s";
const REVISION_COMPONENT_PREFIX = "revision:";
const REVISION_COMPONENT_SEPARATOR = ":";
const INITIAL_REVISION = "initial";

/**
 * Recognizes retired engine-anchor tokens so they can be refused explicitly.
 */
const ENGINE_COMPONENT_PREFIX = "engine:";
const CONTENT_ORIGIN_PREFIX = "origin:";

/**
 * Falls back to schema version `1` when the backend has not recorded an active
 * schema version. The schema hash deliberately excludes this number, while
 * the token's `#s` component carries it to fence schema round-trips.
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
    // The content branch below carries this version too, because an
    // otherwise identical schema round-trip still changes the committed cut.
    return asBaseVersion(
      `${schemaComponent}${SCHEMA_VERSION_TAG}${activeVersion}${TOKEN_SEPARATOR}${revisionComponent(origin, revision)}`,
    );
  }
  // Without TypeGraph revision tracking, the complete graph fingerprint is
  // the commit-spanning fence, including current identity assertions.
  const [schemaComponent, activeVersion, contentComponent] = await Promise.all([
    computeSchemaComponent(store),
    readActiveSchemaVersion(storeBackend(store), store.graphId),
    computeStoreContentComponent(store),
  ]);
  const backend = storeBackend(store);
  const originsVerdict =
    resolveLineage(store) === undefined ? undefined : (
      recordedRevisionOriginsVerdict(backend)
    );
  const origin =
    originsVerdict?.supported ?
      await ensureRevisionOrigin(
        backend,
        originsVerdict,
        store.revisionSchema,
        store.graphId,
      )
    : undefined;
  const contentAnchor =
    origin === undefined ? contentComponent : (
      `${CONTENT_ORIGIN_PREFIX}${origin}:${contentComponent}`
    );
  return asBaseVersion(
    `${schemaComponent}${SCHEMA_VERSION_TAG}${activeVersion}${TOKEN_SEPARATOR}${contentAnchor}`,
  );
}

/** Parses the durable origin carried by a content-fingerprinted base token. */
export function contentOriginOf(version: BaseVersion): string | undefined {
  const component = contentComponentOf(version);
  if (!component.startsWith(CONTENT_ORIGIN_PREFIX)) return undefined;
  const separator = component.indexOf(":", CONTENT_ORIGIN_PREFIX.length);
  return separator === -1 ? undefined : (
      component.slice(CONTENT_ORIGIN_PREFIX.length, separator)
    );
}

/** Returns the graph-content digest from a content-fingerprinted token. */
export function contentFingerprintOf(version: BaseVersion): string {
  const component = contentComponentOf(version);
  if (!component.startsWith(CONTENT_ORIGIN_PREFIX)) return component;
  const separator = component.indexOf(":", CONTENT_ORIGIN_PREFIX.length);
  return separator === -1 ? component : component.slice(separator + 1);
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
 * revision. The decoder also recognizes retired engine-anchor tokens, so
 * there is exactly one place that parses `<origin><sep><revision>`, never two
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
 * Extracts the engine revision from a previously minted engine-anchor token.
 * New tokens never use this form; the merge commit refuses it.
 */
export function engineAnchorOf(
  version: BaseVersion,
): EngineRevision | undefined {
  return engineAnchorParts(version)?.revision;
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
 * The origin-match decision for TypeGraph revision anchors: compare the
 * token's origin with the live row {@link readRevisionOrigin} reads from the
 * supplied session. Both the merge commit and lineage pruning use this
 * comparison. Returns the two
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
  const expectedOrigin = revisionOriginOf(expectedVersion);
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
 * Whether `version` was minted in the retired NUL-separated format. Such a
 * token can never equal one a live store mints now, so every precondition
 * refuses it; callers use this only to say why.
 */
export function isLegacyBaseVersion(version: BaseVersion): boolean {
  return (version as string).includes(LEGACY_TOKEN_SEPARATOR);
}

/** Refusal details shared by every site that rejects a legacy token. */
export const LEGACY_BASE_VERSION_REFUSAL = {
  reason: "legacy-token-format",
  suggestion:
    "This token was minted by an earlier TypeGraph release in a retired format. Re-branch or re-plan from the current target.",
} as const;

/**
 * Index of the component separator, or -1 for a token with no schema
 * component. A legacy token parses as having none, so no anchor or schema
 * half is ever read out of it.
 */
function tokenSeparatorIndex(version: BaseVersion): number {
  if (isLegacyBaseVersion(version)) return -1;
  return (version as string).indexOf(TOKEN_SEPARATOR);
}

/**
 * Extracts the second component from a `base@V` token. The schema component
 * contains no separator, so the substring after the separator is exactly the
 * durable revision or content fingerprint (possibly with its origin).
 *
 * Used by revision-token parsing and content-fingerprint re-validation.
 */
export function contentComponentOf(version: BaseVersion): string {
  const separatorIndex = tokenSeparatorIndex(version);
  return separatorIndex === -1 ? version : (
      (version as string).slice(separatorIndex + 1)
    );
}

/**
 * Extracts the schema-hash component (including the schema-version tag when
 * present) from a `base@V` token — the substring before the separator.
 */
export function schemaComponentOf(version: BaseVersion): string {
  const separatorIndex = tokenSeparatorIndex(version);
  return separatorIndex === -1 ? "" : (
      (version as string).slice(0, separatorIndex)
    );
}

/**
 * Extracts the monotonic active schema version baked into a current token's
 * schema half, or `undefined` for an older content token. The document hash
 * never contains `#s`
 * (hex digits only), so the tag position is unambiguous.
 *
 * Pairs with {@link readActiveSchemaVersion} inside the target commit
 * transaction so a schema round-trip cannot restore an older fence.
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
 * TypeGraph revision anchors are answered directly through the recorded
 * relations. Content-fingerprinted and retired engine tokens return
 * `undefined`, selecting the complete diff.
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
  return undefined;
}
