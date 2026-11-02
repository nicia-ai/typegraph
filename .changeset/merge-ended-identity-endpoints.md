---
"@nicia-ai/typegraph": patch
---

A graph merge no longer refuses an identity assertion that has already ended because one of its endpoints is deleted. A branch that asserts `same` or `different` over two nodes and then deletes one of them — which ends the assertion — or that retracts an assertion while another branch deletes its endpoint, previously failed with `GRAPH_MERGE_IDENTITY_CONFLICT` ("A branch asserted an identity relation over a node another branch deleted.") even though the branch's current ledger held nothing for the pair. The merge now lands the ended assertion as history; an assertion that still holds over a deleted node is refused as before.
