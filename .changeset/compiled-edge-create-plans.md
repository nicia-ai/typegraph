---
"@nicia-ai/typegraph": minor
---

Replace the three specialized edge-insert backend hooks with one `executeEdgeCreatePlan` contract. Managed edge creates now compile endpoint validation, an optional schema fence, and an optional cardinality claim into one all-or-nothing backend plan with an explicit created-or-rejected result. Custom backends can omit the optional planned executor and retain the portable validated write path.
