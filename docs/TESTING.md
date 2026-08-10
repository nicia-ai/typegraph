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

Location: `packages/typegraph/tests/backends/`

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

# PostgreSQL integration tests (requires Docker; manages its test service)
pnpm test:postgres

# Every runnable SQLite example
pnpm test:examples

# PostgreSQL example (requires POSTGRES_URL)
pnpm test:examples:postgres

# Render docs, check internal routes/anchors, and typecheck documented imports
pnpm test:docs:release

# With coverage report
pnpm test:coverage
```

`pnpm test:postgres` manages its Docker test service automatically. The
PostgreSQL example runner intentionally uses `POSTGRES_URL` so it can exercise
the same caller-supplied connection configuration shown to users.

### Per-suite PostgreSQL databases

Every server-PostgreSQL suite owns the graph tables it operates on: `beforeEach`
hooks `TRUNCATE` them, `beforeAll` hooks re-run the migration SQL, and a few
suites `DROP` them outright. To make that ownership true rather than assumed,
each test *file* runs against its own database, named after the file and
recreated on demand from the `POSTGRES_URL` database:

```text
POSTGRES_URL=…/typegraph_test  ->  typegraph_test__postgres_backend
                                   typegraph_test__identity_enablement_lock
                                   …
```

Suites opt in by resolving their connection URL through the shared helper
instead of reading `POSTGRES_URL` directly:

```typescript
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
```

Consequences worth knowing:

- **A new PostgreSQL suite must bootstrap its own tables** (usually
  `await pool.query(generatePostgresMigrationSQL())` in `beforeAll`). It cannot
  inherit them from whichever suite happened to run first.
- **A suite outside `tests/backends/postgres/` must be named in
  `scripts/test-postgres.sh`.** The lane picks up that directory wholesale, but
  mixed-backend suites — the SQLite family in the default lane plus a
  PostgreSQL leg when `POSTGRES_URL` is set — live elsewhere and are listed
  file by file. Forgetting one is invisible: the default lane skips the
  PostgreSQL leg for want of `POSTGRES_URL` and the PostgreSQL lane never loads
  the file, so the leg runs nowhere and the suite still reports green.
  `tests/postgres-lane-coverage.test.ts` fails when a suite that imports
  `provisionPostgresTestDatabase` is missing from the script.
- **The `POSTGRES_URL` role needs `CREATEDB`.** Set
  `TYPEGRAPH_TEST_SHARED_DATABASE=1` to opt out and run every suite against the
  base database — the pre-isolation behaviour, including its cross-suite
  `TRUNCATE`/`DROP` hazards.
- **One vitest invocation at a time per `POSTGRES_URL`.** Two invocations
  resolve the same suite to the same database name, and provisioning drops it
  with `WITH (FORCE)`. Concurrent lanes (for example one per worktree) must use
  separate base databases.
- The per-suite databases are deliberately left behind so a failure stays
  inspectable; the next run recreates them. The Docker container is also left
  running between runs (`up -d --wait` reuses it idempotently), both to skip
  the start/stop cycle and so one invocation's exit cannot tear the server out
  from under a concurrent invocation. Set `TYPEGRAPH_POSTGRES_DOWN=1` to
  restore teardown-on-exit, or stop it manually with
  `docker compose -f packages/typegraph/docker-compose.yml down`. A warm
  server carries no state a run depends on — the per-suite databases are
  dropped and recreated — but leftovers from inspection do accumulate until
  the container is recreated.

The lane runs its suites **file-parallel**, and the worker count follows who
provisioned the server. The bundled `docker-compose.yml` starts PostgreSQL
with `max_connections=400`, which affords `min(6, cores)` workers (each worker
holds at least one pool, and graph-merge property fixtures keep several
backends alive at once). An externally supplied `POSTGRES_URL` has an unknown
connection budget, so it defaults to **one** worker — the pre-parallel
behaviour — until you state a cap explicitly with `TYPEGRAPH_PG_MAX_WORKERS`
after budgeting your server the same way (CI does exactly this: it raises
`max_connections` on its service container, then sets the cap beside that
step). "sorry, too many clients already" mid-suite is the symptom of a cap
your server cannot fund. The graph-merge and pglite vitest projects, which
serialize their files in the default SQLite lane, opt back into parallelism
only when the lane actually runs multi-worker. Reproducing a single failure
with a parallel invocation of a few files remains safe at any worker count —
isolation comes from the per-suite databases, never from serialization. The
one-invocation-per-`POSTGRES_URL` restriction above still applies: worker
parallelism is *within* an invocation, and concurrent invocations still race
on database names.

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

### Changed-Line Mutation Testing on Pull Requests

[`.github/workflows/mutation.yml`](../.github/workflows/mutation.yml) runs Stryker on every pull request
that touches `packages/typegraph/src`, mutating **only the lines that pull request changed**. It computes
the scope from the diff, runs `stryker.diff.config.json` against it, and writes the changed-line mutation
score, the per-status counts, and the location of every survived mutant to the job summary. The full JSON
report is attached as a workflow artifact.

Why changed lines rather than whole files: a whole-file run over the files a typical pull request touches
takes hours, which is unaffordable per pull request, while the same run restricted to the changed line
ranges finishes in minutes. Scoping to the diff also keeps the signal actionable — every survivor it
reports is a mutant in code this pull request wrote, not pre-existing debt in a file it happened to open.

The scope script and the config it feeds:

```bash
cd packages/typegraph

