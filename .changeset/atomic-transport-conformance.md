---
"@nicia-ai/typegraph": minor
---

Add independent execution capability declarations and a framework-agnostic atomic transport conformance runner for backend authors. It verifies ordered result slots, exact statement and parameter forwarding, empty-batch no-op behavior, later-statement rollback without primary or sidecar leakage, and caller-supplied exact-root provenance checks. Generic registration certifies transport mechanics but does not by itself authorize bundled node or edge mutation programs; semantic eligibility remains a separate fail-closed contract. Bundled factories now refuse the removed top-level `capabilities.transactions` override with migration guidance instead of silently retaining it as inert data; use `capabilities.execution.interactiveTransactions`.
