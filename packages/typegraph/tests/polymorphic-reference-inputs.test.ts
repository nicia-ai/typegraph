/**
 * A supertype query is polymorphic by default, and any alias stated
 * `{ expansion: "subclasses" }` is polymorphic whatever the static hierarchy
 * declares, so its rows carry `kind: string` and a widened `NodeId` brand.
 * Every public input that takes a node reference accepts such a row, as edge
 * writes and `neighbors()` do: a composition `partOf.whole`, `subgraph()` on
 * the store, a transaction and a view, and the identity reads. That includes
 * the subclass rows a runtime extension adds under a kind the compile-time
 * graph leaves exact. An arbitrary `{ kind: string, id: string }` object, or
 * the id of another kind with the same properties, is still refused at
 * compile time, and the runtime checks the kind.
 *
 * The exported collection helper types describe the collections the store
 * hands out: a typed node collection is assignable to `NodeCollection` and
 * `NodeWrites` named by its node type and constraint names, and an edge
 * collection whose endpoint is polymorphic is assignable to its read and
 * write helpers named with its graph.
 *
 * Load-bearing: these are compile-time checks under `pnpm typecheck` plus
 * runtime round trips. Narrowing any of those inputs back to an exact-kind
 * reference, or dropping a helper's forwarded type parameter, fails the
 * typecheck.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  type CompositionWholeReference,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type EdgeBatchReads,
  type EdgeId,
  type EdgeTemporalReads,
  type EdgeWrites,
  type NodeCollection,
  type NodeWrites,
  partOf,
  type Store,
  subClassOf,
} from "../src";
import { createTestBackend } from "./test-utils";

const Container = defineNode("Container", {
  schema: z.object({ name: z.string() }),
});
const Folder = defineNode("Folder", {
  schema: z.object({ name: z.string() }),
});
const File = defineNode("File", { schema: z.object({ name: z.string() }) });
const inside = defineEdge("inside", { schema: z.object({}) });
const tags = defineEdge("tags", { schema: z.object({}) });

const graph = defineGraph({
  id: "polymorphic-reference-inputs",
  nodes: {
    Container: { type: Container },
    Folder: { type: Folder },
    File: { type: File },
  },
  edges: {
    inside: {
      type: inside,
      from: [File],
      to: [Container],
      cardinality: "oneActive",
    },
    tags: { type: tags, from: [File], to: [Container] },
  },
  ontology: [
    subClassOf(Folder, Container),
    partOf(File, Container, { via: inside }),
  ],
  identity: { sameIdAcrossKinds: "ignore" },
});

const plainGraph = defineGraph({
  id: "polymorphic-reference-inputs-plain",
  nodes: { File: { type: File } },
  edges: {},
});

const Box = defineNode("Box", { schema: z.object({ name: z.string() }) });
const Shelf = defineNode("Shelf", { schema: z.object({ name: z.string() }) });
const Item = defineNode("Item", { schema: z.object({ name: z.string() }) });
const stored = defineEdge("stored", { schema: z.object({}) });
const labels = defineEdge("labels", { schema: z.object({}) });

/** No `subClassOf`: `Box` reads back exact unless an alias states otherwise. */
const exactGraph = defineGraph({
  id: "polymorphic-reference-inputs-exact",
  nodes: {
    Box: { type: Box },
    Shelf: { type: Shelf },
    Item: { type: Item },
  },
  edges: {
    stored: { type: stored, from: [Item], to: [Box], cardinality: "oneActive" },
    labels: { type: labels, from: [Item], to: [Box] },
  },
  ontology: [partOf(Item, Box, { via: stored })],
  identity: { sameIdAcrossKinds: "ignore" },
});

const Run = defineNode("Run", { schema: z.object({ name: z.string() }) });
const Task = defineNode("Task", { schema: z.object({ title: z.string() }) });
const Agent = defineNode("Agent", { schema: z.object({ name: z.string() }) });
const assigned = defineEdge("assigned", { schema: z.object({}) });

