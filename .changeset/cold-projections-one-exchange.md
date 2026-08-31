---
"@nicia-ai/typegraph": patch
---

Eliminate the cold contribution-marker read before eligible atomic node projection writes. Bundled atomic programs now prove the exact fulltext/vector marker identities and strategy signatures with additional SQL statements inside the same database submission as the row and projection changes; missing, stale, failed, or unmaterialized evidence rolls the whole program back and is diagnosed through the existing typed contribution errors. This keeps projected writes at one mutation exchange even when a Cloudflare Worker constructs a fresh Neon HTTP, D1, or libSQL backend for each request, while retaining the server-side evidence check.
