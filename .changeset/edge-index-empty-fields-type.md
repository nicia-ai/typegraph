---
"@nicia-ai/typegraph": patch
---

Reject empty `fields` arrays at the type level in `defineNodeIndex` and `defineEdgeIndex`. Previously, passing `fields: []` was accepted by TypeScript but threw at runtime. The `fields` property now requires a non-empty tuple, surfacing the error at compile time.
