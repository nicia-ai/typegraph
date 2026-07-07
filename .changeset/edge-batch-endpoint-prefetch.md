---
"@nicia-ai/typegraph": patch
---

Batches edge creation's endpoint-existence checks in `bulkCreate`/`bulkInsert`
into one `getNodes` call per distinct (kind) referenced across the whole
batch, instead of an individual `getNode` probe per edge (mirroring the
batched existence/uniqueness pre-check node creation already had via
`primeBatchValidationCaches`). Found while investigating why a real
LDBC SNB SF1 bulk load (millions of nodes and edges) was far slower than
expected: a controlled 1M-row reproduction showed `bulkInsert` edge-batch
time growing from ~90ms to ~630ms per 2,000-row batch as the graph grew,
while an equivalent node-only batch (no edges) stayed roughly flat. The
edge batch path validated each edge's `from`/`to` endpoints with a
`getNode` call per edge — for a batch with mostly-unique endpoints, that's
thousands of individual round trips per batch instead of one batched
fetch per distinct node kind. With the fix, the same 1M-edge reproduction's
per-batch time drops to roughly ~90-160ms and its growth curve flattens
substantially (the residual growth matches the same mild index-maintenance
cost already seen on plain node inserts). No behavior change: this is a
pure internal optimization to `executeEdgeCreateNoReturnBatch`/
`executeEdgeCreateBatch`; callers observe identical results, just fewer
round trips.
