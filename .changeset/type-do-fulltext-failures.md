---
"@nicia-ai/typegraph": patch
---

Translate missing fulltext storage failures from Cloudflare Durable Objects SQLite into `ContributionUnavailableError` while preserving the underlying database error and transactional rollback.
