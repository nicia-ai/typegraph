---
"@nicia-ai/typegraph": minor
---

Add the `@nicia-ai/typegraph/provenance` subpath for provenance-backed source
retraction. The first slice maps user graph kinds to source, justification,
fact, premise, and derivation roles; supports multiple source node kinds and
terminal fact kinds; requires `{ history: true }`; applies TypeGraph-managed
belief transitions by making unsupported facts non-current; and keeps
recorded-time replay available before and after retraction. PostgreSQL
transitions serialize with TypeGraph-managed history writes on the same graph;
out-of-band SQL remains outside recorded capture.
