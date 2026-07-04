/**
 * Inline `approximate: true` queries get the pgvector GUC wrapping.
 *
 * The search facade always applied `hnsw.iterative_scan = strict_order`
 * (pgvector >= 0.8) around ANN statements so a filtered approximate
 * search keeps scanning past the default ef_search frontier instead of
 * starving. Inline `.similarTo(..., { approximate: true })` queries
 * executed through the plain backend.execute path with no GUCs. The
 * compiler now brands statements containing an ANN index scan and the
 * PostgreSQL backend routes them through the same GUC wrapper.
 *
 * Pinned via a pool-connection spy: the branded query executes inside a
 * transaction that sets hnsw.iterative_scan; the non-approximate query
 * issues no set_config at all.
 *
 * Skipped automatically when `POSTGRES_URL` is unset or pgvector < 0.8.
 */
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "../../../src";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let pool: Pool | undefined;
let isPostgresAvailable = false;
let hasIterativeScan = false;

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const candidate = new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  try {
    await candidate.query("SELECT 1");
    await candidate.query(generatePostgresMigrationSQL());
    const version = await candidate.query<{ v: string }>(
      "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
    );
    const [major = 0, minor = 0] = (version.rows[0]?.v ?? "0.0")
      .split(".")
      .map(Number);
    hasIterativeScan = major > 0 || minor >= 8;
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
  schema: z.object({ category: z.string(), embedding: embedding(8) }),
});

type GucCall = Readonly<{ text: string; params: readonly unknown[] }>;

describe("inline approximate queries apply pgvector GUCs", () => {
  it(
    "wraps the branded statement with iterative_scan; exact stays bare",
    { timeout: 30_000 },
    async (ctx) => {
      if (!isPostgresAvailable || !hasIterativeScan) {
        ctx.skip();
        return;
      }
      const spyPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        connectionTimeoutMillis: 5000,
      });
      try {
        const gucCalls: GucCall[] = [];
        const originalConnect = spyPool.connect.bind(spyPool);
        (spyPool as { connect: unknown }).connect = async (
          ...args: unknown[]
        ) => {
          if (args.length > 0) {
            // Callback form (node-postgres internal paths): pass through
            // unspied — the promise form below covers drizzle's usage.
            return (originalConnect as (...a: unknown[]) => unknown)(...args);
          }
          const client = await originalConnect();
          const originalQuery = client.query.bind(client);
          (client as { query: unknown }).query = (
            config: unknown,
            ...rest: unknown[]
          ) => {
            const text =
              typeof config === "string" ? config
              : (
                typeof config === "object" &&
                config !== null &&
                "text" in config
              ) ?
                (config as { text: string }).text
              : "";
            if (text.includes("set_config")) {
              const params =
                ((
                  typeof config === "object" &&
                  config !== null &&
                  "values" in config
                ) ?
                  (config as { values: readonly unknown[] }).values
                : rest[0]) ?? [];
              gucCalls.push({ text, params: params as readonly unknown[] });
            }
            return (originalQuery as (...args: unknown[]) => unknown)(
              config,
              ...rest,
            );
          };
          return client;
        };

        const backend = createPostgresBackend(drizzle(spyPool));
        const graph = defineGraph({
          id: `ann_gucs_${randomUUID().slice(0, 8)}`,
          nodes: { Doc: { type: Document } },
          edges: {},
        });
        const [store] = await createStoreWithSchema(graph, backend);
        for (let index = 0; index < 20; index++) {
          await store.nodes.Doc.create({
            category: `cat-${index % 3}`,
            embedding: Array.from({ length: 8 }, (_, dim) =>
              Math.sin(index + dim),
            ),
          });
        }
        await store.materializeIndexes();
        const queryVector = Array.from({ length: 8 }, (_, dim) =>
          Math.sin(1 + dim),
        );

        function similar(approximate: boolean) {
          return store
            .query()
            .from("Doc", "d")
            .whereNode("d", (document) =>
              document.embedding.similarTo(queryVector, 4, {
                metric: "cosine",
                ...(approximate ? { approximate: true } : {}),
              }),
            )
            .select((ctx2) => ({ id: ctx2.d.id }))
            .execute();
        }

        gucCalls.length = 0;
        await similar(true);
        const iterative = gucCalls.filter(
          (call) => call.params[0] === "hnsw.iterative_scan",
        );
        expect(iterative.length).toBeGreaterThanOrEqual(1);
        expect(iterative[0]?.params[1]).toBe("strict_order");

        gucCalls.length = 0;
        await similar(false);
        expect(gucCalls).toHaveLength(0);

        // Set operations: the combined statement is a fresh SQL object,
        // so operand ANN brands must be merged onto it — a union with
        // an approximate operand still gets the GUC wrap.
        function categoryQuery(category: string) {
          return store
            .query()
            .from("Doc", "d")
            .whereNode("d", (document) => document.category.eq(category))
            .select((ctx2) => ({ id: ctx2.d.id }));
        }
        function annQuery() {
          return store
            .query()
            .from("Doc", "d")
            .whereNode("d", (document) =>
              document.embedding.similarTo(queryVector, 4, {
                metric: "cosine",
                approximate: true,
              }),
            )
            .select((ctx2) => ({ id: ctx2.d.id }));
        }

        gucCalls.length = 0;
        await annQuery().union(categoryQuery("cat-1")).execute();
        expect(
          gucCalls.filter((call) => call.params[0] === "hnsw.iterative_scan"),
        ).not.toHaveLength(0);

        // And a set operation WITHOUT an approximate operand stays bare.
        gucCalls.length = 0;
        await categoryQuery("cat-0").union(categoryQuery("cat-1")).execute();
        expect(gucCalls).toHaveLength(0);
      } finally {
        await spyPool.end();
      }
    },
  );
});
