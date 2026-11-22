---
"@nicia-ai/typegraph": patch
---

Transaction receipts now count the node deletions and revivals TypeGraph makes on a transaction outside its `tx.nodes` collections, each as one write of the node's kind, in the transaction's receipt and in every enclosing `tx.measure` scope. That covers a node that graph-merge apply deletes, including the delete half of a recreation, through `applyMergePlan()` (in the receipt its report carries) and through `applyMergePlanInTransaction()` (in the caller's receipt), and a fact that a provenance retraction verb closes or reopens. Before, none of these was counted in any receipt. A rejected write still counts nothing, and a merge apply rolled back to its savepoint still counts none of its writes. Writes that bypass the Store (direct backend writes, raw SQL, import helpers) remain uncounted.
