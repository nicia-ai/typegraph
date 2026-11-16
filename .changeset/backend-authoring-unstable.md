---
"@nicia-ai/typegraph": patch
---

The backend authoring surface, everything exported from `@nicia-ai/typegraph/backend` and `@nicia-ai/typegraph/adapters/drizzle/engine`, is now documented as not covered by semver: it may change in any release, including a patch release, without a deprecation period. The bundled SQLite and PostgreSQL backends are the supported ones, and the application API keeps its semver guarantees. No code changes. See [Stability](https://typegraph.dev/backend-authoring#stability).
