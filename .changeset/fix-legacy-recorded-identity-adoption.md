---
"@nicia-ai/typegraph": patch
---

Fix upgrades from older databases that lack recorded identity-assertion storage. Base-schema adoption now creates the missing table and its structural indexes before installing the version-3 changed-since indexes, preserving existing data and honoring custom table names.
