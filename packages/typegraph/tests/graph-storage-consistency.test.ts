/**
 * `GraphStorageInspection.consistency` reports what the counting session
 * proved, never what was requested. These cases pin the parts of that decision
 * that do not depend on a PostgreSQL session fact: a backend with no
 * interactive transactions runs each count as its own statement, and fewer than
 * two count statements cannot disagree with each other. The PostgreSQL
 * session-observation half lives in
 * `tests/backends/postgres/graph-storage-consistency.test.ts`.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import {
  countGraphStorage,
  inventoryRelationTargets,
} from "../src/backend/graph-storage";
import type { GraphBackend } from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";

const GRAPH_ID = "storage_consistency";
const OPERATION = "graphStorageConsistencyTest";
const NEVER_PROVISIONED_TABLE = "typegraph_never_provisioned";

describe("graph storage consistency without interactive transactions", () => {
  let sqlite: Database.Database;
  let transactional: GraphBackend;
  let sequential: GraphBackend;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    for (const statement of generateSqliteDDL()) sqlite.exec(statement);
    const db = drizzle(sqlite);
    transactional = createSqliteBackend(db);
    sequential = createSqliteBackend(db, {
      executionProfile: { transactionMode: "none", isSync: true },
    });
  });

  afterEach(() => {
    sqlite.close();
  });

  it("counts each relation by its own statement, so reports per-statement", async () => {
    const targets = inventoryRelationTargets(sequential);
    expect(sequential.capabilities.execution.interactiveTransactions).toBe(
      false,
    );

    const inspection = await countGraphStorage(
      sequential,
      GRAPH_ID,
      targets,
      OPERATION,
    );

    expect(inspection.relations.length).toBeGreaterThan(1);
    expect(inspection.consistency).toBe("per-statement");
  });

  it("reports the same relations as one snapshot inside a SQLite transaction", async () => {
    const inspection = await countGraphStorage(
      transactional,
      GRAPH_ID,
      inventoryRelationTargets(transactional),
      OPERATION,
    );

    expect(inspection.consistency).toBe("snapshot");
  });

  it("reports a snapshot when at most one count statement ran, even without a transaction", async () => {
    const nodes = requireDefined(inventoryRelationTargets(sequential)[0]);
    const ghost = { relation: "ghost", table: NEVER_PROVISIONED_TABLE };

    const single = await countGraphStorage(
      sequential,
      GRAPH_ID,
      [ghost, nodes],
      OPERATION,
    );
    const none = await countGraphStorage(
      sequential,
      GRAPH_ID,
      [ghost],
      OPERATION,
    );

    expect(single.consistency).toBe("snapshot");
    expect(none.consistency).toBe("snapshot");
    expect(none.totalRows).toBe(0);
  });
});
