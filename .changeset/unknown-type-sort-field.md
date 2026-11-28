---
"@nicia-ai/typegraph": patch
---

A page of a query ordered by a property of unknown type (a `z.union([z.string(), z.number()])`, say) now sorts its rows as `execute()` does on PostgreSQL. When the query selected only some fields, `paginate()`, `page()` and `stream()` ordered such a property by its JSON value while `execute()` orders it, and the cursor compares it, as its text, so three rows ranked 10, 2 and "x" paged as one row and an empty page, with or without a search. A full-text, vector or hybrid query's cursor now also carries such a key as the statement sorts it, so a number whose JSON form is not its text (`1e21`) resumes exactly. A query without a search keeps the cursor it always issued, which holds the row's JSON value: on PostgreSQL that number can still resume from its JSON form and skip a row whose text sorts between the two.
