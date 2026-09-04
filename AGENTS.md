---
alwaysApply: true
---

# Philosophy

- Follow requirements carefully and to the letter
- Think step-by-step, describe your plan, then implement
- Fully implement all functionality - no TODOs, placeholders, or missing pieces
- Prioritize readability and maintainability over performance optimization
- If uncertain, say so rather than guessing

# Project Structure

Monorepo using Turbo with pnpm workspaces.

```
typegraph/
├── packages/
│   ├── typegraph/          # Core library (@nicia-ai/typegraph)
│   │   ├── src/
│   │   │   ├── backend/    # Database backends (SQLite, PostgreSQL, Drizzle)
│   │   │   ├── core/       # Node/edge definitions, graph DSL
│   │   │   ├── query/      # Query builder, predicates, SQL compilation
│   │   │   ├── store/      # Runtime store, collections, operations
│   │   │   ├── ontology/   # Semantic relationships (subClassOf, etc.)
│   │   │   ├── schema/     # Serialization, migration, versioning
│   │   │   ├── errors/     # Error types
│   │   │   └── utils/      # Shared utilities (Result, date, id)
│   │   ├── tests/          # Unit and integration tests
│   │   │   ├── property/   # Property-based tests (fast-check)
│   │   │   └── backends/   # Backend-specific tests
│   │   └── examples/       # Runnable examples
│   ├── eslint-config/      # Shared ESLint configuration
│   └── benchmarks/         # Performance benchmarks
├── apps/
│   └── docs/               # Documentation site (Astro/Starlight)
└── package.json            # Monorepo root (pnpm + turbo)
```

# Tech Stack

- **Zod** - Schema validation and TypeScript type inference
- **Drizzle ORM** - Database abstraction for SQLite and PostgreSQL
- **Vitest** - Test runner
- **fast-check** - Property-based testing
- **Stryker** - Mutation testing
- **tsup** - Build tool

# Common Commands

```bash
# From repository root
pnpm install              # Install all dependencies
pnpm build                # Build all packages
pnpm test                 # Run all tests (SQLite only, postgres tests are skipped)
pnpm test:postgres        # Run PostgreSQL tests (starts Docker automatically)
pnpm lint                 # Run ESLint
pnpm typecheck            # TypeScript type checking
pnpm fix                  # Auto-fix lint and formatting (prettier + eslint --fix + markdownlint)
pnpm test:unused          # Run knip (unused exports, deps, files)

# From packages/typegraph
pnpm test                 # Run unit tests
pnpm test:unit            # Run unit tests only
pnpm test:property        # Run property-based tests
pnpm test:postgres        # Run PostgreSQL tests (starts Docker automatically)
pnpm test:coverage        # Run tests with coverage
pnpm test:mutation        # Run mutation testing
```

# Before Committing

Running `pnpm typecheck` and `pnpm lint` separately is *not* enough —
prettier rules live outside eslint, and those commands won't surface
formatting drift. The canonical pre-commit sequence is:

```bash
pnpm fix && pnpm typecheck && pnpm test
```

`pnpm fix` chains prettier, eslint `--fix` (so a separate `pnpm lint`
is redundant), and markdownlint, exiting non-zero on any unfixable
violation. If it modifies files, fold the changes into the same
commit — they aren't a separate concern.

**Important:** `pnpm test` runs only SQLite-backed tests. The PostgreSQL
backend tests are **skipped** unless `POSTGRES_URL` is set. Always run
`pnpm test:postgres` (from the repo root or `packages/typegraph`) to verify
changes that touch backend, store, or collection code. The script handles
Docker lifecycle automatically — no manual setup required.

