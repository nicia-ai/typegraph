---
"@nicia-ai/typegraph": minor
---

Reads now return a `Date` for a property whose schema output is a `Date`. The store persists a `z.date()` property as its ISO text, and every read handed that text back even though the property is typed `Date`. A read now decodes it wherever the output can only be a `Date`: a `z.date()`, a `z.coerce.date()`, or a pipe that ends in one (`z.string().pipe(z.coerce.date())`), inside `.optional()`, `.nullable()`, `.default()` and similar wrappers, a nested `z.object()`, a `z.array()` or a `z.record()`. This covers collection reads and the nodes and edges every write returns, query rows and selected fields, `.project()` and `asRelation().project()`, aggregates, `first()`, `paginate()` and `stream()`, traversals, `subgraph()` (whole and projected), `neighbors()`, search hits, `asOf()` and `asOfRecorded()` views, reads inside a transaction, and the nodes a graph merge hands to a kind's `block()` and to a `custom` similarity `score()`.

Every read decodes through one owner. Only the canonical text the store writes (`YYYY-MM-DDTHH:mm:ss.sssZ`, years 0001 to 9999) becomes a `Date`; any other value is returned exactly as stored. `.project()` and aggregates already returned a `Date` for a scalar date, but they turned any string or number into one, so non-canonical text became an `Invalid Date`. They now return such text as stored, except where PostgreSQL extracts the value with a `timestamptz` cast. A read applies no parse, transform or refinement, so a union with a date member, a tuple, and a `.transform()` (even one returning a `Date`) still read as stored. A kind with no date position pays nothing on a read.

The stored form is unchanged. `JSON.stringify` of a read, `exportGraph()` documents, pagination cursors and graph-merge plan props hold the same bytes as before. Graph merge still compares, fingerprints and keys committed props in their stored form.

### Upgrade notes

- Code that treated a date property read as a string breaks: `.slice()`, `.localeCompare()`, `startsWith()` and regular-expression tests throw a `TypeError`, `a.at === b.at` compares identity and is always `false`, `String(value)` and template literals give local-time text rather than ISO, and `Date.parse(value)` drops the milliseconds. Use `Date` methods (`getTime()`, `toISOString()`). `new Date(value)` workarounds, `<` and `>` between two values, `JSON.stringify` and `structuredClone` keep working.
- A `z.union()` with a date member, a tuple of dates and a `.transform()` that returns a `Date` still read as stored text. Declare `z.string().pipe(z.coerce.date())` instead of `z.string().transform((text) => new Date(text))` to read a `Date`.
- Stored text that is not the canonical form is still returned as text, never an `Invalid Date`. Run `validateStore()` to find it.
- Node and edge `meta` timestamps (`createdAt`, `validFrom` and the rest) are unchanged: they are still ISO strings.
- `PreparedQueryConfig` has a required `registry` member: the kinds whose stored props a prepared query's rows decode.
