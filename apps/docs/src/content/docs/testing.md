---
title: Testing
description: Patterns for testing code that uses TypeGraph
---

TypeGraph's in-memory SQLite backend makes tests fast and isolated — each test gets a fresh
database with zero setup cost. This guide covers test utilities, common patterns, and strategies
for testing at different levels.

## Test Setup

### In-memory backend (recommended)

`createLocalSqliteBackend()` creates an in-memory SQLite database with TypeGraph tables
pre-configured. Each call returns a completely isolated database.

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
import { createStore } from "@nicia-ai/typegraph";
import { graph } from "../src/graph"; // your graph definition

describe("Person queries", () => {
  let store: ReturnType<typeof createStore<typeof graph>>;

  beforeEach(() => {
    const { backend } = createLocalSqliteBackend();
    store = createStore(graph, backend);
  });

  it("creates and retrieves a person", async () => {
    const alice = await store.nodes.Person.create({
      name: "Alice",
      email: "alice@example.com",
    });

    const found = await store.nodes.Person.getById(alice.id);
    expect(found?.props.name).toBe("Alice");
  });
});
```

No teardown is needed — the in-memory database is garbage collected when the backend goes out
of scope.

### Shared test helper

If many test files use the same setup, extract a helper:

```typescript
// tests/test-helpers.ts
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
import { createStore } from "@nicia-ai/typegraph";
import { graph } from "../src/graph";

export function createTestStore() {
  const { backend } = createLocalSqliteBackend();
  return createStore(graph, backend);
}
```

```typescript
// tests/person.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { createTestStore } from "./test-helpers";

describe("Person", () => {
  let store: ReturnType<typeof createTestStore>;

  beforeEach(() => {
    store = createTestStore();
  });

  // tests...
});
```

### createStore vs createStoreWithSchema

| Factory | Sync? | Schema management | Use for |
|---------|-------|-------------------|---------|
| `createStore(graph, backend)` | Yes | None | Tests, local dev |
| `createStoreWithSchema(graph, backend)` | No | Auto-init, auto-migrate | Production, schema evolution tests |

Use `createStore` for most tests — it's synchronous and avoids async setup. Use
`createStoreWithSchema` when you're specifically testing schema migrations or evolution:

```typescript
import { createStoreWithSchema } from "@nicia-ai/typegraph";

it("migrates from v1 to v2", async () => {
  const { backend } = createLocalSqliteBackend();

  // Initialize with v1 schema
  const [storeV1] = await createStoreWithSchema(graphV1, backend);
  await storeV1.nodes.Person.create({ name: "Alice" });

  // Migrate to v2 schema
  const [storeV2, result] = await createStoreWithSchema(graphV2, backend);
  expect(result.status).toBe("migrated");
});
```

## Testing Queries

### Seed data, then query

The typical pattern is: create data through the collection API, then verify queries return
the expected results.

```typescript
it("finds friends-of-friends", async () => {
  // Seed
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const carol = await store.nodes.Person.create({ name: "Carol" });

  await store.edges.knows.create(alice, bob, {});
  await store.edges.knows.create(bob, carol, {});

  // Query
  const fof = await store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.id.eq(alice.id))
    .traverse("knows", "e")
    .recursive({ minHops: 2, maxHops: 2 })
    .to("Person", "friend")
    .select((ctx) => ctx.friend.name)
    .execute();

  expect(fof).toEqual(["Carol"]);
});
```

### Bulk seeding

For tests that need a larger dataset, use `bulkCreate` for speed:

```typescript
beforeEach(async () => {
  const people = Array.from({ length: 100 }, (_, i) => ({
    props: { name: `Person ${i}`, email: `person${i}@example.com` },
  }));
  await store.nodes.Person.bulkCreate(people);
});
```

### Testing query shapes with toSQL()

You can inspect the generated SQL without executing to verify query structure:

```typescript
it("compiles a traversal to a single statement", () => {
  const query = store
    .query()
    .from("Person", "p")
    .traverse("worksAt", "e")
    .to("Company", "c")
    .select((ctx) => ({ person: ctx.p.name, company: ctx.c.name }));

  const { sql } = query.toSQL();
  expect(sql).toContain("WITH");
  expect(sql).not.toContain(";"); // single statement
});
```

### Testing prepared queries

```typescript
it("executes prepared queries with different bindings", async () => {
  await store.nodes.Person.create({ name: "Alice" });
  await store.nodes.Person.create({ name: "Bob" });

  const prepared = store
    .query()
    .from("Person", "p")
    .whereNode("p", (p) => p.name.eq(p.name.bind("targetName")))
    .select((ctx) => ctx.p.name)
    .prepare();

  const alice = await prepared.execute({ targetName: "Alice" });
  const bob = await prepared.execute({ targetName: "Bob" });

  expect(alice).toEqual(["Alice"]);
  expect(bob).toEqual(["Bob"]);
});
```

## Testing Transactions

Verify atomicity by asserting that failed transactions leave no partial data:

```typescript
it("rolls back on error", async () => {
  try {
    await store.transaction(async (tx) => {
      await tx.nodes.Person.create({ name: "Alice" });
      throw new Error("abort");
    });
  } catch {
    // expected
  }

  const all = await store
    .query()
    .from("Person", "p")
    .select((ctx) => ctx.p)
    .execute();

  expect(all).toHaveLength(0); // Alice was rolled back
});
```

## Testing with the Query Profiler

Use the [Query Profiler](/performance/profiler) in tests to catch unindexed filter patterns
before they reach production.

```typescript
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
import { toDeclaredIndexes } from "@nicia-ai/typegraph/indexes";
import { personEmail } from "../src/indexes";

