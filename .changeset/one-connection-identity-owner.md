---
"@nicia-ai/typegraph": patch
---

The serialized-resource audit and the native-transaction record now ask one internal function which connection a backend's handle runs on. Before, a SQLite or PostgreSQL backend whose connection was known only from a `serializedResource: { mode: "shared", resource }` declaration (for example two `sqlite-proxy` wrappers naming one resource) was one connection to the audit and a separate connection per wrapper to the native-transaction record. No decision read the record's connection for such a driver, so no import, export or transaction outcome changes; the two consumers can no longer disagree. Naming the same connection is still not evidence of the same transaction: state is shared between Store sessions only on proof of one native transaction.
