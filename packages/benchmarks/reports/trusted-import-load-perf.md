# Trusted-import load performance — benchmark observations

Follow-up to #273 (`trustedImportGraph` / `trustedImportGraphStream`), which
switched the SNB TypeGraph loaders (`typegraph-load.ts`) onto the trusted
initial-import path. These are the observations relevant to leveraging it for
the SNB benchmark lanes.

## 1. Write-path speedup confirmed on local hardware

`pnpm bench:bulk-load` (this repo's `bulk-load-investigation.ts`), 100k nodes +
300k edges, in-memory SQLite (`BULK_STORAGE=memory`), Apple-silicon dev
machine. Relative to the old store `bulkInsert` path (`store-live-indexes`):

| Scenario | loadMs | vs store path |
| --- | ---: | ---: |
| `store-live-indexes` (old path) | 7809 | 1.00× |
| `store-deferred-indexes` | 5574 | 1.08× |
| **`trusted-public-atomic-deferred-indexes`** (what the SNB loader now uses) | **2238** | **3.18×** |
| `trusted-native-live-indexes` (internal fast path) | 2065 | 3.41× |

The public trusted path the SNB loaders call lands at **3.18×**, in line with
#273's synthetic SQLite figure (2.98×). The win is drop-secondary-indexes +
prepared/`UNNEST` writes in one transaction, then rebuild indexes + `ANALYZE`.

## 2. Reads are unaffected — full query set, not just IS1–7

#273 verified IS1–7 parity. The `bench/pggraph-comparison` lanes (IC13, BFS3,
IC2/IC8/IC9, GA_DEGREE, and the algorithm lane) were re-run at smoke through the
trusted-import-loaded store: **every query that runs is `comparable=yes`**
against the other engines. The SNB covering index is still built post-import by
the factory's `materializeIndexes()` (guarded by `assertMessageIndexMaterialized`),
so read-time behaviour is identical to the old loader.

## 3. Caveat for scale: the SNB loader now reads the CSV twice

Interchange requires every node chunk before every edge chunk, but the datagen
CSV is entity-stage ordered (edges interleaved). `loadSnbDataset` therefore
makes **two bounded CSV passes** (nodes, then edges) through a zero-capacity
backpressure channel — memory stays at ~1 chunk, but the dataset is read twice.

The 3.18× above is a pure in-memory write measurement with **no CSV I/O**, so it
does not capture that second pass. The net SNB load-time win depends on the
CSV-read : write ratio; the write clearly dominated at 100k, so the net is very
likely still a large win, but this must be confirmed on a real CSV load.

**Recommended: run the definitive SF1/SF10 load-time A/B on the EC2 benchmark
runner**, not locally (local disk is space-constrained; SF10 in particular
needs headroom). Method — same host, same extracted dataset, `typegraph-sqlite`
loadMs only:

```bash
# after (current main, trusted import): note loadMs from a --engines=typegraph-sqlite SF1 run
# before: temporarily restore the pre-#273 loader, re-measure
git show 42f6941f^:packages/benchmarks/src/real/engines/typegraph-load.ts > /tmp/old-load.ts
```

Expectation to verify: SF1 `typegraph-sqlite` loadMs drops materially (target
≳2× end-to-end including the double CSV pass); if the double pass erodes the win
below ~1.5× at SF10, revisit spilling edges to a temp file instead of a 2nd pass.
