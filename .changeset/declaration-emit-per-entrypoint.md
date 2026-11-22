---
"@nicia-ai/typegraph": patch
---

A module that imports a single TypeGraph entrypoint can now export the inferred type of what that entrypoint returns under `declaration: true`.

**The error.** On 0.76.0, a file that imported only the package root and did `export const graph = defineGraph({...})` failed declaration emit with `TS2883: The inferred type of 'graph' cannot be named without a reference to 'IndexDeclaration' from './node_modules/@nicia-ai/typegraph/dist/store-entry.d-<hash>'` (TS2742 on TypeScript 5.9). Libraries and `composite` projects that export graphs, stores, queries, fragments or merge plans hit it, and the same class of error reached every covered subpath: a type an entrypoint's declarations named was often exported only by a different entrypoint, and TypeScript can only name a type through a module already in the consumer's program.

**The fix.** Each entrypoint's declarations now load the public subpaths that export the types they name, through `/// <reference path>` directives the build writes at the top of each entry `.d.ts`. TypeScript then writes those types as `import("@nicia-ai/typegraph/query").…` and so on, never as a `dist/` chunk path. The workaround of adding `import type {} from "@nicia-ai/typegraph/indexes";` (or a type annotation) to the module that exports the graph is no longer needed. The root's export list is unchanged, and no runtime export changed anywhere.

**Newly importable types.** 384 types that public signatures named but no entrypoint exported are now type-only exports of the subpath that owns them: mostly query-builder, expression and fragment helper types on `@nicia-ai/typegraph/query`, store option and collection helper types on `/store`, and graph-definition helpers on `/core`, with a few on `/indexes`, `/graph-merge`, `/provenance`, `/schema`, `/graph-extension`, `/profiler`, `/identity`, `/adapters/drizzle/sqlite` and `/adapters/drizzle/indexes`. They exist so declaration emit can name them; most are not meant to be written by hand.

**Not covered.** Backend values from adapter factories (`createSqliteBackend`, `createLocalSqliteBackend`, `createLibsqlBackend`, `createPostgresBackend`, `createLocalPgliteBackend`) and the vector strategies are typed with backend-authoring contracts that only `@nicia-ai/typegraph/backend` exports. Exporting one with its inferred type still fails declaration emit: export the store built from it, or annotate the backend as `GraphBackend`.
