import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Store } from "../src";
import { KindNotFoundError, ValidationError } from "../src/errors";
import { defineGraphExtension } from "../src/graph-extension";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string().min(1),
    email: z.email().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string().min(1) }),
  from: [Person],
  to: [Company],
});

const baseGraph = defineGraph({
  id: "props_schema_accessors",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Company] },
  },
});

function paperExtension() {
  return defineGraphExtension({
    nodes: {
      Paper: {
        properties: {
          title: { type: "string", minLength: 1 },
          year: { type: "number", int: true, min: 1900 },
        },
      },
    },
  });
}

function paperWithCitesExtension() {
  return defineGraphExtension({
    nodes: {
      Paper: { properties: { title: { type: "string", minLength: 1 } } },
    },
    edges: {
      cites: {
        from: ["Paper"],
        to: ["Paper"],
        properties: {
          note: { type: "string", maxLength: 200 },
        },
      },
    },
  });
}

describe("getNodePropsSchema / getEdgePropsSchema (compile-time kinds)", () => {
  let store: Store<typeof baseGraph>;

  beforeEach(() => {
    store = createStore(baseGraph, createTestBackend());
  });

  it("returns the same Zod object instance as defineNode", () => {
    expect(store.getNodePropsSchema("Person")).toBe(Person.schema);
    expect(store.getNodePropsSchema("Company")).toBe(Company.schema);
  });

  it("returns the same Zod object instance as defineEdge", () => {
    expect(store.getEdgePropsSchema("worksAt")).toBe(worksAt.schema);
  });

  it("returns undefined for an unregistered node kind", () => {
    expect(store.getNodePropsSchema("Ghost")).toBeUndefined();
  });

  it("returns undefined for an unregistered edge kind", () => {
    expect(store.getEdgePropsSchema("hasPet")).toBeUndefined();
  });

  it("returns undefined for inherited prototype keys (node)", () => {
    expect(store.getNodePropsSchema("toString")).toBeUndefined();
    expect(store.getNodePropsSchema("constructor")).toBeUndefined();
    expect(store.getNodePropsSchema("hasOwnProperty")).toBeUndefined();
  });

  it("returns undefined for inherited prototype keys (edge)", () => {
    expect(store.getEdgePropsSchema("toString")).toBeUndefined();
    expect(store.getEdgePropsSchema("constructor")).toBeUndefined();
    expect(store.getEdgePropsSchema("hasOwnProperty")).toBeUndefined();
  });
});

describe("getNodePropsSchemaOrThrow / getEdgePropsSchemaOrThrow", () => {
  let store: Store<typeof baseGraph>;

  beforeEach(() => {
    store = createStore(baseGraph, createTestBackend());
  });

  it("returns the schema when the kind is registered", () => {
    expect(store.getNodePropsSchemaOrThrow("Person")).toBe(Person.schema);
    expect(store.getEdgePropsSchemaOrThrow("worksAt")).toBe(worksAt.schema);
  });

  it("throws KindNotFoundError with entity=node for unknown node kind", () => {
    let caught: unknown;
    try {
      store.getNodePropsSchemaOrThrow("Ghost");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KindNotFoundError);
    const error = caught as KindNotFoundError;
    expect(error.kindName).toBe("Ghost");
    expect(error.entity).toBe("node");
    expect(error.details.graphId).toBe(baseGraph.id);
  });

  it("throws KindNotFoundError with entity=edge for unknown edge kind", () => {
    let caught: unknown;
    try {
      store.getEdgePropsSchemaOrThrow("hasPet");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(KindNotFoundError);
    const error = caught as KindNotFoundError;
    expect(error.kindName).toBe("hasPet");
    expect(error.entity).toBe("edge");
  });

  it("throws KindNotFoundError for prototype-leak keys", () => {
    expect(() => store.getNodePropsSchemaOrThrow("toString")).toThrow(
      KindNotFoundError,
    );
    expect(() => store.getEdgePropsSchemaOrThrow("toString")).toThrow(
      KindNotFoundError,
    );
  });
});

describe("parse parity with collection.create — node", () => {
  let store: Store<typeof baseGraph>;

  beforeEach(() => {
    store = createStore(baseGraph, createTestBackend());
  });

  it("valid props produce the same parsed output as create persists", async () => {
    const schema = store.getNodePropsSchemaOrThrow("Person");

    const input = { name: "Alice", email: "alice@example.com" };
    const parsed = schema.parse(input);
    const created = await store.nodes.Person.create(input);

    expect(parsed).toEqual({ name: "Alice", email: "alice@example.com" });
    expect(created.name).toBe(parsed.name);
    expect(created.email).toBe(parsed.email);
  });

  it("invalid props produce the same underlying Zod issues as create surfaces", async () => {
    const schema = store.getNodePropsSchemaOrThrow("Person");

    const input = { name: "", email: "not-an-email" };

    const parseResult = schema.safeParse(input);
    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;
    const parseIssues = parseResult.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));

    let caught: unknown;
    try {
      await store.nodes.Person.create(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    const createIssues = error.details.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
    }));

    expect(createIssues).toEqual(parseIssues);
  });
});

