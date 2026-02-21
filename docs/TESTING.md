# Testing

Testing strategy and tooling for TypeGraph.

## Philosophy

We value tests that:

1. **Verify behavior, not implementation** - Test what the code does, not how it does it
2. **Cover real usage patterns** - Tests should mirror how users actually use the API
3. **Catch actual bugs** - Mutation testing validates that tests fail when code breaks
4. **Provide clear failure messages** - When tests fail, the cause should be obvious

We avoid:

- Tests that check language features or type system guarantees
- Tests that verify trivial getters/setters
- Tests that duplicate what property tests already cover
- Over-mocking that tests implementation details

## Test Types

### Unit Tests

Location: `packages/typegraph/tests/*.test.ts`

Standard behavior tests for individual modules:

```typescript
import { describe, expect, it } from "vitest";

describe("Feature", () => {
  it("does something specific", () => {
    const result = doThing(input);
    expect(result).toBe(expected);
  });
});
```

### Property-Based Tests

Location: `packages/typegraph/tests/property/*.test.ts`

Use [fast-check](https://github.com/dubzzz/fast-check) to verify invariants hold across random inputs:

```typescript
import fc from "fast-check";
import { describe, expect, it } from "vitest";

describe("properties", () => {
  it("maintains invariant under transformation", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = transform(input);
        expect(invariant(result)).toBe(true);
      })
    );
  });
});
```

Property tests are especially valuable for:

- Algorithmic correctness (closures, graph traversals)
- Serialization round-trips
- Constraint validation
- Pagination correctness

### Integration Tests

Location: `packages/typegraph/tests/backends/*.test.ts`

Tests that exercise complete workflows with real database backends.

The **adapter test suite** (`adapter-test-suite.ts`) defines a shared contract that all backends must satisfy:

```typescript
import { createAdapterTestSuite } from "./adapter-test-suite";

createAdapterTestSuite("SQLite", () => createTestBackend());
```

## Running Tests

```bash
# All tests
pnpm test

# Unit tests only
pnpm test:unit

# Property-based tests only
pnpm test:property

# PostgreSQL integration tests (requires running PostgreSQL)
pnpm test:postgres

# With coverage report
pnpm test:coverage
```

## Coverage

We use [@vitest/coverage-v8](https://vitest.dev/guide/coverage) for coverage reporting.

```bash
pnpm test:coverage
```

Reports are generated in:

- Console (text summary)
- `coverage/index.html` (detailed HTML report)
- `coverage/coverage-summary.json` (for CI)

### Thresholds

Coverage thresholds are configured in `vitest.config.ts`:

```typescript
coverage: {
  thresholds: {
    branches: 64,
    functions: 74,
    lines: 75,
  },
}
```

The test command will fail if coverage drops below these thresholds.

### Interpreting Coverage

High coverage doesn't guarantee good tests. A file can have 100% line coverage but still
have bugs if the tests don't verify correct behavior. This is where mutation testing helps.

## Mutation Testing

We use [Stryker Mutator](https://stryker-mutator.io/) to verify test quality.

Mutation testing works by:

1. Making small changes (mutations) to your code
2. Running tests against each mutant
3. Checking if tests fail (mutant "killed") or pass (mutant "survived")

A surviving mutant indicates a gap in test coverage - code that can change without tests noticing.

### Running Mutation Tests

```bash
# Full run (slow - 6000+ mutants)
pnpm test:mutation

# Targeted run (recommended)
npx stryker run --mutate "src/utils/*.ts"
npx stryker run --mutate "src/query/builder/*.ts"
```

### Interpreting Results

```text
[Survived] StringLiteral
src/utils/date.ts:49:9
-           `Expected format: YYYY-MM-DDTHH:mm:ss.sssZ`,
+           ``,
Tests ran: validateIsoDate throws ValidationError for invalid dates
```

This survived mutant tells us: the test verifies an error is thrown, but doesn't verify
the error message content. Whether to fix this depends on whether the message is part of
the API contract.

### Mutation Score

The mutation score is the percentage of mutants killed:

| Score | Interpretation |
|-------|----------------|
| > 80% | Good test quality |
| 60-80% | Acceptable, review survivors |
| < 60% | Tests may be weak |

Reports are generated at `reports/mutation/index.html`.

### Configuration

Stryker is configured in `stryker.config.json`:

```json
{
  "testRunner": "vitest",
  "mutate": ["src/**/*.ts", "!src/backend/drizzle/ddl.ts"],
  "incremental": true,
  "coverageAnalysis": "perTest"
}
```

Key options:

- `incremental: true` - Caches results between runs for faster iteration
- `coverageAnalysis: "perTest"` - Only runs relevant tests per mutant

## Writing Tests

### Test Structure

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import { createTestBackend, createTestDatabase } from "./test-utils";

describe("Module Name", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    // Fresh database for each test
    const db = createTestDatabase();
    backend = createTestBackend(db);
  });

  describe("feature", () => {
    it("handles the happy path", async () => {
      // Arrange
      const input = createInput();

      // Act
      const result = await backend.doThing(input);

      // Assert
      expect(result).toMatchObject({ expected: "shape" });
    });

    it("rejects invalid input", async () => {
      await expect(backend.doThing(invalid)).rejects.toThrow(ValidationError);
    });
  });
});
```

### Test Utilities

`test-utils.ts` provides:

```typescript
// In-memory SQLite backend for fast tests
const backend = createTestBackend();

// Direct database access when needed
const db = createTestDatabase();

// Pre-configured graph definitions for common test scenarios
const { graph, Person, Organization, worksAt } = createTestGraph();
```

### What to Test

**Do test:**

- Public API behavior
- Error conditions and edge cases
- Constraint enforcement
- Query results with various predicates
- Serialization round-trips

**Don't test:**

- Private implementation details
- Type definitions (TypeScript handles this)
- Third-party library behavior
- Trivial code (simple property access)

### Property Test Patterns

For algorithmic code, prefer property tests:

```typescript
// Instead of example-based tests
it("computes transitive closure", () => {
  const input = [["A", "B"], ["B", "C"]];
  const closure = computeClosure(input);
  expect(closure.get("A")).toContain("C");
});

// Prefer property-based tests
it("closure is transitive", () => {
  fc.assert(
    fc.property(relationsArb, (relations) => {
      const closure = computeClosure(relations);
      // If A→B and B→C in closure, then A→C must be in closure
      for (const [a, b] of closure) {
        for (const [b2, c] of closure) {
          if (b === b2) {
            expect(closure.has(a, c)).toBe(true);
          }
        }
      }
    })
  );
});
```

## CI Integration

Tests run on every PR via Turbo:

```bash
turbo run test
```

Coverage thresholds are enforced when running `pnpm test:coverage`. CI currently runs unit/property
tests by default.
