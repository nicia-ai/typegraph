/**
 * Exact versions of every engine the SNB comparison lane launches itself.
 *
 * Each container image is pinned by tag AND registry digest, so a re-pushed
 * tag cannot change what a run measures. The digest is the multi-platform
 * index digest the registry returns for the tag (`Docker-Content-Digest` on
 * the manifest request), so the same reference resolves on amd64 and arm64
 * hosts. `@ladybugdb/core` is pinned exactly in `package.json` (and by
 * integrity in `pnpm-lock.yaml`).
 *
 * The image references can still be overridden through the environment for a
 * deliberate experiment. A run records the versions each engine reports at
 * runtime (see `SnbEngineHandle.versions`), so an override is visible in the
 * report rather than mistaken for the pin.
 *
 * Where each pin was confirmed (2026-11-20):
 * - `neo4j:2026.10.2` — Docker Hub `library/neo4j` tag list; newest calendar
 *   release, the tag `latest` currently points at.
 * - Graph Data Science 2026.10.2 — the GDS compatibility matrix
 *   (graphdatascience.ninja/versions.json maps Neo4j 2026.10.2 to GDS
 *   2026.10.2) and the GitHub release asset digest.
 * - `ghcr.io/evokoa/pggraph:1.2.1` — the GHCR tag list and the pgGraph GitHub
 *   releases (1.2.1, 2026-09-23). The image path is the registry location of
 *   the pgGraph image and has to stay as written. The unprefixed tag is the
 *   PostgreSQL 17 build (same digest as `pg17-1.2.1`), the same PostgreSQL
 *   major the 0.1.8 pin used.
 * - `pgvector/pgvector:0.8.7-pg18` — the build the floating `pg18` tag
 *   pointed at (same digest), pinned so the TypeGraph/PostgreSQL side is as
 *   reproducible as its competitors. TypeGraph's PostgreSQL migration enables
 *   the `vector` extension unconditionally, so the image must ship pgvector,
 *   matching the image this repository's CI uses for its PostgreSQL tests.
 */

export const PINNED_POSTGRES_IMAGE =
  "pgvector/pgvector:0.8.7-pg18@sha256:38681dc6eaf55308e2a4c6de392d131652dcfac70e1263e35cd9b5ea3fe39782";

export const PINNED_NEO4J_IMAGE =
  "neo4j:2026.10.2@sha256:88458a76de0704f543bab66b7df1984b36ac3f24de3c2e2d74c8fa1972ebb8cf";

export const PINNED_PGGRAPH_IMAGE =
  "ghcr.io/evokoa/pggraph:1.2.1@sha256:2c85eb0f6b3abe5701edaa9cdb0265da56efd7bbb5202108113d02db8bd6faf5";

/**
 * The Graph Data Science plugin jar mounted into the Neo4j container. Pinned
 * here instead of `NEO4J_PLUGINS=["graph-data-science"]`, which makes the
 * image's entrypoint download whatever build the remote compatibility matrix
 * names at container start.
 */
export const PINNED_NEO4J_GDS_PLUGIN = {
  version: "2026.10.2",
  fileName: "neo4j-graph-data-science-2026.10.2.jar",
  url: "https://github.com/neo4j/graph-data-science/releases/download/2026.10.2/neo4j-graph-data-science-2026.10.2.jar",
  sha256: "0ca621d75f1aab8e492ffa688fa75caee6a9635a1d9a97dec0a6620ab7613332",
} as const;

export const POSTGRES_IMAGE =
  process.env["TYPEGRAPH_BENCH_POSTGRES_IMAGE"] ?? PINNED_POSTGRES_IMAGE;
export const NEO4J_IMAGE =
  process.env["TYPEGRAPH_BENCH_NEO4J_IMAGE"] ?? PINNED_NEO4J_IMAGE;
export const PGGRAPH_IMAGE =
  process.env["TYPEGRAPH_BENCH_PGGRAPH_IMAGE"] ?? PINNED_PGGRAPH_IMAGE;

/**
 * Whether an image reference is reproducible: an explicit tag that is not
 * `latest` plus a `sha256` digest. A tag alone can be re-pushed; a digest
 * alone hides which release it is.
 */
export function isPinnedImageReference(reference: string): boolean {
  const match = /^(?<name>[^@\s]+):(?<tag>[^@:/\s]+)@sha256:[0-9a-f]{64}$/.exec(
    reference,
  );
  const tag = match?.groups?.["tag"];
  return tag !== undefined && tag !== "latest";
}

/**
 * Whether an npm dependency specifier names one exact release (no range,
 * tag, or workspace link).
 */
export function isExactNpmVersion(specifier: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(specifier);
}
