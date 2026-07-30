import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  disjointWith,
  equivalentTo,
  inverseOf,
  partOf,
  relatedTo,
  subClassOf,
} from "../src";
import { GraphExtensionUnresolvedOntologyEndpointError } from "../src/graph-extension";
import { mergeGraphExtension } from "../src/graph-extension/merge";
import { validateOntologyRelations } from "../src/ontology/validation";
import { buildKindRegistry } from "../src/registry";
import { computeClosuresFromNamedOntology } from "../src/registry/kind-registry";
import {
  deserializeSchema,
  type SerializedSchema,
  serializeSchema,
} from "../src/schema";
import { matchingArray, matchingObject } from "./test-utils";

const emptySchema = z.object({});
const Person = defineNode("Person", { schema: emptySchema });
const Organization = defineNode("Organization", { schema: emptySchema });
const Company = defineNode("Company", { schema: emptySchema });

type ComposableReadonlyStringSet = ReadonlySet<string> &
  Readonly<{
    union(other: ReadonlySet<string>): Set<string>;
    intersection(other: ReadonlySet<string>): Set<string>;
    difference(other: ReadonlySet<string>): Set<string>;
    symmetricDifference(other: ReadonlySet<string>): Set<string>;
    isSubsetOf(other: ReadonlySet<string>): boolean;
    isSupersetOf(other: ReadonlySet<string>): boolean;
    isDisjointFrom(other: ReadonlySet<string>): boolean;
  }>;

