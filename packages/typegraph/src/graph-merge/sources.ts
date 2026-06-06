/**
 * Candidate SOURCES (design §4 / §6.1) — the RECALL layer of candidate generation.
 *
 * Candidate generation is three layers — sources → scoring → reconciler (§4). This
 * module is the FIRST layer: each source PROPOSES candidates and decides nothing
 * about a fuzzy match. A source emits three things:
 *
 *   - `pairs`       — unscored `(a, b)` node pairs handed to the shared scoring
 *                     stage (`scoring.ts`), which makes every fuzzy match decision.
 *   - `forcedEdges` — DEFINITIONAL matches (a shared unique value) that bypass
 *                     scoring at {@link FORCED_MATCH_SCORE}.
 *   - `baseMembers` — committed base nodes the source pulled into scope, so the
 *                     reconciler can seed + canonicalize a base endpoint without
 *                     re-querying the backend. EMPTY for staged-only sources.
 *
 * Two sources ship here — today's two blocking strategies (`blocking.ts`),
 * refactored behind the source interface:
 *
 *   - {@link exactKeySource} (`exactKey`, §6.1) — the `block(node) => string`
 *     bucket: same-bucket node pairs become fuzzy `pairs`. Staged-vs-staged.
 *   - {@link uniqueSource} (`unique`, §6.1) — the unique-constraint signature
 *     buckets: every same-signature pair is a FORCED edge (a shared unique value
 *     is definitionally the same entity). Staged-vs-staged.
 *
 * Both read the SAME pre-computed `blockNodes` map off the scope (the UNION of the
 * `block()` key and the per-constraint signatures, `blocking.ts`), filtering it by
 * {@link isUniqueBucketKey}: `exactKey` owns the non-unique buckets, `unique` owns
 * the unique buckets. Sharing one blocked map (vs. re-blocking per source) keeps the
 * source split byte-identical to the old fused `generateCandidates` — a node with a
 * unique signature but no `block()` key lands ONLY in its unique bucket, never the
 * all-vs-all `unblocked` bucket.
 *
 * Determinism: the extraction visits buckets in sorted-key order over id-sorted
 * members and enumerates `i < j`, so proposals are emitted in a canonical order;
 * the scoring stage additionally dedups + sorts, so neither source's emission order
 * leaks into the merge result.
 */

import { isUniqueBucketKey, UNBLOCKED_BUCKET_KEY } from "./blocking";
import { MergeError } from "./errors";
import {
  compareMergeKeys,
  compareStrings,
  idOf,
  kindOf,
  type MergeKey,
  mergeKey,
  mergeKeyOf,
} from "./node-key";
import type { CandidateEdge, CandidatePair } from "./scoring";
import { FORCED_MATCH_SCORE } from "./scoring";
import { fieldText } from "./similarity";
import type {
  GraphDef,
  JsonValue,
  Node,
  NodeId,
  NodeType,
  UniqueIntrospection,
} from "./typegraph-internal";
import type { ResolveConfig } from "./types";

/**
 * A committed BASE node a source pulled into the cluster universe (design §4
 * member contribution / §6.4-D). It carries the same `(id, kind, props)` a staged
 * member does, plus a reserved `"base"` origin so the reconciler can enforce
 * base-id-wins (§6.4-C) and tag provenance with the base sentinel (§6.4-D). EMPTY
 * for staged-only sources (`exactKey`, `unique`).
 */
export type BaseMember = Readonly<{
  id: NodeId<NodeType>;
  kind: string;
  props: Readonly<Record<string, JsonValue>>;
  origin: "base";
}>;

/**
 * What a candidate source emits for one kind: fuzzy `pairs` to score, FORCED
 * (definitional) edges to pass through unscored, and the committed `baseMembers`
 * it pulled into scope.
 */
export type SourceResult = Readonly<{
  pairs: readonly CandidatePair[];
  forcedEdges: readonly CandidateEdge[];
  baseMembers: readonly BaseMember[];
}>;

