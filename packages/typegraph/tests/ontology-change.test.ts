/**
 * Unit tests for `classifyOntologyChanges` (`src/schema/ontology-change.ts`).
 *
 * Every relation-classification test below is load-bearing: each case states the
 * revert check, per AGENTS.md.
 */
import { describe, expect, it } from "vitest";

import { ConfigurationError } from "../src/errors";
import {
  classifyOntology,
  classifyOntologyChanges,
  type OntologyChange,
  type OntologyDataProbe,
  type OntologySnapshot,
  PROBE_VIOLATION_FAMILIES,
  probeCoversViolationFamily,
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
  via?: string,
): SerializedOntologyRelation {
  return { metaEdge, from, to, ...(via === undefined ? {} : { via }) };
}

function compositionRelation(
  metaEdge: "partOf" | "hasPart",
  from: string,
  to: string,
  via: string,
  existence?: "optional" | "required",
): SerializedOntologyRelation {
  return {
    metaEdge,
    from,
    to,
    via,
    ...(existence === undefined ? {} : { existence }),
  };
}

/** A relation change as the preflight sees it: the public change plus the probes it carries. */
type ProbedChange = OntologyChange &
  Readonly<{ probes?: readonly OntologyDataProbe[] | undefined }>;

/** The relation changes of a diff, each with the probes it owes (`undefined` when none). */
function classify(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly ProbedChange[] {
  return classifyOntology(before, after).relationChanges.map(
    ({ change, probes }) => ({
      ...change,
      probes: probes.length > 0 ? probes : undefined,
    }),
  );
}

function relationChangeOf(
  changes: readonly ProbedChange[],
  type: "added" | "removed",
) {
  return requireDefined(
    changes.find((change) => change.type === type),
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

/**
 * The endpoint probe an edge kind's own registration owes — the loss no
 * relation change carries — with the edge kinds the classifier names.
 */
function admissionLossOf(before: OntologySnapshot, after: OntologySnapshot) {
  const classification = classifyOntology(before, after);
  return {
    edgeKinds: classification.tightenedEdgeKinds,
    allowances: probeOfKind(classification.probes, "edgeEndpointAssignability")
      .allowances,
  };
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

/**
 * `partOf`/`hasPart` require a registered `via` edge whose whole-side
 * cardinality is `"one"`/`"oneActive"`. `edgeA` (X -> Y) is the only pair
 * declared against it, so it also satisfies composition-exactness for
 * whichever orientation the relation under test infers.
 */
const EDGES_FOR_COMPOSITION: Record<string, SerializedEdgeDef> = {
  edgeA: {
    ...edgeDef("edgeA", ["X"], ["Y"]),
    cardinality: "one",
    targetCardinality: "one",
  },
};

// ============================================================
// The severity matrix
// ============================================================

type MatrixRow = Readonly<{
  metaEdge: string;
  direction: "added" | "removed";
  from: string;
  to: string;
  via?: string;
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
    expectedProbeKinds: [
      "nodeUniqueness",
      "nodeDisjointness",
      "compositionExistence",
    ],
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
    expectedProbeKinds: [
      "nodeUniqueness",
      "nodeDisjointness",
      "compositionExistence",
    ],
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
    expectedProbeKinds: [
      "nodeUniqueness",
      "nodeDisjointness",
      "compositionExistence",
    ],
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
    from: "X",
    to: "Y",
    via: "edgeA",
    edges: EDGES_FOR_COMPOSITION,
    expectedSeverity: "warning",
    expectedProbeKinds: ["composition"],
  },
  {
    metaEdge: "partOf",
    direction: "removed",
    from: "X",
    to: "Y",
    via: "edgeA",
    edges: EDGES_FOR_COMPOSITION,
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
  {
    metaEdge: "hasPart",
    direction: "added",
    from: "X",
    to: "Y",
    via: "edgeA",
    edges: EDGES_FOR_COMPOSITION,
    expectedSeverity: "warning",
    expectedProbeKinds: ["composition"],
  },
  {
    metaEdge: "hasPart",
    direction: "removed",
    from: "X",
    to: "Y",
    via: "edgeA",
    edges: EDGES_FOR_COMPOSITION,
    expectedSeverity: "breaking",
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
    expectedSeverity: "breaking",
    expectedProbeKinds: [],
  },
];

describe("classifyOntologyChanges", () => {
  describe("the severity table", () => {
    it.each(MATRIX)("$metaEdge $direction -> $expectedSeverity", (row) => {
      const edges = row.edges ?? {};
      const relationUnderTest = relation(
        row.metaEdge,
        row.from,
        row.to,
        row.via,
      );
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

      const changes = classify(before, after);
      const change = relationChangeOf(changes, row.direction);

      expect(change.severity).toBe(row.expectedSeverity);
      expect((change.probes ?? []).map((probe) => probe.kind)).toEqual(
        row.expectedProbeKinds,
      );
    });

    // MUTATION CHECK: flipping the
    // `disjointWith`-added row's severity in
    // `classifyKnownRelationSeverity` to "safe" with no probe makes this
    // exact row of the matrix fail.
  });

  describe("symmetric relations", () => {
    const kinds = {
      Alpha: nodeDef("Alpha"),
      Gamma: nodeDef("Gamma"),
    };

    it.each([
      "disjointWith",
      "equivalentTo",
      "sameAs",
      "differentFrom",
      "relatedTo",
    ])(
      "reads %s restated with its arguments swapped as no change",
      (metaEdge) => {
        const before = snapshot(kinds, {}, [
          relation(metaEdge, "Gamma", "Alpha"),
        ]);
        const after = snapshot(kinds, {}, [
          relation(metaEdge, "Alpha", "Gamma"),
        ]);

        expect(classify(before, after)).toEqual([]);
      },
    );

    it("reads an inverseOf restated with its edge kinds swapped as no change", () => {
      const edges = {
        follows: edgeDef("follows", ["Alpha"], ["Gamma"]),
        followedBy: edgeDef("followedBy", ["Gamma"], ["Alpha"]),
      };
      const before = snapshot(kinds, edges, [
        relation("inverseOf", "follows", "followedBy"),
      ]);
      const after = snapshot(kinds, edges, [
        relation("inverseOf", "followedBy", "follows"),
      ]);

      expect(classify(before, after)).toEqual([]);
    });

    it("still reads a swapped subClassOf as a removal and an addition", () => {
      const before = snapshot(kinds, {}, [
        relation("subClassOf", "Gamma", "Alpha"),
      ]);
      const after = snapshot(kinds, {}, [
        relation("subClassOf", "Alpha", "Gamma"),
      ]);

      expect(classify(before, after).map((change) => change.type)).toEqual([
        "removed",
        "added",
      ]);
    });
  });
  // MUTATION CHECK (verified): keying `keyedRelations` by
  // `ontologyRelationIdentityKey` alone (src/schema/ontology-change.ts) reads
  // each swap as a removal beside a probed addition.

  describe("the removed-kind rule", () => {
    it("classifies a removed relation as safe with no probe when this commit also removes one of its kinds", () => {
      const before = snapshot(
        { Company: nodeDef("Company"), Organization: nodeDef("Organization") },
        {},
        [relation("subClassOf", "Company", "Organization")],
      );
      const after = snapshot({ Organization: nodeDef("Organization") }, {}, []);

      const changes = classify(before, after);
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

      const changes = classify(before, after);
      const change = relationChangeOf(changes, "removed");

      expect(change.severity).toBe("warning");
      expect((change.probes ?? []).map((probe) => probe.kind)).toEqual([
        "edgeEndpointAssignability",
      ]);
    });

    // MUTATION CHECK: deleting the
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

      const changes = classify(before, after);
      const added = changes.find(
        (change) =>
          change.type === "added" && change.name.startsWith("disjointWith"),
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

    // MUTATION CHECK: computing the
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

      const changes = classify(before, after);
      const added = relationChangeOf(changes, "added");
      const probe = probeOfKind(added.probes, "nodeUniqueness");

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

      const changes = classify(before, after);
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
      // (a proper-subset test, which additionally requires the after list to
      // be strictly SHORTER) misses this entirely.
      const worksFor = edgeDef("worksFor", ["Person"], ["Organization"]);
      const before = snapshot({}, { worksFor }, [
        relation("subClassOf", "Company", "Organization"),
      ]);
      const after = snapshot({}, { worksFor }, [
        relation("subClassOf", "Shop", "Organization"),
      ]);

      const changes = classify(before, after);
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
    // MUTATION CHECK (verified): gating `edgeEndpointAdmissionLosses`
    // (`src/schema/ontology-change.ts`) on the after pair list being
    // strictly SHORTER than the before list drops the swap (equal-length
    // lists) and this assertion fails.
  });

  describe("an edge kind's endpoint admission loss no relation change carries", () => {
    it("probes a surviving subclass that loses admission when a mid-chain kind is removed, exempting the removed kind's own rows", () => {
      const likes = edgeDef("likes", ["Person"], ["Animal"]);
      const before = snapshot(
        {
          Person: nodeDef("Person"),
          Animal: nodeDef("Animal"),
          Mammal: nodeDef("Mammal"),
          Dog: nodeDef("Dog"),
        },
        { likes },
        [
          relation("subClassOf", "Mammal", "Animal"),
          relation("subClassOf", "Dog", "Mammal"),
        ],
      );
      const after = snapshot(
        {
          Person: nodeDef("Person"),
          Animal: nodeDef("Animal"),
          Dog: nodeDef("Dog"),
        },
        { likes },
        [],
      );

      const changes = classify(before, after);

      expect(changes.map((change) => [change.severity, change.probes])).toEqual(
        [
          ["safe", undefined],
          ["safe", undefined],
        ],
      );
      const loss = admissionLossOf(before, after);
      expect(loss.edgeKinds).toEqual(["likes"]);
      expect(loss.allowances).toEqual([
        {
          edgeKind: "likes",
          allowedPairs: [
            ["Person", "Animal"],
            ["Person", "Mammal"],
          ],
        },
      ]);
    });

    it("owes nothing when the only pairs lost name the removed kind", () => {
      const likes = edgeDef("likes", ["Person"], ["Animal"]);
      const before = snapshot(
        {
          Person: nodeDef("Person"),
          Animal: nodeDef("Animal"),
          Mammal: nodeDef("Mammal"),
        },
        { likes },
        [relation("subClassOf", "Mammal", "Animal")],
      );
      const after = snapshot(
        { Person: nodeDef("Person"), Animal: nodeDef("Animal") },
        { likes },
        [],
      );

      const changes = classify(before, after);

      expect(changes.flatMap((change) => change.probes ?? [])).toEqual([]);
      expect(changes.map((change) => change.entity)).toEqual(["relation"]);
    });

    it("probes a directly narrowed `to` declaration with no relation change at all", () => {
      const nodes = { A: nodeDef("A"), B: nodeDef("B"), C: nodeDef("C") };
      const before = snapshot(
        nodes,
        { e: edgeDef("e", ["A"], ["B", "C"]) },
        [],
      );
      const after = snapshot(nodes, { e: edgeDef("e", ["A"], ["B"]) }, []);

      const loss = admissionLossOf(before, after);

      expect(loss.edgeKinds).toEqual(["e"]);
      expect(loss.allowances).toEqual([
        { edgeKind: "e", allowedPairs: [["A", "B"]] },
      ]);
    });

    it("probes a narrowed source-dependent target map", () => {
      const nodes = { A: nodeDef("A"), B: nodeDef("B"), C: nodeDef("C") };
      const before = snapshot(
        nodes,
        { e: edgeDef("e", ["A"], ["B", "C"]) },
        [],
      );
      const after = snapshot(
        nodes,
        {
          e: {
            ...edgeDef("e", ["A"], ["B", "C"]),
            targetKindsBySource: { A: ["B"] },
          },
        },
        [],
      );

      const loss = admissionLossOf(before, after);

      expect(loss.edgeKinds).toEqual(["e"]);
      expect(loss.allowances).toEqual([
        { edgeKind: "e", allowedPairs: [["A", "B"]] },
      ]);
    });

    it("owes nothing when a dropped declared endpoint is still admitted through subsumption", () => {
      const nodes = { A: nodeDef("A"), B: nodeDef("B"), C: nodeDef("C") };
      const relations = [relation("subClassOf", "C", "B")];
      const before = snapshot(
        nodes,
        { e: edgeDef("e", ["A"], ["B", "C"]) },
        relations,
      );
      const after = snapshot(
        nodes,
        { e: edgeDef("e", ["A"], ["B"]) },
        relations,
      );

      expect(classify(before, after)).toEqual([]);
    });

    it("reports the loss once, on the relation change, when one already carries the diff-wide probe", () => {
      const nodes = {
        Person: nodeDef("Person"),
        Organization: nodeDef("Organization"),
        Company: nodeDef("Company"),
        Shop: nodeDef("Shop"),
      };
      const before = snapshot(
        nodes,
        { worksFor: edgeDef("worksFor", ["Person"], ["Organization", "Shop"]) },
        [relation("subClassOf", "Company", "Organization")],
      );
      const after = snapshot(
        nodes,
        { worksFor: edgeDef("worksFor", ["Person"], ["Organization"]) },
        [],
      );

      const changes = classify(before, after);

      expect(changes.map((change) => change.entity)).toEqual(["relation"]);
      expect(
        probeOfKind(changes[0]?.probes, "edgeEndpointAssignability").allowances,
      ).toEqual([
        { edgeKind: "worksFor", allowedPairs: [["Person", "Organization"]] },
      ]);
    });

    it("does not build a registry for a widened or reordered endpoint declaration", () => {
      const incoherentRelations = [
        relation("disjointWith", "A", "B"),
        relation("subClassOf", "A", "B"),
      ];
      const before = snapshot(
        {},
        { e: edgeDef("e", ["A"], ["B", "C"]) },
        incoherentRelations,
      );
      const after = snapshot(
        {},
        { e: edgeDef("e", ["A"], ["C", "B", "D"]) },
        incoherentRelations,
      );

      expect(classify(before, after)).toEqual([]);
    });
  });

  describe("an incoherent ontology", () => {
    it("propagates ConfigurationError rather than reporting an unresolved probe", () => {
      // `disjointWith(A, B)` plus `subClassOf(A, B)` is a contradiction
      // `validateOntologyRelations` already refuses at store open — the
      // refuse-on-load precedent this module follows (there is no
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

  describe("an in-place `existence` flip on an already-declared partOf/hasPart pair", () => {
    it('classifies optional -> required as ONE "modified" warning entry carrying both composition probes, never remove+add', () => {
      const before = snapshot({}, EDGES_FOR_COMPOSITION, [
        compositionRelation("partOf", "X", "Y", "edgeA"),
      ]);
      const after = snapshot({}, EDGES_FOR_COMPOSITION, [
        compositionRelation("partOf", "X", "Y", "edgeA", "required"),
      ]);

      const changes = classify(before, after);

      // The bug this guards: folding `existence` into the identity key made
      // this diff as remove (breaking) + add (warning), which both defeats
      // the rule that a pure loosening must be safe and makes `ensureSchema`
      // refuse a tightening as "breaking-change" before the tightening
      // preflight ever runs.
      expect(changes).toHaveLength(1);
      const change = requireDefined(changes[0], "expected one change");
      expect(change.type).toBe("modified");
      expect(change.severity).toBe("warning");
      expect(change.details).toContain('existence: "required"');
      expect((change.probes ?? []).map((probe) => probe.kind)).toEqual([
        "composition",
        "compositionExistence",
      ]);
    });
    // MUTATION CHECK: restore `relation.existence ?? ""` as a fifth element
    // of the tuple `relationMapKey` (src/schema/ontology-change.ts) encodes.
    // `changes` then has length 2 (one "removed", one "added") and the
    // "removed" half's severity is "breaking" instead of this test's single
    // "modified"/"warning" entry.

    it('classifies required -> optional as ONE "modified" safe entry with no probe (loosening is safe)', () => {
      const before = snapshot({}, EDGES_FOR_COMPOSITION, [
        compositionRelation("partOf", "X", "Y", "edgeA", "required"),
      ]);
      const after = snapshot({}, EDGES_FOR_COMPOSITION, [
        compositionRelation("partOf", "X", "Y", "edgeA"),
      ]);

      const changes = classify(before, after);

      expect(changes).toHaveLength(1);
      const change = requireDefined(changes[0], "expected one change");
      expect(change.type).toBe("modified");
      expect(change.severity).toBe("safe");
      expect(change.probes).toBeUndefined();
    });
    // MUTATION CHECK: same restore as above. `changes` then has length 2,
    // and the "removed" half (dropping the old `required` declaration)
    // classifies as "breaking" instead of this test's single "safe" entry.

    it("classifies no change at all when existence is unchanged", () => {
      const relations = [
        compositionRelation("partOf", "X", "Y", "edgeA", "required"),
      ];
      const before = snapshot({}, EDGES_FOR_COMPOSITION, relations);
      const after = snapshot({}, EDGES_FOR_COMPOSITION, relations);

      expect(classify(before, after)).toEqual([]);
    });
  });
});

describe("an edge kind's own registration is not an ontology change", () => {
  const nodes = { Task: nodeDef("Task") };
  const plain = edgeDef("dependsOn", ["Task"], ["Task"]);
  const acyclic: SerializedEdgeDef = { ...plain, acyclic: true };

  it("reports acyclic: true as an edge-registration tightening, with no ontology change", () => {
    const before = snapshot(nodes, { dependsOn: plain }, []);
    const after = snapshot(nodes, { dependsOn: acyclic }, []);

    const classification = classifyOntology(before, after);

    expect(classification.changes).toEqual([]);
    expect(classification.probedChanges).toEqual([]);
    expect(classification.tightenedEdgeKinds).toEqual(["dependsOn"]);
    expect(classification.probes.map((probe) => probe.kind)).toEqual([
      "edgeAcyclicity",
    ]);
  });
  // MUTATION CHECK: emitting an `OntologyChange` for the flag again (the
  // previous `entity: "edgeRegistration"` arm) makes `changes` non-empty.

  it("owes nothing when acyclic: true is dropped", () => {
    const before = snapshot(nodes, { dependsOn: acyclic }, []);
    const after = snapshot(nodes, { dependsOn: plain }, []);

    const classification = classifyOntology(before, after);

    expect(classification.changes).toEqual([]);
    expect(classification.tightenedEdgeKinds).toEqual([]);
    expect(classification.probes).toEqual([]);
  });
});

describe("a removed relation naming an external IRI", () => {
  const iri = "https://schema.org/Person";
  const nodes = { Person: nodeDef("Person") };

  it("is safe and owes no probe when no kind reaches the IRI's equivalence class", () => {
    const worksFor = edgeDef("knows", ["Person"], ["Person"]);
    const before = snapshot(nodes, { knows: worksFor }, [
      relation("sameAs", "Person", iri),
    ]);
    const after = snapshot(nodes, { knows: worksFor }, []);

    const classification = classifyOntology(before, after);

    expect(classification.changes.map((change) => change.severity)).toEqual([
      "safe",
    ]);
    expect(classification.probedChanges).toEqual([]);
    expect(classification.probes).toEqual([]);
    expect(classification.tightenedEdgeKinds).toEqual([]);
  });
  // MUTATION CHECK: dropping `severityOfRelationRemoval`'s IRI arm reports
  // the removal as a `warning` that owes nothing.

  it("still owes the endpoint probe when a second kind reaches the same IRI", () => {
    const kinds = { Person: nodeDef("Person"), Human: nodeDef("Human") };
    const edges = { knows: edgeDef("knows", ["Person"], ["Person"]) };
    const before = snapshot(kinds, edges, [
      relation("sameAs", "Person", iri),
      relation("sameAs", "Human", iri),
    ]);
    const after = snapshot(kinds, edges, [relation("sameAs", "Human", iri)]);

    const classification = classifyOntology(before, after);

    expect(
      classification.probedChanges.map((change) => change.severity),
    ).toEqual(["warning"]);
    expect(classification.probes.map((probe) => probe.kind)).toEqual([
      "edgeEndpointAssignability",
    ]);
  });
});

describe("the violation families each probe can produce", () => {
  it("names the families a fence row uses", () => {
    const probe = { families: PROBE_VIOLATION_FAMILIES.composition };
    expect(probe.families).toEqual([
      "composition",
      "edgeAcyclicity",
      "compositionFutureWindow",
    ]);
    expect(probeCoversViolationFamily(probe, "composition")).toBe(true);
    expect(probeCoversViolationFamily(probe, "edgeAcyclicity")).toBe(true);
    expect(probeCoversViolationFamily(probe, "compositionFutureWindow")).toBe(
      true,
    );
    expect(probeCoversViolationFamily(probe, "compositionExistence")).toBe(
      false,
    );
    expect(PROBE_VIOLATION_FAMILIES.compositionExistence).toEqual([
      "compositionExistence",
    ]);
    expect(PROBE_VIOLATION_FAMILIES.nodeUniqueness).toEqual(["nodeUniqueness"]);
    expect(
      (
        Object.values(PROBE_VIOLATION_FAMILIES).flat() as readonly string[]
      ).includes("edgeCardinality"),
    ).toBe(false);
  });
});
