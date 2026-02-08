/**
 * Constraint Enforcement Tests
 *
 * Tests cardinality enforcement on edges and uniqueness constraint handling
 * for node updates and deletes.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, subClassOf } from "../src";
import type { GraphBackend } from "../src/backend/types";
import { CardinalityError } from "../src/errors";
import { createStore } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema - Cardinality Constraints
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
  }),
});

const Department = defineNode("Department", {
  schema: z.object({
    name: z.string(),
  }),
});

const Passport = defineNode("Passport", {
  schema: z.object({
    number: z.string(),
    country: z.string(),
  }),
});

// Edge: Person can have at most ONE passport (cardinality: "one")
const hasPassport = defineEdge("hasPassport");

// Edge: Person can belong to many departments, but only one at a time (cardinality: "oneActive")
const belongsTo = defineEdge("belongsTo", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

// Edge: Person can know many people, but each pair is unique (cardinality: "unique")
const knows = defineEdge("knows");

// Edge: Person can have many projects (cardinality: "many")
const worksOn = defineEdge("worksOn");

const cardinalityGraph = defineGraph({
  id: "cardinality_test",
  nodes: {
    Person: { type: Person },
    Department: { type: Department },
    Passport: { type: Passport },
  },
  edges: {
    hasPassport: {
      type: hasPassport,
      from: [Person],
      to: [Passport],
      cardinality: "one",
    },
    belongsTo: {
      type: belongsTo,
      from: [Person],
      to: [Department],
      cardinality: "oneActive",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "unique",
    },
    worksOn: {
      type: worksOn,
      from: [Person],
      to: [Department],
      cardinality: "many",
    },
  },
  ontology: [],
});

// ============================================================
// Test Schema - Uniqueness Constraints
// ============================================================

const User = defineNode("User", {
  schema: z.object({
    username: z.string(),
    email: z.email(),
    status: z.enum(["active", "inactive"]).optional(),
  }),
});

const follows = defineEdge("follows");

const uniquenessGraph = defineGraph({
  id: "uniqueness_test",
  nodes: {
    User: {
      type: User,
      unique: [
        {
          name: "unique_username",
          fields: ["username"],
          scope: "kind",
          collation: "binary",
        },
        {
          name: "unique_email",
          fields: ["email"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
  },
  edges: {
    follows: {
      type: follows,
      from: [User],
      to: [User],
      cardinality: "many",
    },
  },
  ontology: [],
});

// ============================================================
// Cardinality Constraint Tests
// ============================================================

describe("Cardinality Enforcement", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  describe('cardinality: "one"', () => {
    it("allows creating first edge from source", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const passport = await store.nodes.Passport.create({
        number: "ABC123",
        country: "USA",
      });

      const edgeResult = await store.edges.hasPassport.create(
        { kind: "Person", id: person.id },
        { kind: "Passport", id: passport.id },
        {},
      );

      expect(edgeResult.kind).toBe("hasPassport");
    });

    it("blocks second edge from same source", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const passport1 = await store.nodes.Passport.create({
        number: "ABC123",
        country: "USA",
      });
      const passport2 = await store.nodes.Passport.create({
        number: "XYZ789",
        country: "UK",
      });

      // First edge should succeed
      await store.edges.hasPassport.create(
        { kind: "Person", id: person.id },
        { kind: "Passport", id: passport1.id },
        {},
      );

      // Second edge should fail
      await expect(
        store.edges.hasPassport.create(
          { kind: "Person", id: person.id },
          { kind: "Passport", id: passport2.id },
          {},
        ),
      ).rejects.toThrow(CardinalityError);
    });

    it("allows edges from different sources", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person1 = await store.nodes.Person.create({ name: "Alice" });
      const person2 = await store.nodes.Person.create({ name: "Bob" });
      const passport1 = await store.nodes.Passport.create({
        number: "ABC123",
        country: "USA",
      });
      const passport2 = await store.nodes.Passport.create({
        number: "XYZ789",
        country: "UK",
      });

      // Both should succeed since they're from different sources
      await store.edges.hasPassport.create(
        { kind: "Person", id: person1.id },
        { kind: "Passport", id: passport1.id },
        {},
      );

      await store.edges.hasPassport.create(
        { kind: "Person", id: person2.id },
        { kind: "Passport", id: passport2.id },
        {},
      );
    });
  });

  describe('cardinality: "unique"', () => {
    it("allows first edge between source-target pair", async () => {
      const store = createStore(cardinalityGraph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      const edgeResult = await store.edges.knows.create(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: bob.id },
        {},
      );

      expect(edgeResult.kind).toBe("knows");
    });

    it("blocks duplicate edge between same source-target pair", async () => {
      const store = createStore(cardinalityGraph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      // First edge should succeed
      await store.edges.knows.create(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: bob.id },
        {},
      );

      // Second edge between same pair should fail
      await expect(
        store.edges.knows.create(
          { kind: "Person", id: alice.id },
          { kind: "Person", id: bob.id },
          {},
        ),
      ).rejects.toThrow(CardinalityError);
    });

    it("allows edges to different targets from same source", async () => {
      const store = createStore(cardinalityGraph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const charlie = await store.nodes.Person.create({ name: "Charlie" });

      // Both should succeed since targets are different
      await store.edges.knows.create(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: bob.id },
        {},
      );

      await store.edges.knows.create(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: charlie.id },
        {},
      );
    });

    it("allows edge in reverse direction", async () => {
      const store = createStore(cardinalityGraph, backend);

      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      // Alice knows Bob
      await store.edges.knows.create(
        { kind: "Person", id: alice.id },
        { kind: "Person", id: bob.id },
        {},
      );

      // Bob knows Alice (reverse direction, should succeed)
      await store.edges.knows.create(
        { kind: "Person", id: bob.id },
        { kind: "Person", id: alice.id },
        {},
      );
    });
  });

  describe('cardinality: "oneActive"', () => {
    it("allows creating first active edge", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const dept = await store.nodes.Department.create({ name: "Engineering" });

      const edgeResult = await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept.id },
        { role: "Engineer" },
      );

      expect(edgeResult.kind).toBe("belongsTo");
      expect(edgeResult.meta.validTo).toBeUndefined();
    });

    it("blocks second active edge from same source", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const dept1 = await store.nodes.Department.create({
        name: "Engineering",
      });
      const dept2 = await store.nodes.Department.create({ name: "Marketing" });

      // First active edge should succeed
      await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept1.id },
        {},
      );

      // Second active edge should fail
      await expect(
        store.edges.belongsTo.create(
          { kind: "Person", id: person.id },
          { kind: "Department", id: dept2.id },
          {},
        ),
      ).rejects.toThrow(CardinalityError);
    });

    it("allows multiple edges if previous ones are ended", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const dept1 = await store.nodes.Department.create({
        name: "Engineering",
      });
      const dept2 = await store.nodes.Department.create({ name: "Marketing" });

      // Create first edge and immediately end it
      const edge1 = await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept1.id },
        {},
        { validTo: new Date().toISOString() },
      );

      expect(edge1.meta.validTo).toBeDefined();

      // Now create second active edge - should succeed
      const edge2 = await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept2.id },
        {},
      );

      expect(edge2.meta.validTo).toBeUndefined();
    });

    it("allows creating ended edge when active exists", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });
      const dept1 = await store.nodes.Department.create({
        name: "Engineering",
      });
      const dept2 = await store.nodes.Department.create({ name: "Marketing" });

      // Create active edge
      await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept1.id },
        {},
      );

      // Create ended edge - should succeed since it's not active
      const endedEdge = await store.edges.belongsTo.create(
        { kind: "Person", id: person.id },
        { kind: "Department", id: dept2.id },
        {},
        { validTo: new Date().toISOString() },
      );

      expect(endedEdge.meta.validTo).toBeDefined();
    });
  });

  describe('cardinality: "many"', () => {
    it("allows unlimited edges from same source", async () => {
      const store = createStore(cardinalityGraph, backend);

      const person = await store.nodes.Person.create({ name: "Alice" });

      // Create multiple departments
      const departments = await Promise.all(
        ["Eng", "Marketing", "Sales", "Support"].map((name) =>
          store.nodes.Department.create({ name }),
        ),
      );

      // Create edges to all departments
      const edges = await Promise.all(
        departments.map((dept) =>
          store.edges.worksOn.create(
            { kind: "Person", id: person.id },
            { kind: "Department", id: dept.id },
            {},
          ),
        ),
      );

      expect(edges).toHaveLength(4);
    });
  });
});

// ============================================================
// Uniqueness Constraint Tests
// ============================================================

describe("Uniqueness Constraints", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  describe("Node Update - Unique Field Changes", () => {
    it("allows update that doesn't change unique field", async () => {
      const store = createStore(uniquenessGraph, backend);

      const user = await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      // Update non-unique field
      const updated = await store.nodes.User.update(user.id, {
        status: "active",
      });

      expect(updated.status).toBe("active");
    });

    it("allows update to unique field with no conflict", async () => {
      const store = createStore(uniquenessGraph, backend);

      const user = await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      // Update username to a new unique value
      const updated = await store.nodes.User.update(user.id, {
        username: "alice_new",
      });

      expect(updated.username).toBe("alice_new");
    });

    it("blocks update that creates unique conflict", async () => {
      const store = createStore(uniquenessGraph, backend);

      await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      const bob = await store.nodes.User.create({
        username: "bob",
        email: "bob@example.com",
      });

      // Try to change Bob's username to Alice's - should fail
      await expect(
        store.nodes.User.update(bob.id, { username: "alice" }),
      ).rejects.toThrow("Uniqueness violation");
    });

    it("handles case-insensitive uniqueness on update", async () => {
      const store = createStore(uniquenessGraph, backend);

      await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      const bob = await store.nodes.User.create({
        username: "bob",
        email: "bob@example.com",
      });

      // Try to change Bob's email to Alice's with different case - should fail
      await expect(
        store.nodes.User.update(bob.id, { email: "ALICE@EXAMPLE.COM" }),
      ).rejects.toThrow("Uniqueness violation");
    });
  });

  describe("Node Delete - Unique Entry Cleanup", () => {
    it("cleans up unique entries on delete", async () => {
      const store = createStore(uniquenessGraph, backend);

      const user = await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      // Delete the user
      await store.nodes.User.delete(user.id);

      // Now another user should be able to use the same username
      const newUser = await store.nodes.User.create({
        username: "alice",
        email: "newalice@example.com",
      });

      expect(newUser.username).toBe("alice");
    });

    it("cleans up unique email entry on delete", async () => {
      const store = createStore(uniquenessGraph, backend);

      const user = await store.nodes.User.create({
        username: "alice",
        email: "alice@example.com",
      });

      await store.nodes.User.delete(user.id);

      // New user can use same email
      const newUser = await store.nodes.User.create({
        username: "alice2",
        email: "alice@example.com",
      });

      expect(newUser.email).toBe("alice@example.com");
    });

    it("allows reuse of unique value after delete", async () => {
      const store = createStore(uniquenessGraph, backend);

      // Create and delete user
      const user1 = await store.nodes.User.create({
        username: "recycled_name",
        email: "user1@example.com",
      });
      await store.nodes.User.delete(user1.id);

      // Create new user with same username
      const user2 = await store.nodes.User.create({
        username: "recycled_name",
        email: "user2@example.com",
      });
      await store.nodes.User.delete(user2.id);

      // Create third user with same username
      const user3 = await store.nodes.User.create({
        username: "recycled_name",
        email: "user3@example.com",
      });

      expect(user3.username).toBe("recycled_name");
    });
  });
});

// ============================================================
// Uniqueness Scope Tests - Subclass Hierarchy
// ============================================================

const BaseEntity = defineNode("BaseEntity", {
  schema: z.object({
    code: z.string(),
    name: z.string(),
  }),
});

const Product = defineNode("Product", {
  schema: z.object({
    code: z.string(),
    name: z.string(),
    price: z.number(),
  }),
});

const Service = defineNode("Service", {
  schema: z.object({
    code: z.string(),
    name: z.string(),
    duration: z.number(),
  }),
});

const scopeGraph = defineGraph({
  id: "scope_test",
  nodes: {
    BaseEntity: {
      type: BaseEntity,
      unique: [
        {
          name: "unique_code_across_subclasses",
          fields: ["code"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    Product: {
      type: Product,
      unique: [
        {
          name: "unique_code_across_subclasses",
          fields: ["code"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    Service: {
      type: Service,
      unique: [
        {
          name: "unique_code_across_subclasses",
          fields: ["code"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
  ontology: [subClassOf(Product, BaseEntity), subClassOf(Service, BaseEntity)],
});

describe("Uniqueness Scope: kindWithSubClasses", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("allows same code in unrelated kinds", async () => {
    const store = createStore(scopeGraph, backend);

    // Create a base entity with code "ABC"
    await store.nodes.BaseEntity.create({ code: "ABC", name: "Base ABC" });

    // Create a Product with the same code - should fail because Product is subclass of BaseEntity
    await expect(
      store.nodes.Product.create({
        code: "ABC",
        name: "Product ABC",
        price: 100,
      }),
    ).rejects.toThrow("Uniqueness violation");
  });

  it("blocks duplicate code across sibling subclasses", async () => {
    const store = createStore(scopeGraph, backend);

    // Create a Product with code "XYZ"
    await store.nodes.Product.create({
      code: "XYZ",
      name: "Product XYZ",
      price: 50,
    });

    // Create a Service with the same code - should fail (siblings via BaseEntity)
    await expect(
      store.nodes.Service.create({
        code: "XYZ",
        name: "Service XYZ",
        duration: 60,
      }),
    ).rejects.toThrow("Uniqueness violation");
  });

  it("blocks duplicate code in same subclass", async () => {
    const store = createStore(scopeGraph, backend);

    await store.nodes.Product.create({
      code: "PROD1",
      name: "First Product",
      price: 25,
    });

    await expect(
      store.nodes.Product.create({
        code: "PROD1",
        name: "Second Product",
        price: 30,
      }),
    ).rejects.toThrow("Uniqueness violation");
  });

  it("allows different codes across subclasses", async () => {
    const store = createStore(scopeGraph, backend);

    const product = await store.nodes.Product.create({
      code: "PROD-A",
      name: "Product A",
      price: 100,
    });

    const service = await store.nodes.Service.create({
      code: "SERV-B",
      name: "Service B",
      duration: 30,
    });

    expect(product.code).toBe("PROD-A");
    expect(service.code).toBe("SERV-B");
  });

  it("allows reuse of code after delete", async () => {
    const store = createStore(scopeGraph, backend);

    const product = await store.nodes.Product.create({
      code: "REUSE-CODE",
      name: "Original Product",
      price: 50,
    });

    await store.nodes.Product.delete(product.id);

    // Now a Service should be able to use the same code
    const service = await store.nodes.Service.create({
      code: "REUSE-CODE",
      name: "New Service",
      duration: 45,
    });

    expect(service.code).toBe("REUSE-CODE");
  });
});
