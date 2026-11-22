---
title: Subqueries
description: EXISTS, IN, and correlated subqueries for complex filtering
---

Subqueries let you filter based on conditions that depend on related data—check if related records
exist, or if values appear in another query's results.

## EXISTS

Check if related records exist. A subquery that depends on the outer row is correlated with
`$exists()`, whose callback receives the outer query's fields:

```typescript
import { expr } from "@nicia-ai/typegraph";

// Find people who have authored at least one PR
const authors = await store
  .query()
  .from("Person", "p")
  .where((ctx) =>
    ctx.$exists((subquery, outer) =>
      subquery
        .from("PullRequest", "pr")
        .traverse("author", "e", { direction: "in" })
        .to("Person", "author")
        .whereNode("author", (_author, inner) =>
          expr.eq(inner.author.id, outer.p.id),
        )
        .project((inner) => ({ id: inner.pr.id })),
    ),
  )
  .select((ctx) => ctx.p)
  .execute();
```

A `whereNode()` or `whereEdge()` predicate reads only its own alias, so the outer row reaches
the subquery through `outer`, never through a field reference naming an outer alias. A predicate
that names another alias is refused with `UnsupportedPredicateError` before any SQL is sent.
To compare two aliases of the same query, use `where()`:

```typescript
// Pairs where the person known is older than the person who knows them
const olderFriends = await store
  .query()
  .from("Person", "a")
  .traverse("knows", "k")
  .to("Person", "b")
  .where(({ a, b }) => expr.gt(b.age, a.age))
  .select((ctx) => ({ person: ctx.a.name, friend: ctx.b.name }))
  .execute();
```

A subquery with a recursive traversal and more than one hop compiles each fixed (non-recursive)
hop, and the start of an optional first recursive hop, as a separate statement that cannot see
the outer row, so a `whereNode()` or `whereEdge()` predicate on one of those aliases that reads
`outer` is refused with `UnsupportedPredicateError` (`details.targetAlias`). The same predicate on
a recursive hop's alias is evaluated; otherwise correlate in the subquery's `where()`, which can
read `outer`.

## NOT EXISTS

Find records without related records:

```typescript
import { expr } from "@nicia-ai/typegraph";

// Find people with no pull requests
const nonContributors = await store
  .query()
  .from("Person", "p")
  .where((ctx) =>
    expr.not(
      ctx.$exists((subquery, outer) =>
        subquery
          .from("PullRequest", "pr")
          .traverse("author", "e", { direction: "in" })
          .to("Person", "author")
          .whereNode("author", (_author, inner) =>
            expr.eq(inner.author.id, outer.p.id),
          )
          .project((inner) => ({ id: inner.pr.id })),
      ),
    ),
  )
  .select((ctx) => ctx.p)
  .execute();
```

`exists()` and `notExists()` take an uncorrelated subquery: it is evaluated once, independent of
the outer row.

## IN

Check if a value is in a subquery result set:

```typescript
import { inSubquery } from "@nicia-ai/typegraph";
import { fieldRef } from "@nicia-ai/typegraph/query";

// Find people who work at tech companies
const techWorkers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", () =>
    inSubquery(
      fieldRef("p", ["companyId"]),
      store
        .query()
        .from("Company", "c")
        .whereNode("c", (c) => c.industry.eq("Technology"))
        .aggregate({
          id: fieldRef("c", ["id"], { valueType: "string" }),
        })
        .toAst()
    )
  )
  .select((ctx) => ctx.p)
  .execute();
```

## NOT IN

Exclude values that appear in a subquery:

```typescript
import { notInSubquery } from "@nicia-ai/typegraph";
import { fieldRef } from "@nicia-ai/typegraph/query";

// Find people not in the blocklist
const allowedUsers = await store
  .query()
  .from("Person", "p")
  .whereNode("p", () =>
    notInSubquery(
      fieldRef("p", ["id"]),
      store
        .query()
        .from("BlockedUser", "b")
        .aggregate({
          userId: fieldRef("b", ["props", "userId"], { valueType: "string" }),
        })
        .toAst()
    )
  )
  .select((ctx) => ctx.p)
  .execute();
```

