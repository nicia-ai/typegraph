---
"@nicia-ai/typegraph": minor
---

Add the `@nicia-ai/typegraph/provenance` subpath for provenance-backed source
retraction. The first slice maps user graph kinds to source, justification,
fact, premise, and derivation roles; supports multiple source node kinds and
terminal fact kinds; requires `{ history: true }`; applies TypeGraph-managed
belief transitions by making unsupported facts non-current; and keeps
recorded-time replay available before and after retraction. A transition only
touches facts reachable from the flipped sources, and closing a fact's currency
is a belief-status change rather than a domain delete — the fact's edges are
left untouched (no `restrict`/`cascade`/`disconnect` enforcement), so
`unRetract` is an exact inverse of `retract`. PostgreSQL transitions serialize
with TypeGraph-managed history writes on the same graph; out-of-band SQL
remains outside recorded capture.
