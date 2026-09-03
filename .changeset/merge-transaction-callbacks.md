---
"@nicia-ai/typegraph": minor
---

Compose reviewed merge-plan application with application-owned graph checks and writes using optional `beforeApply` and `afterApply` callbacks. Prechecks receive transaction-bound read-only collections after the target fence is validated; post-apply work uses typed graph operations before the same transaction commits. Failures roll back the combined operation, and transaction-conflict retries replay both callbacks.
