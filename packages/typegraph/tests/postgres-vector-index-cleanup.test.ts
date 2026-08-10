/**
 * Failure precedence for the durable parallel_workers override used by the
 * PostgreSQL vector-index serial retry. No server is needed: the execution
 * seam forces each build/reset outcome directly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVectorParallelWorkerResetTracker,
  runSerialVectorIndexBuild,
  runVectorIndexBuildWithPendingResetRepair,
} from "../src/backend/drizzle/postgres";
import { sql } from "../src/query/sql-fragment";

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

  it("repairs a pending RESET before an IF NOT EXISTS retry can report success", async () => {
    const tracker = createVectorParallelWorkerResetTracker();
    const firstResetError = new Error("parallel_workers reset failed");
    let resetAttempts = 0;
    const firstExecute = vi.fn(
      executionStub((text) => {
        if (text.includes("RESET")) {
          resetAttempts += 1;
          throw firstResetError;
        }
      }),
    );

    await expect(
      runSerialVectorIndexBuild(
        firstExecute,
        "typegraph_vector_slot",
        sql`CREATE INDEX IF NOT EXISTS vector_index`,
        () => {
          tracker.markPending("typegraph_vector_slot");
        },
      ),
    ).rejects.toMatchObject({ cause: firstResetError });

    const retryStatements: string[] = [];
    const retryExecute = vi.fn(
      executionStub((text) => {
        retryStatements.push(text);
      }),
    );
    await runVectorIndexBuildWithPendingResetRepair(
      tracker,
      retryExecute,
      "typegraph_vector_slot",
      sql`CREATE INDEX IF NOT EXISTS vector_index`,
    );

    expect(resetAttempts).toBe(1);
    expect(retryStatements).toEqual([
      expect.stringContaining("RESET (parallel_workers)"),
      expect.stringContaining("CREATE INDEX IF NOT EXISTS"),
    ]);
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
