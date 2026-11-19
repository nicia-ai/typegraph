import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineGraph, defineNode, type Node } from "../../../src";
import type { NodeAccessor } from "../../../src/query/builder/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
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
