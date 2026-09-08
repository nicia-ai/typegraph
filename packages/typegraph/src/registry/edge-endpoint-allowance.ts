/**
 * THE concrete `(from, to)` pairs an edge kind's declaration admits, after
 * subsumption.
 *
 * One owner, called by the graph-side fence declarations
 * (`src/store/claims/verify.ts`) and by the serialized-schema-side ontology
 * tightening probe (`src/schema/ontology-change.ts`), so the audit and the
 * probe can never disagree about what a declaration allows.
 */
import type { EdgeEndpointAllowance } from "../backend/types";
import { compareStrings } from "../utils/compare";
import type { EdgeKindFacts } from "./edge-kind-facts";
import type { KindRegistry } from "./kind-registry";

/**
 * `facts.pairs` is the source when present (it already resolves a
 * source-dependent target map); otherwise the Cartesian `from × to`. Each
 * side is expanded with `registry.expandSubClasses`, which is the same
 * expansion `registry.isAssignableTo` answers with — a kind is assignable to
 * a declared endpoint exactly when it is that endpoint or one of its
 * `expandSubClasses` descendants.
 *
 * Deduped and sorted by `compareStrings(from) || compareStrings(to)` so two
 * runs produce one shape.
 */
export function expandEdgeEndpointAllowance(
  edgeKind: string,
  facts: EdgeKindFacts,
  registry: KindRegistry,
): EdgeEndpointAllowance {
  const declaredPairs: readonly (readonly [string, string])[] =
    facts.pairs === undefined ?
      facts.from.flatMap((from) => facts.to.map((to) => [from, to] as const))
    : facts.pairs.map((pair) => [pair.from, pair.to] as const);

  const seen = new Set<string>();
  const allowedPairs: (readonly [string, string])[] = [];
  for (const [declaredFrom, declaredTo] of declaredPairs) {
    for (const concreteFrom of registry.expandSubClasses(declaredFrom)) {
      for (const concreteTo of registry.expandSubClasses(declaredTo)) {
        const key = `${concreteFrom}\0${concreteTo}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allowedPairs.push([concreteFrom, concreteTo]);
      }
    }
  }

  allowedPairs.sort(
    (left, right) =>
      compareStrings(left[0], right[0]) || compareStrings(left[1], right[1]),
  );

  return { edgeKind, allowedPairs };
}
