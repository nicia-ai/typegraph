---
"@nicia-ai/typegraph": minor
---

A query whose generated SQL names cannot be told apart on every database engine is now refused before any SQL is sent, with the same `ValidationError` on every backend. Each alias becomes part of SQL names (`cte_<alias>`, `<alias>_<column>`, result columns such as `<alias>_<field>`); PostgreSQL clips every name to 63 bytes, and both engines compare names without regard to letter case wherever SQL refers to them. Until now such a query failed on PostgreSQL (`column reference is ambiguous`, `WITH query name specified more than once`) or silently returned another value's data, often on SQLite while PostgreSQL failed. The issue codes `SQL_IDENTIFIER_COLLISION` and `SQL_IDENTIFIER_TOO_LONG` are exported from `@nicia-ai/typegraph/errors` as `SQL_IDENTIFIER_COLLISION_CODE` and `SQL_IDENTIFIER_TOO_LONG_CODE`.

Every entry point checks the statement it actually sends or hands out. `execute()` checks the statement it sends: the one that reads only the selected fields when the selector reads plain fields, and the full statement if it falls back to it. `compile()` and `toSQL()` check the SQL they return, which always carries every column of every alias. `prepare()` checks every statement the prepared query can run. So node `k` beside edge `K` selecting only ids still executes and returns the right rows, while its `compile()`, `toSQL()` and `prepare()` are refused, because the SQL they would hand out reads both `k_id` and `K_id`.

Now refused:

- aliases that differ only by letter case, such as `item` and `Item`;
- long aliases whose generated names clip to the same 63 bytes, such as two 60-character aliases sharing their first 59 characters;
- an edge alias `e` beside a node alias `e_from` when the statement reads the edge's `from_id` and the node's `id` (whole rows, or any `compile()` of a `select()`), and a property `edge_id` of alias `p` selected together with the id of alias `p_edge`;
- `aggregate()` keys that differ only by letter case when the query orders by one of them, such as `total` and `Total` with `.orderBy("Total")`, which SQLite resolved to the other key;
- a result column read back by name that is longer than 63 bytes, such as the id of a 61-character alias (#931);
- an `aggregate()` key longer than 63 bytes (counted in bytes, so 32 two-byte characters are too long), refused when `aggregate()` is called.

The check covers `execute()`, `first()`, `count()`, `exists()`, `executeOn()`, `executeChecked()`, `compile()`, `toSQL()`, `prepare()`, `paginate()`, `stream()` and `page()` of `select()` queries; the terminals of `project()` and `aggregate()` queries, including those that run through `asRelation()`; `count()` and `exists()` before `select()`; `store.batch()`, `store.batchOnce()` and `withCheckedReads()`; the operands of `union()`, `intersect()` and `except()`; and `updateWhere()` candidate queries. Where a statement is embedded in SQL that refers to its result columns by name (relations, checked reads, `batchOnce()`, set operations), result names that differ only by letter case are refused too.

Two names that meet are not refused when the statement never refers to that name in the relation that holds both, so the SQL text of every query that is not refused is unchanged, `.project((ctx) => ({ name: ctx.e_from.name }))` beside an edge `e` keeps working, and a set-based update through a candidate query whose root alias is 61 characters long keeps working. To fix a refused query, rename: use aliases and keys that differ in more than letter case and early in the name, keep aliases short enough that `<alias>_<field>` fits in 63 bytes, or choose a shorter `aggregate()` key.

`aggregate()` keys and `project()` keys starting with the reserved `__tg_` prefix are now refused in any letter case with `ConfigurationError("Projection output name is reserved.")`; `project()` previously refused only the lowercase prefix and `aggregate()` refused none. Recursive traversals, subqueries, and the names a relation or set operation adds around its operands are not checked yet.
