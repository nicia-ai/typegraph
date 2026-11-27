/**
 * The node a graph-merge user callback receives.
 *
 * Graph merge works on props in their stored form — the JSON its wire
 * documents, conflict values and fingerprints carry — so a staged node, and a
 * committed node it read back (`storedFormOfReadProps`), holds a `z.date()`
 * property as its stored text. A user callback typed over `Node<K>` (a
 * kind's `block()` key and a `custom` similarity `score()`) is a read,
 * though: it receives the node exactly as every other read returns it, with
 * each position whose schema output is a `Date` decoded by the store's one
 * read owner. The merge's own keys and texts are still computed from the
 * stored form, so they are unchanged.
 */
import {
  type Node,
  type NodeType,
  storedFormOfReadProps,
  type StoredPropsReader,
} from "./typegraph-internal";

const NODE_STRUCTURAL_KEYS: ReadonlySet<string> = new Set([
  "id",
  "kind",
  "meta",
]);

/** `node` as a callback receives it: its props decoded for its kind by `reader`. */
export function callbackNode<K extends NodeType>(
  node: Node<K>,
  reader: StoredPropsReader,
): Node<K> {
  const props = Object.fromEntries(
    Object.entries(node).filter(([key]) => !NODE_STRUCTURAL_KEYS.has(key)),
  );
  const decoded = reader(node.kind, props);
  // The spread defines own data properties, so a `__proto__` prop stays a
  // property, and the structural keys keep their values.
  return decoded === props ? node : { ...node, ...decoded };
}

/**
 * A committed node graph merge read through the public read surface, back in
 * the stored form the merge works on ({@link callbackNode}'s inverse): every
 * decoded `Date` replaced by the stored text it was read from.
 */
export function storedFormNode<K extends NodeType>(node: Node<K>): Node<K> {
  const props = Object.fromEntries(
    Object.entries(node).filter(([key]) => !NODE_STRUCTURAL_KEYS.has(key)),
  );
  const stored = storedFormOfReadProps(props);
  return stored === props ? node : { ...node, ...stored };
}
