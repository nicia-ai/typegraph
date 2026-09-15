---
title: Database Expressions
description: Type-safe filtering, calculation, projection, grouping, and ordering in SQL
---

Database expressions describe work that TypeGraph sends to the database. They carry a value type,
SQL nullability, and query scope, so TypeScript can reject incompatible operands and references to
aliases outside the current query.

```typescript
import { expr } from "@nicia-ai/typegraph";

const adults = await store
  .query()
  .from("Person", "p")
  .whereNode("p", (_person, e) =>
    expr.gte(e.p.age, expr.literal(18)),
  )
  .project((e) => ({
    name: e.p.name,
    ageNextYear: expr.add(e.p.age, expr.literal(1)),
  }))
  .orderBy((e) => e.p.age, "desc")
  .execute();
```

Expression callbacks are evaluated once while TypeGraph builds the query. Their expression trees
are compiled to SQL; they do not run once per result row.

## Fields, literals, and parameters

The callback context exposes every query alias. Node and edge schema properties appear directly on
their alias, including nested object properties. System metadata lives under `$meta`.

```typescript
.project((e) => ({
  name: e.person.name,
  author: e.person.metadata.author,
  // `$get` reaches schema keys that share a name with expression metadata.
  nestedNode: e.person.metadata.$get("node"),
  validFrom: e.person.$meta.validFrom,
}))
```

Object keys named `node`, `nullable`, `valueType`, `scopeIdentity`, `__type`, `__value`, or
`__scope` share names with the expression wrapper. Access those declared JSON properties with
`$get("key")`. Other declared keys support ordinary dot access. `$get` also accepts dynamic keys
on record schemas.

Use `expr.literal(value)` for a fixed value. Use `expr.param(name, valueType)` for a prepared value:

```typescript
const query = store
  .query()
  .from("Person", "p")
  .whereNode("p", (_person, e) =>
    expr.gt(e.p.age, expr.param("minimumAge", "number")),
  )
  .project((e) => ({ name: e.p.name }));

const prepared = query.prepare();
const rows = await prepared.execute({ minimumAge: 21 });
```

## Comparisons and Boolean expressions

`expr.eq`, `neq`, `gt`, `gte`, `lt`, and `lte` require compatible scalar operands. Compose Boolean
results with `expr.and`, `or`, and `not`. Use `isNull` and `isNotNull` for optional values.

```typescript
.whereNode("p", (_person, e) =>
  expr.and(
    expr.eq(e.p.active, expr.literal(true)),
    expr.or(
      expr.gte(e.p.score, expr.literal(90)),
      expr.isNull(e.p.score),
    ),
  ),
)
```

Comparisons with a nullable operand produce `boolean | undefined`, matching SQL's three-valued
logic. Null checks always produce a Boolean.

## Arithmetic and conversion

Use `add`, `subtract`, `multiply`, and `divide` with numeric expressions. Division produces
`undefined` when the divisor is zero. `toNumber` accepts numbers or strings in JSON number syntax:
an optional minus sign, an integer (`0` or digits without a leading zero), an optional fraction with
at least one digit, and an optional exponent with one to three digits. ASCII whitespace around the value is ignored. The
trimmed input may contain at most 400 characters. Finite values use ordinary IEEE-754 rounding,
including subnormal values; malformed input or a result outside the finite double range produces
`undefined`.

```typescript
.project((e) => ({
  gross: expr.multiply(e.invoice.unitPrice, e.invoice.quantity),
  ratio: expr.divide(e.invoice.used, e.invoice.capacity),
  importedAmount: expr.toNumber(e.invoice.rawAmount),
}))
```

These semantics are the same on SQLite and PostgreSQL.

## Coalescing and conditions

`coalesce` returns the first non-null value. `when` selects between compatible result expressions.

```typescript
.project((e) => ({
  displayName: expr.coalesce(e.p.nickname, e.p.name),
  segment: expr.when(
    expr.gte(e.p.score, expr.literal(90)),
    expr.literal("priority"),
    expr.literal("standard"),
  ),
}))
```

## Projection and mapping

