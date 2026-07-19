import { requireDefined } from "../utils/presence";
/**
 * Per-kind blocking (design §9 phase 2): bucket a kind's NEW nodes by a cheap
 * exact-equality key so candidate-gen (T6) only compares pairs that could
 * plausibly be the same entity, bounding the otherwise-O(n²) work.
 *
 * A node is placed into a bucket for EACH key it produces, so it can belong to
 * MULTIPLE buckets — two key sources combined as a UNION (not a composite key):
 *
 *   1. The caller's `ResolveConfig.block(node)` — an application-defined cheap
 *      pre-filter (e.g. a Patient's `birthDate`) → its ONE block bucket.
 *   2. The kind's declared `unique` constraints, read from the PUBLIC
 *      `store.introspect().kinds[k].unique` → ONE bucket per constraint the node
 *      fully satisfies. A unique constraint is an exact-match short-circuit: two
 *      nodes sharing all of a constraint's field values are definitionally the
 *      same entity, so they co-bucket THERE regardless of their block keys or any
 *      OTHER constraint.
 *
 * Composing the two sources into a single key (the old behavior) was a bug: a
 * differing `block()` key — or a differing EARLIER constraint — split two nodes
 * that share a unique value into separate buckets, so candidate-gen never compared
 * them and a real duplicate survived the merge. The UNION fixes this: a shared
 * unique value always co-buckets, independent of `block()`.
 *
 * candidate-gen compares pairs within each bucket and DEDUPS pairs across buckets,
 * so a node in several buckets is compared against the UNION of its bucket-mates,
 * each pair scored exactly once.
 *
 * Determinism is load-bearing — candidate-gen order must never leak into merge
 * results — so bucket keys are emitted sorted lexicographically, each bucket's
 * member list is sorted by `node.id`, and each unique signature is built in the
 * constraint's declared field order.
 *
 * A node that produces NO key (no `block()`, no satisfied constraint) lands in the
 * shared {@link UNBLOCKED_BUCKET_KEY} bucket, compared all-vs-all within its kind.
 * This is the safe (no false-negative) fallback: blocking only ever prunes pairs
 * that are guaranteed non-matches.
 *
 * This module is a PURE function over its inputs (the introspection snapshot is
 * read synchronously by the caller and passed in); it performs no I/O.
 */
import { compareStrings } from "./node-key";
import type { Node, NodeType, UniqueIntrospection } from "./typegraph-internal";
import { computeUniqueKey } from "./typegraph-internal";
import type { ResolveConfig } from "./types";

/**
 * Bucket key for nodes that produced no blocking key from either `block()` or a
 * unique constraint. Members of this bucket are compared all-vs-all within their
 * kind by candidate-gen.
 */
export const UNBLOCKED_BUCKET_KEY = "unblocked";

/**
 * Separator joining the parts of a bucket key (its prefix, and a unique
 * signature's constraint name + field values). Chosen as a control character so it
 * cannot collide with ordinary stringified property values.
 */
const KEY_PART_SEPARATOR = "\0";

/**
 * Prefix marking a `block()`-key bucket, so a `block()` value can never be confused
 * with a unique-constraint value that happens to stringify the same.
 */
const BLOCK_KEY_PREFIX = "b";

/** Prefix marking a unique-constraint bucket. See {@link BLOCK_KEY_PREFIX}. */
const UNIQUE_KEY_PREFIX = "u";

/**
 * True when a bucket key denotes a UNIQUE-constraint bucket (vs. a `block()` or the
 * unblocked bucket). candidate-gen FORCE-MERGES every pair in such a bucket: a
 * shared unique value is definitionally the same entity (the exact-match
 * short-circuit), so the pair is a GUARANTEED merge candidate regardless of the
 * similarity threshold — differing properties are then reported as conflicts
 * normally. This also keeps the merged graph from violating its own uniqueness:
 * two unmerged same-unique rows could never commit.
 */
export function isUniqueBucketKey(key: string): boolean {
  return key.startsWith(`${UNIQUE_KEY_PREFIX}${KEY_PART_SEPARATOR}`);
}

