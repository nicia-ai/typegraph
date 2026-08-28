---
"@nicia-ai/typegraph": minor
---

Add a framework-agnostic atomic transport conformance runner for backend authors. It verifies ordered result slots, exact statement and parameter forwarding, empty-batch no-op behavior, later-statement rollback without primary or sidecar leakage, and caller-supplied exact-root provenance checks. Backends that do not opt into the certified transport retain the existing portable execution path.