# List the changed-line ranges this branch would mutate
pnpm test:mutation:diff

# Run Stryker against exactly those ranges
npx stryker run stryker.diff.config.json --mutate "$(node --import tsx scripts/mutation-diff.ts --csv)"
```

`scripts/mutation-diff.ts` diffs `$MUTATION_BASE_REF...HEAD` (default base: `origin/main`, three-dot, so
only this branch's own commits count) over `packages/typegraph/src/**/*.ts`, skipping `.d.ts` files,
deleted files, and files with deletions only. Ranges separated by fewer than ten unchanged lines merge
into one entry. It emits `src/<path>.ts:<start>-<end>` entries — one per line by default, comma-joined
with `--csv`, or a JSON array with `--json` — and exits 0 with no entries when nothing is mutable, which
is the signal CI uses to skip the run entirely.

`stryker.diff.config.json` runs the default vitest config, so the dry run executes the whole suite
(roughly 25 minutes) before any mutant is tested; per-mutant runs are cheap after that because
`coverageAnalysis: "perTest"` narrows each mutant to the tests that actually cover it. That trade is
deliberate: a narrower dry-run scope is faster but risks attributing a mutant's survival to a test file
the scoped config never loaded. `ignoreStatic: true` drops mutants that only execute while a module
loads — killing those requires reloading the environment and re-running everything, and they say little
about the changed behavior. The incremental cache (`.stryker-cache/incremental-diff.json`) is restored
across runs on the same branch, so a follow-up push only retests what moved.

The threshold is `break: null`: surviving mutants annotate the pull request but do not fail it. Making
the job blocking is a one-line change to that field once the signal is quiet across the fleet.

**Triage discipline.** A survived mutant on a changed line gets one of two things before the pull request
merges: a test that kills it, or a written justification in the pull request description explaining why
the mutation is not observable behavior (an unreachable defensive branch, a log message that is not part
of any contract). Survivors on lines the pull request did not change are pre-existing debt and are out of
scope for that review — the job never reports them. This is the mechanical enforcement of the
[Load-Bearing Tests](../AGENTS.md#load-bearing-tests) rule: a test that cannot fail when the behavior it
guards breaks is coverage theater, and a surviving mutant is the machine finding exactly that.

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

Every pull request to `main` must pass the full gate defined in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It is much broader
than the local `pnpm test` default (which runs only SQLite unit/property
tests). The jobs are:

| Job | What it runs |
|-----|--------------|
| **Lint & Type Check** | `typecheck`, `lint` (ESLint), `prettier`, `test:docs` (markdownlint), `test:unused` (knip) |
| **Test (SQLite)** | `test:unit` + `test:property` on Node 22 and 24, plus a SQLite perf sanity check and an example smoke test |
| **Test (Coverage)** | `test:coverage` — enforces the coverage thresholds |
| **Type Tests** | `test:types` against TypeScript 5.9.3 and 6.0.2 |
| **Test (PostgreSQL)** | `test:postgres` against `pgvector/pgvector:pg18` (PostgreSQL + pgvector), plus a PostgreSQL perf sanity check |
| **Test (Durable Objects SQLite)** | `test:do` — the workerd / Cloudflare Durable Objects SQLite lane |
| **Build** | `turbo run build` — gated on every job above |

A separate [release workflow](../.github/workflows/release.yml) packs the npm
tarball after CI passes and smoke-imports every public subpath (ESM + CJS)
before publishing. A separate
[mutation workflow](../.github/workflows/mutation.yml) runs changed-line
mutation testing on pull requests that touch `packages/typegraph/src`; it
annotates the pull request but does not gate it (see
[Changed-Line Mutation Testing on Pull Requests](#changed-line-mutation-testing-on-pull-requests)).

To reproduce the core gate locally before pushing, run `pnpm fix && pnpm
typecheck && pnpm test`, then `pnpm test:postgres` (Docker-backed) for any
change touching backend, store, or collection code. Coverage thresholds are
enforced by `pnpm test:coverage`.
