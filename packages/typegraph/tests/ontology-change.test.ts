/**
 * Unit tests for `classifyOntologyChanges` (`src/schema/ontology-change.ts`).
 *
 * Every relation-classification test below is load-bearing: the revert
 * checks are recorded in the scratchpad `lane-A-load-bearing.md` note, per
 * AGENTS.md.
 */
import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/errors";
import {
  classifyOntologyChanges,
  type OntologyDataProbe,
  type OntologySnapshot,
} from "../src/schema/ontology-change";
import {
  type SerializedClosures,
  type SerializedEdgeDef,
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedOntologyRelation,
  type SerializedUniqueConstraint,
} from "../src/schema/types";
import { requireDefined } from "../src/utils/presence";

// ============================================================
// Fixtures
// ============================================================

const EMPTY_CLOSURES: SerializedClosures = {
  subClassAncestors: {},
  subClassDescendants: {},
  broaderClosure: {},
  narrowerClosure: {},
  equivalenceSets: {},
  disjointPairs: [],
  partOfClosure: {},
  hasPartClosure: {},
  iriToKind: {},
  edgeInverses: {},
  edgeImplicationsClosure: {},
  edgeImplyingClosure: {},
};

function nodeDef(
  kind: string,
  uniqueConstraints: readonly SerializedUniqueConstraint[] = [],
): SerializedNodeDef {
  return {
    kind,
    properties: { type: "object", properties: {} },
    uniqueConstraints,
    onDelete: "restrict",
    description: undefined,
  };
}

function edgeDef(
  kind: string,
  fromKinds: readonly string[],
  toKinds: readonly string[],
): SerializedEdgeDef {
  return {
    kind,
    fromKinds,
    toKinds,
    properties: { type: "object", properties: {} },
    cardinality: "many",
    targetCardinality: "many",
    endpointExistence: "notDeleted",
    description: undefined,
  };
}

function ontology(
  relations: readonly SerializedOntologyRelation[],
): SerializedOntology {
  return { metaEdges: {}, relations, closures: EMPTY_CLOSURES };
}

function snapshot(
  nodes: Record<string, SerializedNodeDef>,
  edges: Record<string, SerializedEdgeDef>,
  relations: readonly SerializedOntologyRelation[],
): OntologySnapshot {
  return { nodes, edges, ontology: ontology(relations) };
}

function relation(
  metaEdge: string,
  from: string,
  to: string,
): SerializedOntologyRelation {
  return { metaEdge, from, to };
}

function relationChangeOf(
  changes: ReturnType<typeof classifyOntologyChanges>,
  type: "added" | "removed",
) {
  return requireDefined(
    changes.find(
      (change) => change.entity === "relation" && change.type === type,
    ),
    `expected a ${type} relation change`,
  );
}

function probeOfKind<K extends OntologyDataProbe["kind"]>(
  probes: readonly OntologyDataProbe[] | undefined,
  kind: K,
): Extract<OntologyDataProbe, { kind: K }> {
  const found = (probes ?? []).find(
    (probe): probe is Extract<OntologyDataProbe, { kind: K }> =>
      probe.kind === kind,
  );
  return requireDefined(found, `expected a "${kind}" probe`);
}

/** `implies` only requires same-side assignability, so a same-shape pair is valid. */
const EDGES_FOR_IMPLIES: Record<string, SerializedEdgeDef> = {
  edgeA: edgeDef("edgeA", ["X"], ["Y"]),
  edgeB: edgeDef("edgeB", ["X"], ["Y"]),
};

/** `inverseOf` requires an exact reversal: edgeB's (from, to) is edgeA's (to, from). */
const EDGES_FOR_INVERSE_OF: Record<string, SerializedEdgeDef> = {
  edgeA: edgeDef("edgeA", ["X"], ["Y"]),
  edgeB: edgeDef("edgeB", ["Y"], ["X"]),
};

// ============================================================
// The severity matrix (§1.3)
// ============================================================

type MatrixRow = Readonly<{
  metaEdge: string;
  direction: "added" | "removed";
  from: string;
  to: string;
  edges?: Record<string, SerializedEdgeDef>;
  expectedSeverity: "safe" | "warning" | "breaking";
  expectedProbeKinds: readonly OntologyDataProbe["kind"][];
}>;

