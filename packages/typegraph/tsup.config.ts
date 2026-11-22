import { defineConfig } from "tsup";

/**
 * The published entrypoints, keyed by their `dist` path. The sole owner of the
 * dist↔src map: `scripts/drizzle-reachability-scan.ts` cross-checks
 * `package.json#exports` against it, and the declaration rollup
 * (`scripts/declaration-rollup.ts`) derives its own entry list from it, so
 * neither can name a different set of roots.
 */
const ENTRY = {
  index: "src/index.ts",
  "backend/index": "src/backend/index.ts",
  "core/index": "src/core/index.ts",
  "interchange/index": "src/interchange/index.ts",
  "profiler/index": "src/profiler/index.ts",
  "schema/index": "src/schema/index.ts",
  "indexes/index": "src/indexes/index.ts",
  "graph-extension/index": "src/graph-extension/index.ts",
  "graph-merge/index": "src/graph-merge/index.ts",
  "provenance/index": "src/provenance/index.ts",
  "store-entry": "src/store-entry.ts",
  "query-entry": "src/query-entry.ts",
  "errors-entry": "src/errors-entry.ts",
  "identity-entry": "src/identity-entry.ts",
  maintenance: "src/maintenance.ts",
  "backend/sqlite/index": "src/backend/sqlite/index.ts",
  "backend/sqlite/local": "src/backend/sqlite/local.ts",
  "backend/sqlite/local-store": "src/backend/sqlite/local-store.ts",
  "backend/sqlite/libsql": "src/backend/sqlite/libsql.ts",
  "backend/drizzle/indexes": "src/backend/drizzle/indexes.ts",
  "backend/postgres/index": "src/backend/postgres/index.ts",
  "backend/postgres/working-copy": "src/backend/postgres/working-copy.ts",
  "backend/postgres/pglite": "src/backend/postgres/pglite.ts",
  "backend/postgres/pglite-store": "src/backend/postgres/pglite-store.ts",
  "backend/drizzle/engine/index": "src/backend/drizzle/engine/index.ts",
} as const;

/**
 * Where `scripts/build.ts` has `tsc` write the declaration tree that the
 * declaration rollup consumes, relative to the package root (which is the build's
 * working directory). Gitignored, and rebuilt by every build.
 *
 * It must NOT live under `node_modules`, even in a cache directory:
 * rollup-plugin-dts resolves imports through `ts.resolveModuleName` and treats
 * everything it reports as an external library import — which is every path
 * under `node_modules` — as external, so a tree emitted there would roll up to
 * bare re-exports of files that do not ship.
 *
 * This module deliberately imports nothing but tsup: it is loaded by
 * `scripts/drizzle-reachability-scan.ts` through a plain `require`, where a
 * relative TypeScript import would not resolve.
 */
export const DECLARATION_EMIT_DIR = ".declaration-emit";

/**
 * The emitted declaration file for an entry's source path. `tsc` mirrors the
 * source tree under the emit directory, so `src/backend/index.ts` becomes
 * `.declaration-emit/backend/index.d.ts`.
 *
 * The sole owner of that mapping: every declaration entry below is derived
 * through it, so the declaration rollup's roots cannot drift from the
 * JavaScript build's.
 */
export function declarationEntryFor(sourcePath: string): string {
  const SOURCE_PREFIX = "src/";
  if (!sourcePath.startsWith(SOURCE_PREFIX)) {
    throw new Error(
      `Declaration entry ${JSON.stringify(sourcePath)} does not start with "${SOURCE_PREFIX}"; the emitted declaration tree mirrors "src" only.`,
    );
  }
  if (!sourcePath.endsWith(".ts")) {
    throw new Error(
      `Declaration entry ${JSON.stringify(sourcePath)} does not end with ".ts".`,
    );
  }
  const withoutSourcePrefix = sourcePath.slice(SOURCE_PREFIX.length);
  const withoutExtension = withoutSourcePrefix.slice(0, -".ts".length);
  return `${DECLARATION_EMIT_DIR}/${withoutExtension}.d.ts`;
}

/**
 * The declaration rollup's roots: the `.d.ts` `scripts/build.ts` emitted for
 * each entry, not the entry's source. Rolling pre-emitted declarations is what
 * keeps the build's peak memory off the ~10 GiB plateau a source-rooted rollup
 * needed — see `scripts/declaration-emit.ts`. `pnpm build` is therefore the
 * supported way to build: a bare `tsup` run has no emit to roll and fails on
 * the unresolved declaration entries rather than shipping stale ones.
 */
export const DECLARATION_ENTRY = Object.fromEntries(
  Object.entries(ENTRY).map(([name, source]) => [
    name,
    declarationEntryFor(source),
  ]),
);

/**
 * Modules both bundles leave as imports, on top of the package's
 * dependencies and peers. The declaration rollup reads the same list.
 */
export const EXTERNAL = [
  "better-sqlite3",
  "@libsql/client",
  "bun:sqlite",
  "pg",
  "@electric-sql/pglite",
  "@electric-sql/pglite-pgvector",
] as const;

/**
 * The JavaScript build. tsup writes no declarations: `scripts/build.ts` runs
 * the declaration rollup (`scripts/declaration-rollup.ts`) itself, because the
 * rollup writes each entry's declaration loads while it generates the bundle
 * and tsup cannot run a plugin inside its declaration worker. The clean
 * therefore spares declaration files: in a watch session tsup re-cleans the
 * output directory on every rebuild, and the declaration rollup owns them.
 */
export default defineConfig({
  entry: ENTRY,
  format: ["esm", "cjs"],
  dts: false,
  splitting: true,
  sourcemap: false,
  clean: ["!**/*.d.{ts,cts,mts}"],
  treeshake: true,
  external: [...EXTERNAL],
});