/** Same id under two kinds: a reference's `(kind, id)` pair picks one. */
const collisionGraph = defineGraph({
  id: "polymorphic-reference-inputs-collision",
  nodes: { Run: { type: Run }, Task: { type: Task }, Agent: { type: Agent } },
  edges: { assigned: { type: assigned, from: [Agent], to: [Run, Task] } },
});

const SHARED_ID = "shared-id";

const crateExtension = defineGraphExtension({
  nodes: { Crate: { properties: { name: { type: "string" } } } },
  ontology: [{ metaEdge: "subClassOf", from: "Crate", to: "Box" }],
});

type ExactStore = Store<typeof exactGraph>;

async function explicitlyPolymorphicBoxRow(store: ExactStore, name: string) {
  const rows = await store
    .query()
    .from("Box", "b", { expansion: "subclasses" })
    .whereNode("b", (b) => b.name.eq(name))
    .select((ctx) => ctx.b)
    .execute();
  const row = rows[0];
  if (row === undefined) throw new Error(`no Box row named ${name}`);
  return row;
}

type GraphStore = Store<typeof graph>;

async function openStore(): Promise<GraphStore> {
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    history: true,
  });
  return store;
}

async function polymorphicContainerRow(store: GraphStore, name: string) {
  const rows = await store
    .query()
    .from("Container", "c")
    .whereNode("c", (c) => c.name.eq(name))
    .select((ctx) => ctx.c)
    .execute();
  const row = rows[0];
  if (row === undefined) throw new Error(`no Container row named ${name}`);
  return row;
}

/** Never called: each statement only has to fail the typecheck. */
async function refusesUnbrandedReferences(
  store: GraphStore,
  kind: string,
): Promise<void> {
  const loose = { kind, id: "x" };
  // @ts-expect-error -- an unbranded string-kinded reference
  await store.subgraph(loose, { edges: ["inside"] });
  // @ts-expect-error -- an unbranded string-kinded reference
  await store.identity.representativeOf(loose);
  await store.nodes.File.create(
    { name: "x" },
    // @ts-expect-error -- an unbranded string-kinded reference
    { partOf: { whole: loose } },
  );
}

/** Never called: each statement only has to fail the typecheck. */
async function refusesSameShapeKinds(
  store: ExactStore,
  kind: string,
): Promise<void> {
  const shelf = await store.nodes.Shelf.create({ name: "x" });
  const sameShape = { kind, id: shelf.id };
  await store.nodes.Item.create(
    { name: "x" },
    // @ts-expect-error -- a Shelf id is no Box id, though Shelf has Box's properties
    { partOf: { whole: sameShape } },
  );
  const item = await store.nodes.Item.create({ name: "x" });
  // @ts-expect-error -- a Shelf id is no Box id, though Shelf has Box's properties
  await store.edges.labels.create(item, sameShape, {});
}

