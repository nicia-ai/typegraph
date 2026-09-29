/**
 * `inspectGraphStorage` counts each relation with its own statement, so its
 * counts describe one state only when every statement shared a snapshot. It
 * asks for a `repeatable read` transaction, but a request is not evidence:
 * a wrapper can drop the option, and a role or database can default the level.
 * The result therefore reports the isolation the counting session was observed
 * to run under.
 *
 * Every case interleaves a real `store.clear()` on another connection right
 * after the first count statement. `nodes` is counted first and `schema_versions`
 * later, so a torn read is visible in the data itself: rows in `nodes` with an
 * empty `schema_versions` is a graph state that never existed. That makes the
 * label and the counts checkable against each other instead of against a
 * hard-coded expectation.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
  type GraphStorageInspection,
  inspectGraphStorage,
  type Store,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generatePostgresMigrationSQL } from "../../../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../../../src/backend/postgres";
import { requireDefined } from "../../../src/utils/presence";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);

const READ_COMMITTED_SESSION = String.raw`-c default_transaction_isolation=read\ committed`;
const REPEATABLE_READ_SESSION = String.raw`-c default_transaction_isolation=repeatable\ read`;
const COUNT_STATEMENT_MARKER = "COUNT(*)";

const Note = defineNode("Note", { schema: z.object({ body: z.string() }) });

type Pools = Readonly<{
  writer: Pool;
  readCommitted: Pool;
  repeatableRead: Pool;
}>;

let pools: Pools | undefined;

function openPool(sessionOptions?: string): Pool {
  return new Pool({
    connectionString: TEST_DATABASE_URL,
    connectionTimeoutMillis: 5000,
    max: 4,
    ...(sessionOptions === undefined ? {} : { options: sessionOptions }),
  });
}

beforeAll(async () => {
  if (process.env["POSTGRES_URL"] === undefined) return;
  const opened = {
    writer: openPool(),
    readCommitted: openPool(READ_COMMITTED_SESSION),
    repeatableRead: openPool(REPEATABLE_READ_SESSION),
  };
  pools = opened;
  await opened.writer.query(generatePostgresMigrationSQL());
});

afterAll(async () => {
  if (pools === undefined) return;
  await Promise.all(
    [pools.writer, pools.readCommitted, pools.repeatableRead].map((pool) =>
      pool.end(),
    ),
  );
});

type ReadingBackendOptions = Readonly<{
  /** Runs once, after the first count statement returned. */
  afterFirstCount: () => Promise<void>;
  /** A wrapper that never forwards the requested transaction options. */
  dropRequestedOptions: boolean;
  /** A transaction target that declares no session isolation read. */
  withoutSessionFacts?: boolean;
}>;

function readingBackend(
  raw: GraphBackend,
  options: ReadingBackendOptions,
): GraphBackend {
  const interference = { fired: false };
  return deriveBackend(raw, {
    transaction: (run, requested) =>
      raw.transaction(
        (target) =>
          run(
            deriveBackend(target, {
              async execute<T>(
                query: Parameters<typeof target.execute>[0],
              ): Promise<readonly T[]> {
                const rows = await target.execute<T>(query);
                const isCount = target
                  .compileSql?.(query)
                  .sql.includes(COUNT_STATEMENT_MARKER);
                if (isCount === true && !interference.fired) {
                  interference.fired = true;
                  await options.afterFirstCount();
                }
                return rows;
              },
              ...(options.withoutSessionFacts === true ?
                { fenceSql: undefined }
              : {}),
            }),
          ),
        options.dropRequestedOptions ? undefined : requested,
      ),
  });
}

function rowsOf(inspection: GraphStorageInspection, relation: string): number {
  return requireDefined(
    inspection.relations.find((entry) => entry.relation === relation),
  ).rows;
}

let graphSequence = 0;

/**
 * A populated graph and the two views of it: one that reads through `reading`
 * and one on another connection that can clear it.
 */
