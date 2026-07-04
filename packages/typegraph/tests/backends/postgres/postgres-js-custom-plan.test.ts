/**
 * Per-call custom-plan opt-out on the postgres-js driver.
 *
 * Statements marked `markForceCustomPlan` (parameter-dependent plans —
 * the subgraph id-array fetches) must never fall onto a prepared
 * generic plan. On node-postgres they execute unnamed; postgres-js
 * prepares internally by default, so its adapter must pass
 * `{ prepare: false }` per call — verified here through a spy on
 * `sql.unsafe` while `store.subgraph()` runs. The recursive traversal
 * (scalar parameters, stable plan) must keep the prepared default.
 *
 * Skipped automatically when `POSTGRES_URL` is unset.
 */
import { randomUUID } from "node:crypto";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
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

const TEST_DATABASE_URL =
  process.env.POSTGRES_URL ??
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

let bootstrap: Sql | undefined;
let isPostgresAvailable = false;

beforeAll(async () => {
  if (!process.env.POSTGRES_URL) return;
  const candidate = postgres(TEST_DATABASE_URL, {
    max: 1,
    connect_timeout: 5,
    onnotice: () => {
      // Silence IF NOT EXISTS notices.
    },
  });
  try {
    await candidate.unsafe("SELECT 1");
    await candidate.unsafe(generatePostgresMigrationSQL());
    bootstrap = candidate;
    isPostgresAvailable = true;
  } catch {
    await candidate.end().catch(() => {
      // Unreachable Postgres degrades to "skip".
    });
  }
});

afterAll(async () => {
  if (bootstrap !== undefined) await bootstrap.end();
});

const Document = defineNode("Doc", {
  schema: z.object({ title: z.string() }),
});
const references = defineEdge("references", { schema: z.object({}) });

describe("postgres-js custom-plan opt-out", () => {
  it("passes prepare:false for the subgraph id-array fetches only", async (ctx) => {
    if (!isPostgresAvailable) {
      ctx.skip();
      return;
    }
    const sql = postgres(TEST_DATABASE_URL, {
      max: 2,
      onnotice: () => {
        // Silence IF NOT EXISTS notices.
      },
    });
    try {
      const calls: {
        text: string;
        prepare: boolean | undefined;
      }[] = [];
      const originalUnsafe = sql.unsafe.bind(sql);
      (sql as { unsafe: unknown }).unsafe = (
        text: string,
        params?: readonly unknown[],
        options?: Readonly<{ prepare?: boolean }>,
      ) => {
        calls.push({ text, prepare: options?.prepare });
        return (
          originalUnsafe as (
            t: string,
            p?: readonly unknown[],
            o?: Readonly<{ prepare?: boolean }>,
          ) => unknown
        )(text, params, options);
      };

      const backend = createPostgresBackend(drizzle(sql));
      const graph = defineGraph({
        id: `pjs_plan_${randomUUID().slice(0, 8)}`,
        nodes: { Doc: { type: Document } },
        edges: {
          references: { type: references, from: [Document], to: [Document] },
        },
      });
      const [store] = await createStoreWithSchema(graph, backend);
      const root = await store.nodes.Doc.create({ title: "root" });
      const child = await store.nodes.Doc.create({ title: "child" });
      await store.edges.references.create(root, child, {});

      calls.length = 0;
      const result = await store.subgraph(root.id, {
        edges: ["references"],
        maxDepth: 2,
      });
      expect(result.nodes.size).toBe(2);

      const fetches = calls.filter((call) => call.text.includes("unnest("));
      expect(fetches.length).toBeGreaterThanOrEqual(2);
      for (const fetch of fetches) {
        expect(fetch.prepare).toBe(false);
      }

      const traversal = calls.filter((call) =>
        call.text.includes("WITH RECURSIVE"),
      );
      expect(traversal).toHaveLength(1);
      expect(traversal[0]?.prepare).toBeUndefined();
    } finally {
      await sql.end();
    }
  });
});
