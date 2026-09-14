---
"@nicia-ai/typegraph": minor
---

Add opt-in shared subgraph hydration with `batchOnce(build, { shareSubgraphs: true })`. Compatible reads share a multi-root traversal and hydrated entities while preserving per-request membership, projections, temporal coordinates, edge windows, and independent result objects. Default batching retains independent plans; benchmark overlapping, payload-heavy roots before enabling sharing. All current-time reads built inside a batch use one pinned instant.

Add qualified recursive paths with `path: { format: "qualified", alias: "route" }`. The output alternates kind-qualified node references and edge references with traversal direction. Existing `path: true` and string aliases still return node-ID arrays.

Compose multiple recursive traversal stages with separate depth, path, cycle, and stop state. Later stages expand upstream source identities and preserve prior row multiplicity; final filters and ranges apply after composition. Mixed fixed-hop/recursive chains and scalar recursive-edge projections remain unsupported. Ordered recursive reads now retain their sort columns when embedded in `batchOnce()`.
