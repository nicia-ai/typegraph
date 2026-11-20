---
"@nicia-ai/typegraph": patch
---

Canonical-timestamp validation (`validFrom` / `validTo` on every write, trusted import, interchange, graph-merge plans, `asOf`, and date predicate operands) is roughly ten times cheaper per field. `isCanonicalIsoDate` now checks the fields its pattern captures — month, day for that month and year, hour, minute, second — instead of parsing a `Date` and comparing its `toISOString()` back to the input. It accepts and refuses exactly the same inputs as before, including refusing anything that is not a primitive string (a boxed `String` whose text is canonical); a property test keeps the previous implementation as the oracle.