describe("Index coverage", () => {
  it("all query filters have index coverage", async () => {
    const profiler = new QueryProfiler({
      declaredIndexes: toDeclaredIndexes([personEmail]),
    });
    const profiledStore = profiler.attachToStore(store);

    // Run representative queries
    await profiledStore
      .query()
      .from("Person", "p")
      .whereNode("p", (p) => p.email.eq("alice@example.com"))
      .select((ctx) => ctx.p.name)
      .execute();

    // Fails if any filter property lacks an index
    profiler.assertIndexCoverage();
  });
});
```

This is particularly effective when run against your full test suite — it catches filter patterns
across all tests, not just the ones you remember to check manually.

## PostgreSQL Integration Tests

For tests that verify PostgreSQL-specific behavior (JSONB operators, GIN indexes, concurrent
writes), connect to a real database:

```typescript
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { createPostgresBackend, generatePostgresMigrationSQL } from "@nicia-ai/typegraph/postgres";

describe("PostgreSQL integration", () => {
  let pool: Pool;
  let store: ReturnType<typeof createStore<typeof graph>>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(generatePostgresMigrationSQL());
    const db = drizzle(pool);
    const backend = createPostgresBackend(db);
    store = createStore(graph, backend);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE typegraph_nodes, typegraph_edges CASCADE");
  });

  it("handles concurrent writes", async () => {
    const creates = Array.from({ length: 100 }, (_, i) =>
      store.nodes.Person.create({ name: `Person ${i}` }),
    );
    await Promise.all(creates);

    const count = await store.nodes.Person.count();
    expect(count).toBe(100);
  });
});
```

### Skipping when no database is available

Guard PostgreSQL tests so they're skipped in environments without a database:

```typescript
const describePostgres = process.env.TEST_DATABASE_URL
  ? describe
  : describe.skip;

describePostgres("PostgreSQL-specific", () => {
  // ...
});
```

## Testing Pyramid

| Level | Backend | Speed | Isolation | When to use |
|-------|---------|-------|-----------|-------------|
| Unit | In-memory SQLite | Fast (~1ms setup) | Full (fresh DB per test) | Collection API, query logic, business rules |
| Integration | SQLite file or PostgreSQL | Medium | Shared (truncate between tests) | Concurrency, transactions, backend-specific behavior |
| Profiler | In-memory SQLite | Fast | Full | Index coverage, query pattern verification |

Most tests should be unit tests with in-memory SQLite. Reserve PostgreSQL integration tests for
behavior that differs across backends (array containment, concurrent writes, isolation levels).

## Next Steps

- [Backend Setup](/backend-setup) — Configure SQLite and PostgreSQL backends
- [Query Profiler](/performance/profiler) — Automatic index recommendations
- [Schemas & Stores](/schemas-stores) — Collection API reference
