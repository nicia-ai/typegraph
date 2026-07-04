---
"@nicia-ai/typegraph": patch
---

perf: recorded-time capture acquires the PostgreSQL graph-write advisory lock once per transaction instead of once per captured write (`pg_advisory_xact_lock` is reentrant and held to transaction end, so the repeats were pure round trips). A 50-write recorded transaction drops from N+1 lock round trips to 1; measured 1.7× on the transaction shape.
