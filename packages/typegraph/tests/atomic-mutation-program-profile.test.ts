import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { resolveBundledRootAtomicMutationPrograms } from "../src/backend/capabilities/atomic-mutation-program";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type CommonOperationStrategy,
  createPostgresOperationStrategy,
  createSqliteOperationStrategy,
} from "../src/backend/drizzle/operations/strategy";
import { tables as postgresTables } from "../src/backend/drizzle/schema/postgres";
import { tables as sqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import {
  fts5Strategy,
  tsvectorStrategy,
} from "../src/query/dialect/fulltext-strategy";

type RefusalConstraints = Pick<
  CommonOperationStrategy,
  | "atomicEdgeRefusalConstraints"
  | "atomicMutationPostimageRefusalConstraint"
  | "atomicNodeRefusalConstraints"
>;

function assertRefusalSentinelsAreNotNull(
  strategy: RefusalConstraints,
  tables: readonly Table[],
): void {
  const constraints = [
    strategy.atomicMutationPostimageRefusalConstraint,
    ...Object.values(strategy.atomicEdgeRefusalConstraints),
    ...Object.values(strategy.atomicNodeRefusalConstraints),
  ];
  for (const constraint of constraints) {
    const table = tables.find(
      (candidate) => getTableName(candidate) === constraint.table,
    );
    expect(table, `refusal table ${constraint.table}`).toBeDefined();
    if (table === undefined) continue;
    const column = Object.values(getTableColumns(table)).find(
      (candidate) => candidate.name === constraint.column,
    );
    expect(
      column?.notNull,
      `refusal sentinel ${constraint.table}.${constraint.column}`,
    ).toBe(true);
  }
}

describe("atomic mutation program execution profile", () => {
  it("binds every refusal classifier to a NOT NULL schema column", () => {
    assertRefusalSentinelsAreNotNull(
      createSqliteOperationStrategy(sqliteTables, fts5Strategy),
      [
        sqliteTables.nodes,
        sqliteTables.edges,
        sqliteTables.edgeClaims,
        sqliteTables.schemaVersions,
      ],
    );
    assertRefusalSentinelsAreNotNull(
      createPostgresOperationStrategy(postgresTables, tsvectorStrategy),
      [
        postgresTables.nodes,
        postgresTables.edges,
        postgresTables.edgeClaims,
        postgresTables.schemaVersions,
      ],
    );
  });

  it("registers every semantic program once on the exact bundled root", async () => {
    const temporaryDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-atomic-mutation-profile-"),
    );
    const client = createClient({
      url: `file:${path.join(temporaryDirectory, "graph.db")}`,
    });
    const { backend } = await createLibsqlBackend(client);
    try {
      const profile = resolveBundledRootAtomicMutationPrograms(backend);
      expect(typeof profile?.createNodes).toBe("function");
      expect(typeof profile?.createEdges).toBe("function");
      expect(typeof profile?.deleteNodes).toBe("function");
      expect(typeof profile?.deleteEdges).toBe("function");
      expect(
        resolveBundledRootAtomicMutationPrograms(deriveBackend(backend, {})),
      ).toBeUndefined();
      await backend.transaction((transactionBackend) => {
        expect(
          resolveBundledRootAtomicMutationPrograms(transactionBackend),
        ).toBeUndefined();
        return Promise.resolve();
      });
    } finally {
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
