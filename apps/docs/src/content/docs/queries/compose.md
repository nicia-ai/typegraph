---
title: Compose
description: Reusable query transformations with pipe() and fragment composition
---

Compose operations let you create reusable query transformations. Use `pipe()` to apply
transformations and `createFragment()` to build typed, composable query parts.

## The pipe() Method

Apply a transformation function to a query builder:

```typescript
const results = await store
  .query()
  .from("User", "u")
  .pipe((q) => q.whereNode("u", ({ status }) => status.eq("active")))
  .pipe((q) => q.orderBy("u", "createdAt", "desc"))
  .select((ctx) => ctx.u)
  .execute();
```

Each `pipe()` receives the current builder and returns a modified builder, enabling chained transformations.

## Defining Reusable Fragments

Extract common patterns into reusable functions:

```typescript
// Define reusable fragments
const activeOnly = (q) =>
  q.whereNode("u", ({ status }) => status.eq("active"));

const recentFirst = (q) =>
  q.orderBy("u", "createdAt", "desc");

const first10 = (q) =>
  q.limit(10);

// Use in queries
const results = await store
  .query()
  .from("User", "u")
  .pipe(activeOnly)
  .pipe(recentFirst)
  .pipe(first10)
  .select((ctx) => ctx.u)
  .execute();
```

## Typed Fragments with createFragment()

For full type safety, use the `createFragment()` factory:

```typescript
import { createFragment } from "@nicia-ai/typegraph";

// Create a typed fragment factory for your graph
const fragment = createFragment<typeof graph>();

// Define typed fragments
const activeUsers = fragment((q) =>
  q.whereNode("u", ({ status }) => status.eq("active"))
);

const withRecentPosts = fragment((q) =>
  q.traverse("authored", "a")
   .to("Post", "p")
   .whereNode("p", ({ createdAt }) => createdAt.gte("2024-01-01"))
);

// Compose into queries
const results = await store
  .query()
  .from("User", "u")
  .pipe(activeUsers)
  .pipe(withRecentPosts)
  .select((ctx) => ({
    user: ctx.u,
    post: ctx.p,
  }))
  .execute();
```

## Composing Fragments

Use `composeFragments()` to combine multiple fragments into one:

```typescript
import { composeFragments, limitFragment, orderByFragment } from "@nicia-ai/typegraph";

// Compose multiple fragments into one
const paginatedActiveUsers = composeFragments(
  (q) => q.whereNode("u", ({ status }) => status.eq("active")),
  (q) => q.orderBy("u", "createdAt", "desc"),
  (q) => q.limit(20)
);

// Apply as a single transformation
const results = await store
  .query()
  .from("User", "u")
  .pipe(paginatedActiveUsers)
  .select((ctx) => ctx.u)
  .execute();
```

## Helper Fragments

TypeGraph provides pre-built helper fragments:

```typescript
import {
  limitFragment,
  offsetFragment,
  orderByFragment,
  composeFragments
} from "@nicia-ai/typegraph";

// Pre-built fragments
const paginated = composeFragments(
  orderByFragment("u", "createdAt", "desc"),
  limitFragment(20),
  offsetFragment(40)
);

const results = await store
  .query()
  .from("User", "u")
  .pipe(paginated)
  .select((ctx) => ctx.u)
  .execute();
```

### Available Helpers

| Helper | Description |
|--------|-------------|
| `limitFragment(n)` | Limits results to n rows |
| `offsetFragment(n)` | Skips the first n rows |
| `orderByFragment(alias, field, direction)` | Orders by a field |

## Fragments with Traversals

Fragments can include traversals:

```typescript
// Fragment that adds a manager traversal
const withManager = fragment((q) =>
  q.traverse("reportsTo", "r").to("User", "manager")
);

// Fragment that adds department info
const withDepartment = fragment((q) =>
  q.traverse("belongsTo", "b").to("Department", "dept")
);

// Compose for a complete employee view
const employeeDetails = composeFragments(withManager, withDepartment);

const results = await store
  .query()
  .from("User", "u")
  .pipe(employeeDetails)
  .select((ctx) => ({
    employee: ctx.u,
    manager: ctx.manager,
    department: ctx.dept,
  }))
  .execute();
```

## Post-Select Fragments

`pipe()` is also available on `ExecutableQuery`:

```typescript
// Define a pagination fragment for executable queries
const paginate = (q) =>
  q.orderBy("u", "name", "asc").limit(10).offset(20);

const results = await store
  .query()
  .from("User", "u")
  .select((ctx) => ({ name: ctx.u.name, email: ctx.u.email }))
  .pipe(paginate)
  .execute();
```

## Real-World Patterns

### Search with Conditional Filters

```typescript
function searchUsers(filters: {
  status?: string;
  role?: string;
  search?: string;
}) {
  let query = store.query().from("User", "u");

  // Apply filters conditionally using pipe
  if (filters.status) {
    query = query.pipe((q) =>
      q.whereNode("u", ({ status }) => status.eq(filters.status))
    );
  }

  if (filters.role) {
    query = query.pipe((q) =>
      q.whereNode("u", ({ role }) => role.eq(filters.role))
    );
  }

  if (filters.search) {
    query = query.pipe((q) =>
      q.whereNode("u", ({ name }) => name.ilike(`%${filters.search}%`))
    );
  }

  return query.select((ctx) => ctx.u).execute();
}
```

### Configurable Pagination

```typescript
function createPaginationFragment(options: {
  sortField: string;
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
}) {
  return composeFragments(
    orderByFragment("u", options.sortField, options.sortDir),
    limitFragment(options.pageSize),
    offsetFragment((options.page - 1) * options.pageSize)
  );
}

// Use with any query
const pagination = createPaginationFragment({
  sortField: "createdAt",
  sortDir: "desc",
  page: 2,
  pageSize: 25,
});

const results = await store
  .query()
  .from("User", "u")
  .pipe(pagination)
  .select((ctx) => ctx.u)
  .execute();
```

### Domain-Specific Query Helpers

```typescript
// Create domain-specific query helpers
const userQueries = {
  active: (q) => q.whereNode("u", ({ status }) => status.eq("active")),

  verified: (q) => q.whereNode("u", ({ emailVerified }) => emailVerified.eq(true)),

  withRole: (role: string) => (q) =>
    q.whereNode("u", ({ role: r }) => r.eq(role)),

  withPosts: (q) => q.traverse("authored", "a").to("Post", "p"),

  recentlyActive: (q) => q.whereNode("u", ({ lastLogin }) =>
    lastLogin.gte(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
  ),
};

// Compose for specific use cases
const activeAdmins = await store
  .query()
  .from("User", "u")
  .pipe(userQueries.active)
  .pipe(userQueries.verified)
  .pipe(userQueries.withRole("admin"))
  .select((ctx) => ctx.u)
  .execute();
```

## Type Definitions

For advanced use cases, TypeGraph exports fragment type definitions:

```typescript
import type {
  QueryFragment,
  FlexibleQueryFragment,
  TraversalFragment
} from "@nicia-ai/typegraph";
```

- **`QueryFragment<G, InAliases, OutAliases, InEdgeAliases, OutEdgeAliases>`** - A typed fragment transformation
- **`FlexibleQueryFragment<G, RequiredAliases, AddedAliases, ...>`** - A fragment that works with any compatible builder
- **`TraversalFragment<G, EK, EA, ...>`** - A fragment for transforming TraversalBuilder instances

## Next Steps

- [Filter](/queries/filter) - Filtering with predicates
- [Traverse](/queries/traverse) - Graph traversals
- [Combine](/queries/combine) - Set operations
