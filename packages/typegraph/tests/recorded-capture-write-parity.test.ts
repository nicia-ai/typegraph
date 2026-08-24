import { describe, expect, it } from "vitest";

import {
  batchPointReadVerdict,
  statementExecutionVerdict,
} from "../src/backend/capabilities/resolve";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  createRecordedBackend,
  createRecordedTransactionScope,
  forceRecordedGraphRevision,
  lockRecordedGraphWrite,
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
  runRecordedTransactionSavepoint,
} from "../src/store/recorded-capture";
import { createTestBackend } from "./test-utils";

type MethodBag = Record<string, unknown>;

// A GraphBackend is structurally a TransactionBackend, so the base backend can
// stand in as the scope's transaction target — the resulting wrapper overrides
// the same methods a real transaction target would.
function buildWrappers(): {
  base: MethodBag;
  autocommit: MethodBag;
  transactional: MethodBag;
} {
  const base = createTestBackend();
  const schema = createSqlSchema(base.tableNames);
  return {
    base,
    autocommit: createRecordedBackend(base, schema),
    transactional: createRecordedTransactionScope(
      base,
      batchPointReadVerdict(base),
      schema,
    ).backend,
  };
}

// A method is "wrapped" when the factory replaced the spread-through base
// reference with its own capturing override.
function isWrapped(
  wrapper: MethodBag,
  base: MethodBag,
  method: string,
): boolean {
  if (method === "commands") {
    return (
      typeof wrapper[method] === "object" && wrapper[method] !== base[method]
    );
  }
  return (
    typeof wrapper[method] === "function" && wrapper[method] !== base[method]
  );
}

/**
 * Guardrail for the two recorded-capture factories. They enumerate the same
 * write surface in parallel (delegate-then-touch vs. one captured autocommit
 * transaction per call); a method wired into one but not the other silently
 * bypasses recorded-time capture for that write kind. Rather than collapse the
 * two type-checked factories into an unsafe generic dispatch, this asserts they
 * wrap the identical set of write methods, so the drift fails loudly here.
 */
