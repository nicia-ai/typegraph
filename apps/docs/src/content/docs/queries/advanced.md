---
title: Subqueries
description: EXISTS, IN, and correlated subqueries for complex filtering
---

Subqueries let you filter based on conditions that depend on related data—check if related records
exist, or if values appear in another query's results.

## EXISTS

Check if related records exist:

```typescript
import { exists, fieldRef } from "@nicia-ai/typegraph";

// Find people who have authored at least one PR
const authors = await store
  .query()
  .from("Person", "p")
  .whereNode("p", () =>
    exists(
      store
        .query()
        .from("PullRequest", "pr")
        .traverse("author", "e", { direction: "in" })
        .to("Person", "author")
        .whereNode("author", (a) => a.id.eq(fieldRef("p", ["id"])))
        .select((ctx) => ({ id: ctx.pr.id }))
        .toAst()
    )
  )
  .select((ctx) => ctx.p)
  .execute();
```

## NOT EXISTS

Find records without related records:

```typescript
import { notExists, fieldRef } from "@nicia-ai/typegraph";

// Find people with no pull requests
const nonContributors = await store
  .query()
  .from("Person", "p")
  .whereNode("p", () =>
    notExists(
      store
        .query()
        .from("PullRequest", "pr")
        .traverse("author", "e", { direction: "in" })
        .to("Person", "author")
        .whereNode("author", (a) => a.id.eq(fieldRef("p", ["id"])))
        .select((ctx) => ({ id: ctx.pr.id }))
        .toAst()
    )
  )
  .select((ctx) => ctx.p)
  .execute();
```

## IN

Check if a value is in a subquery result set:

```typescript
import { inSubquery, fieldRef } from "@nicia-ai/typegraph";

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
import { notInSubquery, fieldRef } from "@nicia-ai/typegraph";

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

The `fieldRef()` function creates a reference to a field in the outer query for use in subquery predicates:

```typescript
import { fieldRef } from "@nicia-ai/typegraph";

fieldRef("alias", ["field"])      // Reference a single field
fieldRef("alias", ["nested", "path"])  // Reference a nested field
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `alias` | `string` | The alias of the node/edge in the outer query |
| `path` | `string[]` | Path to the field (array for nested access) |

## Helpers Reference

| Function | Description |
|----------|-------------|
| `exists(subqueryAst)` | True if subquery returns any rows |
| `notExists(subqueryAst)` | True if subquery returns no rows |
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
  .whereNode("u", () =>
    exists(
      store
        .query()
        .from("LoginEvent", "e")
        .whereNode("e", (e) =>
          e.userId.eq(fieldRef("u", ["id"]))
           .and(e.timestamp.gte(sevenDaysAgo))
        )
        .select((ctx) => ({ id: ctx.e.id }))
        .toAst()
    )
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
  .whereNode("p", () =>
    notExists(
      store
        .query()
        .from("CartItem", "ci")
        .whereNode("ci", (ci) => ci.productId.eq(fieldRef("p", ["id"])))
        .select((ctx) => ({ id: ctx.ci.id }))
        .toAst()
    )
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
