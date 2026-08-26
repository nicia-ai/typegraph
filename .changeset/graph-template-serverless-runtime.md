---
"@nicia-ai/typegraph": minor
---

Make graph-template registration DML-only after normal TypeGraph bootstrap, allow embedding-bearing templates on backends configured with `vector: false`, and clone durable runtime-contribution markers during instantiation so targets can be reopened through verified stores from a later serverless isolate. Vector-enabled backends continue to refuse schema-only templates that would require graph-scoped vector storage.
