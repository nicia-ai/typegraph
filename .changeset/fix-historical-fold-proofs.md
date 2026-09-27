---
"@nicia-ai/typegraph": minor
---

Make `IdentityReadFacade` and `IdentityFacade` the complete public identity surfaces, including `classes` and `explainSame`. Replace the exported `IdentityReadSurface` and `IdentitySurface` aliases with those facade types.

Historical identity reads and traversals now agree on registered kinds, and `explainSame` cites an implicit same-ID fold only when both nodes existed at the requested coordinate. Class cursors keep a fixed size as kind filters grow. Identity invariant errors include graph details and an appropriate current or historical recovery hint.