Each server-PostgreSQL suite runs against its own database, provisioned from
`POSTGRES_URL` by `tests/postgres-test-database.ts`. A new suite therefore
resolves its URL with `await provisionPostgresTestDatabase(import.meta.url)`
and creates its own tables in `beforeAll` — it cannot inherit them from
another suite. See [Per-suite PostgreSQL databases](docs/TESTING.md#per-suite-postgresql-databases).

# Pull Requests

Squash merges use the PR description as the commit message, so the body is
permanent history, not review chatter:

- **Keep the description accurate to the final state of the branch.** When
  review rounds change behavior or invalidate a design rationale, update the
  body — a stale explanation in the commit message is worse than none.
- **No hard line-wrapping in the body.** Write single-line paragraphs and let
  GitHub wrap; hard-wrapped markdown renders ragged in the squash commit.
- **No gates / verification / tests-run sections.** CI is the record of what
  ran. The description says what changed and why. Measurement tables,
  benchmark results, and design rationale are content and belong; test
  inventories are not.
- **End with a `Closes #NNN` line for every issue the PR resolves.**

# Release Announcements

Changesets opens the `Version Packages` release PR and generates the package
version plus `packages/typegraph/CHANGELOG.md`. For a substantial release, edit
the generated changelog entry on that release PR's branch before merging. Editing
the PR description alone does not update the packaged changelog or the GitHub
Release generated from it.

- Add `### Highlights` before the generated change groups. Use a few cohesive,
  user-facing paragraphs to explain the release's main capabilities and their
  practical effect. Synthesize related changes instead of repeating every
  changeset.
- Add `### Upgrade notes` when the release changes public types or behavior,
  requires a schema or data migration, introduces deployment ordering, changes
  retry or concurrency semantics, or requires custom backend work. Make each
  bullet an actionable instruction and name the affected API or runtime state.
- Leave the generated `### Minor Changes` and `### Patch Changes` entries intact.
  They remain the detailed source-attributed record beneath the editorial
  summary.
- Small additive releases and routine patch releases do not need editorial
  sections. Add them when a concise overview or migration guidance materially
  helps users.
- Keep the release PR description aligned with the final changelog entry under
  `# Releases` and `## @nicia-ai/typegraph@X.Y.Z`. Preserve the Changesets bot
  preamble. The description becomes the squash commit message, while the
  changelog content ships in the package and supplies the GitHub Release notes.
- When Changesets refreshes an open release PR after more changes land, review
  the Highlights and Upgrade notes again and restore them if regeneration
  removed them.
- After merging, verify that the GitHub Release matches the changelog. Correct
  drift on the GitHub Release page without rewriting historical release PRs. If
  the complete entry exceeds GitHub's body limit, keep Highlights and Upgrade
  notes in the release body and attach the complete changelog entry.

# Core Principles

- **TypeScript strict mode** with readonly types by default
- **Functional programming** over classes
- **Immutable data** patterns
- **Explicit error handling** with Result/Either patterns
- **Single responsibility** - one concern per file/function

# Type Safety

- MUST avoid `any` - use strict types
- SHOULD use `as const` for literal types
- SHOULD prefer type predicates over type assertions
- SHOULD use discriminated unions for state
- SHOULD use `satisfies` operator for type-safe object literals
- SHOULD use `NoInfer<T>` to prevent unwanted inference
- MUST export types from their defining modules
- MUST use `type` imports for type-only imports

# Code Style

## Formatting

- MUST use `function` keyword for pure functions (not arrow functions at top level)
- MUST use braces around switch case statements
- SHOULD avoid unnecessary braces in conditionals for simple statements
- MUST use descriptive names that reveal intent
- MUST use descriptive variable names (ex: `event`, not `e`)

## TypeScript Patterns

- SHOULD avoid `let` unless it adds substantial clarity
- MUST use nullish coalescing (`??`) over logical or (`||`) when appropriate
- MUST avoid `null` - always prefer `undefined`
- MUST use `Readonly<{...}>` type syntax over marking individual members readonly
- SHOULD avoid mutation unless absolutely necessary
- SHOULD use `structuredClone()` for deep copying
- SHOULD prefer spreading over `Object.assign`

## Array Operations

- MUST NOT pass function references directly to array methods

  ```typescript
  // ❌ Avoid - harder to debug, less explicit about arguments
  array.map(transform);

  // ✅ Prefer - explicit arguments, easier debugging, better type inference
  array.map((element) => transform(element));
  ```

  _Rationale: Enforced by eslint-plugin-unicorn. Improves readability, debugging (can add breakpoints/logging), and TypeScript type inference._

## Naming Conventions

- **PascalCase** - Types, interfaces, classes, React component files
- **camelCase** - Functions, variables, properties, non-component files
- **SCREAMING_SNAKE_CASE** - Constants
- **kebab-case** - Non-component filenames

## Allowed Abbreviations

The following abbreviations are permitted (eslint-plugin-unicorn allowlist):

`args`, `ctx`, `db`, `Db`, `def`, `Def`, `dir`, `Dir`, `env`, `Env`, `err`, `Err`, `Fn`, `fn`, `params`, `Param`, `Params`, `props`, `Props`, `ref`, `Ref`, `utils`, `e2e`

## Import Organization

Imports are auto-sorted by `eslint-plugin-simple-import-sort`. General order:

```typescript
// 1. External dependencies
import { sql } from "drizzle-orm";
import { type InferOutput, z } from "zod";

// 2. Internal modules (relative imports)
import { defineGraph, defineNode } from "../src";
import type { GraphBackend } from "../src/backend/types";
```

# Testing

## Frameworks

- **Vitest** - Primary test runner
- **fast-check** - Property-based testing for invariants

## Load-Bearing Tests

A test guarding a behavior ships with evidence it fails when that behavior
breaks: temporarily revert the fix (or mutate the guarded code), watch the
test fail, restore, watch it pass. A test that cannot fail is coverage
theater — it certifies nothing and reads as protection that is not there.
State the revert/mutation check in the PR body when the test is the point
of the change.

## Test Organization

- Unit tests: `tests/*.test.ts`
- Property tests: `tests/property/*.test.ts`
- Backend-specific: `tests/backends/{sqlite,postgres}/*.test.ts`

## Test Utilities

Use helpers from `tests/test-utils.ts`:

```typescript
import { createTestBackend, createTestDatabase } from "./test-utils";

// Creates in-memory SQLite backend (auto-closed after each test)
const backend = createTestBackend();

// Creates in-memory database with direct Drizzle access
const db = createTestDatabase();
```

## Test Structure

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { createTestBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

describe("Feature", () => {
  let backend: GraphBackend;

  beforeEach(() => {
    backend = createTestBackend();
  });

  it("describes expected behavior", async () => {
    // Arrange, Act, Assert
  });
});
```

## Coverage Thresholds

- Branches: 64%
- Functions: 74%
- Lines: 75%

# Contract Discipline

These rules are each distilled from a recurring class of real defects:

- **One predicate, one owner.** A comparison, classification, or validation
  decision consumed by more than one path must be a single exported function
  every path calls. A second inline implementation of an existing decision is
  a defect even while the copies agree — the copies WILL drift (raw-text vs
  canonical-instant window compares, guard clock vs write clock, probe vs
  engine verdicts all did). When you find yourself re-spelling a decision,
  extract the seam instead.
- **An accepted option is applied or refused — never ignored.** If a layer
  validates an option and then cannot honor it in some state, it refuses with
  a typed error naming that state; silently dropping a stated value is the
  API lying to its caller. Audit every option a change touches: each one is
  either threaded to the write that honors it or refused on the path that
  cannot.
- **A fused command is an optimization attempt, not evidence that its
  dimensions ran.** A command returning `unsupported` has executed no SQL and
  the Store must re-enter the complete portable validation/write path. Skip a
  portable predicate only after the command result proves that the command
  applied it. Every new command dimension ships with a custom-port refusal test
  that reaches the fallback and proves no partial row or sidecar write occurred.
- **Runtime evidence is bound to the resource that earned it.** A lock or
  isolation token must identify the graph and transaction session that owns the
  database guarantee; module provenance or a capability boolean is not enough.
  Transparent command-port wrappers inherit that session identity only through
  `deriveBackend`, and execution checks the actual transaction target before
  any decision-driving read.
- **A changed contract re-audits its consumers.** When a change alters what a
  shared function throws, returns, orders, or asserts, enumerate its callers
  and disposition each against the new semantics before merging — verifying
  the changed code against the one consumer you had in mind is not enough.
  Reordering sidecar writes after their gate was correct for store callers
  (a throw aborts the transaction) and turned import's catch-per-row into a
  partial commit; a guard that began returning "what I read" was consumed by
  the store paths while import kept asserting unconditionally. Both defects
  lived in callers the fix never touched. When the contract is a decision,
  prefer returning the decision itself (the predicate, the fence, the plan)
  over a flag a caller re-derives it from — a consumer that cannot spell its
  own version cannot drift.
- **Session facts come from the session that enforces them.** Transaction
  isolation, locks, and similar execution facts must be observed on the pinned
  database session and carried in the evidence minted by that observation.
  Never infer an effective fact from a requested option or a server default;
  configuration can rewrite either between environments. When an existing
  fence statement can return the fact, fold it into that statement rather than
  adding a probe round trip.
- **A backend is derived through `src/backend/derive-backend.ts`, never
  copied.** `deriveBackend` to decorate, `projectBackend` /
  `projectBackendWithout` / `projectGraphBackend` to narrow. A spread,
  `Object.assign` copy or rest-omission builds a NEW object that the
  serialized-resource audit does not follow, and the import/clone guards then
  let a read-and-write-through-one-connection stream proceed into a deadlock.
- **An identifier ending in `Backend` denotes a whole backend object; name a
  members fragment `*Members`.** The construction ratchet is a name selector, so
  this is not a style preference: calling a `Pick<TransactionBackend, …>`
  fragment `commonBackend` made the guardrail fire on a primitive construction,
  and calling a real backend `members` would make it silent on a real copy.

# Error Handling

- MUST throw errors at framework boundaries: server functions, loaders, error boundaries
- MUST use Result/Either for internal logic: services, database operations, utilities
- MUST convert Results to thrown errors at boundaries
- SHOULD use specific error types extending `TypeGraphError`
- SHOULD include cause chain for debugging
- MUST NOT use Result/Either in React components

```typescript
type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

// Internal service - returns Result
export function parseConfig(input: string): Result<Config, ValidationError> {
  try {
    const parsed = JSON.parse(input);
    return { success: true, data: parsed };
  } catch (error) {
    return { success: false, error: new ValidationError("Invalid JSON", { cause: error }) };
  }
}

// Use ok/err helpers from utils
import { err, isErr, ok, unwrap } from "./utils";

function divide(a: number, b: number): Result<number, Error> {
  if (b === 0) return err(new Error("Division by zero"));
  return ok(a / b);
}
```

# Architecture Patterns

## Backend Abstraction

The `GraphBackend` interface abstracts database operations:

```typescript
// SQLite (in-memory or file — requires better-sqlite3)
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite/local";
const { backend, db } = createLocalSqliteBackend();

// SQLite (bring your own Drizzle connection — no native deps)
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
const backend = createSqliteBackend(drizzleDb);

// PostgreSQL
import { createPostgresBackend } from "@nicia-ai/typegraph/adapters/drizzle/postgres";
const backend = createPostgresBackend(pool);
```

## Backend parity

A query written against one backend must behave identically on the other. We
get there by construction, not by hoping:

1. **The query compiler (`src/query`) is a single shared path.** The only
   sanctioned place for a dialect difference is a member of the `DialectAdapter`
   interface — a *token-level* seam (quote an identifier, pick a JSON function,
   emit a boolean literal). Because it is an `interface`, every dialect is forced
   by the type checker to provide an implementation, so a backend can never be
   silently skipped. An ESLint rule bans an inline `dialect === "sqlite"` / `case
   "postgres"` comparison across the whole library source (`src/**`), not only
   the query compiler; a file that genuinely cannot honor that — one-shot
   provisioning or migration, the pessimistic-lock fence's one owner, a
   resource-audit driver fact, dialect-specific error classification — is named
   file by file in `DIALECT_LITERAL_EXEMPTIONS` (`eslint.config.mjs`) with the
   reason, rather than exempted by directory. Never reintroduce a per-dialect
   *strategy function* that re-implements compilation for one backend — that
   parallel-path pattern is exactly what hid the set-operation gap.

2. **Query-feature tests live in the shared cross-backend suite**
   (`tests/backends/integration/*.ts`, registered via `createIntegrationTestSuite`
   and run against every backend). Per-dialect tests in `tests/backends/{sqlite,
   postgres}/**` are for backend-specific wiring only — never for query
   semantics. A per-dialect test will happily certify a divergence; only the
   same case run on both backends verifies equivalence.

3. **Genuine engine gaps are declared, not hidden.** When an engine truly cannot
   do something (e.g. `sqlite-vec` has no `inner_product` metric), surface it as
   a typed capability (`backend.capabilities`), document it in the parity matrix
   in `backend-setup.md`, and add a test asserting the *exact* error on the
   unsupported backend. No silent no-ops.

## Graph Definition

```typescript
import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { z } from "zod";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

const graph = defineGraph({
  id: "social",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});
```

## Store Operations

```typescript
const store = createStore(graph, backend);

// Collection API
const alice = await store.nodes.Person.create({ name: "Alice" });
const bob = await store.nodes.Person.create({ name: "Bob" });
await store.edges.knows.create(alice.id, bob.id, { since: "2024" });

// Query API
const results = await store.query(Person).where({ name: "Alice" }).execute();
```

# File Organization

- MUST group related files using barrel exports (`index.ts`)
- MUST prefer named exports over default exports
- MUST keep one concern per file
- SHOULD co-locate types with implementation
- SHOULD only use `src/types/` for truly shared types
- MUST place new modules in appropriate existing directories before creating new ones
