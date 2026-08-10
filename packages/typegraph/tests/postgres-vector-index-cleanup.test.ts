/**
 * Failure precedence for the durable parallel_workers override used by the
 * PostgreSQL vector-index serial retry. No server is needed: the execution
 * seam forces each build/reset outcome directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  runPostgresVectorIndexBuild,
  runSerialVectorIndexBuild,
  runVectorIndexBuildWithSerialFallback,
} from "../src/backend/drizzle/postgres";
import { type GraphBackend } from "../src/backend/types";
import { defineGraph } from "../src/core/define-graph";
import { embedding } from "../src/core/embedding";
import { defineNode } from "../src/core/node";
import { pgvectorStrategy } from "../src/query/dialect/vector/pgvector-strategy";
import { type VectorStrategy } from "../src/query/dialect/vector-strategy";
import { sql } from "../src/query/sql-fragment";
import { createStore, createStoreWithSchema } from "../src/store/store";
import { createTestBackend } from "./test-utils";

afterEach(() => {
  vi.restoreAllMocks();
});

function statementText(statement: unknown): string {
  const chunks =
    (
      statement as {
        chunks?: readonly unknown[];
        queryChunks?: readonly unknown[];
      }
    ).chunks ??
    (statement as { queryChunks?: readonly unknown[] }).queryChunks ??
    [];
  return chunks
    .map((chunk) => {
      const value = (chunk as { value?: unknown }).value;
      return Array.isArray(value) ? value.join("") : String(value ?? chunk);
    })
    .join("");
}

function executionStub(
  run: (statementText: string) => void,
): (statement: unknown) => Promise<void> {
  return (statement) =>
    Promise.resolve().then(() => {
      run(statementText(statement));
    });
}

function insufficientResourcesError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = "53100";
  return error;
}

describe("Postgres vector-index parallel worker cleanup", () => {
  it("preserves the build failure when RESET also fails and reports repair guidance", async () => {
    const buildError = new Error("serial index build failed");
    const resetError = new Error("parallel_workers reset failed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // Observe the report without writing test output.
    });
    const execute = vi.fn(
      executionStub((text) => {
        if (text.includes("CREATE INDEX")) throw buildError;
        if (text.includes("RESET")) throw resetError;
      }),
    );

    const caught = await runSerialVectorIndexBuild(
      execute,
      "typegraph_vector_slot",
      sql`CREATE INDEX vector_index`,
    ).catch((error: unknown) => error);

    expect(caught).toBe(buildError);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("RESET (parallel_workers)"),
      resetError,
    );
  });

  it("cannot let a failing error reporter displace the build failure", async () => {
    const buildError = new Error("serial index build failed");
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("logger failed");
    });
    const execute = vi.fn(
      executionStub((text) => {
        if (text.includes("CREATE INDEX")) throw buildError;
        if (text.includes("RESET")) throw new Error("reset failed");
      }),
    );

    await expect(
      runSerialVectorIndexBuild(
        execute,
        "typegraph_vector_slot",
        sql`CREATE INDEX vector_index`,
      ),
    ).rejects.toBe(buildError);
  });

  it("absorbs a rejected thenable returned by a hostile error reporter", async () => {
    const buildError = new Error("serial index build failed");
    vi.spyOn(console, "error").mockImplementation((() =>
      Promise.reject(new Error("async logger failed"))) as () => never);
    const execute = vi.fn(
      executionStub((text) => {
        if (text.includes("CREATE INDEX")) throw buildError;
        if (text.includes("RESET")) throw new Error("reset failed");
      }),
    );

    await expect(
      runSerialVectorIndexBuild(
        execute,
        "typegraph_vector_slot",
        sql`CREATE INDEX vector_index`,
      ),
    ).rejects.toBe(buildError);
  });

  it("surfaces exact manual repair guidance when RESET fails after a successful build", async () => {
    const resetError = new Error("parallel_workers reset failed");
    const execute = vi.fn(
      executionStub((text) => {
        if (text.includes("RESET")) throw resetError;
      }),
    );

    const caught = await runSerialVectorIndexBuild(
      execute,
      'typegraph_"vector_slot',
      sql`CREATE INDEX vector_index`,
    ).catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).cause).toBe(resetError);
    expect((caught as Error).message).toContain(
      'ALTER TABLE "typegraph_""vector_slot" RESET (parallel_workers);',
    );
  });

  it("repairs a pending RESET after backend recreation before IF NOT EXISTS can report success", async () => {
    const firstResetError = new Error("parallel_workers reset failed");
    let createAttempts = 0;
    const firstExecute = vi.fn(
      executionStub((text) => {
        if (text.includes("CREATE INDEX")) {
          createAttempts += 1;
          if (createAttempts === 1) {
            throw insufficientResourcesError("parallel build exhausted memory");
          }
        }
        if (text.includes("RESET")) {
          const cleanupAfterSerialBuild = createAttempts === 2;
          if (cleanupAfterSerialBuild) throw firstResetError;
        }
      }),
    );

    await expect(
      runVectorIndexBuildWithSerialFallback(
        firstExecute,
        "typegraph_vector_slot",
        sql`CREATE INDEX IF NOT EXISTS vector_index`,
        sql`DROP INDEX IF EXISTS vector_index`,
      ),
    ).rejects.toMatchObject({ cause: firstResetError });

    // A fresh execution seam represents a recreated backend/process: no
    // in-memory marker survives from the failed attempt above.
    const retryStatements: string[] = [];
    const retryExecute = vi.fn(
      executionStub((text) => {
        retryStatements.push(text);
      }),
    );
    await runVectorIndexBuildWithSerialFallback(
      retryExecute,
      "typegraph_vector_slot",
      sql`CREATE INDEX IF NOT EXISTS vector_index`,
      sql`DROP INDEX IF EXISTS vector_index`,
    );

    expect(retryStatements).toEqual([
      expect.stringContaining("RESET (parallel_workers)"),
      expect.stringContaining("CREATE INDEX IF NOT EXISTS"),
    ]);
  });

  it("does not classify a 53100 cleanup failure as a rebuildable index failure", async () => {
    const cleanupError = insufficientResourcesError("cleanup out of memory");
    const submitted: string[] = [];
    const execute = vi.fn(
      executionStub((text) => {
        submitted.push(text);
        if (text.includes("RESET")) throw cleanupError;
      }),
    );

    await expect(
      runVectorIndexBuildWithSerialFallback(
        execute,
        "typegraph_vector_slot",
        sql`CREATE INDEX IF NOT EXISTS vector_index`,
        sql`DROP INDEX IF EXISTS vector_index`,
      ),
    ).rejects.toMatchObject({ cause: cleanupError });

    expect(submitted).toEqual([
      expect.stringContaining("RESET (parallel_workers)"),
    ]);
  });

  it("materializes a custom strategy without pgvector ALTER, DROP, or serial fallback", async () => {
    const customStrategy = {
      ...pgvectorStrategy,
      name: "custom-postgres-vector",
    } satisfies VectorStrategy;
    const Document = defineNode("Document", {
      schema: z.object({ embedding: embedding(3) }),
    });
    const graph = defineGraph({
      id: "custom_vector_ownership",
      nodes: { Document: { type: Document } },
      edges: {},
    });
    const baseBackend = createTestBackend();
    await createStoreWithSchema(graph, baseBackend);
    const buildError = insufficientResourcesError(
      "custom build exhausted memory",
    );
    const submitted: string[] = [];
    const execute = vi.fn(
      executionStub((text) => {
        submitted.push(text);
        throw buildError;
      }),
    );
    const backend = {
      ...baseBackend,
      dialect: "postgres",
      capabilities: {
        ...baseBackend.capabilities,
        vector: customStrategy.capabilities,
      },
      vectorStrategy: customStrategy,
      execute<T>(): Promise<readonly T[]> {
        return Promise.resolve([]);
      },
      createVectorIndex(): Promise<void> {
        return runPostgresVectorIndexBuild(
          customStrategy,
          execute,
          "custom_owned_vector_slot",
          sql`CREATE INDEX custom_vector_index`,
          sql`DROP INDEX custom_vector_index`,
        );
      },
    } satisfies GraphBackend;
    const store = createStore(graph, backend);

    const result = await store.materializeIndexes({
      refreshStatistics: false,
    });

    expect(result.results).toEqual([
      expect.objectContaining({ status: "failed", error: buildError }),
    ]);
    expect(submitted).toEqual(["CREATE INDEX custom_vector_index"]);
    await baseBackend.close();
  });

  it("restores the setting before rethrowing a build failure", async () => {
    const buildError = new Error("serial index build failed");
    const submitted: string[] = [];
    const execute = vi.fn(
      executionStub((text) => {
        submitted.push(text);
        if (text.includes("CREATE INDEX")) throw buildError;
      }),
    );

    await expect(
      runSerialVectorIndexBuild(
        execute,
        "typegraph_vector_slot",
        sql`CREATE INDEX vector_index`,
      ),
    ).rejects.toBe(buildError);
    expect(submitted).toEqual([
      expect.stringContaining("SET (parallel_workers = 0)"),
      expect.stringContaining("CREATE INDEX"),
      expect.stringContaining("RESET (parallel_workers)"),
    ]);
  });
});
