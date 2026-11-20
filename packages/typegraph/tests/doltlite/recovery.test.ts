import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../../src";
import {
  createDoltliteBackend,
  doltliteWorkingCopyStrategy,
} from "../../src/backend/doltlite";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
async function databasePath() {
  const directory = await mkdtemp(path.join(tmpdir(), "doltlite-recovery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "graph.db");
}

it("does not publish an abruptly terminated process's SQL transaction", async () => {
  const filename = await databasePath();
  const original = await createDoltliteBackend({
    path: filename,
    vector: false,
  });
  original.connection.exec(
    "CREATE TABLE recovery_probe(id TEXT PRIMARY KEY); INSERT INTO recovery_probe VALUES ('committed')",
  );
  await original.backend.close();
  const modulePath = createRequire(import.meta.url).resolve(
    "@dolthub/doltlite",
  );
  const child = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const { DatabaseSync } = require(process.argv[1]);
    const db = new DatabaseSync(process.argv[2]);
    db.exec("BEGIN; INSERT INTO recovery_probe VALUES ('uncommitted')");
    process.exit(17);
  `,
      modulePath,
      filename,
    ],
    { timeout: 15_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(17);
  const reopened = await createDoltliteBackend({
    path: filename,
    vector: false,
  });
  cleanups.push(() => reopened.backend.close());
  expect(
    reopened.connection
      .prepare("SELECT id FROM recovery_probe ORDER BY id")
      .all(),
  ).toEqual([{ id: "committed" }]);
});

it("keeps native-branch vector and fulltext indexes isolated and synchronizes them through semantic merge", async () => {
  const filename = await databasePath();
  const { backend } = await createDoltliteBackend({ path: filename });
  cleanups.push(() => backend.close());
  const Document = defineNode("Document", {
    schema: z.object({
      name: searchable(),
      position: embedding(2, { indexType: "none" }),
    }),
  });
  const graph = defineGraph({
    id: "doltlite_branch_vectors",
    nodes: { Document: { type: Document } },
    edges: {},
  });
  const [store] = await createStoreWithSchema(graph, backend);
  const first = await store.nodes.Document.create({
    name: "first",
    position: [1, 0],
  });
  await store.nodes.Document.create({ name: "second", position: [0, 1] });
  const fork = unwrap(
    await branch(
      store,
      () => Promise.reject(new Error("Native fork must not clone")),
      undefined,
      doltliteWorkingCopyStrategy<typeof graph>(),
    ),
  );
  cleanups.push(() => fork.close());
  await fork.store.nodes.Document.update(first.id, {
    name: "edited",
    position: [-1, 0],
  });
  async function searchNames(target: typeof store) {
    return target
      .query()
      .from("Document", "d")
      .whereNode("d", (d) => d.$fulltext.matches("edited", 10))
      .select((c) => c.d.name)
      .execute();
  }
  expect(await searchNames(store)).toEqual([]);
  expect(await searchNames(fork.store)).toEqual(["edited"]);
  const before = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.position.similarTo([1, 0], 1))
    .select((c) => c.d.name)
    .execute();
  const isolated = await fork.store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.position.similarTo([1, 0], 1))
    .select((c) => c.d.name)
    .execute();
  expect(before).toEqual(["first"]);
  expect(isolated).toEqual(["second"]);
  expect(await merge(store, [fork], {})).toMatchObject({ success: true });
  const after = await store
    .query()
    .from("Document", "d")
    .whereNode("d", (d) => d.position.similarTo([1, 0], 1))
    .select((c) => c.d.name)
    .execute();
  expect(after).toEqual(["second"]);
  expect(await searchNames(store)).toEqual(["edited"]);
});
