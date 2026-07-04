---
"@nicia-ai/typegraph": patch
---

perf: facade search candidate handling planned poorly at scale. The hybrid statement's fused CTE is now MATERIALIZED (PostgreSQL inlines single-use CTEs, re-executing the fusion subtree once per candidate node row under a nested-loop join), and unfiltered facade searches use a flat, parameter-bound current-read candidates subquery instead of a compiled builder query whose per-row SQL clock calls dominated on SQLite. Semantics are unchanged — validity windows and tombstones are still enforced, with the instant bound as a parameter. Filtered searches (`where` / `includeSubClasses`) keep the compiled form.
