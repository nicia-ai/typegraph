import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { createClient } from "@libsql/client";
import Database from "better-sqlite3";
import { drizzle as drizzleBetterSqlite3 } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { GraphBackend, ReconciledSchema } from "../src";
import {
  BaseSchemaMigrationError,
  createStoreWithSchema,
  createVerifiedStore,
  defineEdge,
  defineGraph,
  defineNode,
  instantiateGraphTemplate,
  registerGraphTemplate,
} from "../src";
import {
  edgeMatchIdentityPairCheckName,
  edgeMatchIdentityUniqueIndexName,
  generatePostgresDDL,
  generatePostgresMigrationSQL,
  generateSqliteMigrationSQL,
} from "../src/backend/drizzle/ddl";
import {
  createPostgresBackend,
  createPostgresTables,
} from "../src/backend/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import { createSqliteBackend, createSqliteTables } from "../src/backend/sqlite";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import { requireDefined } from "../src/utils/presence";
import { isSqliteMissingEdgeMatchIdentityColumnError } from "../src/utils/sql-errors";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});

const graph = defineGraph({
  id: "base_schema_adoption",
  nodes: { Person: { type: Person } },
  edges: {
    knows: {
      type: knows,
      from: [Person],
      to: [Person],
      matchIdentity: { name: "knows-label", fields: ["label"] },
    },
  },
});

type SqliteClient = Database.Database;

type ProvisionedInstallation = Readonly<{
  backend: GraphBackend;
  close(): Promise<void>;
}>;

const LEGACY_EDGE_TABLE_SQL = `CREATE TABLE "typegraph_edges" (
  "graph_id" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "from_kind" TEXT NOT NULL,
  "from_id" TEXT NOT NULL,
  "to_kind" TEXT NOT NULL,
  "to_id" TEXT NOT NULL,
  "props" TEXT NOT NULL,
  "valid_from" TEXT,
  "valid_to" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "deleted_at" TEXT,
  PRIMARY KEY ("graph_id", "id")
);`;

function sqliteClient(db: unknown): SqliteClient {
  return (db as { $client: SqliteClient }).$client;
}

function dropLegacySqliteBaseShape(
  client: SqliteClient,
  tableNames: Readonly<{
    edges: string;
    graphTemplates: string;
    baseSchemaVersions: string;
  }>,
): void {
  const edgeTable = tableNames.edges;
  client.exec(`DROP TABLE "${tableNames.graphTemplates}"`);
  client.exec(
    `DROP INDEX IF EXISTS "${edgeMatchIdentityUniqueIndexName(edgeTable)}"`,
  );
  client.exec(`DROP TABLE "${edgeTable}"`);
  client.exec(
    `CREATE TABLE "${edgeTable}" ("graph_id" TEXT NOT NULL, "id" TEXT NOT NULL, "kind" TEXT NOT NULL, "from_kind" TEXT NOT NULL, "from_id" TEXT NOT NULL, "to_kind" TEXT NOT NULL, "to_id" TEXT NOT NULL, "props" TEXT NOT NULL, "valid_from" TEXT, "valid_to" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL, "deleted_at" TEXT, PRIMARY KEY ("graph_id", "id"))`,
  );
  client.exec(`DROP TABLE "${tableNames.baseSchemaVersions}"`);
}

function markerVersion(
  client: SqliteClient,
  tableName: string,
): number | undefined {
  const rows = client
    .prepare(
      `SELECT "version" AS version FROM "${tableName}" WHERE "installation" = 1`,
    )
    .all() as readonly Readonly<{ version: number }>[];
  return rows[0]?.version;
}

async function assertTemplatesWork<G extends typeof graph>(
  backend: GraphBackend,
  store: Readonly<{
    reconciledSchema: ReconciledSchema<G>;
  }>,
): Promise<void> {
  const template = await registerGraphTemplate(backend, {
    templateId: "people-v1",
    reconciled: store.reconciledSchema,
  });
  const instantiated = await instantiateGraphTemplate(backend, {
    template,
    graphId: "base_schema_adoption_target",
  });
  expect(instantiated.status).toBe("ready");
}