describe("parse parity with collection.create — edge", () => {
  let store: Store<typeof baseGraph>;

  beforeEach(() => {
    store = createStore(baseGraph, createTestBackend());
  });

  it("valid edge props produce the same parsed output as create persists", async () => {
    const schema = store.getEdgePropsSchemaOrThrow("worksAt");

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({
      name: "Acme",
      industry: "Tech",
    });

    const input = { role: "Engineer" };
    const parsed = schema.parse(input);
    const edge = await store.edges.worksAt.create(alice, acme, input);

    expect(parsed).toEqual({ role: "Engineer" });
    expect(edge.role).toBe(parsed.role);
  });

  it("invalid edge props produce the same underlying Zod issues as create surfaces", async () => {
    const schema = store.getEdgePropsSchemaOrThrow("worksAt");

    const alice = await store.nodes.Person.create({ name: "Alice" });
    const acme = await store.nodes.Company.create({
      name: "Acme",
      industry: "Tech",
    });

    const input = { role: "" };

    const parseResult = schema.safeParse(input);
    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;
    const parseIssues = parseResult.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));

    let caught: unknown;
    try {
      await store.edges.worksAt.create(alice, acme, input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    const createIssues = error.details.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
    }));

    expect(createIssues).toEqual(parseIssues);
  });
});

describe("graph-extension (runtime) kinds after evolve", () => {
  it("returns the compiled Zod schema for an extension node kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension());

    const schema = evolved.getNodePropsSchemaOrThrow("Paper");
    expect(schema).toBeDefined();

    const valid = { title: "On Computable Numbers", year: 1936 };
    expect(schema.parse(valid)).toEqual(valid);

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    const created = (await papers.create(valid)) as unknown as {
      title: string;
      year: number;
    };
    expect(created.title).toBe(valid.title);
    expect(created.year).toBe(valid.year);
  });

  it("invalid extension-kind props surface identical Zod issues from parse and create", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension());
    const schema = evolved.getNodePropsSchemaOrThrow("Paper");

    const invalid = { title: "", year: 1936.5 };
    const parseResult = schema.safeParse(invalid);
    expect(parseResult.success).toBe(false);
    if (parseResult.success) return;
    const parseIssues = parseResult.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));

    const papers = evolved.getNodeCollectionOrThrow("Paper");
    let caught: unknown;
    try {
      await papers.create(invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    const createIssues = error.details.issues.map((issue) => ({
      path: issue.path,
      code: issue.code,
    }));

    expect(createIssues).toEqual(parseIssues);
  });

  it("returns undefined for an extension kind not yet evolved into the store", () => {
    const store = createStore(baseGraph, createTestBackend());

    expect(store.getNodePropsSchema("Paper")).toBeUndefined();
    expect(() => store.getNodePropsSchemaOrThrow("Paper")).toThrow(
      KindNotFoundError,
    );
  });

  it("returns the compiled Zod schema for an extension edge kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperWithCitesExtension());

    const schema = evolved.getEdgePropsSchemaOrThrow("cites");
    expect(schema).toBeDefined();

    const valid = { note: "follow-up" };
    expect(schema.parse(valid)).toEqual(valid);

    const tooLong = "x".repeat(201);
    const result = schema.safeParse({ note: tooLong });
    expect(result.success).toBe(false);
  });
});

describe("z.toJSONSchema interop (doc snippet sanity)", () => {
  it("produces a JSON Schema object for a compile-time node kind", () => {
    const store = createStore(baseGraph, createTestBackend());

    const jsonSchema = z.toJSONSchema(
      store.getNodePropsSchemaOrThrow("Person"),
    ) as Record<string, unknown>;

    expect(jsonSchema).toBeTypeOf("object");
    expect(jsonSchema.type).toBe("object");
    expect(jsonSchema.properties).toBeTypeOf("object");
  });

  it("produces a JSON Schema object for an extension node kind", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(baseGraph, backend);
    const evolved = await store.evolve(paperExtension());

    const jsonSchema = z.toJSONSchema(
      evolved.getNodePropsSchemaOrThrow("Paper"),
    ) as Record<string, unknown>;

    expect(jsonSchema).toBeTypeOf("object");
    expect(jsonSchema.type).toBe("object");
    const properties = jsonSchema.properties as Record<string, unknown>;
    expect(properties.title).toBeDefined();
  });
});