## fieldRef()

The `fieldRef()` function creates a reference to a field of a query alias: the outer field an
`inSubquery()` or `notInSubquery()` tests, or the column an `aggregate()` subquery projects:

```typescript
import { fieldRef } from "@nicia-ai/typegraph/query";

fieldRef("alias", ["field"])      // Reference a single field
fieldRef("alias", ["nested", "path"])  // Reference a nested field
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `alias` | `string` | The alias of the node/edge the field belongs to |
| `path` | `string[]` | Path to the field (array for nested access) |

## Helpers Reference

| Function | Description |
|----------|-------------|
| `exists(subqueryAst)` | True if the uncorrelated subquery returns any rows |
| `notExists(subqueryAst)` | True if the uncorrelated subquery returns no rows |
| `ctx.$exists((subquery, outer) => …)` | Correlated EXISTS; see [Expressions](/queries/expressions#scope-safety) |
| `inSubquery(fieldRef, subqueryAst)` | True if field value is in subquery results |
| `notInSubquery(fieldRef, subqueryAst)` | True if field value is not in subquery results |

For `inSubquery()` and `notInSubquery()`, the subquery must project exactly one
scalar column. Prefer `aggregate({ ... })` with a single field.

## Real-World Examples

### Users with Recent Activity

```typescript
// Find users who logged in within the last 7 days
const activeUsers = await store
  .query()
  .from("User", "u")
  .where((ctx) =>
    ctx.$exists((subquery, outer) =>
      subquery
        .from("LoginEvent", "e")
        .whereNode("e", (_event, inner) =>
          expr.and(
            expr.eq(inner.e.userId, outer.u.id),
            expr.gte(inner.e.timestamp, expr.literal(sevenDaysAgo)),
          ),
        )
        .project((inner) => ({ id: inner.e.id })),
    ),
  )
  .select((ctx) => ctx.u)
  .execute();
```

### Products Not in Any Cart

```typescript
// Find products that haven't been added to any cart
const unpopularProducts = await store
  .query()
  .from("Product", "p")
  .where((ctx) =>
    expr.not(
      ctx.$exists((subquery, outer) =>
        subquery
          .from("CartItem", "ci")
          .whereNode("ci", (_item, inner) =>
            expr.eq(inner.ci.productId, outer.p.id),
          )
          .project((inner) => ({ id: inner.ci.id })),
      ),
    ),
  )
  .select((ctx) => ctx.p)
  .execute();
```

### Users in Specific Teams

```typescript
// Find users who are members of either the engineering or design team
const targetTeamIds = ["team-eng", "team-design"];

const teamMembers = await store
  .query()
  .from("User", "u")
  .whereNode("u", () =>
    inSubquery(
      fieldRef("u", ["id"]),
      store
        .query()
        .from("TeamMembership", "tm")
        .whereNode("tm", (tm) => tm.teamId.in(targetTeamIds))
        .aggregate({
          userId: fieldRef("tm", ["props", "userId"], {
            valueType: "string",
          }),
        })
        .toAst()
    )
  )
  .select((ctx) => ctx.u)
  .execute();
```

## Query Debugging

For debugging or advanced use cases, you can inspect the query AST or generated SQL.

### View the AST

```typescript
const query = store
  .query()
  .from("Person", "p")
  .whereNode("p", (p) => p.status.eq("active"))
  .select((ctx) => ctx.p);

const ast = query.toAst();
console.log(JSON.stringify(ast, null, 2));
```

### View Generated SQL

`toSQL()` returns the SQL text and bound parameters for the current backend dialect:

```typescript
const { sql, params } = query.toSQL();
console.log("SQL:", sql);
console.log("Parameters:", params);
```

This is useful for:

- Debugging query behavior
- Understanding performance characteristics
- Logging queries in production
- Running the query with a custom executor

## Next Steps

- [Filter](/queries/filter) - Basic filtering with predicates
- [Combine](/queries/combine) - Set operations
- [Execute](/queries/execute) - Running queries
