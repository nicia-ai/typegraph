import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  type Node,
  UniquenessError,
} from "../../../src";
import {
  deriveBackend,
  projectGraphBackend,
} from "../../../src/backend/derive-backend";
import { type TransactionBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import type { NodeAccessor } from "../../../src/query/builder/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledSelectSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { buildKindRegistry } from "../../../src/registry";
import { uniquenessClaimAxis } from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { createGate } from "../../concurrency-utils";
import type { InspectableStore, IntegrationTestContext } from "./test-context";

const RaceDocument = defineNode("RaceDocument", {
  schema: z.object({ status: z.string(), title: z.string() }),
});

const raceGraph = defineGraph({
  id: "set_update_concurrency",
  nodes: { RaceDocument: { type: RaceDocument } },
  edges: {},
});

type RaceStore = InspectableStore<typeof raceGraph>;

const RACE_HANDLE_UNIQUE = {
  name: "set_update_concurrency_handle",
  fields: ["handle"],
  scope: "kind",
  collation: "binary",
} as const;

const RaceHandle = defineNode("RaceHandle", {
  schema: z.object({ handle: z.string() }),
});

const raceUniqueGraph = defineGraph({
  id: "set_update_concurrency_unique",
  nodes: { RaceHandle: { type: RaceHandle, unique: [RACE_HANDLE_UNIQUE] } },
  edges: {},
});

const raceUniqueRegistry = buildKindRegistry(raceUniqueGraph);

/** The node id holding the live claim of `handle`. */
async function handleClaimOwner(
  store: InspectableStore<typeof raceUniqueGraph>,
  handle: string,
): Promise<string | undefined> {
  const row = await store.backend.checkUnique({
    graphId: raceUniqueGraph.id,
    nodeKind: uniquenessClaimAxis(
      "RaceHandle",
      RACE_HANDLE_UNIQUE.scope,
      raceUniqueRegistry,
    ),
    constraintName: RACE_HANDLE_UNIQUE.name,
    key: computeUniqueKey(
      { handle },
      RACE_HANDLE_UNIQUE.fields,
      RACE_HANDLE_UNIQUE.collation,
    ),
    includeDeleted: false,
  });
  return row?.node_id;
}

/**
 * `store`'s backend, whose transaction targets run `afterProbe` once, the
 * first time a batched uniqueness probe returns — after the set update has
 * found its new key free and before it reserves it.
 */
function backendPausingAfterProbe(
  store: InspectableStore<typeof raceUniqueGraph>,
  afterProbe: () => Promise<void>,
) {
  function pausing(target: TransactionBackend): TransactionBackend {
    let paused = false;
    const checkUniqueBatch = requireDefined(target.checkUniqueBatch);
    return deriveBackend(target, {
      checkUniqueBatch: async (params) => {
        const read = await checkUniqueBatch(params);
        if (!paused) {
          paused = true;
          await afterProbe();
        }
        return read;
      },
    });
  }
  return deriveBackend(projectGraphBackend(store.backend), {
    transaction: (run, options) =>
      store.backend.transaction((target) => run(pausing(target)), options),
  });
}

type RacePredicate = (
  document: NodeAccessor<typeof RaceDocument>,
) => ReturnType<NodeAccessor<typeof RaceDocument>["status"]["eq"]>;

type CountRow = Readonly<{ count: string | number }>;

/**
 * The selectors a concurrent writer's committed change falsifies on the one
 * candidate row: a declared property and the stored version.
 */
const RACE_CASES: readonly Readonly<{
  name: string;
  where: RacePredicate;
}>[] = [
  {
    name: "a property predicate",
    where: (document) => document.status.eq("draft"),
  },
  {
    name: "a $meta.version predicate",
    where: (document) => document.$meta.version.eq(1),
  },
];

/**
 * What a waiting set update's text in `pg_stat_activity` contains. The
 * statement that waits is the set update's locked dry-run, the first one that
 * meets the row. The text is cut at `track_activity_query_size` (1 kB by
 * default), and the dry-run opens with its key CTE, which embeds the whole
 * candidate query, so what follows can fall past the cut; the CTE's name
 * cannot.
 */
const SET_UPDATE_TEXT = "%tg_set_keys%";

/**
 * Runs `operation` on one session while another session holds `patch` on the
 * row uncommitted, and releases that writer only once the operation's locked
 * dry-run is observed waiting for the row lock. The operation's snapshot
 * therefore predates the writer's commit and its read of the row lands after
 * it.
 */
async function raceAgainstUncommittedUpdate<Result>(
  context: IntegrationTestContext,
  store: RaceStore,
  documentId: Node<typeof RaceDocument>["id"],
  patch: Readonly<{ status?: string; title?: string }>,
  operation: () => Promise<Result>,
): Promise<Result> {
  const reached = createGate();
  const release = createGate();
  const writing = store.transaction(async (tx) => {
    await tx.nodes.RaceDocument.update(documentId, patch);
    reached.open();
    await release.opened;
  });
  await reached.opened;
  const operating = operation();
  try {
    await vi.waitFor(
      async () => {
        const rows = await context.getBackend().execute<CountRow>(
          asCompiledRowsSql(sql`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE ${SET_UPDATE_TEXT}
          `),
        );
        expect(Number(requireDefined(rows[0]).count)).toBe(1);
      },
      { timeout: 5000 },
    );
  } finally {
    release.open();
  }
  await writing;
  return operating;
}

/**
 * What the replacing writer holds besides its uncommitted delete and
 * re-create. `"table"`: also a SHARE table lock, which an UPDATE of the table
 * waits on before it takes its snapshot. `"row"`: nothing more.
 *
 * Either way the set update waits at its dry-run, on the deleted row itself
 * (`transactionid`): the dry-run locks rows as `FOR NO KEY UPDATE`, whose
 * table lock (ROW SHARE) the SHARE lock does not exclude, so it reaches the
 * row with a snapshot that predates the replacement. Once the writer commits,
 * the row it locked is gone, and the write never runs on its replacement.
 */
type ReplacementHold = "table" | "row";

const REPLACEMENT_HOLD_WAIT_EVENTS: Readonly<Record<ReplacementHold, string>> =
  { table: "transactionid", row: "transactionid" };

/**
 * Runs `operation` while another session holds, uncommitted, a hard delete of
 * `documentId` and a new row created under the same id — at version 1, as the
 * original — and releases that writer only once the operation's dry-run is
 * observed waiting on the row.
 */
async function raceAgainstUncommittedReplacement<Result>(
  context: IntegrationTestContext,
  store: RaceStore,
  documentId: Node<typeof RaceDocument>["id"],
  hold: ReplacementHold,
  operation: () => Promise<Result>,
): Promise<Result> {
  const backend = context.getBackend();
  const nodesTable = createSqlSchema(backend.tableNames).nodesTable;
  const reached = createGate();
  const release = createGate();
  const replacing = backend.transaction(async (tx) => {
    const execute = requireDefined(tx.executeStatement);
    await execute(
      asCompiledStatementSql(sql`
        DELETE FROM ${nodesTable}
        WHERE graph_id = ${store.graphId} AND kind = 'RaceDocument' AND id = ${documentId}
      `),
    );
    const now = new Date().toISOString();
    await execute(
      asCompiledStatementSql(sql`
        INSERT INTO ${nodesTable}
          (graph_id, kind, id, props, version, created_at, updated_at)
        VALUES (
          ${store.graphId}, 'RaceDocument', ${documentId},
          ${JSON.stringify({ status: "published", title: "replacement" })},
          1, ${now}, ${now}
        )
      `),
    );
    if (hold === "table") {
      await execute(
        asCompiledStatementSql(sql`LOCK TABLE ${nodesTable} IN SHARE MODE`),
      );
    }
    reached.open();
    await release.opened;
  });
  await reached.opened;
  const operating = operation();
  try {
    await vi.waitFor(
      async () => {
        const rows = await backend.execute<CountRow>(
          asCompiledRowsSql(sql`
            SELECT count(*) AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND wait_event = ${REPLACEMENT_HOLD_WAIT_EVENTS[hold]}
              AND query LIKE ${SET_UPDATE_TEXT}
          `),
        );
        expect(Number(requireDefined(rows[0]).count)).toBe(1);
      },
      { timeout: 5000 },
    );
  } finally {
    release.open();
  }
  await replacing;
  return operating;
}

export function registerSetUpdateConcurrencyTests(
  context: IntegrationTestContext,
): void {
  describe("set updates against a concurrent writer on another PostgreSQL session", () => {
    // Another session creates a node holding the set update's new key and
    // commits, after the set update's probe found that key free and before it
    // reserves it. The reservation gates the row write, so the set update is
    // refused there, with nothing written: a caller that catches the refusal
    // and commits keeps the row, its claim and the competitor's claim as they
    // were.
    it.runIf(context.serverLaneConcurrency)(
      "updateWhere() refused by a key another session claims after its probe commits no change",
      async () => {
        const store = await context.createStore(raceUniqueGraph);
        const renamed = await store.nodes.RaceHandle.create({
          handle: "before",
        });
        let competitorId: string | undefined;
        const racedStore = createStore(
          raceUniqueGraph,
          backendPausingAfterProbe(store, async () => {
            const competitor = await store.nodes.RaceHandle.create({
              handle: "after",
            });
            competitorId = competitor.id;
          }),
        );

        const thrown = await racedStore.transaction(async (tx) =>
          tx.nodes.RaceHandle.updateWhere({
            patch: { handle: "after" },
            where: (candidate) => candidate.id.eq(renamed.id),
          }).then(
            () => "resolved",
            (error: unknown) => error,
          ),
        );
        const stored = requireDefined(
          await store.nodes.RaceHandle.getById(renamed.id),
        );

        expect({
          refused: thrown instanceof UniquenessError,
          handle: stored.handle,
          version: stored.meta.version,
          oldClaimOwner: await handleClaimOwner(store, "before"),
          newClaimOwner: await handleClaimOwner(store, "after"),
        }).toEqual({
          refused: true,
          handle: "before",
          version: renamed.meta.version,
          oldClaimOwner: renamed.id,
          newClaimOwner: requireDefined(competitorId),
        });
      },
    );

    it.runIf(context.serverLaneConcurrency).each(RACE_CASES)(
      "updateWhere() does not write a row whose committed change falsified $name after its snapshot",
      async ({ where }) => {
        const store = await context.createStore(raceGraph);
        const document = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "original",
        });
        // The writer moves the row to version 2 / published; the update
        // selected it at version 1 / draft.
        const { affectedCount } = await raceAgainstUncommittedUpdate(
          context,
          store,
          document.id,
          { status: "published" },
          () =>
            store.nodes.RaceDocument.updateWhere({
              patch: { title: "stale patch" },
              where,
            }),
        );
        const stored = requireDefined(
          await store.nodes.RaceDocument.getById(document.id),
        );

        expect({
          affectedCount,
          title: stored.title,
          status: stored.status,
          version: stored.meta.version,
        }).toEqual({
          affectedCount: 0,
          title: "original",
          status: "published",
          version: 2,
        });
      },
    );

    it
      .runIf(context.serverLaneConcurrency)
      .each<ReplacementHold>(["table", "row"])(
      "updateWhere() does not write a row deleted and re-created under its id at the same version (writer holds the %s)",
      async (hold) => {
        const store = await context.createStore(raceGraph);
        const document = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "original",
        });
        // The replacement reuses the id AND the version (1), and fails the
        // selector: only the identity of the row the selector read can tell
        // it apart from the original.
        const { affectedCount } = await raceAgainstUncommittedReplacement(
          context,
          store,
          document.id,
          hold,
          () =>
            store.nodes.RaceDocument.updateWhere({
              patch: { title: "stale patch" },
              where: (candidate) => candidate.status.eq("draft"),
            }),
        );
        const stored = requireDefined(
          await store.nodes.RaceDocument.getById(document.id),
        );

        expect({
          affectedCount,
          title: stored.title,
          status: stored.status,
          version: stored.meta.version,
        }).toEqual({
          affectedCount: 0,
          title: "replacement",
          status: "published",
          version: 1,
        });
      },
    );

    it.runIf(context.serverLaneConcurrency)(
      "compareAndSet() still applies when a concurrent change leaves its expected values true",
      async () => {
        const store = await context.createStore(raceGraph);
        const document = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "original",
        });
        const applied = await raceAgainstUncommittedUpdate(
          context,
          store,
          document.id,
          { title: "retitled" },
          () =>
            store.nodes.RaceDocument.compareAndSet(document.id, {
              expected: { status: "draft" },
              patch: { status: "published" },
            }),
        );
        const stored = requireDefined(
          await store.nodes.RaceDocument.getById(document.id),
        );

        expect({
          applied,
          title: stored.title,
          status: stored.status,
          version: stored.meta.version,
        }).toEqual({
          applied: true,
          title: "retitled",
          status: "published",
          version: 3,
        });
      },
    );
    // A history store takes its per-graph write lock before every write it
    // records, and so before that write's row locks. A set update's dry-run
    // row-locks what its write will write, so it must take the graph lock
    // first too: taken only at the write, it would follow the dry-run's row
    // lock, and a writer that holds the graph lock while it updates the same
    // row would deadlock against it.
    it.runIf(context.serverLaneConcurrency)(
      "updateWhere() on a history store takes the graph write lock before its dry-run locks the row",
      async () => {
        const store = await context.createHistoryStore(raceGraph);
        const document = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "original",
        });
        const holding = createGate();
        const release = createGate();
        // Holds the graph write lock (any recorded write takes it), then
        // updates the document once the set update below is waiting.
        const writing = store.transaction(async (tx) => {
          await tx.nodes.RaceDocument.create({
            status: "other",
            title: "lock holder",
          });
          holding.open();
          await release.opened;
          await tx.nodes.RaceDocument.update(document.id, {
            title: "retitled",
          });
        });
        await holding.opened;
        const updating = store.nodes.RaceDocument.updateWhere({
          patch: { status: "published" },
          where: (candidate) => candidate.status.eq("draft"),
        });
        try {
          await vi.waitFor(
            async () => {
              const rows = await context.getBackend().execute<CountRow>(
                asCompiledRowsSql(sql`
                  SELECT count(*) AS count FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND wait_event_type = 'Lock'
                    AND wait_event = 'advisory'
                `),
              );
              expect(Number(requireDefined(rows[0]).count)).toBe(1);
            },
            { timeout: 5000 },
          );
        } finally {
          release.open();
        }
        const outcomes = await Promise.allSettled([writing, updating]);
        const stored = requireDefined(
          await store.nodes.RaceDocument.getById(document.id),
        );

        expect({
          outcomes: outcomes.map((outcome) => outcome.status),
          affectedCount:
            outcomes[1].status === "fulfilled" ?
              outcomes[1].value.affectedCount
            : undefined,
          title: stored.title,
          status: stored.status,
          version: stored.meta.version,
        }).toEqual({
          outcomes: ["fulfilled", "fulfilled"],
          affectedCount: 1,
          title: "retitled",
          status: "published",
          version: 3,
        });
      },
    );
    // The keyed write is all or nothing on its own, without the dry-run's
    // locks: called directly on an autocommit connection, the dry-run's locks
    // are gone by the time it runs. It locks the keyed rows before it counts
    // them, so a row a concurrent writer is changing is counted only once that
    // writer has committed, and a set with one changed row writes nothing.
    it.runIf(context.serverLaneConcurrency)(
      "a direct keyed set write that meets a concurrently changed row writes none of its rows",
      async () => {
        const store = await context.createStore(raceGraph);
        const changed = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "changed",
        });
        const untouched = await store.nodes.RaceDocument.create({
          status: "draft",
          title: "untouched",
        });
        const backend = context.getBackend();
        const nodesTable = createSqlSchema(backend.tableNames).nodesTable;
        const patch = { status: "published" };
        const preview = await requireDefined(backend.previewNodeSetUpdate)({
          operation: "updateWhere",
          graphId: store.graphId,
          kind: "RaceDocument",
          patch,
          candidateIds: asCompiledSelectSql(sql`
            SELECT id AS document_id FROM ${nodesTable}
            WHERE graph_id = ${store.graphId} AND kind = 'RaceDocument'
          `),
          candidateIdColumn: "document_id",
        });
        expect(preview.rows).toHaveLength(2);

        const { affectedCount } = await raceAgainstUncommittedUpdate(
          context,
          store,
          changed.id,
          { title: "retitled" },
          () =>
            requireDefined(backend.updateNodeSet)({
              graphId: store.graphId,
              kind: "RaceDocument",
              patch,
              rows: preview.rows.map((row) => ({
                id: row.id,
                rowToken: row.rowToken,
              })),
            }),
        );
        const storedChanged = requireDefined(
          await store.nodes.RaceDocument.getById(changed.id),
        );
        const storedUntouched = requireDefined(
          await store.nodes.RaceDocument.getById(untouched.id),
        );

        expect({
          affectedCount,
          changed: [storedChanged.title, storedChanged.status],
          untouched: [storedUntouched.status, storedUntouched.meta.version],
        }).toEqual({
          affectedCount: 0,
          changed: ["retitled", "draft"],
          untouched: ["draft", 1],
        });
      },
    );
  });
}
