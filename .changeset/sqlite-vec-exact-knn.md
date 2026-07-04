---
"@nicia-ai/typegraph": patch
---

Non-approximate `.similarTo()` on SQLite now routes through sqlite-vec's
vec0 KNN form. vec0's KNN is brute-force in C — exact by construction —
so the default path keeps identical results (pinned against
JS-computed ground truth) while dropping from the SQL distance scan to
engine speed: 489ms → 124ms for top-10 over 50k 384-dim embeddings.
Declared via a new `searchIsExact` flag on the vector-strategy
contract; pgvector and libSQL leave it unset (their engine forms are
approximate) and are unchanged. The metric gate still applies: an
explicit metric override that differs from the slot's declared metric
falls back to the SQL scan, which is correct for any metric.
