/**
 * Ontology enforcement tests.
 *
 * Tests for runtime enforcement of ontological constraints:
 * - Disjointness: nodes of disjoint kinds cannot share IDs
 * - Delete behavior: restrict, cascade, disconnect
 * - Edge relationships: inverseOf, implies
 * - Query expansion: subclass inclusion
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createQueryBuilder,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  implies,
  inverseOf,
  subClassOf,
} from "../src";
import { RestrictedDeleteError } from "../src/errors";
import { buildKindRegistry } from "../src/registry/builders";
import { createStore } from "../src/store/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

// Node kinds
const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
  }),
});

const Organization = defineNode("Organization", {
  schema: z.object({
    name: z.string(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const Nonprofit = defineNode("Nonprofit", {
  schema: z.object({
    name: z.string(),
    mission: z.string().optional(),
  }),
});

const Animal = defineNode("Animal", {
  schema: z.object({
    species: z.string(),
  }),
});

// Edge kinds
const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

const manages = defineEdge("manages", {
  schema: z.object({}),
});

const managedBy = defineEdge("managedBy", {
  schema: z.object({}),
});

const likes = defineEdge("likes", {
  schema: z.object({}),
});

const interactsWith = defineEdge("interactsWith", {
  schema: z.object({}),
});

// ============================================================
// Disjointness Tests
// ============================================================

describe("Disjointness Enforcement", () => {
  it("allows creating nodes of non-disjoint kinds with same ID", async () => {
    // Company and Nonprofit are not disjoint, so same ID is allowed
    const graph = defineGraph({
      id: "disjoint_test_1",
      nodes: {
        Company: { type: Company },
        Nonprofit: { type: Nonprofit },
      },
      edges: {},
      ontology: [
        subClassOf(Company, Organization),
        subClassOf(Nonprofit, Organization),
      ],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Both can have the same ID since they're not disjoint
    const company = await store.nodes.Company.create({
      name: "Acme Corp",
      industry: "Tech",
    });
    expect(company.id).toBeDefined();

    await backend.close();
  });

  it("blocks creating nodes of disjoint kinds with same ID", async () => {
    const graph = defineGraph({
      id: "disjoint_test_2",
      nodes: {
        Person: { type: Person },
        Animal: { type: Animal },
      },
      edges: {},
      ontology: [disjointWith(Person, Animal)],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Create a Person with ID "entity-1"
    await store.nodes.Person.create(
      { name: "John", email: "john@example.com" },
      { id: "entity-1" },
    );

    // Attempting to create an Animal with the same ID should fail
    await expect(
      store.nodes.Animal.create({ species: "Dog" }, { id: "entity-1" }),
    ).rejects.toThrow();

    await backend.close();
  });

  it("allows same ID after disjoint node is deleted", async () => {
    const graph = defineGraph({
      id: "disjoint_test_3",
      nodes: {
        Person: { type: Person, onDelete: "cascade" },
        Animal: { type: Animal },
      },
      edges: {},
      ontology: [disjointWith(Person, Animal)],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Create and delete a Person
    const person = await store.nodes.Person.create(
      { name: "John", email: "john@example.com" },
      { id: "entity-1" },
    );
    await store.nodes.Person.delete(person.id);

    // Now we can create an Animal with the same ID
    const animal = await store.nodes.Animal.create(
      { species: "Dog" },
      { id: "entity-1" },
    );
    expect(animal.id).toBe("entity-1");

    await backend.close();
  });
});

// ============================================================
// Delete Behavior Tests
// ============================================================

describe("Delete Behavior - Restrict", () => {
  it("blocks delete when node has connected edges (default)", async () => {
    const graph = defineGraph({
      id: "delete_restrict_test",
      nodes: {
        Person: { type: Person }, // default: restrict
        Organization: { type: Organization },
      },
      edges: {
        worksAt: { type: worksAt, from: [Person], to: [Organization] },
      },
      ontology: [],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Create nodes
    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    const org = await store.nodes.Organization.create({ name: "TechCorp" });

    // Create edge
    await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Organization", id: org.id },
      { role: "Engineer" },
    );

    // Attempting to delete Person should fail due to connected edge
    await expect(store.nodes.Person.delete(person.id)).rejects.toThrow(
      RestrictedDeleteError,
    );

    // Attempting to delete Organization should also fail
    await expect(store.nodes.Organization.delete(org.id)).rejects.toThrow(
      RestrictedDeleteError,
    );

    await backend.close();
  });

  it("allows delete when node has no edges", async () => {
    const graph = defineGraph({
      id: "delete_restrict_no_edges",
      nodes: {
        Person: { type: Person },
      },
      edges: {},
      ontology: [],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    const person = await store.nodes.Person.create({
      name: "Bob",
      email: "bob@example.com",
    });

    // Delete should succeed with no edges
    await store.nodes.Person.delete(person.id);

    // Verify deleted
    const retrieved = await store.nodes.Person.getById(person.id);
    expect(retrieved).toBeUndefined();

    await backend.close();
  });
});

describe("Delete Behavior - Cascade", () => {
  it("deletes connected edges when node is deleted", async () => {
    const graph = defineGraph({
      id: "delete_cascade_test",
      nodes: {
        Person: { type: Person, onDelete: "cascade" },
        Organization: { type: Organization },
      },
      edges: {
        worksAt: { type: worksAt, from: [Person], to: [Organization] },
      },
      ontology: [],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Create nodes
    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    const org1 = await store.nodes.Organization.create({ name: "TechCorp" });
    const org2 = await store.nodes.Organization.create({ name: "StartupInc" });

    // Create edges
    const edge1 = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Organization", id: org1.id },
      {},
    );
    const edge2 = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Organization", id: org2.id },
      {},
    );

    // Delete Person - should cascade to edges
    await store.nodes.Person.delete(person.id);

    // Verify node is deleted
    const personFetched = await store.nodes.Person.getById(person.id);
    expect(personFetched).toBeUndefined();

    // Verify edges are deleted
    const edgeRow1 = await backend.getEdge("delete_cascade_test", edge1.id);
    const edgeRow2 = await backend.getEdge("delete_cascade_test", edge2.id);
    expect(edgeRow1?.deleted_at).toBeDefined();
    expect(edgeRow2?.deleted_at).toBeDefined();

    await backend.close();
  });
});

describe("Delete Behavior - Disconnect", () => {
  it("soft-deletes edges when node is deleted", async () => {
    const graph = defineGraph({
      id: "delete_disconnect_test",
      nodes: {
        Person: { type: Person, onDelete: "disconnect" },
        Organization: { type: Organization },
      },
      edges: {
        worksAt: { type: worksAt, from: [Person], to: [Organization] },
      },
      ontology: [],
    });

    const backend = createTestBackend();
    const store = createStore(graph, backend);

    // Create nodes
    const person = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });
    const org = await store.nodes.Organization.create({ name: "TechCorp" });

    // Create edge
    const edgeResult = await store.edges.worksAt.create(
      { kind: "Person", id: person.id },
      { kind: "Organization", id: org.id },
      {},
    );

    // Delete Person - should disconnect (soft-delete) edges
    await store.nodes.Person.delete(person.id);

    // Verify node is deleted
    const personFetched = await store.nodes.Person.getById(person.id);
    expect(personFetched).toBeUndefined();

    // Verify edge is soft-deleted (has deleted_at)
    const edgeRow = await backend.getEdge(
      "delete_disconnect_test",
      edgeResult.id,
    );
    expect(edgeRow?.deleted_at).toBeDefined();

    // Organization still exists
    const orgFetched = await store.nodes.Organization.getById(org.id);
    expect(orgFetched).toBeDefined();

    await backend.close();
  });
});

// ============================================================
// Edge Relationship Tests
// ============================================================

describe("Edge Relationships - inverseOf", () => {
  it("registry correctly maps inverse edges", () => {
    const graph = defineGraph({
      id: "inverse_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        managedBy: { type: managedBy, from: [Person], to: [Person] },
      },
      ontology: [inverseOf(manages, managedBy)],
    });

    const registry = buildKindRegistry(graph);

    // Check inverse relationship is stored both ways
    expect(registry.getInverseEdge("manages")).toBe("managedBy");
    expect(registry.getInverseEdge("managedBy")).toBe("manages");
  });

  it("returns undefined for edges without inverse", () => {
    const graph = defineGraph({
      id: "no_inverse_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [],
    });

    const registry = buildKindRegistry(graph);

    expect(registry.getInverseEdge("likes")).toBeUndefined();
  });
});

describe("Edge Relationships - implies", () => {
  it("registry computes transitive implication closure", () => {
    const graph = defineGraph({
      id: "implies_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        interactsWith: { type: interactsWith, from: [Person], to: [Person] },
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [
        implies(manages, interactsWith), // manages implies interactsWith
        implies(interactsWith, likes), // interactsWith implies likes
      ],
    });

    const registry = buildKindRegistry(graph);

    // manages implies interactsWith directly
    const managesImplied = registry.getImpliedEdges("manages");
    expect(managesImplied).toContain("interactsWith");

    // manages also implies likes transitively (manages -> interactsWith -> likes)
    expect(managesImplied).toContain("likes");

    // interactsWith only implies likes
    const interactsImplied = registry.getImpliedEdges("interactsWith");
    expect(interactsImplied).toContain("likes");
    expect(interactsImplied).not.toContain("manages");

    // likes implies nothing
    const likesImplied = registry.getImpliedEdges("likes");
    expect(likesImplied).toHaveLength(0);
  });

  it("returns empty array for edges with no implications", () => {
    const graph = defineGraph({
      id: "no_implies_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [],
    });

    const registry = buildKindRegistry(graph);

    expect(registry.getImpliedEdges("likes")).toEqual([]);
  });
});

// ============================================================
// Query-Time Implies Expansion Tests
// ============================================================

describe("Query-Time Implies Expansion", () => {
  it("registry computes implying edges (inverse of implies)", () => {
    const graph = defineGraph({
      id: "implying_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        interactsWith: { type: interactsWith, from: [Person], to: [Person] },
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [
        implies(manages, interactsWith),
        implies(interactsWith, likes),
      ],
    });

    const registry = buildKindRegistry(graph);

    // getImplyingEdges returns edges that imply the given edge
    // likes is implied by interactsWith and manages
    const likesImplying = registry.getImplyingEdges("likes");
    expect(likesImplying).toContain("interactsWith");
    expect(likesImplying).toContain("manages");

    // interactsWith is implied by manages
    const interactsImplying = registry.getImplyingEdges("interactsWith");
    expect(interactsImplying).toContain("manages");
    expect(interactsImplying).not.toContain("likes");

    // manages is not implied by anything
    const managesImplying = registry.getImplyingEdges("manages");
    expect(managesImplying).toHaveLength(0);
  });

  it("expandImplyingEdges returns edge and all implying edges", () => {
    const graph = defineGraph({
      id: "expand_implying_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        interactsWith: { type: interactsWith, from: [Person], to: [Person] },
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [
        implies(manages, interactsWith),
        implies(interactsWith, likes),
      ],
    });

    const registry = buildKindRegistry(graph);

    // Expanding "likes" includes likes, interactsWith, and manages
    const expanded = registry.expandImplyingEdges("likes");
    expect(expanded).toContain("likes");
    expect(expanded).toContain("interactsWith");
    expect(expanded).toContain("manages");
    expect(expanded).toHaveLength(3);
  });

  it("query traverse with includeImplyingEdges expands edge kinds", () => {
    const graph = defineGraph({
      id: "query_implies_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        interactsWith: { type: interactsWith, from: [Person], to: [Person] },
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [
        implies(manages, interactsWith),
        implies(interactsWith, likes),
      ],
    });

    const registry = buildKindRegistry(graph);

    // Create a query that uses includeImplyingEdges
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("likes", "e", { includeImplyingEdges: true })
      .to("Person", "friend")
      .select((context) => ({ person: context.p, friend: context.friend }));

    const ast = query.toAst();

    // The traversal should have expanded edge kinds
    expect(ast.traversals).toHaveLength(1);
    const traversal = ast.traversals[0]!;
    expect(traversal.edgeKinds).toContain("likes");
    expect(traversal.edgeKinds).toContain("interactsWith");
    expect(traversal.edgeKinds).toContain("manages");
  });

  it("query traverse without includeImplyingEdges uses single edge kind", () => {
    const graph = defineGraph({
      id: "query_no_implies_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        manages: { type: manages, from: [Person], to: [Person] },
        likes: { type: likes, from: [Person], to: [Person] },
      },
      ontology: [implies(manages, likes)],
    });

    const registry = buildKindRegistry(graph);

    // Create a query without includeImplyingEdges
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("likes", "e")
      .to("Person", "friend")
      .select((context) => ({ person: context.p, friend: context.friend }));

    const ast = query.toAst();

    // Should only have the exact edge kind
    expect(ast.traversals[0]!.edgeKinds).toEqual(["likes"]);
  });
});

// ============================================================
// Query Expansion Tests
// ============================================================

describe("Query Expansion - Subclasses", () => {
  it("expandSubClasses includes all descendants", () => {
    const graph = defineGraph({
      id: "expansion_test",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
        Nonprofit: { type: Nonprofit },
      },
      edges: {},
      ontology: [
        subClassOf(Company, Organization),
        subClassOf(Nonprofit, Organization),
      ],
    });

    const registry = buildKindRegistry(graph);

    // Organization expands to include Company and Nonprofit
    const expanded = registry.expandSubClasses("Organization");
    expect(expanded).toContain("Organization");
    expect(expanded).toContain("Company");
    expect(expanded).toContain("Nonprofit");
    expect(expanded).toHaveLength(3);
  });

  it("expandSubClasses returns only self for leaf nodes", () => {
    const graph = defineGraph({
      id: "expansion_leaf_test",
      nodes: {
        Organization: { type: Organization },
        Company: { type: Company },
      },
      edges: {},
      ontology: [subClassOf(Company, Organization)],
    });

    const registry = buildKindRegistry(graph);

    // Company has no subclasses, expands to just itself
    const expanded = registry.expandSubClasses("Company");
    expect(expanded).toEqual(["Company"]);
  });

  it("expandSubClasses handles transitive hierarchy", () => {
    // Create a deeper hierarchy: GrandChild <- Child <- Parent
    const Parent = defineNode("Parent", {
      schema: z.object({ name: z.string() }),
    });
    const Child = defineNode("Child", {
      schema: z.object({ name: z.string() }),
    });
    const GrandChild = defineNode("GrandChild", {
      schema: z.object({ name: z.string() }),
    });

    const graph = defineGraph({
      id: "expansion_transitive_test",
      nodes: {
        Parent: { type: Parent },
        Child: { type: Child },
        GrandChild: { type: GrandChild },
      },
      edges: {},
      ontology: [subClassOf(Child, Parent), subClassOf(GrandChild, Child)],
    });

    const registry = buildKindRegistry(graph);

    // Parent expands to include Child and GrandChild transitively
    const expanded = registry.expandSubClasses("Parent");
    expect(expanded).toContain("Parent");
    expect(expanded).toContain("Child");
    expect(expanded).toContain("GrandChild");
    expect(expanded).toHaveLength(3);

    // Child expands to include GrandChild
    const childExpanded = registry.expandSubClasses("Child");
    expect(childExpanded).toContain("Child");
    expect(childExpanded).toContain("GrandChild");
    expect(childExpanded).toHaveLength(2);
  });
});
