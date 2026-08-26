---
"@nicia-ai/typegraph": minor
---

Execute eligible plain schema-managed `nodes.bulkInsert` and `nodes.bulkCreate` batches as one schema-fenced native atomic exchange on bundled Neon HTTP, Cloudflare D1, and libSQL roots. Claim-free nodes accept generated IDs, caller-supplied IDs, or mixed batches. A claimed node is eligible only for generated-ID batches with exactly one same-kind (`scope: "kind"`) uniqueness constraint, subject to the backend's claimed-member budget. `bulkCreate` restores rows in input order. Operational Identity, projections, history, revision, caller-supplied or mixed IDs in claimed batches, multiple or non-kind uniqueness constraints, disjointness, and other unsupported forms retain their existing transaction or fallback path.

The eligible program preserves live-duplicate rollback, tombstone resurrection validity semantics, bind-budget chunk rollback, and schema-fence errors. The libSQL transport inventory measures one `batch` submission and zero `execute` calls for both generated claim-free and generated single-claim node batches; this is a submission-count measurement, not a wall-clock RTT benchmark.
