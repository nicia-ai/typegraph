---
"@nicia-ai/typegraph": minor
---

Support graph-declared PostgreSQL indexes in table-backed working copies with stable allocation-scoped physical names. B-tree, GIN, and trigram indexes retain their logical declaration names and schema hashes while copy allocation, durable reopen, retry, and cleanup use isolated physical indexes.