/**
 * The minimal node-collection surface a base-querying source needs: the public
 * `bulkFindByConstraint` (typegraph 0.29.0). It computes each item's constraint key
 * from its props, returns the live committed match per item in INPUT ORDER
 * (`undefined` for misses, soft-deleted excluded), and is indexed by the `uniques`
 * table PK — so graph-merge never reconstructs constraint keys itself. A runtime,
 * kind-string-keyed view (like the commit's `TxNodes`) so a source can dispatch on
 * a kind string without threading the caller's concrete `Store<G>` generic.
 */
export type BaseNodeLookup = Readonly<{
  bulkFindByConstraint: (
    constraintName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
  ) => Promise<readonly (Node<NodeType> | undefined)[]>;
  /**
   * The non-unique sibling (typegraph 0.30): for each item, the live committed nodes
   * sharing its declared-INDEX key (computed from props), returned per item in input
   * order, each inner array id-sorted, soft-deleted excluded. `limitPerInput` bounds
   * per-item fan-out (id-ordered, so the cap is deterministic). Candidate retrieval —
   * NOT a uniqueness/identity guarantee — so `baseKey` emits scored pairs, not forced
   * edges.
   */
  bulkFindByIndex: (
    indexName: string,
    items: readonly Readonly<{ props: Record<string, unknown> }>[],
    options?: Readonly<{ limitPerInput?: number }>,
  ) => Promise<readonly (readonly Node<NodeType>[])[]>;
}>;

/** Runtime, kind-string-keyed view of a store's node collections for base lookups. */
export type BaseLookupStore = Readonly<{
  nodes: Readonly<Record<string, BaseNodeLookup>>;
}>;

/**
 * The per-kind input a source generates over. `blocks` is the UNION `blockNodes`
 * result (`block()` key + per-constraint signatures) the staged sources read.
 *
 * The remaining fields are present only when a BASE-querying source (`baseUnique` /
 * `baseKey`, §6.2) is driven: the kind's materialized staged new `nodes` (the lookup
 * items), its `uniqueConstraints` (for `baseUnique`), the declared `blockIndex` name
 * (for `baseKey`, when the kind configured one), and the committed `store` to query
 * against. Staged-only sources (`exactKey`, `unique`) ignore them, so the public
 * `merge()` candidate path leaves them unset.
 */
export type SourceScope = Readonly<{
  kind: string;
  blocks: ReadonlyMap<string, readonly Node<NodeType>[]>;
  nodes?: readonly Node<NodeType>[];
  uniqueConstraints?: readonly UniqueIntrospection[];
  blockIndex?: string;
  /** When set, `exactKey` bounds the no-key (`"unblocked"`) bucket by sorted-
   * neighbourhood instead of all-vs-all (the `keyless` source, §6.2). */
  keyless?: KeylessConfig;
  store?: BaseLookupStore;
}>;

/**
 * A candidate source (design §4): proposes pairs (recall) + definitional forced
 * edges, and supplies the base members it pulled into scope. The `id` attributes
 * a source in reports and pins its determinism level (§7).
 */
export type CandidateSource = Readonly<{
  readonly id: string;
  generate(scope: SourceScope): Promise<SourceResult>;
}>;

/**
 * Orders a pair's two node IDENTITY keys (`(kind, id)`, not bare id) so the smaller
 * is `a`, with the matching node objects in `left`/`right`. Keying on the composite
 * identity is what keeps a `Patient` and an `Encounter` that share an id string from
 * being proposed as the same endpoint. Guarantees every proposal has a single
 * canonical `(a, b)` representation regardless of enumeration order.
 */
function orderEndpoints<K extends NodeType>(
  left: Node<K>,
  right: Node<K>,
): CandidatePair<K> {
  const leftKey = mergeKeyOf(left);
  const rightKey = mergeKeyOf(right);
  return compareMergeKeys(leftKey, rightKey) <= 0 ?
      { a: leftKey, b: rightKey, left, right }
    : { a: rightKey, b: leftKey, left: right, right: left };
}

