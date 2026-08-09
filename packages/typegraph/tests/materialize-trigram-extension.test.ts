/**
 * Which primitive `materializeIndexes` uses to install `pg_trgm` (#446).
 *
 * `gin_trgm_ops` needs the extension, the extension is database-global, and
 * the claim guarding the build is per-index — so two materializers building
 * DIFFERENT trigram indexes both reach `CREATE EXTENSION`, and the loser is
 * handed 23505 rather than a notice. `GraphBackend.ensureExtension` owns that
 * retry; `executeDdl` cannot.
 *
 * The outcome under real contention needs two connections and lives in
 * `tests/backends/postgres/concurrent-trigram-extension.test.ts`. What is
 * pinned HERE is the call site's choice: the seam when the backend has it, and
 * today's bare statement when it does not — because turning a third-party
 * backend's working trigram index into a `skipped` entry would be a
 * regression, not a fence.
 *
 * PGlite carries no contrib extensions, so index DDL is recorded instead of
 * executed. Nothing downstream of `run()` inspects the physical index, so the
 * recorded call sequence is the whole observable difference between the two
 * paths.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode } from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import {
  createBackendOverlay,
  type DatabaseExtensionName,
  type GraphBackend,
} from "../src/backend/types";
import { defineNodeIndex } from "../src/indexes";
import { createStoreWithSchema } from "../src/store";

const Article = defineNode("Article", {
  schema: z.object({ title: z.string() }),
});

const graph = defineGraph({
  id: "trigram_extension_call_site",
  nodes: { Article: { type: Article } },
  edges: {},
  indexes: [
    defineNodeIndex(Article, {
      fields: ["title"],
      method: "trigram",
      name: "idx_trgm_article_title",
    }),
  ],
});

const clients: PGlite[] = [];

afterEach(async () => {
  const pending = clients.splice(0);
  for (const client of pending.toReversed()) await client.close();
});

type RecordedMaterializer = Readonly<{
  backend: GraphBackend;
  ddl: readonly string[];
  extensions: readonly DatabaseExtensionName[];
}>;

/**
 * A real Postgres backend over PGlite whose index DDL is recorded rather than
 * executed. `carriesSeam: false` models a third-party backend written before
 * `ensureExtension` existed.
 */
async function createRecordedMaterializer(
  carriesSeam: boolean,
): Promise<RecordedMaterializer> {
  const client = await PGlite.create();
  clients.push(client);
  await client.exec(generatePostgresDDL().join("\n\n"));

  const ddl: string[] = [];
  const extensions: DatabaseExtensionName[] = [];
  const base = createPostgresBackend(drizzle(client), { vector: false });
  const recorded = createBackendOverlay<GraphBackend>(base, {
    executeDdl: (statement: string) => {
      ddl.push(statement);
      return Promise.resolve();
    },
    ensureExtension: (name: DatabaseExtensionName) => {
      extensions.push(name);
      return Promise.resolve();
    },
  });
  if (carriesSeam) return { backend: recorded, ddl, extensions };

  // A backend written before the seam has the member ABSENT, not
  // undefined-valued — the only shape a third-party port can actually take.
  const { ensureExtension: omittedSeam, ...withoutSeam } = recorded;
  expect(omittedSeam).toBeDefined();
  return { backend: withoutSeam, ddl, extensions };
}

describe("trigram materialization installs pg_trgm through the backend seam", () => {
  it("prefers ensureExtension when the backend implements it", async () => {
    const { backend, ddl, extensions } = await createRecordedMaterializer(true);
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();

    expect(result.results.map((entry) => entry.status)).toEqual(["created"]);
    expect(extensions).toEqual(["pg_trgm"]);
    // The bare statement is gone from this path: leaving it would keep the
    // unretried 23505 that `ensureExtension` exists to absorb.
    expect(
      ddl.filter((statement) => statement.includes("CREATE EXTENSION")),
    ).toEqual([]);
    expect(ddl.some((statement) => statement.includes("gin_trgm_ops"))).toBe(
      true,
    );
  });

  it("falls back to executeDdl on a backend without the seam", async () => {
    const { backend, ddl, extensions } =
      await createRecordedMaterializer(false);
    const [store] = await createStoreWithSchema(graph, backend);

    const result = await store.materializeIndexes();

    // Still materialized — the caller asked for a trigram index and gets one,
    // just without race tolerance.
    expect(result.results.map((entry) => entry.status)).toEqual(["created"]);
    expect(extensions).toEqual([]);
    expect(ddl[0]).toBe("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(ddl.some((statement) => statement.includes("gin_trgm_ops"))).toBe(
      true,
    );
  });
});
