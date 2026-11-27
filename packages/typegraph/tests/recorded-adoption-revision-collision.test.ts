/**
 * Two recorded-history adoptions of one caller-begun better-sqlite3
 * transaction, writing at once.
 *
 * A better-sqlite3 transaction is identified only by its connection, so each
 * `withRecordedTransaction` adoption of it gets a session and a recorded-time
 * capture of its own (`src/backend/native-transaction-handle.ts`). Both
 * captures allocate the same next revision on the one transaction, and the
 * second flush fails on `typegraph_recorded_anchors`'s primary key with the
 * driver's raw UNIQUE error. The caller commits anyway, so the second
 * adoption's live write is kept without its history.
 *
 * Pinned as a known defect (it reproduces on main before the provenance
 * retraction verbs ran in a caller's transaction, with plain node creates):
 * correct is both adoptions committing at distinct revisions. A fix that
 * refuses the second adoption with a typed error instead changes the
 * observation's shape and must restate `correct`.
 */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, it } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import { generateSqliteDDL } from "../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../src/backend/drizzle/sqlite";
import { tables } from "../src/backend/sqlite";
import type { AdapterHistoryStore } from "../src/store/store";
import { expectObservation } from "./helpers/known-defect";

const Note = defineNode("Note", { schema: z.object({ label: z.string() }) });
const graph = defineGraph({
  id: "recorded_adoption_revision_collision",
  nodes: { Note: { type: Note } },
  edges: {},
});

type CollisionStore = AdapterHistoryStore<typeof graph, never>;
type AdoptedTransaction = Parameters<
  Parameters<CollisionStore["withRecordedTransaction"]>[1]
>[0];

const closers: (() => void)[] = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
});

it("two recorded adoptions of one better-sqlite3 transaction writing at once both record their writes (known defect: the second flush collides)", async () => {
  const connection = new Database(":memory:");
  closers.push(() => {
    connection.close();
  });
  for (const statement of generateSqliteDDL(tables)) connection.exec(statement);
  const connectionDb = drizzle(connection);
  const backend = createSqliteBackend(connectionDb, {
    executionProfile: { isSync: true },
    tables,
  });
  const [created] = await createAdapterStoreWithSchema(graph, backend, {
    history: true,
  });
  const store = created as unknown as CollisionStore;

  connection.exec("BEGIN");
  const outcomes = await Promise.allSettled(
    ["a", "b"].map((id) =>
      store.withRecordedTransaction(
        connectionDb as never,
        (tx: AdoptedTransaction) => tx.nodes.Note.create({ label: id }, { id }),
      ),
    ),
  );
  connection.exec("COMMIT");

  const anchors = connection
    .prepare(
      "SELECT revision FROM typegraph_recorded_anchors WHERE graph_id = ? ORDER BY revision",
    )
    .all(graph.id);
  const live = await store.nodes.Note.find();
  expectObservation({
    lane: { driver: "better-sqlite3" },
    observed: {
      outcomes: outcomes.map((outcome) =>
        outcome.status === "fulfilled" ? "committed" : String(outcome.reason),
      ),
      anchors,
      live: live.map((note): string => note.id).toSorted(),
    },
    correct: {
      outcomes: ["committed", "committed"],
      anchors: [{ revision: 1 }, { revision: 2 }],
      live: ["a", "b"],
    },
    defects: [
      {
        label: "recorded-anchor collision",
        on: { driver: ["better-sqlite3"] },
        today: {
          outcomes: [
            "committed",
            "SqliteError: UNIQUE constraint failed: typegraph_recorded_anchors.graph_id, typegraph_recorded_anchors.origin, typegraph_recorded_anchors.revision",
          ],
          anchors: [{ revision: 1 }],
          live: ["a", "b"],
        },
      },
    ],
  });
});
