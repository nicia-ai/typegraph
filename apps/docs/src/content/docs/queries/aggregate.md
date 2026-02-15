---
title: Aggregate
description: GROUP BY, aggregate functions, and HAVING clauses
---

TypeGraph supports SQL-style aggregations for analytics and reporting. Group nodes by properties,
compute aggregates like COUNT and SUM, and filter groups with HAVING clauses.

## When to Use Aggregations

Aggregations are useful for:

- **Analytics dashboards**: Employee counts by department, revenue by region
- **Reporting**: Average order value, total sales by product category
- **Data exploration**: Find groups meeting certain criteria
- **Metrics**: Count active users, sum transaction amounts

## Basic Aggregation

Use `groupBy()` and `aggregate()` with aggregate helper functions:

```typescript
import { count, field } from "@nicia-ai/typegraph";

const companySizes = await store
  .query()
  .from("Person", "p")
  .traverse("worksAt", "e")
  .to("Company", "c")
  .groupBy("c", "name")                    // Group by company name
  .aggregate({
    companyName: field("c", "name"),       // Include the grouped field
    employeeCount: count("p"),             // Count people in each group
  })
  .execute();

// Result: [{ companyName: "Acme Corp", employeeCount: 42 }, ...]
```

## Aggregate Functions

Import aggregate functions from `@nicia-ai/typegraph`:

```typescript
import { count, countDistinct, sum, avg, min, max, field } from "@nicia-ai/typegraph";
```

### count

Count rows in each group:

```typescript
count("p")              // COUNT(p.id) - count all nodes
count("p", "department") // COUNT(p.props.department) - count non-null values
```

### countDistinct

Count unique values:

```typescript
countDistinct("p")              // COUNT(DISTINCT p.id)
countDistinct("p", "department") // COUNT(DISTINCT p.props.department)
```

### sum

Sum numeric values:

```typescript
sum("p", "salary")      // SUM(p.props.salary)
```

### avg

Average of numeric values:

```typescript
avg("p", "age")         // AVG(p.props.age)
```

### min / max

Minimum and maximum values:

```typescript
min("p", "hireDate")    // MIN(p.props.hireDate)
max("p", "salary")      // MAX(p.props.salary)
```

### field

Include a grouped field in the output:

```typescript
field("p", "department") // The grouped field value
field("c", "id")         // Node ID
field("c", "name")       // Property value
```

## Multiple Aggregations

Combine multiple aggregates in one query:

```typescript
import { count, countDistinct, sum, avg, min, max, field } from "@nicia-ai/typegraph";

const departmentStats = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .aggregate({
    department: field("e", "department"),
    headcount: count("e"),
    uniqueRoles: countDistinct("e", "role"),
    avgSalary: avg("e", "salary"),
    minSalary: min("e", "salary"),
    maxSalary: max("e", "salary"),
    totalPayroll: sum("e", "salary"),
  })
  .execute();
```

## Grouping by Multiple Fields

Chain `groupBy()` calls for multi-column grouping:

```typescript
const breakdown = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .groupBy("e", "level")
  .aggregate({
    department: field("e", "department"),
    level: field("e", "level"),
    count: count("e"),
    avgSalary: avg("e", "salary"),
  })
  .execute();

// Result: [
//   { department: "Engineering", level: "Senior", count: 15, avgSalary: 150000 },
//   { department: "Engineering", level: "Junior", count: 8, avgSalary: 80000 },
//   { department: "Sales", level: "Senior", count: 5, avgSalary: 120000 },
//   ...
// ]
```

## Grouping by Node

Use `groupByNode()` to group by unique nodes (by ID):

```typescript
const projectContributions = await store
  .query()
  .from("Commit", "c")
  .traverse("author", "e")
  .to("Developer", "d")
  .groupByNode("d")                        // Group by developer node
  .aggregate({
    developerId: field("d", "id"),
    developerName: field("d", "name"),
    commitCount: count("c"),
  })
  .execute();
```

## Filtering Groups with HAVING

