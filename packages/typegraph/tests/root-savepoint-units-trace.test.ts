/**
 * The statements a Store over a backend built on a caller's transaction
 * issues for calls awaited in sequence, pinned as a golden per engine.
 *
 * Each call that writes opens a savepoint on the caller's transaction and is
 * a unit of it (`src/store/root-savepoint-units.ts`); the bookkeeping that
 * refuses an overlapping call adds no statement, so calls awaited in sequence
 * issue exactly the statements they issued before it: each write's SAVEPOINT,
 * its statements and its RELEASE, and a read on the caller's transaction
 * itself.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createAdapterStoreWithSchema, defineGraph, defineNode } from "../src";
import { createPostgresTables } from "../src/backend/drizzle/schema/postgres";
import { createSqliteTables } from "../src/backend/drizzle/schema/sqlite";
import { createPostgresBackend } from "../src/backend/postgres";
import { createSqliteBackend } from "../src/backend/sqlite";
import type { AdapterBackend } from "../src/backend/types";
import { requireDefined } from "../src/utils/presence";
import {
  openTracedLibsqlConnection,
  openTracedPgliteConnection,
  prefixedTableNames,
  type TracedConnection,
} from "./helpers/traced-connection";

const TraceItem = defineNode("TraceItem", {
  schema: z.object({ label: z.string() }),
});

const graph = defineGraph({
  id: "root_savepoint_units_trace",
  nodes: { TraceItem: { type: TraceItem } },
  edges: {},
});

const TABLE_NAMES = prefixedTableNames("rsu");

type Lane = Readonly<{
  name: "pglite" | "libsql";
  open: () => Promise<TracedConnection>;
  overCallerTransaction: (native: unknown) => AdapterBackend<unknown>;
}>;

const LANES: readonly Lane[] = [
  {
    name: "pglite",
    open: () => openTracedPgliteConnection([TABLE_NAMES]),
    overCallerTransaction: (native) =>
      createPostgresBackend(native as never, {
        tables: createPostgresTables(TABLE_NAMES),
      }) as AdapterBackend<unknown>,
  },
  {
    name: "libsql",
    open: () => openTracedLibsqlConnection([TABLE_NAMES]),
    overCallerTransaction: (native) =>
      createSqliteBackend(native as never, {
        tables: createSqliteTables(TABLE_NAMES),
        executionProfile: { transactionMode: "drizzle" },
      }) as AdapterBackend<unknown>,
  },
];

/** One statement as text with its whitespace collapsed. */
function statementText(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

describe("a Store over a backend built on a caller's transaction", () => {
  for (const lane of LANES) {
    it(`issues the same statements for calls awaited in sequence (${lane.name})`, async () => {
      const connection = await lane.open();
      try {
        const root = requireDefined(connection.backends[0]);
        await createAdapterStoreWithSchema(graph, root);
        const statements = await root.transactionWithNative(
          async (_target, native) => {
            const [store] = await createAdapterStoreWithSchema(
              graph,
              lane.overCallerTransaction(native),
            );
            connection.reset();
            await store.nodes.TraceItem.create({ label: "a" }, { id: "a" });
            await store.transaction(async (tx) => {
              await tx.nodes.TraceItem.create({ label: "b" }, { id: "b" });
            });
            await store.nodes.TraceItem.find();
            return connection
              .statements()
              .map((statement) => statementText(statement.text));
          },
        );
        await expect(`${statements.join("\n")}\n`).toMatchFileSnapshot(
          `./__snapshots__/root-savepoint-units-trace/${lane.name}.sql`,
        );
      } finally {
        await connection.close();
      }
    });
  }
});
