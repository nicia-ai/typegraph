---
"@nicia-ai/typegraph": patch
---

Prevent startup identity repair from overwriting a newer schema migration with closure data derived from an older schema. Repair now checks the observed schema version inside its write transaction and raises `StaleVersionError` if a concurrent migration advanced it, preserving the newer closure.
