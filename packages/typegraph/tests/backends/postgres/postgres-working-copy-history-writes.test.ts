import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  isRecordedCaptureGuardError,
  type NodeId,
  type RecordedInstant,
  type Store,
} from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import {
  createPostgresWorkingCopyManager,
  type PostgresWorkingCopyManager,
} from "../../../src/backend/postgres/working-copy";
import {
  branchDurable,
  computeBaseVersion,
  reopenDurableBranch,
} from "../../../src/graph-merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { storeBackend } from "../../../src/store/runtime-port";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

type TestGraph = ReturnType<typeof buildGraph>;

type HistoryConfiguration = Readonly<{
  label: string;
  revisionTracking: boolean;
}>;

const HISTORY_CONFIGURATIONS: readonly HistoryConfiguration[] = [
  { label: "history only", revisionTracking: false },
  { label: "history with revision tracking", revisionTracking: true },
];

// Every scenario owns a graph id: working copies clone by graph id, and the
// source tables are shared by every test in this database.
let scenarioCounter = 0;

async function withHistorySource(
  revisionTracking: boolean,
  scenario: (
    context: Readonly<{
      graph: TestGraph;
      source: Store<TestGraph>;
      manager: PostgresWorkingCopyManager<TestGraph>;
    }>,
  ) => Promise<void>,
): Promise<void> {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5 });
  try {
    scenarioCounter += 1;
    const graph = buildGraph(
      `postgres-working-copy-history-writes-${scenarioCounter}`,
    );
    const control = createPostgresBackend(drizzle(pool));
    const [source] = await createStoreWithSchema(graph, control, {
      history: true,
      revisionTracking,
    });
    await source.nodes.Person.create({ name: "Source" });
    const manager = createPostgresWorkingCopyManager<TestGraph>({
      control,
      connect: (names) =>
        Promise.resolve(
          createPostgresBackend(drizzle(pool), {
            tables: createPostgresTables(names),
          }),
        ),
    });
    await scenario({ graph, source, manager });
  } finally {
    await pool.end();
  }
}

async function requireRecordedNow(
  store: Store<TestGraph>,
): Promise<RecordedInstant> {
  const instant = await store.recordedNow();
  if (instant === undefined) throw new Error("Expected recorded history.");
  return instant;
}

async function names(store: Store<TestGraph>): Promise<readonly string[]> {
  const found = await store.nodes.Person.find();
  return found.map((person) => person.name).toSorted();
}

async function nameAt(
  store: Store<TestGraph>,
  instant: RecordedInstant,
  id: NodeId<typeof Person>,
): Promise<string | undefined> {
  const person = await store.asOfRecorded(instant).nodes.Person.getById(id);
  return person?.name;
}

async function exerciseRecordedWrites(copy: Store<TestGraph>): Promise<void> {
  const created = await copy.nodes.Person.create({ name: "Copy" });
  const afterCreate = await requireRecordedNow(copy);
  await copy.nodes.Person.update(created.id, { name: "Copy updated" });
  const afterUpdate = await requireRecordedNow(copy);
  await copy.nodes.Person.delete(created.id);
  const afterDelete = await requireRecordedNow(copy);

  expect(await names(copy)).toEqual(["Source"]);
  expect(await nameAt(copy, afterCreate, created.id)).toBe("Copy");
  expect(await nameAt(copy, afterUpdate, created.id)).toBe("Copy updated");
  expect(await nameAt(copy, afterDelete, created.id)).toBeUndefined();
}

describe.runIf(process.env["POSTGRES_URL"])(
  "PostgreSQL working copies of history-enabled stores accept writes",
  () => {
    describe.each(HISTORY_CONFIGURATIONS)(
      "$label",
      ({ label, revisionTracking }) => {
        it("captures ephemeral copy writes in the copy's history and leaves the source untouched", async () => {
          await withHistorySource(
            revisionTracking,
            async ({ source, manager }) => {
              const sourceRecordedBefore = await requireRecordedNow(source);
              const copy = await manager.ephemeral.create(
                source,
                await computeBaseVersion(source),
              );
              try {
                await exerciseRecordedWrites(copy);
                expect(await names(source)).toEqual(["Source"]);
                expect(await requireRecordedNow(source)).toBe(
                  sourceRecordedBefore,
                );
              } finally {
                await storeBackend(copy).close();
              }
            },
          );
        }, 60_000);

        it("captures durable copy writes before and after reopen", async () => {
          await withHistorySource(
            revisionTracking,
            async ({ graph, source, manager }) => {
              const created = await branchDurable(source, manager.durable, {
                id: asBranchId(`history-writes-${label.replaceAll(" ", "-")}`),
                allocationId: `history-writes-${revisionTracking}`,
              });
              if (!isOk(created)) throw created.error;
              const { branch, descriptor } = unwrap(created);
              await exerciseRecordedWrites(branch.store);
              await branch.close();

              const reopenedResult = await reopenDurableBranch(
                graph,
                descriptor,
                manager.durable,
              );
              if (!isOk(reopenedResult)) throw reopenedResult.error;
              const reopened = unwrap(reopenedResult);
              try {
                await exerciseRecordedWrites(reopened.store);
                expect(await names(source)).toEqual(["Source"]);
              } finally {
                await reopened.close();
              }
            },
          );
        }, 60_000);

        it("returns exactly the store, descriptor and access from durable create", async () => {
          await withHistorySource(
            revisionTracking,
            async ({ source, manager }) => {
              const allocationId = `history-shape-${revisionTracking}`;
              const created = await manager.durable.create(
                source,
                await computeBaseVersion(source),
                asBranchId(`history-shape-${revisionTracking}`),
                allocationId,
              );
              try {
                expect(Object.keys(created).toSorted()).toEqual([
                  "access",
                  "descriptor",
                  "store",
                ]);
              } finally {
                await created.store.close();
                await manager.abortAllocation(allocationId);
              }
            },
          );
        }, 60_000);

        it("still refuses user raw SQL writes on an ephemeral copy", async () => {
          await withHistorySource(
            revisionTracking,
            async ({ source, manager }) => {
              const copy = await manager.ephemeral.create(
                source,
                await computeBaseVersion(source),
              );
              try {
                await copy.nodes.Person.create({ name: "Copy" });
                const caught = await copy
                  .transaction((tx) => {
                    const rawSql = Reflect.get(tx, "sql") as Readonly<{
                      run?: unknown;
                    }>;
                    return Promise.resolve(rawSql.run);
                  })
                  .catch((error: unknown) => error);
                expect(
                  isRecordedCaptureGuardError(
                    caught,
                    "RECORDED_CAPTURE_RAW_SQL_DISABLED",
                  ),
                ).toBe(true);
              } finally {
                await storeBackend(copy).close();
              }
            },
          );
        }, 60_000);
      },
    );
  },
);
