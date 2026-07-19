/**
 * Subgraph shared traversal on Postgres: the recursive BFS closure is
 * computed ONCE and its ids passed to the node and edge fetches as a
 * single text[] parameter, instead of embedding the recursive CTE in
 * both statements (which re-ran the traversal twice per call).
 *
 * Pinned here:
 * 1. Statement shape — exactly one executed statement contains the
 *    recursive traversal; the node/edge fetches semi-join an unnest of
 *    the id-array parameter instead of re-declaring the CTE.
 * 2. Array-literal escaping — user-supplied ids containing quotes,
 *    backslashes, commas, and braces survive the text[] round trip.
 * 3. Plan mode — the id-filtered fetches run as UNNAMED statements.
 *    A named prepared statement flips to a generic (parameter-blind)
 *    plan after five executions, and for an id-array filter whose
 *    cardinality varies per call that plan is catastrophic (measured
 *    21ms -> 310ms on the edge fetch). Unnamed execution re-plans
 *    against the actual array every call.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import type { GraphBackend } from "../../../src/backend/types";

const TEST_DATABASE_URL =
  process.env["POSTGRES_URL"] ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let isPostgresAvailable = false;

function requirePostgres(ctx: { skip: () => void }): Pool {
  if (!isPostgresAvailable || pool === undefined) {
    ctx.skip();
    throw new Error("unreachable");
  }
  return pool;
}

beforeAll(async () => {
  if (!process.env["POSTGRES_URL"]) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(generatePostgresMigrationSQL());
    pool = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (pool !== undefined) await pool.end();
});

const Document = defineNode("Doc", {
  schema: z.object({ title: z.string() }),
});
const references = defineEdge("references", { schema: z.object({}) });

function buildGraph(graphId: string) {
  return defineGraph({
    id: graphId,
    nodes: { Doc: { type: Document } },
    edges: {
      references: { type: references, from: [Document], to: [Document] },
    },
  });
}

/**
 * Wraps GraphBackend.execute to record compiled statement text. The
 * subgraph path executes through backend.execute (adapter prepared
 * path), which the drizzle logger does not see.
 */
function withStatementCapture(backend: GraphBackend): {
  backend: GraphBackend;
  statements: string[];
} {
  const statements: string[] = [];
  const compileSql = backend.compileSql;
  if (compileSql === undefined) {
    throw new Error("Postgres backend must expose compileSql");
  }
  const captured: GraphBackend = {
    ...backend,
    execute: (query) => {
      statements.push(compileSql(query).sql);
      return backend.execute(query);
    },
  };
  return { backend: captured, statements };
}

describe("subgraph shared traversal (Postgres)", () => {
  it("runs the recursive traversal once; fetches filter by id array", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const raw = createPostgresBackend(drizzle(activePool));
    const { backend, statements } = withStatementCapture(raw);
    const [store] = await createStoreWithSchema(
      buildGraph(`subgraph_shape_${randomUUID().slice(0, 8)}`),
      backend,
    );

    const root = await store.nodes.Doc.create({ title: "root" });
    const child = await store.nodes.Doc.create({ title: "child" });
    await store.edges.references.create(root, child, {});

    statements.length = 0;
    const result = await store.subgraph(root.id, {
      edges: ["references"],
      maxDepth: 3,
    });
    expect(result.nodes.size).toBe(2);

    const recursive = statements.filter((statement) =>
      statement.includes("WITH RECURSIVE"),
    );
    expect(recursive).toHaveLength(1);

    const fetches = statements.filter((statement) =>
      statement.includes("unnest("),
    );
    expect(fetches.length).toBeGreaterThanOrEqual(2);
    for (const fetch of fetches) {
      expect(fetch).not.toContain("WITH RECURSIVE");
      expect(fetch).toContain("::text[]");
    }
  });

  it("executes the id-filtered fetches unnamed, keeping custom plans", async (ctx) => {
    requirePostgres(ctx);
    const spyPool = new Pool({
      connectionString: TEST_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    try {
      const submitted: { name: string | undefined; text: string }[] = [];
      const originalQuery = spyPool.query.bind(spyPool);
      (spyPool as { query: unknown }).query = (
        config: unknown,
        ...rest: unknown[]
      ) => {
        if (typeof config === "string") {
          submitted.push({ name: undefined, text: config });
        } else if (
          typeof config === "object" &&
          config !== null &&
          "text" in config
        ) {
          const typed = config as { name?: string; text: string };
          submitted.push({ name: typed.name, text: typed.text });
        }
        return (originalQuery as (...args: unknown[]) => unknown)(
          config,
          ...rest,
        );
      };

      const backend = createPostgresBackend(drizzle(spyPool));
      const [store] = await createStoreWithSchema(
        buildGraph(`subgraph_plan_${randomUUID().slice(0, 8)}`),
        backend,
      );
      const root = await store.nodes.Doc.create({ title: "root" });
      const child = await store.nodes.Doc.create({ title: "child" });
      await store.edges.references.create(root, child, {});

      submitted.length = 0;
      await store.subgraph(root.id, { edges: ["references"], maxDepth: 2 });

      const fetches = submitted.filter((call) => call.text.includes("unnest("));
      expect(fetches.length).toBeGreaterThanOrEqual(2);
      for (const fetch of fetches) {
        expect(fetch.name).toBeUndefined();
      }

      // The traversal itself has scalar parameters and stays on the
      // named prepared path.
      const traversal = submitted.filter((call) =>
        call.text.includes("WITH RECURSIVE"),
      );
      expect(traversal).toHaveLength(1);
      expect(traversal[0]?.name).toBeDefined();
    } finally {
      await spyPool.end();
    }
  });

  it("round-trips hostile user-supplied ids through the array literal", async (ctx) => {
    const activePool = requirePostgres(ctx);
    const backend = createPostgresBackend(drizzle(activePool));
    const [store] = await createStoreWithSchema(
      buildGraph(`subgraph_ids_${randomUUID().slice(0, 8)}`),
      backend,
    );

    const hostileIds = [
      'quote-"-id',
      String.raw`backslash-\-id`,
      "comma-,-id",
      "brace-{}-id",
      String.raw`mixed-\"{,}\\-id`,
    ] as const;

    const root = await store.nodes.Doc.create(
      { title: "root" },
      { id: "hostile-root" },
    );
    for (const id of hostileIds) {
      const node = await store.nodes.Doc.create({ title: id }, { id });
      await store.edges.references.create(root, node, {});
    }

    const result = await store.subgraph(root.id, {
      edges: ["references"],
      maxDepth: 2,
    });

    expect(result.nodes.size).toBe(hostileIds.length + 1);
    for (const id of hostileIds) {
      expect(
        (result.nodes.get(id) as { title?: string } | undefined)?.title,
      ).toBe(id);
    }
    expect(result.adjacency.get(root.id)?.get("references")).toHaveLength(
      hostileIds.length,
    );
  });
});
