---
"@nicia-ai/typegraph": patch
---

An aggregate query, and any relation (`asRelation()`, derived relations, a bound prepared relation), now runs in `store.batch()` and on a transaction passed to `executeOn()`. Both entry points accepted these reads by type and then refused them with `ConfigurationError: A relation cannot execute on a different database or transaction target.` That refusal is removed: `executeOn(target)` now runs on the target it is given for every read terminal, as selects, projections and set operations already did. Passing a target of another database is the caller's error and is not detected; the read runs on that database.
