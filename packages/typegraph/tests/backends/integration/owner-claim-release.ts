/**
 * A uniqueness claim is released by its owner, and keyed from validated
 * props only.
 *
 * Every write that moves a node off a unique value, or removes the node, gives
 * back "the claims this node holds for this constraint" — for an update, those
 * not equal to the key it now claims — rather than a claim whose key it
 * recomputes from the row it read back. A claim's key is derived from the
 * props the write validated, by the one key function, on every path.
 *
 * Recomputing a key from another representation of the same value is what
 * leaked: a `Date` keys as JSON while its stored ISO text keys raw, a
 * PostgreSQL JSONB object comes back in another key order, and an import under
 * `onUnknownProperty: "allow"` stated the document's text rather than the
 * value its schema produced. Each case below moves a row through one write
 * path and then requires the claim rows to be exactly the keys of the live
 * constrained nodes, read straight from the claim relation.
 *
 * REVERT CHECK: restoring main's `src` fails the date move and remove cases on
 * the lanes whose release is keyed (every move path; the per-row soft delete),
 * the lazy and nullable-union date kinds, the object claim stored in another
 * key order, the import cases, the piped get-or-create resurrection and the
 * provenance reopen. The legacy raw-form claim and recursive-union cases pass
 * on main and fail on the previous head of this change (aa064e84), which
 * keyed date fields from schema introspection; they guard against that shape
 * coming back.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type NodeId,
  UniquenessError,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import {
  exportGraph,
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const DATE_KIND_NAMES = [
  "OcrEvent",
  "OcrLazyEvent",
  "OcrNullableEvent",
] as const;
type DateKindName = (typeof DATE_KIND_NAMES)[number];

const OcrEvent = defineNode("OcrEvent", {
  schema: z.object({ name: z.string(), at: z.date() }),
});

/** A date behind `z.lazy`: no introspection of the field can see it. */
const OcrLazyEvent = defineNode("OcrLazyEvent", {
  schema: z.object({ name: z.string(), at: z.lazy(() => z.date()) }),
});

/** A date inside a union with `null`. */
const OcrNullableEvent = defineNode("OcrNullableEvent", {
  schema: z.object({ name: z.string(), at: z.union([z.date(), z.null()]) }),
});

/** A date reached through a pipe: its input is text, its output a `Date`. */
const OcrPipedEvent = defineNode("OcrPipedEvent", {
  schema: z.object({
    name: z.string(),
    at: z.string().pipe(z.coerce.date()),
  }),
});

type OcrCode = string | readonly OcrCode[];
const OcrCodeSchema: z.ZodType<OcrCode> = z.union([
  z.string(),
  z.array(z.lazy(() => OcrCodeSchema)),
]);

/** A constrained field whose type is a recursive union. */
const OcrRecursive = defineNode("OcrRecursive", {
  schema: z.object({ code: OcrCodeSchema }),
});

/** An object-valued unique property, declared longest key first. */
const OcrBadge = defineNode("OcrBadge", {
  schema: z.object({ code: z.object({ zeta: z.string(), a: z.string() }) }),
});

/** A record-valued unique property: its validated key order is its input's. */
const OcrTagged = defineNode("OcrTagged", {
  schema: z.object({ tags: z.record(z.string(), z.string()) }),
});

const OcrSource = defineNode("OcrSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const OcrJustification = defineNode("OcrJustification", {
  schema: z.object({ label: z.string() }),
});

const ocrPremiseOf = defineEdge("ocrPremiseOf");
const ocrDerives = defineEdge("ocrDerives");

