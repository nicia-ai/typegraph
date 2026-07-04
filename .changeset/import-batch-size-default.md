---
"@nicia-ai/typegraph": patch
---

`importGraph`'s default `batchSize` is now 1,000 (was 100), and the
default now actually applies: options are parsed through
`ImportOptionsSchema` at the function boundary, so direct calls that
omit fields with schema defaults (e.g. `{ onConflict: "error" }`)
resolve them instead of reading `undefined`. `ImportOptions` is now the
schema's input type — fields with defaults are optional for callers.

Each import batch pays fixed per-round-trip costs (existence probe,
unique pre-check, one multi-row insert), so the old default dominated
import time on client/server engines: a 20k-node + 5k-edge import on
PostgreSQL drops from 1,515ms to 781ms (16.5k → 32k entities/s).
SQLite imports are insensitive to the value (in-process, no round
trips). Explicit `batchSize` values are unaffected.

Fulltext batch upserts and deletes are now split by the driver's
bind-parameter budget in the backend wrappers, like node/edge/unique
inserts already were. Previously a searchable import slice emitted ONE
FTS5 (or tsvector) statement over every row — 6 binds per row, so a
1,000-row slice overflowed SQLite's 999-bind fallback ceiling and D1's
~100-bind cap, and 6,000-row slices overflowed even better-sqlite3's
32,766 budget ("too many SQL variables").
