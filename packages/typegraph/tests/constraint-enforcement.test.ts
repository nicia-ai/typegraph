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
import { checkWherePredicate, computeUniqueKey } from "../src/constraints";
import { type UniqueConstraint } from "../src/core/types";
import {
  CardinalityError,
  ConfigurationError,
  UniquenessError,
} from "../src/errors";
import { buildKindRegistry } from "../src/registry";
import { createStore } from "../src/store";
import {
  checkUniquenessConstraints,
  createUniquenessContext,
  insertUniquenessEntries,
} from "../src/store/uniqueness";
import { requireDefined } from "../src/utils/presence";
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

// ============================================================
// Uniqueness Over Fields Named After Prototype Members
// ============================================================

/**
 * A schema may DECLARE a field named after an `Object.prototype` member —
 * `toString` below is an ordinary optional string field. When such a field is
 * absent from a props bag, every constraint decision about it must read the
 * bag's OWN keys; a plain `props.toString` read finds the inherited function
 * and treats an absent field as a present value.
 */
const Entry = defineNode("Entry", {
  schema: z.object({
    label: z.string(),
    toString: z.string().optional(),
  }),
});

function protoNamedGraph(id: string, collation: "binary" | "caseInsensitive") {
  return defineGraph({
    id,
    nodes: {
      Entry: {
        type: Entry,
        unique: [
          {
            name: "unique_to_string",
            fields: ["toString"],
            scope: "kind",
            collation,
          },
        ],
      },
    },
    edges: {},
    ontology: [],
  });
}

const binaryProtoGraph = protoNamedGraph("proto_named_binary", "binary");
const insensitiveProtoGraph = protoNamedGraph(
  "proto_named_insensitive",
  "caseInsensitive",
);

/** The `where`-less constraint list `defineGraph` normalized for `Entry`. */
function protoNamedConstraints(graph: typeof binaryProtoGraph) {
  return graph.nodes.Entry.unique;
}

describe("Uniqueness key for a field named after a prototype member", () => {
  const absent: Record<string, unknown> = { label: "first" };
  const otherAbsent: Record<string, unknown> = { label: "second" };
  const explicitlyUndefined: Record<string, unknown> = {
    label: "first",
    toString: undefined,
  };

  it("keys an absent field as absent under binary collation", () => {
    const key = computeUniqueKey(absent, ["toString"], "binary");

    // The inherited `Object.prototype.toString` is a function, which
    // `JSON.stringify` drops — reading it produced the empty key.
    expect(key).not.toBe("");
    expect(key).toBe(
      computeUniqueKey(explicitlyUndefined, ["toString"], "binary"),
    );
  });

  it("keys an absent field as absent under caseInsensitive collation", () => {
    // Reading the inherited function here threw
    // "Cannot read properties of undefined (reading 'toLowerCase')".
    expect(() =>
      computeUniqueKey(absent, ["toString"], "caseInsensitive"),
    ).not.toThrow();
    expect(computeUniqueKey(absent, ["toString"], "caseInsensitive")).toBe(
      computeUniqueKey(absent, ["toString"], "binary"),
    );
  });

  it("collides two bags that both omit the field", () => {
    for (const collation of ["binary", "caseInsensitive"] as const) {
      expect(computeUniqueKey(absent, ["toString"], collation)).toBe(
        computeUniqueKey(otherAbsent, ["toString"], collation),
      );
    }
  });

  it("keeps distinct present values distinct, and distinct from absence", () => {
    const present = { label: "first", toString: "alpha" };
    const otherPresent = { label: "second", toString: "beta" };

    for (const collation of ["binary", "caseInsensitive"] as const) {
      expect(computeUniqueKey(present, ["toString"], collation)).not.toBe(
        computeUniqueKey(otherPresent, ["toString"], collation),
      );
      expect(computeUniqueKey(present, ["toString"], collation)).not.toBe(
        computeUniqueKey(absent, ["toString"], collation),
      );
    }

    // Case folding still applies to a present value.
    expect(
      computeUniqueKey(
        { label: "first", toString: "ALPHA" },
        ["toString"],
        "caseInsensitive",
      ),
    ).toBe(computeUniqueKey(present, ["toString"], "caseInsensitive"));
  });
});