function uniqueOn(name: string, field: string, collation = "binary" as const) {
  return [{ name, fields: [field], scope: "kind", collation }] as const;
}

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      OcrEvent: { type: OcrEvent, unique: uniqueOn("OcrEvent_at", "at") },
      OcrLazyEvent: {
        type: OcrLazyEvent,
        unique: uniqueOn("OcrLazyEvent_at", "at"),
      },
      OcrNullableEvent: {
        type: OcrNullableEvent,
        unique: uniqueOn("OcrNullableEvent_at", "at"),
      },
      OcrPipedEvent: {
        type: OcrPipedEvent,
        unique: [
          {
            name: "OcrPipedEvent_at",
            fields: ["at"],
            scope: "kind",
            collation: "caseInsensitive",
          },
        ],
      },
      OcrRecursive: {
        type: OcrRecursive,
        unique: uniqueOn("OcrRecursive_code", "code"),
      },
      OcrBadge: { type: OcrBadge, unique: uniqueOn("OcrBadge_code", "code") },
      OcrTagged: {
        type: OcrTagged,
        unique: uniqueOn("OcrTagged_tags", "tags"),
      },
      OcrSource: { type: OcrSource },
      OcrJustification: { type: OcrJustification },
    },
    edges: {
      ocrPremiseOf: {
        type: ocrPremiseOf,
        from: [OcrSource, OcrEvent],
        to: [OcrJustification],
      },
      ocrDerives: {
        type: ocrDerives,
        from: [OcrJustification],
        to: [OcrEvent],
      },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `owner_claim_release_${graphIdCounter}`;
}

const A = new Date("2024-01-01T00:00:00.000Z");
const B = new Date("2024-02-01T00:00:00.000Z");

async function createGraphStore(context: IntegrationTestContext) {
  const graphId = nextGraphId();
  const store = await context.createStore(buildGraph(graphId));
  return { graphId, store };
}

type OcrStore = Awaited<ReturnType<typeof createGraphStore>>["store"];
type EventCollection = OcrStore["nodes"]["OcrEvent"];
type EventId = NodeId<typeof OcrEvent>;

/**
 * The collection of one date kind. The three date kinds share their props'
 * TypeScript shape, so one collection type serves them all.
 */
function dateNodes(store: OcrStore, kind: DateKindName): EventCollection {
  return store.nodes[kind] as unknown as EventCollection;
}

/** The key the store claims for a validated value of one field. */
function keyOf(field: string, value: unknown, collation = "binary" as const) {
  return computeUniqueKey({ [field]: value }, [field], collation);
}

type LiveClaim = Readonly<{
  constraint_name: string;
  key: string;
  node_id: string;
}>;

/** Every live claim of the graph, read straight from the claim relation. */
async function liveClaims(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly LiveClaim[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<LiveClaim>(
    asCompiledRowsSql(sql`
      SELECT constraint_name, key, node_id
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
        AND deleted_at IS NULL
    `),
  );
  return rows
    .map((row) => ({
      constraint_name: row.constraint_name,
      key: row.key,
      node_id: row.node_id,
    }))
    .toSorted((left, right) => compareStrings(left.node_id, right.node_id));
}

function claim(constraintName: string, key: string, nodeId: string) {
  return { constraint_name: constraintName, key, node_id: nodeId };
}

async function expectNoViolations(store: OcrStore): Promise<void> {
  expect(await store.verifyConstraintFences()).toEqual([]);
}

/** Whether a write was refused, by error name, or completed. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

/** Replaces a node's claim with the one an earlier writer left in its place. */
async function plantClaim(
  store: OcrStore,
  graphId: string,
  kind: string,
  nodeId: string,
  constraintName: string,
  keys: Readonly<{ taken: string; planted: string }>,
): Promise<void> {
  await store.backend.deleteUnique({
    graphId,
    nodeKind: kind,
    constraintName,
    key: keys.taken,
    concreteKind: kind,
    nodeId,
  });
  await store.backend.insertUnique({
    graphId,
    nodeKind: kind,
    constraintName,
    key: keys.planted,
    nodeId,
    concreteKind: kind,
  });
}

type MovePath = Readonly<{
  name: string;
  move: (nodes: EventCollection, store: OcrStore, id: EventId) => Promise<void>;
}>;

/** Write paths that move the row `id` from A to B. */
const MOVE_PATHS: readonly MovePath[] = [
  {
    name: "update",
    move: async (nodes, _store, id) => {
      await nodes.update(id, { at: B });
    },
  },
  {
    name: "upsertById",
    move: async (nodes, _store, id) => {
      await nodes.upsertById(id, { name: "row", at: B });
    },
  },
  {
    name: "bulkUpsertById",
    move: async (nodes, _store, id) => {
      await nodes.bulkUpsertById([{ id, props: { name: "row", at: B } }]);
    },
  },
  {
    name: "bulkReplaceById",
    move: async (nodes, _store, id) => {
      await nodes.bulkReplaceById([{ id, props: { name: "row", at: B } }]);
    },
  },
  {
    name: "update inside a transaction",
    move: async (_nodes, store, id) => {
      await store.transaction(async (tx) => {
        await tx.nodes.OcrEvent.update(id, { at: B });
      });
    },
  },
];

type RemovePath = Readonly<{
  name: string;
  remove: (
    nodes: EventCollection,
    store: OcrStore,
    id: EventId,
  ) => Promise<void>;
}>;

/** Write paths that remove the row `id`. */
const REMOVE_PATHS: readonly RemovePath[] = [
  { name: "delete", remove: (nodes, _store, id) => nodes.delete(id) },
  { name: "bulkDelete", remove: (nodes, _store, id) => nodes.bulkDelete([id]) },
  { name: "hardDelete", remove: (nodes, _store, id) => nodes.hardDelete(id) },
  {
    name: "delete inside a transaction",
    remove: (_nodes, store, id) =>
      store.transaction(async (tx) => {
        await tx.nodes.OcrEvent.delete(id);
      }),
  },
];

function interchangeDocument(
  nodes: GraphData["nodes"],
  description = "owner claim release",
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description },
    nodes,
    edges: [],
  };
}

export function registerOwnerClaimReleaseIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a uniqueness claim is released by its owner", () => {
    for (const kind of DATE_KIND_NAMES) {
      const constraintName = `${kind}_at`;
      // The transaction paths address `OcrEvent` directly.
      const movePaths =
        kind === "OcrEvent" ? MOVE_PATHS : (
          MOVE_PATHS.filter((path) => !path.name.includes("transaction"))
        );
      const removePaths =
        kind === "OcrEvent" ? REMOVE_PATHS : (
          REMOVE_PATHS.filter((path) => !path.name.includes("transaction"))
        );

      for (const path of movePaths) {
        it(`${kind} ${path.name}: the row holds exactly the date it moved to`, async () => {
          const { graphId, store } = await createGraphStore(context);
          const nodes = dateNodes(store, kind);
          const row = await nodes.create({ name: "row", at: A }, { id: "row" });

          await path.move(nodes, store, row.id);

          expect(
            await liveClaims(store.backend, graphId, constraintName),
          ).toEqual([claim(constraintName, keyOf("at", B), "row")]);
          const taker = await nodes.create({ name: "taker", at: A });
          await expect(
            nodes.create({ name: "intruder", at: B }),
          ).rejects.toBeInstanceOf(UniquenessError);
          const found = await nodes.findByConstraint(constraintName, {
            name: "probe",
            at: A,
          });
          expect(found?.id).toBe(taker.id);
          await expectNoViolations(store);
        });
      }

      for (const path of removePaths) {
        it(`${kind} ${path.name}: a removed row holds no claim`, async () => {
          const { graphId, store } = await createGraphStore(context);
          const nodes = dateNodes(store, kind);
          const row = await nodes.create({ name: "row", at: A }, { id: "row" });

          await path.remove(nodes, store, row.id);

          expect(
            await liveClaims(store.backend, graphId, constraintName),
          ).toEqual([]);
          await nodes.create({ name: "taker", at: A });
          await expectNoViolations(store);
        });
      }
    }

    it("an update that keeps the date keeps exactly its claim", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });

      await store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" });

      expect(await liveClaims(store.backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      await expect(
        store.nodes.OcrEvent.create({ name: "intruder", at: A }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("a soft-deleted row resurrected by upsert reclaims its date, and its next delete releases it", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.OcrEvent.delete("row" as EventId);

      await store.nodes.OcrEvent.upsertById("row", { name: "row", at: A });
      expect(await liveClaims(store.backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);

      await store.nodes.OcrEvent.delete("row" as EventId);
      expect(await liveClaims(store.backend, graphId, "OcrEvent_at")).toEqual(
        [],
      );
    });

    it("a claim left in the raw text form is released by the owner's next update and delete", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.OcrEvent.create(
        { name: "other", at: B },
        { id: "other" },
      );
      await plantClaim(store, graphId, "OcrEvent", "row", "OcrEvent_at", {
        taken: keyOf("at", A),
        planted: A.toISOString(),
      });
      await plantClaim(store, graphId, "OcrEvent", "other", "OcrEvent_at", {
        taken: keyOf("at", B),
        planted: B.toISOString(),
      });

      // An update that keeps the value re-keys it; a delete releases it.
      await store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" });
      await store.nodes.OcrEvent.delete("other" as EventId);

      expect(await liveClaims(store.backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      await expectNoViolations(store);
    });

    it("an object claim stored in another key order is released by the owner's update", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );
      // The key order PostgreSQL's JSONB returns, which an earlier release
      // computed from the stored row and so never matched.
      await plantClaim(store, graphId, "OcrBadge", "badge", "OcrBadge_code", {
        taken: keyOf("code", { zeta: "z", a: "a" }),
        planted: JSON.stringify({ a: "a", zeta: "z" }),
      });

      await store.nodes.OcrBadge.update("badge" as NodeId<typeof OcrBadge>, {
        code: { zeta: "y", a: "b" },
      });

      expect(await liveClaims(store.backend, graphId, "OcrBadge_code")).toEqual(
        [claim("OcrBadge_code", keyOf("code", { zeta: "y", a: "b" }), "badge")],
      );
    });

    it("getOrCreateByConstraint resurrects a soft-deleted row holding a piped date", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );
      await store.nodes.OcrPipedEvent.delete(
        "row" as NodeId<typeof OcrPipedEvent>,
      );

      const result = await store.nodes.OcrPipedEvent.getOrCreateByConstraint(
        "OcrPipedEvent_at",
        { name: "again", at: A.toISOString() },
      );

      expect({ action: result.action, id: result.node.id }).toEqual({
        action: "resurrected",
        id: "row",
      });
      expect(
        await liveClaims(store.backend, graphId, "OcrPipedEvent_at"),
      ).toEqual([
        claim("OcrPipedEvent_at", keyOf("at", A).toLowerCase(), "row"),
      ]);
      await expectNoViolations(store);
    });

    it("bulkGetOrCreateByConstraint resurrects and updates rows holding piped dates", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrPipedEvent.create(
        { name: "deleted", at: A.toISOString() },
        { id: "deleted" },
      );
      await store.nodes.OcrPipedEvent.create(
        { name: "live", at: B.toISOString() },
        { id: "live" },
      );
      await store.nodes.OcrPipedEvent.delete(
        "deleted" as NodeId<typeof OcrPipedEvent>,
      );

      const results =
        await store.nodes.OcrPipedEvent.bulkGetOrCreateByConstraint(
          "OcrPipedEvent_at",
          [
            { props: { name: "again", at: A.toISOString() } },
            { props: { name: "renamed", at: B.toISOString() } },
          ],
          { ifExists: "update" },
        );

      expect(
        results.map((result) => ({
          action: result.action,
          id: result.node.id,
        })),
      ).toEqual([
        { action: "resurrected", id: "deleted" },
        { action: "updated", id: "live" },
      ]);
      expect(
        await liveClaims(store.backend, graphId, "OcrPipedEvent_at"),
      ).toEqual([
        claim("OcrPipedEvent_at", keyOf("at", A).toLowerCase(), "deleted"),
        claim("OcrPipedEvent_at", keyOf("at", B).toLowerCase(), "live"),
      ]);
    });

    it("getOrCreateByConstraint updates a live row holding a piped date", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );

      const result = await store.nodes.OcrPipedEvent.getOrCreateByConstraint(
        "OcrPipedEvent_at",
        { name: "renamed", at: A.toISOString() },
        { ifExists: "update" },
      );

      expect({
        action: result.action,
        id: result.node.id,
        name: result.node.name,
      }).toEqual({ action: "updated", id: "row", name: "renamed" });
    });

    it("an import under onUnknownProperty allow claims the value its schema produced", async () => {
      const { graphId, store } = await createGraphStore(context);
      const imported = await importGraph(
        store,
        interchangeDocument([
          {
            kind: "OcrPipedEvent",
            id: "row",
            properties: {
              name: "row",
              at: A.toISOString(),
              legacyNote: "kept",
            },
          },
        ]),
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);

      expect(
        await liveClaims(store.backend, graphId, "OcrPipedEvent_at"),
      ).toEqual([
        claim("OcrPipedEvent_at", keyOf("at", A).toLowerCase(), "row"),
      ]);
      await expect(
        store.nodes.OcrPipedEvent.create({ name: "dup", at: A.toISOString() }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("an import update under onUnknownProperty allow releases the date the row moves off", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );

      const imported = await importGraph(
        store,
        interchangeDocument([
          {
            kind: "OcrPipedEvent",
            id: "row",
            properties: {
              name: "row",
              at: B.toISOString(),
              legacyNote: "kept",
            },
          },
        ]),
        { onConflict: "update", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);

      expect(
        await liveClaims(store.backend, graphId, "OcrPipedEvent_at"),
      ).toEqual([
        claim("OcrPipedEvent_at", keyOf("at", B).toLowerCase(), "row"),
      ]);
      await store.nodes.OcrPipedEvent.create({
        name: "taker",
        at: A.toISOString(),
      });
      await expectNoViolations(store);
    });

    // PR #1005 pinned this as "import claim key: JSONB key order" on
    // PostgreSQL. Keying the claim from the parsed props, which a `z.object`
    // puts in its shape's order, closes it on every lane.
    it("an object-valued unique property imported under allow collides with a create of the same value", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );
      const exported = await exportGraph(source);
      const { store } = await createGraphStore(context);
      const imported = await importGraph(
        store,
        {
          ...exported,
          nodes: exported.nodes.map((node) => ({
            ...node,
            properties: { ...node.properties, legacyNote: "kept" },
          })),
        },
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);
      expect(
        await outcome(() =>
          store.nodes.OcrBadge.create({ code: { zeta: "z", a: "a" } }),
        ),
      ).toBe("UniquenessError");
    });

    // PR #1005 pinned this as "date claim release" (and, on better-sqlite3,
    // "date claim release (delete too)"). Release by owner closes it.
    it("a write that replaces or deletes a unique date releases the old date", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrEvent.create(
        { name: "imported", at: B },
        { id: "imported" },
      );
      const exported = await exportGraph(source);
      const { store } = await createGraphStore(context);
      await store.nodes.OcrEvent.create(
        { name: "imported", at: A },
        { id: "imported" },
      );
      await store.nodes.OcrEvent.create(
        { name: "deleted", at: new Date("2023-01-01T00:00:00.000Z") },
        { id: "deleted" },
      );
      // The exported text, revived to the `Date` the schema reads.
      const imported = await importGraph(
        store,
        {
          ...exported,
          nodes: exported.nodes.map((node) => ({
            ...node,
            properties: {
              ...node.properties,
              at: new Date(String(node.properties["at"])),
            },
          })),
        },
        { onConflict: "update", onUnknownProperty: "error" },
      );
      await store.nodes.OcrEvent.delete("deleted" as EventId);

      expect({
        importErrors: imported.errors.length,
        afterImport: await outcome(() =>
          store.nodes.OcrEvent.create({ name: "a", at: A }),
        ),
        afterDelete: await outcome(() =>
          store.nodes.OcrEvent.create({
            name: "c",
            at: new Date("2023-01-01T00:00:00.000Z"),
          }),
        ),
      }).toEqual({
        importErrors: 0,
        afterImport: "written",
        afterDelete: "written",
      });
    });

    it("a fact reopened by provenance reclaims its date in the form a create claims", async () => {
      const store = await context.createHistoryStore(buildGraph(nextGraphId()));
      const source = await store.nodes.OcrSource.create(
        { label: "source", retracted: false },
        { id: "source" },
      );
      const fact = await store.nodes.OcrEvent.create(
        { name: "fact", at: A },
        { id: "fact" },
      );
      const justification = await store.nodes.OcrJustification.create(
        { label: "justification" },
        { id: "justification" },
      );
      await store.edges.ocrPremiseOf.create(source, justification, {});
      await store.edges.ocrDerives.create(justification, fact, {});
      const provenance = createRetractionCapability(store, {
        source: { kind: "OcrSource" },
        justification: { kind: "OcrJustification" },
        fact: { kinds: ["OcrEvent"] },
        premiseOf: { kind: "ocrPremiseOf" },
        derives: { kind: "ocrDerives" },
      });

      await provenance.retract(source);
      await provenance.unRetract(source);

      expect(
        await liveClaims(store.backend, store.graphId, "OcrEvent_at"),
      ).toEqual([claim("OcrEvent_at", keyOf("at", A), "fact")]);
      expect(
        await outcome(() =>
          store.nodes.OcrEvent.create({ name: "dup", at: A }),
        ),
      ).toBe("UniquenessError");
    });

    it("a constrained field typed as a recursive union keys an ordinary string", async () => {
      const { store } = await createGraphStore(context);
      await store.nodes.OcrRecursive.create({ code: "root" });
      await expect(
        store.nodes.OcrRecursive.create({ code: "root" }),
      ).rejects.toBeInstanceOf(UniquenessError);
      await store.nodes.OcrRecursive.create({ code: ["root", ["leaf"]] });
    });
  });

  describe("claims keyed in another form before release by owner (documented, not repaired)", () => {
    it("a legacy raw-form claim does not fence a create of the same date until its owner is rewritten", async () => {
      const { graphId, store } = await createGraphStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await plantClaim(store, graphId, "OcrEvent", "row", "OcrEvent_at", {
        taken: keyOf("at", A),
        planted: A.toISOString(),
      });

      const duplicate = await outcome(() =>
        store.nodes.OcrEvent.create({ name: "dup", at: A }, { id: "dup" }),
      );
      expectObservation({
        lane: { driver: context.driver },
        observed: duplicate,
        correct: "UniquenessError",
        defects: [
          {
            label: "legacy raw-form date claim",
            on: {},
            today: "written",
          },
        ],
      });

      // The repair: rewriting the owner re-keys its claim from validated
      // props, and surfaces the duplicate the legacy key let in.
      const rewriteWithDuplicate = await outcome(() =>
        store.nodes.OcrEvent.update("row" as EventId, {}),
      );
      expect(rewriteWithDuplicate).toBe(
        duplicate === "written" ? "UniquenessError" : "written",
      );
      if (duplicate === "written") {
        await store.nodes.OcrEvent.hardDelete("dup" as EventId);
      }
      await store.nodes.OcrEvent.update("row" as EventId, {});
      expect(await liveClaims(store.backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      expect(
        await outcome(() =>
          store.nodes.OcrEvent.create({ name: "dup", at: A }),
        ),
      ).toBe("UniquenessError");
    });

    it("a record-valued unique property round-tripped through PostgreSQL does not fence a create in its original key order", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrTagged.create(
        { tags: { zeta: "z", a: "a" } },
        { id: "tagged" },
      );
      const exported = await exportGraph(source);
      const { store } = await createGraphStore(context);
      const imported = await importGraph(store, exported, {
        onConflict: "error",
        onUnknownProperty: "error",
      });
      expect(imported.errors).toEqual([]);

      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed: await outcome(() =>
          store.nodes.OcrTagged.create({ tags: { zeta: "z", a: "a" } }),
        ),
        correct: "UniquenessError",
        defects: [
          {
            label: "record key order through JSONB",
            on: { dialect: ["postgres"] },
            today: "written",
          },
        ],
      });
    });
  });
}
