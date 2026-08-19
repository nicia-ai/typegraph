---
"@nicia-ai/typegraph": patch
---

CI now runs an external-consumer API-surface compatibility check (`test:api-surface`) that compares the current `etc/*.api.md` snapshots against the last published tag and fails on a breaking change reachable by an external consumer: a required member added to a contravariantly-reachable type, any member removed, or an optional member tightened to required. The checker script itself is never published (it is absent from `package.json`'s `files` array) and changes no runtime behavior, exported type, or module a consumer can import, so it ships as a patch rather than a minor.