describe("a polymorphic query row is accepted as a node reference", () => {
  it("attaches a part to it, moves the part to another, and reads the attachment back", async () => {
    const store = await openStore();
    const reports = await store.nodes.Folder.create({ name: "reports" });
    const archive = await store.nodes.Folder.create({ name: "archive" });
    const reportsRow = await polymorphicContainerRow(store, "reports");
    const archiveRow = await polymorphicContainerRow(store, "archive");
    expectTypeOf(reportsRow.kind).toEqualTypeOf<string>();
    expect(reportsRow.kind).toBe("Folder");

    const file = await store.nodes.File.create(
      { name: "readme" },
      { partOf: { whole: reportsRow } },
    );
    const [attached] = await store.edges.inside.findFrom(file);
    expect(attached?.toKind).toBe("Folder");
    expect(attached?.toId).toBe(reports.id);

    await store.nodes.File.reparent(file.id, { whole: archiveRow });
    const [moved] = await store.edges.inside.findFrom(file);
    expect(moved?.toId).toBe(archive.id);

    const created = await store.nodes.File.bulkCreate([
      { props: { name: "notes" }, partOf: { whole: reportsRow } },
    ]);
    expect(created).toHaveLength(1);
  });

  it("roots a subgraph at it on the store, inside a transaction and on a view", async () => {
    const store = await openStore();
    const reports = await store.nodes.Folder.create({ name: "reports" });
    await store.nodes.File.create(
      { name: "readme" },
      { partOf: { whole: reports } },
    );
    const row = await polymorphicContainerRow(store, "reports");
    const options = { edges: ["inside"] as const, direction: "both" as const };

    const fromStore = await store.subgraph(row, options);
    const fromTransaction = await store.transaction((tx) =>
      tx.subgraph(row, options),
    );
    const fromView = await store
      .asOf(new Date().toISOString())
      .subgraph(row, options);

    for (const result of [fromStore, fromTransaction, fromView]) {
      expect(result.root?.id).toBe(reports.id);
      expect(result.edges).toHaveLength(1);
    }
  });

  it("answers identity reads for it", async () => {
    const store = await openStore();
    const reports = await store.nodes.Folder.create({ name: "reports" });
    const row = await polymorphicContainerRow(store, "reports");

    const representative = await store.identity.representativeOf(row);
    expect(representative).toEqual({ kind: "Folder", id: reports.id });
    const replay = await store.identity.replay(row);
    expect(replay.completeness.status).toBeDefined();
  });

  it("still refuses an arbitrary string-kinded object at compile time", () => {
    expect(refusesUnbrandedReferences).toBeTypeOf("function");
  });
});

describe("exported collection helper types describe the store's collections", () => {
  it("accepts typed node collections named by node type and constraint names", async () => {
    const store = await openStore();
    const [plain] = await createStoreWithSchema(
      plainGraph,
      createTestBackend(),
    );

    const plainWrites: NodeWrites<typeof File, never> = plain.nodes.File;
    const plainCollection: NodeCollection<typeof File, never> =
      plain.nodes.File;
    const folderWrites: NodeWrites<typeof Folder, never> = store.nodes.Folder;
    const partCollection: NodeCollection<typeof File, never> = store.nodes.File;
    expect([
      plainWrites,
      plainCollection,
      folderWrites,
      partCollection,
    ]).toHaveLength(4);

    // Naming the whole reference keeps attachments available through the
    // helper type.
    const partWrites: NodeWrites<
      typeof File,
      never,
      CompositionWholeReference<typeof graph, "File">
    > = store.nodes.File;
    const reports = await store.nodes.Folder.create({ name: "reports" });
    const row = await polymorphicContainerRow(store, "reports");
    const file = await partWrites.create(
      { name: "readme" },
      { partOf: { whole: row } },
    );
    const [attached] = await store.edges.inside.findFrom(file);
    expect(attached?.toId).toBe(reports.id);
  });

  it("accepts an edge collection with a polymorphic endpoint named with its graph", async () => {
    const store = await openStore();
    interface TagsPairs {
      from: typeof File;
      to: typeof Container;
    }
    const reads: EdgeTemporalReads<
      typeof tags,
      typeof File,
      typeof Container,
      TagsPairs,
      EdgeId<typeof tags>,
      typeof graph
    > = store.edges.tags;
    const batchReads: EdgeBatchReads<
      typeof tags,
      typeof File,
      typeof Container,
      TagsPairs,
      EdgeId<typeof tags>,
      typeof graph
    > = store.edges.tags;
    const writes: EdgeWrites<
      typeof tags,
      typeof File,
      typeof Container,
      TagsPairs,
      EdgeId<typeof tags>,
      typeof graph
    > = store.edges.tags;

    const folder = await store.nodes.Folder.create({ name: "reports" });
    const file = await store.nodes.File.create({ name: "readme" });
    const row = await polymorphicContainerRow(store, "reports");
    const edge = await writes.create(file, row, {});
    expect(edge.toId).toBe(folder.id);
    expect(await reads.findFrom(file)).toHaveLength(1);
    expect(batchReads).toBeDefined();
  });
});

