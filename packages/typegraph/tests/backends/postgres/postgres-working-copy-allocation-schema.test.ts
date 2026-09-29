/**
 * An allocation lives in one explicit schema. No session's `search_path` decides
 * where its relations are created (by the connected Store or by provisioning)
 * or where they are found for removal. These tests run the connected backend
 * over connections whose `search_path` leads with a different schema, and
 * remove allocations from sessions that do not search the recorded one.
 */
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Client, type ClientConfig, Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  embedding,
  type GraphDef,
  searchable,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import type { AnyPgTransaction } from "../../../src/backend/drizzle/execution";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { bindNamesToAllocationSchema } from "../../../src/backend/drizzle/postgres-allocation-schema";
import {
  createPostgresTables,
  defaultPostgresTableNames,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import type {
  AdapterBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { ConfigurationError } from "../../../src/errors";
import {
  branch,
  branchDurable,
  destroyDurableBranch,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { computeBaseVersion } from "../../../src/graph-merge/base-version";
import { BranchError } from "../../../src/graph-merge/errors";
import { unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { defineNodeIndex } from "../../../src/indexes";
import {
  allocationVectorTablePrefix,
  createPgvectorStrategyForAllocation,
} from "../../../src/query/dialect/vector/pgvector-strategy";
import { renderPostgres } from "../../../src/query/sql-fragment";
import { createStore, createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const LEDGER = "typegraph_working_copy_allocations";
// A schema that leads a skewed connection's search_path, ahead of `public`.
const SKEW_SCHEMA = "alloc_schema_skew";
const MOVED_SCHEMA = "alloc_schema_moved";
const DEPENDENT_SCHEMA = "alloc_schema_dependents";
const DIGEST_LENGTH = 24;
const TABLE_KIND = "r";

const Document = defineNode("Doc", {
  schema: z.object({ name: z.string(), vector: embedding(3) }),
});
const vectorGraph = defineGraph({
  id: "postgres-allocation-schema-vector",
  nodes: { Doc: { type: Document } },
  edges: {},
  indexes: [
    defineNodeIndex(Document, { fields: ["name"], name: "schema_doc_name" }),
  ],
});
const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const personGraph = defineGraph({
  id: "postgres-allocation-schema-person",
  nodes: { Person: { type: Person } },
  edges: {},
});

const Article = defineNode("Article", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});
const articleGraph = defineGraph({
  id: "postgres-allocation-schema-article",
  nodes: { Article: { type: Article } },
  edges: {},
});

type AdoptingBackend = Pick<
  AdapterBackend<AnyPgTransaction>,
  "adoptSchemaWriteTransaction"
>;

type Relation = Readonly<{ schema: string; name: string; kind: string }>;

function digestOf(names: PostgresTableNames): string {
  const start = "tgw_".length;
  return names.nodes.slice(start, start + DIGEST_LENGTH);
}

function physicalPrefixOf(names: PostgresTableNames): string {
  return names.nodes.slice(0, -"nodes".length);
}

/** Every relation, in any schema, whose name carries this allocation's digest. */
async function relationsOf(
  pool: Pool,
  names: PostgresTableNames,
): Promise<readonly Relation[]> {
  const found = await pool.query<Relation>(
    "SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE position($1 in c.relname) > 0 ORDER BY 1, 2",
    [digestOf(names)],
  );
  return found.rows;
}

/** Drops every table of an allocation, wherever it is, leaving nothing behind. */
async function dropAllocationTables(
  pool: Pool,
  names: PostgresTableNames,
): Promise<void> {
  for (const relation of await relationsOf(pool, names)) {
    if (relation.kind !== TABLE_KIND) continue;
    await pool.query(
      `DROP TABLE IF EXISTS "${relation.schema}"."${relation.name}" CASCADE`,
    );
  }
  expect(await relationsOf(pool, names)).toEqual([]);
}

/** Moves every table of an allocation into `schema`. */
async function moveAllocationTables(
  pool: Pool,
  names: PostgresTableNames,
  schema: string,
): Promise<void> {
  for (const relation of await relationsOf(pool, names)) {
    if (relation.kind !== TABLE_KIND) continue;
    await pool.query(
      `ALTER TABLE "${relation.schema}"."${relation.name}" SET SCHEMA ${schema}`,
    );
  }
}

function schemasOf(relations: readonly Relation[]): readonly string[] {
  return [...new Set(relations.map((relation) => relation.schema))];
}

async function ledgerRows(
  pool: Pool,
  names: PostgresTableNames,
): Promise<readonly Readonly<{ schema_name: string | null }>[]> {
  const found = await pool.query<{ schema_name: string | null }>(
    `SELECT schema_name FROM ${LEDGER} WHERE physical_prefix = $1`,
    [physicalPrefixOf(names)],
  );
  return found.rows;
}

async function currentSchema(pool: Pool): Promise<string> {
  const found = await pool.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  );
  return found.rows[0]?.schema ?? "";
}

/** Every connection resolves and creates in the skew schema first. */
function skewedPool(): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    options: `-c search_path=${SKEW_SCHEMA},public`,
  });
}

