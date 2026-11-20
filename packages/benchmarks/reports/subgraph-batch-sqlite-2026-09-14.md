# Subgraph batching: initial SQLite measurement

Measured on 2026-09-14 with in-memory better-sqlite3, eight iterations after
two warmups. These small runs establish direction; they are not release
guardrails.

| Shape | Mode | Median total | Statements | Raw rows | Encoded bytes |
| --- | --- | ---: | ---: | ---: | ---: |
| 75% overlap, full 2,048-byte payload | direct | 0.93 ms | 16 | 74 | 173,106 |
| same | batchOnceUnfused | 1.59 ms | 1 | 8 | 185,713 |
| same | batchOnceShared | 1.28 ms | 1 | 1 | 135,768 |
| 0% overlap, full 256-byte payload | direct | 1.17 ms | 16 | 104 | 57,208 |
| same | batchOnceUnfused | 1.40 ms | 1 | 8 | 74,825 |
| same | batchOnceShared | 1.57 ms | 1 | 1 | 93,845 |
| 75% overlap, identity projection, seeded 2,048-byte payload | direct | 0.73 ms | 16 | 74 | 16,621 |
| same | batchOnceUnfused | 1.11 ms | 1 | 8 | 24,521 |
| same | batchOnceShared | 0.90 ms | 1 | 1 | 28,932 |

All shapes use eight roots, depth two, and branching factor two. Reproduce a
row by changing `--overlap`, `--projection`, and `--payload-bytes`:

```bash
pnpm exec tsx src/subgraph-batch-bench.ts --roots=8 --depth=2 \
  --branching=2 --overlap=75 --projection=full --payload-bytes=2048 \
  --iterations=8 --warmup=2 --simulated-roundtrip-ms=0
```

At 75% overlap with full payloads, opt-in sharing reduced encoded bytes by
26.9% and median total time by 19.6% relative to the unfused one-statement
control. With no overlap it increased encoded bytes by 25.4% and time by 11.8%.
For identity-only projection, sharing reduced time by 18.8% but increased the
small encoded representation by 18.0%. This makes overlap and projected payload
material to any automatic-selection policy; statement count alone does not
justify sharing.

Backend duration is the sum of client-observed `backend.execute` durations,
not server execution time. Concurrent direct calls overlap, so this sum can
exceed total wall time. Encoded bytes are UTF-8 JSON size at the backend
boundary, not database-protocol wire bytes. Heap deltas were collected but
omitted because short-run, non-forced-GC measurements were noisy. A real remote
PostgreSQL endpoint is required for network and server conclusions.
