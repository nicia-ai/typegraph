import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "../../src";
import { createSqliteTables } from "../../src/backend/sqlite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  getStoreOperation,
  operateStore,
  type StoreOperationRequest,
  unwrap,
} from "../../src/graph-merge";
import { requireDefined } from "../../src/utils/presence";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "durable_restart",
  nodes: { Item: { type: Item } },
  edges: {},
});

describe("durable Store operation process recovery", () => {
  it("recovers and replays after the committing process is killed without returning an outcome", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "typegraph-durable-"));
    const databasePath = path.join(directory, "graph.sqlite");
    const requestPath = path.join(directory, "request.json");
    const packageRoot = path.resolve(import.meta.dirname, "../..");
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { writeFileSync } from "node:fs";
      import { z } from "zod";
      import { createStoreWithSchema, defineGraph, defineNode } from "./src/index.ts";
      import { createSqliteTables } from "./src/backend/sqlite/index.ts";
      import { createLocalSqliteBackend } from "./src/backend/sqlite/local.ts";
      import { captureStoreOperationTarget, operateStore, unwrap } from "./src/graph-merge/index.ts";
      const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
      const graph = defineGraph({ id: "durable_restart", nodes: { Item: { type: Item } }, edges: {} });
      const [store] = await createStoreWithSchema(graph, createLocalSqliteBackend({ path: ${JSON.stringify(databasePath)}, tables: createSqliteTables({ storeOperations: "restart_outcomes", recordedAnchors: "restart_anchors", recordedClock: "restart_clock" }) }).backend, { history: true });
      const request = { target: await captureStoreOperationTarget(store), idempotencyKey: "retry-key", mutation: { id: "created" }, metadata: { version: 1 } };
      writeFileSync(${JSON.stringify(requestPath)}, JSON.stringify(request));
      unwrap(await operateStore(store, request, async (tx) => {
        const node = await tx.nodes.Item.create({ name: "created" }, { id: "created" });
        return { id: node.id };
      }));
      process.kill(process.pid, "SIGKILL");
    `,
      ],
      { cwd: packageRoot, encoding: "utf8", timeout: 30_000 },
    );
    try {
      expect(child.error).toBeUndefined();
      expect(child.signal).toBe("SIGKILL");
      const request = JSON.parse(
        await readFile(requestPath, "utf8"),
      ) as StoreOperationRequest;
      const handle = createLocalSqliteBackend({
        path: databasePath,
        tables: createSqliteTables({
          storeOperations: "restart_outcomes",
          recordedAnchors: "restart_anchors",
          recordedClock: "restart_clock",
        }),
      });
      try {
        const [reopened] = await createStoreWithSchema(graph, handle.backend, {
          history: true,
        });
        const evidence = requireDefined(
          unwrap(await getStoreOperation(reopened, request)),
        );
        expect(evidence.result).toEqual({ id: "created" });
        expect(evidence.receipt.writes.nodes["Item"]).toBe(1);
        const replayed = unwrap(
          await operateStore(reopened, request, () => {
            throw new Error("recovery attempted a duplicate mutation");
          }),
        );
        expect(replayed.outcome).toBe("replayed");
        expect(replayed.evidence).toEqual(evidence);
        expect(await reopened.recordedNow()).toBe(evidence.receipt.recorded);
        expect(
          await reopened.nodes.Item.getById(asNodeId("created")),
        ).toMatchObject({ name: "created" });
      } finally {
        await handle.backend.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
