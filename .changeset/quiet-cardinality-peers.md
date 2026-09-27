---
"@nicia-ai/typegraph": minor
---

Bound candidate merge planning on revision-tracked graphs with `one` or `unique` edge cardinality. The transient working copy now includes only cardinality peers for candidate sources or endpoint pairs, so staging preserves full-clone constraint decisions without reading unrelated edges. Graphs with `oneActive` retain complete-clone staging until an active-only keyed peer read is available.