/** Alternate new connections lead with the skew schema; the rest keep the default. */
function mixedPool(): Readonly<{
  pool: Pool;
  skewedConnections: () => number;
}> {
  let opened = 0;
  let skewed = 0;
  class AlternatingClient extends Client {
    constructor(config?: ClientConfig) {
      opened += 1;
      const skew = opened % 2 === 0;
      if (skew) skewed += 1;
      super(
        skew ?
          { ...config, options: `-c search_path=${SKEW_SCHEMA},public` }
        : config,
      );
    }
  }
  const pool = new Pool({
    connectionString: TEST_DATABASE_URL,
    max: 4,
    Client: AlternatingClient,
  });
  return { pool, skewedConnections: () => skewed };
}

function managerOver<G extends GraphDef>(
  control: Pool,
  connectPool: Pool,
  connectedNames: PostgresTableNames[],
): PostgresWorkingCopyManager<G> {
  return createPostgresWorkingCopyManager<G>({
    control: createPostgresBackend(drizzle(control)),
    connect: (names, allocation) => {
      connectedNames.push(names);
      return Promise.resolve(
        createPostgresBackend(drizzle(connectPool), {
          tables: createPostgresTables(names),
          ...(allocation === undefined ?
            {}
          : { vector: allocation.vectorStrategy }),
        }),
      );
    },
  });
}

function requireNames(
  connectedNames: readonly PostgresTableNames[],
): PostgresTableNames {
  const names = connectedNames[0];
  if (names === undefined) throw new Error("Allocation did not call connect.");
  return names;
}

async function onlyUnsealedId(
  manager: Pick<
    PostgresWorkingCopyManager<GraphDef>,
    "listUnsealedAllocations"
  >,
): Promise<string> {
  const unsealed = await manager.listUnsealedAllocations();
  const [only] = unsealed;
  if (unsealed.length !== 1 || only === undefined) {
    throw new Error(`Expected one live allocation, found ${unsealed.length}.`);
  }
  return only.allocationId;
}

async function abortLeftoverAllocations(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    const manager = managerOver<GraphDef>(pool, pool, []);
    for (const orphan of await manager.listUnsealedAllocations()) {
      await manager.abortAllocation(orphan.allocationId);
    }
  } finally {
    await pool.end();
  }
}

