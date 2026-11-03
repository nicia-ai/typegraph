---
"@nicia-ai/typegraph": patch
---

A graph merge no longer commits an identity ledger that is both same and different over the time a retracted assertion still held. The merge's contradiction check used to drop a base assertion a branch retracts, although the merged ledger keeps it as history valid until the retraction's end, so another branch's claim over that span went unchecked: one branch asserting `different(b, c)` while another asserted a backdated `same(a, c)` and retracted the inherited `same(a, b)` merged into a ledger where `b` and `c` were both the same and different until the retraction. That merge is now refused at plan time with `GRAPH_MERGE_IDENTITY_CONFLICT`, as `planMerge` and the incremental commit guard also judge the retracted row over the time it held.
