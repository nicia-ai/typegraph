import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineNode } from "../../../src";
import { generatePostgresDDL } from "../../../src/backend/drizzle/ddl";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { defineNodeIndex, generateIndexDDL } from "../../../src/indexes";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const nameIndex = defineNodeIndex(Person, { fields: ["name"] });

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy index-name boundary",
  () => {
    it("shows why a logical index name cannot be replayed onto two table copies", async () => {
      const firstTable = "working_copy_index_probe_a";
      const secondTable = "working_copy_index_probe_b";
      const firstDdl = generateIndexDDL(nameIndex, "postgres", {
        nodesTableName: firstTable,
      });
      const secondDdl = generateIndexDDL(nameIndex, "postgres", {
        nodesTableName: secondTable,
      });
      const firstBootstrap = generatePostgresDDL(
        createPostgresTables({ nodes: firstTable }, { indexes: [nameIndex] }),
      ).join("\n");
      const secondBootstrap = generatePostgresDDL(
        createPostgresTables({ nodes: secondTable }, { indexes: [nameIndex] }),
      ).join("\n");

      // Bootstrap and runtime DDL both reuse the graph's logical name, even
      // though PostgreSQL index names are global within a schema.
      for (const ddl of [
        firstDdl,
        secondDdl,
        firstBootstrap,
        secondBootstrap,
      ]) {
        expect(ddl).toContain(`"${nameIndex.name}"`);
      }

      const pool = new Pool({ connectionString: TEST_DATABASE_URL });
      try {
        const columns =
          '("graph_id" text NOT NULL, "kind" text NOT NULL, "props" jsonb NOT NULL)';
        await pool.query(`CREATE TABLE "${firstTable}" ${columns}`);
        await pool.query(`CREATE TABLE "${secondTable}" ${columns}`);
        await pool.query(firstDdl);
        await pool.query(secondDdl);

        const indexes = await pool.query<{
          tablename: string;
          indexname: string;
        }>(
          "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1 ORDER BY tablename",
          [nameIndex.name],
        );
        expect(indexes.rows).toEqual([
          { tablename: firstTable, indexname: nameIndex.name },
        ]);
      } finally {
        await pool.end();
      }
    }, 60_000);
  },
);
