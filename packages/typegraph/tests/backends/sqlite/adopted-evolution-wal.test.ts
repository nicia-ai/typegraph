import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "vitest";

import { createSqliteTables } from "../../../src/backend/drizzle/schema/sqlite";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { assertAdoptedEvolutionVisibility } from "../integration/adopted-evolution-visibility";

it("keeps adopted changes atomic across independent SQLite WAL connections with custom tables", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "typegraph-evolution-wal-"),
  );
  const databasePath = path.join(directory, "graph.db");
  const tables = createSqliteTables({
    nodes: "application_nodes",
    edges: "application_edges",
    schemaVersions: "application_schema_versions",
  });
  const writer = createLocalSqliteBackend({ path: databasePath, tables });
  const reader = createLocalSqliteBackend({ path: databasePath, tables });
  try {
    await assertAdoptedEvolutionVisibility(writer.backend, reader.backend);
  } finally {
    await writer.backend.close();
    await reader.backend.close();
    await rm(directory, { recursive: true, force: true });
  }
});