/** Sorts a bucket's members by ascending node id (defensive — blocking already does). */
function sortMembersById<K extends NodeType>(
  members: readonly Node<K>[],
): readonly Node<K>[] {
  return [...members].sort((left, right) => compareStrings(left.id, right.id));
}

/** Visits the blocked buckets in sorted-key order. */
function sortedBucketKeys(
  blocks: ReadonlyMap<string, readonly Node<NodeType>[]>,
): readonly string[] {
  return [...blocks.keys()].sort((left, right) => compareStrings(left, right));
}

/** The system fields a {@link Node} carries alongside its schema props. */
const NODE_SYSTEM_FIELDS: ReadonlySet<string> = new Set(["id", "kind", "meta"]);

/**
 * Extracts a node's schema PROPS from its spread runtime shape (`Node` spreads its
 * schema fields at the top level alongside `id` / `kind` / `meta`). Used to build a
 * base lookup's props from a staged node and a {@link BaseMember}'s props from the
 * returned committed node — without a second fetch or any knowledge of the schema.
 */
function nodeProps(node: Node<NodeType>): Record<string, JsonValue> {
  const props: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(
    node as unknown as Record<string, unknown>,
  )) {
    if (!NODE_SYSTEM_FIELDS.has(key)) {
      props[key] = value as JsonValue;
    }
  }
  return props;
}

/**
 * The bounded coarse source for the NO-KEY case (design §6.2, `keyless`): which
 * unblocked nodes to compare, and how far. `window` is the forward-neighbour count;
 * `sortFields` is the kind's similarity text fields, so the SORTED-NEIGHBOURHOOD sort
 * groups lexically-similar values adjacently (the same text the scorer reads).
 */
export type KeylessConfig = Readonly<{
  window: number;
  sortFields: readonly string[];
}>;

/**
 * Builds the {@link KeylessConfig} for a kind's resolve config (its `keyless.window`
 * plus the similarity text fields the sorted-neighbourhood pass sorts on), or
 * `undefined` when `keyless` is unset. The sort fields are the kind's similarity text
 * (so adjacency tracks the scorer's text); `custom` similarity exposes none → sort by
 * id only (bounded but semantically weak — a no-key custom kind wants `stagedVector`,
 * deferred §8).
 *
 * Shared by `merge()`'s source path AND the back-compat `generateCandidates()` helper,
 * so both honour `ResolveConfig.keyless` identically rather than the helper silently
 * ignoring it.
 */
export function keylessConfigFor<G extends GraphDef, K extends NodeType>(
  resolveConfig: ResolveConfig<G, K>,
): KeylessConfig | undefined {
  if (resolveConfig.keyless === undefined) {
    return undefined;
  }
  const strategy = resolveConfig.similarity;
  const sortFields =
    strategy.kind === "fulltext" || strategy.kind === "hybrid" ? strategy.fields
    : strategy.kind === "vector" ? [strategy.field]
    : [];
  return { window: resolveConfig.keyless.window, sortFields };
}

/**
 * Single-pass SORTED-NEIGHBOURHOOD pairs over one bucket's members: sort by the
 * similarity-field text (tie-broken by id — a total order, so the output is a pure
 * function of the member SET), then propose each node only against its next `window`
 * neighbours. O(n·window) instead of O(n²); `window ≥ n-1` degenerates to all-vs-all.
 */
function windowedPairs(
  members: readonly Node<NodeType>[],
  config: KeylessConfig,
): readonly CandidatePair[] {
  const keyed = members.map((node) => ({
    node,
    key: fieldText(node, config.sortFields),
  }));
  keyed.sort((left, right) =>
    left.key === right.key ?
      compareStrings(left.node.id, right.node.id)
    : compareStrings(left.key, right.key),
  );
  const pairs: CandidatePair[] = [];
  for (let index = 0; index < keyed.length; index += 1) {
    const last = Math.min(index + config.window, keyed.length - 1);
    for (let index_ = index + 1; index_ <= last; index_ += 1) {
      pairs.push(orderEndpoints(keyed[index]!.node, keyed[index_]!.node));
    }
  }
  return pairs;
}

