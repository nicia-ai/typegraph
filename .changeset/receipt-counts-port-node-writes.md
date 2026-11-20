---
"@nicia-ai/typegraph": patch
---

Transaction receipts now count a node delete or revival that a transaction's internal runtime port performs, as one write of the node's kind, in the transaction's receipt and in every enclosing `tx.measure` scope. Before, a fact a provenance transition closed or reopened, and a node merge apply deleted, was counted in no receipt.
