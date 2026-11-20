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
  .pipe((q) => q.orderBy("u", "meta.createdAt", "desc"))
  .select((ctx) => ctx.u)
  .execute();
```

Each `pipe()` receives the current builder and returns a modified builder, enabling chained transformations.
An inline function like these is typed by the query it extends, so `q` knows the alias `u` and its kind.

## Reusable Fragments with createFragment()

A function written away from its query has nothing to type `q` by. `createFragment()` fixes that: a
fragment **declares the node aliases it requires**, by kind, and its body is typed against exactly
those. The fragment then applies to any query that has those aliases, and keeps everything else that
query carries.

```typescript
import { z } from "zod";
import { defineEdge, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { createFragment } from "@nicia-ai/typegraph/query";
import { createLocalSqliteStore } from "@nicia-ai/typegraph/sqlite/local";

const User = defineNode("User", {
  schema: z.object({ name: z.string(), status: z.enum(["active", "inactive"]) }),
});
const Post = defineNode("Post", {
  schema: z.object({ title: z.string(), publishedAt: z.string() }),
});
const authored = defineEdge("authored", {
  schema: z.object({ role: z.enum(["author", "editor"]) }),
});

const graph = defineGraph({
  id: "blog",
  nodes: { User: { type: User }, Post: { type: Post } },
  edges: { authored: { type: authored, from: [User], to: [Post] } },
});

const store = await createLocalSqliteStore(graph);

// Create the fragment factory for your graph once
const fragment = createFragment<typeof graph>();

// Requires a User alias `u`, and filters it
const activeUsers = fragment({ u: "User" }, (q) =>
  q.whereNode("u", ({ status }) => status.eq("active")),
);

// Requires a User alias `u`, and adds the edge alias `a` and the Post alias `p`
const recentPosts = fragment({ u: "User" }, (q) =>
  q
    .traverse("authored", "a", { from: "u" })
    .to("Post", "p")
    .whereNode("p", ({ publishedAt }) => publishedAt.gte("2024-01-01")),
);

const results = await store
  .query()
  .from("User", "u")
  .pipe(activeUsers)
  .pipe(recentPosts)
  .select((ctx) => ({
    user: ctx.u.name,
    post: ctx.p.title,
    role: ctx.a.role,
  }))
  .execute();
```

Inside the body, `u` is typed exactly as `from("User", "u")` types it: `status` is the `User`
property, and a property `User` does not declare is a compile error. After the pipe, `ctx.u` keeps the
type the query gave it, and the aliases the fragment added (`p`, `a`) are typed as well.

A fragment that requires no alias takes only its body:

```typescript
const firstPage = fragment((q) => q.limit(20));
```

### What a Fragment Can Require

The declaration maps each alias to one node kind: `{ u: "User" }`. A query satisfies it when its `u`
alias is a node alias that binds only that kind:

| Host alias | Satisfies `{ u: "User" }` |
|------------|---------------------------|
| `from("User", "u")`, under the default expansion, `"exact"` or `"subclasses"` | Yes |
| `traverse(...).to("User", "u")`, `optionalTraverse(...).to("User", "u")` | Yes |
| `from("Post", "u")` | No: another kind |
| `from(["User", "Post"], "u")` | No: the alias can bind a `Post` |
| `from("User", "u", { expansion: "narrower" })`, `fromDynamic(...)` | No: the alias is untyped |
| No `u` alias, or `u` names an edge | No |

An unsatisfied requirement is a compile error at the `pipe()` call, with a message naming the alias
and the kind, for example `Error: fragment requires alias 'u' to be a 'User' node`. A caller the
compile-time check cannot reach (untyped code, a cast) is refused at runtime instead, with a
`ConfigurationError` whose `details.code` is `QUERY_FRAGMENT_REQUIREMENT_UNMET`. The runtime check
admits a subclass: a host `u` bound to an `Admin` that is a `subClassOf` `User` runs, though the
compile-time check, which does not follow the ontology, refuses `from("Admin", "u")`.

A fragment is written for the graph its factory names. Piping it into a query over another graph is a
compile error, `Error: fragment is written for another graph`, because its body is typed against that
graph's schemas: a filter on a property the other graph's kind lacks would read a property no row has.
A query over a graph that extends the fragment's graph takes it, and a fragment for any graph
(`createFragment<GraphDef>()`, or a helper called without a graph type argument) applies to every
graph. This check is compile-time only: at runtime a fragment does not record its graph.

What a declaration does not express:

- **Edge aliases.** A fragment cannot require an edge alias of the host query. Include the traversal
  in the fragment instead, so the fragment owns its edge alias.
- **Optionality.** A required alias may be optional in the host (an `optionalTraverse` target); the
  body only filters, traverses and orders, which an optional alias supports, and the alias keeps its
  optional type after the pipe.
- **A choice of kinds.** A requirement names one kind; a host alias over a list of kinds does not
  satisfy it. A requirement typed as a union of kinds, `{ u: kind }` with `kind` typed
  `"User" | "Post"`, is a compile error at the declaration: the value captured at runtime is one of
  the kinds, so no check against the union could keep the two in step.

### Traversals Start Where You Say

A traversal in a fragment without a `from` option starts at the query's current node, the last
traversal target, which the fragment cannot know. Pass `from` to start it at a required alias, as
`recentPosts` does above.

### Alias Collisions

A fragment cannot add an alias it declared: `fragment({ u: "User" }, (q) => q.traverse(...).to("User", "u"))`
is a compile error in the body. Whether the host query already uses an alias the fragment adds cannot
be known when the fragment is defined, so it is a compile error at `pipe()`:

```typescript
store
  .query()
  .from("User", "u")
  .traverse("authored", "a")
  .to("Post", "p")
  .pipe(recentPosts);
// Error: fragment adds alias 'a', which this query already uses
// Error: fragment adds alias 'p', which this query already uses
```

Node, edge and recursive aliases share one namespace, so a fragment's edge alias collides with a host
node alias of the same name too. The fragment never shadows a host alias: at runtime the same query
is refused with a `ValidationError`.

## Composing Fragments

Use `composeFragments()` to combine fragments into one, applied left to right:

```typescript
import { composeFragments } from "@nicia-ai/typegraph/query";

const publishedOnly = fragment({ p: "Post" }, (q) =>
  q.whereNode("p", ({ publishedAt }) => publishedAt.lte("2025-01-01")),
);

// `publishedOnly` requires `p`, which `recentPosts` adds
const activeAuthorsWithPosts = composeFragments(activeUsers, recentPosts, publishedOnly);

const results = await store
  .query()
  .from("User", "u")
  .pipe(activeAuthorsWithPosts)
  .select((ctx) => ({ user: ctx.u.name, post: ctx.p.title }))
  .execute();
```

`composeFragments()` takes any number of fragments. The composed fragment requires what the first
fragment requires, plus each alias a later fragment requires that no earlier fragment holds, and it is
written for the narrowest of its fragments' graphs, so a helper for any graph composes with a fragment
for one graph in either order. It is a compile error at the `composeFragments()` call when:

- a later fragment requires an alias an earlier one holds as a node of another kind, or as an edge or
  recursive alias;
- a later fragment adds an alias an earlier one already holds;
- two fragments are written for graphs neither of which extends the other;
- an argument is a union of fragments, such as `flag ? activeUsers : publishedOnly`. A union keeps only
  what every branch shares, so it would drop the requirements of whichever branch runs; compose or pipe
  each branch on its own instead.

## Helper Fragments

TypeGraph provides pre-built helper fragments:

```typescript
import {
  limitFragment,
  offsetFragment,
  orderByFragment,
  composeFragments,
} from "@nicia-ai/typegraph/query";

// Pre-built fragments
const paginated = composeFragments(
  orderByFragment("u", "meta.createdAt", "desc"),
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
| `orderByFragment(alias, field, direction)` | Orders by a field. It declares no requirement: `alias` may name a node or an edge, and `field` is typed against every node and edge kind of the graph; the alias and field are checked when the fragment is applied |

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
import type { GraphOrderField } from "@nicia-ai/typegraph/query";

function createPaginationFragment(options: {
  sortField: GraphOrderField<typeof graph>;
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
  sortField: "meta.createdAt",
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
const fragment = createFragment<typeof graph>();

// Create domain-specific query helpers
const userQueries = {
  active: fragment({ u: "User" }, (q) =>
    q.whereNode("u", ({ status }) => status.eq("active")),
  ),

  verified: fragment({ u: "User" }, (q) =>
    q.whereNode("u", ({ emailVerified }) => emailVerified.eq(true)),
  ),

  withRole: (role: string) =>
    fragment({ u: "User" }, (q) =>
      q.whereNode("u", ({ role: userRole }) => userRole.eq(role)),
    ),

  withPosts: fragment({ u: "User" }, (q) =>
    q.traverse("authored", "a", { from: "u" }).to("Post", "p"),
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
  FragmentRequiredAliases,
  FragmentRequirements,
  QueryFragment,
  QueryFragmentBody,
  QueryFragmentFactory,
  TraversalFragment,
} from "@nicia-ai/typegraph/query";
```

- **`QueryFragment<G, Requires, Added, AddedEdges, AddedRecursive>`** - A fragment built by
  `createFragment()`: what it requires (`{ u: "User" }`) and the node, edge and recursive aliases it adds.
  Annotate a fragment as `QueryFragment<typeof graph, { u: "User" }>` to state that it requires `u` and
  adds nothing. The annotation must state the fragment's shape exactly: one that drops a requirement,
  widens a kind or names another graph is a compile error
- **`FragmentRequirements<G>`** - The shape of a declaration: alias name to node kind name
- **`FragmentRequiredAliases<G, Requires>`** - The alias map a fragment body is typed against: each
  required alias as `from(kind, alias)` types it
- **`QueryFragmentBody<G, Requires, ...>`** - The function a fragment is written as, typed against the
  declared aliases only
- **`QueryFragmentFactory<G>`** - The `fragment` function `createFragment<G>()` returns
- **`TraversalFragment<G, EK, EA, ...>`** - A function type for transforming `TraversalBuilder` instances

## Next Steps

- [Filter](/queries/filter) - Filtering with predicates
- [Traverse](/queries/traverse) - Graph traversals
- [Combine](/queries/combine) - Set operations
