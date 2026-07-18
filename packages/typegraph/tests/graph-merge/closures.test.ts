import type { OntologyIntrospection } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  equivalentTo,
  subClassOf,
} from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  buildSubClassClosure,
  isReachable,
  SUB_CLASS_OF_META_EDGE,
} from "../../src/graph-merge/closures";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Doctor = defineNode("Doctor", {
  schema: z.object({ name: z.string() }),
});
const SpecialistDoctor = defineNode("SpecialistDoctor", {
  schema: z.object({ name: z.string() }),
});
const Physician = defineNode("Physician", {
  schema: z.object({ name: z.string() }),
});
const Animal = defineNode("Animal", {
  schema: z.object({ name: z.string() }),
});

/**
 * Builds a real store from `graph`, then projects its public
 * `store.introspect().ontology` into a closure — exercising the genuine public
 * surface (introspection + `computeTransitiveClosure`) end to end rather than a
 * hand-rolled ontology array.
 */
async function closureFromGraph(
  graph: Parameters<typeof createStoreWithSchema>[0],
): Promise<ReturnType<typeof buildSubClassClosure>> {
  const fixture = createSqliteMergeBackend();
  try {
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    return buildSubClassClosure(store.introspect().ontology);
  } finally {
    await fixture.cleanup();
  }
}

const taxonomyGraph = defineGraph({
  id: "closures-taxonomy",
  nodes: {
    Person: { type: Person },
    Doctor: { type: Doctor },
    SpecialistDoctor: { type: SpecialistDoctor },
    Animal: { type: Animal },
  },
  edges: {},
  ontology: [subClassOf(SpecialistDoctor, Doctor), subClassOf(Doctor, Person)],
});