describe("Uniqueness sidecar for a field named after a prototype member", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  function contextFor(graph: typeof binaryProtoGraph) {
    return createUniquenessContext(graph.id, buildKindRegistry(graph), backend);
  }

  for (const graph of [binaryProtoGraph, insensitiveProtoGraph]) {
    const collation = protoNamedConstraints(graph)[0].collation;

    it(`refuses a second node that also omits the field (${collation})`, async () => {
      const ctx = contextFor(graph);
      const constraints = protoNamedConstraints(graph);

      await insertUniquenessEntries(
        ctx,
        "Entry",
        "entry-1",
        { label: "first" },
        constraints,
      );

      await expect(
        checkUniquenessConstraints(
          ctx,
          "Entry",
          "entry-2",
          { label: "second" },
          constraints,
        ),
      ).rejects.toThrow(UniquenessError);
    });

    it(`admits a node carrying a value for the field (${collation})`, async () => {
      const ctx = contextFor(graph);
      const constraints = protoNamedConstraints(graph);

      await insertUniquenessEntries(
        ctx,
        "Entry",
        "entry-1",
        { label: "first" },
        constraints,
      );

      await expect(
        checkUniquenessConstraints(
          ctx,
          "Entry",
          "entry-2",
          { label: "second", toString: "alpha" },
          constraints,
        ),
      ).resolves.toBeUndefined();
    });
  }
});

// ============================================================
// Partial Uniqueness (`where`) Over Absent Optional Fields
// ============================================================

const Account = defineNode("Account", {
  schema: z.object({
    name: z.string(),
    externalId: z.string().optional(),
  }),
});

const partialUniqueGraph = defineGraph({
  id: "partial_unique_test",
  nodes: {
    Account: {
      type: Account,
      unique: [
        {
          name: "unique_external_id",
          fields: ["externalId"],
          scope: "kind",
          collation: "binary",
          where: (fields) => requireDefined(fields["externalId"]).isNotNull(),
        },
      ],
    },
  },
  edges: {},
  ontology: [],
});

/** Constraints whose `where` names a field called after a prototype member. */
const protoWhereGraph = defineGraph({
  id: "proto_named_where_test",
  nodes: {
    Entry: {
      type: Entry,
      unique: [
        {
          name: "unique_when_to_string_null",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
          // Dot notation cannot name this field: `fields.toString` resolves to
          // the builder object's inherited `toString` method, which is exactly
          // the confusion under test.
          // eslint-disable-next-line @typescript-eslint/dot-notation
          where: (fields) => requireDefined(fields["toString"]).isNull(),
        },
        {
          name: "unique_when_to_string_present",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
          // eslint-disable-next-line @typescript-eslint/dot-notation
          where: (fields) => requireDefined(fields["toString"]).isNotNull(),
        },
      ],
    },
  },
  edges: {},
  ontology: [],
});

/** The well-known symbols a generic consumer probes an unknown object with. */
const PROBED_SYMBOLS: readonly symbol[] = [
  Symbol.iterator,
  Symbol.asyncIterator,
  Symbol.toPrimitive,
  Symbol.toStringTag,
];

/** What each `where` evaluation observed when it probed its builder. */
const symbolProbes: (readonly unknown[])[] = [];

/** A constraint whose `where` probes the builder the way a library would. */
const symbolProbeGraph = defineGraph({
  id: "symbol_probe_where_test",
  nodes: {
    Entry: {
      type: Entry,
      unique: [
        {
          name: "unique_label",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
          where: (fields) => {
            const builder = fields as unknown as Readonly<
              Record<symbol, unknown>
            >;
            symbolProbes.push(PROBED_SYMBOLS.map((symbol) => builder[symbol]));
            return requireDefined(fields["label"]).isNotNull();
          },
        },
      ],
    },
  },
  edges: {},
  ontology: [],
});

describe("Partial uniqueness over an absent optional field", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("does not apply to nodes created without the field", async () => {
    const store = createStore(partialUniqueGraph, backend);

    // The predicate builder declares every schema field, optional or not, so
    // naming an absent one reports absence instead of throwing.
    const first = await store.nodes.Account.create({ name: "first" });
    const second = await store.nodes.Account.create({ name: "second" });

    expect(first.externalId).toBeUndefined();
    expect(second.externalId).toBeUndefined();
  });

  it("still enforces the constraint for nodes carrying the field", async () => {
    const store = createStore(partialUniqueGraph, backend);

    await store.nodes.Account.create({ name: "first", externalId: "ext-1" });

    await expect(
      store.nodes.Account.create({ name: "second", externalId: "ext-1" }),
    ).rejects.toThrow("Uniqueness violation");

    const third = await store.nodes.Account.create({
      name: "third",
      externalId: "ext-2",
    });
    expect(third.externalId).toBe("ext-2");
  });

  it("answers a well-known symbol as absent instead of as a field", () => {
    const [constraint] = symbolProbeGraph.nodes.Entry.unique;

    expect(checkWherePredicate(constraint, { label: "first" })).toBe(true);

    // A symbol is never a schema field name, so the builder must answer one the
    // way a plain object does. Answering with a field builder instead hands
    // every JS protocol that probes an unknown object — iteration, `ToPrimitive`
    // string coercion, array-like consumption — a NON-CALLABLE object where it
    // requires a method, so a `where` callback that merely gets logged or
    // spread throws a TypeError from inside user code. And a predicate built
    // from such a read would carry a symbol as its `field`, which reads as
    // absent for every node: a partial constraint silently applying to nothing.
    // The callback runs once per evaluation AND once at definition time, where
    // `defineGraph` captures the clause to check its field is declared. Every
    // recorded probe — from either caller — must answer the same way.
    expect(symbolProbes.length).toBeGreaterThanOrEqual(1);
    for (const probed of symbolProbes) {
      expect(probed).toHaveLength(PROBED_SYMBOLS.length);
      for (const value of probed) {
        expect(value).toBeUndefined();
      }
    }
  });

  it("evaluates a where clause naming a prototype-member field by own key", () => {
    const [whenNull, whenPresent] = protoWhereGraph.nodes.Entry.unique;

    // Absent: the inherited `Object.prototype.toString` read as a present
    // value, inverting both predicates.
    expect(checkWherePredicate(whenNull, { label: "first" })).toBe(true);
    expect(checkWherePredicate(whenPresent, { label: "first" })).toBe(false);

    // Present: unchanged.
    const carried = { label: "first", toString: "alpha" };
    expect(checkWherePredicate(whenNull, carried)).toBe(false);
    expect(checkWherePredicate(whenPresent, carried)).toBe(true);
  });
});

