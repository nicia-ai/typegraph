/**
 * Ontology subclass-closure glue over TypeGraph's PUBLIC closure utilities.
 *
 * TypeGraph 0.29.0 exports `computeTransitiveClosure` / `invertClosure` /
 * `isReachable` from the package root, and `store.introspect().ontology` exposes
 * the declared meta-edges as `{ metaEdge, from, to, origin }` records. This
 * module is therefore THIN GLUE: it projects the introspected ontology onto the
 * `[child, parent]` relation pairs the public closure builder expects, folds in
 * `equivalentTo` equivalence classes, and exposes the {@link isReachable}
 * accessor reconcileTypes (T10) consumes. There is deliberately NO local Warshall
 * reimplementation — the transitive work is done entirely by the public
 * `computeTransitiveClosure`.
 *
 * Direction convention (verified against `store.introspect()` at runtime):
 * `subClassOf(Child, Parent)` introspects as `{ metaEdge: "subClassOf",
 * from: "Child", to: "Parent" }`. So `from` is the more-specific (child) type
 * and `to` is the more-general (parent) type, matching the `[child, parent]`
 * relation pairs `computeTransitiveClosure` consumes, where `isReachable(closure,
 * child, ancestor)` answers "is `child` a (transitive) subclass of `ancestor`?".
 */
import type { OntologyIntrospection } from "./typegraph-internal";
import {
  computeTransitiveClosure,
  isReachable as isReachablePublic,
} from "./typegraph-internal";

/**
 * The meta-edge name identifying a subclass relation in `introspect().ontology`.
 */
export const SUB_CLASS_OF_META_EDGE = "subClassOf";

/**
 * The meta-edge name identifying an equivalence relation in
 * `introspect().ontology`. `equivalentTo` edges are folded into symmetric
 * equivalence classes so that equivalent types share each other's ancestors and
 * descendants.
 */
export const EQUIVALENT_TO_META_EDGE = "equivalentTo";

/**
 * An immutable subclass closure plus the equivalence-class canonicalization used
 * to fold `equivalentTo` relations.
 *
 * - `closure` maps each (canonicalized) child type to the set of all its
 *   (canonicalized) transitive ancestors, as produced by the public
 *   `computeTransitiveClosure`.
 * - `canonicalOf` maps every type seen in the ontology to its equivalence-class
 *   representative (the lexicographically-smallest member). Types not involved
 *   in any `equivalentTo` relation map to themselves.
 */
export type SubClassClosure = Readonly<{
  closure: ReadonlyMap<string, ReadonlySet<string>>;
  canonicalOf: ReadonlyMap<string, string>;
}>;

/**
 * Disjoint-set forest over type names, used to fold `equivalentTo` relations
 * into equivalence classes. Path-halving find keeps the structure flat; union by
 * lexicographically-smaller representative makes the chosen canonical
 * deterministic and independent of relation insertion order.
 */
type UnionFind = Readonly<{
  parent: Map<string, string>;
}>;

function makeUnionFind(): UnionFind {
  return { parent: new Map<string, string>() };
}

function ensure(unionFind: UnionFind, value: string): void {
  if (!unionFind.parent.has(value)) {
    unionFind.parent.set(value, value);
  }
}

function find(unionFind: UnionFind, value: string): string {
  ensure(unionFind, value);
  let root = value;
  while (unionFind.parent.get(root) !== root) {
    const grandparent = unionFind.parent.get(
      unionFind.parent.get(root)!,
    )!;
    unionFind.parent.set(root, grandparent);
    root = grandparent;
  }
  return root;
}

function union(unionFind: UnionFind, left: string, right: string): void {
  const leftRoot = find(unionFind, left);
  const rightRoot = find(unionFind, right);
  if (leftRoot === rightRoot) {
    return;
  }
  // Deterministic representative: the lexicographically-smaller root, so the
  // chosen canonical does not depend on relation ordering.
  const [winner, loser] =
    leftRoot < rightRoot ? [leftRoot, rightRoot] : [rightRoot, leftRoot];
  unionFind.parent.set(loser, winner);
}

/**
 * Builds the subclass closure from an introspected ontology.
 *
 * Steps:
 *   1. Fold every `equivalentTo` relation into a union-find so equivalent types
 *      collapse to a single deterministic representative.
 *   2. Project every `subClassOf` relation onto a `[childRep, parentRep]` pair
 *      (each endpoint canonicalized to its equivalence representative). Self
 *      loops introduced by equivalence are dropped — a type is never its own
 *      strict subclass.
 *   3. Hand the relation pairs to the PUBLIC `computeTransitiveClosure`. No local
 *      transitive-closure logic exists here.
 *
 * @param ontology The `store.introspect().ontology` array.
 * @returns A `SubClassClosure` queryable via `isReachable` (which canonicalizes
 *   its inputs through the equivalence map).
 */
export function buildSubClassClosure(
  ontology: readonly OntologyIntrospection[],
): SubClassClosure {
  const unionFind = makeUnionFind();

  for (const relation of ontology) {
    ensure(unionFind, relation.from);
    ensure(unionFind, relation.to);
    if (relation.metaEdge === EQUIVALENT_TO_META_EDGE) {
      union(unionFind, relation.from, relation.to);
    }
  }

  const canonicalOf = new Map<string, string>();
  for (const value of unionFind.parent.keys()) {
    canonicalOf.set(value, find(unionFind, value));
  }

  const relationKeys = new Set<string>();
  const relations: (readonly [string, string])[] = [];
  for (const relation of ontology) {
    if (relation.metaEdge !== SUB_CLASS_OF_META_EDGE) {
      continue;
    }
    const child = canonicalOf.get(relation.from) ?? relation.from;
    const parent = canonicalOf.get(relation.to) ?? relation.to;
    if (child === parent) {
      continue;
    }
    const key = `${child}\0${parent}`;
    if (relationKeys.has(key)) {
      continue;
    }
    relationKeys.add(key);
    relations.push([child, parent]);
  }

  return {
    closure: computeTransitiveClosure(relations),
    canonicalOf,
  };
}

/**
 * Resolves a type name to its equivalence-class representative, falling back to
 * the name itself when the type was never seen in the ontology.
 */
function canonicalType(closure: SubClassClosure, type: string): string {
  return closure.canonicalOf.get(type) ?? type;
}

/**
 * Reports whether `from` is a (transitive) subclass of `to`.
 *
 * Both arguments are canonicalized through the equivalence map first, then the
 * PUBLIC `isReachable` is consulted. Equivalent-but-distinct types (e.g.
 * `equivalentTo(Physician, Doctor)`) are treated as mutually reachable. A type
 * is NOT considered a subclass of itself (the relation is strict / irreflexive),
 * matching the public closure's non-reflexive semantics.
 *
 * @param closure The closure produced by `buildSubClassClosure`.
 * @param from The candidate descendant (more-specific) type.
 * @param to The candidate ancestor (more-general) type.
 */
export function isReachable(
  closure: SubClassClosure,
  from: string,
  to: string,
): boolean {
  const fromRep = canonicalType(closure, from);
  const toRep = canonicalType(closure, to);
  if (fromRep === toRep) {
    // Distinct names that fold to the same equivalence class are mutually
    // reachable; identical names are NOT (strict subclass relation).
    return from !== to;
  }
  return isReachablePublic(closure.closure, fromRep, toRep);
}
