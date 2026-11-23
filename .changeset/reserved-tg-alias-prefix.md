---
"@nicia-ai/typegraph": minor
---

Query aliases and output keys that start with `__tg`, in any letter case, are now refused before any SQL is sent (#975). The compiler names what it generates beside a caller's names in that namespace: it renames a `$exists()` / `$scalar()` subquery's aliases to `__tg_sq_<depth>_a<index>`, and names hidden ordering and envelope columns `__tg_order_<n>`, `__tg_relation_order_<n>`, `__tg_scalar` and the like. A caller name spelled like a generated one met it, and the query returned wrong values with no error: an outer alias named `__tg_sq_1_a0`, read through `outer.__tg_sq_1_a0` inside a `$exists()` subquery, compared the subquery's own row with itself, and a relation `project()` key named `__tg_relation_order_0` beside an `orderBy()` came back holding another column's value.

- An alias passed to `from()`, `fromDynamic()`, `traverse()`, `optionalTraverse()`, `traverseDynamic()`, `optionalTraverseDynamic()`, `to()`, `toDynamic()`, `toKindSet()`, `parts()`, `wholes()`, or as a `recursive({ depth, path })` alias, inside a subquery or not, is refused where it is passed with a `ValidationError` whose issue carries `path: "alias"` and the code `SQL_IDENTIFIER_COLLISION`, even when it is not otherwise a valid identifier (`__tg-bad`). A query AST compiled without the builder is refused the same way at compile, for every alias of the statement, of its nested subqueries and of each set-operation leaf.
- `aggregate()` and `project()` keys were already refused under the narrower `__tg_` prefix; they are now refused under `__tg` (so `__tgTotal` is refused too), and a relation's `project()` and `aggregate()` keys are refused the same way, all with the existing `ConfigurationError` ("Projection output name is reserved.", `details.outputName`).
- The same keys are refused when they reach the library without those calls. A relation definition handed to the public `ExecutableRelationQuery` constructor is refused when it is compiled (`execute()`, `compile()`, `prepare()`, `count()`, `exists()`, `batchOnce()`) if any column of its tree, or any output key of a source query in it, starts with `__tg`: a visible column named `__tg_partition_rank` under `topPerPartition()` otherwise met the hidden rank column and returned no rows on SQLite and an ambiguous-column error on PostgreSQL. A query state handed to a public query constructor (`ExecutableProjectionQuery`, `ExecutableAggregateQuery`, `QueryBuilder` and the like) is refused the same way when its AST is built.

Every query that uses no such name compiles to the same SQL as before.

### Breaking

A query that uses an alias, or an `aggregate()`, `project()` or relation key, starting with `__tg` in any letter case now throws where the name is passed. Rename it.
