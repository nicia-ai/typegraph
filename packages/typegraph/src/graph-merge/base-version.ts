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
 *   2. A **content fingerprint** — a SHA-256 digest (truncated to a fixed-width
 *      hex string) of every LIVE node and edge over the base store (`id`,
 *      `updated_at`, the bitemporal `valid_from`/`valid_to`, and canonicalized
 *      `props`; edges also carry their endpoint ids), sorted by id, so two stores
 *      with identical live content fingerprint identically regardless of row
 *      enumeration order or insertion order. Props AND validity are folded in so
 *      the token changes on a content or validity edit even when `updated_at` ties
 *      at millisecond granularity. Hashing keeps the token fixed-width instead of
 *      growing linearly with store size.
 *
 * The token MUST be computed off the ORIGINAL base store, never off a clone:
 * `exportGraph`/`importGraph` regenerate `created_at`/`updated_at`, so a clone's
 * fingerprint would not match its source. (See the working-copy fidelity note in
 * T4.)
 *
 * `computeBaseVersion` is async because schema hashing and live-content
 * enumeration go through async TypeGraph internals. The design's synchronous
 * illustrative signature does not survive contact with the real store surface.
 */

import { canonicalizeProps, parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import { enumerateAllEdges, enumerateAllNodes } from "./state-diff";
import type { GraphBackend, GraphDef, Store } from "./typegraph-internal";
import { getEdgeKinds, getNodeKinds, sha256Hex } from "./typegraph-internal";
import { computeSchemaHash, serializeSchema } from "./typegraph-internal";
import type { BaseVersion } from "./types";
import { asBaseVersion } from "./types";

/**
 * Separator between the schema-hash and content-fingerprint token components.
 * Both components are fixed-width hex digests (no NUL byte), so a single NUL
 * unambiguously delimits the two components.
 */
const TOKEN_SEPARATOR = "\0";

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
 */
async function readActiveSchemaVersion(
  backend: GraphBackend,
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
  const version = await readActiveSchemaVersion(store.backend, store.graphId);
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
 */
async function computeContentFingerprint<G extends GraphDef>(
  store: Store<G>,
): Promise<string> {
  const backend = store.backend;
  const graphId = store.graphId;
  const graph = store.graph;

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

  return sha256Hex(
    canonicalizeProps({
      nodes: nodeDigest.sort((left, right) => byDigestEntry(left, right)),
      edges: edgeDigest.sort((left, right) => byDigestEntry(left, right)),
    }),
    CONTENT_FINGERPRINT_BYTES,
  );
}

/**
 * Computes the immutable `base@V` token for a store. Combines the schema hash
 * with a live-content fingerprint into a single branded {@link BaseVersion}.
 *
 * MUST be called on the ORIGINAL base store, not a clone (clones regenerate
 * timestamps and would fingerprint differently).
 */
export async function computeBaseVersion<G extends GraphDef>(
  store: Store<G>,
): Promise<BaseVersion> {
  const [schemaComponent, contentComponent] = await Promise.all([
    computeSchemaComponent(store),
    computeContentFingerprint(store),
  ]);
  return asBaseVersion(
    `${schemaComponent}${TOKEN_SEPARATOR}${contentComponent}`,
  );
}
