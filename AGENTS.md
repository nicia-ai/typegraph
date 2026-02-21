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
pnpm fix                  # Auto-fix lint and formatting

# From packages/typegraph
pnpm test                 # Run unit tests
pnpm test:unit            # Run unit tests only
pnpm test:property        # Run property-based tests
pnpm test:postgres        # Run PostgreSQL tests (starts Docker automatically)
pnpm test:coverage        # Run tests with coverage
pnpm test:mutation        # Run mutation testing
```

**Important:** `pnpm test` runs only SQLite-backed tests. The 214 PostgreSQL
backend tests are **skipped** unless `POSTGRES_URL` is set. Always run
`pnpm test:postgres` (from the repo root or `packages/typegraph`) to verify
changes that touch backend, store, or collection code. The script handles
Docker lifecycle automatically — no manual setup required.

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
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
const { backend, db } = createLocalSqliteBackend();

// SQLite (bring your own Drizzle connection — no native deps)
import { createSqliteBackend } from "@nicia-ai/typegraph/sqlite";
const backend = createSqliteBackend(drizzleDb);

// PostgreSQL
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";
const backend = createPostgresBackend(pool);
```

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
