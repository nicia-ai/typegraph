---
"@nicia-ai/typegraph": minor
---

A query whose generated SQL names cannot be told apart on every database engine is now refused before any SQL is sent, with the same `ValidationError` on every backend. Each alias becomes part of SQL names (`cte_<alias>`, `<alias>_<column>`, result columns such as `<alias>_<field>`); PostgreSQL clips every name to 63 bytes, and both engines compare names without regard to letter case. Until now such a query failed on PostgreSQL (`column reference is ambiguous`, `WITH query name specified more than once`) or silently returned another value's data, often on SQLite while PostgreSQL failed. The issue codes `SQL_IDENTIFIER_COLLISION` and `SQL_IDENTIFIER_TOO_LONG` are exported from `@nicia-ai/typegraph/errors` as `SQL_IDENTIFIER_COLLISION_CODE` and `SQL_IDENTIFIER_TOO_LONG_CODE`.

Now refused, by `execute()`, `compile()`, `toSQL()` and `prepare()` alike:

- aliases that differ only by letter case, such as `item` and `Item`;
- long aliases whose generated names clip to the same 63 bytes, such as two 60-character aliases sharing their first 59 characters;
- an edge alias `e` beside a node alias `e_from` when whole rows are selected, and a property `edge_id` of alias `p` selected together with the id of alias `p_edge`;
- a result column read back by name that is longer than 63 bytes, such as the id of a 61-character alias (#931);
- an `aggregate()` key longer than 63 bytes (counted in bytes, so 32 two-byte characters are too long), refused when `aggregate()` is called.

To fix a refused query, rename: use aliases that differ in more than letter case and early in the name, keep aliases short enough that `<alias>_<field>` fits in 63 bytes, or choose a shorter `aggregate()` key. The SQL text of every query that is not refused is unchanged, and two names that meet are not refused when the statement reads neither of them; a set-based update through a candidate query whose root alias is 61 characters long keeps working.

`aggregate()` keys and `project()` keys starting with the reserved `__tg_` prefix are now refused in any letter case with `ConfigurationError("Projection output name is reserved.")`; `project()` previously refused only the lowercase prefix and `aggregate()` refused none. Recursive traversals, set operations, `asRelation()`, subqueries, `batchOnce()`, checked reads and cursor pages do not run this check yet.
