/**
 * THE WRITE-SHAPE GOLDEN.
 *
 * One deterministic trace per (driver, store shape, receiver, write): every
 * statement the driver ran, the store hook events interleaved where they fired
 * (`onOperationEnd` with its `outcome`, `onError` with its error class), the
 * revision advance on revision-tracking stores, and how the write settled. A
 * refactor that claims to keep write behavior keeps these files byte-identical;
 * a change that moves one of them is a behavior change and says so.
 *
 * The matrix:
 *  - drivers: SQLite through better-sqlite3 (`sqlite`) and through
 *    `@libsql/client` (`libsql`), and PostgreSQL through PGlite (`pglite`).
 *    libSQL is here for its batch tier: its root runs a store's static atomic
 *    programs (the create, delete, resolved-update and mutation-set batch
 *    families) as one `batch()` round trip, which no other driver reaches;
 *  - store shapes: plain, unique + disjoint, identity fold, history, revisions
 *    without history, edge cardinality `one`, edge match identity — each built
 *    by `createStoreWithSchema`, so the schema fence runs. The two edge shapes
 *    run only edge and store-level writes: their registrations reach no node
 *    write;
 *  - receivers: the bundled root (every driver); a `deriveBackend` root with
 *    no marks and a `store.transaction` (every driver); a root whose
 *    `clearValidTo` capability is disabled (every driver, plain store); and a
 *    root declaring no interactive transactions (the SQLite drivers: PGlite
 *    always runs interactive transactions) — over libSQL, the batch tier
 *    whose every store-owned unit is one atomic `batch()`;
 *  - writes: every node and edge collection write method (each driver file
 *    ends with a coverage check that the methods its traces actually called
 *    include every name in `NODE_WRITE_NAMES` / `EDGE_WRITE_NAMES`); the
 *    get-or-create `ifExists: "update"` converge and update branches, each
 *    with and without `coalesceUnchangedUpserts`; the collisions a fused
 *    statement must diagnose (occupied id, tombstoned id, id owned by another
 *    kind, unique and cardinality conflicts, a missing or tombstoned endpoint,
 *    a restricted delete); the store-level import, graph-merge apply and
 *    history transaction `writeNodeUpsertBatch`;
 *  - faults: a schema bump committed between store construction and the
 *    write; a generated id that is already occupied when the statement runs
 *    (the mocked id generator hands out a seeded id); a schema-fenced
 *    statement that misses its fence while the diagnosis after it sees the
 *    fence hold (the recorder hides the schema row for exactly that
 *    statement); and a row retired between the delete gate that read it live
 *    and the hooked write (the recorder tombstones it as soon as the gate
 *    returns), producing `unchanged` for node deletes and libSQL's atomic
 *    edge delete; portable edge deletes report `unknown`. A
 *    generated-id collision surfaces as the INSERT's duplicate-key error, so
 *    only the fence miss reaches a bundled root's autocommit no-row recovery.
 *    The retirement fault stages only a base-row tombstone. It runs on plain
 *    stores, where there are no sidecars, history versions, or revision clocks
 *    to make the simulated concurrent delete incomplete. The fence miss and
 *    the retirement fire only on a statement run outside a
 *    transaction; a trace whose write never runs one — or never mints the
 *    colliding id — says `fault not reached`, so no trace passes an ordinary
 *    write off as a faulted one.
 *
 * Unknown kinds: every public route to a collection (the `nodes` / `edges`
 * proxies, `getNodeCollection*`, `getEdgeCollection*`) refuses an
 * unregistered kind with `KindNotFoundError` before any operation runs, so
 * the operation-level unknown-kind checks in `node-operations.ts` (inside the
 * hooked transaction) and `edge-operations.ts` (before hooks) are unreachable
 * from outside the store. The golden pins what IS reachable: the proxy
 * refusal (no hook, no statement), an edge endpoint of an unregistered node
 * kind, and `writeNodeUpsertBatch` naming an unregistered kind.
 *
 * Every golden file runs on its own database, and every trace in it against
 * its own graph, seeded with the same rows, minting its generated ids from a
 * namespace derived from the trace's name — so no file depends on another,
 * and a `-t` filter reproduces the full run byte for byte. Rendered traces
 * renumber generated ids by first appearance and collapse wall-clock
 * timestamps to `<timestamp>`. A receiver whose store refuses to open for
 * every write renders that refusal once.
 *
 * Each driver's goldens run from a test file of their own,
 * `tests/write-shape-golden-<driver>.test.ts`, which mocks `nanoid` with
 * {@link traceIds} and calls {@link registerWriteShapeGoldenFile}; one file
 * per driver lets the shard split place each driver's minutes on its own.
 * Snapshots live in `tests/__snapshots__/write-shape-golden/<driver>/`, one
 * file per (store shape, receiver). Regenerate them — after an intended
 * behavior change, or on a new base — from `packages/typegraph` with:
 *
 *     pnpm exec vitest run tests/write-shape-golden-*.test.ts -u
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
  type GraphBackend,
  partOf,
  type Store,
  type StoreOptions,
} from "../../src";
import { deriveBackend } from "../../src/backend/derive-backend";
import { recordedInstantRevision } from "../../src/core";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import {
  type GraphData,
  importGraph,
  ImportOptionsSchema,
} from "../../src/interchange";
import { createRetractionCapability } from "../../src/provenance";
import { createSqlSchema } from "../../src/query/compiler/schema";
import {
  EDGE_WRITE_NAMES,
  NODE_WRITE_NAMES,
} from "../../src/store/collection-surface";
import { readRecordedClock } from "../../src/store/recorded-capture";
import {
  type HeterogeneousNodeUpsertInput,
  type HistoryStore,
  type RecordedReadStore,
} from "../../src/store-entry";
import { err, ok, type Result } from "../../src/utils/result";
import { createTestBackend } from "../test-utils";
import {
  describeError,
  openWriteShapeEngine,
  renderWriteShape,
  WRITE_SHAPE_DRIVERS,
  type WriteShapeDriver,
  type WriteShapeEngine,
} from "./write-shape-recorder";
import { traceIds } from "./write-shape-trace-ids";

const GENERATED_ID_PATTERN = /\bt[0-9a-f]{8}n\d{4}\b/gu;

/** FNV-1a: a stable, position-free namespace for one trace's name. */
function traceNamespace(traceKey: string): string {
  let hash = 0x81_1c_9d_c5;
  for (const character of traceKey) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return `t${hash.toString(16).padStart(8, "0")}`;
}

