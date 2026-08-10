/**
 * The pg_trgm prerequisite is database-global, unlike the per-index build
 * claims held by materializeIndexes. Verify the PostgreSQL backend fences the
 * extension install on one transaction-bound connection without a live server.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { type AnyPgDatabase } from "../src/backend/drizzle/execution/postgres-execution";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { type GraphBackend } from "../src/backend/types";
import { defineGraph } from "../src/core/define-graph";
import { defineNode } from "../src/core/node";
import { defineNodeIndex } from "../src/indexes";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

function statementText(statement: unknown): string {
  const chunks =
    (statement as { queryChunks?: readonly unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : String(value ?? chunk);
    })
    .join("");
}

function stubTransactionalDatabase(): Readonly<{
  db: AnyPgDatabase;
  statements: readonly string[];
}> {
  const statements: string[] = [];
  const transaction = {
    execute(
      statement: unknown,
    ): Promise<Readonly<{ rows: readonly unknown[] }>> {
      statements.push(statementText(statement));
      return Promise.resolve({ rows: [] });
    },
  };
  const db = {
    $client: { query: () => Promise.resolve({ rows: [] }) },
    transaction<T>(fn: (tx: typeof transaction) => Promise<T>): Promise<T> {
      return fn(transaction);
    },
  } as unknown as AnyPgDatabase;
  return { db, statements };
}

function duplicateKeyError(): Error {
  return Object.assign(new Error("duplicate extension catalog row"), {
    code: "23505",
  });
}

const Document = defineNode("Document", {
  schema: z.object({ title: z.string() }),
});

function trigramGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Document: { type: Document } },
    edges: {},
    indexes: [
      defineNodeIndex(Document, { fields: ["title"], method: "trigram" }),
    ],
  });
}

async function initializedCustomPostgresBackend(
  graph: ReturnType<typeof trigramGraph>,
  overlay: Partial<GraphBackend>,
): Promise<GraphBackend> {
  const baseBackend = createTestBackend();
  await createStoreWithSchema(graph, baseBackend);
  return {
    ...baseBackend,
    ...overlay,
    dialect: "postgres",
    execute<T>(): Promise<readonly T[]> {
      return Promise.resolve([]);
    },
  };
}

describe("Postgres pg_trgm extension prerequisite", () => {
  it("takes a constant transaction advisory lock before installing the extension", async () => {
    const { db, statements } = stubTransactionalDatabase();
    const backend = createPostgresBackend(db, { vector: false });

    await requireDefined(backend.ensureTrigramExtension)();

    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("pg_advisory_xact_lock");
    expect(statements[0]).toContain("typegraph:pg-trgm-ddl");
    expect(statements[1]).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");
  });

  it("retries a concurrent extension catalog race without transaction support", async () => {
    const statements: string[] = [];
    const db = {
      $client: { query: () => Promise.resolve({ rows: [] }) },
      execute(
        statement: unknown,
      ): Promise<Readonly<{ rows: readonly unknown[] }>> {
        statements.push(statementText(statement));
        if (statements.length === 1) return Promise.reject(duplicateKeyError());
        return Promise.resolve({ rows: [] });
      },
    } as unknown as AnyPgDatabase;
    const backend = createPostgresBackend(db, {
      capabilities: { transactions: false },
      vector: false,
    });

    await requireDefined(backend.ensureTrigramExtension)();

    expect(statements).toHaveLength(2);
    expect(new Set(statements)).toEqual(
      new Set(["CREATE EXTENSION IF NOT EXISTS pg_trgm;"]),
    );
  });

  it("materializes through a custom prerequisite hook before index DDL", async () => {
    const graph = trigramGraph("trigram_custom_hook");
    const events: string[] = [];
    const backend = await initializedCustomPostgresBackend(graph, {
      ensureTrigramExtension(): Promise<void> {
        events.push("ensure pg_trgm");
        return Promise.resolve();
      },
      executeDdl(statement): Promise<void> {
        events.push(statement);
        return Promise.resolve();
      },
    });
    const store = createStore(graph, backend);

    const result = await store.materializeIndexes({
      refreshStatistics: false,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ status: "created" }),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0]).toBe("ensure pg_trgm");
    expect(events[1]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
  });

  it("retries a custom backend's extension 23505 before materializing its index", async () => {
    const graph = trigramGraph("trigram_custom_retry");
    const events: string[] = [];
    let extensionAttempts = 0;
    const backend = await initializedCustomPostgresBackend(graph, {
      executeDdl(statement): Promise<void> {
        events.push(statement);
        if (statement.includes("CREATE EXTENSION")) {
          extensionAttempts += 1;
          if (extensionAttempts === 1) {
            return Promise.reject(duplicateKeyError());
          }
        }
        return Promise.resolve();
      },
    });
    const store = createStore(graph, backend);

    const result = await store.materializeIndexes({
      refreshStatistics: false,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ status: "created" }),
    ]);
    expect(events).toHaveLength(3);
    expect(events[0]).toBe("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(events[1]).toBe("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    expect(events[2]).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
  });
});
