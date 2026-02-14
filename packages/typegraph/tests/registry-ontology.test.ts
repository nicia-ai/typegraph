/**
 * Registry & Ontology Tests
 *
 * The KindRegistry precomputes transitive closures from ontology relations,
 * enabling efficient runtime queries like "is X a subclass of Y?" without
 * graph traversal.
 *
 * Key ontology relations:
 *   - subClassOf(Child, Parent) - Type inheritance
 *   - broader(Specific, General) - Concept hierarchy
 *   - equivalentTo(A, B) / sameAs(A, B) - Type equivalence
 *   - disjointWith(A, B) - Types that cannot overlap
 *   - partOf(Part, Whole) / hasPart(Whole, Part) - Composition
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  broader,
  defineGraph,
  defineNode,
  disjointWith,
  equivalentTo,
  hasPart,
  narrower,
  partOf,
  sameAs,
  subClassOf,
} from "../src";
import { buildKindRegistry } from "../src/registry";

const emptySchema = z.object({});

describe("subClassOf - Type Inheritance", () => {
  const Entity = defineNode("Entity", { schema: emptySchema });
  const Organization = defineNode("Organization", { schema: emptySchema });
  const Company = defineNode("Company", { schema: emptySchema });
  const Startup = defineNode("Startup", { schema: emptySchema });

  const graph = defineGraph({
    id: "inheritance_test",
    nodes: {
      Entity: { type: Entity },
      Organization: { type: Organization },
      Company: { type: Company },
      Startup: { type: Startup },
    },
    edges: {},
    ontology: [
      subClassOf(Organization, Entity),
      subClassOf(Company, Organization),
      subClassOf(Startup, Company),
    ],
  });

  const registry = buildKindRegistry(graph);

  it("detects direct subclass relationships", () => {
    expect(registry.isSubClassOf("Company", "Organization")).toBe(true);
    expect(registry.isSubClassOf("Organization", "Entity")).toBe(true);
  });

  it("computes transitive subclass relationships", () => {
    expect(registry.isSubClassOf("Company", "Entity")).toBe(true);
    expect(registry.isSubClassOf("Startup", "Entity")).toBe(true);
  });

  it("correctly rejects non-subclass relationships", () => {
    expect(registry.isSubClassOf("Entity", "Company")).toBe(false);
    expect(registry.isSubClassOf("Organization", "Startup")).toBe(false);
  });

  it("expands a kind to include all subclasses", () => {
    const expanded = registry.expandSubClasses("Organization");
    expect(expanded).toContain("Organization");
    expect(expanded).toContain("Company");
    expect(expanded).toContain("Startup");
    expect(expanded).not.toContain("Entity");
  });

  it("returns ancestors (superclasses) of a kind", () => {
    const ancestors = registry.getAncestors("Startup");
    expect(ancestors.has("Company")).toBe(true);
    expect(ancestors.has("Organization")).toBe(true);
    expect(ancestors.has("Entity")).toBe(true);
  });

  it("returns descendants (subclasses) of a kind", () => {
    const descendants = registry.getDescendants("Organization");
    expect(descendants.has("Company")).toBe(true);
    expect(descendants.has("Startup")).toBe(true);
  });
});

describe("broader/narrower - Concept Hierarchy", () => {
  const Animal = defineNode("Animal", { schema: emptySchema });
  const Mammal = defineNode("Mammal", { schema: emptySchema });
  const Dog = defineNode("Dog", { schema: emptySchema });

  const graph = defineGraph({
    id: "hierarchy_test",
    nodes: {
      Animal: { type: Animal },
      Mammal: { type: Mammal },
      Dog: { type: Dog },
    },
    edges: {},
    ontology: [broader(Dog, Mammal), broader(Mammal, Animal)],
  });

  const registry = buildKindRegistry(graph);

  it("detects direct broader relationships", () => {
    expect(registry.isNarrowerThan("Dog", "Mammal")).toBe(true);
    expect(registry.isBroaderThan("Animal", "Mammal")).toBe(true);
  });

  it("computes transitive broader relationships", () => {
    expect(registry.isNarrowerThan("Dog", "Animal")).toBe(true);
  });

  it("expands to include all narrower concepts", () => {
    const narrowerConcepts = registry.expandNarrower("Animal");
    expect(narrowerConcepts).toContain("Animal");
    expect(narrowerConcepts).toContain("Mammal");
    expect(narrowerConcepts).toContain("Dog");
  });
});

describe("narrower - Inverse of broader", () => {
  const Science = defineNode("Science", { schema: emptySchema });
  const Physics = defineNode("Physics", { schema: emptySchema });

  const graph = defineGraph({
    id: "narrower_test",
    nodes: {
      Science: { type: Science },
      Physics: { type: Physics },
    },
    edges: {},
    ontology: [narrower(Science, Physics)],
  });

  const registry = buildKindRegistry(graph);

  it("narrower(A, B) means B is narrower than A", () => {
    expect(registry.isNarrowerThan("Physics", "Science")).toBe(true);
    expect(registry.isBroaderThan("Science", "Physics")).toBe(true);
  });
});

describe("equivalentTo/sameAs - Type Equivalence", () => {
  const Client = defineNode("Client", { schema: emptySchema });
  const Customer = defineNode("Customer", { schema: emptySchema });

  const graph = defineGraph({
    id: "equivalence_test",
    nodes: {
      Client: { type: Client },
      Customer: { type: Customer },
    },
    edges: {},
    ontology: [equivalentTo(Client, Customer)],
  });

  const registry = buildKindRegistry(graph);

  it("detects equivalent types", () => {
    expect(registry.areEquivalent("Client", "Customer")).toBe(true);
    expect(registry.areEquivalent("Customer", "Client")).toBe(true);
  });

  it("returns all equivalents of a type", () => {
    const equivalents = registry.getEquivalents("Client");
    expect(equivalents).toContain("Customer");
  });
});

describe("sameAs - Alias for equivalentTo", () => {
  const User = defineNode("User", { schema: emptySchema });
  const Account = defineNode("Account", { schema: emptySchema });

  const graph = defineGraph({
    id: "sameas_test",
    nodes: {
      User: { type: User },
      Account: { type: Account },
    },
    edges: {},
    ontology: [sameAs(User, Account)],
  });

  const registry = buildKindRegistry(graph);

  it("works the same as equivalentTo", () => {
    expect(registry.areEquivalent("User", "Account")).toBe(true);
  });
});

describe("disjointWith - Mutually Exclusive Types", () => {
  const Person = defineNode("Person", { schema: emptySchema });
  const Organization = defineNode("Organization", { schema: emptySchema });

  const graph = defineGraph({
    id: "disjoint_test",
    nodes: {
      Person: { type: Person },
      Organization: { type: Organization },
    },
    edges: {},
    ontology: [disjointWith(Person, Organization)],
  });

  const registry = buildKindRegistry(graph);

  it("detects disjoint types", () => {
    expect(registry.areDisjoint("Person", "Organization")).toBe(true);
    expect(registry.areDisjoint("Organization", "Person")).toBe(true);
  });

  it("returns all disjoint kinds for a type", () => {
    const disjoint = registry.getDisjointKinds("Person");
    expect(disjoint).toContain("Organization");
  });
});

describe("partOf/hasPart - Composition", () => {
  const Engine = defineNode("Engine", { schema: emptySchema });
  const Car = defineNode("Car", { schema: emptySchema });
  const Vehicle = defineNode("Vehicle", { schema: emptySchema });

  const graph = defineGraph({
    id: "composition_test",
    nodes: {
      Engine: { type: Engine },
      Car: { type: Car },
      Vehicle: { type: Vehicle },
    },
    edges: {},
    ontology: [partOf(Engine, Car), partOf(Car, Vehicle)],
  });

  const registry = buildKindRegistry(graph);

  it("detects direct part-of relationships", () => {
    expect(registry.isPartOf("Engine", "Car")).toBe(true);
  });

  it("computes transitive part-of relationships", () => {
    expect(registry.isPartOf("Engine", "Vehicle")).toBe(true);
  });

  it("returns all wholes that contain a part", () => {
    const wholes = registry.getWholes("Engine");
    expect(wholes).toContain("Car");
    expect(wholes).toContain("Vehicle");
  });

  it("returns all parts of a whole", () => {
    const parts = registry.getParts("Vehicle");
    expect(parts).toContain("Car");
    expect(parts).toContain("Engine");
  });
});

describe("hasPart - Inverse of partOf", () => {
  const Wheel = defineNode("Wheel", { schema: emptySchema });
  const Bicycle = defineNode("Bicycle", { schema: emptySchema });

  const graph = defineGraph({
    id: "haspart_test",
    nodes: {
      Wheel: { type: Wheel },
      Bicycle: { type: Bicycle },
    },
    edges: {},
    ontology: [hasPart(Bicycle, Wheel)],
  });

  const registry = buildKindRegistry(graph);

  it("hasPart(Whole, Part) means Part is part of Whole", () => {
    expect(registry.isPartOf("Wheel", "Bicycle")).toBe(true);
    expect(registry.getParts("Bicycle")).toContain("Wheel");
  });
});

describe("isAssignableTo - Subsumption-based Assignment", () => {
  const Organization = defineNode("Organization", { schema: emptySchema });
  const Company = defineNode("Company", { schema: emptySchema });

  const graph = defineGraph({
    id: "assignable_test",
    nodes: {
      Organization: { type: Organization },
      Company: { type: Company },
    },
    edges: {},
    ontology: [subClassOf(Company, Organization)],
  });

  const registry = buildKindRegistry(graph);

  it("a type is assignable to itself", () => {
    expect(registry.isAssignableTo("Company", "Company")).toBe(true);
  });

  it("a subclass is assignable to its superclass", () => {
    expect(registry.isAssignableTo("Company", "Organization")).toBe(true);
  });

  it("a superclass is not assignable to a subclass", () => {
    expect(registry.isAssignableTo("Organization", "Company")).toBe(false);
  });
});
