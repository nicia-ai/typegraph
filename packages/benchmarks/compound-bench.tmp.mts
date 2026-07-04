/**
 * Compound-operation comparison bench. Run verbatim from
 * packages/benchmarks in BOTH the 0.34.0 worktree and the current tree:
 * uses only store APIs that exist in both versions.
 * Usage: npx tsx compound-bench.tmp.ts [--postgres]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
  type GraphBackend,
} from "@nicia-ai/typegraph";
import { importGraph } from "@nicia-ai/typegraph/interchange";
import { createLocalSqliteBackend } from "@nicia-ai/typegraph/sqlite/local";
import { createPostgresBackend } from "@nicia-ai/typegraph/postgres";

const usePostgres = process.argv.includes("--postgres");

const Doc = defineNode("Doc", {
  schema: z.object({
    title: searchable({ language: "english" }),
    body: z.string(),
    category: z.string(),
    embedding: embedding(16),
  }),
});
const Hub = defineNode("Hub", { schema: z.object({ name: z.string() }) });
const Spoke = defineNode("Spoke", { schema: z.object({ name: z.string() }) });
const links = defineEdge("links", { schema: z.object({}) });
const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const WORDS = [
  "signal",
  "noise",
  "climate",
  "energy",
  "policy",
  "carbon",
  "relay",
  "sensor",
];
function vec(seed: number): number[] {
  return Array.from({ length: 16 }, (_, index) =>
    Math.sin(seed * 31 + index * 17),
  );
}
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
function report(label: string, ms: number, unit = "ms"): void {
  console.log(`RESULT\t${label}\t${ms.toFixed(3)}\t${unit}`);
}

function docProps(index: number) {
  return {
    title: `${WORDS[index % WORDS.length]} ${WORDS[(index + 3) % WORDS.length]} document ${index}`,
    body: "lorem ipsum dolor sit amet consectetur adipiscing elit ".repeat(4),
    category: `cat-${index % 5}`,
    embedding: vec(index),
  };
}

async function makeBackend(
  graphSuffix: string,
): Promise<{ backend: GraphBackend; cleanup: () => Promise<void> }> {
  if (usePostgres) {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
    const backend = createPostgresBackend(drizzle(pool));
    return {
      backend,
      cleanup: async () => {
        await pool.end();
      },
    };
  }
  const { backend } = createLocalSqliteBackend();
  return { backend, cleanup: async () => backend.close() };
}

const engine = usePostgres ? "pg" : "sqlite-mem";
const runTag = `cmp_${Date.now().toString(36)}`;

// ---------- bulkCreate 5000 docs ----------
{
  const { backend, cleanup } = await makeBackend("bulk");
  const graph = defineGraph({
    id: `${runTag}_bulk`,
    nodes: { Doc: { type: Doc } },
    edges: {},
  });
  const [store] = await createStoreWithSchema(graph, backend);
  const items = Array.from({ length: 5000 }, (_, index) => ({
    props: docProps(index),
  }));
  const start = performance.now();
  await store.nodes.Doc.bulkCreate(items);
  report(
    `${engine} bulkCreate 5000 docs (fulltext+embedding)`,
    performance.now() - start,
  );
  await cleanup();
}

// ---------- importGraph 10k nodes + 15k edges ----------
{
  const { backend, cleanup } = await makeBackend("import");
  const graph = defineGraph({
    id: `${runTag}_imp`,
    nodes: { Person: { type: Person } },
    edges: { links: { type: links, from: [Person], to: [Person] } },
  });
  const [store] = await createStoreWithSchema(graph, backend);
  const nodes = Array.from({ length: 10_000 }, (_, index) => ({
    kind: "Person",
    id: `p${index}`,
    properties: { name: `person ${index}` },
  }));
  const edges = Array.from({ length: 15_000 }, (_, index) => ({
    kind: "links",
    id: `e${index}`,
    from: { kind: "Person", id: `p${index % 10_000}` },
    to: { kind: "Person", id: `p${(index * 7 + 1) % 10_000}` },
    properties: {},
  }));
  const start = performance.now();
  await importGraph(store, { nodes, edges }, {
    onConflict: "skip",
    batchSize: 500,
  } as never);
  const elapsed = performance.now() - start;
  report(`${engine} importGraph 25k entities`, elapsed);
  report(
    `${engine} importGraph entities/s`,
    25_000 / (elapsed / 1000),
    "per-s",
  );
  await cleanup();
}

// ---------- cascade delete: hub with 50 edges ----------
{
  const { backend, cleanup } = await makeBackend("cascade");
  const graph = defineGraph({
    id: `${runTag}_casc`,
    nodes: { Hub: { type: Hub, onDelete: "cascade" }, Spoke: { type: Spoke } },
    edges: { links: { type: links, from: [Hub], to: [Spoke] } },
  });
  const [store] = await createStoreWithSchema(graph, backend);
  const spokes = [];
  for (let index = 0; index < 50; index++) {
    spokes.push(
      await store.nodes.Spoke.create(
        { name: `s${index}` },
        { id: `s${index}` },
      ),
    );
  }
  await store.refreshStatistics();
  const iterations = usePostgres ? 20 : 40;
  const samples: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const hub = await store.nodes.Hub.create(
      { name: "hub" },
      { id: `h${iteration}` },
    );
    for (const spoke of spokes) await store.edges.links.create(hub, spoke, {});
    const start = performance.now();
    await store.nodes.Hub.delete(hub.id);
    samples.push(performance.now() - start);
  }
  report(`${engine} cascade delete (50 edges)`, median(samples));
  await cleanup();
}

// ---------- hybrid search over 2000 docs ----------
{
  const { backend, cleanup } = await makeBackend("hybrid");
  const graph = defineGraph({
    id: `${runTag}_hyb`,
    nodes: { Doc: { type: Doc } },
    edges: {},
  });
  const [store] = await createStoreWithSchema(graph, backend);
  await store.nodes.Doc.bulkCreate(
    Array.from({ length: 2000 }, (_, index) => ({ props: docProps(index) })),
  );
  // Recommended setup: refresh planner statistics after a bulk load.
  await store.refreshStatistics();
  const query = vec(7);
  const iterations = usePostgres ? 150 : 200;
  for (let index = 0; index < 20; index++) {
    await store.search.hybrid("Doc", {
      vector: { fieldPath: "embedding", queryEmbedding: query },
      fulltext: { query: "signal energy" },
      limit: 10,
    });
  }
  const samples: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await store.search.hybrid("Doc", {
      vector: { fieldPath: "embedding", queryEmbedding: query },
      fulltext: { query: "signal energy" },
      limit: 10,
    });
    samples.push(performance.now() - start);
  }
  report(`${engine} hybrid search (2000 docs)`, median(samples));
  await cleanup();
}

// ---------- PG-only: read hydration + recorded tx ----------
if (usePostgres) {
  {
    const { backend, cleanup } = await makeBackend("read");
    const graph = defineGraph({
      id: `${runTag}_read`,
      nodes: { Doc: { type: Doc } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend);
    await store.nodes.Doc.bulkCreate(
      Array.from({ length: 5000 }, (_, index) => ({ props: docProps(index) })),
    );
    await store.refreshStatistics();
    await store.nodes.Doc.find({ limit: 5000 });
    const samples: number[] = [];
    for (let index = 0; index < 25; index++) {
      const start = performance.now();
      const rows = await store.nodes.Doc.find({ limit: 5000 });
      samples.push(performance.now() - start);
      if (rows.length !== 5000) throw new Error("read drift");
    }
    report(`pg find() 5000 rows (full hydration)`, median(samples));
    await cleanup();
  }
  {
    const { backend, cleanup } = await makeBackend("recorded");
    const graph = defineGraph({
      id: `${runTag}_rec`,
      nodes: { Person: { type: Person } },
      edges: {},
    });
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    await store.nodes.Person.create({ name: "warm" });
    const samples: number[] = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const start = performance.now();
      await store.transaction(async (tx) => {
        for (let index = 0; index < 50; index++) {
          await tx.nodes.Person.create({ name: `t${iteration}-${index}` });
        }
      });
      samples.push(performance.now() - start);
    }
    report(`pg recorded tx (50 creates, history on)`, median(samples));
    await cleanup();
  }
}
console.log("DONE");