describe("recorded-capture write-surface parity", () => {
  it("restores pending capture when a TypeGraph savepoint rolls back", async () => {
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;

    await backend.transaction(async (target) => {
      const scope = createRecordedTransactionScope(
        target,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await runRecordedTransactionSavepoint(
        scope.backend,
        statementExecution,
        "typegraph_capture_restore_test",
        async () => {
          await scope.backend.insertNode({
            graphId: "capture_restore",
            kind: "Person",
            id: "rolled-back",
            props: { name: "Rolled back" },
          });
          return {
            action: "rollback",
            value: undefined,
            cause: new Error("expected test rollback"),
          };
        },
      );
      expect(await scope.flush()).toEqual(new Map());
    });

    await expect(
      backend.getNode("capture_restore", "Person", "rolled-back"),
    ).resolves.toBeUndefined();
  });

  it("restores touches and forced revisions when the savepoint callback throws", async () => {
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;

    await backend.transaction(async (target) => {
      const scope = createRecordedTransactionScope(
        target,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await expect(
        runRecordedTransactionSavepoint(
          scope.backend,
          statementExecution,
          "typegraph_capture_throw_test",
          async () => {
            await scope.backend.insertNode({
              graphId: "capture_throw",
              kind: "Person",
              id: "rolled-back",
              props: { name: "Rolled back" },
            });
            expect(
              forceRecordedGraphRevision(scope.backend, "capture_throw"),
            ).toBe(true);
            throw new Error("expected callback failure");
          },
        ),
      ).rejects.toThrow("expected callback failure");
      expect(await scope.flush()).toEqual(new Map());
    });
  });

  it("restores capture after rollback even when savepoint release fails", async () => {
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;

    await backend.transaction(async (target) => {
      const executeStatement = target.executeStatement;
      if (executeStatement === undefined) {
        throw new Error("Expected statement execution on the test target");
      }
      const releaseFailureTarget = deriveBackend(target, {
        async executeStatement(statement): Promise<void> {
          const sql = statement.chunks
            .filter((chunk) => chunk.kind === "text")
            .map((chunk) => chunk.value)
            .join("");
          if (sql.startsWith("RELEASE SAVEPOINT")) {
            throw new Error("injected release failure");
          }
          await executeStatement(statement);
        },
      });
      const scope = createRecordedTransactionScope(
        releaseFailureTarget,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await expect(
        runRecordedTransactionSavepoint(
          scope.backend,
          statementExecution,
          "typegraph_capture_release_test",
          async () => {
            await scope.backend.insertNode({
              graphId: "capture_release",
              kind: "Person",
              id: "rolled-back",
              props: { name: "Rolled back" },
            });
            return {
              action: "rollback",
              value: undefined,
              cause: new Error("expected rollback"),
            };
          },
        ),
      ).rejects.toThrow("Failed to recover a TypeGraph recorded transaction");
      expect(await scope.flush()).toEqual(new Map());
    });
  });

  it("restores the PostgreSQL graph-lock memo after savepoint rollback", async () => {
    const { backend } = await createLocalPgliteBackend({
      vector: false,
    });
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;
    let lockQueryCount = 0;
    try {
      await backend.transaction(async (target) => {
        const execute = target.execute;
        const countedTarget = deriveBackend(target, {
          execute: <T>(query: Parameters<typeof execute<T>>[0]) => {
            const sql = query.chunks
              .filter((chunk) => chunk.kind === "text")
              .map((chunk) => chunk.value)
              .join("");
            if (sql.includes("pg_advisory_xact_lock")) lockQueryCount += 1;
            return execute<T>(query);
          },
        });
        const scope = createRecordedTransactionScope(
          countedTarget,
          batchPointReadVerdict(backend),
          createSqlSchema(backend.tableNames),
        );
        await runRecordedTransactionSavepoint(
          scope.backend,
          statementExecution,
          "typegraph_capture_lock_test",
          async () => {
            await lockRecordedGraphWrite(scope.backend, "capture_lock");
            return {
              action: "rollback",
              value: undefined,
              cause: new Error("expected rollback"),
            };
          },
        );
        await lockRecordedGraphWrite(scope.backend, "capture_lock");
      });
      expect(lockQueryCount).toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("wraps every required write method in both capture factories", () => {
    const { base, autocommit, transactional } = buildWrappers();
    for (const method of RECORDED_REQUIRED_WRITE_METHODS) {
      expect(
        isWrapped(autocommit, base, method),
        `autocommit factory must capture-wrap ${method}`,
      ).toBe(true);
      expect(
        isWrapped(transactional, base, method),
        `transaction factory must capture-wrap ${method}`,
      ).toBe(true);
    }
  });

  it("wraps every optional write method the backend provides in both factories", () => {
    const { base, autocommit, transactional } = buildWrappers();
    for (const method of RECORDED_OPTIONAL_WRITE_METHODS) {
      if (typeof base[method] !== "function") continue;
      expect(
        isWrapped(autocommit, base, method),
        `autocommit factory must capture-wrap optional ${method}`,
      ).toBe(true);
      expect(
        isWrapped(transactional, base, method),
        `transaction factory must capture-wrap optional ${method}`,
      ).toBe(true);
    }
  });

  it("keeps read methods callable through both capture factories", () => {
    const { autocommit, transactional } = buildWrappers();
    for (const method of ["getNode", "getEdge", "getNodes", "getEdges"]) {
      expect(typeof autocommit[method], `${method} must pass through`).toBe(
        "function",
      );
      expect(typeof transactional[method], `${method} must pass through`).toBe(
        "function",
      );
    }
  });

  it("wraps the identical write-method set in both factories (no drift)", () => {
    const { base, autocommit, transactional } = buildWrappers();
    const candidates = [
      ...RECORDED_REQUIRED_WRITE_METHODS,
      ...RECORDED_OPTIONAL_WRITE_METHODS,
    ];
    const autocommitWrapped = candidates.filter((method) =>
      isWrapped(autocommit, base, method),
    );
    const transactionalWrapped = candidates.filter((method) =>
      isWrapped(transactional, base, method),
    );
    expect(autocommitWrapped).toEqual(transactionalWrapped);
  });
});
