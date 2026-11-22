/**
 * Which package entrypoints semver covers. Semver covers every entrypoint
 * except the backend-authoring ones (README "Stability");
 * `tests/public-type-reachability.test.ts` proves this classification names
 * every `package.json` export exactly once, and the declaration-emit smoke
 * test (`scripts/test-types.ts consumer`) compiles one consumer fixture per
 * covered entrypoint.
 */

/**
 * The semver-covered entrypoints, in the order the README's Stability
 * paragraph lists them. This order is the move map's tie-break: when several
 * covered entrypoints export a moved name, the map names the first one here.
 * The vocabulary subpaths created to own the moved names (`/store`, `/query`,
 * `/errors`, `/identity`, `/maintenance`) come before the older concept
 * subpaths, which come before feature and runtime-specific subpaths, so the
 * earliest exporter is the entrypoint that owns the concept.
 */
export const COVERED_ENTRYPOINTS = [
  ".",
  "./store",
  "./query",
  "./errors",
  "./identity",
  "./maintenance",
  "./core",
  "./schema",
  "./indexes",
  "./graph-extension",
  "./graph-merge",
  "./interchange",
  "./profiler",
  "./provenance",
  "./sqlite/local",
  "./postgres/pglite",
  "./adapters/drizzle/sqlite",
  "./adapters/drizzle/sqlite/local",
  "./adapters/drizzle/sqlite/libsql",
  "./adapters/drizzle/postgres",
  "./adapters/drizzle/postgres/working-copy",
  "./adapters/drizzle/postgres/pglite",
  "./adapters/drizzle/indexes",
] as const;

/** The backend-authoring entrypoints semver does not cover. */
export const AUTHORING_ENTRYPOINTS = [
  "./backend",
  "./adapters/drizzle/engine",
] as const;
