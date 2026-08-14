---
"@nicia-ai/typegraph": minor
---

`drizzle-orm` becomes an optional peer dependency. Affected configuration first: installs whose package manager does not auto-install optional peers must add `drizzle-orm` explicitly to use the Drizzle adapter entrypoints — the ten portable entrypoints (core, schema, indexes, graph-extension, interchange, profiler, graph-merge, provenance, and the root) need no Drizzle at all, which an install-grain fixture now proves by importing and requiring all ten with `drizzle-orm` absent from `node_modules`. The two batteries-included entrypoints (`adapters/drizzle/sqlite/local`, `adapters/drizzle/postgres/pglite`) refuse a missing peer with a typed error naming the failing specifier and the install command, in both module formats; the six pass-in-a-handle adapter entrypoints surface the module-resolution error, documented per entrypoint. A `drizzle-orm`-present-but-broken install is never laundered into the missing-peer refusal.