const MATRIX: readonly MatrixRow[] = [
  {
    metaEdge: "disjointWith",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["nodeDisjointness"],
  },
  {
    metaEdge: "disjointWith",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "subClassOf",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["nodeUniquenessComponent", "nodeDisjointness"],
  },
  {
    metaEdge: "subClassOf",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["edgeEndpointAssignability"],
  },
  {
    metaEdge: "equivalentTo",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["nodeUniquenessComponent", "nodeDisjointness"],
  },
  {
    metaEdge: "equivalentTo",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["edgeEndpointAssignability"],
  },
  {
    metaEdge: "sameAs",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["nodeUniquenessComponent", "nodeDisjointness"],
  },
  {
    metaEdge: "sameAs",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "warning",
    expectedProbeKinds: ["edgeEndpointAssignability"],
  },
  {
    metaEdge: "inverseOf",
    direction: "added",
    from: "edgeA",
    to: "edgeB",
    edges: EDGES_FOR_INVERSE_OF,
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "inverseOf",
    direction: "removed",
    from: "edgeA",
    to: "edgeB",
    edges: EDGES_FOR_INVERSE_OF,
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "implies",
    direction: "added",
    from: "edgeA",
    to: "edgeB",
    edges: EDGES_FOR_IMPLIES,
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "implies",
    direction: "removed",
    from: "edgeA",
    to: "edgeB",
    edges: EDGES_FOR_IMPLIES,
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "broader",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "broader",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "narrower",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "narrower",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "partOf",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "partOf",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "hasPart",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "hasPart",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "relatedTo",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "relatedTo",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "differentFrom",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "differentFrom",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "aCustomVocabularyRelation",
    direction: "added",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "aCustomVocabularyRelation",
    direction: "removed",
    from: "A",
    to: "B",
    expectedSeverity: "safe",
    expectedProbeKinds: [],
  },
];

