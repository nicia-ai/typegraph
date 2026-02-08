/**
 * Cursor Pagination and Streaming Tests
 *
 * Tests for the paginate() and stream() methods on ExecutableQuery.
 * These provide efficient large dataset handling via keyset pagination.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  ValidationError,
} from "../src";
import { createTestBackend } from "./test-utils";

// ============================================================
// Test Graph Setup
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().optional(),
  }),
});

const Company = defineNode("Company", {
  schema: z.object({
    name: z.string(),
    revenue: z.number(),
  }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({
    role: z.string(),
    startYear: z.number(),
  }),
});

const graph = defineGraph({
  id: "pagination_test",
  nodes: {
    Person: { type: Person },
    Company: { type: Company },
  },
  edges: {
    worksAt: {
      type: worksAt,
      from: [Person],
      to: [Company],
      cardinality: "many",
    },
  },
});

// ============================================================
// Test Helpers
// ============================================================

function createTestStore() {
  const backend = createTestBackend();
  return createStore(graph, backend);
}

async function seedTestData(
  store: Awaited<ReturnType<typeof createTestStore>>,
) {
  // Create 25 people with distinct names for pagination testing
  const people = [];
  for (let index = 1; index <= 25; index++) {
    const person = await store.nodes.Person.create({
      name: `Person_${String(index).padStart(2, "0")}`,
      age: 20 + index,
      email: `person${index}@example.com`,
    });
    people.push(person);
  }

  // Create some companies
  const companies = [];
  for (let index = 1; index <= 5; index++) {
    const company = await store.nodes.Company.create({
      name: `Company_${index}`,
      revenue: index * 1_000_000,
    });
    companies.push(company);
  }

  return { people, companies };
}

// ============================================================
// Pagination Tests
// ============================================================

describe("Cursor Pagination", () => {
  it("returns first page of results", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const page = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 5 });

    expect(page.data.length).toBe(5);
    expect(page.hasNextPage).toBe(true);
    expect(page.hasPrevPage).toBe(false);
    expect(page.nextCursor).toBeDefined();
    expect(page.prevCursor).toBeUndefined();

    // Results should be ordered by name
    expect(page.data[0]!.name).toBe("Person_01");
    expect(page.data[4]!.name).toBe("Person_05");
  });

  it("fetches next page using cursor", async () => {
    const store = createTestStore();
    await seedTestData(store);

    // Get first page
    const page1 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 5 });

    // Get second page using cursor
    const page2 = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 5, after: page1.nextCursor! });

    expect(page2.data.length).toBe(5);
    expect(page2.hasNextPage).toBe(true);
    expect(page2.hasPrevPage).toBe(true);

    // Should continue from where page1 left off
    expect(page2.data[0]!.name).toBe("Person_06");
    expect(page2.data[4]!.name).toBe("Person_10");
  });

  it("detects last page correctly", async () => {
    const store = createTestStore();
    await seedTestData(store); // 25 people total

    // Get first 4 pages of 5
    let cursor: string | undefined;
    for (let index = 0; index < 4; index++) {
      const page = await store
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ctx.p)
        .paginate({ first: 5, ...(cursor ? { after: cursor } : {}) });
      cursor = page.nextCursor;
    }

    // Fifth page should be the last (only 5 remaining)
    const lastPage = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 5, ...(cursor ? { after: cursor } : {}) });

    expect(lastPage.data.length).toBe(5);
    expect(lastPage.hasNextPage).toBe(false);
    expect(lastPage.data[0]!.name).toBe("Person_21");
    expect(lastPage.data[4]!.name).toBe("Person_25");
  });

  it("handles empty result set", async () => {
    const store = createTestStore();
    // Don't seed any data

    const page = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 10 });

    expect(page.data.length).toBe(0);
    expect(page.hasNextPage).toBe(false);
    expect(page.hasPrevPage).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    expect(page.prevCursor).toBeUndefined();
  });

  it("respects where clauses", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const page = await store
      .query()
      .from("Person", "p")
      .whereNode("p", (n) => n.age.gte(40))
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 10 });

    // Only people with age >= 40 (age = 20 + i, so i >= 20)
    expect(page.data.length).toBe(6); // Person 20-25
    expect(page.data.every((p) => p.age >= 40)).toBe(true);
  });

  it("handles descending order", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const page = await store
      .query()
      .from("Person", "p")
      .orderBy("p", "name", "desc")
      .select((ctx) => ctx.p)
      .paginate({ first: 5 });

    expect(page.data[0]!.name).toBe("Person_25");
    expect(page.data[4]!.name).toBe("Person_21");
  });

  it("handles multiple order columns", async () => {
    const backend = createTestBackend();
    const store2 = createStore(graph, backend);

    // Create people with same age but different names
    for (let index = 0; index < 10; index++) {
      await store2.nodes.Person.create({
        name: `Person_${String(index).padStart(2, "0")}`,
        age: index < 5 ? 30 : 40, // Two age groups
      });
    }

    const page1 = await store2
      .query()
      .from("Person", "p")
      .orderBy("p", "age")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .paginate({ first: 3 });

    expect(page1.data[0]!.age).toBe(30);
    expect(page1.data[0]!.name).toBe("Person_00");
  });

  it("throws ValidationError without ORDER BY", async () => {
    const store = createTestStore();

    await expect(
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .paginate({ first: 10 }),
    ).rejects.toThrow(ValidationError);
  });

  it("throws ValidationError for invalid cursor", async () => {
    const store = createTestStore();

    await expect(
      store
        .query()
        .from("Person", "p")
        .orderBy("p", "name")
        .select((ctx) => ctx.p)
        .paginate({ first: 10, after: "invalid-cursor" }),
    ).rejects.toThrow(ValidationError);
  });
});

// ============================================================
// Streaming Tests
// ============================================================

describe("Streaming", () => {
  it("streams all results", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const results: unknown[] = [];
    for await (const person of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .stream({ batchSize: 7 })) {
      results.push(person);
    }

    expect(results.length).toBe(25);
    // Verify ordering
    expect((results[0] as { name: string }).name).toBe("Person_01");
    expect((results[24] as { name: string }).name).toBe("Person_25");
  });

  it("handles small batch size", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const results: unknown[] = [];
    for await (const person of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .stream({ batchSize: 3 })) {
      results.push(person);
    }

    expect(results.length).toBe(25);
  });

  it("allows early termination", async () => {
    const store = createTestStore();
    await seedTestData(store);

    const results: unknown[] = [];
    for await (const person of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .stream({ batchSize: 10 })) {
      results.push(person);
      if (results.length >= 5) break;
    }

    expect(results.length).toBe(5);
  });

  it("handles empty result set", async () => {
    const store = createTestStore();

    const results: unknown[] = [];
    for await (const person of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .stream()) {
      results.push(person);
    }

    expect(results.length).toBe(0);
  });

  it("uses default batch size of 1000", async () => {
    const store = createTestStore();
    await seedTestData(store);

    // Just verify it works without explicit batchSize
    const results: unknown[] = [];
    for await (const person of store
      .query()
      .from("Person", "p")
      .orderBy("p", "name")
      .select((ctx) => ctx.p)
      .stream()) {
      results.push(person);
    }

    expect(results.length).toBe(25);
  });

  it("throws ValidationError without ORDER BY", () => {
    const store = createTestStore();

    expect(() =>
      store
        .query()
        .from("Person", "p")
        .select((ctx) => ctx.p)
        .stream(),
    ).toThrow(ValidationError);
  });
});
