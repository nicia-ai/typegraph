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
import { encodeTupleKey } from "../utils/tuple-key";
import type { EdgeKindFacts } from "./edge-kind-facts";
import type { KindRegistry } from "./kind-registry";

/**
 * `facts.pairs` is the source — the one builder that read the declaration
 * already resolved a source-dependent target map or a Cartesian `from × to`
 * into it. Each side is expanded with `registry.expandSubClasses`, which is
 * the same expansion `registry.isAssignableTo` answers with — a kind is
 * assignable to a declared endpoint exactly when it is that endpoint or one
 * of its `expandSubClasses` descendants.
 *
 * Deduped and sorted by `compareStrings(from) || compareStrings(to)` so two
 * runs produce one shape.
 */
export function expandEdgeEndpointAllowance(
  edgeKind: string,
  facts: EdgeKindFacts,
  registry: KindRegistry,
): EdgeEndpointAllowance {
  const seen = new Set<string>();
  const allowedPairs: (readonly [string, string])[] = [];
  for (const { from: declaredFrom, to: declaredTo } of facts.pairs) {
    for (const concreteFrom of registry.expandSubClasses(declaredFrom)) {
      for (const concreteTo of registry.expandSubClasses(declaredTo)) {
        const key = encodeTupleKey([concreteFrom, concreteTo]);
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
