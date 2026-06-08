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
import { compareStrings } from "./node-key";
import type { OntologyIntrospection } from "./typegraph-internal";
import {
  computeTransitiveClosure,
  isReachable as isReachablePublic,
} from "./typegraph-internal";
import { UnionFind } from "./union-find";

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
const EQUIVALENT_TO_META_EDGE = "equivalentTo";

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
  // Union by lexicographically-smaller representative, so each equivalence class's
  // canonical is its lex-min member, independent of relation insertion order.
  const unionFind = new UnionFind<string>(compareStrings);

  for (const relation of ontology) {
    unionFind.add(relation.from);
    unionFind.add(relation.to);
    if (relation.metaEdge === EQUIVALENT_TO_META_EDGE) {
      unionFind.union(relation.from, relation.to);
    }
  }

  const canonicalOf = new Map<string, string>();
  for (const value of unionFind.members()) {
    canonicalOf.set(value, unionFind.find(value));
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
