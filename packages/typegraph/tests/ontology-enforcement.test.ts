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
  defineGraphExtension,
  defineNode,
  disjointWith,
  implies,
  inverseOf,
  subClassOf,
} from "../src";
import { ConfigurationError, RestrictedDeleteError } from "../src/errors";
import { buildKindRegistry } from "../src/registry/builders";
import { deserializeSchema, serializeSchema } from "../src/schema";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
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
// implies() Endpoint Compatibility Validation (issue #239)
// ============================================================

describe("implies() Endpoint Compatibility Validation", () => {
  it("rejects an implication whose endpoints share no compatible kind on either side", () => {
    // Reproduces #239: about (Paper -> Topic) implying writes (Author -> Paper)
    // has no relationship between {Paper} and {Author}, nor {Topic} and {Paper}.
    const Author = defineNode("Author", {
      schema: z.object({ name: z.string() }),
    });
    const Paper = defineNode("Paper", {
      schema: z.object({ title: z.string() }),
    });
    const Topic = defineNode("Topic", {
      schema: z.object({ name: z.string() }),
    });

    const writes = defineEdge("writes", { schema: z.object({}) });
    const about = defineEdge("about", { schema: z.object({}) });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_endpoint_repro",
          nodes: {
            Author: { type: Author },
            Paper: { type: Paper },
            Topic: { type: Topic },
          },
          edges: {
            writes: { type: writes, from: [Author], to: [Paper] },
            about: { type: about, from: [Paper], to: [Topic] },
          },
          ontology: [implies(about, writes)],
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("rejects an implication that is only incompatible on the 'to' side", () => {
    const Person = defineNode("PersonEp", { schema: z.object({}) });
    const Document = defineNode("DocumentEp", { schema: z.object({}) });
    const Report = defineNode("ReportEp", { schema: z.object({}) });

    const authored = defineEdge("authored", { schema: z.object({}) });
    const filed = defineEdge("filed", { schema: z.object({}) });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_to_mismatch",
          nodes: {
            Person: { type: Person },
            Document: { type: Document },
            Report: { type: Report },
          },
          edges: {
            authored: { type: authored, from: [Person], to: [Document] },
            filed: { type: filed, from: [Person], to: [Report] },
          },
          ontology: [implies(authored, filed)],
        }),
      ),
    ).toThrow(/endpoint-incompatible/);
  });

  it("accepts an implication when the implying edge's endpoint is a subclass of the implied edge's endpoint", () => {
    const Organization = defineNode("OrganizationEp", { schema: z.object({}) });
    const Company = defineNode("CompanyEp", { schema: z.object({}) });
    const Person = defineNode("PersonEp2", { schema: z.object({}) });

    const employedBy = defineEdge("employedBy", { schema: z.object({}) });
    const affiliatedWith = defineEdge("affiliatedWith", {
      schema: z.object({}),
    });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_subclass_ok",
          nodes: {
            Organization: { type: Organization },
            Company: { type: Company },
            Person: { type: Person },
          },
          edges: {
            employedBy: { type: employedBy, from: [Person], to: [Company] },
            affiliatedWith: {
              type: affiliatedWith,
              from: [Person],
              to: [Organization],
            },
          },
          ontology: [
            subClassOf(Company, Organization),
            implies(employedBy, affiliatedWith),
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("requires every implying-side kind to be assignable, not just some", () => {
    const Organization = defineNode("OrganizationEp2", {
      schema: z.object({}),
    });
    const Company = defineNode("CompanyEp2", { schema: z.object({}) });

    // memberOf allows Company OR Organization as its source; affiliatedWith
    // only allows Company. Organization is not a Company (and not declared
    // as its subclass), so this must fail even though Company alone would pass.
    const memberOf = defineEdge("memberOf", { schema: z.object({}) });
    const affiliatedWith = defineEdge("affiliatedWith2", {
      schema: z.object({}),
    });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_partial_mismatch",
          nodes: {
            Organization: { type: Organization },
            Company: { type: Company },
          },
          edges: {
            memberOf: {
              type: memberOf,
              from: [Company, Organization],
              to: [Company],
            },
            affiliatedWith2: {
              type: affiliatedWith,
              from: [Company],
              to: [Company],
            },
          },
          ontology: [
            subClassOf(Company, Organization),
            implies(memberOf, affiliatedWith),
          ],
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("does not validate ontology relations naming an edge kind not registered on the graph", () => {
    const Person = defineNode("PersonEp5", { schema: z.object({}) });

    // "about" is a real EdgeType but is never added to this graph's `edges`
    // — its declared endpoints can't affect this graph's traversals, so the
    // relation is inert rather than validated.
    const about = defineEdge("aboutEp", { schema: z.object({}) });
    const knowsEp = defineEdge("knowsEp", { schema: z.object({}) });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_unregistered_edge",
          nodes: { Person: { type: Person } },
          edges: {
            knowsEp: { type: knowsEp, from: [Person], to: [Person] },
          },
          ontology: [implies(about, knowsEp)],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects an implies() relation whose endpoints are plain kind-name strings, as graph-extension-authored relations carry", () => {
    // compileOntologyRelation (graph-extension/compiler.ts) resolves an
    // implies() relation's endpoints to plain edge-kind-name strings, not
    // EdgeType objects — the shape store.evolve({ ontology }) produces.
    // Simulate that shape directly rather than round-tripping through the
    // full extension-merge pipeline.
    const Author = defineNode("AuthorStr", { schema: z.object({}) });
    const Paper = defineNode("PaperStr", { schema: z.object({}) });
    const Topic = defineNode("TopicStr", { schema: z.object({}) });

    const writes = defineEdge("writesStr", { schema: z.object({}) });
    const about = defineEdge("aboutStr", { schema: z.object({}) });
    const impliesMetaEdge = implies(writes, about).metaEdge;

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_string_endpoints",
          nodes: {
            Author: { type: Author },
            Paper: { type: Paper },
            Topic: { type: Topic },
          },
          edges: {
            writesStr: { type: writes, from: [Author], to: [Paper] },
            aboutStr: { type: about, from: [Paper], to: [Topic] },
          },
          ontology: [
            { metaEdge: impliesMetaEdge, from: "aboutStr", to: "writesStr" },
          ],
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it("enforces the same validation when a registry is rebuilt from a persisted schema", () => {
    const Author = defineNode("AuthorDs", { schema: z.object({}) });
    const Paper = defineNode("PaperDs", { schema: z.object({}) });
    const Topic = defineNode("TopicDs", { schema: z.object({}) });

    const writes = defineEdge("writesDs", { schema: z.object({}) });
    const about = defineEdge("aboutDs", { schema: z.object({}) });

    // defineGraph() alone never validates implies() endpoints (only
    // buildKindRegistry does), so this graph can be constructed and
    // serialized without ever going through createStore.
    const graph = defineGraph({
      id: "implies_deserialized",
      nodes: {
        Author: { type: Author },
        Paper: { type: Paper },
        Topic: { type: Topic },
      },
      edges: {
        writesDs: { type: writes, from: [Author], to: [Paper] },
        aboutDs: { type: about, from: [Paper], to: [Topic] },
      },
      ontology: [implies(about, writes)],
    });

    const serialized = serializeSchema(graph, 1);

    expect(() => deserializeSchema(serialized).buildRegistry()).toThrow(
      ConfigurationError,
    );
  });

  it("does not crash when an unregistered edge kind collides with an Object.prototype member name", () => {
    const Person = defineNode("PersonProto", { schema: z.object({}) });

    // "toString" is never added to this graph's `edges` — the lookup must
    // resolve to undefined (correctly skipped), not to the inherited
    // Object.prototype.toString function.
    const toStringEdge = defineEdge("toString", { schema: z.object({}) });
    const knowsProto = defineEdge("knowsProto", { schema: z.object({}) });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_prototype_collision",
          nodes: { Person: { type: Person } },
          edges: {
            knowsProto: { type: knowsProto, from: [Person], to: [Person] },
          },
          ontology: [implies(toStringEdge, knowsProto)],
        }),
      ),
    ).not.toThrow();
  });

  it("error message scopes the incompatible kinds without implying they are the edge's full allowed set", () => {
    const Organization = defineNode("OrganizationMsg", {
      schema: z.object({}),
    });
    const Company = defineNode("CompanyMsg", { schema: z.object({}) });

    const memberOf = defineEdge("memberOfMsg", { schema: z.object({}) });
    const affiliatedWith = defineEdge("affiliatedWithMsg", {
      schema: z.object({}),
    });

    expect(
      () =>
        buildKindRegistry(
          defineGraph({
            id: "implies_message_scope",
            nodes: {
              Organization: { type: Organization },
              Company: { type: Company },
            },
            edges: {
              memberOfMsg: {
                type: memberOf,
                from: [Company, Organization],
                to: [Company],
              },
              affiliatedWithMsg: {
                type: affiliatedWith,
                from: [Company],
                to: [Company],
              },
            },
            ontology: [
              subClassOf(Company, Organization),
              implies(memberOf, affiliatedWith),
            ],
          }),
        ),
      // Company is compatible (subClassOf Organization is irrelevant here —
      // Company matches affiliatedWith's Company directly); only
      // Organization is incompatible. The message must not read as if
      // Organization were memberOf's only allowed "from" kind.
    ).toThrow(
      /from kind\(s\) \[OrganizationMsg\] declared on "memberOfMsg" cannot be assigned/,
    );
  });

  it("createStoreWithSchema rejects a bad implies() relation before committing any schema version", async () => {
    const AuthorCommit = defineNode("AuthorCommit", { schema: z.object({}) });
    const PaperCommit = defineNode("PaperCommit", { schema: z.object({}) });
    const TopicCommit = defineNode("TopicCommit", { schema: z.object({}) });

    const writes = defineEdge("writesCommit", { schema: z.object({}) });
    const about = defineEdge("aboutCommit", { schema: z.object({}) });

    const graph = defineGraph({
      id: "implies_no_commit_on_reject",
      nodes: {
        AuthorCommit: { type: AuthorCommit },
        PaperCommit: { type: PaperCommit },
        TopicCommit: { type: TopicCommit },
      },
      edges: {
        writesCommit: {
          type: writes,
          from: [AuthorCommit],
          to: [PaperCommit],
        },
        aboutCommit: { type: about, from: [PaperCommit], to: [TopicCommit] },
      },
      ontology: [implies(about, writes)],
    });

    const backend = createTestBackend();

    await expect(createStoreWithSchema(graph, backend)).rejects.toThrow(
      ConfigurationError,
    );

    // The rejection must happen before the schema is durably committed —
    // otherwise the invalid schema becomes the "active" version and every
    // subsequent store construction against it throws forever, with no
    // way to recover short of a manual rollback.
    expect(await backend.getActiveSchema(graph.id)).toBeUndefined();

    await backend.close();
  });

  it("store.evolve() rejects a bad implies() relation before committing a new schema version", async () => {
    const AuthorEvolveCommit = defineNode("AuthorEvolveCommit", {
      schema: z.object({}),
    });
    const PaperEvolveCommit = defineNode("PaperEvolveCommit", {
      schema: z.object({}),
    });
    const TopicEvolveCommit = defineNode("TopicEvolveCommit", {
      schema: z.object({}),
    });

    const writes = defineEdge("writesEvolveCommit", { schema: z.object({}) });
    const about = defineEdge("aboutEvolveCommit", { schema: z.object({}) });

    // The compile-time graph is valid on its own — no implies() yet.
    const graph = defineGraph({
      id: "implies_evolve_no_commit_on_reject",
      nodes: {
        AuthorEvolveCommit: { type: AuthorEvolveCommit },
        PaperEvolveCommit: { type: PaperEvolveCommit },
        TopicEvolveCommit: { type: TopicEvolveCommit },
      },
      edges: {
        writesEvolveCommit: {
          type: writes,
          from: [AuthorEvolveCommit],
          to: [PaperEvolveCommit],
        },
        aboutEvolveCommit: {
          type: about,
          from: [PaperEvolveCommit],
          to: [TopicEvolveCommit],
        },
      },
    });

    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend);
    const initialRow = await backend.getActiveSchema(graph.id);
    expect(initialRow?.version).toBe(1);

    // Graph-extension-authored implies() relations carry plain edge-kind
    // name strings rather than EdgeType objects — this reproduces #239's
    // other real-world trigger (store.evolve, not compile-time implies()).
    const badExtension = defineGraphExtension({
      ontology: [
        {
          metaEdge: "implies",
          from: "aboutEvolveCommit",
          to: "writesEvolveCommit",
        },
      ],
    });

    await expect(store.evolve(badExtension)).rejects.toThrow(
      ConfigurationError,
    );

    // No new schema version was committed — the active version is still 1.
    const rowAfterRejectedEvolve = await backend.getActiveSchema(graph.id);
    expect(rowAfterRejectedEvolve?.version).toBe(1);

    await backend.close();
  });

  it("rejects an implies() chain that bridges incompatible endpoints through an UNREGISTERED intermediate edge", () => {
    // Transitivity hole: `writes` (Author -> Paper) implies an intermediate
    // `about` edge that is NOT registered on the graph, which in turn implies
    // `likes` (Reader -> Reader). Both direct hops touch the unregistered
    // `about`, so a per-direct-relation gate would skip BOTH — yet the
    // precomputed transitive closure still folds `writes` rows into any
    // `expand: "implying"` traversal of `likes`, even though Author/Paper are
    // endpoint-incompatible with Reader. The gate must validate the effective
    // closure, not rely on each direct hop being individually checkable.
    const Author = defineNode("AuthorBridge", { schema: z.object({}) });
    const Paper = defineNode("PaperBridge", { schema: z.object({}) });
    const Reader = defineNode("ReaderBridge", { schema: z.object({}) });

    const writes = defineEdge("writesBridge", { schema: z.object({}) });
    // `about` is intentionally never added to the graph's `edges`.
    const about = defineEdge("aboutBridge", { schema: z.object({}) });
    const likes = defineEdge("likesBridge", { schema: z.object({}) });

    expect(() =>
      buildKindRegistry(
        defineGraph({
          id: "implies_transitive_bridge",
          nodes: {
            Author: { type: Author },
            Paper: { type: Paper },
            Reader: { type: Reader },
          },
          edges: {
            writesBridge: { type: writes, from: [Author], to: [Paper] },
            likesBridge: { type: likes, from: [Reader], to: [Reader] },
          },
          ontology: [implies(writes, about), implies(about, likes)],
        }),
      ),
    ).toThrow(ConfigurationError);
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

  it("query traverse with expand: implying expands edge kinds", () => {
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

    // Create a query that uses implying-edge expansion
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("likes", "e", { expand: "implying" })
      .to("Person", "friend")
      .select((context) => ({ person: context.p, friend: context.friend }));

    const ast = query.toAst();

    // The traversal should have expanded edge kinds
    expect(ast.traversals).toHaveLength(1);
    const traversal = requireDefined(ast.traversals[0]);
    expect(traversal.edgeKinds).toContain("likes");
    expect(traversal.edgeKinds).toContain("interactsWith");
    expect(traversal.edgeKinds).toContain("manages");
  });

  it("query traverse with expand: inverse expands inverse edge kinds", () => {
    const likedBy = defineEdge("likedBy", {
      schema: z.object({}),
    });

    const graph = defineGraph({
      id: "query_inverse_test",
      nodes: {
        Person: { type: Person },
      },
      edges: {
        likes: { type: likes, from: [Person], to: [Person] },
        likedBy: { type: likedBy, from: [Person], to: [Person] },
      },
      ontology: [inverseOf(likes, likedBy)],
    });

    const registry = buildKindRegistry(graph);

    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("likes", "e", { expand: "inverse" })
      .to("Person", "friend")
      .select((context) => ({ person: context.p, friend: context.friend }));

    const traversal = requireDefined(query.toAst().traversals[0]);

    expect(traversal.edgeKinds).toEqual(["likes"]);
    expect(traversal.inverseEdgeKinds).toEqual(["likedBy"]);
  });

  it("query traverse without implying expansion uses single edge kind", () => {
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

    // Create a query without implying-edge expansion
    const query = createQueryBuilder<typeof graph>(graph.id, registry)
      .from("Person", "p")
      .traverse("likes", "e")
      .to("Person", "friend")
      .select((context) => ({ person: context.p, friend: context.friend }));

    const ast = query.toAst();

    // Should only have the exact edge kind
    expect(requireDefined(ast.traversals[0]).edgeKinds).toEqual(["likes"]);
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
