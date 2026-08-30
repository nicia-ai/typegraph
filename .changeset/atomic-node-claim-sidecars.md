---
"@nicia-ai/typegraph": minor
---

Fold single disjointness claims and owner-side node claim cleanup into bundled atomic mutation programs. Eligible `nodes.bulkInsert()` and `nodes.bulkCreate()` calls for a `disjointWith` kind now retain one schema-fenced transport submission on Neon HTTP, Cloudflare D1, and libSQL, including legacy live-row detection and typed `DisjointError` rollback. Restricted node deletes release owned uniqueness and disjointness claims inside the same atomic program, and update-only upserts no longer fall back merely because their kind participates in disjointness.

Custom mutation executors now advertise claim support explicitly through `claimSupport.families`, `claimSupport.maxEntries`, and `releasedClaimFamilies`; omitted claim families remain on the portable path.
