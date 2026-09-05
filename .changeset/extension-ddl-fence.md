---
"@nicia-ai/typegraph": patch
---

The PostgreSQL backend's database-extension install now resolves the write-fence plan and spells its advisory lock through the backend's `fenceSql`, like every other lock site, instead of hardcoding `pg_advisory_xact_lock(hashtext(...), 0)` inline. A custom or derived PostgreSQL profile whose resolved plan is `engine-serialized` or `unfenced` installs extensions without taking that lock and relies solely on the duplicate-key retry, which was already the fence's correctness owner in that case. The bundled PostgreSQL backend's behavior and emitted SQL are unchanged.