/**
 * Extracts the FUZZY candidate pairs from the NON-unique (block / unblocked)
 * buckets: every `i < j` pair of a bucket's id-sorted members, in sorted-key
 * order. Cross-bucket duplicates are left for the scoring stage to dedup.
 *
 * When `keyless` is set, the shared `"unblocked"` (no-key) bucket is bounded by
 * single-pass sorted-neighbourhood ({@link windowedPairs}) instead of all-vs-all —
 * closing the O(n²) cliff (design §6.2). Keyed `block()` buckets are unaffected
 * (they are already bounded by the key). Unset preserves all-vs-all for every bucket.
 */
export function pairsFromBlocks(
  blocks: ReadonlyMap<string, readonly Node<NodeType>[]>,
  keyless?: KeylessConfig,
): readonly CandidatePair[] {
  const pairs: CandidatePair[] = [];
  for (const bucketKey of sortedBucketKeys(blocks)) {
    if (isUniqueBucketKey(bucketKey)) {
      continue;
    }
    const members = sortMembersById(blocks.get(bucketKey) ?? []);
    if (keyless !== undefined && bucketKey === UNBLOCKED_BUCKET_KEY) {
      pairs.push(...windowedPairs(members, keyless));
      continue;
    }
    for (let index = 0; index < members.length; index += 1) {
      for (let index_ = index + 1; index_ < members.length; index_ += 1) {
        pairs.push(orderEndpoints(members[index]!, members[index_]!));
      }
    }
  }
  return pairs;
}

/**
 * Extracts the FORCED (definitional) edges from the UNIQUE-constraint buckets:
 * every `i < j` pair of a bucket's id-sorted members, at {@link FORCED_MATCH_SCORE}.
 * Cross-bucket / cross-constraint duplicates are left for the scoring stage to dedup.
 */
export function forcedEdgesFromBlocks(
  blocks: ReadonlyMap<string, readonly Node<NodeType>[]>,
): readonly CandidateEdge[] {
  const edges: CandidateEdge[] = [];
  for (const bucketKey of sortedBucketKeys(blocks)) {
    if (!isUniqueBucketKey(bucketKey)) {
      continue;
    }
    const members = sortMembersById(blocks.get(bucketKey) ?? []);
    for (let index = 0; index < members.length; index += 1) {
      for (let index_ = index + 1; index_ < members.length; index_ += 1) {
        const { a, b } = orderEndpoints(members[index]!, members[index_]!);
        edges.push({ a, b, score: FORCED_MATCH_SCORE });
      }
    }
  }
  return edges;
}

/**
 * Ontology RETYPE candidate edges (the cross-kind STAGED source, §6.4 / T10).
 *
 * Node identity is strictly `(kind, id)`, so a `Patient` and an `Encounter` that
 * share an id string are DISTINCT and never fuse. But under `reconcileTypes:
 * "ontology"`, two STAGED-NEW nodes that share a bare id AND carry subtype-compatible
 * kinds are "the same entity at a refined type" (one branch staged `Doctor:x`,
 * another `SpecialistDoctor:x`). This source forces those distinct identities into one
 * cluster so the reconciler can collapse it to the most-specific kind. The same-id
 * identities are PARTITIONED into maximal subtype-comparable groups first, so an
 * unrelated kind sharing the id (`Encounter:x` beside `Doctor:x` / `SpecialistDoctor:x`)
 * is split into its own group and does NOT suppress the valid retype; a group only
 * fuses when its kinds still collapse to a single most-specific kind.
 *
 * `isRetypeCompatible` MUST be the same most-specific-common-kind test the reconciler
 * uses ({@link import("./type-reconcile").mostSpecificCommonKind}), so a kind set
 * fuses here iff the reconciler would later collapse it. The caller passes STAGED
 * identities only: a committed-base ↔ staged cross-kind retype is an inherited
 * mutation the additive `mergeIncremental()` v1 refuses, so base members are excluded.
 *
 * Deterministic: ids are visited in sorted order, the identities at each id are sorted
 * + deduped, and a star of forced edges from the minimum identity makes the fusion
 * transitive (the scoring stage dedups the forced set).
 */
