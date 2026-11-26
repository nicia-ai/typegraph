/**
 * A SQLite transaction the engine ended before its boundary, on the driver
 * shapes the shared integration lanes do not run.
 *
 * A failing statement can end a SQLite transaction in the engine itself (a
 * trigger's `RAISE(ROLLBACK)`); a statement that reaches the connection
 * afterwards runs in autocommit. The transaction's view must observe the end
 * before any later statement reaches the driver: a sibling submitted in the
 * same turn as the failing statement included, and on a driver whose own
 * transaction flag does not report the engine's state.
 */
import type { Client } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import { createLibsqlBackend } from "../../../src/backend/sqlite/libsql";
import type {
  GraphBackend,
  InsertNodeParams,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";
import {
  createRemoteLibsqlDouble,
  type RemoteLibsqlDouble,
} from "../../helpers/remote-libsql-double";
import {
  cleanupTemporaryFiles,
  createTemporaryDbPath,
} from "./libsql-temporary-database";

afterEach(cleanupTemporaryFiles);

const GRAPH_ID = "engine_end";
const ROLLBACK_ID = "engine-rollback";

function nodeRow(id: string): InsertNodeParams {
  return { graphId: GRAPH_ID, kind: "Item", id, props: { label: id } };
}

/** A failure as its error class, or `"untyped driver error"`. */
function outcomeOf(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => "fulfilled",
    (error: unknown) =>
      error instanceof TypeGraphError ? error.name : "untyped driver error",
  );
}

/** Makes inserting node {@link ROLLBACK_ID} end its transaction in the engine. */
async function installRollbackTrigger(backend: GraphBackend): Promise<void> {
  const nodes = requireDefined(backend.tableNames).nodes;
  await requireDefined(backend.executeDdl)(
    `CREATE TRIGGER tg_engine_rollback BEFORE INSERT ON "${nodes}"
     WHEN NEW.id = '${ROLLBACK_ID}'
     BEGIN SELECT RAISE(ROLLBACK, 'engine ended the transaction'); END`,
  );
}

async function nodeIds(backend: GraphBackend): Promise<readonly string[]> {
  const rows = await backend.execute<{ id: string }>(
    asCompiledRowsSql(sql`
      SELECT id FROM ${sql.identifier(requireDefined(backend.tableNames).nodes)}
      WHERE graph_id = ${GRAPH_ID} ORDER BY id
    `),
  );
  return rows.map((row) => row.id);
}

/** Runs `run` on a libSQL backend over a remote-client double on a fresh file. */
async function withRemoteBackend(
  run: (backend: GraphBackend, double: RemoteLibsqlDouble) => Promise<void>,
): Promise<void> {
  const double = createRemoteLibsqlDouble(createTemporaryDbPath());
  try {
    const { backend } = await createLibsqlBackend(
      double.client as unknown as Client,
    );
    try {
      await run(backend, double);
    } finally {
      await backend.close();
    }
  } finally {
    double.close();
  }
}

describe("a SQLite transaction the engine ended", () => {
  it("refuses a sibling statement submitted in the same turn as the failure, on an asynchronous profile over a synchronous driver", async () => {
    const backend = createSqliteBackend(drizzle(new Database(":memory:")), {
      executionProfile: { isSync: false, transactionMode: "sql" },
    });
    try {
      await requireDefined(backend.bootstrapTables)();
      await installRollbackTrigger(backend);
      const statements: Record<string, Promise<string>> = {};
      const transaction = await outcomeOf(
        backend.transaction(async (tx) => {
          await tx.insertNode(nodeRow("first"));
          // Both submitted before either settles: the sibling reaches the
          // view while the failure that ended the transaction is unobserved.
          statements["failing"] = outcomeOf(
            tx.insertNode(nodeRow(ROLLBACK_ID)),
          );
          statements["sibling"] = outcomeOf(tx.insertNode(nodeRow("sibling")));
          await Promise.all(Object.values(statements));
        }),
      );
      expect({
        failing: await statements["failing"],
        sibling: await statements["sibling"],
        transaction,
        nodes: await nodeIds(backend),
      }).toEqual({
        failing: "untyped driver error",
        sibling: "TransactionRolledBackError",
        transaction: "TransactionRolledBackError",
        nodes: [],
      });
    } finally {
      await backend.close();
    }
  });

  describe("on a remote libSQL client, whose transaction flag reports its stream", () => {
    it("refuses a write the callback issues after the engine ended its transaction, and saves nothing", async () => {
      await withRemoteBackend(async (backend) => {
        await installRollbackTrigger(backend);
        const statements: Record<string, string> = {};
        const transaction = await outcomeOf(
          backend.transaction(async (tx) => {
            await tx.insertNode(nodeRow("first"));
            // The callback catches the failure and carries on; the stream
            // is still open.
            statements["failing"] = await outcomeOf(
              tx.insertNode(nodeRow(ROLLBACK_ID)),
            );
            statements["later"] = await outcomeOf(
              tx.insertNode(nodeRow("later")),
            );
          }),
        );
        expect({
          ...statements,
          transaction,
          nodes: await nodeIds(backend),
        }).toEqual({
          failing: "untyped driver error",
          later: "TransactionRolledBackError",
          transaction: "TransactionRolledBackError",
          nodes: [],
        });
      });
    });

    it("keeps admitting after a failure that left the transaction open, and commits", async () => {
      await withRemoteBackend(async (backend) => {
        const statements: Record<string, string> = {};
        const transaction = await outcomeOf(
          backend.transaction(async (tx) => {
            await tx.insertNode(nodeRow("first"));
            // A primary-key conflict fails the statement, not the transaction.
            statements["duplicate"] = await outcomeOf(
              tx.insertNode(nodeRow("first")),
            );
            statements["later"] = await outcomeOf(
              tx.insertNode(nodeRow("later")),
            );
          }),
        );
        expect({
          ...statements,
          transaction,
          nodes: await nodeIds(backend),
        }).toEqual({
          duplicate: "DatabaseOperationError",
          later: "fulfilled",
          transaction: "fulfilled",
          nodes: ["first", "later"],
        });
      });
    });

    it("reads contribution markers on the transaction's stream, not on the root before the stream's BEGIN", async () => {
      await withRemoteBackend(async (backend, double) => {
        const markers = requireDefined(
          backend.tableNames?.contributionMaterializations,
        );
        // A fresh backend over the same client: its marker cache is cold.
        const { backend: cold } = await createLibsqlBackend(
          double.client as unknown as Client,
          { schemaProvisioning: "dml-only" },
        );
        try {
          const from = double.trace.length;
          await outcomeOf(
            cold.transaction((tx) =>
              requireDefined(tx.deleteEmbedding)({
                graphId: GRAPH_ID,
                nodeKind: "Doc",
                fieldPath: "embedding",
                nodeId: "d1",
                dimensions: 3,
                metric: "cosine",
                indexType:
                  requireDefined(cold.capabilities.vector).indexTypes[0] ??
                  "none",
              }),
            ),
          );
          const markerReads = double.trace
            .slice(from)
            .filter((entry) => entry.sql.includes(markers))
            .map((entry) => entry.connection);
          expect(markerReads.length).toBeGreaterThan(0);
          expect(new Set(markerReads)).toEqual(
            new Set(markerReads.filter((each) => each.startsWith("stream"))),
          );
        } finally {
          await cold.close();
        }
      });
    });
  });
});
