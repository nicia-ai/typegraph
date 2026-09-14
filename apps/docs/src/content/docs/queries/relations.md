---
title: Composing Relations
description: Combine, filter, aggregate, and batch explicit SQL results
---

Call `asRelation()` on a database projection to work with its output columns. A relation supports
SQL filtering, projection, aggregation, ordering, deduplication, and set operations. Its callbacks
see the projected columns, with their original value types and SQL nullability.

```typescript
import { expr } from "@nicia-ai/typegraph";

const names = store.query().from("Person", "person")
  .project((fields) => ({ name: fields.person.name }))
  .asRelation();

const uniqueNames = await names.distinct()
  .orderBy((columns) => columns.name)
  .execute();
```

Before `asRelation()`, projection ordering uses the graph alias context. After it, ordering and
filtering use the output-column context. Graph traversal requires a graph-node binding; a projected
object does not automatically become one.

## Set operations over visible columns

`union()`, `unionAll()`, `intersect()`, and `except()` combine explicit SQL projections. Operands
must have the same ordered column names, value types, and nullability, and compatible graph,
execution-target, and temporal provenance. Create projections in the same field order.

```typescript
const employees = store.query().from("Employee", "employee")
  .project((fields) => ({ name: fields.employee.name })).asRelation();
const contractors = store.query().from("Contractor", "contractor")
  .project((fields) => ({ name: fields.contractor.name })).asRelation();

const people = await employees.union(contractors)
  .orderBy((columns) => columns.name)
  .limit(20)
  .execute();
```

`union()` removes duplicate projected rows, even when different graph entities produced those rows.
`unionAll()` retains duplicates. Distinct set operations and `distinct()` require portable scalar
columns; structured JSON equality differs between database engines. `unionAll()` can retain
structured columns because it does not compare them for equality.

Legacy `select()` callbacks are JavaScript result transformations and keep their existing set-operation
behavior. Use `project()` for set operations whose equality is defined by the visible output.

## Filter and aggregate completed results

Derived relations make filtering after aggregation and aggregation of aggregated results explicit:

```typescript
const totals = store.query().from("Purchase", "purchase")
  .groupBy((fields) => [fields.purchase.customerId])
  .aggregate((fields) => ({
    customerId: fields.purchase.customerId,
    total: expr.sum(fields.purchase.amount),
  }))
  .asRelation();

const largeCustomers = await totals
  .where((columns) => expr.gt(columns.total, expr.literal(100)))
  .orderBy((columns) => columns.total, "desc", "last")
  .execute();

const grandTotal = await totals
  .aggregate((columns) => ({ total: expr.sum(columns.total) }))
  .first();
```

SQL NULL still decodes to `undefined`. Ordering accepts an explicit `"first"` or `"last"` null
position; the defaults are NULLS LAST for ascending and NULLS FIRST for descending.

`distinct()` compares the whole projection before the relation's limit and offset. It does not
select an arbitrary edge or path to represent an entity. `count()` counts the current relation,
including distinctness and its range; `exists()` checks whether it has a row. Neither runs `map()`.

## Typed prepared composition

Reuse parameter expressions in the query and pass their declaration to `prepare()` to infer the
binding object's names and value types. The declaration must match every parameter used across all
operands and derived stages. Undeclared, missing, extra, and incompatible parameters are refused.

```typescript
const parameters = { minimum: expr.param("minimum", "number") };
const prepared = totals
  .where((columns) => expr.gt(columns.total, parameters.minimum))
  .prepare(parameters);

const rows = await prepared.execute({ minimum: 100 });
const bound = prepared.bind({ minimum: 200 });
```

`prepare()` without a declaration preserves the compatibility binding type
`Readonly<Record<string, unknown>>` and validates bindings at runtime. Parameter types are inferred
from the explicit declaration, not recovered automatically from every earlier query callback.

## Entity identities and deterministic pages

To deduplicate nodes, project only a node's `kind` and `id`, then call
`distinctNodes({ kind: "kind", id: "id" })`. The relation verifies that both columns came from the
same graph-node alias. The representative policy is identity-only: adding payload, edge, or path
columns is refused, because different matches might disagree on those values.

`page({ limit, offset? })` and `stream({ pageSize? })` require a provably unique ordering: use a
whole-row `distinct()` relation with scalar columns and order by every output column exactly once.
Computed sort expressions, missing tie-breakers, structured columns, and unproven uniqueness are
refused. Page limits and stream page sizes must be positive integers.

```typescript
const orderedNames = names.distinct().orderBy((columns) => columns.name);
const secondPage = await orderedNames.page({ limit: 20, offset: 20 });

for await (const row of orderedNames.stream({ pageSize: 100 })) {
  console.log(row.name);
}
```

Streaming fetches bounded pages; it is not a database cursor. Concurrent writes can change later
pages unless the relation runs inside a transaction with an appropriate stable snapshot. Ordinary
`limit()` and `offset()` remain available for relations without a proven unique order.

## Batch derived results

A bound relation implements the same one-statement read contract as other `batchOnce()` inputs:

```typescript
const [highValue, allTotals] = await store.batchOnce(() => [
  prepared.bind({ minimum: 200 }),
  totals.orderBy((columns) => columns.customerId),
] as const);
```

The requests execute in one SQL statement and retain independent result arrays. Normal batch
budgets, execution-target checks, and materialized-response tradeoffs apply. For retrieving multiple
subgraphs, continue to use the recommended
[`batchOnce(read => roots.map(root => read.subgraph(...)))` pattern](/performance/overview/).

Derived relations currently refuse execution inside `withCheckedReads()`. Recorded views retain
their recorded coordinate for direct relation execution and preparation; recorded relations remain
unavailable in `batchOnce()`. These refusals occur before any member executes.