export function ontologyRetypeEdges(
  stagedIdentities: Iterable<MergeKey>,
  isRetypeCompatible: (kinds: readonly string[]) => boolean,
): readonly CandidateEdge[] {
  const identitiesById = new Map<string, MergeKey[]>();
  for (const identity of stagedIdentities) {
    const id = idOf(identity);
    const bucket = identitiesById.get(id);
    if (bucket === undefined) {
      identitiesById.set(id, [identity]);
    } else {
      bucket.push(identity);
    }
  }

  const edges: CandidateEdge[] = [];
  for (const id of [...identitiesById.keys()].sort(compareStrings)) {
    const identities = [...new Set(identitiesById.get(id))].sort(
      compareMergeKeys,
    );
    if (identities.length < 2) {
      continue; // a single kind at this id — nothing cross-kind to reconcile.
    }
    // Partition the same-id identities into maximal subtype-comparable GROUPS, so an
    // UNRELATED kind sharing the id (e.g. an `Encounter:x` next to a `Doctor:x` /
    // `SpecialistDoctor:x` refinement) does not suppress the valid retype: two
    // identities join a group when their kinds are pairwise retype-compatible, and the
    // relation is unioned transitively.
    const group = unionByCompatibility(identities, isRetypeCompatible);
    for (const members of groupsOf(identities, group)) {
      // Only fuse a group that still collapses to ONE most-specific kind (a single
      // minimum). Incompatible siblings linked only through a shared subtype do not —
      // fusing them would force the reconciler to flag the cluster and pick a kind.
      if (
        members.length < 2 ||
        !isRetypeCompatible(members.map((identity) => kindOf(identity)))
      ) {
        continue;
      }
      for (let index = 1; index < members.length; index += 1) {
        edges.push({
          a: members[0]!,
          b: members[index]!,
          score: FORCED_MATCH_SCORE,
        });
      }
    }
  }
  return edges;
}

/**
 * Union-find over a same-id identity set: `identity → group representative`, where two
 * identities share a representative iff their kinds are (transitively) pairwise
 * {@link isRetypeCompatible}. Pure over the identity SET (the representative chosen is
 * irrelevant — only the partition matters, and callers re-sort each group).
 */
function unionByCompatibility(
  identities: readonly MergeKey[],
  isRetypeCompatible: (kinds: readonly string[]) => boolean,
): ReadonlyMap<MergeKey, MergeKey> {
  const parent = new Map<MergeKey, MergeKey>(
    identities.map((identity) => [identity, identity]),
  );
  const find = (key: MergeKey): MergeKey => {
    let root = key;
    while (parent.get(root) !== root) {
      root = parent.get(root)!;
    }
    return root;
  };
  for (let index = 0; index < identities.length; index += 1) {
    for (let index_ = index + 1; index_ < identities.length; index_ += 1) {
      if (
        isRetypeCompatible([kindOf(identities[index]!), kindOf(identities[index_]!)])
      ) {
        parent.set(find(identities[index]!), find(identities[index_]!));
      }
    }
  }
  return new Map(identities.map((identity) => [identity, find(identity)]));
}

