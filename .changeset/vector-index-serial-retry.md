---
"@nicia-ai/typegraph": patch
---

PostgreSQL ANN index builds (`materializeIndexes()` on pgvector
HNSW/IVFFlat) now retry serially when the parallel build exhausts
shared memory. Parallel builds stage the index graph in dynamic shared
memory, and resource-constrained hosts — e.g. containers with the 64MB
`/dev/shm` default — reject the allocation with SQLSTATE class 53
(observed: 53100 from `dsm_impl_posix` on a 50k x 384-dim HNSW build).
The retry drops the INVALID leftover from the failed CONCURRENTLY
build, pins the vector table to `parallel_workers = 0`, rebuilds in
local memory, and restores the setting. Non-resource failures still
surface as before. Serial builds are slower — raise `/dev/shm` and
`maintenance_work_mem` where you control the host — but a slow index
beats a silently missing one.
