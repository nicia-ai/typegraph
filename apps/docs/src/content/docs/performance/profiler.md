---
title: Query Profiler
description: Capture query patterns and generate index recommendations
---

The Query Profiler captures property access patterns from your queries and generates
index recommendations. Use it during development or in test suites to identify missing indexes.

## Quick Start

```typescript
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";

// Create a profiler and attach it to your store
const profiler = new QueryProfiler();
const profiledStore = profiler.attachToStore(store);

// Run queries as normal - they're automatically tracked
await profiledStore
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("alice@example.com"))
  .select((ctx) => ({ name: ctx.p.name }))
  .execute();

// Get recommendations
const report = profiler.getReport();

for (const rec of report.recommendations) {
  console.log(
    `[${rec.priority}] ${rec.entityType}:${rec.kind} ${rec.fields.join(", ")}`,
  );
  console.log(`  ${rec.reason}`);
}
```

## How It Works

The profiler uses JavaScript Proxy to transparently wrap your store and query builders. When
queries execute, it extracts property access patterns from the query AST:

- **Filter patterns**: Properties used in `.whereNode()` and `.whereEdge()` predicates
- **Sort patterns**: Properties used in `.orderBy()`
- **Select patterns**: Properties accessed in `.select()` callbacks
- **Group patterns**: Properties used in `.groupBy()`

The profiler then compares these patterns against your declared indexes and generates
recommendations for missing coverage.

## Kinds and `includeSubClasses`

When you query with `includeSubClasses: true`, a single alias can represent multiple kinds.
When the profiler is attached to a store, it uses the graph schema to attribute a property access
only to kinds where that JSON path exists. This avoids recommending indexes for unrelated subclasses.

## Attaching to a Store

```typescript
const profiler = new QueryProfiler();
const profiledStore = profiler.attachToStore(store);

// The profiled store behaves exactly like the original
await profiledStore.nodes.Person.create({ email: "bob@example.com", name: "Bob" });

// Queries are tracked automatically
await profiledStore.query().from("Person", "p").select((ctx) => ctx.p).execute();

// Access the profiler from the store
profiledStore.profiler.getReport();
```

The profiled store exposes a `profiler` property for convenient access.

## Declaring Existing Indexes

Pass your existing indexes so the profiler doesn't recommend indexes you already have:

```typescript
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
import { toDeclaredIndexes } from "@nicia-ai/typegraph/indexes";
import { personEmail, worksAtRole } from "./indexes";

const profiler = new QueryProfiler({
  declaredIndexes: toDeclaredIndexes([personEmail, worksAtRole]),
});
```

You can also declare indexes manually:

```typescript
const profiler = new QueryProfiler({
  declaredIndexes: [
    {
      entityType: "node",
      kind: "Person",
      fields: ["/email"],
      unique: true,
      name: "idx_person_email",
    },
    {
      entityType: "node",
      kind: "Person",
      fields: ["/name"],
      unique: false,
      name: "idx_person_name",
    },
  ],
});
```

## Understanding the Report

```typescript
const report = profiler.getReport();
```

The report contains:

### `recommendations`

Prioritized index recommendations sorted by importance:

```typescript
for (const rec of report.recommendations) {
  console.log(
    `[${rec.priority}] ${rec.entityType}:${rec.kind} ${rec.fields.join(", ")}`,
  );
  console.log(`  Reason: ${rec.reason}`);
  console.log(`  Frequency: ${rec.frequency}`);
}
```

**Priority levels:**

- `high`: Property accessed 10+ times in filters/sorts (configurable)
- `medium`: Property accessed 5-9 times (configurable)
- `low`: Property accessed 3-4 times (configurable)

### `unindexedFilters`

Properties used in filter predicates that lack index coverage:

```typescript
for (const path of report.unindexedFilters) {
  const target =
    path.target.__type === "prop" ? path.target.pointer : path.target.field;
  console.log(`Unindexed filter: ${path.entityType}:${path.kind} ${target}`);
}
```

### `patterns`

Raw property access statistics:

```typescript
for (const [key, stats] of report.patterns) {
  console.log(`${key}: ${stats.count} accesses`);
  console.log(`  Contexts: ${[...stats.contexts].join(", ")}`);
  console.log(`  Predicates: ${[...stats.predicateTypes].join(", ")}`);
}
```

### `summary`

Session statistics:

```typescript
console.log(`Total queries: ${report.summary.totalQueries}`);
console.log(`Unique patterns: ${report.summary.uniquePatterns}`);
console.log(`Duration: ${report.summary.durationMs}ms`);
```

## Test Assertions

Use `assertIndexCoverage()` to fail tests when queries filter on unindexed properties:

```typescript
import { describe, it, beforeAll, afterAll } from "vitest";
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";

describe("Query Performance", () => {
  let profiler: QueryProfiler;
  let profiledStore: ProfiledStore<typeof graph>;

  beforeAll(() => {
    profiler = new QueryProfiler({
      declaredIndexes: toDeclaredIndexes([personEmail, personName]),
    });
    profiledStore = profiler.attachToStore(store);
  });

  // Run your test suite against profiledStore...

  it("all filtered properties should be indexed", () => {
    // Throws if any filter property lacks an index
    profiler.assertIndexCoverage();
  });
});
```

## Configuration

```typescript
const profiler = new QueryProfiler({
  // Indexes you already have
  declaredIndexes: [...],

  // Minimum frequency to generate a recommendation (default: 3)
  minFrequencyForRecommendation: 5,

  // Optional priority thresholds (defaults: 5 and 10)
  mediumFrequencyThreshold: 8,
  highFrequencyThreshold: 20,
});
```

## Lifecycle Methods

```typescript
// Reset collected data (keeps configuration)
profiler.reset();

// Detach from store (allows reattachment)
profiler.detach();

// Check attachment status
if (profiler.isAttached) {
  console.log("Profiler is attached to a store");
}
```

## Manual Recording

For custom integrations, record queries directly from their AST:

```typescript
const query = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("test@example.com"))
  .select((ctx) => ctx.p);

// Record without executing
profiler.recordQuery(query.toAst());
```

## Composite Index Detection

The profiler understands composite index prefix matching. If you have an index on `["email", "name"]`,
queries filtering on just `email` are considered covered:

```typescript
const profiler = new QueryProfiler({
  declaredIndexes: [
    {
      entityType: "node",
      kind: "Person",
      fields: ["/email", "/name"],
      unique: false,
      name: "idx_email_name",
    },
  ],
});

// This query IS covered (uses the email prefix of the composite index)
await profiledStore
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.email.eq("test@example.com"))
  .execute();

// No recommendation generated for email
```

## Best Practices

1. **Profile realistic workloads**: Run your actual queries or test suite, not synthetic benchmarks.

2. **Profile before optimizing**: Don't guess which indexes you need - let the profiler tell you.

3. **Use in CI**: Add `assertIndexCoverage()` to your test suite to catch regressions.

4. **Declare all indexes**: Pass your existing indexes so recommendations are accurate.

5. **Review frequency**: High-frequency patterns are most important to index.

## Next Steps

- [Indexes](/performance/indexes) - Create the indexes the profiler recommends
- [Performance Overview](/performance/overview) - Best practices and smart select