Use `having()` to filter groups based on aggregate values (SQL's HAVING clause):

```typescript
import { count, havingGt } from "@nicia-ai/typegraph";

// Only departments with more than 5 employees
const largeDepartments = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .having(havingGt(count("e"), 5))         // HAVING COUNT(e) > 5
  .aggregate({
    department: field("e", "department"),
    headcount: count("e"),
  })
  .execute();
```

### Available HAVING Helpers

```typescript
import {
  having,
  havingGt,
  havingGte,
  havingLt,
  havingLte,
  havingEq,
} from "@nicia-ai/typegraph";

// Comparison helpers
havingGt(aggregate, value)   // >
havingGte(aggregate, value)  // >=
havingLt(aggregate, value)   // <
havingLte(aggregate, value)  // <=
havingEq(aggregate, value)   // =

// Generic comparison (for custom operators)
having(aggregate, "gt", value)
```

### Multiple HAVING Conditions

Chain multiple having conditions:

```typescript
const qualifiedDepartments = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .having(havingGte(count("e"), 5))        // At least 5 employees
  .having(havingGte(avg("e", "salary"), 100000)) // Average salary >= 100k
  .aggregate({
    department: field("e", "department"),
    headcount: count("e"),
    avgSalary: avg("e", "salary"),
  })
  .execute();
```

## Aggregations with Traversals

Combine graph traversals with aggregations:

```typescript
const topContributors = await store
  .query()
  .from("PullRequest", "pr")
  .whereNode("pr", (pr) => pr.state.eq("merged"))
  .traverse("targetsRepo", "e1")
  .to("Repository", "repo")
  .traverse("author", "e2", { direction: "in" })
  .to("Developer", "dev")
  .groupBy("repo", "name")
  .groupBy("dev", "name")
  .aggregate({
    repository: field("repo", "name"),
    developer: field("dev", "name"),
    prCount: count("pr"),
    linesChanged: sum("pr", "linesAdded"),
  })
  .limit(50)
  .execute();
```

## Ordering Aggregated Results

Order by aggregate values:

```typescript
const topDepartments = await store
  .query()
  .from("Employee", "e")
  .groupBy("e", "department")
  .aggregate({
    department: field("e", "department"),
    headcount: count("e"),
    totalSalary: sum("e", "salary"),
  })
  .orderBy((ctx) => ctx.totalSalary, "desc")
  .limit(10)
  .execute();
```

## Real-World Example: Team Analytics

```typescript
import { count, countDistinct, sum, avg, field, havingGt } from "@nicia-ai/typegraph";

// 1. Productivity by department
const departmentMetrics = await store
  .query()
  .from("Developer", "dev")
  .traverse("authored", "e")
  .to("PullRequest", "pr")
  .whereNode("pr", (pr) => pr.state.eq("merged"))
  .groupBy("dev", "department")
  .aggregate({
    department: field("dev", "department"),
    developerCount: countDistinct("dev"),
    totalPRs: count("pr"),
    totalLinesAdded: sum("pr", "linesAdded"),
    avgLinesPerPR: avg("pr", "linesAdded"),
  })
  .execute();

// 2. Active reviewers (reviewed > 10 PRs)
const activeReviewers = await store
  .query()
  .from("Developer", "d")
  .traverse("reviewed", "r")
  .to("PullRequest", "pr")
  .groupByNode("d")
  .having(havingGt(count("pr"), 10))
  .aggregate({
    developer: field("d", "name"),
    reviewCount: count("pr"),
  })
  .orderBy((ctx) => ctx.reviewCount, "desc")
  .execute();

// 3. Repository health
const repoHealth = await store
  .query()
  .from("Repository", "r")
  .traverse("contains", "e")
  .to("PullRequest", "pr")
  .groupByNode("r")
  .aggregate({
    repo: field("r", "name"),
    openPRs: count("pr"),
    avgAge: avg("pr", "daysOpen"),
  })
  .execute();
```

## Next Steps

- [Shape](/queries/shape) - Output transformation with `select()`
- [Order](/queries/order) - Ordering and limiting results
- [Traverse](/queries/traverse) - Graph traversals