// ============================================================
// Graph fixtures
// ============================================================

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const Other = defineNode("Other", {
  schema: z.object({ name: z.string() }),
});
const Extra = defineNode("Extra", {
  schema: z.object({ name: z.string() }),
});
const link = defineEdge("link", {
  schema: z.object({ label: z.string() }),
});
/** The composition shape's realizing edge: an `Item` is part of an `Other`. */
const memberOf = defineEdge("memberOf", { schema: z.object({}) });
/** The provenance shape's roles, as the retraction capability names them. */
const Source = defineNode("Source", {
  schema: z.object({
    name: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Justification = defineNode("Justification", {
  schema: z.object({ name: z.string() }),
});
const Fact = defineNode("Fact", { schema: z.object({ name: z.string() }) });
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const ITEM_NAME_UNIQUE = {
  name: "item_name",
  fields: ["name"],
  scope: "kind",
  collation: "binary",
} as const;

const LINK_LABEL_IDENTITY = { name: "link-label", fields: ["label"] } as const;

export type GraphTraits = Readonly<{
  unique: boolean;
  disjoint: boolean;
  identity: boolean;
  /** `link`'s source-side cardinality. */
  edgeCardinality: "many" | "one" | "oneActive";
  /** `link`'s target-side cardinality; `many` declares none. */
  edgeTargetCardinality: "many" | "one";
  /** Whether `link` declares `acyclic: true`. */
  edgeAcyclic: boolean;
  edgeMatchIdentity: boolean;
  /**
   * The kinds a shape registers beyond the base graph's: `composition` makes
   * `Item` a part of `Other` through `memberOf`; `provenance` adds the
   * retraction capability's source, justification and fact roles.
   */
  feature: "none" | "composition" | "provenance";
}>;

export const PLAIN_TRAITS: GraphTraits = {
  unique: false,
  disjoint: false,
  identity: false,
  edgeCardinality: "many",
  edgeTargetCardinality: "many",
  edgeAcyclic: false,
  edgeMatchIdentity: false,
  feature: "none",
};

function itemRegistration(traits: GraphTraits) {
  return { type: Item, unique: traits.unique ? [ITEM_NAME_UNIQUE] : [] };
}

function linkRegistration(traits: GraphTraits) {
  // The target-side and acyclic keys are stated only when a shape declares
  // them, so every shape that predates them registers `link` as it did.
  const registration = {
    type: link,
    from: [Item],
    to: [Item],
    cardinality: traits.edgeCardinality,
    ...(traits.edgeTargetCardinality === "many" ?
      {}
    : { targetCardinality: traits.edgeTargetCardinality }),
    ...(traits.edgeAcyclic ? { acyclic: true } : {}),
  };
  return traits.edgeMatchIdentity ?
      { ...registration, matchIdentity: LINK_LABEL_IDENTITY }
    : registration;
}

function graphAxioms(traits: GraphTraits) {
  return {
    ontology: traits.disjoint ? [disjointWith(Item, Other)] : [],
    identity:
      traits.identity ? { sameIdAcrossKinds: "fold" as const } : undefined,
  };
}

function baseGraph(id: string, traits: GraphTraits) {
  return defineGraph({
    id,
    nodes: { Item: itemRegistration(traits), Other: { type: Other } },
    edges: { link: linkRegistration(traits) },
    ...graphAxioms(traits),
  });
}

function compositionGraph(id: string, traits: GraphTraits) {
  return defineGraph({
    id,
    nodes: { Item: itemRegistration(traits), Other: { type: Other } },
    edges: {
      link: linkRegistration(traits),
      memberOf: {
        type: memberOf,
        from: [Item],
        to: [Other],
        cardinality: "oneActive",
      },
    },
    ontology: [partOf(Item, Other, { via: memberOf })],
  });
}

function provenanceGraph(id: string, traits: GraphTraits) {
  return defineGraph({
    id,
    nodes: {
      Item: itemRegistration(traits),
      Other: { type: Other },
      Source: { type: Source },
      Justification: { type: Justification },
      Fact: { type: Fact },
    },
    edges: {
      link: linkRegistration(traits),
      premiseOf: {
        type: premiseOf,
        from: [Source, Fact],
        to: [Justification],
      },
      derives: { type: derives, from: [Justification], to: [Fact] },
    },
  });
}

type WriteShapeGraph = ReturnType<typeof baseGraph>;
type CompositionGraph = ReturnType<typeof compositionGraph>;
type ProvenanceGraph = ReturnType<typeof provenanceGraph>;

/**
 * The shape's graph. A feature graph registers every base kind plus its own,
 * so the harness types every store over the base graph; the feature writes
 * recover their own kinds through `compositionSurface` / `provenanceStore`.
 */
function writeShapeGraph(id: string, traits: GraphTraits): WriteShapeGraph {
  switch (traits.feature) {
    case "none": {
      return baseGraph(id, traits);
    }
    case "composition": {
      return compositionGraph(id, traits) as unknown as WriteShapeGraph;
    }
    case "provenance": {
      return provenanceGraph(id, traits) as unknown as WriteShapeGraph;
    }
  }
}

/**
 * The base graph plus one node kind: committing it moves the active schema.
 * Only base shapes run a schema-bump fault.
 */
function schemaBumpGraph(id: string, traits: GraphTraits) {
  return defineGraph({
    id,
    nodes: {
      Item: itemRegistration(traits),
      Other: { type: Other },
      Extra: { type: Extra },
    },
    edges: { link: linkRegistration(traits) },
    ...graphAxioms(traits),
  });
}

type WriteShapeStore =
  | Store<WriteShapeGraph>
  | HistoryStore<WriteShapeGraph>
  | RecordedReadStore<WriteShapeGraph>;
export type WriteSurface = Pick<Store<WriteShapeGraph>, "nodes" | "edges">;
type CompositionSurface = Pick<Store<CompositionGraph>, "nodes" | "edges">;

/** A composition shape's surface, typed over the kinds its graph registers. */
export function compositionSurface(surface: WriteSurface): CompositionSurface {
  return surface as unknown as CompositionSurface;
}

/** A provenance shape's history store, typed over its graph's kinds. */
function provenanceStore(
  store: WriteShapeStore,
): HistoryStore<ProvenanceGraph> {
  return store as unknown as HistoryStore<ProvenanceGraph>;
}

// ============================================================
// Store shapes
// ============================================================

/**
 * A group of collection writes: node and edge writes over the base kinds,
 * and the composition writes, which reach only a graph declaring `partOf`.
 */
type WriteEntity = "node" | "edge" | "composition";

export type StoreShape = Readonly<{
  name: string;
  traits: GraphTraits;
  options: StoreOptions;
  /** The collection writes this shape's registrations can reach. */
  entities: readonly WriteEntity[];
}>;

const BOTH_ENTITIES: readonly WriteEntity[] = ["node", "edge"];
export const EDGE_ENTITY: readonly WriteEntity[] = ["edge"];
export const COMPOSITION_ENTITY: readonly WriteEntity[] = ["composition"];
const NO_ENTITY: readonly WriteEntity[] = [];

const STORE_SHAPES: readonly StoreShape[] = [
  {
    name: "plain",
    traits: PLAIN_TRAITS,
    options: {},
    entities: BOTH_ENTITIES,
  },
  {
    name: "unique-disjoint",
    traits: { ...PLAIN_TRAITS, unique: true, disjoint: true },
    options: {},
    entities: BOTH_ENTITIES,
  },
  {
    name: "identity",
    traits: { ...PLAIN_TRAITS, identity: true },
    options: {},
    entities: BOTH_ENTITIES,
  },
  {
    name: "history",
    traits: PLAIN_TRAITS,
    options: { history: true },
    entities: BOTH_ENTITIES,
  },
  {
    name: "revisions",
    traits: PLAIN_TRAITS,
    options: { revisionTracking: true },
    entities: BOTH_ENTITIES,
  },
  {
    name: "edge-cardinality-one",
    traits: { ...PLAIN_TRAITS, edgeCardinality: "one" },
    options: {},
    entities: EDGE_ENTITY,
  },
  {
    name: "edge-match-identity",
    traits: { ...PLAIN_TRAITS, edgeMatchIdentity: true },
    options: {},
    entities: EDGE_ENTITY,
  },
  {
    name: "composition",
    traits: { ...PLAIN_TRAITS, feature: "composition" },
    options: {},
    entities: COMPOSITION_ENTITY,
  },
  {
    // The retraction capability needs a history store; only its store-level
    // writes run here, the collection writes are the history shape's.
    name: "provenance",
    traits: { ...PLAIN_TRAITS, feature: "provenance" },
    options: { history: true },
    entities: NO_ENTITY,
  },
];

function tracksRevisions(shape: StoreShape): boolean {
  return (
    shape.options.history === true || shape.options.revisionTracking === true
  );
}

// ============================================================
// Seed rows, identical for every trace
// ============================================================

export const ITEM_A = { kind: "Item", id: "item-a" } as const;
export const ITEM_B = { kind: "Item", id: "item-b" } as const;
export const ITEM_C = { kind: "Item", id: "item-c" } as const;
export const ITEM_DEAD = { kind: "Item", id: "item-dead" } as const;
export const ITEM_MISSING = { kind: "Item", id: "item-missing" } as const;
export const OTHER_A = { kind: "Other", id: "other-a" } as const;
export const OTHER_B = { kind: "Other", id: "other-b" } as const;
const SOURCE_A = { kind: "Source", id: "source-a" } as const;
const JUSTIFICATION_A = {
  kind: "Justification",
  id: "justification-a",
} as const;
const FACT_A = { kind: "Fact", id: "fact-a" } as const;

/**
 * `item-a -link-live-> item-b`, a tombstoned `item-c -link-dead-> item-a`, a
 * tombstoned `item-dead`, and `other-a` of a second kind; then whatever
 * rows the shape's feature adds.
 */
async function seed(
  store: WriteShapeStore,
  traits: GraphTraits,
): Promise<void> {
  await seedBase(store);
  switch (traits.feature) {
    case "none": {
      return;
    }
    case "composition": {
      await seedComposition(store);
      return;
    }
    case "provenance": {
      await seedProvenance(store);
      return;
    }
  }
}

async function seedBase(store: WriteShapeStore): Promise<void> {
  await store.transaction(async (tx) => {
    await tx.nodes.Item.bulkInsert(
      [ITEM_A, ITEM_B, ITEM_C, ITEM_DEAD].map((item) => ({
        id: item.id,
        props: { name: item.id },
      })),
    );
    await tx.nodes.Other.create({ name: OTHER_A.id }, { id: OTHER_A.id });
    await tx.edges.link.bulkInsert([
      { id: "link-live", from: ITEM_A, to: ITEM_B, props: { label: "live" } },
      { id: "link-dead", from: ITEM_C, to: ITEM_A, props: { label: "dead" } },
    ]);
    await tx.edges.link.delete(asEdgeId<typeof link>("link-dead"));
    await tx.nodes.Item.delete(asNodeId<typeof Item>(ITEM_DEAD.id));
  });
}

/**
 * `item-c` (whose only edge is tombstoned, so nothing restricts deleting it)
 * is part of `other-a`; `other-b` is a second, empty whole.
 */
async function seedComposition(store: WriteShapeStore): Promise<void> {
  await store.transaction(async (tx) => {
    const surface = compositionSurface(tx);
    await surface.nodes.Other.create({ name: OTHER_B.id }, { id: OTHER_B.id });
    await surface.edges.memberOf.create(
      ITEM_C,
      OTHER_A,
      {},
      {
        id: "member-c",
      },
    );
  });
}

/** `source-a` is the only premise of `justification-a`, which derives `fact-a`. */
async function seedProvenance(store: WriteShapeStore): Promise<void> {
  await provenanceStore(store).transaction(async (tx) => {
    await tx.nodes.Source.create({ name: SOURCE_A.id }, { id: SOURCE_A.id });
    await tx.nodes.Justification.create(
      { name: JUSTIFICATION_A.id },
      { id: JUSTIFICATION_A.id },
    );
    await tx.nodes.Fact.create({ name: FACT_A.id }, { id: FACT_A.id });
    await tx.edges.premiseOf.create(SOURCE_A, JUSTIFICATION_A, {});
    await tx.edges.derives.create(JUSTIFICATION_A, FACT_A, {});
  });
}

// ============================================================
// Writes
// ============================================================

type WriteFault =
  | Readonly<{ kind: "schema-bump" }>
  | Readonly<{ kind: "schema-fence-miss" }>
  | Readonly<{ kind: "generated-id-collision"; occupiedId: string }>
  | Readonly<{
      kind: "gated-row-retired";
      entity: "node" | "edge";
      id: string;
    }>;

const SCHEMA_BUMP: WriteFault = { kind: "schema-bump" };
const SCHEMA_FENCE_MISS: WriteFault = { kind: "schema-fence-miss" };

function generatedIdCollision(occupiedId: string): WriteFault {
  return { kind: "generated-id-collision", occupiedId };
}

function gatedRowRetired(entity: "node" | "edge", id: string): WriteFault {
  return { kind: "gated-row-retired", entity, id };
}

/** A write ready to run; resolves to an optional one-line result summary. */
type WriteThunk = () => Promise<string | undefined>;

export type CollectionWrite = Readonly<{
  name: string;
  clearsValidTo?: true;
  /** Store options this write adds to its shape's. */
  storeOptions?: Readonly<{ coalesceUnchangedUpserts: true }>;
  /** Only shapes this predicate accepts run the write. */
  appliesTo?: (shape: StoreShape) => boolean;
  fault?: WriteFault;
  /** Resolves to a one-line summary when the result itself is the point. */
  run: (surface: WriteSurface) => Promise<unknown>;
}>;

function itemId(id: string) {
  return asNodeId<typeof Item>(id);
}

function linkId(id: string) {
  return asEdgeId<typeof link>(id);
}

function hasUnique(shape: StoreShape): boolean {
  return shape.traits.unique;
}

function isPlain(shape: StoreShape): boolean {
  return shape.name === "plain";
}

/** A shape over the base graph alone, with no feature kinds. */
function isBaseShape(shape: StoreShape): boolean {
  return shape.traits.feature === "none";
}

function appliedOrRejected(applied: boolean): string {
  return applied ? "applied" : "rejected";
}

function actions(results: readonly Readonly<{ action: string }>[]): string {
  return results.map((result) => result.action).join(",");
}

const COALESCING: NonNullable<CollectionWrite["storeOptions"]> = {
  coalesceUnchangedUpserts: true,
};

/**
 * The write as written, then again on a store that coalesces unchanged
 * upserts: the two take different converge and update paths.
 */
function withAndWithoutCoalescing(
  write: CollectionWrite,
): readonly CollectionWrite[] {
  return [
    write,
    { ...write, name: `${write.name} coalescing`, storeOptions: COALESCING },
  ];
}

const UPDATE_IF_EXISTS = { ifExists: "update" } as const;

const UNREGISTERED_KIND = "Unregistered";
const UNREGISTERED_NODE = { kind: UNREGISTERED_KIND, id: "ghost" } as const;

/** Indexes a collection proxy with a kind the graph does not register. */
function unregisteredCollection<C>(collections: object): C {
  return (collections as Readonly<Record<string, C>>)[UNREGISTERED_KIND] as C;
}

type UnregisteredNodeCollection = Pick<WriteSurface["nodes"]["Item"], "create">;
type UnregisteredEdgeCollection = Pick<WriteSurface["edges"]["link"], "create">;

const NODE_WRITES: readonly CollectionWrite[] = [
  {
    name: "node.create generated id",
    run: (surface) => surface.nodes.Item.create({ name: "new" }),
  },
  {
    name: "node.create supplied id",
    run: (surface) =>
      surface.nodes.Item.create({ name: "new" }, { id: "item-new" }),
  },
  {
    name: "node.createFromRecord supplied id",
    run: (surface) =>
      surface.nodes.Item.createFromRecord({ name: "new" }, { id: "item-new" }),
  },
  {
    name: "node.create over a tombstone",
    run: (surface) =>
      surface.nodes.Item.create({ name: ITEM_DEAD.id }, { id: ITEM_DEAD.id }),
  },
  {
    name: "node.create occupied id",
    run: (surface) =>
      surface.nodes.Item.create({ name: "dup" }, { id: ITEM_A.id }),
  },
  {
    name: "node.create id owned by another kind",
    run: (surface) =>
      surface.nodes.Item.create({ name: "cross" }, { id: OTHER_A.id }),
  },
  {
    name: "node.create unique conflict",
    appliesTo: hasUnique,
    run: (surface) => surface.nodes.Item.create({ name: ITEM_A.id }),
  },
  {
    name: "node.create after a schema bump",
    fault: SCHEMA_BUMP,
    run: (surface) =>
      surface.nodes.Item.create({ name: "stale" }, { id: "item-stale" }),
  },
  {
    name: "node.create generated id already occupied",
    fault: generatedIdCollision(ITEM_A.id),
    run: (surface) => surface.nodes.Item.create({ name: "collides" }),
  },
  {
    name: "node.create generated id when the statement misses its fence",
    fault: SCHEMA_FENCE_MISS,
    run: (surface) => surface.nodes.Item.create({ name: "fence-miss" }),
  },
  {
    name: "node.create of an unregistered kind",
    run: (surface) =>
      unregisteredCollection<UnregisteredNodeCollection>(surface.nodes).create({
        name: "ghost",
      }),
  },
  {
    name: "node.bulkCreate generated ids",
    run: (surface) =>
      surface.nodes.Item.bulkCreate([
        { props: { name: "bulk-1" } },
        { props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.bulkCreate generated id already occupied",
    fault: generatedIdCollision(ITEM_A.id),
    run: (surface) =>
      surface.nodes.Item.bulkCreate([
        { props: { name: "bulk-1" } },
        { props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.bulkCreate supplied ids",
    run: (surface) =>
      surface.nodes.Item.bulkCreate([
        { id: "bulk-1", props: { name: "bulk-1" } },
        { id: "bulk-2", props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.bulkInsert generated ids",
    run: (surface) =>
      surface.nodes.Item.bulkInsert([
        { props: { name: "bulk-1" } },
        { props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.bulkInsert generated id already occupied",
    fault: generatedIdCollision(ITEM_A.id),
    run: (surface) =>
      surface.nodes.Item.bulkInsert([
        { props: { name: "bulk-1" } },
        { props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.bulkInsert supplied ids",
    run: (surface) =>
      surface.nodes.Item.bulkInsert([
        { id: "bulk-1", props: { name: "bulk-1" } },
        { id: "bulk-2", props: { name: "bulk-2" } },
      ]),
  },
  {
    name: "node.update",
    run: (surface) =>
      surface.nodes.Item.update(itemId(ITEM_A.id), { name: "renamed" }),
  },
  {
    name: "node.update clearValidTo on a missing row",
    clearsValidTo: true,
    run: (surface) =>
      surface.nodes.Item.update(
        itemId(ITEM_MISSING.id),
        { name: "renamed" },
        { clearValidTo: true },
      ),
  },
  {
    name: "node.update clearValidTo on a live row",
    clearsValidTo: true,
    run: (surface) =>
      surface.nodes.Item.update(
        itemId(ITEM_A.id),
        { name: "renamed" },
        { clearValidTo: true },
      ),
  },
  {
    name: "node.update after a schema bump",
    fault: SCHEMA_BUMP,
    run: (surface) =>
      surface.nodes.Item.update(itemId(ITEM_A.id), { name: "stale" }),
  },
  {
    name: "node.upsertById live row",
    run: (surface) =>
      surface.nodes.Item.upsertById(ITEM_A.id, { name: "upserted" }),
  },
  {
    name: "node.upsertById absent row",
    run: (surface) =>
      surface.nodes.Item.upsertById("item-new", { name: "upserted" }),
  },
  {
    name: "node.upsertById tombstone",
    run: (surface) =>
      surface.nodes.Item.upsertById(ITEM_DEAD.id, { name: ITEM_DEAD.id }),
  },
  {
    name: "node.upsertById coalesced",
    storeOptions: COALESCING,
    run: (surface) =>
      surface.nodes.Item.upsertById(ITEM_A.id, { name: ITEM_A.id }),
  },
  {
    name: "node.upsertByIdFromRecord live row",
    run: (surface) =>
      surface.nodes.Item.upsertByIdFromRecord(ITEM_A.id, { name: "upserted" }),
  },
  {
    name: "node.bulkUpsertById with a repeated id",
    run: (surface) =>
      surface.nodes.Item.bulkUpsertById([
        { id: ITEM_A.id, props: { name: "first" } },
        { id: "item-new", props: { name: "item-new" } },
        { id: ITEM_A.id, props: { name: "second" } },
      ]),
  },
  {
    name: "node.bulkUpsertById live and absent ids",
    run: (surface) =>
      surface.nodes.Item.bulkUpsertById([
        { id: ITEM_A.id, props: { name: "upserted" } },
        { id: "item-new", props: { name: "item-new" } },
      ]),
  },
  {
    name: "node.bulkReplaceById",
    run: (surface) =>
      surface.nodes.Item.bulkReplaceById([
        { id: ITEM_A.id, props: { name: "replaced" } },
        { id: "item-new", props: { name: "item-new" } },
      ]),
  },
  {
    name: "node.compareAndSet match",
    run: (surface) =>
      surface.nodes.Item.compareAndSet(itemId(ITEM_A.id), {
        expected: { name: ITEM_A.id },
        patch: { name: "swapped" },
      }).then((applied) => appliedOrRejected(applied)),
  },
  {
    name: "node.compareAndSet mismatch",
    run: (surface) =>
      surface.nodes.Item.compareAndSet(itemId(ITEM_A.id), {
        expected: { name: "not-the-name" },
        patch: { name: "swapped" },
      }).then((applied) => appliedOrRejected(applied)),
  },
  {
    name: "node.updateWhere",
    run: (surface) =>
      surface.nodes.Item.updateWhere({
        where: (item) => item.name.eq(ITEM_A.id),
        patch: { name: "set-updated" },
      }).then((result) => `affected=${result.affectedCount}`),
  },
  {
    name: "node.updateWhere matching no row",
    run: (surface) =>
      surface.nodes.Item.updateWhere({
        where: (item) => item.name.eq(ITEM_MISSING.id),
        patch: { name: "set-updated" },
      }).then((result) => `affected=${result.affectedCount}`),
  },
  {
    name: "node.delete",
    run: (surface) => surface.nodes.Item.delete(itemId(ITEM_C.id)),
  },
  {
    name: "node.delete missing row",
    run: (surface) => surface.nodes.Item.delete(itemId(ITEM_MISSING.id)),
  },
  {
    name: "node.delete when the row is retired after its gate",
    appliesTo: isPlain,
    fault: gatedRowRetired("node", ITEM_C.id),
    run: (surface) => surface.nodes.Item.delete(itemId(ITEM_C.id)),
  },
  {
    name: "node.delete with a live edge",
    run: (surface) => surface.nodes.Item.delete(itemId(ITEM_A.id)),
  },
  {
    name: "node.bulkDelete",
    run: (surface) =>
      surface.nodes.Item.bulkDelete([
        itemId(ITEM_C.id),
        itemId(ITEM_MISSING.id),
      ]),
  },
  {
    name: "node.bulkDelete absent rows",
    run: (surface) =>
      surface.nodes.Item.bulkDelete([
        itemId(ITEM_DEAD.id),
        itemId(ITEM_MISSING.id),
      ]),
  },
  {
    name: "node.hardDelete",
    run: (surface) => surface.nodes.Item.hardDelete(itemId(ITEM_C.id)),
  },
  {
    name: "node.bulkHardDelete",
    run: (surface) =>
      surface.nodes.Item.bulkHardDelete([
        itemId(ITEM_C.id),
        itemId(ITEM_MISSING.id),
      ]),
  },
  {
    name: "node.bulkHardDelete with a live edge and a tombstone",
    run: (surface) =>
      surface.nodes.Item.bulkHardDelete([
        itemId(ITEM_A.id),
        itemId(ITEM_DEAD.id),
      ]),
  },
  {
    name: "node.reparent of a kind that is not a part",
    appliesTo: isPlain,
    run: (surface) =>
      compositionSurface(surface).nodes.Item.reparent(itemId(ITEM_B.id), {
        whole: OTHER_A,
      }),
  },
  {
    name: "node.getOrCreateByConstraint found",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.getOrCreateByConstraint(ITEM_NAME_UNIQUE.name, {
        name: ITEM_A.id,
      }).then((result) => result.action),
  },
  {
    name: "node.getOrCreateByConstraint created",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.getOrCreateByConstraint(ITEM_NAME_UNIQUE.name, {
        name: "fresh",
      }).then((result) => result.action),
  },
  {
    name: "node.bulkGetOrCreateByConstraint",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.bulkGetOrCreateByConstraint(ITEM_NAME_UNIQUE.name, [
        { props: { name: ITEM_A.id } },
        { props: { name: "fresh" } },
      ]).then((results) => actions(results)),
  },
  {
    name: "node.bulkGetOrCreateByConstraint found only",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.bulkGetOrCreateByConstraint(ITEM_NAME_UNIQUE.name, [
        { props: { name: ITEM_A.id } },
      ]).then((results) => actions(results)),
  },
  ...withAndWithoutCoalescing({
    name: "node.getOrCreateByConstraint ifExists update found",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.getOrCreateByConstraint(
        ITEM_NAME_UNIQUE.name,
        { name: ITEM_A.id },
        UPDATE_IF_EXISTS,
      ).then((result) => result.action),
  }),
  ...withAndWithoutCoalescing({
    name: "node.bulkGetOrCreateByConstraint ifExists update live, retired and fresh",
    appliesTo: hasUnique,
    run: (surface) =>
      surface.nodes.Item.bulkGetOrCreateByConstraint(
        ITEM_NAME_UNIQUE.name,
        [
          { props: { name: ITEM_A.id } },
          { props: { name: ITEM_DEAD.id } },
          { props: { name: "fresh" } },
        ],
        UPDATE_IF_EXISTS,
      ).then((results) => actions(results)),
  }),
];

const EDGE_WRITES: readonly CollectionWrite[] = [
  {
    name: "edge.create generated id",
    run: (surface) =>
      surface.edges.link.create(ITEM_C, ITEM_B, { label: "fresh" }),
  },
  {
    name: "edge.create supplied id",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_C,
        ITEM_B,
        { label: "fresh" },
        { id: "link-new" },
      ),
  },
  {
    name: "edge.create over a tombstone",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_C,
        ITEM_A,
        { label: "dead" },
        { id: "link-dead" },
      ),
  },
  {
    name: "edge.create occupied id",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_C,
        ITEM_B,
        { label: "fresh" },
        { id: "link-live" },
      ),
  },
  {
    name: "edge.create generated id already occupied",
    fault: generatedIdCollision("link-live"),
    run: (surface) =>
      surface.edges.link.create(ITEM_C, ITEM_B, { label: "collides" }),
  },
  {
    name: "edge.create of an unregistered kind",
    run: (surface) =>
      unregisteredCollection<UnregisteredEdgeCollection>(surface.edges).create(
        ITEM_C,
        ITEM_B,
        { label: "ghost" },
      ),
  },
  {
    name: "edge.create endpoint of an unregistered kind",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_C,
        UNREGISTERED_NODE as unknown as typeof ITEM_B,
        { label: "ghost" },
      ),
  },
  {
    name: "edge.create parallel to a live edge",
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_B, { label: "live" }),
  },
  {
    name: "edge.create second edge from one source",
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_C, { label: "second" }),
  },
  {
    name: "edge.create missing endpoint",
    run: (surface) =>
      surface.edges.link.create(ITEM_C, ITEM_MISSING, { label: "missing" }),
  },
  {
    name: "edge.create tombstoned endpoint",
    run: (surface) =>
      surface.edges.link.create(ITEM_C, ITEM_DEAD, { label: "tombstoned" }),
  },
  {
    name: "edge.create after a schema bump",
    fault: SCHEMA_BUMP,
    run: (surface) =>
      surface.edges.link.create(
        ITEM_C,
        ITEM_B,
        { label: "stale" },
        { id: "link-stale" },
      ),
  },
  {
    name: "edge.bulkCreate",
    run: (surface) =>
      surface.edges.link.bulkCreate([
        { from: ITEM_C, to: ITEM_B, props: { label: "bulk-1" } },
        { from: ITEM_B, to: ITEM_C, props: { label: "bulk-2" } },
      ]),
  },
  {
    name: "edge.bulkCreate generated id already occupied",
    fault: generatedIdCollision("link-live"),
    run: (surface) =>
      surface.edges.link.bulkCreate([
        { from: ITEM_C, to: ITEM_B, props: { label: "bulk-1" } },
        { from: ITEM_B, to: ITEM_C, props: { label: "bulk-2" } },
      ]),
  },
  {
    name: "edge.bulkInsert",
    run: (surface) =>
      surface.edges.link.bulkInsert([
        { from: ITEM_C, to: ITEM_B, props: { label: "bulk-1" } },
        { from: ITEM_B, to: ITEM_C, props: { label: "bulk-2" } },
      ]),
  },
  {
    name: "edge.update",
    run: (surface) =>
      surface.edges.link.update(linkId("link-live"), { label: "renamed" }),
  },
  {
    name: "edge.update clearValidTo on a missing row",
    clearsValidTo: true,
    run: (surface) =>
      surface.edges.link.update(
        linkId("link-missing"),
        { label: "renamed" },
        { clearValidTo: true },
      ),
  },
  {
    name: "edge.update clearValidTo on a live row",
    clearsValidTo: true,
    run: (surface) =>
      surface.edges.link.update(
        linkId("link-live"),
        { label: "renamed" },
        { clearValidTo: true },
      ),
  },
  {
    name: "edge.update after a schema bump",
    fault: SCHEMA_BUMP,
    run: (surface) =>
      surface.edges.link.update(linkId("link-live"), { label: "stale" }),
  },
  {
    name: "edge.bulkUpsertById with a repeated id",
    run: (surface) =>
      surface.edges.link.bulkUpsertById([
        {
          id: linkId("link-live"),
          from: ITEM_A,
          to: ITEM_B,
          props: { label: "first" },
        },
        {
          id: linkId("link-new"),
          from: ITEM_C,
          to: ITEM_B,
          props: { label: "new" },
        },
        {
          id: linkId("link-live"),
          from: ITEM_A,
          to: ITEM_B,
          props: { label: "second" },
        },
      ]),
  },
  {
    name: "edge.bulkUpsertById live and absent ids",
    run: (surface) =>
      surface.edges.link.bulkUpsertById([
        {
          id: linkId("link-live"),
          from: ITEM_A,
          to: ITEM_B,
          props: { label: "upserted" },
        },
        {
          id: linkId("link-new"),
          from: ITEM_C,
          to: ITEM_B,
          props: { label: "new" },
        },
      ]),
  },
  {
    name: "edge.delete",
    run: (surface) => surface.edges.link.delete(linkId("link-live")),
  },
  {
    name: "edge.delete when the row is retired after its gate",
    appliesTo: isPlain,
    fault: gatedRowRetired("edge", "link-live"),
    run: (surface) => surface.edges.link.delete(linkId("link-live")),
  },
  {
    name: "edge.bulkDelete",
    run: (surface) =>
      surface.edges.link.bulkDelete([linkId("link-live"), linkId("link-dead")]),
  },
  {
    name: "edge.bulkDelete absent rows",
    run: (surface) =>
      surface.edges.link.bulkDelete([
        linkId("link-dead"),
        linkId("link-missing"),
      ]),
  },
  {
    name: "edge.hardDelete",
    run: (surface) => surface.edges.link.hardDelete(linkId("link-live")),
  },
  {
    name: "edge.bulkHardDelete live, tombstoned and absent ids",
    run: (surface) =>
      surface.edges.link.bulkHardDelete([
        linkId("link-live"),
        linkId("link-dead"),
        linkId("link-missing"),
      ]),
  },
  {
    name: "edge.getOrCreateByEndpoints found",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(ITEM_A, ITEM_B, {
          label: "live",
        })
        .then((result) => result.action),
  },
  {
    name: "edge.getOrCreateByEndpoints created",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(ITEM_C, ITEM_B, {
          label: "fresh",
        })
        .then((result) => result.action),
  },
  {
    name: "edge.getOrCreateByEndpoints matchOn label",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(
          ITEM_A,
          ITEM_B,
          { label: "other" },
          { matchOn: ["label"] },
        )
        .then((result) => result.action),
  },
  {
    name: "edge.bulkGetOrCreateByEndpoints",
    run: (surface) =>
      surface.edges.link
        .bulkGetOrCreateByEndpoints([
          { from: ITEM_A, to: ITEM_B, props: { label: "live" } },
          { from: ITEM_C, to: ITEM_B, props: { label: "fresh" } },
        ])
        .then((results) => actions(results)),
  },
  {
    name: "edge.bulkGetOrCreateByEndpoints found only",
    run: (surface) =>
      surface.edges.link
        .bulkGetOrCreateByEndpoints([
          { from: ITEM_A, to: ITEM_B, props: { label: "live" } },
        ])
        .then((results) => actions(results)),
  },
  {
    name: "edge.bulkGetOrCreateByEndpoints ifExists update all found unchanged",
    storeOptions: COALESCING,
    run: (surface) =>
      surface.edges.link
        .bulkGetOrCreateByEndpoints(
          [{ from: ITEM_A, to: ITEM_B, props: { label: "live" } }],
          UPDATE_IF_EXISTS,
        )
        .then((results) => actions(results)),
  },
  ...withAndWithoutCoalescing({
    name: "edge.getOrCreateByEndpoints ifExists update found and changed",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(
          ITEM_A,
          ITEM_B,
          { label: "renamed" },
          UPDATE_IF_EXISTS,
        )
        .then((result) => result.action),
  }),
  ...withAndWithoutCoalescing({
    name: "edge.getOrCreateByEndpoints ifExists update found unchanged",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(
          ITEM_A,
          ITEM_B,
          { label: "live" },
          UPDATE_IF_EXISTS,
        )
        .then((result) => result.action),
  }),
  ...withAndWithoutCoalescing({
    name: "edge.getOrCreateByEndpoints ifExists update over a tombstone",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(
          ITEM_C,
          ITEM_A,
          { label: "dead" },
          UPDATE_IF_EXISTS,
        )
        .then((result) => result.action),
  }),
  ...withAndWithoutCoalescing({
    name: "edge.bulkGetOrCreateByEndpoints ifExists update live, tombstoned and fresh",
    run: (surface) =>
      surface.edges.link
        .bulkGetOrCreateByEndpoints(
          [
            { from: ITEM_A, to: ITEM_B, props: { label: "live" } },
            { from: ITEM_C, to: ITEM_A, props: { label: "dead" } },
            { from: ITEM_C, to: ITEM_B, props: { label: "fresh" } },
          ],
          UPDATE_IF_EXISTS,
        )
        .then((results) => actions(results)),
  }),
];

function moved(
  results: readonly Readonly<{
    moved: boolean;
    edge: Readonly<{ id: string }>;
  }>[],
): string {
  return results
    .map((result) => `${result.moved ? "moved" : "held"} via ${result.edge.id}`)
    .join(",");
}

/**
 * Writes on the composition shape, where `item-c` is part of `other-a`
 * through `member-c` and `other-b` is an empty whole.
 */
const COMPOSITION_WRITES: readonly CollectionWrite[] = [
  {
    name: "node.reparent to another whole",
    run: (surface) =>
      compositionSurface(surface)
        .nodes.Item.reparent(itemId(ITEM_C.id), { whole: OTHER_B })
        .then((result) => moved([result])),
  },
  {
    name: "node.reparent to the whole it already holds",
    run: (surface) =>
      compositionSurface(surface)
        .nodes.Item.reparent(itemId(ITEM_C.id), { whole: OTHER_A })
        .then((result) => moved([result])),
  },
  {
    name: "node.reparent of an unattached part",
    run: (surface) =>
      compositionSurface(surface)
        .nodes.Item.reparent(itemId(ITEM_B.id), { whole: OTHER_B })
        .then((result) => moved([result])),
  },
  {
    name: "node.reparent of a missing part",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.reparent(itemId(ITEM_MISSING.id), {
        whole: OTHER_B,
      }),
  },
  {
    name: "node.bulkReparent",
    run: (surface) =>
      compositionSurface(surface)
        .nodes.Item.bulkReparent([
          { id: itemId(ITEM_C.id), options: { whole: OTHER_B } },
          { id: itemId(ITEM_B.id), options: { whole: OTHER_B } },
        ])
        .then((results) => moved(results)),
  },
  {
    name: "node.bulkReparent listing a part twice",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.bulkReparent([
        { id: itemId(ITEM_C.id), options: { whole: OTHER_B } },
        { id: itemId(ITEM_C.id), options: { whole: OTHER_A } },
      ]),
  },
  {
    name: "node.create attached to a whole",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.create(
        { name: "part" },
        { id: "item-part", partOf: { whole: OTHER_A } },
      ),
  },
  {
    name: "node.delete of an attached part",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.delete(itemId(ITEM_C.id)),
  },
  {
    name: "node.delete of a whole with a part",
    run: (surface) =>
      compositionSurface(surface).nodes.Other.delete(
        asNodeId<typeof Other>(OTHER_A.id),
      ),
  },
];

const COLLECTION_WRITES: Readonly<
  Record<WriteEntity, readonly CollectionWrite[]>
> = {
  node: NODE_WRITES,
  edge: EDGE_WRITES,
  composition: COMPOSITION_WRITES,
};

type StoreWrite = Readonly<{
  name: string;
  clearsValidTo?: true;
  /** Only shapes this predicate accepts run the write. */
  appliesTo?: (shape: StoreShape) => boolean;
  fault?: WriteFault;
  /** Sets up whatever the write needs, then returns the write itself. */
  prepare: (store: WriteShapeStore) => Promise<WriteThunk>;
}>;

const IMPORT_DOCUMENT: GraphData = {
  formatVersion: "2.0",
  exportedAt: "2024-01-01T00:00:00.000Z",
  source: { type: "external" },
  nodes: [
    { kind: "Item", id: "item-imported", properties: { name: "imported" } },
    { kind: "Item", id: ITEM_A.id, properties: { name: ITEM_A.id } },
  ],
  edges: [
    {
      kind: "link",
      id: "link-imported",
      from: { kind: "Item", id: "item-imported" },
      to: ITEM_B,
      properties: { label: "imported" },
    },
  ],
};

/** A base shape whose store captures history. */
function capturesHistory(shape: StoreShape): boolean {
  return isBaseShape(shape) && shape.options.history === true;
}

/** A base shape whose store keeps a lineage source to fence against. */
function keepsLineage(shape: StoreShape): boolean {
  return isBaseShape(shape) && tracksRevisions(shape);
}

function isProvenance(shape: StoreShape): boolean {
  return shape.traits.feature === "provenance";
}

const PROVENANCE_CONFIG = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

function retractionCapability(store: WriteShapeStore) {
  return createRetractionCapability(provenanceStore(store), PROVENANCE_CONFIG);
}

/**
 * Mints a lineage anchor, optionally changes `item-a` after it, then answers
 * the write: a transaction asserting `item-a` and its outgoing links are
 * unchanged since the anchor.
 */
async function prepareReadSetFence(
  store: WriteShapeStore,
  changeAfterAnchor: boolean,
): Promise<WriteThunk> {
  const base = store as Store<WriteShapeGraph>;
  const anchor = await base.lineageRevisionNow();
  if (anchor === undefined) throw new Error("the store keeps no lineage");
  if (changeAfterAnchor) {
    await base.nodes.Item.update(itemId(ITEM_A.id), { name: "changed" });
  }
  const itemA = { kind: ITEM_A.kind, id: itemId(ITEM_A.id) };
  return async () => {
    await base.transaction((tx) =>
      tx.assertUnchangedSince(anchor, [
        { node: itemA },
        { edgesAt: itemA, direction: "out", kind: "link" },
      ]),
    );
    return "unchanged";
  };
}

type NodeUpsertBatchEntry = Readonly<{
  kind: string;
  id: string;
  props: Readonly<{ name: string }>;
}>;

/** A live, an absent and a tombstoned id, in that order. */
const NODE_UPSERT_BATCH: readonly NodeUpsertBatchEntry[] = [
  { kind: "Item", id: ITEM_A.id, props: { name: "batched" } },
  { kind: "Item", id: "item-new", props: { name: "item-new" } },
  { kind: "Item", id: ITEM_DEAD.id, props: { name: ITEM_DEAD.id } },
];

/**
 * Runs `tx.writeNodeUpsertBatch` in a history transaction. Entries are typed
 * loosely so a case can name a kind the graph does not register.
 */
function writeNodeUpsertBatch(
  store: WriteShapeStore,
  entries: readonly NodeUpsertBatchEntry[],
): WriteThunk {
  const history = store as HistoryStore<WriteShapeGraph>;
  return async () => {
    const nodes = await history.transaction((tx) =>
      tx.writeNodeUpsertBatch(
        entries as readonly HeterogeneousNodeUpsertInput<WriteShapeGraph>[],
      ),
    );
    return `upserted=${nodes.length}`;
  };
}

const STORE_WRITES: readonly StoreWrite[] = [
  {
    name: "tx.writeNodeUpsertBatch live, absent and tombstoned ids",
    appliesTo: capturesHistory,
    prepare: (store) =>
      Promise.resolve(writeNodeUpsertBatch(store, NODE_UPSERT_BATCH)),
  },
  {
    name: "tx.writeNodeUpsertBatch after a schema bump",
    appliesTo: capturesHistory,
    fault: SCHEMA_BUMP,
    prepare: (store) =>
      Promise.resolve(writeNodeUpsertBatch(store, NODE_UPSERT_BATCH)),
  },
  {
    name: "tx.writeNodeUpsertBatch of an unregistered kind",
    appliesTo: capturesHistory,
    prepare: (store) =>
      Promise.resolve(
        writeNodeUpsertBatch(store, [
          { kind: UNREGISTERED_KIND, id: "ghost", props: { name: "ghost" } },
        ]),
      ),
  },
  {
    name: "tx.assertUnchangedSince over an unchanged read set",
    appliesTo: keepsLineage,
    prepare: (store) => prepareReadSetFence(store, false),
  },
  {
    name: "tx.assertUnchangedSince after a change in the read set",
    appliesTo: keepsLineage,
    prepare: (store) => prepareReadSetFence(store, true),
  },
  {
    name: "provenance.assertHolds of a believed fact",
    appliesTo: isProvenance,
    prepare: (store) => {
      const provenance = retractionCapability(store);
      return Promise.resolve(async () => {
        const held = await provenanceStore(store).transaction((tx) =>
          provenance.assertHolds(tx, [FACT_A]),
        );
        return held
          .map(
            (entry) =>
              `${entry.fact.id} via ${entry.via.map((ref) => ref.id).join("+")}`,
          )
          .join(",");
      });
    },
  },
  {
    name: "provenance.assertHolds after its only source is retracted",
    appliesTo: isProvenance,
    prepare: async (store) => {
      const provenance = retractionCapability(store);
      await provenance.retract(SOURCE_A);
      return async () => {
        await provenanceStore(store).transaction((tx) =>
          provenance.assertHolds(tx, [FACT_A]),
        );
        return "held";
      };
    },
  },
  {
    name: "provenance.retract",
    appliesTo: isProvenance,
    prepare: (store) => {
      const provenance = retractionCapability(store);
      return Promise.resolve(async () => {
        const report = await provenance.retract(SOURCE_A);
        return (
          `died=${report.died.length} survived=${report.survivedVia.length}` +
          ` unaffected=${report.unaffected.length}`
        );
      });
    },
  },
  {
    name: "store import",
    appliesTo: isBaseShape,
    prepare: (store) =>
      Promise.resolve(async () => {
        const result = await importGraph(
          store,
          IMPORT_DOCUMENT,
          ImportOptionsSchema.parse({ onConflict: "skip" }),
        );
        return (
          `nodes created=${result.nodes.created} skipped=${result.nodes.skipped}` +
          ` edges created=${result.edges.created} skipped=${result.edges.skipped}`
        );
      }),
  },
  {
    name: "store graph-merge apply",
    appliesTo: isBaseShape,
    prepare: async (store) => {
      const base = store as Store<WriteShapeGraph>;
      const working = unwrap(
        await branch(base, () => Promise.resolve(createTestBackend()), {
          id: asBranchId("branch-a"),
        }),
      );
      await working.store.nodes.Item.create(
        { name: "branched" },
        { id: "item-branched" },
      );
      await working.store.edges.link.create(
        ITEM_C,
        { kind: "Item", id: "item-branched" },
        { label: "branched" },
      );
      return async () => {
        const report = unwrap(await merge(base, [working]));
        return `merged nodes=${report.merged.nodes} edges=${report.merged.edges}`;
      };
    },
  },
];

// ============================================================
// Receivers
// ============================================================

type OpenedReceiver = Readonly<{
  /** An interactive store over the same graph, for seeds and faults. */
  seedStore: WriteShapeStore;
  write: (run: (surface: WriteSurface) => Promise<unknown>) => Promise<unknown>;
  /** The receiver's own store, when it is one: store-level writes need it. */
  store: WriteShapeStore | undefined;
}>;

export type Receiver = Readonly<{
  name: string;
  drivers: readonly WriteShapeDriver[];
  appliesTo?: (shape: StoreShape) => boolean;
  includesWrite?: (write: CollectionWrite | StoreWrite) => boolean;
  open: (
    engine: WriteShapeEngine,
    graph: WriteShapeGraph,
    options: StoreOptions,
  ) => Promise<OpenedReceiver>;
}>;

const SQLITE_DRIVERS: readonly WriteShapeDriver[] = ["sqlite", "libsql"];

async function openStore(
  graph: WriteShapeGraph,
  backend: GraphBackend,
  options: StoreOptions,
): Promise<WriteShapeStore> {
  const [store] = await createStoreWithSchema(graph, backend, options);
  return store;
}

function storeReceiver(store: WriteShapeStore): OpenedReceiver {
  return { seedStore: store, write: (run) => run(store), store };
}

function requireNonInteractiveRoot(engine: WriteShapeEngine): GraphBackend {
  if (engine.nonInteractiveRoot === undefined) {
    throw new Error(`${engine.driver} has no non-interactive root`);
  }
  return engine.nonInteractiveRoot;
}

export const RECEIVERS: readonly Receiver[] = [
  {
    name: "root",
    drivers: WRITE_SHAPE_DRIVERS,
    open: async (engine, graph, options) =>
      storeReceiver(await openStore(graph, engine.root, options)),
  },
  {
    name: "derived-root",
    drivers: WRITE_SHAPE_DRIVERS,
    open: async (engine, graph, options) =>
      storeReceiver(
        await openStore(graph, deriveBackend(engine.root, {}), options),
      ),
  },
  {
    // Store-level writes need a store, so a shape without collection writes
    // has nothing to run inside a transaction.
    name: "transaction",
    drivers: WRITE_SHAPE_DRIVERS,
    appliesTo: (shape) => shape.entities.length > 0,
    open: async (engine, graph, options) => {
      const store = await openStore(graph, engine.root, options);
      return {
        seedStore: store,
        write: (run) => store.transaction((tx) => run(tx)),
        store: undefined,
      };
    },
  },
  {
    name: "no-clear-valid-to",
    drivers: WRITE_SHAPE_DRIVERS,
    appliesTo: isPlain,
    includesWrite: (write) => write.clearsValidTo === true,
    open: async (engine, graph, options) =>
      storeReceiver(
        await openStore(
          graph,
          deriveBackend(engine.root, {
            capabilities: {
              ...engine.root.capabilities,
              clearValidTo: false,
            },
          }),
          options,
        ),
      ),
  },
  {
    name: "non-interactive-root",
    drivers: SQLITE_DRIVERS,
    open: async (engine, graph, options) => {
      const seedStore = await openStore(graph, engine.root, options);
      const store = await openStore(
        graph,
        requireNonInteractiveRoot(engine),
        options,
      );
      return { seedStore, write: (run) => run(store), store };
    },
  },
];

/**
 * The collection methods traced writes called, as `node.<method>` and
 * `edge.<method>`: recorded at the call, so a write named after a method it
 * never reaches, or a write the matrix never runs, adds nothing.
 */
type InvokedMethods = Set<string>;

/**
 * `collections` (a surface's `nodes` or `edges`), recording each collection
 * method called through it into `invoked`. The real collection receives the
 * call unchanged, as its own `this`.
 */
function recordingCollections<C extends object>(
  collections: C,
  entity: "node" | "edge",
  invoked: InvokedMethods,
): C {
  return new Proxy(collections, {
    get(target, kind) {
      const collection: unknown = Reflect.get(target, kind);
      if (typeof collection !== "object" || collection === null) {
        return collection;
      }
      return new Proxy(collection, {
        get(collectionTarget, member) {
          const value: unknown = Reflect.get(collectionTarget, member);
          if (typeof member !== "string" || typeof value !== "function") {
            return value;
          }
          return (...args: unknown[]): unknown => {
            invoked.add(`${entity}.${member}`);
            return Reflect.apply(value, collectionTarget, args);
          };
        },
      });
    },
  });
}

function recordingSurface(
  surface: WriteSurface,
  invoked: InvokedMethods,
): WriteSurface {
  return {
    nodes: recordingCollections(surface.nodes, "node", invoked),
    edges: recordingCollections(surface.edges, "edge", invoked),
  };
}

// ============================================================
// Runner
// ============================================================

type TraceRequest = Readonly<{
  engine: WriteShapeEngine;
  shape: StoreShape;
  receiver: Receiver;
  name: string;
  storeOptions?: CollectionWrite["storeOptions"];
  fault?: WriteFault;
  /**
   * Prepares the write against a seeded receiver, or answers `undefined`
   * where the receiver cannot run it.
   */
  bind: (opened: OpenedReceiver) => Promise<WriteThunk | undefined>;
}>;

/**
 * One write's outcome: its rendered lines, nothing where the receiver cannot
 * run it, or the reason the receiver's store refused to open.
 */
type TraceResult =
  | Readonly<{ kind: "traced"; lines: readonly string[] }>
  | Readonly<{ kind: "skipped" }>
  | Readonly<{ kind: "refused"; heading: string; reason: string }>;

function summaryOf(result: unknown): string | undefined {
  return typeof result === "string" ? result : undefined;
}

async function readRevision(
  engine: WriteShapeEngine,
  graphId: string,
): Promise<number> {
  const instant = await readRecordedClock(
    engine.root,
    createSqlSchema(engine.root.tableNames),
    graphId,
  );
  return instant === undefined ? 0 : recordedInstantRevision(instant);
}

/** Opens the receiver's store, or answers why the store refused to open. */
async function openReceiver(
  request: TraceRequest,
  graph: WriteShapeGraph,
): Promise<Result<OpenedReceiver, string>> {
  try {
    return ok(
      await request.receiver.open(request.engine, graph, {
        ...request.shape.options,
        ...request.storeOptions,
        hooks: request.engine.recorder.hooks,
      }),
    );
  } catch (error: unknown) {
    return err(describeError(error));
  }
}

/** Applies the part of a fault that must land before the write is bound. */
async function injectFault(
  request: TraceRequest,
  graphId: string,
): Promise<void> {
  const { fault } = request;
  if (fault?.kind === "schema-bump") {
    await createStoreWithSchema(
      schemaBumpGraph(graphId, request.shape.traits),
      request.engine.root,
      request.shape.options,
    );
  }
}

/** Applies the part of a fault that must land as the write starts. */
function armFault(
  engine: WriteShapeEngine,
  graphId: string,
  fault: WriteFault | undefined,
): void {
  switch (fault?.kind) {
    case "generated-id-collision": {
      traceIds.occupyNextMint(fault.occupiedId);
      return;
    }
    case "schema-fence-miss": {
      engine.missNextSchemaFence(graphId);
      return;
    }
    case "gated-row-retired": {
      engine.retireRowAfterNextRead({
        entity: fault.entity,
        graphId,
        id: fault.id,
      });
      return;
    }
    case "schema-bump":
    case undefined: {
      return;
    }
  }
}

/** The test-armed faults a write settled without reaching. */
function pendingTraceFaults(fault: WriteFault | undefined): readonly string[] {
  const occupiedId = traceIds.pendingOccupiedMint();
  return fault?.kind === "generated-id-collision" && occupiedId !== undefined ?
      [`the next generated id is the occupied ${occupiedId}`]
    : [];
}

async function trace(request: TraceRequest): Promise<TraceResult> {
  const { engine, shape, receiver } = request;
  const namespace = traceNamespace(
    `${shape.name}|${receiver.name}|${request.name}`,
  );
  traceIds.begin(namespace);
  const graphId = `g${namespace}`;
  const heading = `### ${request.name}`;
  const opened = await openReceiver(
    request,
    writeShapeGraph(graphId, shape.traits),
  );
  if (!opened.success) {
    return { kind: "refused", heading, reason: opened.error };
  }
  await seed(opened.data.seedStore, shape.traits);
  await injectFault(request, graphId);
  const write = await request.bind(opened.data);
  if (write === undefined) return { kind: "skipped" };
  const revisionTracked = tracksRevisions(shape);
  const before = revisionTracked ? await readRevision(engine, graphId) : 0;
  armFault(engine, graphId, request.fault);
  const capture = await engine.recorder.capture(write, () =>
    pendingTraceFaults(request.fault),
  );
  const after = revisionTracked ? await readRevision(engine, graphId) : 0;
  return {
    kind: "traced",
    lines: [
      heading,
      ...renderWriteShape(capture, [
        { pattern: GENERATED_ID_PATTERN, label: "id" },
        {
          pattern: new RegExp(String.raw`\b${graphId}\b`, "gu"),
          label: "graph",
        },
      ]),
      ...(revisionTracked ? [`revision +${after - before}`] : []),
      "",
    ],
  };
}

/**
 * Renders a receiver's traces. A store that refused to open for every write
 * says so once: the refusal is one fact, not one per write.
 */
function renderTraces(results: readonly TraceResult[]): string {
  const reasons = new Set(
    results.map((result) =>
      result.kind === "refused" ? result.reason : undefined,
    ),
  );
  const [onlyReason] = reasons;
  if (reasons.size === 1 && onlyReason !== undefined) {
    return `=> store refused for every write: ${onlyReason}\n`;
  }
  return results
    .flatMap((result) => {
      switch (result.kind) {
        case "traced": {
          return result.lines;
        }
        case "skipped": {
          return [];
        }
        case "refused": {
          return [result.heading, `=> store refused: ${result.reason}`, ""];
        }
      }
    })
    .join("\n");
}

function appliesToShape(
  write: Readonly<{ appliesTo?: (shape: StoreShape) => boolean }>,
  shape: StoreShape,
): boolean {
  return write.appliesTo === undefined || write.appliesTo(shape);
}

/**
 * One golden matrix: the store shapes it builds, the receivers it opens
 * each shape on, the writes it traces on each shape, and the collection
 * methods its traces must reach. The write-shape golden is one; a second
 * matrix reuses this runner and recorder with shapes and writes of its own,
 * and writes its snapshots to a directory of its own.
 */
export type GoldenMatrix = Readonly<{
  /** Names the matrix's `describe` blocks. */
  title: string;
  /** The directory under `tests/__snapshots__/` holding its golden files. */
  snapshotDir: string;
  shapes: readonly StoreShape[];
  receivers: readonly Receiver[];
  collectionWrites: (shape: StoreShape) => readonly CollectionWrite[];
  storeWrites: readonly StoreWrite[];
  /** Names what {@link GoldenMatrix.requiredMethods} covers, for the check. */
  coverageSubject: string;
  /** `node.<method>` / `edge.<method>` names the traces must invoke. */
  requiredMethods: readonly string[];
}>;

async function traceReceiver(
  engine: WriteShapeEngine,
  matrix: GoldenMatrix,
  shape: StoreShape,
  receiver: Receiver,
  invoked: InvokedMethods,
): Promise<string> {
  const results: TraceResult[] = [];
  for (const write of matrix.collectionWrites(shape)) {
    if (
      !appliesToShape(write, shape) ||
      (receiver.includesWrite !== undefined && !receiver.includesWrite(write))
    )
      continue;
    results.push(
      await trace({
        engine,
        shape,
        receiver,
        name: write.name,
        ...(write.storeOptions === undefined ?
          {}
        : { storeOptions: write.storeOptions }),
        ...(write.fault === undefined ? {} : { fault: write.fault }),
        bind: (opened) =>
          Promise.resolve(async () =>
            summaryOf(
              await opened.write((surface) =>
                write.run(recordingSurface(surface, invoked)),
              ),
            ),
          ),
      }),
    );
  }
  for (const write of matrix.storeWrites) {
    if (
      !appliesToShape(write, shape) ||
      (receiver.includesWrite !== undefined && !receiver.includesWrite(write))
    )
      continue;
    results.push(
      await trace({
        engine,
        shape,
        receiver,
        name: write.name,
        ...(write.fault === undefined ? {} : { fault: write.fault }),
        bind: ({ store }) =>
          store === undefined ?
            Promise.resolve(undefined)
          : write.prepare(store),
      }),
    );
  }
  return renderTraces(results);
}

/**
 * A receiver file boots its own in-process database and runs a few dozen
 * traces; on a loaded machine that outlasts the default budget without being
 * wrong.
 */
const RECEIVER_FILE_BUDGET_MS = 120_000;

/**
 * Each golden file gets a database of its own. PostgreSQL may return an
 * unordered re-read in physical order, and physical order depends on every
 * row a database has ever held, so a shared database would let one file's
 * traces reorder another's.
 */
async function traceReceiverFile(
  driver: WriteShapeDriver,
  matrix: GoldenMatrix,
  shape: StoreShape,
  receiver: Receiver,
  invoked: InvokedMethods,
): Promise<string> {
  const engine = await openWriteShapeEngine(driver);
  try {
    return await traceReceiver(engine, matrix, shape, receiver, invoked);
  } finally {
    await engine.close();
  }
}

/** The (store shape, receiver) golden files `driver` runs. */
function receiverFiles(
  driver: WriteShapeDriver,
  matrix: GoldenMatrix,
): readonly Readonly<{ shape: StoreShape; receiver: Receiver }>[] {
  return matrix.shapes.flatMap((shape) =>
    matrix.receivers
      .filter(
        (receiver) =>
          receiver.drivers.includes(driver) &&
          (receiver.appliesTo?.(shape) ?? true),
      )
      .map((receiver) => ({ shape, receiver })),
  );
}

function receiverFileName(shape: StoreShape, receiver: Receiver): string {
  return `${shape.name}.${receiver.name}`;
}

/**
 * Registers one driver's golden files of `matrix`, then the coverage check
 * over the methods those files' traces invoked, in the calling test file.
 * That file must mock `nanoid` with {@link traceIds}.
 */
export function registerGoldenMatrixFile(
  driver: WriteShapeDriver,
  matrix: GoldenMatrix,
): void {
  const invoked: InvokedMethods = new Set();
  const traced = new Set<string>();
  const files = receiverFiles(driver, matrix);

  describe(`${matrix.title} [${driver}]`, () => {
    describe.each(matrix.shapes)("$name store", (shape) => {
      it.each(
        files
          .filter((file) => file.shape === shape)
          .map((file) => file.receiver),
      )(
        "$name receiver",
        async (receiver) => {
          const golden = await traceReceiverFile(
            driver,
            matrix,
            shape,
            receiver,
            invoked,
          );
          traced.add(receiverFileName(shape, receiver));
          await expect(golden).toMatchFileSnapshot(
            `./__snapshots__/${matrix.snapshotDir}/${driver}/${shape.name}.${receiver.name}.txt`,
          );
        },
        RECEIVER_FILE_BUDGET_MS,
      );
    });
  });

  // Declared last, so it runs after every golden file above has traced.
  describe(`${matrix.title} coverage [${driver}]`, () => {
    it(`invoked every ${matrix.coverageSubject}`, () => {
      // The check reads what this file's traces called, so it needs all of
      // them: run the whole file, not a `-t` subset that includes this test.
      expect([...traced].toSorted()).toEqual(
        files
          .map(({ shape, receiver }) => receiverFileName(shape, receiver))
          .toSorted(),
      );
      expect(
        matrix.requiredMethods.filter((method) => !invoked.has(method)),
      ).toEqual([]);
    });
  });
}

const WRITE_SHAPE_MATRIX: GoldenMatrix = {
  title: "write-shape golden",
  snapshotDir: "write-shape-golden",
  shapes: STORE_SHAPES,
  receivers: RECEIVERS,
  collectionWrites: (shape) =>
    shape.entities.flatMap((entity) => COLLECTION_WRITES[entity]),
  storeWrites: STORE_WRITES,
  coverageSubject: "node and edge collection write method",
  requiredMethods: [
    ...NODE_WRITE_NAMES.map((name) => `node.${name}`),
    ...EDGE_WRITE_NAMES.map((name) => `edge.${name}`),
  ],
};

/** Registers one driver's write-shape golden files; see {@link registerGoldenMatrixFile}. */
export function registerWriteShapeGoldenFile(driver: WriteShapeDriver): void {
  registerGoldenMatrixFile(driver, WRITE_SHAPE_MATRIX);
}
