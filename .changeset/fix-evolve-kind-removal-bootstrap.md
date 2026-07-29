---
"@nicia-ai/typegraph": patch
---

Ensure the kind-removal status table before `evolve()` checks it, so databases
created before TypeGraph 0.44 can evolve without manual backend initialization.