/** Buckets identities by their union-find representative, each group id-sorted. */
function groupsOf(
  identities: readonly MergeKey[],
  representativeOf: ReadonlyMap<MergeKey, MergeKey>,
): readonly (readonly MergeKey[])[] {
  const byRoot = new Map<MergeKey, MergeKey[]>();
  for (const identity of identities) {
    const root = representativeOf.get(identity)!;
    const bucket = byRoot.get(root);
    if (bucket === undefined) {
      byRoot.set(root, [identity]);
    } else {
      bucket.push(identity);
    }
  }
  return [...byRoot.values()].map((group) => [...group].sort(compareMergeKeys));
}

/**
 * `exactKey` source (§6.1) — today's `block(node) => string` bucketing. Same-bucket
 * node pairs become fuzzy `pairs` for the scoring stage to decide. Staged-vs-staged,
 * fully deterministic, no base members.
 *
 * Also hosts the `keyless` source (§6.2): when `scope.keyless` is set, the no-key
 * (`"unblocked"`) bucket is bounded by sorted-neighbourhood rather than all-vs-all.
 * It rides `exactKey` rather than a parallel source because both operate on the same
 * staged blocked map and would otherwise double-emit the unblocked bucket.
 */
export const exactKeySource: CandidateSource = {
  id: "exactKey",
  generate(scope) {
    return Promise.resolve({
      pairs: pairsFromBlocks(scope.blocks, scope.keyless),
      forcedEdges: [],
      baseMembers: [],
    });
  },
};

/**
 * `unique` source (§6.1) — today's unique-constraint short-circuit. Every pair
 * sharing a unique signature is a FORCED edge: a shared unique value is
 * definitionally the same entity, so it merges regardless of similarity (differing
 * properties are reported as conflicts downstream, and the merged graph never
 * violates its own uniqueness). Staged-vs-staged, fully deterministic, no base
 * members.
 */
export const uniqueSource: CandidateSource = {
  id: "unique",
  generate(scope) {
    return Promise.resolve({
      pairs: [],
      forcedEdges: forcedEdgesFromBlocks(scope.blocks),
      baseMembers: [],
    });
  },
};

/**
 * `baseUnique` source (§6.2) — the first NEW-vs-BASE source. For each declared
 * unique constraint, it issues ONE batched `bulkFindByConstraint` over the staged
 * new nodes against the committed base store (TypeGraph's own constraint API,
 * indexed by the `uniques` PK; key computed from props, soft-deleted excluded). Each
 * hit is a DEFINITIONAL match — a staged node sharing a committed node's unique
 * value is the same entity — so it emits:
 *
 *   - a FORCED edge between the staged node and the committed base node, and
 *   - a {@link BaseMember} built from the returned committed node (no second fetch),
 *     so the reconciler can seed + canonicalize the base endpoint (§4).
 *
 * Grouped by `(kind, constraint)` — one batched call per constraint — so each
 * constraint's own `fields` / `where` / `scope` / `collation` semantics are honoured
 * by construction; graph-merge never rebuilds keys. Deterministic: constraints are
 * visited in sorted name order, base members are deduped by id and id-sorted, and
 * the scoring stage dedups + sorts the forced edges.
 *
 * NOT part of {@link CANDIDATE_SOURCES}: the public `merge()` snapshot path stays
 * staged-vs-staged. This source is driven only by the synthetic new-vs-base scope
 * (later slice steps), which supplies the `nodes` / `uniqueConstraints` / `store`
 * the staged sources omit.
 */
