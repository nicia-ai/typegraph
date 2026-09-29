import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineGraphExtension,
  defineNode,
  embedding,
  type GraphDef,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import {
  createPostgresTables,
  type PostgresTableNames,
} from "../../../src/backend/drizzle/schema/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import { ConfigurationError } from "../../../src/errors";
import {
  branch,
  branchDurable,
  branchForEvolution,
  type CandidateWriteSet,
  captureCandidateWriteSetTarget,
  destroyDurableBranch,
  planCandidateWriteSet,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { computeBaseVersion } from "../../../src/graph-merge/base-version";
import { BranchError } from "../../../src/graph-merge/errors";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { defineNodeIndex } from "../../../src/indexes";
import { allocationVectorTablePrefix } from "../../../src/query/dialect/vector/pgvector-strategy";
import type { VectorStrategy } from "../../../src/query/dialect/vector-strategy";
import { createStoreWithSchema } from "../../../src/store/store";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const LEDGER = "typegraph_working_copy_allocations";
const VALID_FROM = "2026-01-01T00:00:00.000Z";
const ROLE_MISMATCH_CODE = "WORKING_COPY_ROLE_MISMATCH";
// Roles are cluster-global; this name is reserved to this file.
const OTHER_ROLE = "tg_make_backend_other_role";
const OTHER_ROLE_PASSWORD = "other-role-password";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const personGraph = defineGraph({
  id: "postgres-make-backend-person",
  nodes: { Person: { type: Person } },
  edges: {},
});

const VectorNode = defineNode("VectorNode", {
  schema: z.object({ vector: embedding(3) }),
});
function vectorGraphNamed(id: string) {
  return defineGraph({
    id,
    nodes: { VectorNode: { type: VectorNode } },
    edges: {},
  });
}
const vectorGraph = vectorGraphNamed("postgres-make-backend-vector-crash");
const siblingVectorGraph = vectorGraphNamed(
  "postgres-make-backend-vector-sibling",
);

type ConnectOptions = Readonly<{
  /** Graph-index extras a caller-supplied Drizzle schema carries. */
  indexes?: GraphDef["indexes"];
}>;

function managerOver<G extends GraphDef>(
  pool: Pool,
  connectedNames: PostgresTableNames[],
  options: ConnectOptions = {},
): PostgresWorkingCopyManager<G> {
  return createPostgresWorkingCopyManager<G>({
    control: createPostgresBackend(drizzle(pool)),
    connect: (names, allocation) => {
      connectedNames.push(names);
      return Promise.resolve(
        createPostgresBackend(drizzle(pool), {
          tables: createPostgresTables(names, {
            ...(options.indexes === undefined ?
              {}
            : { indexes: options.indexes }),
          }),
          ...(allocation === undefined ?
            {}
          : { vector: allocation.vectorStrategy }),
        }),
      );
    },
  });
}

function physicalPrefixOf(names: PostgresTableNames): string {
  return names.nodes.slice(0, -"nodes".length);
}

async function ownedRelations(
  pool: Pool,
  names: PostgresTableNames,
): Promise<Readonly<{ tables: readonly string[]; ledgerRows: number }>> {
  const prefix = physicalPrefixOf(names);
  const tables = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND (left(tablename, length($1)) = $1 OR left(tablename, length($2)) = $2) ORDER BY tablename",
    [prefix, allocationVectorTablePrefix(prefix)],
  );
  const ledger = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${LEDGER} WHERE physical_prefix = $1`,
    [prefix],
  );
  return {
    tables: tables.rows.map((row) => row.tablename),
    ledgerRows: ledger.rows[0]?.count ?? 0,
  };
}

async function vectorTablesOf(
  pool: Pool,
  names: PostgresTableNames,
): Promise<readonly string[]> {
  const header = allocationVectorTablePrefix(physicalPrefixOf(names));
  const found = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND left(tablename, length($1)) = $1 ORDER BY tablename",
    [header],
  );
  return found.rows.map((row) => row.tablename);
}

function requireNames(
  connectedNames: readonly PostgresTableNames[],
  index = 0,
): PostgresTableNames {
  const names = connectedNames[index];
  if (names === undefined) throw new Error("Allocation did not call connect.");
  return names;
}

async function dropOtherRole(pool: Pool): Promise<void> {
  const existing = await pool.query(
    "SELECT 1 FROM pg_roles WHERE rolname = $1",
    [OTHER_ROLE],
  );
  if (existing.rowCount === 0) return;
  await pool.query(`DROP OWNED BY ${OTHER_ROLE}`);
  await pool.query(`DROP ROLE ${OTHER_ROLE}`);
}

/**
 * Runs `run` with a pool that logs in as a second database role, then drops the
 * role. The role holds no privileges beyond a login, as a least-privilege
 * `connect` role would.
 */
async function withOtherRole<T>(
  pool: Pool,
  run: (otherPool: Pool) => Promise<T>,
): Promise<T> {
  await dropOtherRole(pool);
  await pool.query(
    `CREATE ROLE ${OTHER_ROLE} LOGIN PASSWORD '${OTHER_ROLE_PASSWORD}'`,
  );
  const otherUrl = new URL(TEST_DATABASE_URL);
  otherUrl.username = OTHER_ROLE;
  otherUrl.password = OTHER_ROLE_PASSWORD;
  const otherPool = new Pool({ connectionString: otherUrl.toString(), max: 4 });
  try {
    return await run(otherPool);
  } finally {
    await otherPool.end();
    await dropOtherRole(pool);
  }
}

function connectOver(
  pool: Pool,
  connectedNames: PostgresTableNames[],
  observeAtConnect?: (names: PostgresTableNames) => Promise<void>,
) {
  return async (
    names: PostgresTableNames,
    allocation?: Readonly<{ vectorStrategy: VectorStrategy }>,
  ) => {
    connectedNames.push(names);
    await observeAtConnect?.(names);
    return createPostgresBackend(drizzle(pool), {
      tables: createPostgresTables(names),
      ...(allocation === undefined ?
        {}
      : { vector: allocation.vectorStrategy }),
    });
  };
}

async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

function expectRoleMismatch(error: unknown): void {
  expect(error).toBeInstanceOf(ConfigurationError);
  expect((error as ConfigurationError).details["code"]).toBe(
    ROLE_MISMATCH_CODE,
  );
  expect((error as ConfigurationError).details["connectedRole"]).toBe(
    OTHER_ROLE,
  );
}

/**
 * The ledger is database-wide. Recover whatever an earlier failing test left
 * live so each test asserts only its own allocation.
 */
async function abortLeftoverAllocations(): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  try {
    const manager = managerOver<GraphDef>(pool, []);
    for (const orphan of await manager.listUnsealedAllocations()) {
      await manager.abortAllocation(orphan.allocationId);
    }
  } catch (error) {
    // The ledger does not exist until the first allocation.
    if (
      !(error instanceof Error) ||
      !error.message.includes("does not exist")
    ) {
      throw error;
    }
  } finally {
    await pool.end();
  }
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working-copy makeBackend",
  () => {
    beforeEach(abortLeftoverAllocations);

    it("backs branch() with a ledger-recorded allocation that close removes", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(personGraph, control, {
          revisionTracking: true,
        });
        const person = await source.nodes.Person.create({ name: "Source" });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof personGraph>(pool, connectedNames);

        const forked = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("make-backend-round-trip"),
          }),
        );
        const names = requireNames(connectedNames);
        const live = await manager.listUnsealedAllocations();
        expect(live).toHaveLength(1);
        expect(live[0]?.state).toBe("ephemeral");
        const provisioned = await ownedRelations(pool, names);
        expect(provisioned.ledgerRows).toBe(1);
        expect(provisioned.tables).toEqual(Object.values(names).toSorted());

        const copied = await forked.store.nodes.Person.getById(person.id);
        expect(copied?.name).toBe("Source");
        await forked.store.nodes.Person.update(person.id, { name: "Forked" });
        const unchanged = await source.nodes.Person.getById(person.id);
        expect(unchanged?.name).toBe("Source");

        await forked.close();
        expect(await ownedRelations(pool, names)).toEqual({
          tables: [],
          ledgerRows: 0,
        });
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("hands out a schema-mutable backend to branchForEvolution", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(personGraph, control, {
          revisionTracking: true,
        });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof personGraph>(pool, connectedNames);
        const plan = await source.planEvolution(
          defineGraphExtension({
            nodes: {
              Tag: {
                properties: { label: { type: "string", optional: true } },
              },
            },
          }),
        );

        const future = unwrap(
          await branchForEvolution(source, plan, manager.makeBackend, {
            id: asBranchId("make-backend-evolution"),
          }),
        );
        const tag = await future.store
          .getNodeCollectionOrThrow("Tag")
          .create({ label: "New" });
        expect(tag["label"]).toBe("New");
        // Unlike a fixed-schema copy, the store can keep evolving.
        const evolved = await future.store.evolve(
          defineGraphExtension({
            nodes: { Label: { properties: { text: { type: "string" } } } },
          }),
        );
        const label = await evolved
          .getNodeCollectionOrThrow("Label")
          .create({ text: "Later" });
        expect(label["text"]).toBe("Later");

        const names = requireNames(connectedNames);
        const committed = await pool.query<{ schema_doc: string }>(
          `SELECT schema_doc::text AS schema_doc FROM "${names.schemaVersions}" WHERE graph_id = $1`,
          [personGraph.id],
        );
        expect(
          committed.rows.map((row) => row.schema_doc).join("\n"),
        ).toContain('"Tag"');
        expect(
          source.introspect().kinds.map((kind) => kind.name),
        ).not.toContain("Tag");

        await future.close();
        const remaining = await ownedRelations(pool, names);
        expect(remaining.tables).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("backs planCandidateWriteSet and leaves nothing behind", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [target] = await createStoreWithSchema(personGraph, control, {
          revisionTracking: true,
        });
        await target.nodes.Person.create({ name: "Existing" });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof personGraph>(pool, connectedNames);
        const writeSet: CandidateWriteSet = {
          formatVersion: 1,
          sourceId: "make-backend-candidate",
          target: await captureCandidateWriteSetTarget(target),
          nodes: [
            {
              kind: "Person",
              id: "candidate-person",
              properties: { name: "Candidate" },
              validFrom: VALID_FROM,
            },
          ],
          edges: [],
        };

        const planned = await planCandidateWriteSet({
          target,
          makeBackend: manager.makeBackend,
          writeSet,
        });

        expect(isErr(planned)).toBe(false);
        expect(connectedNames.length).toBeGreaterThan(0);
        for (const names of connectedNames) {
          expect(await ownedRelations(pool, names)).toEqual({
            tables: [],
            ledgerRows: 0,
          });
        }
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("lets abortAllocation recover a crashed owner, including lazily created vector tables", async () => {
      const controlPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 4,
      });
      const crashedPool = new Pool({
        connectionString: TEST_DATABASE_URL,
        max: 4,
      });
      try {
        await controlPool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const control = createPostgresBackend(drizzle(controlPool));
        const [source] = await createStoreWithSchema(vectorGraph, control, {
          revisionTracking: true,
        });
        await source.nodes.VectorNode.create({ vector: [0.1, 0.2, 0.3] });
        const connectedNames: PostgresTableNames[] = [];
        const crashedManager = managerOver<typeof vectorGraph>(
          crashedPool,
          connectedNames,
        );

        unwrap(
          await branch(source, crashedManager.makeBackend, {
            id: asBranchId("make-backend-crash"),
          }),
        );
        const names = requireNames(connectedNames);
        expect(await vectorTablesOf(controlPool, names)).toHaveLength(1);

        // The owner dies without closing: nothing runs its teardown.
        await crashedPool.end();

        const recovery = managerOver<typeof vectorGraph>(controlPool, []);
        const unsealed = await recovery.listUnsealedAllocations();
        expect(unsealed).toHaveLength(1);
        const [orphan] = unsealed;
        if (orphan === undefined) throw new Error("Missing orphan allocation.");
        expect(orphan.state).toBe("ephemeral");

        await recovery.abortAllocation(orphan.allocationId);

        expect(await ownedRelations(controlPool, names)).toEqual({
          tables: [],
          ledgerRows: 0,
        });
        expect(await recovery.listUnsealedAllocations()).toEqual([]);
      } finally {
        await controlPool.end();
      }
    }, 60_000);

    it("removes only its own vector tables when a sibling allocation is live", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(
          siblingVectorGraph,
          control,
          {
            revisionTracking: true,
          },
        );
        await source.nodes.VectorNode.create({ vector: [0.3, 0.2, 0.1] });
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof siblingVectorGraph>(
          pool,
          connectedNames,
        );
        const first = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("make-backend-sibling-a"),
          }),
        );
        const second = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("make-backend-sibling-b"),
          }),
        );
        const firstNames = requireNames(connectedNames, 0);
        const secondNames = requireNames(connectedNames, 1);
        const secondVectors = await vectorTablesOf(pool, secondNames);
        expect(secondVectors).toHaveLength(1);
        expect(await vectorTablesOf(pool, firstNames)).toHaveLength(1);

        await first.close();

        expect(await ownedRelations(pool, firstNames)).toEqual({
          tables: [],
          ledgerRows: 0,
        });
        expect(await vectorTablesOf(pool, secondNames)).toEqual(secondVectors);
        const siblingRows = await second.store.nodes.VectorNode.find({
          limit: 10,
        });
        expect(siblingRows).toHaveLength(1);
        await second.close();
        const remaining = await ownedRelations(pool, secondNames);
        expect(remaining.tables).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("keeps declared graph indexes off the source's and siblings' index names", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
      try {
        const IndexedPerson = defineNode("IndexedPerson", {
          schema: z.object({ name: z.string(), tags: z.array(z.string()) }),
        });
        const indexedGraph = defineGraph({
          id: "postgres-make-backend-indexes",
          nodes: { IndexedPerson: { type: IndexedPerson } },
          edges: {},
          indexes: [
            defineNodeIndex(IndexedPerson, {
              fields: ["name"],
              name: "make_backend_name_idx",
            }),
            defineNodeIndex(IndexedPerson, {
              fields: ["tags"],
              method: "gin",
              name: "make_backend_tags_idx",
            }),
          ],
        });
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(indexedGraph, control, {
          revisionTracking: true,
        });
        await source.nodes.IndexedPerson.create({
          name: "Source",
          tags: ["alpha"],
        });
        const sourceNodes = source.revisionSchema.tables.nodes;
        const connectedNames: PostgresTableNames[] = [];
        // A caller-supplied Drizzle schema carrying the graph's logical index
        // names must not replay them onto allocation tables either.
        const manager = managerOver<typeof indexedGraph>(pool, connectedNames, {
          indexes: indexedGraph.indexes,
        });

        const first = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("make-backend-index-a"),
          }),
        );
        const second = unwrap(
          await branch(source, manager.makeBackend, {
            id: asBranchId("make-backend-index-b"),
          }),
        );
        // The source claims its logical index names only after the copies
        // exist: a copy that replayed them first would steal the names and
        // leave the source's CREATE INDEX IF NOT EXISTS a silent no-op.
        const sourceIndexes = await source.materializeIndexes();
        expect(sourceIndexes.results.map((result) => result.status)).toEqual([
          "created",
          "created",
        ]);
        for (const forked of [first, second]) {
          const materialized = await forked.store.materializeIndexes();
          expect(materialized.results.map((result) => result.status)).toEqual([
            "created",
            "created",
          ]);
        }

        const firstNames = requireNames(connectedNames, 0);
        const secondNames = requireNames(connectedNames, 1);
        const indexRows = await pool.query<{
          tablename: string;
          indexname: string;
        }>(
          "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY($1::text[]) AND indexname NOT LIKE '%_pkey' ORDER BY tablename, indexname",
          [[sourceNodes, firstNames.nodes, secondNames.nodes]],
        );
        const indexesOn = (table: string): readonly string[] =>
          indexRows.rows
            .filter((row) => row.tablename === table)
            .map((row) => row.indexname);
        expect(indexesOn(sourceNodes)).toEqual(
          expect.arrayContaining(["make_backend_name_idx"]),
        );
        expect(indexesOn(sourceNodes)).toEqual(
          expect.arrayContaining(["make_backend_tags_idx"]),
        );
        for (const names of [firstNames, secondNames]) {
          const scoped = indexesOn(names.nodes).filter((name) =>
            name.startsWith(`${physicalPrefixOf(names)}gix_`),
          );
          expect(scoped).toHaveLength(2);
          expect(indexesOn(names.nodes)).not.toContain("make_backend_name_idx");
          expect(indexesOn(names.nodes)).not.toContain("make_backend_tags_idx");
        }
        const allScoped = [firstNames, secondNames].flatMap((names) =>
          indexesOn(names.nodes).filter((name) => name.includes("_gix_")),
        );
        expect(new Set(allScoped).size).toBe(4);

        await first.close();
        await second.close();
      } finally {
        await pool.end();
      }
    }, 120_000);

    it("scopes declared index names on a backend derived from the makeBackend result", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const DerivedPerson = defineNode("DerivedPerson", {
          schema: z.object({ name: z.string() }),
        });
        const derivedGraph = defineGraph({
          id: "postgres-make-backend-derived-indexes",
          nodes: { DerivedPerson: { type: DerivedPerson } },
          edges: {},
          indexes: [
            defineNodeIndex(DerivedPerson, {
              fields: ["name"],
              name: "make_backend_derived_idx",
            }),
          ],
        });
        const [source] = await createStoreWithSchema(
          derivedGraph,
          createPostgresBackend(drizzle(pool)),
        );
        const connectedNames: PostgresTableNames[] = [];
        const manager = managerOver<typeof derivedGraph>(pool, connectedNames);

        const forked = unwrap(
          await branch(source, async () =>
            deriveBackend(await manager.makeBackend(), {}),
          ),
        );
        const materialized = await forked.store.materializeIndexes();
        expect(materialized.results.map((result) => result.status)).toEqual([
          "created",
        ]);
        const sourceIndexes = await source.materializeIndexes();
        expect(sourceIndexes.results.map((result) => result.status)).toEqual([
          "created",
        ]);

        const names = requireNames(connectedNames);
        const indexRows = await pool.query<{
          tablename: string;
          indexname: string;
        }>(
          "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = current_schema() AND (indexname = 'make_backend_derived_idx' OR indexname LIKE $1)",
          [`${physicalPrefixOf(names)}gix_%`],
        );
        expect(
          indexRows.rows.filter((row) => row.tablename === names.nodes),
        ).toEqual([
          expect.objectContaining({
            indexname: expect.stringContaining(
              `${physicalPrefixOf(names)}gix_`,
            ) as string,
          }),
        ]);
        expect(
          indexRows.rows.find(
            (row) => row.indexname === "make_backend_derived_idx",
          )?.tablename,
        ).toBe(source.revisionSchema.tables.nodes);

        await forked.close();
      } finally {
        await pool.end();
      }
    }, 120_000);

    it("refuses a connection whose creation schema differs from control's and leaves no allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      const otherSchema = "make_backend_other_schema";
      try {
        await pool.query(`CREATE SCHEMA IF NOT EXISTS ${otherSchema}`);
        // Resolves the allocation's tables through `public` but creates new
        // relations in its own schema, as a per-role "$user" schema does.
        const connectedPool = new Pool({
          connectionString: TEST_DATABASE_URL,
          max: 4,
          options: `-c search_path=${otherSchema},public`,
        });
        try {
          const connectedNames: PostgresTableNames[] = [];
          const manager = createPostgresWorkingCopyManager<typeof personGraph>({
            control: createPostgresBackend(drizzle(pool)),
            connect: (names, allocation) => {
              connectedNames.push(names);
              return Promise.resolve(
                createPostgresBackend(drizzle(connectedPool), {
                  tables: createPostgresTables(names),
                  ...(allocation === undefined ?
                    {}
                  : { vector: allocation.vectorStrategy }),
                }),
              );
            },
          });

          await expect(manager.makeBackend()).rejects.toBeInstanceOf(
            BranchError,
          );

          expect(
            await ownedRelations(pool, requireNames(connectedNames)),
          ).toEqual({ tables: [], ledgerRows: 0 });
          expect(await manager.listUnsealedAllocations()).toEqual([]);
        } finally {
          await connectedPool.end();
        }
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS ${otherSchema} CASCADE`);
        await pool.end();
      }
    }, 60_000);

    it("refuses a connection that does not bind the allocation vector strategy and leaves no allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
        const connectedNames: PostgresTableNames[] = [];
        const manager = createPostgresWorkingCopyManager<typeof vectorGraph>({
          control: createPostgresBackend(drizzle(pool)),
          // Ignores the allocation strategy, so a vector graph would create
          // its tables under the shared default names.
          connect: (names) => {
            connectedNames.push(names);
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
              }),
            );
          },
        });

        await expect(manager.makeBackend()).rejects.toBeInstanceOf(BranchError);

        const names = requireNames(connectedNames);
        expect(await ownedRelations(pool, names)).toEqual({
          tables: [],
          ledgerRows: 0,
        });
        expect(await manager.listUnsealedAllocations()).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("never replays a connection's bootstrap DDL onto the allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        let bootstrapCalls = 0;
        const manager = createPostgresWorkingCopyManager<typeof personGraph>({
          control: createPostgresBackend(drizzle(pool)),
          connect: (names, allocation) => {
            const backend = createPostgresBackend(drizzle(pool), {
              tables: createPostgresTables(names),
              ...(allocation === undefined ?
                {}
              : { vector: allocation.vectorStrategy }),
            });
            return Promise.resolve(
              deriveBackend(backend, {
                bootstrapTables: () => {
                  bootstrapCalls += 1;
                  return Promise.resolve();
                },
              }),
            );
          },
        });

        const backend = await manager.makeBackend();
        await backend.bootstrapTables?.();
        await backend.close();

        expect(bootstrapCalls).toBe(0);
      } finally {
        await pool.end();
      }
    }, 60_000);

    it("accepts a connection with vector support disabled", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const manager = createPostgresWorkingCopyManager<typeof personGraph>({
          control: createPostgresBackend(drizzle(pool)),
          connect: (names) => {
            connectedNames.push(names);
            return Promise.resolve(
              createPostgresBackend(drizzle(pool), {
                tables: createPostgresTables(names),
                vector: false,
              }),
            );
          },
        });

        const backend = await manager.makeBackend();
        expect(await manager.listUnsealedAllocations()).toHaveLength(1);
        await backend.close();

        expect(await manager.listUnsealedAllocations()).toEqual([]);
        const remaining = await ownedRelations(
          pool,
          requireNames(connectedNames),
        );
        expect(remaining.tables).toEqual([]);
      } finally {
        await pool.end();
      }
    }, 60_000);
    it("refuses a connection running as another role before it writes the ledger or any DDL", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const connectedNames: PostgresTableNames[] = [];
        const presentAtConnect: (string | undefined)[] = [];
        // Ledger claims and DDL run only inside a `control` transaction.
        let controlTransactions = 0;
        let transactionsAtRefusal: number | undefined;
        const source = createPostgresBackend(drizzle(pool));
        const control = deriveBackend(source, {
          transaction: (operation) => {
            controlTransactions += 1;
            return source.transaction(operation);
          },
        });
        await withOtherRole(pool, async (otherPool) => {
          const manager = createPostgresWorkingCopyManager<typeof personGraph>({
            control,
            connect: connectOver(otherPool, connectedNames, async (names) => {
              const observed = await pool.query<{ present: string | null }>(
                "SELECT to_regclass($1)::text AS present",
                [`"${names.nodes}"`],
              );
              presentAtConnect.push(observed.rows[0]?.present ?? undefined);
            }),
          });

          const failure = await rejectionOf(manager.makeBackend());

          transactionsAtRefusal = controlTransactions;
          expectRoleMismatch(failure);
          expect(await manager.listUnsealedAllocations()).toEqual([]);
        });
        // `makeBackend` connects before provisioning, so the refusal precedes
        // every allocation table and ledger write.
        expect(presentAtConnect).toEqual([undefined]);
        expect(transactionsAtRefusal).toBe(0);
        expect(
          await ownedRelations(pool, requireNames(connectedNames)),
        ).toEqual({ tables: [], ledgerRows: 0 });
      } finally {
        await dropOtherRole(pool);
        await pool.end();
      }
    }, 60_000);

    it("refuses a differently-privileged clone connection with the role error and removes the allocation", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(personGraph, control, {
          revisionTracking: true,
        });
        const connectedNames: PostgresTableNames[] = [];
        // The role holds no ledger privilege: the role error must still win over
        // the permission failure the ledger-token read would raise.
        await withOtherRole(pool, async (otherPool) => {
          const manager = createPostgresWorkingCopyManager<typeof personGraph>({
            control,
            connect: connectOver(otherPool, connectedNames),
          });

          const failure = await rejectionOf(
            manager.durable.create(
              source,
              await computeBaseVersion(source),
              asBranchId("role-mismatch-clone"),
              "role-mismatch-clone-allocation",
            ),
          );

          expectRoleMismatch(failure);
          expect(await manager.listUnsealedAllocations()).toEqual([]);
          expect(
            await ownedRelations(pool, requireNames(connectedNames)),
          ).toEqual({ tables: [], ledgerRows: 0 });
        });
      } finally {
        await dropOtherRole(pool);
        await pool.end();
      }
    }, 60_000);

    it("refuses a reopen from another role and leaves the sealed allocation intact", async () => {
      const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
      try {
        const control = createPostgresBackend(drizzle(pool));
        const [source] = await createStoreWithSchema(personGraph, control, {
          revisionTracking: true,
        });
        const sameRoleNames: PostgresTableNames[] = [];
        const sameRole = createPostgresWorkingCopyManager<typeof personGraph>({
          control,
          connect: connectOver(pool, sameRoleNames),
        });
        const { branch: created, descriptor } = unwrap(
          await branchDurable(source, sameRole.durable, {
            id: asBranchId("role-mismatch-reopen"),
            allocationId: "role-mismatch-reopen-allocation",
          }),
        );
        await created.close();
        try {
          const otherNames: PostgresTableNames[] = [];
          await withOtherRole(pool, async (otherPool) => {
            const other = createPostgresWorkingCopyManager<typeof personGraph>({
              control,
              connect: connectOver(otherPool, otherNames),
            });

            const reopened = await reopenDurableBranch(
              personGraph,
              descriptor,
              other.durable,
            );

            expect(isErr(reopened)).toBe(true);
            expectRoleMismatch(
              isErr(reopened) ? reopened.error.cause : undefined,
            );
          });
          const intact = await ownedRelations(
            pool,
            requireNames(sameRoleNames),
          );
          expect(intact.ledgerRows).toBe(1);
          expect(intact.tables).toEqual(
            Object.values(requireNames(sameRoleNames)).toSorted(),
          );
        } finally {
          unwrap(await destroyDurableBranch(descriptor, sameRole.durable));
        }
      } finally {
        await dropOtherRole(pool);
        await pool.end();
      }
    }, 60_000);
  },
);
