---
"@nicia-ai/typegraph": minor
---

Support list-valued parameters in `in()` / `notIn()`

`field.in(param("ids"))` now binds the whole list at
`.prepare().execute({ ids: [...] })`, so the canonical "fetch these ids"
query can finally be prepared. The list rides on a single bound parameter
that the dialect unpacks (`json_each` on SQLite, `jsonb_array_elements_text`
on PostgreSQL), which keeps arity out of the SQL text: one compiled statement
serves every list length, and a list of any size costs one bound parameter
instead of one per element. An empty list is valid — `in([])` matches nothing,
`notIn([])` matches everything.

A `ParameterRef` passed among the *elements* of a literal list
(`in(["a", param("b")])`) was previously coerced to a literal and silently
produced wrong results. It now throws `UnsupportedPredicateError` naming the
supported form. A name used both as a list and as a scalar in one query is
rejected at `prepare()`.

`DialectAdapter` gains two members, `inListParameter` and `packListValue`;
custom dialect adapters must implement them.
