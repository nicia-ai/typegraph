/**
 * The edge-cardinality half of schema-tightening classification: which axes a
 * proposed schema newly constrains, i.e. those whose existing rows a commit
 * owes a data check.
 *
 * Deliberately its own module, parallel to `ontology-change.ts` rather than
 * folded into it: an ontology change is a statement about RELATIONS between
 * kinds, while a cardinality change is a per-edge-kind declaration with no
 * relation vocabulary of its own — folding it into `OntologyChange` would
 * force every ontology-only consumer (`classifyOntologyChanges`,
 * `computeSchemaDiff`'s ontology bucket) to grow a case they cannot act on.
 */
import type { EdgeCardinalityDeclaration } from "../backend/types";
import { edgeCardinalityAxisReferences } from "../store/claims/edge-claims";
import type { OntologySnapshot } from "./ontology-change";

/**
 * THE axes a schema commit newly constrains, i.e. those whose existing rows
 * this commit owes a data check.
 *
 * An axis is probed whenever the proposed value is a constrained one and
 * differs from the stored value. Deliberately coarser than an implication
 * lattice over the cardinalities: probing a genuine loosening (`one` →
 * `oneActive`) costs one read of a population that is already clean, while
 * missing a tightening publishes a constraint the data violates. The cheap
 * error is the one this takes.
 *
 * A stored declaration this proposal does not carry (a brand-new edge kind)
 * reads as `"many"` on both axes — the same default an old schema loads as —
 * so a newly-declared constrained kind is always probed, even though it can
 * have no violating rows yet: the read is cheap and the alternative is a
 * special case that could drift.
 */
export function newlyConstrainedEdgeAxes(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly EdgeCardinalityDeclaration[] {
  const result: EdgeCardinalityDeclaration[] = [];
  for (const [edgeKind, afterDef] of Object.entries(after.edges)) {
    const beforeDef = before.edges[edgeKind];
    const declarations = {
      cardinality: afterDef.cardinality,
      targetCardinality: afterDef.targetCardinality,
    };
    for (const ref of edgeCardinalityAxisReferences(declarations)) {
      const storedCardinality =
        ref.direction === "source" ?
          (beforeDef?.cardinality ?? "many")
        : (beforeDef?.targetCardinality ?? "many");
      if (storedCardinality !== ref.cardinality) {
        result.push({ ...ref, edgeKind });
      }
    }
  }
  return result;
}

export { type EdgeCardinalityDeclaration } from "../backend/types";