async function assertMatchIdentityWrite(backend: GraphBackend): Promise<void> {
  // createStoreWithSchema is privileged, but a current marker makes adoption
  // return before DDL. A false-stamped installation therefore reaches this
  // real edge write unchanged and still fails on its missing physical storage.
  const [store] = await createStoreWithSchema(graph, backend);
  const source = await store.nodes.Person.create({ name: "source" });
  const target = await store.nodes.Person.create({ name: "target" });
  await store.edges.knows.create(source, target, { label: "provisioned" });
}

function reconciledSurface(
  store: unknown,
): Readonly<{ reconciledSchema: ReconciledSchema<typeof graph> }> {
  return store as Readonly<{
    reconciledSchema: ReconciledSchema<typeof graph>;
  }>;
}

function provisionGeneratedSqlite(): Promise<ProvisionedInstallation> {
  const tables = createSqliteTables({
    baseSchemaVersions: "generated_base_schema_versions",
  });
  const client = new Database(":memory:");
  client.exec(generateSqliteMigrationSQL(tables));
  const backend = createSqliteBackend(drizzleBetterSqlite3(client), {
    executionProfile: { isSync: true },
    tables,
  });
  return Promise.resolve({
    backend,
    async close(): Promise<void> {
      await backend.close();
      client.close();
    },
  });
}

async function provisionGeneratedPostgres(): Promise<ProvisionedInstallation> {
  const tables = createPostgresTables({
    baseSchemaVersions: "generated_base_schema_versions",
  });
  const client = await PGlite.create({
    extensions: { vector: pgvectorExtension },
  });
  await client.exec(generatePostgresMigrationSQL(tables));
  const backend = createPostgresBackend(drizzlePglite(client), {
    tables,
    vector: false,
  });
  return {
    backend,
    async close(): Promise<void> {
      await backend.close();
      await client.close();
    },
  };
}

async function provisionVectorlessPglite(): Promise<ProvisionedInstallation> {
  const { backend } = await createLocalPgliteBackend({ vector: false });
  return { backend, close: async () => backend.close() };
}

function provisionLocalSqlite(): Promise<ProvisionedInstallation> {
  const { backend } = createLocalSqliteBackend();
  return Promise.resolve({ backend, close: () => backend.close() });
}

async function provisionLibsql(): Promise<ProvisionedInstallation> {
  const client = createClient({ url: ":memory:" });
  const { backend } = await createLibsqlBackend(client);
  return {
    backend,
    async close(): Promise<void> {
      await backend.close();
      client.close();
    },
  };
}

