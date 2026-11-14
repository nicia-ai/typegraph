import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type CompiledRowsSql,
  createStore,
  defineGraph,
  defineNode,
  recordedInstantRevision,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { generateSqliteDDL } from "../../../src/backend/drizzle/ddl";
import { createSqliteBackend } from "../../../src/backend/drizzle/sqlite";
import { requireDefined } from "../../../src/utils/presence";
import { isSqliteWriterSlotBusy } from "../../../src/utils/sql-errors";
import { createGate } from "../../concurrency-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "prune_contention",
  nodes: { Person: { type: Person } },
  edges: {},
});

it("publishes pruning atomically while another WAL connection contends for the writer slot", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "typegraph-prune-"));
  const file = path.join(directory, "graph.db");
  const first = new Database(file);
  const second = new Database(file);
  const reached = createGate();
  const release = createGate();
  try {
    first.pragma("journal_mode = WAL");
    second.pragma("busy_timeout = 0");
    for (const statement of generateSqliteDDL()) first.exec(statement);
    const base = createSqliteBackend(drizzle(first));
    const writer = createStore(graph, createSqliteBackend(drizzle(second)), {
      history: true,
    });
    const pruner = createStore(
      graph,
      deriveBackend(base, {
        transaction(callback, options) {
          return base.transaction(
            (target) =>
              callback(
                deriveBackend(target, {
                  async execute<T>(query: CompiledRowsSql) {
                    const rows = await target.execute<T>(query);
                    const text = requireDefined(base.compileSql)(query).sql;
                    if (
                      text.trimStart().startsWith("UPDATE") &&
                      text.includes("anchor_retention=")
                    ) {
                      reached.open();
                      await release.opened;
                    }
                    return rows;
                  },
                }),
              ),
            options,
          );
        },
      }),
      { history: true },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let index = 0; index < 4; index += 1) {
        vi.setSystemTime(new Date(`2026-06-01T12:00:0${index}.000Z`));
        await writer.nodes.Person.create({ name: `person-${index}` });
      }
    } finally {
      vi.useRealTimers();
    }
    const cutoff = "2026-06-01T12:00:02.000Z";
    const before = requireDefined(
      await writer.resolveRecordedInstant("2026-06-01T12:00:00.000Z"),
    );
    const boundary = requireDefined(
      await writer.resolveRecordedInstant(cutoff),
    );
    const owner = await writer.allocationOwner();
    const pruning = pruner.pruneRecordedInstants(cutoff, { limit: 1 });
    try {
      await reached.opened;
      // A separate WAL reader sees the previous committed metadata, never the half-published watermark.
      expect(
        await writer.resolveRecordedInstant("2026-06-01T12:00:00.000Z"),
      ).toBe(before);
      const writeError: unknown = await writer.nodes.Person.create({
        name: "contender",
      }).catch((error: unknown) => error);
      expect(isSqliteWriterSlotBusy(writeError)).toBe(true);
      const pruneError: unknown = await writer
        .pruneRecordedInstants(cutoff)
        .catch((error: unknown) => error);
      expect(isSqliteWriterSlotBusy(pruneError)).toBe(true);
    } finally {
      release.open();
    }
    expect(await pruning).toEqual({
      deletedCount: 1,
      retainedBoundary: boundary,
      hasMore: true,
    });
    await writer.nodes.Person.create({ name: "after-commit" });
    expect(
      recordedInstantRevision(requireDefined(await writer.recordedNow())),
    ).toBe(5);
    expect(await writer.pruneRecordedInstants(cutoff, { limit: 1 })).toEqual({
      deletedCount: 1,
      retainedBoundary: boundary,
      hasMore: false,
    });
    expect(
      first
        .prepare(
          "SELECT revision FROM typegraph_recorded_anchors WHERE graph_id=? ORDER BY revision",
        )
        .all(graph.id),
    ).toEqual([{ revision: 3 }, { revision: 4 }, { revision: 5 }]);
    expect(await writer.resolveRecordedInstant(cutoff)).toBe(boundary);
    expect(await writer.allocationOwner()).toEqual(owner);
    await expect(
      writer.resolveRecordedInstant("2026-06-01T12:00:01.000Z"),
    ).rejects.toMatchObject({
      details: { code: "RECORDED_LOOKUP_HISTORY_PRUNED" },
    });
    expect(
      await writer.resolveRecordedInstant("2026-06-01T11:59:59.000Z"),
    ).toBeUndefined();
  } finally {
    release.open();
    vi.useRealTimers();
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
