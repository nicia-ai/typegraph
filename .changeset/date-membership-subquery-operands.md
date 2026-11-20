---
"@nicia-ai/typegraph": minor
---

Date operands in membership, JSON-path, subquery and index-probe positions now pass the same canonical-date check as every other date predicate, before any SQL runs, so they compare the same way on every backend.

- `expr.arrayContains` on a date array checks its element, whether a literal, a `param()` binding, or one a `coalesce` or `when` forwards. A short form of a stored instant such as `"2024-01-01T00:00:00Z"` bound to `expr.param("at", "date")` previously matched on PostgreSQL, which re-renders the operand, and not on SQLite; a year-0000 operand failed PostgreSQL's cast. Both now throw `UnsupportedPredicateError`.
- The predicate builder's `contains`, `containsAll` and `containsAny` on a date array, `pathContains` on a date-array JSON path, and `pathEquals` on a date JSON path take a `Date` or a canonical string and refuse anything else with `UnsupportedPredicateError`. `pathEquals` compared a date path as a `timestamptz` on PostgreSQL and as text on SQLite, so a non-canonical string matched different rows; the array forms compared text on both and silently matched nothing.
- A date a `$scalar()` subquery or an `inSubquery` / `notInSubquery` subquery projects, as a literal or a binding, is checked against the property it is compared with. On PostgreSQL such a projection is now typed `timestamptz`: it was `text`, so comparing a date property with `$scalar(… project({ cutoff: expr.param("from", "date") }) …)`, or testing it `IN` such a subquery, failed with `operator does not exist: timestamp with time zone >= text` even for a canonical value, while SQLite returned rows. The comparison now runs and returns the same rows on every backend.
- `bulkFindByIndex` now probes a date-typed index key instead of throwing `ConfigurationError`. A probe must be a `Date` or a canonical string in the years 0001 to 9999 and binds its canonical text, the one form SQLite (which compares the stored text) and PostgreSQL (which compares the instant) agree on; any other probe throws `ValidationError`.

`DialectAdapter` has a new required member, `dateValue`, which types a date literal or parameter as the dialect's date type: identity on SQLite, `CAST(… AS timestamptz)` on PostgreSQL. A custom dialect adapter must implement it.
