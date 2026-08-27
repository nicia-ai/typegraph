---
"@nicia-ai/typegraph": minor
---

Unify bundled root create and delete optimizations behind one exact-root mutation-program profile. Eligible node and edge `bulkDelete()` calls now run as one schema-fenced atomic exchange on bundled Neon HTTP, Cloudflare D1, and libSQL roots; the programs preserve edge collection identity, node restricted-delete semantics, stale-schema refusal, bind-budget chunking, and whole-call rollback, while node kinds that owe unique, disjointness, identity, projection, or capture sidecars retain the transactional path. Portable edge bulk deletion now replaces per-ID reads and writes with one batched authoritative read and set-based soft-delete chunks when the backend exposes the existing batch ports.
