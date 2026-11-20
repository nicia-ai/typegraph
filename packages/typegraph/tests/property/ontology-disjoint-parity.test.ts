/**
 * Pins the relationship "load-time validation catches every disjointness
 * contradiction the registry can materialize at runtime".
 *
 * These are two consumers of one expansion path, and they drifted once
 * already: validation used to propagate over the *declared* relations while
 * the registry expands over *precomputed closures*, which closed equivalence
 * classes through external IRIs. An ontology could then load clean and still
 * leave the registry holding `A ≡ B` and `A | B` simultaneously. Randomized
 * ontologies over a kind pool that mixes local names with IRI-shaped names
 * are the cheapest way to keep that drift from reappearing.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type NamedOntologyRelation,
  type OntologyValidationIssue,
  validateOntologyRelations,
} from "../../src/ontology/validation";
import {
  computeClosuresFromNamedOntology,
  computeDisjointExpansionClosures,
  expandDisjointSide,
} from "../../src/registry/kind-registry";
import { requireDefined } from "../../src/utils/presence";

const DISJOINT_PAIR_SEPARATOR = "|";
const META_EDGE_DISJOINT_WITH = "disjointWith";
const DISJOINT_CONFLICT_CODE = "ONTOLOGY_DISJOINT_CONFLICT";

/**
 * Issues that make an ontology structurally invalid on their own. Such an
 * ontology is rejected before anyone can observe its closures, so the parity
 * invariant says nothing about it.
 */
const STRUCTURAL_ISSUE_CODES: ReadonlySet<string> = new Set([
  "ONTOLOGY_CYCLE",
  "ONTOLOGY_SELF_LOOP",
  "DUPLICATE_ONTOLOGY_RELATION",
]);

const kindArb = fc.constantFrom(
  "Alpha",
  "Beta",
  "Gamma",
  "Delta",
  "http://ex.org/A",
  "http://ex.org/B",
);

const relationArb: fc.Arbitrary<NamedOntologyRelation> = fc.record({
  metaEdge: fc.constantFrom(
    "subClassOf",
    "equivalentTo",
    "sameAs",
    META_EDGE_DISJOINT_WITH,
  ),
  from: kindArb,
  to: kindArb,
});

const ontologyArb = fc.array(relationArb, { maxLength: 8 });

function hasIssueCode(
  issues: readonly OntologyValidationIssue[],
  code: string,
): boolean {
  return issues.some((issue) => issue.code === code);
}

function isStructurallyInvalid(
  issues: readonly OntologyValidationIssue[],
): boolean {
  return issues.some((issue) => STRUCTURAL_ISSUE_CODES.has(issue.code));
}

describe("disjointness validation covers runtime disjointness", () => {
  it("never lets an accepted ontology hold two kinds as equivalent and disjoint at once", () => {
    fc.assert(
      fc.property(ontologyArb, (ontology) => {
        const issues = validateOntologyRelations(ontology);
        fc.pre(!isStructurallyInvalid(issues));
        fc.pre(!hasIssueCode(issues, DISJOINT_CONFLICT_CODE));

        const { disjointPairs, equivalenceSets } =
          computeClosuresFromNamedOntology(ontology);

        for (const pair of disjointPairs) {
          const members = pair.split(DISJOINT_PAIR_SEPARATOR);
          const left = requireDefined(members[0]);
          const right = requireDefined(members[1]);

          expect(left).not.toBe(right);
          expect(equivalenceSets.get(left)?.has(right) ?? false).toBe(false);
          expect(equivalenceSets.get(right)?.has(left) ?? false).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("keeps the expanded sides of every accepted disjoint declaration apart", () => {
    fc.assert(
      fc.property(ontologyArb, (ontology) => {
        const issues = validateOntologyRelations(ontology);
        fc.pre(!isStructurallyInvalid(issues));
        fc.pre(!hasIssueCode(issues, DISJOINT_CONFLICT_CODE));

        // An overlap here is precisely what `computeDisjointPairs` swallows
        // through its `left === right` self-pair guard: no runtime error, just
        // a disjointness declaration quietly reduced to nothing.
        const closures = computeDisjointExpansionClosures(ontology);
        for (const relation of ontology) {
          if (relation.metaEdge !== META_EDGE_DISJOINT_WITH) continue;
          if (relation.from === relation.to) continue;

          const left = expandDisjointSide(relation.from, closures);
          const right = new Set(expandDisjointSide(relation.to, closures));
          expect(left.filter((kind) => right.has(kind))).toEqual([]);
        }
      }),
      { numRuns: 500 },
    );
  });
});
