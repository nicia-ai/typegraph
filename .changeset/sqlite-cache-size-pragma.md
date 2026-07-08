---
"@nicia-ai/typegraph": minor
---

`createLocalSqliteBackend`'s `pragmas` option accepts two new fields:
`cacheSizeKib` (`PRAGMA cache_size`) and `mmapSizeBytes` (`PRAGMA
mmap_size`). Both default to `undefined`, leaving SQLite's own built-in
defaults (a 2MiB page cache, mmap disabled) untouched — existing callers
are unaffected.

SQLite's 2MiB default cache is fine for a small embedded database, but
once a database's working set exceeds it, every page a query touches past
that point pays a fresh disk read instead of a cache hit — including pages
an otherwise fully covering index would have served from cache alone. Set
`cacheSizeKib` (and optionally `mmapSizeBytes`) once a database's working
set is known to exceed the default, the same way you'd size a page cache
for any other embedded or server database engine.
