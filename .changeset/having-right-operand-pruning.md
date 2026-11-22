---
"@nicia-ai/typegraph": patch
---

Column pruning now keeps a field read only on the right of a comparison. A `having()` comparison such as `t.id != k.fromId`, where no other clause read `k.fromId`, pruned that column from its CTE: the statement failed with `no such column` on SQLite and `column ... does not exist` on PostgreSQL, and with an edge `e` beside a node `e_from` the comparison silently read the node's id on both sides and returned no rows. The edge column is now carried; beside `e_from` the statement declares two `e_from_id` columns that `having()` reads unqualified, so it is refused with `SQL_IDENTIFIER_COLLISION` before any SQL is sent (#960).
