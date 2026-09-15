---
"@nicia-ai/typegraph": minor
---

Add `relation.topPerPartition({ partitionBy, orderBy, limit })` to retrieve up to N rows per parent in one query. Explicit partition keys and ordering select winners independently for each parent, and the result can feed ordered record collections, prepared queries, and batches without losing scalar codecs.

Filters, distinctness, and ranges before the stage select its candidates; filters afterward remove winners without replacement. Include a stable final ordering key for repeatable winners and add relation ordering to control the final result order. Backends must advertise `windowFunctions: true`; unsupported profiles refuse execution before SQL.