describe("classifyOntologyChanges", () => {
  describe("the severity table", () => {
    it.each(MATRIX)("$metaEdge $direction -> $expectedSeverity", (row) => {
      const edges = row.edges ?? {};
      const relationUnderTest = relation(row.metaEdge, row.from, row.to);
      const before = snapshot(
        {},
        edges,
        row.direction === "removed" ? [relationUnderTest] : [],
      );
      const after = snapshot(
        {},
        edges,
        row.direction === "added" ? [relationUnderTest] : [],
      );

      const changes = classifyOntologyChanges(before, after);
      const change = relationChangeOf(changes, row.direction);

      expect(change.severity).toBe(row.expectedSeverity);
      expect((change.probes ?? []).map((probe) => probe.kind)).toEqual(
        row.expectedProbeKinds,
      );
    });

    // MUTATION CHECK (recorded in lane-A-load-bearing.md): flipping the
    // `disjointWith`-added row's severity in
    // `classifyKnownRelationSeverity` to "safe" with no probe makes this
    // exact row of the matrix fail.
  });

  describe("the removed-kind rule", () => {
    it("classifies a removed relation as safe with no probe when this commit also removes one of its kinds", () => {
      const before = snapshot(
        { Company: nodeDef("Company"), Organization: nodeDef("Organization") },
        {},
        [relation("subClassOf", "Company", "Organization")],
      );
      const after = snapshot({ Organization: nodeDef("Organization") }, {}, []);

      const changes = classifyOntologyChanges(before, after);
      const change = relationChangeOf(changes, "removed");

      expect(change.severity).toBe("safe");
      expect(change.probes).toBeUndefined();
    });

    it("classifies the same removal as warning + edgeEndpointAssignability when both kinds survive", () => {
      const before = snapshot(
        { Company: nodeDef("Company"), Organization: nodeDef("Organization") },
        {},
        [relation("subClassOf", "Company", "Organization")],
      );
      const after = snapshot(
        { Company: nodeDef("Company"), Organization: nodeDef("Organization") },
        {},
        [],
      );

      const changes = classifyOntologyChanges(before, after);
      const change = relationChangeOf(changes, "removed");

      expect(change.severity).toBe("warning");
      expect((change.probes ?? []).map((probe) => probe.kind)).toEqual([
        "edgeEndpointAssignability",
      ]);
    });

    // MUTATION CHECK (recorded in lane-A-load-bearing.md): deleting the
    // removed-kind guard in `classifyRelation` makes the first assertion
    // above fail (the removal reads as an ordinary warning instead of safe).
  });

  describe("probe payloads", () => {
    it("computes the propagated nodeDisjointness delta, not just the authored pair", () => {
      const before = snapshot({}, {}, [
        relation("subClassOf", "Company", "Organization"),
      ]);
      const after = snapshot({}, {}, [
        relation("subClassOf", "Company", "Organization"),
        relation("disjointWith", "Person", "Organization"),
      ]);

      const changes = classifyOntologyChanges(before, after);
      const added = changes.find(
        (change) =>
          change.entity === "relation" &&
          change.type === "added" &&
          change.name.startsWith("disjointWith"),
      );
      const probe = probeOfKind(
        requireDefined(added, "expected the added disjointWith relation")
          .probes,
        "nodeDisjointness",
      );

      expect(probe.pairs).toEqual([
        ["Company", "Person"],
        ["Organization", "Person"],
      ]);
    });

    // MUTATION CHECK (recorded in lane-A-load-bearing.md): computing the
    // delta from the authored relations directly (skipping
    // `registry.disjointKindPairs()`'s propagated closure) drops the
    // ["Company", "Person"] pair and fails this assertion.

    it("merges kindWithSubClasses uniqueness components across an added subClassOf", () => {
      const emailUnique: SerializedUniqueConstraint = {
        name: "email_unique",
        fields: ["email"],
        where: undefined,
        scope: "kindWithSubClasses",
        collation: "binary",
      };
      const nodes = {
        Contractor: nodeDef("Contractor", [emailUnique]),
        Worker: nodeDef("Worker", [emailUnique]),
      };
      const before = snapshot(nodes, {}, []);
      const after = snapshot(nodes, {}, [
        relation("subClassOf", "Contractor", "Worker"),
      ]);

      const changes = classifyOntologyChanges(before, after);
      const added = relationChangeOf(changes, "added");
      const probe = probeOfKind(added.probes, "nodeUniquenessComponent");

      expect(probe.groups).toEqual([
        {
          constraintName: "email_unique",
          coveredKinds: ["Contractor", "Worker"],
        },
      ]);
    });

    it("computes the shrunk edge endpoint allowance for a removed subClassOf", () => {
      const worksFor = edgeDef("worksFor", ["Person"], ["Organization"]);
      const before = snapshot({}, { worksFor }, [
        relation("subClassOf", "Company", "Organization"),
      ]);
      const after = snapshot({}, { worksFor }, []);

      const changes = classifyOntologyChanges(before, after);
      const removed = relationChangeOf(changes, "removed");
      const probe = probeOfKind(removed.probes, "edgeEndpointAssignability");

      expect(probe.allowances).toEqual([
        { edgeKind: "worksFor", allowedPairs: [["Person", "Organization"]] },
      ]);
    });

    it("detects a same-size endpoint swap, not just a shrink in pair count", () => {
      // `subClassOf(Company, Organization)` swapped for `subClassOf(Shop,
      // Organization)` in one commit: the allowed-pair COUNT for `worksFor`
      // is unchanged (one subclass pair either way), but `(Person, Company)`
      // is no longer admitted. A count-based "did this shrink?" predicate
      // (`isProperSubset`, which additionally requires the after list to be
      // strictly SHORTER) misses this entirely.
      const worksFor = edgeDef("worksFor", ["Person"], ["Organization"]);
      const before = snapshot({}, { worksFor }, [
        relation("subClassOf", "Company", "Organization"),
      ]);
      const after = snapshot({}, { worksFor }, [
        relation("subClassOf", "Shop", "Organization"),
      ]);

      const changes = classifyOntologyChanges(before, after);
      const removed = relationChangeOf(changes, "removed");
      const probe = probeOfKind(removed.probes, "edgeEndpointAssignability");

      expect(probe.allowances).toEqual([
        {
          edgeKind: "worksFor",
          allowedPairs: [
            ["Person", "Organization"],
            ["Person", "Shop"],
          ],
        },
      ]);
    });
    // MUTATION CHECK (verified): restoring
    // `isProperSubset(afterPairKeys, beforePairKeys)` in place of
    // `lostAnyMember(beforePairKeys, afterPairKeys)`
    // (`edgeEndpointAssignabilityDelta`, `src/schema/ontology-change.ts`)
    // makes `removed.probes` undefined (equal-length before/after pair
    // lists never count as a proper subset) and this assertion fails.
  });

  describe("an incoherent ontology", () => {
    it("propagates ConfigurationError rather than reporting an unresolved probe", () => {
      // `disjointWith(A, B)` plus `subClassOf(A, B)` is a contradiction
      // `validateOntologyRelations` already refuses at store open — the
      // refuse-on-load precedent this module follows (ruling: no
      // "unresolved" probe variant).
      const incoherentRelations = [
        relation("disjointWith", "A", "B"),
        relation("subClassOf", "A", "B"),
      ];
      const before = snapshot({}, {}, incoherentRelations);
      // At least one relation change so a registry build is actually
      // attempted (an unrelated diff never touches the incoherent ontology).
      const after = snapshot({}, {}, [
        ...incoherentRelations,
        relation("broader", "X", "Y"),
      ]);

      expect(() => classifyOntologyChanges(before, after)).toThrow(
        ConfigurationError,
      );
    });

    it("never throws when the diff adds or removes no relation", () => {
      const incoherentRelations = [
        relation("disjointWith", "A", "B"),
        relation("subClassOf", "A", "B"),
      ];
      const before = snapshot({}, {}, incoherentRelations);
      const after = snapshot({}, {}, incoherentRelations);

      expect(() => classifyOntologyChanges(before, after)).not.toThrow();
    });
  });
});
