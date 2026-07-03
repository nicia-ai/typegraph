/**
 * The composite MERGE IDENTITY key for a node: the pair `(kind, id)`.
 *
 * TypeGraph node identity is the PAIR `(kind, id)` — a bare id string is NOT unique
 * on its own (a `Patient` and an `Encounter` may both carry the id "x" as two
 * DISTINCT committed nodes; ids are caller-supplied). Every place the merge pipeline
 * groups, clusters, de-dupes, repoints, retypes, or deletes BY NODE IDENTITY must
 * key on this pair — never the bare id — or two different-kind nodes that happen to
 * share an id string silently fuse into one cluster (wrong merge, dropped node,
 * incoherent commit) and the §6.4-A base guard is bypassed.
 *
 * Represented as a NUL-joined string (a branded {@link MergeKey}) so it doubles as a
 * `Map`/`Set` key and a deterministic ordering key. `kind` is a schema identifier
 * (NUL-free), so the FIRST NUL unambiguously delimits kind from id even when a
 * caller-supplied id itself contains a NUL byte. This matches the `(kind, id)`
 * separator the commit-time write guard already uses.
 *
 * {@link compareMergeKeys} orders by the bare id FIRST (kind only breaks a same-id
 * tie), so the merge's "minimum-id survivor" / id-sorted-members semantics are
 * preserved unchanged for the common single-kind cluster — the composite key changes
 * WHICH nodes share an identity, never the ordering among genuinely distinct ids.
 */

import type { NodeId, NodeType } from "./typegraph-internal";

/** The `(kind, id)` separator: a NUL byte (0x00), absent from schema kind names. */
const SEPARATOR = String.fromCharCode(0);

/** A node id in its untyped (`NodeType`-default) branded form. */
type AnyNodeId = NodeId<NodeType>;

/**
 * A composite `(kind, id)` node-identity key. Branded so it cannot be confused with
 * a bare {@link NodeId} at the type level — the whole point is that the two are NOT
 * interchangeable as identities.
 */
export type MergeKey = string & { readonly __mergeKey: unique symbol };

/** Builds the composite identity key for a `(kind, id)` pair. */
export function mergeKey(kind: string, id: string): MergeKey {
  // `kindOf`/`idOf` split on the FIRST NUL, so a NUL in `kind` would alias distinct
  // identities (`mergeKey("a\0b","c") === mergeKey("a","b\0c")`), silently fusing
  // unrelated nodes into one cluster and bypassing the §6.4-A base guard this composite
  // key exists to protect. Kinds are NUL-free schema identifiers; fail loud if not.
  if (kind.includes(SEPARATOR)) {
    throw new Error(
      `Node kind ${JSON.stringify(kind)} contains a NUL byte, which collides the (kind, id) merge-identity separator.`,
    );
  }
  return `${kind}${SEPARATOR}${id}` as MergeKey;
}

/** Builds the composite identity key for any object carrying a `kind` and `id`. */
export function mergeKeyOf(
  node: Readonly<{ kind: string; id: string }>,
): MergeKey {
  return mergeKey(node.kind, node.id);
}

/** The kind component of a {@link MergeKey}. */
export function kindOf(key: MergeKey): string {
  const separator = key.indexOf(SEPARATOR);
  return separator === -1 ? key : key.slice(0, separator);
}

/** The bare node id component of a {@link MergeKey}. */
export function idOf(key: MergeKey): AnyNodeId {
  const separator = key.indexOf(SEPARATOR);
  return (separator === -1 ? key : key.slice(separator + 1)) as AnyNodeId;
}

/**
 * Deterministic comparator over two merge keys, BARE ID first and kind only as a
 * same-id tie-break. This keeps the merge's minimum-id survivor selection and
 * id-sorted member order identical to the pre-composite behaviour for any pair of
 * genuinely distinct ids (the overwhelmingly common case), so the re-key changes
 * identity grouping without perturbing deterministic ordering.
 */
export function compareMergeKeys(left: MergeKey, right: MergeKey): number {
  const leftId = idOf(left);
  const rightId = idOf(right);
  if (leftId !== rightId) {
    return leftId < rightId ? -1 : 1;
  }
  const leftKind = kindOf(left);
  const rightKind = kindOf(right);
  return (
    leftKind < rightKind ? -1
    : leftKind > rightKind ? 1
    : 0
  );
}

export { compareStrings } from "../utils/compare";
