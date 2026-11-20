import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type Node } from "../../../src";
import type { NodeAccessor } from "../../../src/query/builder/types";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
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
 * Runs `operation` on one session while another session holds `patch` on the
 * row uncommitted, and releases that writer only once the operation's UPDATE
 * is observed waiting for the row lock. The operation's snapshot therefore
 * predates the writer's commit and its write lands after it.
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
              AND query LIKE '%UPDATE%'
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
 * Where the replacing writer makes the set update wait. `"table"`: a SHARE
 * table lock, which an UPDATE needs a conflicting lock against before it
 * takes its snapshot but a plain read does not — so the update waits after
 * any earlier read statement and writes from a snapshot that sees the
 * replacement. `"row"`: the deleted row's own lock, which an UPDATE meets only
 * while writing — so its snapshot predates the replacement.
 */
type ReplacementHold = "table" | "row";

const REPLACEMENT_HOLD_WAIT_EVENTS: Readonly<Record<ReplacementHold, string>> =
  { table: "relation", row: "transactionid" };

/**
 * Runs `operation` while another session holds, uncommitted, a hard delete of
 * `documentId` and a new row created under the same id — at version 1, as the
 * original — and releases that writer only once the operation's UPDATE is
 * observed waiting on `hold`.
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
              AND query LIKE '%UPDATE%'
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
  });
}