describe("buildSubClassClosure over public introspection", () => {
  it("exposes the introspected subClassOf relations", async () => {
    const fixture = createSqliteMergeBackend();
    try {
      const [store] = await createStoreWithSchema(
        taxonomyGraph,
        fixture.backend,
      );
      const ontology = store.introspect().ontology;
      const subClassPairs = ontology
        .filter((entry) => entry.metaEdge === SUB_CLASS_OF_META_EDGE)
        .map((entry) => [entry.from, entry.to] as const);
      expect(subClassPairs).toContainEqual(["SpecialistDoctor", "Doctor"]);
      expect(subClassPairs).toContainEqual(["Doctor", "Person"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("is reachable transitively (SpecialistDoctor -> Person)", async () => {
    const closure = await closureFromGraph(taxonomyGraph);
    expect(isReachable(closure, "SpecialistDoctor", "Doctor")).toBe(true);
    expect(isReachable(closure, "Doctor", "Person")).toBe(true);
    expect(isReachable(closure, "SpecialistDoctor", "Person")).toBe(true);
  });

  it("is not reachable in the reverse (superclass -> subclass) direction", async () => {
    const closure = await closureFromGraph(taxonomyGraph);
    expect(isReachable(closure, "Person", "SpecialistDoctor")).toBe(false);
    expect(isReachable(closure, "Person", "Doctor")).toBe(false);
    expect(isReachable(closure, "Doctor", "SpecialistDoctor")).toBe(false);
  });

  it("treats the subclass relation as strict (irreflexive)", async () => {
    const closure = await closureFromGraph(taxonomyGraph);
    expect(isReachable(closure, "Doctor", "Doctor")).toBe(false);
    expect(isReachable(closure, "SpecialistDoctor", "SpecialistDoctor")).toBe(
      false,
    );
  });

  it("reports unrelated types as mutually unreachable", async () => {
    const graph = defineGraph({
      id: "closures-disjoint",
      nodes: {
        Person: { type: Person },
        Doctor: { type: Doctor },
        Animal: { type: Animal },
      },
      edges: {},
      ontology: [subClassOf(Doctor, Person)],
    });
    const closure = await closureFromGraph(graph);
    expect(isReachable(closure, "Animal", "Person")).toBe(false);
    expect(isReachable(closure, "Person", "Animal")).toBe(false);
    expect(isReachable(closure, "Doctor", "Animal")).toBe(false);
    expect(isReachable(closure, "Animal", "Doctor")).toBe(false);
  });

  it("returns false for types absent from the ontology", async () => {
    const closure = await closureFromGraph(taxonomyGraph);
    expect(isReachable(closure, "Nurse", "Person")).toBe(false);
    expect(isReachable(closure, "Person", "Nurse")).toBe(false);
  });
});

describe("closure is independent of input pair ordering", () => {
  const forward: readonly OntologyIntrospection[] = [
    {
      metaEdge: SUB_CLASS_OF_META_EDGE,
      from: "SpecialistDoctor",
      to: "Doctor",
      origin: "compile-time",
    },
    {
      metaEdge: SUB_CLASS_OF_META_EDGE,
      from: "Doctor",
      to: "Person",
      origin: "compile-time",
    },
  ];
  const reversed: readonly OntologyIntrospection[] = [...forward].reverse();

  it("yields identical reachability regardless of relation order", () => {
    const a = buildSubClassClosure(forward);
    const b = buildSubClassClosure(reversed);
    expect(isReachable(a, "SpecialistDoctor", "Person")).toBe(true);
    expect(isReachable(b, "SpecialistDoctor", "Person")).toBe(true);
    expect(isReachable(a, "Person", "SpecialistDoctor")).toBe(
      isReachable(b, "Person", "SpecialistDoctor"),
    );
  });

  it("produces byte-identical closures after normalization", () => {
    const normalize = (
      closure: ReturnType<typeof buildSubClassClosure>,
    ): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      for (const [child, ancestors] of closure.closure) {
        out[child] = [...ancestors].sort();
      }
      return out;
    };
    expect(normalize(buildSubClassClosure(forward))).toEqual(
      normalize(buildSubClassClosure(reversed)),
    );
  });
});

describe("equivalentTo folding", () => {
  const equivalenceGraph = defineGraph({
    id: "closures-equivalence",
    nodes: {
      Person: { type: Person },
      Doctor: { type: Doctor },
      Physician: { type: Physician },
      SpecialistDoctor: { type: SpecialistDoctor },
    },
    edges: {},
    ontology: [
      subClassOf(SpecialistDoctor, Doctor),
      subClassOf(Doctor, Person),
      equivalentTo(Physician, Doctor),
    ],
  });

  it("makes equivalent types mutually reachable", async () => {
    const closure = await closureFromGraph(equivalenceGraph);
    expect(isReachable(closure, "Physician", "Doctor")).toBe(true);
    expect(isReachable(closure, "Doctor", "Physician")).toBe(true);
  });

  it("shares ancestors across an equivalence class", async () => {
    const closure = await closureFromGraph(equivalenceGraph);
    // Physician ≡ Doctor, and Doctor ⊑ Person, so Physician ⊑ Person too.
    expect(isReachable(closure, "Physician", "Person")).toBe(true);
    // SpecialistDoctor ⊑ Doctor ≡ Physician, so SpecialistDoctor ⊑ Physician.
    expect(isReachable(closure, "SpecialistDoctor", "Physician")).toBe(true);
  });

  it("is order-independent for equivalentTo and subClassOf interleaving", () => {
    const base: readonly OntologyIntrospection[] = [
      {
        metaEdge: SUB_CLASS_OF_META_EDGE,
        from: "SpecialistDoctor",
        to: "Doctor",
        origin: "compile-time",
      },
      {
        metaEdge: SUB_CLASS_OF_META_EDGE,
        from: "Doctor",
        to: "Person",
        origin: "compile-time",
      },
      {
        metaEdge: "equivalentTo",
        from: "Physician",
        to: "Doctor",
        origin: "compile-time",
      },
    ];
    const shuffled: readonly OntologyIntrospection[] = [
      requireDefined(base[2]),
      requireDefined(base[0]),
      requireDefined(base[1]),
    ];
    const a = buildSubClassClosure(base);
    const b = buildSubClassClosure(shuffled);
    expect(isReachable(a, "Physician", "Person")).toBe(
      isReachable(b, "Physician", "Person"),
    );
    expect(isReachable(a, "SpecialistDoctor", "Physician")).toBe(
      isReachable(b, "SpecialistDoctor", "Physician"),
    );
    expect(isReachable(a, "Physician", "Person")).toBe(true);
  });
});
