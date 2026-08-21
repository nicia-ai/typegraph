---
"@nicia-ai/typegraph": minor
---

`drizzle-orm` is now optional when using TypeGraph's portable entrypoints. Applications that import only the root, backend, core, schema, indexes, graph-extension, interchange, profiler, graph-merge, or provenance entrypoints no longer need Drizzle installed.

Applications using a managed SQLite or PGlite Store, or an explicit `/adapters/drizzle/...` entrypoint, must still install it with `npm install drizzle-orm` when their package manager does not install optional peers automatically. Managed Store factories report a typed `MISSING_PEER_DEPENDENCY` error with that command; explicit Drizzle adapters retain the runtime's raw module-resolution error. See [Managed Store Entrypoints](https://typegraph.dev/backend-setup#managed-store-entrypoints) and [installation troubleshooting](https://typegraph.dev/troubleshooting#missing-optional-drizzle-orm-peer).
