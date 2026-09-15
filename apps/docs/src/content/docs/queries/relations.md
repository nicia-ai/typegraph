---
title: Composing Relations
description: Combine, filter, aggregate, and batch explicit SQL results
---

Call `asRelation()` on a database projection to work with its output columns. A relation supports
SQL filtering, projection, aggregation, ordering, deduplication, top-N per partition, and set operations. Its callbacks
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

Repeated relation `groupBy()` calls accumulate grouping expressions. When `aggregate()` or
`project()` completes that grouping, filters, distinctness, ordering, limits, and offsets apply to
the input rows first. Order or limit the returned relation to apply those operations to the grouped
results instead.

SQL NULL still decodes to `undefined`. Ordering accepts an explicit `"first"` or `"last"` null
position; the defaults are NULLS LAST for ascending and NULLS FIRST for descending.

`distinct()` compares the whole projection before the relation's limit and offset. It does not
select an arbitrary edge or path to represent an entity. `count()` counts the current relation,
including distinctness and its range; `exists()` checks whether it has a row. Neither runs `map()`.

<a id="ordered-scalar-collections"></a>

## Ordered collections

Use `expr.collect()` to return a list of scalar values or explicit flat records per group on a backend declaring
[`orderedAggregates: true`](/backend-setup#backend-capabilities). Project the input columns into a
relation first, then define collection ordering explicitly:

```typescript
const purchases = store.query().from("Purchase", "purchase")
  .project((fields) => ({
    id: fields.purchase.id,
    customerId: fields.purchase.customerId,
    amount: fields.purchase.amount,
    purchasedAt: fields.purchase.purchasedAt,
  })).asRelation();

const histories = await purchases
  .groupBy((columns) => [columns.customerId])
  .aggregate((columns) => ({
    customerId: columns.customerId,
    amounts: expr.collect(columns.amount, {
      orderBy: [
        { expression: columns.purchasedAt, direction: "asc", nulls: "last" },
        { expression: columns.id },
      ],
      filter: expr.gte(columns.amount, expr.literal(10)),
    }),
  }))
  .orderBy((columns) => columns.customerId)
  .execute();
// One row per customer, with matching amounts in purchase order.
```

Project a record when each parent needs the fields from each matching child together. Record fields
must be explicitly named scalar expressions; nested objects, arrays, and raw object expressions
are not collection elements:

```typescript
const histories = await purchases
  .groupBy((columns) => [columns.customerId])
  .aggregate((columns) => ({
    customerId: columns.customerId,
    purchases: expr.collect({
      id: columns.id,
      amount: columns.amount,
      purchasedAt: columns.purchasedAt,
    }, {
      orderBy: [
        { expression: columns.purchasedAt },
        { expression: columns.id },
      ],
    }),
  }))
  .execute();
// Each purchases value is a readonly array of readonly records.
// purchasedAt decodes to Date; nullable fields decode to undefined.
```

Import `CollectOptions<Scope>` to type reusable options or helper parameters without restating the
nonempty ordering tuple. It names the options contract for `expr.collect()`. `distinct` and
aggregate-local `limit` are not supported.

`orderBy` must contain at least one scalar expression. Each item accepts `direction` (`"asc"` by
default) and `nulls` (last for ascending, first for descending). Include a unique tie-breaker when
other ordering values can tie. Collection ordering controls elements inside each list; the relation's
outer `orderBy()` controls result rows. Source ordering is not an implicit collection order.

The optional `filter` is a Boolean database expression in the same scope as the value and ordering
expressions. SQL TRUE includes an element; false and SQL NULL exclude it. This follows SQL aggregate
filter semantics, including for prepared parameters.

Aggregate-local filtering matters with optional traversals. It can exclude a missing child while
retaining the parent's group:

```typescript
const projects = store.query().from("Project", "project")
  .optionalTraverse("hasTask", "assignment").to("Task", "task")
  .project((fields) => ({
    project: fields.project.name,
    taskId: fields.task.id,
    taskTitle: fields.task.title,
    priority: fields.task.priority,
  })).asRelation();

const rows = await projects
  .groupBy((columns) => [columns.project])
  .aggregate((columns) => ({
    project: columns.project,
    tasks: expr.collect(columns.taskTitle, {
      orderBy: [{ expression: columns.priority }, { expression: columns.taskId }],
      filter: expr.isNotNull(columns.taskId),
    }),
  }))
  .orderBy((columns) => columns.project)
  .execute();
// [{ project: "Launch", tasks: ["Fix blocker", "Write announcement"] },
//  { project: "Research", tasks: [] }]
```

Putting `expr.isNotNull(columns.taskId)` in the relation's outer `where()` instead removes the
childless row before grouping, so `Research` has no result row. Use the collection filter when the
parent must remain visible with an empty collection.

The same rule applies to records. Replace `columns.taskTitle` in the optional-traversal example
with `{ id: columns.taskId, title: columns.taskTitle }`, keeping its `orderBy` and
`filter: expr.isNotNull(columns.taskId)` options. This returns `[]` for a parent without a child.
Without that filter, an admitted optional-traversal row creates a record even when every projected
field is SQL NULL; its fields decode to `undefined`.

Scalar collection elements may be strings, numbers, Booleans, or dates. Record fields may use those
same scalar types, and their Boolean, Date, and SQL NULL values decode to `boolean`, `Date`, and
`undefined` respectively. The result is a readonly array with the projected element types and
nullability preserved. Filtering does not change those types. An
included SQL NULL operand decodes to `undefined` and remains in the collection; filtering is based
only on the `filter` expression. This includes NULL values from missing optional targets when the
filter admits them.

An empty ungrouped collection aggregate returns one row containing `[]`; an empty grouped relation
returns no rows. Source filters, distinctness, and ranges apply before collection aggregation.
Duplicates remain unless you deduplicate the input projection explicitly.

Collections support prepared and batched relation execution. They are materialized arrays, with no
implicit truncation or response-byte limit. Arbitrary object/nested collection elements and aggregate-local
limits are outside this API. Structured equality restrictions still apply: collection columns
cannot be used as relation ordering keys, with `distinct()`, distinct set operations, grouping keys, or the existing
scalar-only paging contract. Use compatible `unionAll()` to retain collection rows without equality.

## Top-N per parent

Use `topPerPartition()` to select up to N rows independently for each parent in one SQL query.
Partition keys identify the parent; the stage's ordering chooses its winning children. Both callbacks
must return nonempty tuples of scalar expressions. Include the parent's kind as well as its ID when
IDs can overlap across node kinds.

```typescript
const recentPurchases = purchases.topPerPartition({
  partitionBy: (columns) => [columns.customerId],
  orderBy: (columns) => [
    { expression: columns.purchasedAt, direction: "desc", nulls: "last" },
    { expression: columns.id },
  ],
  limit: 3,
});

const rows = await recentPurchases
  .orderBy((columns) => columns.customerId)
  .orderBy((columns) => columns.purchasedAt, "desc", "last")
  .orderBy((columns) => columns.id)
  .execute();
```

`limit` must be a positive safe integer. Import `TopPerPartitionOptions<Fields>` to type reusable
options for a projected relation, and `TopPerPartitionOrder` for reusable ordering entries. The stage
uses `ROW_NUMBER()`: ties do not expand the limit.
Supply a stable final tie-breaker, usually the child's ID, to choose repeatable winners. Use kind
and ID for multi-kind children whose IDs can overlap. The API cannot prove that your ordering is unique.
Nullable partition keys group together, and ordering
accepts the same explicit null positions and defaults as relation ordering. The ranking column is
private and never appears in the result.

Stage ordering chooses winners; it does not guarantee final result order. Add relation `orderBy()`
after the stage to order returned rows. A `where()` before `topPerPartition()` chooses candidates;
a `where()` afterward removes winners without selecting replacements. For example, filter purchases
by a minimum amount before ranking to retrieve the latest three qualifying purchases, or after
ranking to inspect which of the latest three qualify.

Source `distinct()`, limits, and offsets apply before ranking. A source limit is global and can
remove a parent's candidates entirely. Limits and offsets added after ranking apply globally to
the winners. Complete any pending `groupBy()` with `aggregate()` or `project()` before ranking;
post-execution JavaScript `map()` results cannot be ranked in SQL.

Ranked rows can feed ordered record collections, keeping the per-parent bound in SQL:

```typescript
const histories = await recentPurchases
  .groupBy((columns) => [columns.customerId])
  .aggregate((columns) => ({
    customerId: columns.customerId,
    purchases: expr.collect({
      id: columns.id,
      amount: columns.amount,
      purchasedAt: columns.purchasedAt,
    }, {
      orderBy: [
        { expression: columns.purchasedAt, direction: "desc", nulls: "last" },
        { expression: columns.id },
      ],
    }),
  }))
  .orderBy((columns) => columns.customerId)
  .execute();
```

For optional traversals, partition by the parent's identity. A childless parent's placeholder row
survives ranking. Keep `filter: expr.isNotNull(columns.taskId)` inside `expr.collect()` to turn that
placeholder into `[]`, as in the optional-traversal example above. Filtering the placeholder out of
the relation would remove the parent.

Ranked relations preserve projected types and codecs and support prepared queries and `batchOnce()`.
They require [`windowFunctions: true`](/backend-setup#backend-capabilities); unsupported backends
throw `UnsupportedBackendCapabilityError` before execution. This bounds returned rows per partition, but the database
may still scan and sort all candidates. It does not impose a response-byte budget or add an
aggregate-local collection limit.

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
