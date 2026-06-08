import type { GraphBackend } from "@nicia-ai/typegraph";
import { createLocalPgliteBackend } from "@nicia-ai/typegraph/postgres/pglite";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";

import type { Embedder } from "../../src/graph-merge/types";

/**
 * Dual-backend test fixtures for the graph-merge suite.
 *
 * Both backends run fully in-process: SQLite via better-sqlite3
 * (`createLocalSqliteBackend`) and Postgres via PGlite + pgvector
 * (`createLocalPgliteBackend`). There is NO Docker, NO `POSTGRES_URL`, and no
 * 5432 dependency — `backendMatrix()` returns both backends and both ALWAYS
 * run under plain `pnpm test`.
 */

/**
 * A constructed backend paired with a disposer. Callers MUST invoke `cleanup`
 * (typically in an `afterEach`) so the underlying engine — including PGlite's
 * in-process Postgres — is released.
 */
export type MergeBackendFixture = Readonly<{
  backend: GraphBackend;
  cleanup: () => Promise<void>;
}>;

/**
 * Creates an in-memory SQLite backend fixture.
 */
export function createSqliteMergeBackend(): MergeBackendFixture {
  const { backend } = createLocalSqliteBackend();
  return {
    backend,
    cleanup: async () => {
      await backend.close();
    },
  };
}

/**
 * Creates an in-process PGlite (Postgres + pgvector) backend fixture.
 *
 * `createLocalPgliteBackend` is async because it boots the WASM Postgres
 * engine and loads the pgvector extension before returning a ready backend.
 */
export async function createPgliteMergeBackend(): Promise<MergeBackendFixture> {
  const { backend } = await createLocalPgliteBackend();
  return {
    backend,
    cleanup: async () => {
      await backend.close();
    },
  };
}

/** Fixed alphabet for {@link fakeEmbedder}: a–z plus space (27 dims). */
const EMBEDDER_ALPHABET = "abcdefghijklmnopqrstuvwxyz ";

/** Maps a text to its 27-dim lowercase character-frequency vector. */
function charFrequencyVector(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDER_ALPHABET.length);
  for (const char of text.toLowerCase()) {
    const index = EMBEDDER_ALPHABET.indexOf(char);
    if (index !== -1) {
      vector[index] = (vector[index] ?? 0) + 1;
    }
  }
  return vector;
}

/**
 * A deterministic, OFFLINE stand-in for a real sentence embedder, for exercising
 * the `vector`/`hybrid` plumbing without downloading a model. Each text maps to a
 * 27-dim character-frequency vector, so cosine over the vectors correlates with
 * character overlap: a near-duplicate name ("anna rivera" ≈ "ana rivera") scores
 * far above an unrelated one ("bob lee") — enough to assert RELATIVE behavior and
 * determinism. It is a PURE function of the text, so the merge stays
 * order-independent. NOT a quality model — production injects the real
 * all-MiniLM-L6-v2 embedder from the harness.
 */
export const fakeEmbedder: Embedder = (texts) =>
  Promise.resolve(texts.map((text) => charFrequencyVector(text)));

/**
 * Builds the precomputed `text→vector` lookup `scorePair` reads, from the
 * lowercased field texts, using {@link fakeEmbedder}. Mirrors what `merge()`
 * precomputes, so a unit test can score a `vector`/`hybrid` pair directly.
 */
export async function fakeEmbeddings(
  texts: readonly string[],
): Promise<ReadonlyMap<string, Float32Array>> {
  const keys = texts.map((text) => text.toLowerCase());
  const vectors = await fakeEmbedder(keys);
  const lookup = new Map<string, Float32Array>();
  for (const [index, key] of keys.entries()) lookup.set(key, vectors[index]!);
  return lookup;
}

/**
 * A named backend factory used to parameterize `describe.each` suites.
 */
export type BackendMatrixEntry = Readonly<{
  name: string;
  make: () => Promise<MergeBackendFixture>;
}>;

/**
 * Returns the full dual-backend matrix. Both entries always run — there is no
 * environment gating. SQLite's synchronous factory is wrapped so every entry
 * shares the async `make()` signature.
 */
export function backendMatrix(): readonly BackendMatrixEntry[] {
  return [
    {
      name: "SQLite",
      make: () => Promise.resolve(createSqliteMergeBackend()),
    },
    {
      name: "PGlite",
      make: () => createPgliteMergeBackend(),
    },
  ];
}