Use `project()` to select database columns and computed values. Use `map()` for JavaScript work
after each row is decoded.

```typescript
const labels = await store
  .query()
  .from("Person", "p")
  .project((e) => ({ name: e.p.name, age: e.p.age }))
  .map((row) => `${row.name} (${row.age})`)
  .execute();
```

`select()` remains the compatibility result-mapping API. Existing selectors keep their current
execution behavior: compatibility planning may probe or retry a selector, so legacy selectors must
be pure. New code that should run in SQL should use `project()` explicitly. A `project()` callback
runs exactly once when the query is built, and a `map()` callback runs exactly once for each decoded
result row.

Use [`asRelation()`](/queries/relations/) to compose a SQL projection with set operations, derived
filters and aggregates, whole-row distinctness, and output-column ordering. Keep `map()` at the end
of SQL composition; mapped relations cannot become new SQL projections or set operands.

## Grouping and aggregates

Expression callbacks also work with grouping, aggregate projections, ordering, and HAVING:

```typescript
const totals = await store
  .query()
  .from("Person", "p")
  .groupBy((e) => [e.p.department])
  .having((e) => expr.gt(expr.count(e.p.id), expr.literal(2)))
  .aggregate((e) => ({
    department: e.p.department,
    people: expr.count(e.p.id),
    totalSalary: expr.sum(e.p.salary),
  }))
  .orderBy((e) => e.p.department, "asc")
  .execute();
```

`count` and `countDistinct` return a number. `sum`, `avg`, `min`, and `max` include `undefined` in
their result type because an empty input produces SQL `NULL`.
`countDistinct` accepts string, number, Boolean, and date expressions. Arrays, objects, embeddings,
and unknown dynamic values are refused because SQLite text equality and PostgreSQL JSON equality do
not define the same distinct groups for structured values.

For ordered scalar lists, use [`expr.collect()` on a relation](/queries/relations#ordered-scalar-collections).
Collection ordering is explicit and independent of result-row ordering.

## Scope safety

Each field expression belongs to the query scope that created it. TypeGraph refuses expression
trees that mix unrelated scopes at runtime, and callback types prevent aliases from another query
from being passed accidentally. Correlated subquery helpers provide an explicit outer context when
an inner query needs an outer field; ordinary callbacks cannot capture one by alias name.

Use `$exists()` for a correlated Boolean and `$scalar()` for one nullable value:

```ts
const people = await store
  .query()
  .from("Person", "person")
  .project((e) => ({
    hasNamesake: e.$exists((subquery, outer) =>
      subquery
        .from("Person", "candidate")
        .whereNode("candidate", (_candidate, inner) =>
          expr.eq(inner.candidate.name, outer.person.name),
        )
        .project((inner) => ({ id: inner.candidate.id })),
    ),
    peerAge: e.$scalar((subquery, outer) =>
      subquery
        .from("Person", "candidate")
        .whereNode("candidate", (_candidate, inner) =>
          expr.eq(inner.candidate.name, outer.person.name),
        )
        .project((inner) => ({ age: inner.candidate.age }))
        .limit(1),
    ),
    name: e.person.name,
  }))
  .execute();
```

Both callbacks must return an explicitly projected query on the same graph, execution target, and
temporal coordinate as the enclosing query. `$exists()` accepts any nonempty projection. `$scalar()`
requires exactly one projected field and either `limit(1)` or an ungrouped aggregate, so behavior
does not depend on an engine's handling of multiple scalar rows. A scalar with no matching row is
decoded as `undefined`. Parameters inside either subquery participate in the enclosing prepared
query's bindings.

Expression builders do not accept raw SQL. This keeps parameter binding, decoding, and SQLite /
PostgreSQL behavior on the same compiler path.

## Collection expression nodes

`expr.collect(value, options)` returns `DatabaseExpression<readonly T[], Scope>`. Reusable helpers
can import `CollectOptions<Scope>` for its required, nonempty `orderBy` tuple. Collection expressions
expose a distinct `node.kind: "collect"`, with `operand` and `orderBy`. Ordinary `"aggregate"` nodes
retain their operator and optional operand; collection-only options do not appear on them.
