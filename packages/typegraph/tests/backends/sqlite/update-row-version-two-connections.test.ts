/**
 * An update and a concurrent move of the same row, on two better-sqlite3
 * connections to one WAL file.
 *
 * The server PostgreSQL lanes run this schedule in the shared suite
 * (`tests/backends/integration/update-row-version.ts`): there the second
 * session's move commits between the update's read and its write, and the
 * update's version-predicated write is what keeps the stored row and its
 * claims in step. SQLite cannot reach that schedule at all: a store write runs
 * in `BEGIN IMMEDIATE`, which takes the database's one writer slot before the
 * update reads the row, so the other connection's move is refused busy while
 * the update is between its read and its write. This case puts the move in
 * exactly that window on a real second connection, catches both outcomes, and
 * asserts what survived: the update's row, its one claim, a create of the
 * stored value refused and the value the row never left still held.
 *
 * The second connection waits for nothing (`timeout: 0`): better-sqlite3 is
 * synchronous, so a busy wait would block the one event loop both
 * connections share.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generateSqliteDDL } from "../../../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import { type TransactionBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { requireDefined } from "../../../src/utils/presence";

const TwoEvent = defineNode("TwoEvent", {
  schema: z.object({ name: z.string(), at: z.date() }),
});
const TwoTag = defineNode("TwoTag", {
  schema: z.object({ name: z.string(), code: z.string() }),
});

const graph = defineGraph({
  id: "update_row_version_two_connections",
  nodes: {
    TwoEvent: {
      type: TwoEvent,
      unique: [
        {
          name: "TwoEvent_at",
          fields: ["at"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    TwoTag: {
      type: TwoTag,
      unique: [
        {
          name: "TwoTag_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});

type Shape = Readonly<{
  name: string;
  kind: "TwoEvent" | "TwoTag";
  constraintName: string;
  field: "at" | "code";
  before: unknown;
  after: unknown;
  text: (value: unknown) => string;
}>;

const SHAPES: readonly Shape[] = [
  {
    name: "a unique z.date() field",
    kind: "TwoEvent",
    constraintName: "TwoEvent_at",
    field: "at",
    before: new Date("2024-01-01T00:00:00.000Z"),
    after: new Date("2024-01-02T00:00:00.000Z"),
    text: (value) => new Date(String(value)).toISOString(),
  },
  {
    name: "a unique z.string() field",
    kind: "TwoTag",
    constraintName: "TwoTag_code",
    field: "code",
    before: "code-1",
    after: "code-2",
    text: String,
  },
];

type Collection = Readonly<{
  create: (props: never, options?: { id?: string }) => Promise<unknown>;
  getById: (id: never) => Promise<Record<string, unknown> | undefined>;
  update: (id: never, props: never) => Promise<unknown>;
}>;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function openTwoConnections() {
  const directory = await mkdtemp(path.join(tmpdir(), "typegraph-rowver-"));
  const file = path.join(directory, "graph.db");
  const first = new Database(file);
  first.pragma("journal_mode = WAL");
  first.pragma("busy_timeout = 5000");
  for (const statement of generateSqliteDDL()) first.exec(statement);
  const second = new Database(file, { timeout: 0 });
  cleanups.push(async () => {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    first: createSqliteBackend(drizzle(first)),
    second: createSqliteBackend(drizzle(second)),
  };
}

/** Runs `intervene` after the first in-transaction read of `id` on `backend`. */
function interleaveAfterRead(
  backend: GraphBackend,
  id: string,
  intervene: () => Promise<void>,
) {
  const state = { armed: false };
  function interleaved(target: TransactionBackend) {
    return deriveBackend(target, {
      getNode: async (graphId: string, kind: string, nodeId: string) => {
        const row = await target.getNode(graphId, kind, nodeId);
        if (state.armed && nodeId === id) {
          state.armed = false;
          await intervene();
        }
        return row;
      },
    } as never);
  }
  return {
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(interleaved(tx)), options),
    }),
    arm: () => {
      state.armed = true;
    },
  };
}

async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

describe("an update and a concurrent move on two SQLite connections", () => {
  for (const shape of SHAPES) {
    it(`the move is refused inside the update's window and the update's row and claim survive (${shape.name})`, async () => {
      const connections = await openTwoConnections();
      const [moverStore] = await createStoreWithSchema(
        graph,
        connections.second,
      );
      const mover = moverStore.nodes[shape.kind] as unknown as Collection;
      const moved: { outcome?: string } = {};
      const interleaver = interleaveAfterRead(
        connections.first,
        "row",
        async () => {
          moved.outcome = await outcome(() =>
            mover.update(
              "row" as never,
              { [shape.field]: shape.after } as never,
            ),
          );
        },
      );
      const [store] = await createStoreWithSchema(graph, interleaver.backend);
      const nodes = store.nodes[shape.kind] as unknown as Collection;
      await nodes.create(
        { name: "row", [shape.field]: shape.before } as never,
        { id: "row" },
      );

      interleaver.arm();
      const updated = await outcome(() =>
        nodes.update("row" as never, { name: "renamed" } as never),
      );

      const stored = requireDefined(await nodes.getById("row" as never));
      const claims = await connections.first.execute<{ key: string }>(
        asCompiledRowsSql(sql`
          SELECT key FROM ${sql.identifier(createSqlSchema(connections.first.tableNames).tables.uniques)}
          WHERE graph_id = ${graph.id}
            AND constraint_name = ${shape.constraintName}
            AND deleted_at IS NULL
        `),
      );
      expect({
        mover: moved.outcome,
        updated,
        name: stored["name"],
        value: shape.text(stored[shape.field]),
        claims: claims.map((row) => row.key),
        duplicate: await outcome(() =>
          nodes.create({ name: "dup", [shape.field]: shape.before } as never),
        ),
        vacated: await outcome(() =>
          nodes.create({
            name: "vacated",
            [shape.field]: shape.after,
          } as never),
        ),
      }).toEqual({
        mover: "SqliteError",
        updated: "written",
        name: "renamed",
        value: shape.text(shape.before),
        claims: [
          computeUniqueKey(
            { [shape.field]: shape.before },
            [shape.field],
            "binary",
          ),
        ],
        duplicate: "UniquenessError",
        vacated: "written",
      });
    });
  }
});
