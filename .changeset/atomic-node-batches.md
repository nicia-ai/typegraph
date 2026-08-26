---
"@nicia-ai/typegraph": minor
---

Execute eligible plain schema-managed `nodes.bulkInsert` and `nodes.bulkCreate` batches as one schema-fenced native atomic exchange on bundled Neon HTTP, Cloudflare D1, and libSQL roots. The complete plain node family accepts generated IDs, caller-supplied IDs, or mixed batches, and `bulkCreate` restores rows in input order. Claims, Operational Identity, projections, history, revision, constrained shapes, and other unsupported forms retain their existing transaction or fallback path.

The eligible program preserves live-duplicate rollback, tombstone resurrection validity semantics, bind-budget chunk rollback, and schema-fence errors while avoiding the prior sequence of transport submissions.
