import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineEdge, defineGraph, defineNode } from "../../../src";
import { createPostgresBackend } from "../../../src/backend/drizzle/postgres";
import { createPostgresTables } from "../../../src/backend/drizzle/schema/postgres";
import { createPostgresWorkingCopyManager } from "../../../src/backend/postgres/working-copy";
import { branchDurable } from "../../../src/graph-merge";
import { isOk, unwrap } from "../../../src/graph-merge/result";
import { asBranchId } from "../../../src/graph-merge/types";
import { rollbackSchema } from "../../../src/schema";
import { storeBackend } from "../../../src/store/runtime-port";
import { provisionPostgresTestDatabase } from "../../postgres-test-database";

const URL_ = await provisionPostgresTestDatabase(import.meta.url);
const A = defineNode("A", { schema: z.object({}) });
const B = defineNode("B", { schema: z.object({}) });
const rel = defineEdge("rel", { schema: z.object({}) });
const GRAPH_ID = "probe-clone-fixed-rollback";
const tight = defineGraph({ id: GRAPH_ID, nodes: { A: { type: A }, B: { type: B } }, edges: { rel: { type: rel, from: [A], to: [B], cardinality: "one" } } });
const loose = defineGraph({ id: GRAPH_ID, nodes: { A: { type: A }, B: { type: B } }, edges: { rel: { type: rel, from: [A], to: [B], cardinality: "many" } } });

afterEach(() => vi.restoreAllMocks());

describe.runIf(process.env["POSTGRES_URL"])("fixed-schema working copy", () => {
  it("clone-fixed-schema-rollback-preflight-unguarded: a managed working copy refuses a rollback that owes a preflight", async () => {
    // Works around the allocation name collision so the guard itself is reachable.
    const realSlice = String.prototype.slice;
    vi.spyOn(String.prototype, "slice").mockImplementation(function (this: string, ...args: [number?, number?]) {
      if (String(this) === "identityTransitionRetention" && args[0] === 0 && args[1] === 15) return "identityTransRet";
      return realSlice.apply(this, args);
    });
    const pool = new Pool({ connectionString: URL_, max: 6 });
    try {
      const control = createPostgresBackend(drizzle(pool));
      const [v1] = await createStoreWithSchema(tight, control, { history: true, revisionTracking: true });
      expect(v1).toBeDefined();
      const [source] = await createStoreWithSchema(loose, control, { history: true, revisionTracking: true });
      const manager = createPostgresWorkingCopyManager<typeof loose>({
        control,
        connect: (names) => Promise.resolve(createPostgresBackend(drizzle(pool), { tables: createPostgresTables(names) })),
      });
      const result = await branchDurable(source, manager.durable, { id: asBranchId("c1"), allocationId: "clone-rollback-alloc" });
      expect(isOk(result) ? undefined : (result as { error: Error }).error.cause).toBeUndefined();
      const { branch } = unwrap(result);
      const backend = storeBackend(branch.store);
      const before = await backend.getActiveSchema(GRAPH_ID);
      await expect(backend.setActiveVersion({ graphId: GRAPH_ID, expected: { kind: "active", version: before?.version ?? 0 }, version: 1 })).rejects.toThrow(/fixed schema/);
      await expect(rollbackSchema(backend, GRAPH_ID, 1)).rejects.toThrow(/fixed schema/);
      const after = await backend.getActiveSchema(GRAPH_ID);
      expect(after?.version).toBe(before?.version);
    } finally {
      await pool.end();
    }
  });
});
