/**
 * A vector slot's marker deletion still in flight when a better-sqlite3
 * transaction callback returns.
 *
 * `deleteSchemaVectorSlotContribution` deletes one marker row per contribution
 * the strategy owns, one statement each, and evicts the slot from the marker
 * cache after the last one. A deletion the callback started without awaiting
 * is still between two of those statements when the callback returns. The
 * transaction's view closes at the boundary, so the statements after it are
 * refused: the first delete commits, the rest never run, and the eviction is
 * skipped, leaving the root's cache authorising a slot whose marker is gone.
 * Main ran the rest of the deletion after `COMMIT`, in autocommit.
 *
 * Draining a call admitted before the boundary as a whole (rather than each
 * statement on its own) is the session lifecycle's work. The case is pinned
 * at today's value (`correct` states the outcome that work must reach).
 *
 * better-sqlite3-specific wiring: a strategy with two contributions and a
 * driver-level statement trace.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { describe, expect, it } from "vitest";

import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import type {
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { TypeGraphError } from "../../../src/errors";
import { sqliteVecStrategy } from "../../../src/query/dialect/vector/sqlite-vec-strategy";
import type {
  VectorSlot,
  VectorStrategy,
} from "../../../src/query/dialect/vector-strategy";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";

const GRAPH_ID = "callback_exit_marker";

const SLOT = {
  graphId: GRAPH_ID,
  nodeKind: "Doc",
  fieldPath: "embedding",
  dimensions: 3,
  metric: "cosine",
  indexType: "none",
} as const;

/**
 * sqlite-vec's storage plus a second contribution of its own, so a slot's
 * deletion is two statements.
 */
const TWO_CONTRIBUTION_STRATEGY: VectorStrategy = {
  ...sqliteVecStrategy,
  ownedTables(slot) {
    const [storage] = sqliteVecStrategy.ownedTables(slot);
    const primary = requireDefined(storage);
    const companionTable = `${primary.tableName}_companion`;
    return [
      primary,
      {
        ...primary,
        logicalName: `${primary.logicalName}:companion`,
        tableName: companionTable,
        createDdl: [
          `CREATE TABLE IF NOT EXISTS "${companionTable}" (node_id TEXT PRIMARY KEY)`,
        ],
      },
    ];
  },
};

function loadSqliteVec(database: Database.Database): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqliteVec = require("sqlite-vec") as {
    load: (db: Database.Database) => void;
  };
  sqliteVec.load(database);
}

/** A failure as its error class, or `"untyped driver error"`. */
function outcomeOf(pending: Promise<unknown>): Promise<string> {
  return pending.then(
    () => "fulfilled",
    (error: unknown) =>
      error instanceof TypeGraphError ? error.name : "untyped driver error",
  );
}

/** The member a transaction backend deletes a slot's marker with. */
function deletingSlot(backend: TransactionBackend): Readonly<{
  deleteSchemaVectorSlotContribution: (slot: VectorSlot) => Promise<void>;
}> {
  return backend as unknown as Readonly<{
    deleteSchemaVectorSlotContribution: (slot: VectorSlot) => Promise<void>;
  }>;
}

/** The trace's transaction boundaries and marker deletions, in order. */
function boundariesAndDeletes(statements: readonly string[]): string[] {
  return statements.flatMap((statement) => {
    const text = statement.trim().replaceAll(/\s+/g, " ");
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(text)) {
      return [text.split(" ")[0]?.toUpperCase() ?? text];
    }
    if (/^delete from "typegraph_contribution_materializations"/i.test(text)) {
      return ["DELETE marker"];
    }
    return [];
  });
}

async function markerCount(backend: GraphBackend): Promise<number> {
  let count = 0;
  for (const contribution of TWO_CONTRIBUTION_STRATEGY.ownedTables(SLOT)) {
    const marker = await requireDefined(backend.getContributionMaterialization)(
      {
        graphId: GRAPH_ID,
        logicalName: contribution.logicalName,
        owner: contribution.owner,
        tableName: contribution.tableName,
      },
    );
    if (marker !== undefined) count += 1;
  }
  return count;
}

describe("a vector slot's marker deletion in flight when a better-sqlite3 transaction callback returns (known defect)", () => {
  it("deletes every marker inside the transaction, and the root stops authorising the slot", async () => {
    const statements: string[] = [];
    const database = new Database(":memory:", {
      verbose: (message) => {
        statements.push(String(message));
      },
    });
    loadSqliteVec(database);
    const backend = createSqliteBackend(drizzle(database), {
      executionProfile: { isSync: true },
      vector: TWO_CONTRIBUTION_STRATEGY,
    });
    try {
      await requireDefined(backend.bootstrapTables)();
      await requireDefined(backend.createVectorIndex)(SLOT);
      const embedding = { ...SLOT, nodeId: "d1" };
      const deleteEmbedding = requireDefined(backend.deleteEmbedding);
      // The root confirms both markers, and caches the confirmation.
      expect(await outcomeOf(deleteEmbedding(embedding))).toBe("fulfilled");

      statements.length = 0;
      let deletion: Promise<string> | undefined;
      const transaction = await outcomeOf(
        backend.transaction((tx) => {
          deletion = outcomeOf(
            deletingSlot(tx).deleteSchemaVectorSlotContribution(SLOT),
          );
          return Promise.resolve();
        }),
      );
      const deletionOutcome = await requireDefined(deletion);
      const trace = boundariesAndDeletes(statements);
      expectObservation({
        lane: { driver: "better-sqlite3" },
        observed: {
          transaction,
          deletion: deletionOutcome,
          trace,
          markers: await markerCount(backend),
          rootAfter: await outcomeOf(deleteEmbedding(embedding)),
        },
        correct: {
          transaction: "fulfilled",
          deletion: "fulfilled",
          trace: ["BEGIN", "DELETE marker", "DELETE marker", "COMMIT"],
          markers: 0,
          rootAfter: "StoreNotInitializedError",
        },
        defects: [
          {
            label:
              "session lifecycle: a call in flight at callback exit is cut at the statement boundary",
            on: { driver: ["better-sqlite3"] },
            today: {
              transaction: "fulfilled",
              deletion: "TransactionClosedError",
              trace: ["BEGIN", "DELETE marker", "COMMIT"],
              markers: 1,
              rootAfter: "fulfilled",
            },
          },
        ],
      });
    } finally {
      await backend.close();
      database.close();
    }
  });
});
