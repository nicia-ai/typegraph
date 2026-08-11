---
"@nicia-ai/typegraph": patch
---

Restore a merged node's `disjointWith` reservations after a resolved merge write set commits.

A resolved node write set (the graph-merge apply path, and the set update it shares its preflight with) validates the whole after-image, then clears the affected nodes' sidecar rows so its upserts can take the approved keys in any order, then rebuilds them once at the end — the rebuild is what keeps a coalesced, otherwise side-effect-free upsert from leaving its key unreserved.

The clear is keyed on the claim's OWNER, so it takes every reservation the affected nodes hold, and since 0.48 that includes their `disjointWith` claims as well as their uniqueness claims. The rebuild now goes through the same claim writer an ordinary create uses, which restores whatever the row's kind owes rather than the uniqueness slice alone; previously a merged node came out of every merge with its disjointness axis unreserved, leaving it unfenced against a disjoint namesake for the rest of the graph's life.
