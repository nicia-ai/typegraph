import { describe, expect, it } from "vitest";

import {
  batchPointReadVerdict,
  statementExecutionVerdict,
} from "../src/backend/capabilities/resolve";
import { deriveBackend } from "../src/backend/derive-backend";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import {
  type SavepointDecision,
  SavepointRecoveryFailure,
} from "../src/backend/session-savepoint";
import { CompilerInvariantError } from "../src/errors";
import { createSqlSchema } from "../src/query/compiler/schema";
import {
  enterOperation,
  openTransactionSession,
  type OperationBackend,
} from "../src/store/operation-scope";
import {
  createRecordedBackend,
  createRecordedTransactionScope,
  forceRecordedGraphRevision,
  lockRecordedGraphWrite,
  RECORDED_OPTIONAL_WRITE_METHODS,
  RECORDED_REQUIRED_WRITE_METHODS,
  recordedGraphLockMemoOf,
  recordedTransactionControlTarget,
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
  // The root is the stand-in, held as a transaction session's handle.
  const operation = enterOperation(openTransactionSession(base));
  return {
    base,
    autocommit: createRecordedBackend(base, schema),
    transactional: createRecordedTransactionScope(
      operation,
      operation.backend,
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

/** One captured node write, into a graph of its own named `graphId`. */
function insertInto(
  backend: OperationBackend,
  graphId: string,
): Promise<unknown> {
  return backend.insertNode({
    graphId,
    kind: "Person",
    id: graphId,
    props: { name: graphId },
  });
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
  it("keeps an empty direct resolved-update batch as a no-op", async () => {
    const backend = createTestBackend();
    await backend.transaction(async (target) => {
      const captureOperation = enterOperation(openTransactionSession(target));
      const scope = createRecordedTransactionScope(
        captureOperation,
        captureOperation.backend,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await expect(
        scope.backend.updateResolvedNodesBatch?.({ entries: [] }),
      ).resolves.toEqual([]);
      expect(await scope.flush()).toEqual(new Map());
    });
  });

  it("restores pending capture when a TypeGraph savepoint rolls back", async () => {
    const backend = createTestBackend();
    const statementExecution = statementExecutionVerdict(backend);
    expect(statementExecution.supported).toBe(true);
    if (!statementExecution.supported) return;

    await backend.transaction(async (target) => {
      const captureOperation = enterOperation(openTransactionSession(target));
      const scope = createRecordedTransactionScope(
        captureOperation,
        captureOperation.backend,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await runRecordedTransactionSavepoint(
        captureOperation,
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
      const captureOperation = enterOperation(openTransactionSession(target));
      const scope = createRecordedTransactionScope(
        captureOperation,
        captureOperation.backend,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await expect(
        runRecordedTransactionSavepoint(
          captureOperation,
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
              forceRecordedGraphRevision(captureOperation, "capture_throw"),
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
      const captureOperation = enterOperation(
        openTransactionSession(releaseFailureTarget),
      );
      const scope = createRecordedTransactionScope(
        captureOperation,
        captureOperation.backend,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
      );
      await expect(
        runRecordedTransactionSavepoint(
          captureOperation,
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
      ).rejects.toBeInstanceOf(SavepointRecoveryFailure);
      expect(await scope.flush()).toEqual(new Map());
    });
  });

  it("refuses a session whose recorded slot holds a value recorded capture did not bind, instead of reading it as unbound", () => {
    const session = openTransactionSession(createTestBackend());
    const operation = enterOperation(session);
    expect(recordedTransactionControlTarget(operation)).toBe(operation.backend);
    session.recorded.binding = { foreign: true };
    expect(() => recordedTransactionControlTarget(operation)).toThrow(
      CompilerInvariantError,
    );
  });

  describe("a capture scope's savepoint checkpoint", () => {
    // Each write goes to its own graph, so the graphs a flush allocates
    // revisions for are exactly the writes the capture still holds.
    async function capturedGraphs(
      units: (
        capture: OperationBackend,
        unit: (
          savepoint: string,
          fn: () => Promise<SavepointDecision<undefined>>,
        ) => Promise<undefined>,
      ) => Promise<void>,
    ): Promise<readonly string[]> {
      const backend = createTestBackend();
      const statementExecution = statementExecutionVerdict(backend);
      if (!statementExecution.supported)
        throw new Error("Fixture requires statement execution");
      return backend.transaction(async (target) => {
        const captureOperation = enterOperation(openTransactionSession(target));
        const scope = createRecordedTransactionScope(
          captureOperation,
          captureOperation.backend,
          batchPointReadVerdict(backend),
          createSqlSchema(backend.tableNames),
        );
        await units(scope.backend, (savepoint, fn) =>
          runRecordedTransactionSavepoint(
            captureOperation,
            scope.backend,
            statementExecution,
            savepoint,
            fn,
          ),
        );
        const instants = await scope.flush();
        return [...instants.keys()].toSorted();
      });
    }

    const ROLLBACK = {
      action: "rollback",
      value: undefined,
      cause: new Error("expected test rollback"),
    } as const;
    const RELEASE = { action: "release", value: undefined } as const;

    it("keeps what a released unit captured and restores what a rolled-back one did", async () => {
      const graphs = await capturedGraphs(async (capture, unit) => {
        await unit("typegraph_capture_kept", async () => {
          await insertInto(capture, "released_unit");
          return RELEASE;
        });
        await unit("typegraph_capture_dropped", async () => {
          await insertInto(capture, "rolled_back_unit");
          return ROLLBACK;
        });
      });
      expect(graphs).toEqual(["released_unit"]);
    });

    it("restores an inner rolled-back unit inside an outer released one, keeping the outer's own capture", async () => {
      const graphs = await capturedGraphs(async (capture, unit) => {
        await unit("typegraph_capture_outer", async () => {
          await insertInto(capture, "outer_before");
          await unit("typegraph_capture_inner", async () => {
            await insertInto(capture, "inner_rolled_back");
            return ROLLBACK;
          });
          await insertInto(capture, "outer_after");
          return RELEASE;
        });
      });
      expect(graphs).toEqual(["outer_after", "outer_before"]);
    });

    it("restores an inner released unit with the outer unit that rolls back around it", async () => {
      const graphs = await capturedGraphs(async (capture, unit) => {
        await insertInto(capture, "before_units");
        await unit("typegraph_capture_outer", async () => {
          await insertInto(capture, "outer_rolled_back");
          await unit("typegraph_capture_inner", async () => {
            await insertInto(capture, "inner_released");
            return RELEASE;
          });
          return ROLLBACK;
        });
      });
      expect(graphs).toEqual(["before_units"]);
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
        const captureOperation = enterOperation(
          openTransactionSession(countedTarget),
        );
        const scope = createRecordedTransactionScope(
          captureOperation,
          captureOperation.backend,
          batchPointReadVerdict(backend),
          createSqlSchema(backend.tableNames),
        );
        await runRecordedTransactionSavepoint(
          captureOperation,
          scope.backend,
          statementExecution,
          "typegraph_capture_lock_test",
          async () => {
            await lockRecordedGraphWrite(
              scope.backend,
              "capture_lock",
              recordedGraphLockMemoOf(captureOperation),
            );
            return {
              action: "rollback",
              value: undefined,
              cause: new Error("expected rollback"),
            };
          },
        );
        await lockRecordedGraphWrite(
          scope.backend,
          "capture_lock",
          recordedGraphLockMemoOf(captureOperation),
        );
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
