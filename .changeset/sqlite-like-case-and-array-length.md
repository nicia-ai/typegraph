---
"@nicia-ai/typegraph": minor
---

`like()` is now case-sensitive on SQLite, as it always was on PostgreSQL and as the documentation describes. The query compiler emitted a plain `LIKE` on both backends, and SQLite's `LIKE` ignores ASCII case, so `x.s.like("A%")` matched both `"ABC"` and `"abc"` on SQLite but only `"ABC"` on PostgreSQL. Case-sensitive matching is now a dialect operation. PostgreSQL still emits `LIKE … ESCAPE '\'`. SQLite emits `GLOB` over the same pattern, translated in SQL, so literal and `param()` patterns behave identically: `%` and `_` are the wildcards, `\` escapes, and `*`, `?`, `[`, `]` match themselves.

`contains()`, `startsWith()`, `endsWith()` and `ilike()` are unchanged and stay case-insensitive. Their case folding is the database's. SQLite's built-in `LOWER()` folds ASCII letters only (Unicode when the ICU extension is loaded). PostgreSQL folds per the database's `LC_CTYPE`: under a UTF-8 locale `ilike("é")` matches `"É"`, under the `C` locale it does not. This is now documented on the predicates page and in the backend parity matrix rather than emulated.

`ArrayFieldAccessor` no longer declares a `length` member. It was typed as a `NumberFieldAccessor` but never built, so `x.tags.length.gt(1)` compiled and then threw `TypeError: Cannot read properties of undefined (reading 'gt')` on every backend. Use `lengthEq` / `lengthGt` / `lengthGte` / `lengthLt` / `lengthLte`, which are unchanged.

### Breaking

- Changed: on SQLite (better-sqlite3, libSQL, and any Drizzle SQLite driver), `like()` matches case-sensitively. Existing SQLite queries using `like()` may return fewer rows after upgrading. To keep the previous case-insensitive behaviour, use `ilike()` with the same pattern. PostgreSQL results are unchanged.
- Removed: `ArrayFieldAccessor.length`. Code that used it threw at runtime; it is now a compile error. Replace `x.tags.length.gt(n)` with `x.tags.lengthGt(n)`, and likewise for `eq` / `gte` / `lt` / `lte`.