function provisionLegacyLocalSqlite(): Promise<ProvisionedInstallation> {
  const directory = mkdtempSync(path.join(tmpdir(), "typegraph-base-schema-"));
  const databasePath = path.join(directory, "legacy.sqlite");
  const legacy = new Database(databasePath);
  legacy.exec(LEGACY_EDGE_TABLE_SQL);
  legacy.close();
  try {
    const { backend } = createLocalSqliteBackend({ path: databasePath });
    return Promise.resolve({
      backend,
      async close(): Promise<void> {
        await backend.close();
        rmSync(directory, { force: true, recursive: true });
      },
    });
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

async function provisionLegacyLibsql(): Promise<ProvisionedInstallation> {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(LEGACY_EDGE_TABLE_SQL);
  try {
    const { backend } = await createLibsqlBackend(client);
    return {
      backend,
      async close(): Promise<void> {
        await backend.close();
        client.close();
      },
    };
  } catch (error) {
    client.close();
    throw error;
  }
}

async function provisionLegacySqliteBootstrap(): Promise<ProvisionedInstallation> {
  const client = new Database(":memory:");
  client.exec(LEGACY_EDGE_TABLE_SQL);
  const backend = createSqliteBackend(drizzleBetterSqlite3(client), {
    executionProfile: { isSync: true },
  });
  try {
    await requireDefined(backend.bootstrapTables)();
    return {
      backend,
      async close(): Promise<void> {
        await backend.close();
        client.close();
      },
    };
  } catch (error) {
    await backend.close();
    client.close();
    throw error;
  }
}

async function provisionLegacyPostgresBootstrap(): Promise<ProvisionedInstallation> {
  const client = await PGlite.create();
  await client.exec(LEGACY_EDGE_TABLE_SQL);
  const backend = createPostgresBackend(drizzlePglite(client), {
    vector: false,
  });
  try {
    await requireDefined(backend.bootstrapTables)();
    return {
      backend,
      async close(): Promise<void> {
        await backend.close();
        await client.close();
      },
    };
  } catch (error) {
    await backend.close();
    await client.close();
    throw error;
  }
}

/** Covered complete-installation entry points; bring-your-own factories omit DDL. */
const PROVISIONING_PATHS = [
  {
    id: "generated-postgres-installation",
    provision: provisionGeneratedPostgres,
  },
  { id: "generated-sqlite-installation", provision: provisionGeneratedSqlite },
  { id: "libsql-managed-installation", provision: provisionLibsql },
  {
    id: "local-pglite-vectorless-installation",
    provision: provisionVectorlessPglite,
  },
  { id: "local-sqlite-managed-installation", provision: provisionLocalSqlite },
] as const;

const LEGACY_FACTORY_ADOPTION_PATHS = [
  { id: "libsql-managed-upgrade", provision: provisionLegacyLibsql },
  {
    id: "local-sqlite-managed-upgrade",
    provision: provisionLegacyLocalSqlite,
  },
  {
    id: "postgres-backend-bootstrap-upgrade",
    provision: provisionLegacyPostgresBootstrap,
  },
  {
    id: "sqlite-backend-bootstrap-upgrade",
    provision: provisionLegacySqliteBootstrap,
  },
] as const;

describe("deployment-wide base-schema adoption", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(PROVISIONING_PATHS)(
    "$id satisfies the base-schema gate",
    async ({ provision }) => {
      const installation = await provision();
      try {
        await requireDefined(installation.backend.assertBaseSchemaCurrent)();
        await assertMatchIdentityWrite(installation.backend);
      } finally {
        await installation.close();
      }
    },
  );

  it.each(LEGACY_FACTORY_ADOPTION_PATHS)(
    "$id repairs v0.51 edge storage before completing installation",
    async ({ provision }) => {
      const installation = await provision();
      try {
        await requireDefined(installation.backend.assertBaseSchemaCurrent)();
        await assertMatchIdentityWrite(installation.backend);
      } finally {
        await installation.close();
      }
    },
  );

  it("refuses to false-stamp a legacy SQLite database through fresh-installation SQL", () => {
    const client = new Database(":memory:");
    try {
      client.exec(LEGACY_EDGE_TABLE_SQL);
      let installationError: unknown;
      try {
        client.exec(generateSqliteMigrationSQL());
      } catch (error) {
        installationError = error;
      }
      expect(
        isSqliteMissingEdgeMatchIdentityColumnError(installationError),
      ).toBe(true);
      const markerTable = client
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'typegraph_base_schema_versions'",
        )
        .get();
      const marker =
        markerTable === undefined ? undefined : (
          client
            .prepare(
              'SELECT version FROM "typegraph_base_schema_versions" WHERE installation = 1',
            )
            .get()
        );
      expect(marker).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it("refuses to false-stamp a legacy PostgreSQL database through fresh-installation SQL", async () => {
    const client = await PGlite.create({
      extensions: { vector: pgvectorExtension },
    });
    try {
      await client.exec(LEGACY_EDGE_TABLE_SQL);
      await expect(
        client.exec(generatePostgresMigrationSQL()),
      ).rejects.toMatchObject({ code: "42703" });
      const markerRelation = await client.query<{ exists: boolean }>(
        "SELECT to_regclass('typegraph_base_schema_versions') IS NOT NULL AS exists",
      );
      const markerResult =
        markerRelation.rows[0]?.exists === true ?
          await client.query<{ version: number }>(
            'SELECT version FROM "typegraph_base_schema_versions" WHERE installation = 1',
          )
        : { rows: [] };
      const markerRows = markerResult.rows;
      expect(markerRows).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("re-plans both local SQLite column races before publishing the marker", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "typegraph-base-race-"));
    const databasePath = path.join(directory, "legacy.sqlite");
    const legacy = new Database(databasePath);
    legacy.exec(LEGACY_EDGE_TABLE_SQL);
    legacy.close();
    const competitor = new Database(databasePath);
    // The unbound method is intentional: the spy must invoke the native method
    // against both the factory-owned connection and the competitor connection.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalExec = Database.prototype.exec;
    const racedColumns = new Set<string>();
    const execSpy = vi
      .spyOn(Database.prototype, "exec")
      .mockImplementation(function (
        this: Database.Database,
        source,
      ): Database.Database {
        for (const column of ["match_identity_name", "match_identity_key"]) {
          if (
            racedColumns.has(column) ||
            !source.includes(`ADD COLUMN "${column}"`)
          ) {
            continue;
          }
          const statement = source
            .split(";")
            .find((part) => part.includes(`ADD COLUMN "${column}"`));
          if (statement !== undefined) {
            originalExec.call(competitor, statement);
            racedColumns.add(column);
          }
          break;
        }
        return originalExec.call(this, source);
      });
    try {
      const { backend } = createLocalSqliteBackend({ path: databasePath });
      await backend.close();
      expect([...racedColumns]).toEqual([
        "match_identity_name",
        "match_identity_key",
      ]);
      const marker = competitor
        .prepare(
          'SELECT version FROM "typegraph_base_schema_versions" WHERE installation = 1',
        )
        .get();
      expect(marker).toEqual({ version: 1 });
    } finally {
      execSpy.mockRestore();
      competitor.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("adopts a legacy SQLite installation and registers templates", async () => {
    const tableNames = {
      baseSchemaVersions: "tg_base_schema_versions",
      edges: "tg_edges",
      graphTemplates: "tg_graph_templates",
    } as const;
    const tables = createSqliteTables(tableNames);
    const { backend, db } = createLocalSqliteBackend({ tables });
    const client = sqliteClient(db);
    try {
      await createStoreWithSchema(graph, backend);
      expect(markerVersion(client, tableNames.baseSchemaVersions)).toBe(1);

      dropLegacySqliteBaseShape(client, tableNames);
      const prepareSpy = vi.spyOn(client, "prepare");
      // `prepare` is the driver's DDL boundary; only inspect statements for
      // the relations this adoption owns, so unrelated warm-open probes do
      // not make this test a brittle total-call-count assertion.
      const [reopened] = await createStoreWithSchema(graph, backend);
      expect(markerVersion(client, tableNames.baseSchemaVersions)).toBe(1);
      expect(
        client
          .prepare(`PRAGMA table_info("${tableNames.edges}")`)
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(
        expect.arrayContaining(["match_identity_name", "match_identity_key"]),
      );
      await assertTemplatesWork(backend, reconciledSurface(reopened));
      const adoptionDdl = prepareSpy.mock.calls
        .map(([source]) => source)
        .filter(
          (source) =>
            source.includes(tableNames.baseSchemaVersions) ||
            source.includes(tableNames.graphTemplates) ||
            source.includes("match_identity"),
        );
      expect(
        adoptionDdl.some((statement) => statement.includes("CREATE TABLE")),
      ).toBe(true);

      prepareSpy.mockClear();
      await createStoreWithSchema(graph, backend);
      expect(
        prepareSpy.mock.calls.some(([source]) => {
          const statement = source;
          return (
            (statement.includes(tableNames.baseSchemaVersions) ||
              statement.includes(tableNames.graphTemplates) ||
              statement.includes("match_identity")) &&
            (statement.includes("CREATE TABLE") ||
              statement.includes("ALTER TABLE") ||
              statement.includes("CREATE UNIQUE INDEX"))
          );
        }),
      ).toBe(false);
    } finally {
      await backend.close();
    }
  });

  it("accepts pre-provisioned SQLite identity columns without a pair CHECK", async () => {
    const tableNames = {
      baseSchemaVersions: "tg_base_schema_versions",
      edges: "tg_edges",
      graphTemplates: "tg_graph_templates",
    } as const;
    const tables = createSqliteTables(tableNames);
    const { backend, db } = createLocalSqliteBackend({ tables });
    const client = sqliteClient(db);
    try {
      await createStoreWithSchema(graph, backend);
      client.exec(`DROP TABLE "${tableNames.edges}"`);
      client.exec(
        `CREATE TABLE "${tableNames.edges}" ("graph_id" TEXT NOT NULL, "id" TEXT NOT NULL, "kind" TEXT NOT NULL, "from_kind" TEXT NOT NULL, "from_id" TEXT NOT NULL, "to_kind" TEXT NOT NULL, "to_id" TEXT NOT NULL, "props" TEXT NOT NULL, "match_identity_name" TEXT, "match_identity_key" TEXT, "valid_from" TEXT, "valid_to" TEXT, "created_at" TEXT NOT NULL, "updated_at" TEXT NOT NULL, "deleted_at" TEXT, PRIMARY KEY ("graph_id", "id"))`,
      );
      client.exec(`DROP TABLE "${tableNames.baseSchemaVersions}"`);

      const [reopened] = await createStoreWithSchema(graph, backend);
      expect(markerVersion(client, tableNames.baseSchemaVersions)).toBe(1);
      const indexes = client
        .prepare(`PRAGMA index_list("${tableNames.edges}")`)
        .all() as readonly Readonly<{ name: string }>[];
      expect(indexes.map((index) => index.name)).toContain(
        edgeMatchIdentityUniqueIndexName(tableNames.edges),
      );

      const from = await reopened.nodes.Person.create({ name: "From" });
      const to = await reopened.nodes.Person.create({ name: "To" });
      await expect(
        reopened.edges.knows.create(from, to, { label: "works" }),
      ).resolves.toMatchObject({ label: "works" });
    } finally {
      await backend.close();
    }
  });

  it("adopts a legacy PostgreSQL/PGlite installation and registers templates", async () => {
    const tableNames = {
      baseSchemaVersions: "tg_base_schema_versions",
      edges: "tg_edges",
      graphTemplates: "tg_graph_templates",
    } as const;
    const tables = createPostgresTables(tableNames);
    const client = await PGlite.create();
    await client.exec(generatePostgresDDL(tables).join("\n\n"));
    const backend = createPostgresBackend(drizzlePglite(client), {
      tables,
      vector: false,
    });
    try {
      await createStoreWithSchema(graph, backend);
      await client.exec(
        [
          `DROP TABLE "${tableNames.graphTemplates}"`,
          `DROP INDEX "${edgeMatchIdentityUniqueIndexName(tableNames.edges)}"`,
          `ALTER TABLE "${tableNames.edges}" DROP CONSTRAINT "${edgeMatchIdentityPairCheckName(tableNames.edges)}"`,
          `ALTER TABLE "${tableNames.edges}" DROP COLUMN "match_identity_key"`,
          `ALTER TABLE "${tableNames.edges}" DROP COLUMN "match_identity_name"`,
          `DROP TABLE "${tableNames.baseSchemaVersions}"`,
        ].join(";\n"),
      );

      const [reopened] = await createStoreWithSchema(graph, backend);
      const marker = await client.query<{ version: number }>(
        `SELECT version FROM "${tableNames.baseSchemaVersions}" WHERE installation = 1`,
      );
      expect(marker.rows[0]?.version).toBe(1);
      const columns = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${tableNames.edges}'`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual(
        expect.arrayContaining(["match_identity_name", "match_identity_key"]),
      );
      await assertTemplatesWork(backend, reconciledSurface(reopened));

      await client.exec(
        `UPDATE "${tableNames.baseSchemaVersions}" SET version = 0 WHERE installation = 1`,
      );
      await createStoreWithSchema(graph, backend);
      const advancedMarker = await client.query<{ version: number }>(
        `SELECT version FROM "${tableNames.baseSchemaVersions}" WHERE installation = 1`,
      );
      expect(advancedMarker.rows[0]?.version).toBe(1);

      const querySpy = vi.spyOn(client, "query");
      await createStoreWithSchema(graph, backend);
      expect(
        querySpy.mock.calls.some(([query]) => {
          const statement = query;
          const namesAdoptionStorage =
            statement.includes(tableNames.baseSchemaVersions) ||
            statement.includes(tableNames.graphTemplates) ||
            statement.includes("match_identity");
          return (
            namesAdoptionStorage &&
            /(?:ALTER TABLE|CREATE (?:UNIQUE )?(?:INDEX|TABLE))/i.test(
              statement,
            )
          );
        }),
      ).toBe(false);
    } finally {
      await backend.close();
      await client.close();
    }
  });

  it.each([
    ["missing", undefined],
    ["stale", 0],
    ["newer", 2],
  ] as const)(
    "createVerifiedStore refuses a %s base marker without DDL",
    async (reason, version) => {
      const { backend, db } = createLocalSqliteBackend();
      const client = sqliteClient(db);
      try {
        await createStoreWithSchema(graph, backend);
        if (version === undefined) {
          client.exec("DROP TABLE typegraph_base_schema_versions");
        } else {
          client.exec(
            `UPDATE typegraph_base_schema_versions SET version = ${String(version)} WHERE installation = 1`,
          );
        }
        const prepareSpy = vi.spyOn(client, "prepare");
        const bootstrapSpy = vi.spyOn(backend, "bootstrapTables");
        await expect(createVerifiedStore(graph, backend)).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof BaseSchemaMigrationError &&
            error.code === "BASE_SCHEMA_MIGRATION_REQUIRED" &&
            error.details.reason === reason,
        );
        expect(bootstrapSpy).not.toHaveBeenCalled();
        expect(
          prepareSpy.mock.calls.some(([source]) => {
            const statement = source.trimStart().toUpperCase();
            return (
              statement.startsWith("CREATE ") ||
              statement.startsWith("ALTER ") ||
              statement.startsWith("DROP ")
            );
          }),
        ).toBe(false);
      } finally {
        await backend.close();
      }
    },
  );

  it("stamps the current base version on fresh bootstrap", async () => {
    const { backend, db } = createLocalSqliteBackend();
    try {
      await createStoreWithSchema(graph, backend);
      const rows = (
        db as unknown as {
          $client: Database.Database;
        }
      ).$client
        .prepare(
          `SELECT version FROM typegraph_base_schema_versions WHERE installation = 1`,
        )
        .all() as readonly Readonly<{ version: number }>[];
      expect(rows).toEqual([{ version: 1 }]);
    } finally {
      await backend.close();
    }
  });

  it("refuses to downgrade a newer base marker during bootstrap", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const client = sqliteClient(db);
    try {
      await createStoreWithSchema(graph, backend);
      client.exec(
        "UPDATE typegraph_base_schema_versions SET version = 2 WHERE installation = 1",
      );

      await expect(backend.bootstrapTables?.()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof BaseSchemaMigrationError &&
          error.details.reason === "newer",
      );
      expect(markerVersion(client, "typegraph_base_schema_versions")).toBe(2);
    } finally {
      await backend.close();
    }
  });

  it("keeps and refuses a concurrently published newer marker during bootstrap", async () => {
    const { backend, db } = createLocalSqliteBackend();
    const client = sqliteClient(db);
    try {
      await createStoreWithSchema(graph, backend);
      client.exec(
        "DELETE FROM typegraph_base_schema_versions WHERE installation = 1",
      );

      const prepare = client.prepare.bind(client);
      let publishedNewerMarker = false;
      vi.spyOn(client, "prepare").mockImplementation((source) => {
        if (!publishedNewerMarker && source.includes("CREATE TABLE")) {
          publishedNewerMarker = true;
          prepare(
            "INSERT INTO typegraph_base_schema_versions (installation, version, updated_at) VALUES (1, 2, CURRENT_TIMESTAMP)",
          ).run();
        }
        return prepare(source);
      });

      await expect(backend.bootstrapTables?.()).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof BaseSchemaMigrationError &&
          error.details.reason === "newer",
      );
      expect(publishedNewerMarker).toBe(true);
      expect(markerVersion(client, "typegraph_base_schema_versions")).toBe(2);
    } finally {
      await backend.close();
    }
  });
});
