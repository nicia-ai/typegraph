---
"@nicia-ai/typegraph": patch
---

The published package no longer ships sourcemaps. They were 28.4 MB of the 43.5 MB unpacked package. The packed tarball drops from 9.8 MB to 3.2 MB. The JavaScript no longer carries `sourceMappingURL` comments, so bundlers do not warn about missing maps. No runtime change.
