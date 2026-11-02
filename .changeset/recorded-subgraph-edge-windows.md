---
"@nicia-ai/typegraph": patch
---

**A recorded-pinned `subgraph()` with `edgeWindows` no longer fails with an unknown `recorded_from` column.** The windowed edge source projected only the live edge columns, while the recorded read's row filter over it narrows by the recorded interval; the source now keeps `recorded_from` / `recorded_to` whenever the recorded binding carries them (an engine-native `AS OF` source carries none and needs none).