describe("ontology truth and hardening", () => {
  it("propagates disjointness through the subClassOf closure", () => {
    const graph = defineGraph({
      id: "disjoint-subsumption",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [
        disjointWith(Person, Organization),
        subClassOf(Company, Organization),
      ],
    });

    const registry = buildKindRegistry(graph);
    expect(registry.areDisjoint("Person", "Company")).toBe(true);
    expect(registry.getDisjointKinds("Company")).toContain("Person");
  });

  it("provides a symmetric direct relatedTo accessor", () => {
    const graph = defineGraph({
      id: "related-kinds",
      nodes: { Person: { type: Person }, Company: { type: Company } },
      edges: {},
      ontology: [relatedTo(Person, Company)],
    });
    const registry = buildKindRegistry(graph);
    expect(registry.getRelatedKinds("Person")).toEqual(["Company"]);
    expect(registry.getRelatedKinds("Company")).toEqual(["Person"]);
    expect(registry.getRelatedKinds("Missing")).toEqual([]);
  });

  it("rejects incoherent live-graph ontology with structured details", () => {
    const graph = defineGraph({
      id: "live-incoherent",
      nodes: { Person: { type: Person }, Organization: { type: Organization } },
      edges: {},
      ontology: [
        subClassOf(Person, Organization),
        disjointWith(Person, Organization),
      ],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        }),
      }),
    );
  });

  it("rejects a disjointWith self-loop", () => {
    const graph = defineGraph({
      id: "disjoint-self-loop",
      nodes: { Person: { type: Person } },
      edges: {},
      ontology: [disjointWith(Person, Person)],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        }),
      }),
    );
  });

  it("rejects a common subclass of two disjoint parents", () => {
    const graph = defineGraph({
      id: "common-subclass-of-disjoint-parents",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [
        disjointWith(Person, Organization),
        subClassOf(Company, Person),
        subClassOf(Company, Organization),
      ],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
          issues: matchingArray([
            expect.objectContaining({
              code: "ONTOLOGY_DISJOINT_CONFLICT",
              details: matchingObject({ kind: "Company" }),
            }),
          ]),
        }),
      }),
    );
  });

  it("allows a kind to be part of a disjoint kind", () => {
    const graph = defineGraph({
      id: "part-of-disjoint-kind",
      nodes: { Person: { type: Person }, Organization: { type: Organization } },
      edges: {},
      ontology: [
        disjointWith(Person, Organization),
        partOf(Person, Organization),
      ],
    });

    expect(() => buildKindRegistry(graph)).not.toThrow();
  });

  it("rejects disjoint overlap reached through equivalence and subclass", () => {
    const graph = defineGraph({
      id: "interleaved-disjoint-conflict",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [
        disjointWith(Person, Organization),
        equivalentTo(Person, Company),
        subClassOf(Company, Organization),
      ],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        }),
      }),
    );
  });

  it("rejects a kind declared both equivalentTo and disjointWith another", () => {
    const graph = defineGraph({
      id: "equivalent-and-disjoint",
      nodes: { Person: { type: Person }, Organization: { type: Organization } },
      edges: {},
      ontology: [
        equivalentTo(Person, Organization),
        disjointWith(Person, Organization),
      ],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        }),
      }),
    );
  });

  it("rejects equivalentTo/disjointWith conflict via equivalence transitivity", () => {
    const Client = defineNode("Client", { schema: emptySchema });
    const Customer = defineNode("Customer", { schema: emptySchema });
    const Supplier = defineNode("Supplier", { schema: emptySchema });
    const graph = defineGraph({
      id: "transitive-equivalent-and-disjoint",
      nodes: {
        Client: { type: Client },
        Customer: { type: Customer },
        Supplier: { type: Supplier },
      },
      edges: {},
      ontology: [
        equivalentTo(Client, Customer),
        equivalentTo(Customer, Supplier),
        disjointWith(Client, Supplier),
      ],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        }),
      }),
    );
  });

  it("validates a long equivalence chain without overflowing the stack", () => {
    const chainLength = 20_000;
    const ontology = Array.from({ length: chainLength }, (_, index) => ({
      metaEdge: "equivalentTo",
      from: `Kind${index}`,
      to: `Kind${index + 1}`,
    }));
    ontology.push({
      metaEdge: "disjointWith",
      from: "Kind0",
      to: `Kind${chainLength}`,
    });

    expect(validateOntologyRelations(ontology)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "ONTOLOGY_DISJOINT_CONFLICT" }),
      ]),
    );

    const closures = computeClosuresFromNamedOntology(ontology.slice(0, -1));
    expect(closures.equivalenceSets.get("Kind0")).toContain(
      `Kind${chainLength}`,
    );
  });

  it("exposes equivalence classes as complete readonly set views", () => {
    const closures = computeClosuresFromNamedOntology([
      { metaEdge: "equivalentTo", from: "Alpha", to: "Beta" },
      { metaEdge: "equivalentTo", from: "Beta", to: "Gamma" },
    ]);
    const equivalents = closures.equivalenceSets.get("Alpha");
    expect(equivalents).toBeDefined();
    if (equivalents === undefined) throw new Error("Missing equivalence set");

    expect(equivalents.size).toBe(2);
    expect(equivalents.has("Alpha")).toBe(false);
    expect(equivalents.has("Beta")).toBe(true);
    expect([...equivalents]).toEqual(["Beta", "Gamma"]);
    expect([...equivalents.keys()]).toEqual(["Beta", "Gamma"]);
    expect([...equivalents.entries()]).toEqual([
      ["Beta", "Beta"],
      ["Gamma", "Gamma"],
    ]);

    const context = { visited: [] as string[] };
    equivalents.forEach(function (this: typeof context, value, key, set) {
      expect(this).toBe(context);
      expect(key).toBe(value);
      expect(set).toBe(equivalents);
      this.visited.push(value);
    }, context);
    expect(context.visited).toEqual(["Beta", "Gamma"]);
    expect(Object.keys(equivalents)).toEqual([]);
    expect(Object.prototype.toString.call(equivalents)).toBe("[object Set]");

    const composable = equivalents as ComposableReadonlyStringSet;
    expect([...composable.union(new Set(["Delta"]))]).toEqual([
      "Beta",
      "Gamma",
      "Delta",
    ]);
    expect([...composable.intersection(new Set(["Gamma", "Delta"]))]).toEqual([
      "Gamma",
    ]);
    expect([...composable.difference(new Set(["Gamma"]))]).toEqual(["Beta"]);
    expect([
      ...composable.symmetricDifference(new Set(["Gamma", "Delta"])),
    ]).toEqual(["Beta", "Delta"]);
    expect(composable.isSubsetOf(new Set(["Beta", "Gamma", "Delta"]))).toBe(
      true,
    );
    expect(composable.isSupersetOf(new Set(["Beta"]))).toBe(true);
    expect(composable.isDisjointFrom(new Set(["Delta"]))).toBe(true);
    expect(composable.isDisjointFrom(new Set(["Gamma"]))).toBe(false);
    expect([...equivalents]).toEqual(["Beta", "Gamma"]);
  });

  it("lifts disjointness onto equivalence-set members", () => {
    const Client = defineNode("Client", { schema: emptySchema });
    const Customer = defineNode("Customer", { schema: emptySchema });
    const graph = defineGraph({
      id: "disjoint-across-equivalence",
      nodes: {
        Client: { type: Client },
        Customer: { type: Customer },
        Organization: { type: Organization },
      },
      edges: {},
      ontology: [
        equivalentTo(Client, Customer),
        disjointWith(Client, Organization),
      ],
    });

    const registry = buildKindRegistry(graph);
    expect(registry.areDisjoint("Customer", "Organization")).toBe(true);
    expect(registry.areDisjoint("Client", "Customer")).toBe(false);
    expect(registry.areDisjoint("Customer", "Customer")).toBe(false);
  });

  it("closes disjointness across interleaved equivalence and subclass relations", () => {
    const Client = defineNode("Client", { schema: emptySchema });
    const Customer = defineNode("Customer", { schema: emptySchema });
    const VipCustomer = defineNode("VipCustomer", { schema: emptySchema });
    const PremiumCustomer = defineNode("PremiumCustomer", {
      schema: emptySchema,
    });
    const graph = defineGraph({
      id: "disjoint-across-equivalent-hierarchy",
      nodes: {
        Client: { type: Client },
        Customer: { type: Customer },
        VipCustomer: { type: VipCustomer },
        PremiumCustomer: { type: PremiumCustomer },
        Organization: { type: Organization },
      },
      edges: {},
      ontology: [
        equivalentTo(Client, Customer),
        subClassOf(VipCustomer, Customer),
        equivalentTo(VipCustomer, PremiumCustomer),
        disjointWith(Client, Organization),
      ],
    });

    const registry = buildKindRegistry(graph);
    expect(registry.areDisjoint("VipCustomer", "Organization")).toBe(true);
    expect(registry.areDisjoint("PremiumCustomer", "Organization")).toBe(true);
  });

  it("recomputes serialized closures instead of trusting stale persisted data", () => {
    const graph = defineGraph({
      id: "stale-closures",
      nodes: {
        Person: { type: Person },
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [
        disjointWith(Person, Organization),
        subClassOf(Company, Organization),
      ],
    });
    const serialized = serializeSchema(graph, 1);
    const staleSchema = {
      ...serialized,
      ontology: {
        ...serialized.ontology,
        closures: {
          ...serialized.ontology.closures,
          subClassAncestors: {},
          subClassDescendants: {},
          disjointPairs: [],
        },
      },
    } satisfies SerializedSchema;

    const registry = deserializeSchema(staleSchema).buildRegistry();
    expect(registry.isSubClassOf("Company", "Organization")).toBe(true);
    expect(registry.areDisjoint("Person", "Company")).toBe(true);
  });

  it("validates serialized relations even when persisted closures look benign", () => {
    const valid = serializeSchema(
      defineGraph({
        id: "serialized-incoherent",
        nodes: {
          Person: { type: Person },
          Organization: { type: Organization },
        },
        edges: {},
        ontology: [subClassOf(Person, Organization)],
      }),
      1,
    );
    const incoherent = {
      ...valid,
      ontology: {
        ...valid.ontology,
        relations: [
          { metaEdge: "subClassOf", from: "Person", to: "Organization" },
          { metaEdge: "subClassOf", from: "Organization", to: "Person" },
        ],
      },
    } satisfies SerializedSchema;

    expect(() => deserializeSchema(incoherent).buildRegistry()).toThrow(
      expect.objectContaining({
        details: matchingObject({ code: "ONTOLOGY_CYCLE" }),
      }),
    );
  });

  it("rejects endpoint-incompatible inverse edges", () => {
    const Author = defineNode("Author", { schema: emptySchema });
    const Paper = defineNode("Paper", { schema: emptySchema });
    const Topic = defineNode("Topic", { schema: emptySchema });
    const writes = defineEdge("writes");
    const writtenBy = defineEdge("writtenBy");
    const graph = defineGraph({
      id: "inverse-endpoints",
      nodes: {
        Author: { type: Author },
        Paper: { type: Paper },
        Topic: { type: Topic },
      },
      edges: {
        writes: { type: writes, from: [Author], to: [Paper] },
        writtenBy: { type: writtenBy, from: [Topic], to: [Author] },
      },
      ontology: [inverseOf(writes, writtenBy)],
    });

    expect(() => buildKindRegistry(graph)).toThrow(
      expect.objectContaining({
        code: "CONFIGURATION_ERROR",
        details: matchingObject({ metaEdge: "inverseOf" }),
      }),
    );
  });

  it("rejects multiple inverse partners but preserves legal self-inverse edges", () => {
    const first = defineEdge("first");
    const second = defineEdge("second");
    const third = defineEdge("third");
    const conflicting = defineGraph({
      id: "inverse-unique",
      nodes: { Person: { type: Person } },
      edges: {
        first: { type: first, from: [Person], to: [Person] },
        second: { type: second, from: [Person], to: [Person] },
        third: { type: third, from: [Person], to: [Person] },
      },
      ontology: [inverseOf(first, second), inverseOf(first, third)],
    });
    expect(() => buildKindRegistry(conflicting)).toThrow(
      expect.objectContaining({
        details: matchingObject({
          code: "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS",
        }),
      }),
    );

    const symmetric = defineEdge("symmetric");
    const legal = defineGraph({
      id: "self-inverse",
      nodes: { Person: { type: Person } },
      edges: {
        symmetric: { type: symmetric, from: [Person], to: [Person] },
      },
      ontology: [inverseOf(symmetric, symmetric)],
    });
    expect(buildKindRegistry(legal).getInverseEdge("symmetric")).toBe(
      "symmetric",
    );
  });

  it("uses the same inverse-partner validation for graph extensions", () => {
    expect(() =>
      defineGraphExtension({
        ontology: [
          { metaEdge: "inverseOf", from: "a", to: "b" },
          { metaEdge: "inverseOf", from: "a", to: "c" },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        issues: matchingArray([
          expect.objectContaining({
            code: "ONTOLOGY_INVERSE_MULTIPLE_PARTNERS",
            path: "/ontology/1",
          }),
        ]),
      }),
    );
  });

  it("uses inverse endpoint validation on the deserializer registry path", () => {
    const Author = defineNode("DeserializeAuthor", { schema: emptySchema });
    const Paper = defineNode("DeserializePaper", { schema: emptySchema });
    const Topic = defineNode("DeserializeTopic", { schema: emptySchema });
    const writes = defineEdge("deserializeWrites");
    const writtenBy = defineEdge("deserializeWrittenBy");
    const schema = serializeSchema(
      defineGraph({
        id: "inverse-deserialized",
        nodes: {
          DeserializeAuthor: { type: Author },
          DeserializePaper: { type: Paper },
          DeserializeTopic: { type: Topic },
        },
        edges: {
          deserializeWrites: {
            type: writes,
            from: [Author],
            to: [Paper],
          },
          deserializeWrittenBy: {
            type: writtenBy,
            from: [Topic],
            to: [Author],
          },
        },
        ontology: [inverseOf(writes, writtenBy)],
      }),
      1,
    );

    expect(() => deserializeSchema(schema).buildRegistry()).toThrow(
      expect.objectContaining({
        details: matchingObject({ metaEdge: "inverseOf" }),
      }),
    );
  });

  it("rejects unresolved bare extension edge names but keeps external IRIs inert", () => {
    const localEdge = defineEdge("localEdge");
    const host = defineGraph({
      id: "extension-ontology-endpoints",
      nodes: { Person: { type: Person } },
      edges: {
        localEdge: { type: localEdge, from: [Person], to: [Person] },
      },
    });

    const typo = defineGraphExtension({
      ontology: [{ metaEdge: "inverseOf", from: "localEdge", to: "localEdg" }],
    });
    expect(() => mergeGraphExtension(host, typo)).toThrow(
      GraphExtensionUnresolvedOntologyEndpointError,
    );

    const external = defineGraphExtension({
      ontology: [
        {
          metaEdge: "inverseOf",
          from: "https://example.com/edge/a",
          to: "https://example.com/edge/b",
        },
      ],
    });
    expect(() => mergeGraphExtension(host, external)).not.toThrow();
  });
});
