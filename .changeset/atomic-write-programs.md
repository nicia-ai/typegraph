---
"@nicia-ai/typegraph": minor
---

Eligible schema-managed generated-id node creates and `cardinality: "many"` edge creates on bundled root backends can now execute as one authoritative statement, including Neon HTTP and Cloudflare D1, where all required claims, projections, and side effects are either absent or fused into that statement. History/revision and Operational Identity work, plus other managed writes, continue to require the interactive transaction or an explicit typed refusal.

Clarify and harden execution boundaries for managed writes. The authoritative command helper now validates command/result correlation once, with typed node, edge, and convergence overloads; first-party Store consumers no longer duplicate that check, while recorded-capture retains its direct transaction-wrapper assertion. `OptionalTransactionExecution` is now a discriminated `{ mode: "interactive-transaction" | "sequential" }` value; migrate custom consumers from `execution.atomic` to `execution.mode`.

Document the distinction between interactive Store transactions, static internal adapter batches, and authoritative one-statement commands. Durable edge `matchIdentity` convergence may qualify for the one-statement root command because its canonical key has a database arbiter; claims/cardinality, undeclared dynamic `matchOn`, history/revision sidecars, and Operational Identity remain interactive-transaction contracts. The static native-batch adapter foundation remains internal; no new public Store batching API is implied.
