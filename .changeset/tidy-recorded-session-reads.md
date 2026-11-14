---
"@nicia-ai/typegraph": patch
---

Reduce recorded ownership metadata round trips by reading allocation origins with the clock and checking iterative read ownership once per verified database snapshot. Preserve per-statement checks for weaker isolation and external owner providers, and reject origins retired during an operation.