export const baseUniqueSource: CandidateSource = {
  id: "baseUnique",
  async generate(scope) {
    const { kind, nodes, uniqueConstraints, store } = scope;
    if (
      nodes === undefined ||
      uniqueConstraints === undefined ||
      store === undefined
    ) {
      throw new MergeError(
        "baseUniqueSource requires nodes, uniqueConstraints, and store in the source scope.",
        { details: { kind, source: "baseUnique" } },
      );
    }

    const collection = store.nodes[kind];
    if (collection === undefined || nodes.length === 0) {
      return { pairs: [], forcedEdges: [], baseMembers: [] };
    }

    const forcedEdges: CandidateEdge[] = [];
    const baseMembers = new Map<string, BaseMember>();

    // The lookup items are the SAME for every constraint (one props bag per staged
    // node), so build them ONCE rather than per constraint, and fire the independent
    // per-constraint lookups concurrently. Results are consumed in sorted-constraint
    // order below, so the dedup-by-id keeps determinism despite the parallel I/O.
    const constraints = [...uniqueConstraints].sort((left, right) =>
      compareStrings(left.name, right.name),
    );
    const items = nodes.map((node) => ({ props: nodeProps(node) }));
    // `bulkFindByConstraint` re-validates each item's FULL props against the kind's
    // CREATE schema to compute the constraint key, so a non-idempotent create schema
    // (a transform/default/coercion) — or a staged node that otherwise fails the
    // schema — throws a typegraph error. Surface it as a typed MergeError carrying the
    // kind + constraint, rather than letting an opaque throw be masked as the generic
    // "Merge failed while staging or committing" wrapper downstream.
    const matchesByConstraint = await Promise.all(
      constraints.map(async (constraint) => {
        try {
          return await collection.bulkFindByConstraint(constraint.name, items);
        } catch (error) {
          throw new MergeError(
            `baseUniqueSource: new-vs-base lookup for constraint "${constraint.name}" on kind "${kind}" failed — a staged node's props could not be validated against the kind's schema for constraint-key computation.`,
            { details: { kind, constraint: constraint.name }, cause: error },
          );
        }
      }),
    );
    for (const matches of matchesByConstraint) {
      for (const [index, node] of nodes.entries()) {
        const base = matches[index];
        if (base === undefined) {
          continue;
        }
        const stagedNode = node;
        const stagedKey = mergeKey(stagedNode.kind, stagedNode.id);
        const baseKey = mergeKey(base.kind, base.id);
        // ALWAYS pull the committed node in as a base member, so the reconciler seeds +
        // canonicalizes it and enforces base-id-wins (§6.4-C) — including for a
        // same-(kind,id) re-discovery, where the committed value must still win over a
        // divergent staged prop. (Dropping the base member here is what made a same-id
        // re-add ERROR in the stale-overwrite guard instead of resolving onto the base.)
        if (!baseMembers.has(baseKey)) {
          baseMembers.set(baseKey, {
            origin: "base",
            id: base.id,
            kind: base.kind,
            props: nodeProps(base),
          });
        }
        // A same-(kind,id) re-discovery is already ONE identity (the base member lands
        // in the staged node's own cluster by key), so it needs no linking edge — a
        // self-loop would be a degenerate no-op. Skip ONLY the forced edge, not the
        // base member above.
        if (stagedKey === baseKey) {
          continue;
        }
        const { a, b } =
          compareMergeKeys(stagedKey, baseKey) <= 0 ?
            { a: stagedKey, b: baseKey }
          : { a: baseKey, b: stagedKey };
        forcedEdges.push({ a, b, score: FORCED_MATCH_SCORE });
      }
    }

    return {
      pairs: [],
      forcedEdges,
      baseMembers: [...baseMembers.values()].sort((left, right) =>
        compareStrings(left.id, right.id),
      ),
    };
  },
};

/**
 * `baseKey` source (§6.2, descriptor-backed block key) — the second NEW-vs-BASE
 * source. For the kind's declared block INDEX (named by `ResolveConfig.blockIndex`,
 * threaded onto the scope), it issues ONE batched `bulkFindByIndex` over the staged
 * new nodes against the committed base store (typegraph 0.30's non-unique index
 * lookup; key computed from props, soft-deleted excluded, fan-out bounded by
 * `limitPerInput`). Unlike {@link baseUniqueSource}, a shared block key is NOT
 * definitional — it is a candidate — so each new↔base hit emits:
 *
 *   - a {@link CandidatePair} (staged ↔ base) handed to the shared scoring stage (it
 *     becomes an edge only if it clears the kind's threshold), and
 *   - a {@link BaseMember} built from the returned committed node (no second fetch).
 *
 * A same-(kind, id) hit needs no pair — the base member joins the staged node's own
 * cluster by key — so only its base member is emitted. graph-merge never reconstructs
 * the index key (typegraph owns `fields`/`scope`/`where`/collation), mirroring
 * `baseUnique`. Deterministic: typegraph returns matches per item in input order,
 * id-sorted; base members are deduped by id and id-sorted; the scoring stage dedups +
 * sorts the pairs. Field-set index keys only — a transform block key stays on the
 * staged-only opaque `block()` (§6.2).
 *
 * NOT part of {@link CANDIDATE_SOURCES}: the public `merge()` snapshot path stays
 * staged-vs-staged; this source runs only under the synthetic new-vs-base scope.
 */
