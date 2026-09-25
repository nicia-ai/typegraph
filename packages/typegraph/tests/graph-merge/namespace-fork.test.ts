import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  defineNodeIndex,
  embedding,
  type Store,
} from "../../src";
import { createPostgresBackend } from "../../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { installRevisionChangesJournal } from "../../src/backend/revision-journal";
import {
  forkGraphNamespace,
  prepareNamespaceForkTarget,
} from "../../src/graph-merge/namespace-fork";

const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const graph = defineGraph({
  id: "namespace-fork-fidelity",
  nodes: { Item: { type: Item } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});
const otherGraph = defineGraph({
  id: "namespace-fork-unrelated",
  nodes: { Item: { type: Item } },
  edges: {},
});

const Doc = defineNode("Doc", {
  schema: z.object({ title: z.string(), embedding: embedding(3) }),
});
const vectorGraph = defineGraph({
  id: "namespace-fork-vectors",
  nodes: { Doc: { type: Doc } },
  edges: {},
  indexes: [defineNodeIndex(Doc, { name: "doc_title_idx", fields: ["title"] })],
});
const ClusteredDoc = defineNode("ClusteredDoc", {
  schema: z.object({
    title: z.string(),
    embedding: embedding(3, { indexType: "ivfflat", lists: 1 }),
  }),
});
const clusteredGraph = defineGraph({
  id: "namespace-fork-ivfflat",
  nodes: { ClusteredDoc: { type: ClusteredDoc } },
  edges: {},
});
const QUERY = [1, 0, 0];

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
    ).rejects.toThrow("prepareNamespaceForkTarget");
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
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await prepareNamespaceForkTarget(source, targetFixture.backend);
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

  it("validates identity assertions when the target has revision journal triggers", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    await createStoreWithSchema(otherGraph, targetFixture.backend, {
      history: true,
    });
    await installRevisionChangesJournal(targetFixture.backend);
    const first = await source.nodes.Item.create({ name: "first" });
    const second = await source.nodes.Item.create({ name: "second" });
    await source.identity.assertSame(first, second);

    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "identity-journal-fork",
    );
    expect(await fork.store.identity.assertionsOf(first)).toHaveLength(1);
    expect(fork.proof.contentDigest).toMatch(/^[a-f\d]{64}$/);
  });

  it("refuses strategy-owned contributions before copying any target rows", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    await source.nodes.Item.create({ name: "source" });
    await sourceFixture.client
      .exec(`INSERT INTO typegraph_contribution_materializations
      (graph_id, logical_name, owner, table_name, signature, last_attempted_at)
      VALUES ('namespace-fork-fidelity', 'owned', 'test', 'test_owned_table', 'sig', now())`);

    await expect(
      forkGraphNamespace(source, targetFixture.backend, "contribution-refusal"),
    ).rejects.toThrow("bundled tsvector and pgvector contribution tables");
    const targetRows = await targetFixture.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_nodes WHERE graph_id = 'namespace-fork-fidelity'",
    );
    expect(targetRows.rows[0]?.count).toBe("0");
  });

  it("refuses a write between the source stamp and its snapshot without populating the target", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(graph, sourceFixture.backend, {
      history: true,
    });
    await prepareNamespaceForkTarget(source, targetFixture.backend);
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

describe("forkGraphNamespace with pgvector storage", () => {
  async function vectorSource() {
    const sourceFixture = await createLocalPgliteBackend();
    const targetFixture = await createLocalPgliteBackend();
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(
      vectorGraph,
      sourceFixture.backend,
      { history: true },
    );
    const near = await source.nodes.Doc.create({
      title: "near",
      embedding: [0.9, 0.1, 0],
    });
    const far = await source.nodes.Doc.create({
      title: "far",
      embedding: [0, 0, 1],
    });
    const results = await source.materializeIndexes();
    expect(results.results.map((entry) => entry.status)).not.toContain(
      "failed",
    );
    return { source, sourceFixture, targetFixture, near, far };
  }

  async function nearestTitles(
    store: Store<typeof vectorGraph>,
  ): Promise<readonly string[]> {
    const rows = await store
      .query()
      .from("Doc", "d")
      .whereNode("d", (d) => d.embedding.similarTo(QUERY, 2))
      .select((ctx) => ({ title: ctx.d.title }))
      .execute();
    return rows.map((row) => row.title);
  }

  async function physicalIndexes(
    client: Awaited<ReturnType<typeof createLocalPgliteBackend>>["client"],
  ): Promise<readonly string[]> {
    const rows = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND (indexname LIKE 'tg_vecidx%' OR indexname = 'doc_title_idx') ORDER BY indexname",
    );
    return rows.rows.map((row) => row.indexname);
  }

  it("copies embeddings, and the prepared target has the source's ANN and relational indexes", async () => {
    const { source, sourceFixture, targetFixture, near } = await vectorSource();
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    expect(await physicalIndexes(targetFixture.client)).toEqual(
      await physicalIndexes(sourceFixture.client),
    );
    expect(await physicalIndexes(targetFixture.client)).toHaveLength(2);

    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "vector-fork",
    );

    expect((await fork.store.nodes.Doc.getById(near.id))?.embedding).toEqual(
      near.embedding,
    );
    expect(await nearestTitles(fork.store)).toEqual(
      await nearestTitles(source),
    );
    expect(await nearestTitles(fork.store)).toEqual(["near", "far"]);
    const retry = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "vector-fork",
    );
    expect(retry.proof).toEqual(fork.proof);
  });

  it("covers embeddings in the digest a retry verifies", async () => {
    const { source, targetFixture, near } = await vectorSource();
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    await forkGraphNamespace(source, targetFixture.backend, "vector-digest");
    const table = await targetFixture.client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'tg_vec%'",
    );
    const tableName = table.rows[0]?.name;
    if (tableName === undefined) throw new Error("vector table missing");
    await targetFixture.client.query(
      `UPDATE "${tableName}" SET embedding = '[0,1,0]' WHERE node_id = $1`,
      [near.id],
    );

    await expect(
      forkGraphNamespace(source, targetFixture.backend, "vector-digest"),
    ).rejects.toThrow("changed target namespace");
  });

  it("aborts by removing the copied embeddings and keeping the prepared tables", async () => {
    const { source, targetFixture } = await vectorSource();
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "vector-abort",
    );

    await fork.abort();

    const vectorTable = await targetFixture.client.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE 'tg_vec%'",
    );
    expect(vectorTable.rows).toHaveLength(1);
    const remaining = await targetFixture.client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${vectorTable.rows[0]?.name ?? ""}"`,
    );
    expect(remaining.rows[0]?.count).toBe("0");
    const second = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "vector-after-abort",
    );
    expect(await nearestTitles(second.store)).toEqual(["near", "far"]);
  });

  it("refuses an unprepared target before copying any rows", async () => {
    const { source, targetFixture } = await vectorSource();
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    await targetFixture.client.exec("DROP INDEX doc_title_idx");

    await expect(
      forkGraphNamespace(source, targetFixture.backend, "vector-unprepared"),
    ).rejects.toThrow("prepareNamespaceForkTarget");
    const targetRows = await targetFixture.client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_nodes WHERE graph_id = 'namespace-fork-vectors'",
    );
    expect(targetRows.rows[0]?.count).toBe("0");
  });

  it("neither replays nor requires an index whose build never completed", async () => {
    const { source, sourceFixture, targetFixture } = await vectorSource();
    await sourceFixture.client.exec(
      "DROP INDEX doc_title_idx; UPDATE typegraph_index_materializations SET materialized_at = NULL WHERE index_name = 'doc_title_idx'",
    );

    await prepareNamespaceForkTarget(source, targetFixture.backend);
    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "vector-unbuilt-index",
    );

    expect(await physicalIndexes(targetFixture.client)).toHaveLength(1);
    expect(await nearestTitles(fork.store)).toEqual(["near", "far"]);
  });

  it("refuses a target opened without vector storage", async () => {
    const { source } = await vectorSource();
    const vectorless = await createLocalPgliteBackend({ vector: false });
    cleanups.push(vectorless.backend.close);

    await expect(
      prepareNamespaceForkTarget(source, vectorless.backend),
    ).rejects.toThrow("same vector storage");
    await expect(
      forkGraphNamespace(source, vectorless.backend, "vectorless-target"),
    ).rejects.toThrow("same vector storage");
  });

  it("refuses a source opened without vector storage, whose vector tables were never written", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend();
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(
      vectorGraph,
      sourceFixture.backend,
      { history: true },
    );
    await source.nodes.Doc.create({ title: "near", embedding: [0.9, 0.1, 0] });

    await expect(
      prepareNamespaceForkTarget(source, targetFixture.backend),
    ).rejects.toThrow("the source has none and the target has pgvector");
    await expect(
      forkGraphNamespace(source, targetFixture.backend, "vectorless-source"),
    ).rejects.toThrow("the source has none and the target has pgvector");
  });

  it("forks between two vector-disabled backends, keeping embeddings in properties", async () => {
    const sourceFixture = await createLocalPgliteBackend({ vector: false });
    const targetFixture = await createLocalPgliteBackend({ vector: false });
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(
      vectorGraph,
      sourceFixture.backend,
      { history: true },
    );
    const near = await source.nodes.Doc.create({
      title: "near",
      embedding: [0.9, 0.1, 0],
    });

    await prepareNamespaceForkTarget(source, targetFixture.backend);
    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "both-vectorless",
    );

    expect((await fork.store.nodes.Doc.getById(near.id))?.embedding).toEqual(
      near.embedding,
    );
  });
});

