/**
 * A recorded capture scope flushes into the transaction whose writes it
 * captured, and nowhere else: its flush target is bound when the scope is
 * created, and a target from another transaction is refused there, before any
 * statement.
 */
import { describe, expect, it } from "vitest";

import { batchPointReadVerdict } from "../src/backend/capabilities/resolve";
import type { GraphBackend } from "../src/backend/types";
import { ConfigurationError } from "../src/errors";
import { createSqlSchema } from "../src/query/compiler/schema";
import { sql } from "../src/query/sql-fragment";
import { asCompiledRowsSql } from "../src/query/sql-intent";
import {
  enterOperation,
  openTransactionSession,
} from "../src/store/operation-scope";
import { createRecordedTransactionScope } from "../src/store/recorded-capture";
import { createTestBackend } from "./test-utils";

const GRAPH_ID = "capture_flush_target";

async function recordedNodeCount(backend: GraphBackend): Promise<number> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<Readonly<{ count: number }>>(
    asCompiledRowsSql(
      sql`SELECT COUNT(*) AS count FROM ${schema.recordedNodesTable}`,
    ),
  );
  return Number(rows[0]?.count);
}

describe("recorded capture scope flush target", () => {
  it("refuses a flush target of another transaction before any statement", async () => {
    const captured = createTestBackend();
    const foreign = createTestBackend();
    const rollback = new Error("roll the captured transaction back");
    let refusal: unknown;
    await expect(
      captured.transaction(async (capturedTransaction) => {
        await foreign.transaction(async (foreignTransaction) => {
          try {
            const scope = createRecordedTransactionScope(
              enterOperation(openTransactionSession(foreignTransaction)),
              enterOperation(openTransactionSession(capturedTransaction))
                .backend,
              batchPointReadVerdict(captured),
              createSqlSchema(captured.tableNames),
              false,
            );
            await scope.backend.insertNode({
              graphId: GRAPH_ID,
              kind: "Person",
              id: "captured",
              props: { name: "Captured" },
            });
            await scope.flush();
          } catch (error) {
            refusal = error;
          }
        });
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    // Nothing reached either database: no history row committed into the
    // foreign one while the captured write rolled back.
    await expect(recordedNodeCount(foreign)).resolves.toBe(0);
    expect(refusal).toBeInstanceOf(ConfigurationError);
    await expect(
      captured.getNode(GRAPH_ID, "Person", "captured"),
    ).resolves.toBeUndefined();
  });

  it("flushes through an operation handle of the scope's own transaction", async () => {
    const backend = createTestBackend();
    await backend.transaction(async (transaction) => {
      const session = openTransactionSession(transaction);
      const scope = createRecordedTransactionScope(
        enterOperation(session),
        enterOperation(session).backend,
        batchPointReadVerdict(backend),
        createSqlSchema(backend.tableNames),
        false,
      );
      await scope.backend.insertNode({
        graphId: GRAPH_ID,
        kind: "Person",
        id: "own",
        props: { name: "Own" },
      });
      const instants = await scope.flush();
      expect([...instants.keys()]).toEqual([GRAPH_ID]);
    });
    await expect(recordedNodeCount(backend)).resolves.toBe(1);
  });
});
