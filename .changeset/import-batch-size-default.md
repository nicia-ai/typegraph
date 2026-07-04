---
"@nicia-ai/typegraph": patch
---

`importGraph`'s default `batchSize` is now 1,000 (was 100). Each batch
pays fixed per-round-trip costs — existence probe, unique pre-check,
one multi-row insert — so the old default dominated import time on
client/server engines: a 20k-node + 5k-edge import on PostgreSQL drops
from 1,515ms to 781ms (16.5k → 32k entities/s) with the new default.
Above ~1,000 the multi-row insert itself dominates and larger batches
stop paying. SQLite imports are insensitive to the value (in-process,
no round trips; measured within noise). The backend still splits
inserts by its per-driver bind-parameter budget, so a large batch never
overruns driver limits. Explicit `batchSize` values are unaffected.