describe("forkGraphNamespace with an IVFFlat index", () => {
  async function ivfflatIndexes(
    client: Awaited<ReturnType<typeof createLocalPgliteBackend>>["client"],
  ): Promise<readonly string[]> {
    const rows = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND indexdef ILIKE '%USING ivfflat%'",
    );
    return rows.rows.map((row) => row.indexname);
  }

  async function recordedIvfflat(
    client: Awaited<ReturnType<typeof createLocalPgliteBackend>>["client"],
  ): Promise<number> {
    const rows = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM typegraph_index_materializations WHERE graph_id = 'namespace-fork-ivfflat' AND entity = 'vector'",
    );
    return Number(rows.rows[0]?.count);
  }

  it("builds IVFFlat after the copy, and a later materialization keeps retries verifiable", async () => {
    const sourceFixture = await createLocalPgliteBackend();
    const targetFixture = await createLocalPgliteBackend();
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(
      clusteredGraph,
      sourceFixture.backend,
      { history: true },
    );
    await source.nodes.ClusteredDoc.create({
      title: "near",
      embedding: [0.9, 0.1, 0],
    });
    await source.nodes.ClusteredDoc.create({
      title: "far",
      embedding: [0, 0, 1],
    });
    await source.materializeIndexes();
    expect(await ivfflatIndexes(sourceFixture.client)).toHaveLength(1);

    await prepareNamespaceForkTarget(source, targetFixture.backend);
    expect(await ivfflatIndexes(targetFixture.client)).toEqual([]);
    const fork = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "ivfflat-fork",
    );
    expect(await recordedIvfflat(targetFixture.client)).toBe(0);

    const materialized = await fork.store.materializeIndexes();
    expect(
      materialized.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");
    expect(await ivfflatIndexes(targetFixture.client)).toHaveLength(1);
    expect(await recordedIvfflat(targetFixture.client)).toBe(1);

    const retry = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "ivfflat-fork",
    );
    expect(retry.proof).toEqual(fork.proof);
    await retry.abort();
  });

  it("rebuilds an IVFFlat index an aborted fork left behind when the next fork is materialized", async () => {
    const sourceFixture = await createLocalPgliteBackend();
    const targetFixture = await createLocalPgliteBackend();
    cleanups.push(sourceFixture.backend.close, targetFixture.backend.close);
    const [source] = await createStoreWithSchema(
      clusteredGraph,
      sourceFixture.backend,
      { history: true },
    );
    await source.nodes.ClusteredDoc.create({
      title: "near",
      embedding: [0.9, 0.1, 0],
    });
    await source.materializeIndexes();
    const ivfflatOid = async (): Promise<string | undefined> => {
      const rows = await targetFixture.client.query<{ oid: string }>(
        "SELECT c.oid::text AS oid FROM pg_class AS c JOIN pg_indexes AS i ON i.indexname = c.relname WHERE i.schemaname = current_schema() AND i.indexdef ILIKE '%USING ivfflat%'",
      );
      return rows.rows[0]?.oid;
    };

    await prepareNamespaceForkTarget(source, targetFixture.backend);
    const first = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "ivfflat-first",
    );
    await first.store.materializeIndexes();
    const firstIndex = await ivfflatOid();
    expect(firstIndex).toBeDefined();
    await first.abort();
    expect(await ivfflatOid()).toBe(firstIndex);

    await source.nodes.ClusteredDoc.create({
      title: "far",
      embedding: [0, 0, 1],
    });
    await prepareNamespaceForkTarget(source, targetFixture.backend);
    const second = await forkGraphNamespace(
      source,
      targetFixture.backend,
      "ivfflat-second",
    );
    const materialized = await second.store.materializeIndexes();

    expect(
      materialized.results.find((entry) => entry.entity === "vector")?.status,
    ).toBe("created");
    const secondIndex = await ivfflatOid();
    expect(secondIndex).toBeDefined();
    expect(secondIndex).not.toBe(firstIndex);
  });
});