describe("an explicitly polymorphic row is accepted on a graph without subclasses", () => {
  it("attaches to it, links to it, and roots reads at it", async () => {
    const [store] = await createStoreWithSchema(
      exactGraph,
      createTestBackend(),
    );
    const box = await store.nodes.Box.create({ name: "spares" });
    const row = await explicitlyPolymorphicBoxRow(store, "spares");
    expectTypeOf(row.kind).toEqualTypeOf<string>();

    const item = await store.nodes.Item.create(
      { name: "bolt" },
      { partOf: { whole: row } },
    );
    const [attached] = await store.edges.stored.findFrom(item);
    expect(attached?.toId).toBe(box.id);

    const label = await store.edges.labels.create(item, row, {});
    expect(label.toId).toBe(box.id);
    const neighbors = await store.neighbors(row, {
      edges: ["labels"],
      direction: "in",
    });
    expect(neighbors.map((neighbor) => neighbor.node.id)).toEqual([item.id]);

    const subgraph = await store.subgraph(row, {
      edges: ["stored"],
      direction: "both",
    });
    expect(subgraph.root?.id).toBe(box.id);
    expect(await store.identity.representativeOf(row)).toEqual({
      kind: "Box",
      id: box.id,
    });
  });

  it("attaches to a subclass a runtime extension adds", async () => {
    const [store] = await createStoreWithSchema(
      exactGraph,
      createTestBackend(),
    );
    const evolved = await store.evolve(crateExtension);
    const crates = evolved.getNodeCollection("Crate");
    if (crates === undefined) throw new Error("Crate was not evolved in");
    const crate = await crates.create({ name: "pallet" });
    const row = await explicitlyPolymorphicBoxRow(evolved, "pallet");
    expect(row.kind).toBe("Crate");

    const item = await evolved.nodes.Item.create(
      { name: "nut" },
      { partOf: { whole: row } },
    );
    const [attached] = await evolved.edges.stored.findFrom(item);
    console.info("runtime-subclass whole attachment", attached);
    expect(attached?.toKind).toBe("Crate");
    expect(attached?.toId).toBe(crate.id);
  });

  it("still refuses a same-shaped unrelated kind at compile time", () => {
    expect(refusesSameShapeKinds).toBeTypeOf("function");
  });
});

describe("a polymorphic reference is read as the (kind, id) pair it states", () => {
  it("resolves a Run's branded id under kind Task to the Task that shares the id", async () => {
    const [store] = await createStoreWithSchema(
      collisionGraph,
      createTestBackend(),
    );
    const run = await store.nodes.Run.create(
      { name: "run" },
      { id: SHARED_ID },
    );
    const task = await store.nodes.Task.create(
      { title: "task" },
      { id: SHARED_ID },
    );
    const agent = await store.nodes.Agent.create({ name: "agent" });
    // The widened reference's `kind` is a `string`, so a Run id under another
    // kind name compiles. Nothing ties the erased brand to the kind at
    // runtime: the pair names the Task.
    const kind = "Task";
    const mislabelled = { kind, id: run.id };

    const resolved = await store.getNodeByRef(mislabelled);
    console.info("mislabelled reference resolved to", resolved);
    expect(resolved?.kind).toBe("Task");
    expect(resolved?.id).toBe(task.id);

    const edge = await store.edges.assigned.create(agent, mislabelled, {});
    expect(edge.toKind).toBe("Task");
    expect(edge.toId).toBe(SHARED_ID);
    const [taskEdge] = await store.edges.assigned.findTo(task);
    expect(taskEdge?.id).toBe(edge.id);
    expect(await store.edges.assigned.findTo(run)).toEqual([]);
  });
});
