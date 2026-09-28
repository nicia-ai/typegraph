---
"@nicia-ai/typegraph": minor
---

Bound candidate merge planning on revision-tracked graphs with `one` or `unique` edge cardinality. The transient working copy now includes only cardinality peers for candidate sources or endpoint pairs, so staging preserves full-clone constraint decisions without reading unrelated edges. A `oneActive` graph uses complete-clone staging when its backend lacks the active-only keyed peer read.
