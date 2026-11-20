---
"@nicia-ai/typegraph": minor
---

A range predicate on a date property (`gt`, `gte`, `lt`, `lte`, `between`) now refuses a string operand that is not canonical UTC ISO-8601 (`YYYY-MM-DDTHH:mm:ss.sssZ`) with `UnsupportedPredicateError`, before any SQL runs. SQLite compared such a string with the stored value as text and PostgreSQL as a `timestamptz` instant, so the same query matched different rows on the two backends: `gte("2024-01-01")` matched on SQLite and not on PostgreSQL, and `gte("2024-01-01T00:00:00Z")` the reverse. This changes what was accepted: a date-only string, a string without fractional milliseconds or with fewer than three digits, a UTC offset, a zoneless string, or an impossible date such as `"2024-02-30T00:00:00.000Z"` previously reached the database and now throws. Convert one with `new Date(value).toISOString()` after deciding which time zone it names, or pass a `Date`. A canonical string and a `Date` are accepted as before and compare identically on every backend, because the store writes a date property as its `toISOString()` text.

The check covers every element of an `in` / `notIn` list, both bounds of `between`, nested date properties reached through `get()`, literals compared in the expression context, and values bound to a `param()` when a prepared query executes. A bound `eq`, `neq`, `in` or `notIn` value on a date property, which previously took any string, now takes a `Date` or a canonical string. `between` on a date property also refuses a bound that is neither a `Date` nor a string, which previously reached the database.

The `$meta` timestamp predicates make the same decision through the same owner, so the two surfaces cannot drift. Both now also refuse a `Date` outside the four-digit years 0000 to 9999 (`$meta` with `ValidationError`, as before for its other refusals): its `toISOString()` is the extended `+010000-…` form, which sorts as text before every four-digit year and so compared differently on the two backends.

Error messages for a date, comparison or field-compatibility refusal now name the property (`"d.publishedAt"`, `"d.metadata.publishedAt"`) instead of the `props` column (`"d.props"`).
