import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createStoreWithSchema, defineGraph, defineNode } from "../../src";
import { createPostgresBackend } from "../../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import {
  forkGraphNamespace,
  installNamespaceForkLedger,
} from "../../src/graph-merge/namespace-fork";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "namespace-fork-fidelity",
  nodes: { Item: { type: Item } },
  edges: {},
});
const otherGraph = defineGraph({
  id: "namespace-fork-unrelated",
  nodes: { Item: { type: Item } },
  edges: {},
});

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe("forkGraphNamespace", () => {
  it("requires owner-side retry ledger installation", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await expect(
      forkGraphNamespace(source, targetFixture.backend, "missing-ledger"),
    ).rejects.toThrow("installNamespaceForkLedger");
    const relation = await targetFixture.client.query<{
      relation: string | null;
    }>(
      "SELECT to_regclass('typegraph_namespace_fork_operations')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
  });

  it("copies recorded history and tombstones, and returns the same proof on retry", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    await installNamespaceForkLedger(targetFixture.backend);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    const [unrelatedSource] = await createStoreWithSchema(
      otherGraph,
      sourceFixture.backend,
      { history: true },
    );
    const [unrelatedTarget] = await createStoreWithSchema(
      otherGraph,
      targetFixture.backend,
      { history: true },
    );
    const unrelatedSourceItem = await unrelatedSource.nodes.Item.create({
      name: "source-only",
    });
    const unrelatedTargetItem = await unrelatedTarget.nodes.Item.create({
      name: "target-only",
    });
    const item = await source.nodes.Item.create({ name: "before" });
    const recorded = await source.recordedNow();
    expect(recorded).toBeDefined();
    if (recorded === undefined) throw new Error("recorded instant missing");
    await source.nodes.Item.update(item.id, { name: "after" });
    const deleted = await source.nodes.Item.create({ name: "deleted" });
    await source.nodes.Item.delete(deleted.id);

    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "restore-1",
    );
    expect(fork.store.historyEnabled).toBe(true);
    expect((await fork.store.nodes.Item.getById(item.id))?.name).toBe("after");
    expect(
      (await fork.store.asOfRecorded(recorded).nodes.Item.getById(item.id))
        ?.name,
    ).toBe("before");
    expect(await fork.store.nodes.Item.getById(deleted.id)).toBeUndefined();
    expect(fork.proof.contentDigest).toMatch(/^[a-f\d]{64}$/);
    expect(
      (await unrelatedTarget.nodes.Item.getById(unrelatedTargetItem.id))?.name,
    ).toBe("target-only");
    expect(
      await unrelatedTarget.nodes.Item.getById(unrelatedSourceItem.id),
    ).toBeUndefined();

    const retry = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "restore-1",
    );
    expect(retry.proof).toEqual(fork.proof);
    await expect(
      forkGraphNamespace(source, targetFixture.backend, "restore-2"),
    ).rejects.toThrow("already contains this graph");
    await fork.abort();
    const afterAbort = await targetFixture.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_nodes WHERE graph_id = 'namespace-fork-fidelity'",
    );
    expect(afterAbort.rows[0]?.count).toBe("0");
    expect(
      (await unrelatedTarget.nodes.Item.getById(unrelatedTargetItem.id))?.name,
    ).toBe("target-only");
  });

  it("refuses strategy-owned contributions before copying any target rows", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    await installNamespaceForkLedger(targetFixture.backend);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await source.nodes.Item.create({ name: "source" });
    await sourceFixture.client
      .exec(`INSERT INTO typegraph_contribution_materializations
      (graph_id, logical_name, owner, table_name, signature, last_attempted_at)
      VALUES ('namespace-fork-fidelity', 'owned', 'test', 'test_owned_table', 'sig', now())`);

    await expect(
      forkGraphNamespace(source, targetFixture.backend, "contribution-refusal"),
    ).rejects.toThrow("strategy-owned contribution tables");
    const targetRows = await targetFixture.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_nodes WHERE graph_id = 'namespace-fork-fidelity'",
    );
    expect(targetRows.rows[0]?.count).toBe("0");
  });

  it("refuses a write between the source stamp and its snapshot without populating the target", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    await installNamespaceForkLedger(targetFixture.backend);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    const item = await source.nodes.Item.create({ name: "before" });
    const revisionNow = source.revisionNow.bind(source);
    vi.spyOn(source, "revisionNow").mockImplementationOnce(async () => {
      const revision = await revisionNow();
      await source.nodes.Item.update(item.id, { name: "raced" });
      return revision;
    });

    await expect(
      forkGraphNamespace(source, targetFixture.backend, "race-refusal"),
    ).rejects.toThrow("Source advanced before the namespace fork snapshot");
    const targetRows = await targetFixture.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_nodes WHERE graph_id = 'namespace-fork-fidelity'",
    );
    expect(targetRows.rows[0]?.count).toBe("0");
  });

  it("refuses a second backend pointing at the source database before making a ledger", async () => {
    const fixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(fixture.backend.close);
    const [source] = await createStoreWithSchema(graph, fixture.backend, {
      history: true,
    });
    await source.nodes.Item.create({ name: "source" });
    const aliased = createPostgresBackend(fixture.db, { vector: false });

    await expect(
      forkGraphNamespace(source, aliased, "aliased"),
    ).rejects.toThrow(
      /share one backend transaction resource|connects to the source database/,
    );
    const relation = await fixture.client.query<{ relation: string | null }>(
      "SELECT to_regclass('typegraph_namespace_fork_operations')::text AS relation",
    );
    expect(relation.rows[0]?.relation).toBeNull();
  });
});
