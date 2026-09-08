/**
 * The uniqueness claim axis is DETERMINISTIC over a hierarchy (I9).
 *
 * A `kindWithSubClasses` claim fences by colliding on one row, which only works
 * if every kind the scope covers computes the SAME axis. That is a property of
 * the fold, not of any one hierarchy shape, so it is checked over random
 * subclass DAGs — multi-root and multiple-inheritance shapes included, because
 * those are exactly where the older "walk one root's descendants" answer stops
 * being kind-independent.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getKindsForUniquenessCheck } from "../../src/constraints";
import { defineNode } from "../../src/core/node";
import { type NodeType } from "../../src/core/types";
import { core } from "../../src/ontology/core-meta-edges";
import { type OntologyRelation } from "../../src/ontology/types";
import {
  computeClosuresFromOntology,
  KindRegistry,
} from "../../src/registry/kind-registry";
import { uniquenessClaimAxis } from "../../src/store/claims/axis";

const nodeTypeCache = new Map<string, NodeType>();

function kindType(name: string): NodeType {
  const cached = nodeTypeCache.get(name);
  if (cached !== undefined) return cached;
  const created = defineNode(name, { schema: z.object({}) });
  nodeTypeCache.set(name, created);
  return created;
}

function subClassRegistry(
  edges: readonly (readonly [string, string])[],
): KindRegistry {
  return mixedRegistry(edges, []);
}

/**
 * Builds a registry from a mix of `subClassOf` and `equivalentTo` relations —
 * D1 folds both into the SAME subsumption closure, so the axis determinism
 * property must hold whether a component is connected by subclassing,
 * equivalence, or both.
 */
function mixedRegistry(
  subClassEdges: readonly (readonly [string, string])[],
  equivalenceEdges: readonly (readonly [string, string])[],
): KindRegistry {
  const relations: OntologyRelation[] = [
    ...subClassEdges.map(([child, parent]): OntologyRelation => ({
      metaEdge: core.subClassOfMetaEdge,
      from: kindType(child),
      to: kindType(parent),
    })),
    ...equivalenceEdges.map(([left, right]): OntologyRelation => ({
      metaEdge: core.equivalentToMetaEdge,
      from: kindType(left),
      to: kindType(right),
    })),
  ];
  return new KindRegistry(
    new Map(),
    new Map(),
    computeClosuresFromOntology(relations),
  );
}

/** Kind names an edge may connect; short so collisions (and DAGs) are frequent. */
const KIND_NAMES = [
  "Alpha",
  "Beta",
  "Delta",
  "Employee",
  "Contractor",
  "Worker",
  "Zeta",
] as const;

/**
 * Random acyclic subclass edges: a child may only subclass a kind LATER in the
 * fixed name order, which makes cycles unrepresentable while still admitting
 * several roots and several parents per kind.
 */
const subClassEdgesArb = fc
  .uniqueArray(
    fc
      .tuple(
        fc.integer({ min: 0, max: KIND_NAMES.length - 2 }),
        fc.integer({ min: 1, max: KIND_NAMES.length - 1 }),
      )
      .filter(([child, parent]) => child < parent),
    { maxLength: 8 },
  )
  .map((pairs) =>
    pairs.map(
      ([child, parent]) =>
        [KIND_NAMES[child] as string, KIND_NAMES[parent] as string] as const,
    ),
  );

/**
 * Random unordered `equivalentTo` edges over the same kind names. No
 * acyclicity constraint is needed — equivalence is symmetric/transitive by
 * construction, so any pair set is coherent.
 */
const equivalenceEdgesArb = fc
  .uniqueArray(
    fc
      .tuple(
        fc.integer({ min: 0, max: KIND_NAMES.length - 2 }),
        fc.integer({ min: 1, max: KIND_NAMES.length - 1 }),
      )
      .filter(([left, right]) => left < right),
    { maxLength: 8 },
  )
  .map((pairs) =>
    pairs.map(
      ([left, right]) =>
        [KIND_NAMES[left] as string, KIND_NAMES[right] as string] as const,
    ),
  );

/**
 * Every kind reachable from `kind` through subclass edges OR equivalence
 * edges, in either direction — the same "one connected component, one axis"
 * property must hold regardless of which meta-edge joined two kinds, since
 * the registry folds both into one subsumption closure (D1).
 */
function connectedKinds(
  kind: string,
  subClassEdges: readonly (readonly [string, string])[],
  equivalenceEdges: readonly (readonly [string, string])[] = [],
): readonly string[] {
  const members = new Set<string>([kind]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of subClassEdges) {
      if (members.has(child) && !members.has(parent)) {
        members.add(parent);
        grew = true;
      }
      if (members.has(parent) && !members.has(child)) {
        members.add(child);
        grew = true;
      }
    }
    for (const [left, right] of equivalenceEdges) {
      if (members.has(left) && !members.has(right)) {
        members.add(right);
        grew = true;
      }
      if (members.has(right) && !members.has(left)) {
        members.add(left);
        grew = true;
      }
    }
  }
  return [...members];
}

describe("uniqueness claim axis determinism", () => {
  it("gives every kind in a connected component the same axis", () => {
    fc.assert(
      fc.property(
        subClassEdgesArb,
        equivalenceEdgesArb,
        (edges, equivEdges) => {
          const registry = mixedRegistry(edges, equivEdges);
          for (const kind of KIND_NAMES) {
            const axis = uniquenessClaimAxis(
              kind,
              "kindWithSubClasses",
              registry,
            );
            for (const member of connectedKinds(kind, edges, equivEdges)) {
              expect(
                uniquenessClaimAxis(member, "kindWithSubClasses", registry),
              ).toBe(axis);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("never fences narrower than the probe reads", () => {
    // The claim would be decorative if a kind the probe checks could hold the
    // key at an axis this kind never visits, so the probe's set must be inside
    // the component the axis is folded from.
    fc.assert(
      fc.property(
        subClassEdgesArb,
        equivalenceEdgesArb,
        (edges, equivEdges) => {
          const registry = mixedRegistry(edges, equivEdges);
          for (const kind of KIND_NAMES) {
            const component = new Set(connectedKinds(kind, edges, equivEdges));
            for (const probed of getKindsForUniquenessCheck(
              kind,
              "kindWithSubClasses",
              registry,
            )) {
              expect(component.has(probed)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("keeps a multi-root hierarchy on one axis where a root walk does not", () => {
    // The ✎C4 counterexample, pinned as a unit case so the property failure is
    // legible: Employee has two roots (Alpha, Zeta) and Contractor has one, so
    // "the root's descendants" answers differently depending on who asks.
    const registry = subClassRegistry([
      ["Employee", "Alpha"],
      ["Employee", "Zeta"],
      ["Contractor", "Zeta"],
    ]);

    const employeeProbe = getKindsForUniquenessCheck(
      "Employee",
      "kindWithSubClasses",
      registry,
    );
    const contractorProbe = getKindsForUniquenessCheck(
      "Contractor",
      "kindWithSubClasses",
      registry,
    );
    expect([...employeeProbe].toSorted()).not.toEqual(
      [...contractorProbe].toSorted(),
    );

    expect(
      uniquenessClaimAxis("Employee", "kindWithSubClasses", registry),
    ).toBe("Alpha");
    expect(
      uniquenessClaimAxis("Contractor", "kindWithSubClasses", registry),
    ).toBe("Alpha");
  });

  it("leaves a kind-scoped claim on the kind itself", () => {
    const registry = subClassRegistry([["Employee", "Worker"]]);
    expect(uniquenessClaimAxis("Employee", "kind", registry)).toBe("Employee");
  });
});