async function populatedGraph(
  readingPool: Pool,
  reading: Omit<ReadingBackendOptions, "afterFirstCount">,
) {
  const live = requireDefined(pools);
  graphSequence += 1;
  const graph = defineGraph({
    id: `storage_consistency_${String(graphSequence)}`,
    nodes: { Note: { type: Note } },
    edges: {},
  });
  const [writing] = await createStoreWithSchema(
    graph,
    createPostgresBackend(drizzle(live.writer)),
  );
  await writing.nodes.Note.create({ body: "kept until the clear" });
  const baseline = await inspectGraphStorage(writing);
  const cleared = { value: false };
  const inspecting: Store<typeof graph> = createStore(
    graph,
    readingBackend(createPostgresBackend(drizzle(readingPool)), {
      ...reading,
      afterFirstCount: async () => {
        await writing.clear();
        cleared.value = true;
      },
    }),
  );
  return { baseline, cleared, inspecting, writing };
}

describe("inspectGraphStorage consistency on PostgreSQL", () => {
  it("counts one snapshot although the graph is cleared between statements", async (ctx) => {
    if (pools === undefined) {
      ctx.skip();
      return;
    }
    const { baseline, cleared, inspecting, writing } = await populatedGraph(
      pools.readCommitted,
      { dropRequestedOptions: false },
    );
    expect(rowsOf(baseline, "nodes")).toBeGreaterThan(0);
    expect(rowsOf(baseline, "schemaVersions")).toBeGreaterThan(0);

    const inspection = await inspectGraphStorage(inspecting);

    expect(cleared.value).toBe(true);
    expect(inspection.consistency).toBe("snapshot");
    expect(inspection.relations).toEqual(baseline.relations);
    expect(inspection.totalRows).toBe(baseline.totalRows);
    expect(rowsOf(await inspectGraphStorage(writing), "nodes")).toBe(0);
  });

  it("reports per-statement, and the counts really are torn, when a wrapper drops the isolation option under a read committed session", async (ctx) => {
    if (pools === undefined) {
      ctx.skip();
      return;
    }
    const { baseline, cleared, inspecting } = await populatedGraph(
      pools.readCommitted,
      { dropRequestedOptions: true },
    );

    const inspection = await inspectGraphStorage(inspecting);

    expect(cleared.value).toBe(true);
    expect(inspection.consistency).toBe("per-statement");
    // `nodes` was counted before the clear and `schema_versions` after it: a
    // state the graph was never in. The label is honest, not merely cautious.
    expect(rowsOf(inspection, "nodes")).toBe(rowsOf(baseline, "nodes"));
    expect(rowsOf(inspection, "schemaVersions")).toBe(0);
  });

  it("reads the effective level off the session, not the request: a dropped option under a repeatable read session is still one snapshot", async (ctx) => {
    if (pools === undefined) {
      ctx.skip();
      return;
    }
    const { baseline, cleared, inspecting } = await populatedGraph(
      pools.repeatableRead,
      { dropRequestedOptions: true },
    );

    const inspection = await inspectGraphStorage(inspecting);

    expect(cleared.value).toBe(true);
    expect(inspection.consistency).toBe("snapshot");
    expect(inspection.relations).toEqual(baseline.relations);
  });

  it("reports per-statement when the transaction declares no session isolation read, although repeatable read was requested", async (ctx) => {
    if (pools === undefined) {
      ctx.skip();
      return;
    }
    const { baseline, cleared, inspecting } = await populatedGraph(
      pools.readCommitted,
      { dropRequestedOptions: false, withoutSessionFacts: true },
    );

    const inspection = await inspectGraphStorage(inspecting);

    expect(cleared.value).toBe(true);
    // The request was honored, so the counts happen to be consistent; with no
    // fact to observe, the result must not claim what it cannot prove.
    expect(inspection.relations).toEqual(baseline.relations);
    expect(inspection.consistency).toBe("per-statement");
  });
});