async function prepareDatabase(pool: Pool): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${SKEW_SCHEMA}`);
}

/** Renders a compiled statement, quoting identifiers, so its shape can be asserted. */
function statementText(query: {
  chunks: readonly Readonly<{ kind: string; value?: unknown }>[];
}): string {
  return query.chunks
    .map((chunk) =>
      chunk.kind === "identifier" ? `"${String(chunk.value)}"`
      : typeof chunk.value === "string" ? chunk.value
      : "?",
    )
    .join("");
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

/** The `details.code` of every `ConfigurationError` along an error's cause chain. */
function configurationCodesOf(error: unknown): readonly unknown[] {
  const codes: unknown[] = [];
  for (
    let link: unknown = error;
    link instanceof Error;
    link = (link as { cause?: unknown }).cause
  ) {
    if (link instanceof ConfigurationError) codes.push(link.details["code"]);
  }
  return codes;
}

/** The message of every error along an error's cause chain. */
function messagesOf(error: unknown): readonly string[] {
  const messages: string[] = [];
  for (
    let link: unknown = error;
    link instanceof Error;
    link = (link as { cause?: unknown }).cause
  ) {
    messages.push(link.message);
  }
  return messages;
}

/** Sanity check that the skew is real, so the assertions below are not vacuous. */
async function expectSkewed(pool: Pool): Promise<void> {
  expect(await currentSchema(pool)).toBe(SKEW_SCHEMA);
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy allocation schema",
  () => {
    beforeEach(abortLeftoverAllocations);

    it("creates every lazily created relation in the allocation schema through a connection that leads with another schema", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const [source] = await createStoreWithSchema(
          vectorGraph,
          createPostgresBackend(drizzle(pool)),
          { revisionTracking: true },
        );
        await source.nodes.Doc.create({ name: "source", vector: [1, 2, 3] });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof vectorGraph>(
          pool,
          skewed,
          connectedNames,
        );

        const forked = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("allocation-schema-skewed"),
          }),
        );
        await forked.store.nodes.Doc.create({
          name: "forked",
          vector: [3, 2, 1],
        });
        await forked.store.materializeIndexes();

        const names = requireNames(connectedNames);
        const allocationSchema = await currentSchema(pool);
        const live = await relationsOf(pool, names);
        // The vector table and its ANN index, the graph index, and every
        // lazily ensured bundled table, all in the one schema.
        expect(schemasOf(live)).toEqual([allocationSchema]);
        expect(
          live.some(
            (relation) =>
              relation.kind === TABLE_KIND &&
              relation.name.startsWith(
                allocationVectorTablePrefix(physicalPrefixOf(names)),
              ),
          ),
        ).toBe(true);
        expect(await ledgerRows(pool, names)).toEqual([
          { schema_name: allocationSchema },
        ]);

        await forked.close();

        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("rebuilds a fulltext contribution in the allocation schema when its transaction's session leads with another", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        const [source] = await createStoreWithSchema(
          articleGraph,
          createPostgresBackend(drizzle(pool)),
          { revisionTracking: true },
        );
        await source.nodes.Article.create({ title: "Alpha source" });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof articleGraph>(
          pool,
          skewed,
          connectedNames,
        );
        const forked = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("allocation-schema-rebuild"),
          }),
        );
        await forked.store.nodes.Article.create({ title: "Beta forked" });

        // The rebuild drops and recreates the allocation's fulltext table in a
        // schema-write transaction on a skewed session.
        const rebuilt = await forked.store.rebuildContribution("fulltext");

        expect(rebuilt.rebuilt.length).toBeGreaterThan(0);
        const names = requireNames(connectedNames);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          await currentSchema(pool),
        ]);
        const hits = await forked.store.search.fulltext("Article", {
          query: "Beta",
          limit: 10,
        });
        expect(hits).toHaveLength(1);
        await forked.close();
        expect(await relationsOf(pool, names)).toEqual([]);
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("removes a crashed owner's relations from every schema and drops its ledger row", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        const [source] = await createStoreWithSchema(
          vectorGraph,
          createPostgresBackend(drizzle(pool)),
          { revisionTracking: true },
        );
        await source.nodes.Doc.create({ name: "source", vector: [1, 2, 3] });
        const connectedNames: PostgresTableNames[] = [];
        const crashed = managerOver<typeof vectorGraph>(
          pool,
          skewed,
          connectedNames,
        );
        const forked = unwrap(
          await branch(source, crashed.makeBackend, {
            id: asBranchId("allocation-schema-crash"),
          }),
        );
        await forked.store.nodes.Doc.create({ name: "f", vector: [3, 2, 1] });
        const names = requireNames(connectedNames);
        const live = await relationsOf(pool, names);
        expect(live.length).toBeGreaterThan(0);

        // The owner dies without closing: nothing runs its teardown.
        await skewed.end();
        const recovery = managerOver<typeof vectorGraph>(pool, pool, []);
        await recovery.abortAllocation(await onlyUnsealedId(recovery));

        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("keeps every relation in the allocation schema when connections alternate between schemas", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const { pool: mixed, skewedConnections } = mixedPool();
      try {
        await prepareDatabase(pool);
        const [source] = await createStoreWithSchema(
          vectorGraph,
          createPostgresBackend(drizzle(pool)),
          { revisionTracking: true },
        );
        await source.nodes.Doc.create({ name: "source", vector: [1, 2, 3] });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof vectorGraph>(
          pool,
          mixed,
          connectedNames,
        );

        const forked = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("allocation-schema-mixed"),
          }),
        );
        await Promise.all(
          [1, 2, 3, 4].map((index) =>
            forked.store.nodes.Doc.create({
              name: `forked-${index}`,
              vector: [index, 0, 1],
            }),
          ),
        );
        await forked.store.materializeIndexes();
        // Both kinds of connection served the allocation.
        await Promise.all(
          [1, 2, 3, 4, 5, 6].map(() => mixed.query("SELECT pg_sleep(0.05)")),
        );
        expect(skewedConnections()).toBeGreaterThan(0);

        const names = requireNames(connectedNames);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          await currentSchema(pool),
        ]);
        await forked.close();
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await mixed.end();
        await pool.end();
      }
    }, 60_000);

    it("clones a durable copy through a skewed connection, reopens it, and destroys it from every schema", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        const cloneStatements: string[] = [];
        const sourceBackend = createPostgresBackend(drizzle(pool));
        // The clone copies rows on the source's own session, so the target
        // relations it writes must be named through the allocation schema.
        const observedSource = deriveBackend(sourceBackend, {
          transaction: <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
          ): Promise<T> =>
            sourceBackend.transaction((transaction) =>
              operation(
                deriveBackend(transaction, {
                  execute: async <Row>(
                    query: Parameters<typeof transaction.execute>[0],
                  ): Promise<readonly Row[]> => {
                    cloneStatements.push(statementText(query));
                    return transaction.execute<Row>(query);
                  },
                }),
              ),
            ),
        });
        const [source] = await createStoreWithSchema(
          vectorGraph,
          observedSource,
          { revisionTracking: true },
        );
        await source.nodes.Doc.create({ name: "source", vector: [1, 2, 3] });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof vectorGraph>(
          pool,
          skewed,
          connectedNames,
        );

        const { branch: created, descriptor } = unwrap(
          await branchDurable(source, manager.durable, {
            id: asBranchId("allocation-schema-durable"),
            allocationId: "allocation-schema-durable-allocation",
          }),
        );
        const names = requireNames(connectedNames);
        const allocationSchema = await currentSchema(pool);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          allocationSchema,
        ]);
        const targetWrites = cloneStatements.filter(
          (statement) =>
            statement.startsWith("INSERT INTO") &&
            statement.includes(physicalPrefixOf(names)),
        );
        expect(targetWrites.length).toBeGreaterThan(0);
        for (const statement of targetWrites) {
          expect(statement).toMatch(
            new RegExp(
              String.raw`^INSERT INTO "${allocationSchema}"\."(tg_vec_)?tgw_`,
              "u",
            ),
          );
        }
        await created.close();

        const reopened = unwrap(
          await reopenDurableBranch(vectorGraph, descriptor, manager.durable),
        );
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          allocationSchema,
        ]);
        await reopened.close();

        unwrap(await destroyDurableBranch(descriptor, manager.durable));
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("fixes provisioning to the allocation schema before it claims the ledger or creates anything", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const transactions: string[][] = [];
        const source = createPostgresBackend(drizzle(pool));
        const control = deriveBackend(source, {
          transaction: <T>(
            operation: (transaction: TransactionBackend) => Promise<T>,
          ): Promise<T> =>
            source.transaction((transaction) => {
              const seen: string[] = [];
              transactions.push(seen);
              return operation(
                deriveBackend(transaction, {
                  execute: async <Row>(
                    query: Parameters<typeof transaction.execute>[0],
                  ): Promise<readonly Row[]> => {
                    seen.push(statementText(query));
                    return transaction.execute<Row>(query);
                  },
                }),
              );
            }),
        });
        const manager = createPostgresWorkingCopyManager<GraphDef>({
          control,
          connect: (names) =>
            Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                vector: false,
              }),
            ),
        });

        await manager.makeBackend();

        const provisioning = transactions.find((statements) =>
          statements.some((statement) =>
            statement.startsWith(`INSERT INTO "${LEDGER}"`),
          ),
        );
        expect(provisioning?.[0]).toContain("set_config('search_path'");
        await manager.abortAllocation(await onlyUnsealedId(manager));
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("removes an allocation from the schema its ledger row records, not the remover's", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${MOVED_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        // Relocate the allocation to a schema no session here searches.
        for (const relation of await relationsOf(pool, names)) {
          if (relation.kind !== TABLE_KIND) continue;
          await pool.query(
            `ALTER TABLE "${relation.schema}"."${relation.name}" SET SCHEMA ${MOVED_SCHEMA}`,
          );
        }
        await pool.query(
          `UPDATE ${LEDGER} SET schema_name = $1 WHERE physical_prefix = $2`,
          [MOVED_SCHEMA, physicalPrefixOf(names)],
        );
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          MOVED_SCHEMA,
        ]);

        await manager.abortAllocation(await onlyUnsealedId(manager));

        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${MOVED_SCHEMA} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("keeps the ledger row and names the schema when the allocation's tables moved out of the recorded one", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${MOVED_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        // The tables move away; the ledger row still records the old schema.
        for (const relation of await relationsOf(pool, names)) {
          if (relation.kind !== TABLE_KIND) continue;
          await pool.query(
            `ALTER TABLE "${relation.schema}"."${relation.name}" SET SCHEMA ${MOVED_SCHEMA}`,
          );
        }

        const failure = await rejectionOf(
          manager.abortAllocation(allocationId),
        );
        expect(failure).toBeInstanceOf(BranchError);
        expect((failure as BranchError).message).toContain(`"${MOVED_SCHEMA}"`);
        expect((failure as BranchError).message).toContain("not in its schema");
        expect((failure as BranchError).message).not.toContain("also has");
        expect((failure as BranchError).details).toMatchObject({
          allocationId,
          foundIn: [MOVED_SCHEMA],
          schemas: [MOVED_SCHEMA],
        });
        expect((failure as BranchError).suggestion).toContain("schema_name");
        expect(await ledgerRows(pool, names)).toHaveLength(1);
        expect(await onlyUnsealedId(manager)).toBe(allocationId);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          MOVED_SCHEMA,
        ]);

        // Pointing the row at where the tables now live makes it removable.
        await pool.query(
          `UPDATE ${LEDGER} SET schema_name = $1 WHERE physical_prefix = $2`,
          [MOVED_SCHEMA, physicalPrefixOf(names)],
        );
        await manager.abortAllocation(allocationId);
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${MOVED_SCHEMA} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("refuses removal while a stale copy of an allocation table sits in another schema, words it as an extra location, and removes once the copy is dropped", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${MOVED_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        const recordedSchema = await currentSchema(pool);
        // A backup or restore schema holds a copy while the original stays.
        await pool.query(
          `CREATE TABLE ${MOVED_SCHEMA}."${names.nodes}" (LIKE "${recordedSchema}"."${names.nodes}")`,
        );

        const failure = await rejectionOf(
          manager.abortAllocation(allocationId),
        );
        expect(failure).toBeInstanceOf(BranchError);
        const branchFailure = failure as BranchError;
        expect(branchFailure.message).toContain(
          `also has relations in "${MOVED_SCHEMA}"`,
        );
        expect(branchFailure.message).toContain(`"${recordedSchema}"`);
        expect(branchFailure.message).not.toContain("not in its schema");
        expect(branchFailure.details).toMatchObject({
          allocationId,
          schema: recordedSchema,
          foundIn: [MOVED_SCHEMA],
          schemas: [recordedSchema, MOVED_SCHEMA],
        });
        expect(branchFailure.suggestion).toContain(`"${MOVED_SCHEMA}"`);
        expect(await ledgerRows(pool, names)).toHaveLength(1);
        expect(schemasOf(await relationsOf(pool, names))).toEqual(
          [recordedSchema, MOVED_SCHEMA].toSorted(),
        );

        await pool.query(`DROP TABLE ${MOVED_SCHEMA}."${names.nodes}"`);
        await manager.abortAllocation(allocationId);
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${MOVED_SCHEMA} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("words a partial move as a split allocation and never suggests dropping the only copy of a moved table", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${MOVED_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        const recordedSchema = await currentSchema(pool);
        // Only the nodes table leaves; the edges table stays where it was.
        await pool.query(
          `ALTER TABLE "${recordedSchema}"."${names.nodes}" SET SCHEMA ${MOVED_SCHEMA}`,
        );

        const failure = await rejectionOf(
          manager.abortAllocation(allocationId),
        );
        expect(failure).toBeInstanceOf(BranchError);
        const branchFailure = failure as BranchError;
        expect(branchFailure.message).toContain("is split across schemas");
        expect(branchFailure.message).toContain(`"${MOVED_SCHEMA}"`);
        expect(branchFailure.message).not.toContain("also has relations");
        expect(branchFailure.message).not.toContain("not in its schema");
        expect(branchFailure.details).toMatchObject({
          allocationId,
          schema: recordedSchema,
          foundIn: [MOVED_SCHEMA],
          schemas: [recordedSchema, MOVED_SCHEMA],
        });
        expect(branchFailure.suggestion).not.toMatch(/drop the stale/i);
        expect(branchFailure.suggestion).toContain("Drop nothing");
        expect(branchFailure.suggestion).toContain(`"${MOVED_SCHEMA}"`);
        expect(await ledgerRows(pool, names)).toHaveLength(1);

        // The moved table is still the only copy; moving it back recovers.
        await pool.query(
          `ALTER TABLE ${MOVED_SCHEMA}."${names.nodes}" SET SCHEMA "${recordedSchema}"`,
        );
        await manager.abortAllocation(allocationId);
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${MOVED_SCHEMA} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("removes the ledger row of an allocation whose tables were dropped entirely, so abort succeeds and it leaves the list", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        await dropAllocationTables(pool, names);
        expect(await ledgerRows(pool, names)).toHaveLength(1);

        await manager.abortAllocation(allocationId);

        expect(await ledgerRows(pool, names)).toEqual([]);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("removes the ledger row when close() finds the allocation's tables dropped entirely", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        const backend = await manager.makeBackend();
        const names = requireNames(connectedNames);
        await dropAllocationTables(pool, names);

        await backend.close();

        expect(await ledgerRows(pool, names)).toEqual([]);
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("keeps a legacy ledger row that records no schema and names where its tables moved", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${MOVED_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        await pool.query(
          `UPDATE ${LEDGER} SET schema_name = NULL WHERE physical_prefix = $1`,
          [physicalPrefixOf(names)],
        );
        await moveAllocationTables(pool, names, MOVED_SCHEMA);

        const failure = await rejectionOf(
          manager.abortAllocation(allocationId),
        );

        expect(failure).toBeInstanceOf(BranchError);
        expect((failure as BranchError).message).toContain(`"${MOVED_SCHEMA}"`);
        expect(await ledgerRows(pool, names)).toHaveLength(1);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          MOVED_SCHEMA,
        ]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${MOVED_SCHEMA} CASCADE`);
        await abortLeftoverAllocations();
        await pool.end();
      }
    }, 60_000);

    it("removes a legacy ledger row that records no schema when its tables were dropped entirely", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        await pool.query(
          `UPDATE ${LEDGER} SET schema_name = NULL WHERE physical_prefix = $1`,
          [physicalPrefixOf(names)],
        );
        await dropAllocationTables(pool, names);

        await manager.abortAllocation(await onlyUnsealedId(manager));

        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("keeps the ledger row and the allocation discoverable when a relation cannot be dropped", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${DEPENDENT_SCHEMA}`);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationId = await onlyUnsealedId(manager);
        // A view in another schema depends on an allocation table.
        await pool.query(
          `CREATE VIEW ${DEPENDENT_SCHEMA}.blocker AS SELECT * FROM "${names.nodes}"`,
        );

        const failure = await rejectionOf(
          manager.abortAllocation(allocationId),
        );
        expect(failure).toBeInstanceOf(Error);
        expect(String((failure as Error).cause)).toMatch(/depend/iu);

        expect(await ledgerRows(pool, names)).toHaveLength(1);
        expect(await onlyUnsealedId(manager)).toBe(allocationId);
        const remaining = await relationsOf(pool, names);
        expect(
          remaining.filter((relation) => relation.kind === TABLE_KIND),
        ).toHaveLength(Object.keys(defaultPostgresTableNames).length);

        await pool.query(`DROP VIEW ${DEPENDENT_SCHEMA}.blocker`);
        await manager.abortAllocation(allocationId);

        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${DEPENDENT_SCHEMA} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("resolves a legacy ledger row that records no schema through the removing session", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        await manager.makeBackend();
        const names = requireNames(connectedNames);
        await pool.query(
          `UPDATE ${LEDGER} SET schema_name = NULL WHERE physical_prefix = $1`,
          [physicalPrefixOf(names)],
        );

        await manager.abortAllocation(await onlyUnsealedId(manager));

        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("adds the schema column to a ledger written before it existed", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const manager = managerOver<GraphDef>(pool, pool, []);
        await manager.makeBackend();
        await pool.query(`ALTER TABLE ${LEDGER} DROP COLUMN schema_name`);

        const unsealed = await manager.listUnsealedAllocations();

        expect(unsealed).toHaveLength(1);
        const column = await pool.query(
          "SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'schema_name' AND NOT attisdropped",
          [LEDGER],
        );
        expect(column.rowCount).toBe(1);
        await manager.abortAllocation(await onlyUnsealedId(manager));
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses a connection built over a copy of the names and leaves no allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = createPostgresWorkingCopyManager<typeof personGraph>({
          control: createPostgresBackend(drizzle(pool)),
          connect: (names) => {
            connectedNames.push(names);
            // A copy carries no allocation schema, so its DDL would follow the
            // pooled connection's search_path.
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables({ ...names }),
              }),
            );
          },
        });
        const [source] = await createStoreWithSchema(
          personGraph,
          createPostgresBackend(drizzle(pool)),
          { revisionTracking: true },
        );

        await expect(manager.makeBackend()).rejects.toThrow(
          /not bound to the allocation schema/u,
        );
        await expect(
          manager.durable.create(
            source,
            await computeBaseVersion(source),
            asBranchId("allocation-schema-copy"),
            "allocation-schema-copy-allocation",
          ),
        ).rejects.toBeInstanceOf(BranchError);

        for (const names of connectedNames) {
          expect(await relationsOf(pool, names)).toEqual([]);
          expect(await ledgerRows(pool, names)).toEqual([]);
        }
        expect(connectedNames).toHaveLength(2);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("refuses a bound backend on a driver that cannot hold the transaction its DDL needs", () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
      const names = Object.fromEntries(
        Object.keys(defaultPostgresTableNames).map((key) => [
          key,
          `tgw_${"c".repeat(DIGEST_LENGTH)}_${key.slice(0, 15)}`,
        ]),
      ) as PostgresTableNames;
      bindNamesToAllocationSchema(names, "public");
      let refusal: unknown;
      try {
        createPostgresBackend(drizzle(pool), {
          tables: createPostgresTables(names),
          capabilities: { execution: { interactiveTransactions: false } },
        });
      } catch (error) {
        refusal = error;
      }
      void pool.end();
      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details["code"]).toBe(
        "ALLOCATION_SCHEMA_REQUIRES_INTERACTIVE_TRANSACTIONS",
      );
    });

    it("refuses to adopt a caller's transaction whose session is not in the allocation schema", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        const manager = managerOver<GraphDef>(pool, pool, []);
        const backend = await manager.makeBackend();
        const adopt = (backend as AdoptingBackend).adoptSchemaWriteTransaction;
        if (adopt === undefined) throw new Error("Adoption is unavailable.");

        const refusal = await rejectionOf(
          drizzle(skewed).transaction((transaction) =>
            adopt(transaction, personGraph.id, { waitBudgetMs: 1000 }),
          ),
        );
        expect(refusal).toBeInstanceOf(ConfigurationError);
        expect((refusal as ConfigurationError).details["code"]).toBe(
          "ALLOCATION_SCHEMA_SESSION_MISMATCH",
        );

        // A session already in the allocation schema is adopted.
        await drizzle(pool).transaction((transaction) =>
          adopt(transaction, personGraph.id, { waitBudgetMs: 1000 }),
        );
        await backend.close();
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("checks a caller-owned transaction's schema for lazy DDL instead of rewriting its search_path", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, pool, connectedNames);
        const owner = await manager.makeBackend();
        const names = requireNames(connectedNames);
        const searchPathOf = async (
          transaction: AnyPgTransaction,
        ): Promise<string> => {
          const shown = await transaction.execute(sql`SHOW search_path`);
          return String(
            (shown as { rows: { search_path: string }[] }).rows[0]?.search_path,
          );
        };

        let skewedPathBefore = "";
        let skewedPathAfter = "";
        let refusal: unknown;
        await drizzle(skewed).transaction(async (transaction) => {
          skewedPathBefore = await searchPathOf(transaction);
          const callerBackend = createPostgresBackend(transaction, {
            tables: createPostgresTables(names),
          });
          refusal = await rejectionOf(
            createStoreWithSchema(personGraph, callerBackend),
          );
          skewedPathAfter = await searchPathOf(transaction);
        });
        expect(configurationCodesOf(refusal)).toContain(
          "ALLOCATION_SCHEMA_SESSION_MISMATCH",
        );
        expect(skewedPathAfter).toBe(skewedPathBefore);

        // A session already in the allocation schema runs the same DDL and
        // keeps the search_path it brought.
        let matchingPathBefore = "";
        let matchingPathAfter = "";
        await drizzle(pool).transaction(async (transaction) => {
          matchingPathBefore = await searchPathOf(transaction);
          const callerBackend = createPostgresBackend(transaction, {
            tables: createPostgresTables(names),
          });
          await createStoreWithSchema(personGraph, callerBackend);
          matchingPathAfter = await searchPathOf(transaction);
        });
        expect(matchingPathAfter).toBe(matchingPathBefore);
        await owner.close();
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("refuses lazy DDL on a caller-owned transaction whose session is not in the allocation schema, before any schema write", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof articleGraph>(
          pool,
          pool,
          connectedNames,
        );
        const owner = await manager.makeBackend();
        const names = requireNames(connectedNames);
        // The schema is committed on the allocation and the caller's store is
        // built with createStore, so no schema write precedes the rebuild's
        // lazy contribution DDL: that DDL must be the statement refused.
        await createStoreWithSchema(articleGraph, owner);
        const before = await relationsOf(pool, names);

        let refusal: unknown;
        await drizzle(skewed).transaction(async (transaction) => {
          const callerBackend = createPostgresBackend(transaction, {
            tables: createPostgresTables(names),
          });
          const callerStore = createStore(articleGraph, callerBackend);
          refusal = await rejectionOf(
            callerStore.rebuildContribution("fulltext"),
          );
        });

        expect(configurationCodesOf(refusal)).toContain(
          "ALLOCATION_SCHEMA_SESSION_MISMATCH",
        );
        expect(messagesOf(refusal).join(" ")).toContain("Lazy DDL");
        const skewedRelations = await pool.query(
          "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1",
          [SKEW_SCHEMA],
        );
        expect(skewedRelations.rows).toEqual([]);
        expect(await relationsOf(pool, names)).toEqual(before);
        await owner.close();
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("allocates, reopens and destroys a history-enabled durable copy through a connection that leads with another schema", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const [source] = await createStoreWithSchema(
          personGraph,
          createPostgresBackend(drizzle(pool)),
          { history: true },
        );
        await source.nodes.Person.create({ name: "source" });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof personGraph>(
          pool,
          skewed,
          connectedNames,
        );

        const { branch: created, descriptor } = unwrap(
          await branchDurable(source, manager.durable, {
            id: asBranchId("allocation-schema-history"),
            allocationId: "allocation-schema-history-allocation",
          }),
        );
        const names = requireNames(connectedNames);
        expect(schemasOf(await relationsOf(pool, names))).toEqual([
          await currentSchema(pool),
        ]);
        await created.close();

        const reopened = unwrap(
          await reopenDurableBranch(personGraph, descriptor, manager.durable),
        );
        await reopened.close();

        unwrap(await destroyDurableBranch(descriptor, manager.durable));
        expect(await relationsOf(pool, names)).toEqual([]);
        expect(await ledgerRows(pool, names)).toEqual([]);
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("answers catalog probes from the allocation's schema, not from a relation the session's search_path reaches first", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      let decoy = "";
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, skewed, connectedNames);
        const backend = await manager.makeBackend();
        const names = requireNames(connectedNames);
        decoy = `shadow_${digestOf(names)}`;
        await pool.query(
          `CREATE TABLE ${SKEW_SCHEMA}."${decoy}" (id int PRIMARY KEY, label text)`,
        );
        const catalog = backend.catalog;
        if (catalog?.tablesExist === undefined) throw new Error("No catalog.");

        // The decoy exists only in the skew schema, which the connection
        // searches first; the allocation's schema does not hold it.
        expect(await catalog.tablesExist([decoy, names.nodes])).toEqual([
          { name: decoy, exists: false },
          { name: names.nodes, exists: true },
        ]);
        expect(await catalog.indexStates([`${decoy}_pkey`])).toEqual([
          { name: `${decoy}_pkey`, exists: false, invalid: false },
        ]);
        expect(await catalog.columnTypes(decoy)).toEqual([]);
        const nodeColumns = await catalog.columnTypes(names.nodes);
        expect(nodeColumns.length).toBeGreaterThan(0);
        await backend.close();
      } finally {
        if (decoy !== "") {
          await pool.query(`DROP TABLE IF EXISTS ${SKEW_SCHEMA}."${decoy}"`);
        }
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("finds the allocation's secondary indexes for a trusted import through a connection that leads with another schema", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, skewed, connectedNames);
        const backend = await manager.makeBackend();
        const names = requireNames(connectedNames);
        const nodeIndexOids = async (): Promise<readonly string[]> => {
          const found = await pool.query<{ oid: string }>(
            "SELECT i.indexrelid::text AS oid FROM pg_catalog.pg_index i WHERE i.indrelid = to_regclass($1) AND NOT i.indisprimary AND NOT i.indisunique ORDER BY 1",
            [`"${await currentSchema(pool)}"."${names.nodes}"`],
          );
          return found.rows.map((row) => row.oid);
        };
        const before = await nodeIndexOids();
        expect(before.length).toBeGreaterThan(0);

        const trustedImport = backend.trustedImport;
        if (trustedImport === undefined) throw new Error("No trusted import.");
        await trustedImport(() => Promise.resolve());

        // Suspending and restoring an index recreates it, so its oid changes.
        const after = await nodeIndexOids();
        expect(after).toHaveLength(before.length);
        expect(after.filter((oid) => before.includes(oid))).toEqual([]);
        await backend.close();
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("drops and recreates only the allocation's own index when a same-named index sits earlier on the connection's search_path", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const skewed = skewedPool();
      let decoyTable = "";
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<GraphDef>(pool, skewed, connectedNames);
        const backend = await manager.makeBackend();
        const names = requireNames(connectedNames);
        const allocationSchema = await currentSchema(pool);
        const indexOids = async (
          schema: string,
          indexName: string,
        ): Promise<readonly string[]> => {
          const found = await pool.query<{ oid: string }>(
            "SELECT c.oid::text AS oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'i' AND n.nspname = $1 AND c.relname = $2",
            [schema, indexName],
          );
          return found.rows.map((row) => row.oid);
        };
        const allocationIndex = await pool.query<{ index_name: string }>(
          "SELECT i.relname AS index_name FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = to_regclass($1) AND NOT x.indisprimary AND NOT x.indisunique ORDER BY 1 LIMIT 1",
          [`"${allocationSchema}"."${names.nodes}"`],
        );
        const indexName = allocationIndex.rows[0]?.index_name ?? "";
        expect(indexName).not.toBe("");
        decoyTable = `decoy_${digestOf(names)}`;
        await pool.query(
          `CREATE TABLE ${SKEW_SCHEMA}."${decoyTable}" (id int)`,
        );
        await pool.query(
          `CREATE INDEX "${indexName}" ON ${SKEW_SCHEMA}."${decoyTable}" (id)`,
        );
        const decoyBefore = await indexOids(SKEW_SCHEMA, indexName);
        const ownBefore = await indexOids(allocationSchema, indexName);
        expect(decoyBefore).toHaveLength(1);
        expect(ownBefore).toHaveLength(1);

        const trustedImport = backend.trustedImport;
        if (trustedImport === undefined) throw new Error("No trusted import.");
        await trustedImport(() => Promise.resolve());

        expect(await indexOids(SKEW_SCHEMA, indexName)).toEqual(decoyBefore);
        const ownAfter = await indexOids(allocationSchema, indexName);
        expect(ownAfter).toHaveLength(1);
        expect(ownAfter).not.toEqual(ownBefore);
        await backend.close();
      } finally {
        if (decoyTable !== "") {
          await pool.query(
            `DROP TABLE IF EXISTS ${SKEW_SCHEMA}."${decoyTable}"`,
          );
        }
        await skewed.end();
        await pool.end();
      }
    }, 60_000);

    it("creates a schema-bound vector table and index in the schema whatever the session's search_path", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
      const skewed = skewedPool();
      try {
        await prepareDatabase(pool);
        await expectSkewed(skewed);
        const allocationSchema = await currentSchema(pool);
        const prefix = `tgw_${"d".repeat(DIGEST_LENGTH)}_`;
        const strategy = createPgvectorStrategyForAllocation(
          prefix,
          allocationSchema,
        );
        const slot = {
          graphId: "schema-strategy",
          nodeKind: "Doc",
          fieldPath: "vector",
          dimensions: 3,
          metric: "cosine",
          indexType: "hnsw",
        } as const;
        // No search-path pin: the statements themselves must name the schema.
        for (const contribution of strategy.ownedTables(slot)) {
          for (const ddl of contribution.createDdl) await skewed.query(ddl);
        }
        const createIndex = strategy.buildCreateIndex?.(slot);
        if (createIndex === undefined) throw new Error("No index DDL.");
        await skewed.query(renderPostgres(createIndex).sql);

        const digestRelations = async () => {
          const found = await pool.query<Relation>(
            "SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE position($1 in c.relname) > 0",
            ["d".repeat(DIGEST_LENGTH)],
          );
          return found.rows;
        };
        const created = await digestRelations();
        expect(schemasOf(created)).toEqual([allocationSchema]);
        expect(created.map((relation) => relation.kind).toSorted()).toEqual([
          "i",
          "i",
          "r",
        ]);

        for (const statement of strategy.buildDropStorage(slot)) {
          await skewed.query(statement);
        }
        expect(await digestRelations()).toEqual([]);
      } finally {
        await skewed.end();
        await pool.end();
      }
    }, 60_000);
  },
);
