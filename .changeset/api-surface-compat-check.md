---
"@nicia-ai/typegraph": patch
---

**For contributors:** CI now compares the public `etc/*.api.md` snapshots with the last published tag through `test:api-surface`. The check fails when an external consumer would lose a member, see an optional member become required, or need to supply a newly required member through a contravariant API position. This adds no runtime or published API; it makes breaking surface changes visible before release. See the [release verification commands](https://github.com/nicia-ai/typegraph/blob/main/docs/RELEASE.md#pre-release-verification).
