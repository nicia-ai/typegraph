---
"@nicia-ai/typegraph": minor
---

Replace the three specialized edge-insert backend hooks with the shared `executeManagedCreate` contract. Managed edge creates now compile endpoint validation, an optional schema fence, and an optional cardinality claim into one all-or-nothing `ManagedCreatePlan` with an explicit `ManagedCreateResult`. Custom backends can omit the optional planned executor and retain the portable validated write path.