export const baseKeySource: CandidateSource = {
  id: "baseKey",
  async generate(scope) {
    const { kind, nodes, blockIndex, store } = scope;
    // No declared block index for this kind → baseKey contributes nothing (a kind opts
    // into new-vs-base block-key recall by declaring an index + setting blockIndex).
    if (blockIndex === undefined) {
      return { pairs: [], forcedEdges: [], baseMembers: [] };
    }
    if (nodes === undefined || store === undefined) {
      throw new MergeError(
        "baseKeySource requires nodes and store in the source scope.",
        { details: { kind, source: "baseKey" } },
      );
    }

    const collection = store.nodes[kind];
    if (collection === undefined || nodes.length === 0) {
      return { pairs: [], forcedEdges: [], baseMembers: [] };
    }

    const items = nodes.map((node) => ({ props: nodeProps(node) }));
    // Like `bulkFindByConstraint`, an unknown index name / type-incompatible field
    // throws a typegraph error; surface it as a typed MergeError carrying the index +
    // kind rather than letting it be masked as the generic "Merge failed" wrapper.
    let matchesByNode: readonly (readonly Node<NodeType>[])[];
    try {
      matchesByNode = await collection.bulkFindByIndex(blockIndex, items);
    } catch (error) {
      throw new MergeError(
        `baseKeySource: new-vs-base lookup on index "${blockIndex}" for kind "${kind}" failed — the index is undeclared or a staged node's props are incompatible with its indexed fields.`,
        { details: { kind, index: blockIndex }, cause: error },
      );
    }

    const pairs: CandidatePair[] = [];
    const baseMembers = new Map<string, BaseMember>();
    for (const [index, node] of nodes.entries()) {
      const stagedNode = node;
      const stagedKey = mergeKey(stagedNode.kind, stagedNode.id);
      for (const base of matchesByNode[index] ?? []) {
        const baseKey = mergeKey(base.kind, base.id);
        if (!baseMembers.has(baseKey)) {
          baseMembers.set(baseKey, {
            origin: "base",
            id: base.id,
            kind: base.kind,
            props: nodeProps(base),
          });
        }
        // A same-(kind, id) re-discovery is already ONE identity; the base member lands
        // in the staged node's own cluster by key, so it needs no candidate pair.
        if (stagedKey === baseKey) {
          continue;
        }
        pairs.push(orderEndpoints(stagedNode, base));
      }
    }

    return {
      pairs,
      forcedEdges: [],
      baseMembers: [...baseMembers.values()].sort((left, right) =>
        compareStrings(left.id, right.id),
      ),
    };
  },
};

/**
 * The STAGED candidate sources the public `merge()` drives, in a fixed order (§6.1
 * "phase: now"). The scoring stage dedups + sorts the union, so this order does not
 * affect the merge result; it is fixed only for stable report attribution. The
 * new-vs-base {@link baseUniqueSource} / {@link baseKeySource} are deliberately NOT
 * here — they run only under the synthetic new-vs-base scope so the public snapshot
 * path stays staged-vs-staged.
 */
export const CANDIDATE_SOURCES: readonly CandidateSource[] = [
  exactKeySource,
  uniqueSource,
];
