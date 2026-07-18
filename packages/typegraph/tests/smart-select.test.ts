/**
 * Tests for smart select optimization.
 *
 * Smart select tracks which fields the select callback reads and compiles
 * a selective projection query that avoids fetching the full props blob.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { type QueryBuilderState } from "../src/query/builder/types";
import {
  buildSelectiveFields,
  createTrackingContext,
  FieldAccessTracker,
} from "../src/query/execution/field-tracker";
import { createSchemaIntrospector } from "../src/query/schema-introspector";
import { type SqlFragment } from "../src/query/sql-fragment";
import { type CompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import { toSqlWithParams } from "./sql-test-utils";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graph Definition
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string().optional(),
    age: z.number().optional(),
    isActive: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    profile: z.object({ bio: z.string() }).optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    industry: z.string().optional(),
  }),
});

const Office = defineNode("Office", {
  schema: z.object({
    city: z.string(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string().optional(),
  }),
});

const locatedIn = defineEdge("locatedIn");

const testGraph = defineGraph({
  id: "smart_select_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
    Office: { type: Office },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    locatedIn: {
      type: locatedIn,
      from: [Company],
      to: [Office],
      cardinality: "many",
    },
  },
});

const schemaIntrospector = createSchemaIntrospector(
  new Map([
    ["Person", { schema: Person.schema }],
    ["Company", { schema: Company.schema }],
    ["Office", { schema: Office.schema }],
  ]),
  new Map([
    ["worksAt", { schema: worksAt.schema }],
    ["locatedIn", { schema: locatedIn.schema }],
  ]),
);

// ============================================================
// SQL helpers
// ============================================================

function sqlToStrings(sqlObject: SqlFragment | string): {
  sql: string;
  params: unknown[];
} {
  // The cached-template fast path runs via executeRaw, which the recording
  // backend captures as already-serialized SQL text.
  if (typeof sqlObject === "string") return { sql: sqlObject, params: [] };

  return toSqlWithParams(sqlObject);
}

function createRecordingBackend(): Readonly<{
  backend: GraphBackend;
  getLastQuery: () => SqlFragment | string | undefined;
}> {
  const backend = createTestBackend();
  let lastQuery: SqlFragment | string | undefined;

  const recordingBackend: GraphBackend = {
    ...backend,
    execute: async <T>(query: CompiledRowsSql) => {
      lastQuery = query;
      return backend.execute<T>(query);
    },
    // Reads run through the cached-template fast path (executeRaw); capture the
    // already-serialized SQL text so the projection assertions still see the
    // statement the query actually ran.
    executeRaw: async <T>(sqlText: string, params: readonly unknown[]) => {
      lastQuery = sqlText;
      return requireDefined(backend.executeRaw)<T>(sqlText, params);
    },
  };

  return {
    backend: recordingBackend,
    getLastQuery: () => lastQuery,
  };
}

// ============================================================
// Unit Tests
// ============================================================

describe("FieldAccessTracker", () => {
  it("deduplicates repeated accesses", () => {
    const tracker = new FieldAccessTracker();
    tracker.record("p", "email", false);
    tracker.record("p", "email", false);

    const fields = tracker.getAccessedFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      alias: "p",
      field: "email",
      isSystemField: false,
    });
  });

  it("preserves isSystemField when re-recorded as non-system", () => {
    const tracker = new FieldAccessTracker();
    tracker.record("a", "id", true);
    tracker.record("a", "id", false);

    const fields = tracker.getAccessedFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      alias: "a",
      field: "id",
      isSystemField: true,
    });
  });

  it("upgrades non-system field to system field", () => {
    const tracker = new FieldAccessTracker();
    tracker.record("a", "id", false);
    tracker.record("a", "id", true);

    const fields = tracker.getAccessedFields();
    expect(fields).toHaveLength(1);
    expect(fields[0]).toEqual({
      alias: "a",
      field: "id",
      isSystemField: true,
    });
  });
});

describe("createTrackingContext", () => {
  const mockState: QueryBuilderState = {
    startAlias: "p",
    startKinds: ["Person"],
    currentAlias: "p",
    includeSubClasses: false,
    traversals: [],
    predicates: [],
    projection: [],
    orderBy: [],
    aggregateOrderBy: [],
    limit: undefined,
    offset: undefined,
    temporalMode: "current",
    asOf: undefined,
    groupBy: undefined,
    having: undefined,
    fusion: undefined,
    dynamicNodeAliases: new Set(),
    dynamicEdgeAliases: new Set(),
  };

  it("records node props, system fields, and meta access", () => {
    const tracker = new FieldAccessTracker();
    const context = createTrackingContext(mockState, tracker, {
      schemaIntrospector,
      mode: "truthy",
      optionalTraversalAliases: "present",
    }) as { p: { email: unknown; id: unknown; meta: unknown } };

    expect(context.p.email).toBe("x");
    expect(context.p.id).toBe("x");
    expect(context.p.meta).toBeDefined();

    const accessed = tracker.getAccessedFields();
    expect(accessed).toContainEqual({
      alias: "p",
      field: "email",
      isSystemField: false,
    });
    expect(accessed).toContainEqual({
      alias: "p",
      field: "id",
      isSystemField: true,
    });
    expect(accessed).toContainEqual({
      alias: "p",
      field: "meta.createdAt",
      isSystemField: true,
    });
  });

  it("sets optional traversal aliases to undefined when configured", () => {
    const stateWithOptionalTraversal: QueryBuilderState = {
      ...mockState,
      traversals: [
        {
          edgeAlias: "e",
          edgeKinds: ["worksAt"],
          direction: "out",
          nodeAlias: "c",
          nodeKinds: ["Company"],
          joinFromAlias: "p",
          joinEdgeField: "from_id",
          optional: true,
        },
      ],
    };

    const tracker = new FieldAccessTracker();
    const context = createTrackingContext(stateWithOptionalTraversal, tracker, {
      schemaIntrospector,
      mode: "falsy",
      optionalTraversalAliases: "absent",
    }) as { p: unknown; c: unknown; e: unknown };

    expect(context.p).toBeDefined();
    expect(context.c).toBeUndefined();
    expect(context.e).toBeUndefined();
  });
});

describe("buildSelectiveFields", () => {
  it("builds deterministic output names", () => {
    const fields = buildSelectiveFields([
      { alias: "p", field: "email", isSystemField: false },
      { alias: "p", field: "id", isSystemField: true },
    ]);

    expect(fields).toEqual([
      {
        alias: "p",
        field: "email",
        outputName: "p_email",
        isSystemField: false,
      },
      { alias: "p", field: "id", outputName: "p_id", isSystemField: true },
    ]);
  });
});

// ============================================================
// Integration Tests
// ============================================================

describe("Smart Select Integration", () => {
  let store: Store<typeof testGraph>;
  let getLastQuery: () => SqlFragment | string | undefined;
  let aliceId: string;

  beforeEach(async () => {
    const { backend, getLastQuery: getQuery } = createRecordingBackend();
    getLastQuery = getQuery;
    store = createStore(testGraph, backend);

    const alice = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
      age: 30,
      isActive: true,
      tags: ["a", "b"],
      profile: { bio: "Hello" },
    });
    aliceId = alice.id;

    await store.nodes.Person.create({
      name: "Bob",
      age: 25,
      isActive: false,
    });
  });

  it("uses selective projection for simple field selection", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .select((ctx) => ({ email: ctx.p.email, name: ctx.p.name }))
      .execute();

    expect(results).toHaveLength(2);

    const last = getLastQuery();
    expect(last).toBeDefined();

    const { sql } = sqlToStrings(requireDefined(last));
    expect(sql).toContain('AS "p_email"');
    expect(sql).toContain('AS "p_name"');
    expect(sql).not.toContain('AS "p_props"');
  });

  it("returns correct data for computed selects without fetching full props", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name", "asc")
      .select((ctx) => ({
        upperName: ctx.p.name.toUpperCase(),
        hasEmail: ctx.p.email ? true : false,
        emailOrNone: ctx.p.email ?? "none",
      }))
      .execute();

    expect(results).toEqual([
      {
        upperName: "ALICE",
        hasEmail: true,
        emailOrNone: "alice@example.com",
      },
      {
        upperName: "BOB",
        hasEmail: false,
        emailOrNone: "none",
      },
    ]);

    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).not.toContain('AS "p_props"');
  });

  it("decodes boolean and object/array fields correctly (SQLite)", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({
        isActive: ctx.p.isActive,
        tags: ctx.p.tags,
        profile: ctx.p.profile,
      }))
      .execute();

    expect(results).toEqual([
      {
        isActive: true,
        tags: ["a", "b"],
        profile: { bio: "Hello" },
      },
    ]);
  });

  it("handles optional traversals and conditional selection", async () => {
    const company = await store.nodes.Company.create({ name: "Acme" });

    await store.edges.worksAt.create(
      { kind: "Person", id: aliceId },
      { kind: "Company", id: company.id },
      { role: "Engineer" },
    );

    const results = await store
      .query()
      .from("Person", "p")
      .optionalTraverse("worksAt", "e")
      .to("Company", "c")
      .orderBy("p", "name", "asc")
      .select((ctx) => ({
        person: ctx.p.name,
        company: ctx.c ? ctx.c.name : "none",
      }))
      .execute();

    expect(results).toEqual([
      { person: "Alice", company: "Acme" },
      { person: "Bob", company: "none" },
    ]);

    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).not.toContain('AS "p_props"');
  });

  it("collapses selective multi-hop non-optional traversals to terminal CTE", async () => {
    const company = await store.nodes.Company.create({ name: "Acme" });
    const office = await store.nodes.Office.create({ city: "San Francisco" });

    await store.edges.worksAt.create(
      { kind: "Person", id: aliceId },
      { kind: "Company", id: company.id },
      {},
    );
    await store.edges.locatedIn.create(
      { kind: "Company", id: company.id },
      { kind: "Office", id: office.id },
      {},
    );

    const results = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (person) => person.id.eq(aliceId))
      .traverse("worksAt", "w")
      .to("Company", "c")
      .traverse("locatedIn", "l")
      .to("Office", "o")
      .select((ctx) => ({
        personName: ctx.p.name,
        companyName: ctx.c.name,
        officeCity: ctx.o.city,
      }))
      .execute();

    expect(results).toEqual([
      {
        personName: "Alice",
        companyName: "Acme",
        officeCity: "San Francisco",
      },
    ]);

    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).toContain("FROM cte_o");
    expect(sql).not.toContain("FROM cte_p INNER JOIN cte_c");
    expect(sql).not.toContain('AS "p_props"');
    expect(sql).not.toContain('AS "c_props"');
    expect(sql).not.toContain('AS "o_props"');
  });

  it("uses selective projection for paginate (includes ORDER BY fields for cursors)", async () => {
    await store.nodes.Person.create({
      name: "Charlie",
      age: 35,
    });

    const page1 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "age", "asc")
      .select((ctx) => ({ name: ctx.p.name }))
      .paginate({ first: 1 });

    expect(page1.data).toEqual([{ name: "Bob" }]);
    expect(page1.nextCursor).toBeDefined();

    const { sql: sql1 } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql1).toContain('AS "p_name"');
    expect(sql1).toContain('AS "p_age"');
    expect(sql1).not.toContain('AS "p_props"');

    const page2 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "age", "asc")
      .select((ctx) => ({ name: ctx.p.name }))
      .paginate({ first: 1, after: requireDefined(page1.nextCursor) });

    expect(page2.data).toEqual([{ name: "Alice" }]);
    expect(page2.prevCursor).toBeDefined();

    const { sql: sql2 } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql2).not.toContain('AS "p_props"');
  });

  it("uses selective projection for stream (via paginate)", async () => {
    const results: Readonly<{ name: string }>[] = [];

    for await (const row of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name", "asc")
      .select((ctx) => ({ name: ctx.p.name }))
      .stream({ batchSize: 1 })) {
      results.push(row);
      if (results.length >= 2) break;
    }

    expect(results).toEqual([{ name: "Alice" }, { name: "Bob" }]);
    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).not.toContain('AS "p_props"');
  });

  it("falls back when returning whole node objects", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.name.eq("Alice"))
      .select((ctx) => ({ person: ctx.p, email: ctx.p.email }))
      .execute();

    expect(results).toHaveLength(1);
    expect(results[0]?.person.email).toBe("alice@example.com");
    expect(results[0]?.person.meta.createdAt).toBeDefined();

    // Full fetch projection includes the props blob.
    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).toContain('AS "p_props"');
  });

  it("preserves id system field in selective paginate results", async () => {
    const page = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name", "asc")
      .select((ctx) => ({
        id: ctx.p.id,
        name: ctx.p.name,
      }))
      .paginate({ first: 10 });

    expect(page.data).toHaveLength(2);
    expect(requireDefined(page.data[0]).name).toBe("Alice");
    expect(requireDefined(page.data[0]).id).toBe(aliceId);
    expect(requireDefined(page.data[1]).id).toBeDefined();
    expect(typeof requireDefined(page.data[1]).id).toBe("string");

    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).toContain('AS "p_id"');
    expect(sql).not.toContain('AS "p_props"');
  });

  it("orders by system field id correctly in paginate", async () => {
    const page = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "id", "asc")
      .select((ctx) => ({
        id: ctx.p.id,
        name: ctx.p.name,
      }))
      .paginate({ first: 10 });

    expect(page.data).toHaveLength(2);
    expect(requireDefined(page.data[0]).id).toBeDefined();
    expect(requireDefined(page.data[1]).id).toBeDefined();
    expect(requireDefined(page.data[0]).id).not.toBe(
      requireDefined(page.data[1]).id,
    );

    const { sql } = sqlToStrings(requireDefined(getLastQuery()));
    expect(sql).not.toContain('AS "p_props"');
  });

  it("orders by system field id correctly in execute", async () => {
    const results = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "id", "asc")
      .select((ctx) => ({
        id: ctx.p.id,
        name: ctx.p.name,
      }))
      .execute();

    expect(results).toHaveLength(2);
    expect(requireDefined(results[0]).id).toBeDefined();
    expect(requireDefined(results[1]).id).toBeDefined();
    // Verify ordering is by actual id column, not props->'id'
    expect(requireDefined(results[0]).id < requireDefined(results[1]).id).toBe(
      true,
    );
  });

  it("supports string comparison operators on id field", async () => {
    const allResults = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "id", "asc")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .execute();

    expect(allResults).toHaveLength(2);
    const firstId = requireDefined(allResults[0]).id;

    const gtResults = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.id.gt(firstId))
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .execute();

    expect(gtResults).toHaveLength(1);
    expect(requireDefined(gtResults[0]).id > firstId).toBe(true);

    const lteResults = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.id.lte(firstId))
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .execute();

    expect(lteResults).toHaveLength(1);
    expect(requireDefined(lteResults[0]).id).toBe(firstId);
  });

  it("supports cursor pagination with orderBy id", async () => {
    await store.nodes.Person.create({ name: "Charlie", age: 35 });

    const page1 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "id", "asc")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .paginate({ first: 2 });

    expect(page1.data).toHaveLength(2);
    expect(page1.hasNextPage).toBe(true);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "id", "asc")
      .select((ctx) => ({ id: ctx.p.id, name: ctx.p.name }))
      .paginate({ first: 2, after: requireDefined(page1.nextCursor) });

    expect(page2.data).toHaveLength(1);
    expect(page2.hasNextPage).toBe(false);
    // Page 2 id must be greater than all page 1 ids
    expect(
      requireDefined(page2.data[0]).id > requireDefined(page1.data[1]).id,
    ).toBe(true);
  });
});
