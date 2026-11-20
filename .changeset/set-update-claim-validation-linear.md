---
"@nicia-ai/typegraph": patch
---

Uniqueness validation of a set write is linear in the rows it writes. `updateWhere()`, merge apply and the other resolved node writes refuse two members of the set that compete for one claim row, and that check compared every proposal with every earlier one, re-encoding both claim keys per comparison: an `updateWhere()` over 10,000 rows of a kind with a uniqueness constraint spent about 15 s in it on either backend (SQLite: 17.4 s for the whole call, 0.49 s now). Proposals are now compared only with the earlier proposals on their own claim row, which are the only ones that can compete, and the refusal still names the earliest competitor.