/**
 * Builds the exact-match signature for one unique constraint from a node's
 * field values, or `undefined` when ANY of the constraint's fields is `null` /
 * `undefined` (a partial key cannot establish exact-match equality, and — since
 * the introspection snapshot does not expose a constraint's `where` predicate —
 * skipping absent values keeps a partial unique constraint from silently
 * over-merging two distinct rows that the database would treat as a non-match;
 * a genuine non-partial null collision still surfaces loudly at commit).
 *
 * The signature delegates to {@link computeUniqueKey} — the SAME key the store
 * enforces uniqueness with — so a blocking bucket co-buckets EXACTLY the values
 * the commit-time uniqueness check treats as equal. Hand-rolling a separate
 * canonical encoding here drifted from enforcement: it distinguished the number
 * `1` from the string `"1"` (which `computeUniqueKey` collapses, so the merge
 * aborted with a `UniquenessError`) and key-sorted object values (which
 * `computeUniqueKey` does not, so distinct rows were silently over-merged).
 */
function constraintSignature(
  node: Node<NodeType>,
  constraint: UniqueIntrospection,
): string | undefined {
  const props = node as unknown as Record<string, unknown>;
  for (const field of constraint.fields) {
    const value = props[field];
    if (value === undefined || value === null) {
      return undefined;
    }
  }
  return `${constraint.name}${KEY_PART_SEPARATOR}${computeUniqueKey(
    props,
    constraint.fields,
    constraint.collation,
  )}`;
}

/**
 * Computes the SET of bucket keys a node belongs to: its `block()` key bucket (if
 * `block()` returned a key) PLUS one bucket per unique constraint the node fully
 * satisfies. Because a shared unique value gets its OWN bucket — never intersected
 * with the block key or other constraints — two nodes sharing it always co-bucket.
 * Returns `[UNBLOCKED_BUCKET_KEY]` when the node produces no key at all.
 *
 * Each unique signature already embeds its constraint name, so distinct constraints
 * yield distinct keys; the `b`/`u` prefixes keep block and unique keyspaces
 * disjoint. No constraint ordering is needed — each is an independent bucket.
 */
function bucketKeysFor(
  node: Node<NodeType>,
  block: ResolveConfig["block"],
  constraints: readonly UniqueIntrospection[],
): readonly string[] {
  const keys: string[] = [];

  const blockKey = block?.(node);
  if (blockKey !== undefined) {
    keys.push(`${BLOCK_KEY_PREFIX}${KEY_PART_SEPARATOR}${blockKey}`);
  }

  for (const constraint of constraints) {
    const signature = constraintSignature(node, constraint);
    if (signature !== undefined) {
      keys.push(`${UNIQUE_KEY_PREFIX}${KEY_PART_SEPARATOR}${signature}`);
    }
  }

  return keys.length === 0 ? [UNBLOCKED_BUCKET_KEY] : keys;
}

/**
 * Buckets a kind's NEW nodes by their blocking key(s). A node may land in MORE
 * THAN ONE bucket — its `block()` bucket plus a bucket for each unique constraint
 * it satisfies — so two nodes sharing any blocking key co-bucket and are compared.
 *
 * @param newNodes The kind's new (fork-introduced) nodes. All nodes SHOULD be of
 *   one kind; the caller invokes `blockNodes` once per resolved kind.
 * @param resolveConfig The kind's resolution config; its optional `block`
 *   function supplies the application blocking key.
 * @param uniqueConstraints The kind's `unique` constraints from
 *   `store.introspect().kinds[k].unique`. Pass an empty array when blocking
 *   should rely on `block()` alone.
 * @returns A map from bucket key → that bucket's nodes. Iteration order of the
 *   returned map is the lexicographic order of bucket keys, and each bucket's
 *   node list is sorted by `node.id`, so the result is a pure, order-independent
 *   function of the input node SET. A node may appear in several buckets;
 *   candidate-gen dedups pairs so each is scored once.
 */
export function blockNodes<K extends NodeType>(
  newNodes: readonly Node<K>[],
  resolveConfig: Pick<ResolveConfig, "block">,
  uniqueConstraints: readonly UniqueIntrospection[] = [],
): Map<string, Node<K>[]> {
  const buckets = new Map<string, Node<K>[]>();

  for (const node of newNodes) {
    for (const key of bucketKeysFor(
      node,
      resolveConfig.block,
      uniqueConstraints,
    )) {
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, [node]);
      } else {
        bucket.push(node);
      }
    }
  }

  const sortedKeys = [...buckets.keys()].sort((left, right) =>
    compareStrings(left, right),
  );
  const ordered = new Map<string, Node<K>[]>();
  for (const key of sortedKeys) {
    const members = [...requireDefined(buckets.get(key))].sort((left, right) =>
      compareStrings(left.id, right.id),
    );
    ordered.set(key, members);
  }
  return ordered;
}
