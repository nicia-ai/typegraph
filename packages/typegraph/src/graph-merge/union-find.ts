import { requireDefined } from "../utils/presence";
/**
 * A deterministic disjoint-set forest (union-find), shared by every merge phase
 * that folds a set of items into equivalence classes — ontology equivalence
 * (`closures.ts`), candidate clustering (`clustering.ts`), and cross-kind identity
 * grouping (`sources.ts`).
 *
 * Determinism is the load-bearing property: path compression keeps `find` flat,
 * and the union rule makes the chosen representative a pure function of the union
 * SET, not the union order — the item that compares LEAST (by the `compare`
 * supplied at construction) always becomes the root. Two runs that union the same
 * pairs in any order therefore produce identical roots, which is what lets the
 * merge's partitions be order-independent. Callers that only need the partition
 * (and re-sort each group) may pass any total order; callers that expose the
 * representative (e.g. an equivalence-class canonical) pass the comparator whose
 * minimum they want as the representative.
 */
export class UnionFind<T> {
  private readonly parent = new Map<T, T>();

  constructor(private readonly compare: (left: T, right: T) => number) {}

  /** Adds `value` as its own singleton set if it is not already present. */
  add(value: T): void {
    if (!this.parent.has(value)) {
      this.parent.set(value, value);
    }
  }

  /** Returns the representative of `value`'s set, compressing the path to it. */
  find(value: T): T {
    this.add(value);
    let root = value;
    while (this.parent.get(root) !== root) {
      root = requireDefined(this.parent.get(root));
    }
    // Path compression: point every node on the walk straight at the root.
    let cursor = value;
    while (cursor !== root) {
      const next = requireDefined(this.parent.get(cursor));
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  /** Merges the sets of `left` and `right`; the `compare`-minimal root wins. */
  union(left: T, right: T): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) {
      return;
    }
    if (this.compare(leftRoot, rightRoot) <= 0) {
      this.parent.set(rightRoot, leftRoot);
    } else {
      this.parent.set(leftRoot, rightRoot);
    }
  }

  /** Every value seen by {@link add}/{@link find}/{@link union}, insertion order. */
  members(): readonly T[] {
    return [...this.parent.keys()];
  }
}