// ============================================================
// Undeclared `where` Fields Are Refused at Definition Time
// ============================================================

/**
 * The uniqueness predicate builder is a TOTAL Proxy: it answers for every
 * name, because the builder type declares every schema field as required so a
 * partial constraint can ask whether an OPTIONAL one is present. That totality
 * is correct and must stay — but it means a TYPO'D field name cannot be caught
 * at the builder. For a typed caller the type system catches it
 * (`UniqueConstraintPredicateBuilder` declares exactly the schema's fields and
 * has no index signature); an untyped JavaScript caller had no guard at all and
 * got a predicate that quietly never applied — a partial constraint enforcing
 * nothing, reported as success.
 *
 * `defineGraph` is where that is refused: the one gate every constraint passes
 * before a write can evaluate it, so the refusal covers every write path rather
 * than the subset of `checkWherePredicate` call sites that happen to hold a
 * schema. It mirrors `validateGraphExtension`'s `UNKNOWN_UNIQUE_WHERE_FIELD`,
 * which already holds this invariant for kinds declared as JSON documents.
 */

type UntypedFieldBuilder = Readonly<{
  isNull: () => unknown;
  isNotNull: () => unknown;
}>;

/**
 * Builds the graph the way an untyped caller would: the constraint is cast to
 * the declared type, which is exactly what an untyped call site does implicitly.
 */
function defineAccountGraph(
  id: string,
  where: (fields: Record<string, UntypedFieldBuilder>) => unknown,
): unknown {
  const constraint: UniqueConstraint = {
    name: "unique_external_id",
    fields: ["externalId"],
    scope: "kind",
    collation: "binary",
    where: where as NonNullable<UniqueConstraint["where"]>,
  };

  // The registration is cast to its constraint-free shape: that is precisely
  // what an untyped call site has — a `unique` array TypeScript never checked.
  const registration = { type: Account, unique: [constraint] } as unknown as {
    type: typeof Account;
  };

  return defineGraph({
    id,
    nodes: { Account: registration },
    edges: {},
    ontology: [],
  });
}

describe("uniqueness `where` clauses naming an undeclared field", () => {
  it("refuses the graph definition, naming the field and the declared set", () => {
    expect(() =>
      defineAccountGraph("undeclared_where_field", (fields) =>
        requireDefined(fields["externaId"]).isNotNull(),
      ),
    ).toThrow(/externaId/);

    expect(() =>
      defineAccountGraph("undeclared_where_field_2", (fields) =>
        requireDefined(fields["externaId"]).isNotNull(),
      ),
    ).toThrow(ConfigurationError);
  });

  it("refuses a `where` callback that returns something other than a predicate", () => {
    expect(() =>
      defineAccountGraph("non_predicate_where", () => ({ nope: true })),
    ).toThrow(ConfigurationError);
  });

  it("accepts a clause naming a DECLARED optional field, which still evaluates as absent", () => {
    const graph = defineAccountGraph("declared_optional_where", (fields) =>
      requireDefined(fields["externalId"]).isNotNull(),
    ) as typeof partialUniqueGraph;

    const [constraint] = graph.nodes.Account.unique;

    // The 0.46 behavior this refusal must not disturb: a DECLARED but absent
    // optional field evaluates as absent rather than throwing or being refused.
    expect(checkWherePredicate(requireDefined(constraint), { name: "a" })).toBe(
      false,
    );
    expect(
      checkWherePredicate(requireDefined(constraint), {
        name: "a",
        externalId: "ext-1",
      }),
    ).toBe(true);
  });
});
