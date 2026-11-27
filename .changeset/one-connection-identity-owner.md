---
"@nicia-ai/typegraph": patch
---

The serialized-resource audit and the native-transaction record now get their answer to which connection a backend's handle runs on from one internal function. Before, a SQLite or PostgreSQL backend whose connection was known only from a `serializedResource: { mode: "shared", resource }` declaration (for example two `sqlite-proxy` wrappers naming one resource) was one connection to the audit but a separate connection per wrapper to the native-transaction record. Both now name the declared resource. Imports, exports and transactions behave as before. Naming the same connection is still not evidence of the same transaction. A connection known only from a declaration can never join a Store session to a transaction another backend opened on that connection, because a declaration is the caller's claim and not something observed on the session.
