/**
 * QueryProfiler Tests
 *
 * Tests the profiling system for query pattern collection and index recommendations.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  avg,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  exists,
  field,
  havingGt,
  inSubquery,
  jsonPointer,
  subClassOf,
} from "../src";
import { extractPropertyAccesses } from "../src/profiler/ast-extractor";
import {
  keyToPath,
  pathToKey,
  ProfileCollector,
} from "../src/profiler/collector";
import { QueryProfiler } from "../src/profiler/query-profiler";
import {
  generateRecommendations,
  getUnindexedFilters,
} from "../src/profiler/recommendations";
import { type DeclaredIndex } from "../src/profiler/types";
import { createStore, type Store } from "../src/store";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Schema
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.email().optional(),
    age: z.number().int().positive().optional(),
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

const Document = defineNode("Document", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string(),
  }),
});

const testGraph = defineGraph({
  id: "profiler_test",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Company: { type: Company },
    Document: { type: Document },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      cardinality: "many",
    },
  },
  ontology: [subClassOf(Company, Organization)],
});

// ============================================================
// Test Setup
// ============================================================

let store: Store<typeof testGraph>;

beforeEach(() => {
  const backend = createTestBackend();
  store = createStore(testGraph, backend);
});

// ============================================================
// Unit Tests: Path Serialization
// ============================================================

describe("Path Serialization", () => {
  it("pathToKey converts props pointers", () => {
    expect(
      pathToKey({
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      }),
    ).toBe("node:Person:/email");
  });

  it("pathToKey converts nested props pointers", () => {
    expect(
      pathToKey({
        entityType: "node",
        kind: "Order",
        target: {
          __type: "prop",
          pointer: jsonPointer(["metadata", "priority"]),
        },
      }),
    ).toBe("node:Order:/metadata/priority");
  });

  it("pathToKey converts system fields", () => {
    expect(
      pathToKey({
        entityType: "node",
        kind: "Person",
        target: { __type: "system", field: "id" },
      }),
    ).toBe("node:Person:$id");
  });

  it("keyToPath parses props pointers", () => {
    expect(keyToPath("node:Person:/email")).toEqual({
      entityType: "node",
      kind: "Person",
      target: { __type: "prop", pointer: jsonPointer(["email"]) },
    });
  });

  it("keyToPath parses system fields", () => {
    expect(keyToPath("node:Person:$id")).toEqual({
      entityType: "node",
      kind: "Person",
      target: { __type: "system", field: "id" },
    });
  });

  it("keyToPath throws for malformed keys", () => {
    expect(() => keyToPath("Person")).toThrow(/Invalid profile key/);
    expect(() => keyToPath("node:Person")).toThrow(/Invalid profile key/);
  });

  it("keyToPath throws for invalid entity types", () => {
    expect(() => keyToPath("vertex:Person:/email")).toThrow(
      /Invalid entity type/,
    );
  });

  it("keyToPath throws for invalid targets", () => {
    expect(() => keyToPath("node:Person:email")).toThrow(/JSON Pointer/);
    expect(() => keyToPath("node::/email")).toThrow(/Kind must not be empty/);
    expect(() => keyToPath("node:Person:$")).toThrow(
      /System field must not be empty/,
    );
  });
});

// ============================================================
// Unit Tests: ProfileCollector
// ============================================================

describe("ProfileCollector", () => {
  it("records property accesses", () => {
    const collector = new ProfileCollector();

    collector.record(
      {
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      },
      "filter",
      "eq",
    );

    const patterns = collector.getPatterns();
    expect(patterns.size).toBe(1);

    const stats = patterns.get("node:Person:/email");
    expect(stats).toBeDefined();
    expect(stats!.count).toBe(1);
    expect(stats!.contexts.has("filter")).toBe(true);
    expect(stats!.predicateTypes.has("eq")).toBe(true);
  });

  it("aggregates multiple accesses to same property", () => {
    const collector = new ProfileCollector();

    collector.record(
      {
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      },
      "filter",
      "eq",
    );
    collector.record(
      {
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      },
      "filter",
      "contains",
    );
    collector.record(
      {
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      },
      "sort",
    );

    const patterns = collector.getPatterns();
    const stats = patterns.get("node:Person:/email");

    expect(stats!.count).toBe(3);
    expect(stats!.contexts.has("filter")).toBe(true);
    expect(stats!.contexts.has("sort")).toBe(true);
    expect(stats!.predicateTypes.has("eq")).toBe(true);
    expect(stats!.predicateTypes.has("contains")).toBe(true);
  });

  it("tracks query count", () => {
    const collector = new ProfileCollector();

    collector.recordQuery();
    collector.recordQuery();
    collector.recordQuery();

    const summary = collector.getSummary();
    expect(summary.totalQueries).toBe(3);
  });

  it("resets data", () => {
    const collector = new ProfileCollector();

    collector.record(
      {
        entityType: "node",
        kind: "Person",
        target: { __type: "prop", pointer: jsonPointer(["email"]) },
      },
      "filter",
    );
    collector.recordQuery();

    collector.reset();

    expect(collector.getPatterns().size).toBe(0);
    expect(collector.getSummary().totalQueries).toBe(0);
  });
});

// ============================================================
// Unit Tests: Recommendations
// ============================================================

describe("Recommendations", () => {
  it("generates recommendations for unindexed filters", () => {
    const emailPointer = jsonPointer(["email"]);
    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 5,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const recommendations = generateRecommendations(patterns, [], 1);

    expect(recommendations.length).toBe(1);
    expect(recommendations[0]!.entityType).toBe("node");
    expect(recommendations[0]!.kind).toBe("Person");
    expect(recommendations[0]!.fields).toEqual([emailPointer]);
  });

  it("excludes declared indexes from recommendations", () => {
    const emailPointer = jsonPointer(["email"]);
    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 10,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const declaredIndexes: DeclaredIndex[] = [
      {
        entityType: "node",
        kind: "Person",
        fields: [emailPointer],
        unique: true,
        name: "idx_email",
      },
    ];

    const recommendations = generateRecommendations(
      patterns,
      declaredIndexes,
      1,
    );

    expect(recommendations.length).toBe(0);
  });

  it("supports composite index prefix matching", () => {
    const emailPointer = jsonPointer(["email"]);
    const namePointer = jsonPointer(["name"]);

    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 10,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
      [
        "node:Person:/name",
        {
          count: 10,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const declaredIndexes: DeclaredIndex[] = [
      {
        entityType: "node",
        kind: "Person",
        fields: [emailPointer, namePointer],
        unique: false,
        name: "idx_email_name",
      },
    ];

    const recommendations = generateRecommendations(
      patterns,
      declaredIndexes,
      1,
    );

    const hasEmail = recommendations.some((r) =>
      r.fields.includes(emailPointer),
    );
    const hasName = recommendations.some((r) => r.fields.includes(namePointer));
    expect(hasEmail).toBe(false);
    expect(hasName).toBe(true);
  });

  it("skips system fields (id, kind)", () => {
    const patterns = new Map([
      [
        "node:Person:$id",
        {
          count: 100,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const recommendations = generateRecommendations(patterns, [], 1);

    expect(recommendations.length).toBe(0);
  });

  it("respects minFrequency threshold", () => {
    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 2,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const recommendations = generateRecommendations(patterns, [], {
      minFrequencyForRecommendation: 5,
    });

    expect(recommendations.length).toBe(0);
  });

  it("assigns priority based on frequency", () => {
    const emailPointer = jsonPointer(["email"]);
    const namePointer = jsonPointer(["name"]);
    const agePointer = jsonPointer(["age"]);
    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 15, // high
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
      [
        "node:Person:/name",
        {
          count: 7, // medium
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
      [
        "node:Person:/age",
        {
          count: 3, // low
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const recommendations = generateRecommendations(patterns, [], 1);

    const byField = new Map(
      recommendations.map((r) => [r.fields[0]!, r.priority] as const),
    );

    expect(byField.get(emailPointer)).toBe("high");
    expect(byField.get(namePointer)).toBe("medium");
    expect(byField.get(agePointer)).toBe("low");
  });

  it("getUnindexedFilters returns only filter context", () => {
    const emailPointer = jsonPointer(["email"]);
    const patterns = new Map([
      [
        "node:Person:/email",
        {
          count: 5,
          contexts: new Set(["filter" as const]),
          predicateTypes: new Set(["eq"]),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
      [
        "node:Person:/name",
        {
          count: 5,
          contexts: new Set(["select" as const]), // Not a filter
          predicateTypes: new Set<string>(),
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      ],
    ]);

    const unindexed = getUnindexedFilters(patterns, []);

    expect(unindexed.length).toBe(1);
    expect(unindexed[0]!.target).toEqual({
      __type: "prop",
      pointer: emailPointer,
    });
  });
});

// ============================================================
// Integration Tests: QueryProfiler
// ============================================================

describe("QueryProfiler", () => {
  describe("Attachment", () => {
    it("attaches to store and provides profiler property", () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      expect(profiledStore.profiler).toBe(profiler);
      expect(profiler.isAttached).toBe(true);
    });

    it("preserves Store getters and collection API", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      // Getter access must not break private fields.
      expect(profiledStore.graphId).toBe("profiler_test");

      const created = await profiledStore.nodes.Person.create({
        name: "Alice",
        email: "alice@example.com",
        age: 30,
      });
      expect(created.id).toBeDefined();
    });

    it("preserves ExecutableQuery methods like compile()", () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      const compiled = profiledStore
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .compile();

      expect(compiled).toBeDefined();
    });

    it("throws when attaching twice without detach", () => {
      const profiler = new QueryProfiler();
      profiler.attachToStore(store);

      expect(() => profiler.attachToStore(store)).toThrow(/already attached/);
    });

    it("allows reattachment after detach", () => {
      const profiler = new QueryProfiler();
      profiler.attachToStore(store);
      profiler.detach();

      expect(() => profiler.attachToStore(store)).not.toThrow();
    });
  });

  describe("Pattern Collection", () => {
    it("captures filter patterns", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      const report = profiler.getReport();
      expect(report.summary.totalQueries).toBe(1);

      const patterns = [...report.patterns.entries()];
      const emailPattern = patterns.find(([key]) => key.includes("email"));
      expect(emailPattern).toBeDefined();
      expect(emailPattern![1].contexts.has("filter")).toBe(true);
      expect(emailPattern![1].predicateTypes.has("eq")).toBe(true);
    });

    it("captures sort patterns", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .orderBy("p", "name", "asc")
        .execute();

      const report = profiler.getReport();
      const patterns = [...report.patterns.entries()];
      const namePattern = patterns.find(([key]) => key.includes("name"));
      expect(namePattern).toBeDefined();
      expect(namePattern![1].contexts.has("sort")).toBe(true);
    });

    it("captures select patterns for system fields", async () => {
      // Note: When selecting whole nodes (ctx.p), individual property accesses
      // are not tracked because the AST fetches the entire props blob.
      // Only system fields (id, kind) are tracked as select patterns.
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .execute();

      const report = profiler.getReport();
      const patterns = [...report.patterns.entries()];

      // System fields are captured in select context
      const idPattern = patterns.find(([key]) => key === "node:Person:$id");
      expect(idPattern).toBeDefined();
      expect(idPattern![1].contexts.has("select")).toBe(true);

      const kindPattern = patterns.find(([key]) => key === "node:Person:$kind");
      expect(kindPattern).toBeDefined();
      expect(kindPattern![1].contexts.has("select")).toBe(true);
    });

    it("aggregates across multiple queries", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      for (let index = 0; index < 5; index++) {
        await profiledStore
          .query()
          .from("Person", "p")
          .whereNode("p", (p) => p.age.gt(18))
          .select((ctx) => ctx.p)
          .execute();
      }

      const report = profiler.getReport();
      expect(report.summary.totalQueries).toBe(5);

      const patterns = [...report.patterns.entries()];
      const agePattern = patterns.find(([key]) => key.includes("age"));
      expect(agePattern![1].count).toBe(5);
    });

    it("captures edge filter patterns with entityType edge", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .traverse("worksAt", "w")
        .whereEdge("w", (w) => w.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ctx.c)
        .execute();

      const report = profiler.getReport();
      expect(report.summary.totalQueries).toBe(1);

      const patterns = [...report.patterns.entries()];
      const rolePattern = patterns.find(
        ([key]) => key === "edge:worksAt:/role",
      );
      expect(rolePattern).toBeDefined();
      expect(rolePattern![1].contexts.has("filter")).toBe(true);
      expect(rolePattern![1].predicateTypes.has("eq")).toBe(true);
    });

    it("captures both node and edge patterns in same query", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.name.eq("Alice"))
        .traverse("worksAt", "w")
        .whereEdge("w", (w) => w.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ctx.c)
        .execute();

      const report = profiler.getReport();
      const patterns = [...report.patterns.entries()];

      const namePattern = patterns.find(([key]) => key === "node:Person:/name");
      const rolePattern = patterns.find(
        ([key]) => key === "edge:worksAt:/role",
      );

      expect(namePattern).toBeDefined();
      expect(rolePattern).toBeDefined();
    });

    it("captures edge patterns across multiple edge kinds", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .traverse("worksAt", "w")
        .whereEdge("w", (w) => w.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ctx.c)
        .execute();

      await profiledStore
        .query()
        .from("Person", "p")
        .traverse("knows", "k")
        .whereEdge("k", (k) => k.since.eq("2020"))
        .to("Person", "p2")
        .select((ctx) => ctx.p2)
        .execute();

      const report = profiler.getReport();
      expect(report.summary.totalQueries).toBe(2);

      const patterns = [...report.patterns.entries()];
      expect(patterns.some(([key]) => key === "edge:worksAt:/role")).toBe(true);
      expect(patterns.some(([key]) => key === "edge:knows:/since")).toBe(true);
    });
  });

  describe("Index Recommendations", () => {
    it("recommends indexes for unindexed filters", async () => {
      const emailPointer = jsonPointer(["email"]);
      const profiler = new QueryProfiler({ minFrequencyForRecommendation: 1 });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      const report = profiler.getReport();
      expect(report.recommendations.length).toBeGreaterThan(0);

      const emailRec = report.recommendations.find((r) =>
        r.fields.includes(emailPointer),
      );
      expect(emailRec).toBeDefined();
      expect(emailRec!.kind).toBe("Person");
    });

    it("excludes declared indexes from recommendations", async () => {
      const emailPointer = jsonPointer(["email"]);
      const profiler = new QueryProfiler({
        declaredIndexes: [
          {
            entityType: "node",
            kind: "Person",
            fields: [emailPointer],
            unique: true,
            name: "idx_email",
          },
        ],
        minFrequencyForRecommendation: 1,
      });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      const report = profiler.getReport();
      const emailRec = report.recommendations.find((r) =>
        r.fields.includes(emailPointer),
      );
      expect(emailRec).toBeUndefined();
    });

    it("attributes includeSubClasses filters to matching kinds", async () => {
      const industryPointer = jsonPointer(["industry"]);
      const profiler = new QueryProfiler({ minFrequencyForRecommendation: 1 });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Organization", "o", { includeSubClasses: true })
        .whereNode("o", (o) => o.industry!.eq("Tech"))
        .select((ctx) => ctx.o)
        .execute();

      const report = profiler.getReport();

      const companyIndustry = report.recommendations.find(
        (r) => r.kind === "Company" && r.fields.includes(industryPointer),
      );
      expect(companyIndustry).toBeDefined();

      const orgIndustry = report.recommendations.find(
        (r) => r.kind === "Organization" && r.fields.includes(industryPointer),
      );
      expect(orgIndustry).toBeUndefined();
    });

    it("recommends edge indexes with entityType edge", async () => {
      const rolePointer = jsonPointer(["role"]);
      const profiler = new QueryProfiler({ minFrequencyForRecommendation: 1 });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .traverse("worksAt", "w")
        .whereEdge("w", (w) => w.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ctx.c)
        .execute();

      const report = profiler.getReport();

      const roleRec = report.recommendations.find(
        (r) =>
          r.entityType === "edge" &&
          r.kind === "worksAt" &&
          r.fields.includes(rolePointer),
      );
      expect(roleRec).toBeDefined();
      expect(roleRec!.entityType).toBe("edge");
    });

    it("excludes declared edge indexes from recommendations", async () => {
      const rolePointer = jsonPointer(["role"]);
      const profiler = new QueryProfiler({
        declaredIndexes: [
          {
            entityType: "edge",
            kind: "worksAt",
            fields: [rolePointer],
            unique: false,
            name: "idx_worksAt_role",
          },
        ],
        minFrequencyForRecommendation: 1,
      });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .traverse("worksAt", "w")
        .whereEdge("w", (w) => w.role.eq("Engineer"))
        .to("Company", "c")
        .select((ctx) => ctx.c)
        .execute();

      const report = profiler.getReport();

      const roleRec = report.recommendations.find(
        (r) => r.entityType === "edge" && r.kind === "worksAt",
      );
      expect(roleRec).toBeUndefined();
    });
  });

  describe("Test Assertions", () => {
    it("assertIndexCoverage throws for missing indexes", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      expect(() => {
        profiler.assertIndexCoverage();
      }).toThrow(/Unindexed filter properties/);
    });

    it("assertIndexCoverage passes when all filters indexed", async () => {
      const emailPointer = jsonPointer(["email"]);
      const profiler = new QueryProfiler({
        declaredIndexes: [
          {
            entityType: "node",
            kind: "Person",
            fields: [emailPointer],
            unique: true,
            name: "idx_email",
          },
        ],
      });
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      expect(() => {
        profiler.assertIndexCoverage();
      }).not.toThrow();
    });
  });

  describe("Reset", () => {
    it("reset clears all data", async () => {
      const profiler = new QueryProfiler();
      const profiledStore = profiler.attachToStore(store);

      await profiledStore
        .query()
        .from("Person", "p")
        .whereNode("p", (p) => p.email.eq("test@example.com"))
        .select((ctx) => ctx.p)
        .execute();

      profiler.reset();

      const report = profiler.getReport();
      expect(report.summary.totalQueries).toBe(0);
      expect(report.patterns.size).toBe(0);
    });
  });
});

// ============================================================
// Integration Tests: AST Extractor
// ============================================================

describe("AST Extractor", () => {
  it("extracts from comparison predicates", () => {
    const emailPointer = jsonPointer(["email"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) => p.email.eq("test@example.com"))
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const filterAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer,
    );
    expect(filterAccess).toBeDefined();
    expect(filterAccess!.entityType).toBe("node");
    expect(filterAccess!.kindNames).toEqual(["Person"]);
    expect(filterAccess!.predicateType).toBe("eq");
  });

  it("extracts from string predicates", () => {
    const namePointer = jsonPointer(["name"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) => p.name.contains("Alice"))
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const filterAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === namePointer,
    );
    expect(filterAccess).toBeDefined();
    expect(filterAccess!.predicateType).toBe("contains");
  });

  it("extracts from orderBy", () => {
    const namePointer = jsonPointer(["name"]);
    const builder = store.query().from("Person", "p");
    const query = builder.select((ctx) => ctx.p).orderBy("p", "name", "asc");

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const sortAccess = accesses.find(
      (a) =>
        a.context === "sort" &&
        a.target.__type === "prop" &&
        a.target.pointer === namePointer,
    );
    expect(sortAccess).toBeDefined();
  });

  it("extracts from projection", () => {
    // Note: Individual property selections (ctx.p.email) are not tracked
    // because the AST fetches the entire props blob. Only system fields
    // (id, kind) are tracked as separate select accesses.
    const builder = store.query().from("Person", "p");
    const query = builder.select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const selectAccesses = accesses.filter((a) => a.context === "select");
    expect(
      selectAccesses.some(
        (a) => a.target.__type === "system" && a.target.field === "id",
      ),
    ).toBe(true);
    expect(
      selectAccesses.some(
        (a) => a.target.__type === "system" && a.target.field === "kind",
      ),
    ).toBe(true);
  });

  it("extracts edge properties with entityType edge", () => {
    const rolePointer = jsonPointer(["role"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .traverse("worksAt", "w")
      .whereEdge("w", (w) => w.role.eq("Engineer"))
      .to("Company", "c")
      .select((ctx) => ctx.c);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const edgeFilterAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.entityType === "edge" &&
        a.target.__type === "prop" &&
        a.target.pointer === rolePointer,
    );
    expect(edgeFilterAccess).toBeDefined();
    expect(edgeFilterAccess!.kindNames).toEqual(["worksAt"]);
    expect(edgeFilterAccess!.predicateType).toBe("eq");
  });

  it("extracts from vector similarity predicates", () => {
    const embeddingPointer = jsonPointer(["embedding"]);
    const builder = store.query().from("Document", "d");
    const query = builder
      .whereNode("d", (d) => d.embedding.similarTo([0, 0, 0], 5))
      .select((ctx) => ctx.d);

    const accesses = extractPropertyAccesses(query.toAst());

    const vectorAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === embeddingPointer &&
        a.predicateType === "vector_similarity",
    );
    expect(vectorAccess).toBeDefined();
    expect(vectorAccess!.kindNames).toEqual(["Document"]);
  });

  it("extracts from EXISTS subquery predicates", () => {
    const industryPointer = jsonPointer(["industry"]);

    const subquery = store
      .query()
      .from("Company", "c")
      .whereNode("c", (c) => c.industry.eq("Tech"))
      .select((ctx) => ctx.c)
      .toAst();

    const query = store
      .query()
      .from("Person", "p")
      .whereNode("p", () => exists(subquery))
      .select((ctx) => ctx.p);

    const accesses = extractPropertyAccesses(query.toAst());

    const industryAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === industryPointer &&
        a.predicateType === "eq",
    );
    expect(industryAccess).toBeDefined();
    expect(industryAccess!.kindNames).toEqual(["Company"]);
  });

  it("extracts from IN subquery predicates", () => {
    const emailPointer = jsonPointer(["email"]);

    const subquery = store
      .query()
      .from("Person", "p2")
      .whereNode("p2", (p2) => p2.email.eq("test@example.com"))
      .aggregate({ email: field("p2", "email") })
      .toAst();

    const query = store
      .query()
      .from("Person", "p")
      .whereNode("p", () => inSubquery(field("p", "email"), subquery))
      .select((ctx) => ctx.p);

    const accesses = extractPropertyAccesses(query.toAst());

    const inAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer &&
        a.predicateType === "in_subquery",
    );
    expect(inAccess).toBeDefined();

    const subqueryAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer &&
        a.predicateType === "eq",
    );
    expect(subqueryAccess).toBeDefined();
  });

  it("extracts from HAVING aggregate comparisons", () => {
    const agePointer = jsonPointer(["age"]);

    const query = store
      .query()
      .from("Person", "p")
      .groupByNode("p")
      .having(havingGt(avg("p", "age"), 20))
      .aggregate({ avgAge: avg("p", "age") });

    const accesses = extractPropertyAccesses(query.toAst());

    const havingAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === agePointer &&
        a.predicateType === "avg_gt",
    );
    expect(havingAccess).toBeDefined();
  });

  it("extracts from AND predicates", () => {
    const emailPointer = jsonPointer(["email"]);
    const agePointer = jsonPointer(["age"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) => p.email.eq("test@example.com").and(p.age.gt(18)))
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const emailAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer,
    );
    const ageAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === agePointer,
    );

    expect(emailAccess).toBeDefined();
    expect(emailAccess!.predicateType).toBe("eq");
    expect(ageAccess).toBeDefined();
    expect(ageAccess!.predicateType).toBe("gt");
  });

  it("extracts from OR predicates", () => {
    const emailPointer = jsonPointer(["email"]);
    const namePointer = jsonPointer(["name"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) =>
        p.email.eq("test@example.com").or(p.name.contains("Alice")),
      )
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const emailAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer,
    );
    const nameAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === namePointer,
    );

    expect(emailAccess).toBeDefined();
    expect(nameAccess).toBeDefined();
    expect(nameAccess!.predicateType).toBe("contains");
  });

  it("extracts from NOT predicates", () => {
    const emailPointer = jsonPointer(["email"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) => p.email.eq("test@example.com").not())
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const emailAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer,
    );
    expect(emailAccess).toBeDefined();
    expect(emailAccess!.predicateType).toBe("eq");
  });

  it("extracts from nested AND/OR/NOT predicates", () => {
    const emailPointer = jsonPointer(["email"]);
    const namePointer = jsonPointer(["name"]);
    const agePointer = jsonPointer(["age"]);
    const builder = store.query().from("Person", "p");
    const query = builder
      .whereNode("p", (p) =>
        p.email
          .eq("test@example.com")
          .and(p.name.contains("Alice").or(p.age.gt(21)))
          .not(),
      )
      .select((ctx) => ctx.p);

    const ast = query.toAst();
    const accesses = extractPropertyAccesses(ast);

    const emailAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === emailPointer,
    );
    const nameAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === namePointer,
    );
    const ageAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === agePointer,
    );

    expect(emailAccess).toBeDefined();
    expect(nameAccess).toBeDefined();
    expect(ageAccess).toBeDefined();
  });

  it("includes expanded kinds for includeSubClasses aliases", () => {
    const namePointer = jsonPointer(["name"]);
    const builder = store.query().from("Organization", "o", {
      includeSubClasses: true,
    });
    const query = builder
      .whereNode("o", (o) => o.name!.eq("Acme"))
      .select((ctx) => ctx.o);

    const accesses = extractPropertyAccesses(query.toAst());

    const filterAccess = accesses.find(
      (a) =>
        a.context === "filter" &&
        a.target.__type === "prop" &&
        a.target.pointer === namePointer,
    );

    expect(filterAccess).toBeDefined();
    expect(filterAccess!.kindNames).toEqual(["Organization", "Company"]);
  });
});
