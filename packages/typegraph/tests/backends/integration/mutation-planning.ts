/* eslint-disable unicorn/no-null -- Explicit null is the public unbounded validFrom sentinel. */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import {
  applyMergePlan,
  createMutationPlanBuilder,
  MutationDocumentSchema,
  planMutations,
} from "../../../src/graph-merge";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string(), note: z.string().optional() }),
});
const links = defineEdge("links", { schema: z.object({ label: z.string() }) });
const graph = defineGraph({
  id: "mutation_planning",
  nodes: {
    Item: {
      type: Item,
      unique: [
        { name: "name", fields: ["name"], scope: "kind", collation: "binary" },
      ],
    },
  },
  edges: { links: { type: links, from: [Item], to: [Item] } },
});

function makeBackend(): Promise<GraphBackend> {
  return Promise.resolve(createLocalSqliteBackend().backend);
}

/** Exercises transport encoding, rather than only cloning the in-memory builder. */
function mutationJsonRoundTrip(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as unknown;
}

export function registerMutationPlanningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bounded mutation planning", () => {
    it("rejects overlapping or duplicate property removals in the public schema", async () => {
      const store = await context.createHistoryStore(graph);
      const builder = await createMutationPlanBuilder(store, "schema");
      for (const unsetProps of [["name"], ["note", "note"]]) {
        const document = {
          ...builder.document,
          operations: [
            {
              op: "node.update",
              kind: "Item",
              id: "item",
              props: { name: "new" },
              unsetProps,
            },
          ],
        };
        expect(MutationDocumentSchema.safeParse(document).success).toBe(false);
        expect(
          await planMutations({
            target: store,
            mutations: document,
            makeBackend,
          }),
        ).toMatchObject({ success: false });
      }
    });

    it("matches collections when deleting and recreating an expired node, including unchanged properties", async () => {
      for (const sameProps of [false, true]) {
        const native = await context.createHistoryStore({
          ...graph,
          id: `mutation_native_${sameProps}`,
        });
        const planned = await context.createHistoryStore({
          ...graph,
          id: `mutation_planned_${sameProps}`,
        });
        for (const store of [native, planned])
          await store.nodes.Item.create(
            { name: "original", note: "discard" },
            {
              id: "reused",
              validFrom: "2000-01-01T00:00:00.000Z",
              validTo: "2001-01-01T00:00:00.000Z",
            },
          );
        const props =
          sameProps ?
            { name: "original", note: "discard" }
          : { name: "replacement" };
        await native.nodes.Item.delete(asNodeId<typeof Item>("reused"));
        const direct = await native.nodes.Item.create(props, {
          id: "reused",
          validFrom: null,
        });
        const builder = await createMutationPlanBuilder(planned, "recreate");
        const mutations = mutationJsonRoundTrip(
          builder
            .deleteNode("Item", "reused")
            .createNode("Item", "reused", props, { validFrom: null }).document,
        );
        const artifact = unwrap(
          await planMutations({ target: planned, makeBackend, mutations }),
        );
        expect(artifact.formatVersion).toBe(2);
        unwrap(await applyMergePlan(planned, artifact));
        const actual = await planned.nodes.Item.getById(direct.id);
        expect(actual).toMatchObject({ name: direct.name });
        expect(actual?.note).toBe(direct.note);
        expect(actual?.meta.validFrom).toBe(direct.meta.validFrom);
        expect(actual?.meta.validTo).toBe(direct.meta.validTo);
      }
    });

    it("round-trips clearing node and edge validity through the mutation document and artifact", async () => {
      const store = await context.createHistoryStore({
        ...graph,
        id: "mutation_clear_ends",
      });
      const a = await store.nodes.Item.create(
        { name: "a" },
        { id: "a", validTo: "2100-01-01T00:00:00.000Z" },
      );
      const b = await store.nodes.Item.create({ name: "b" }, { id: "b" });
      const edge = await store.edges.links.create(
        a,
        b,
        { label: "edge" },
        { id: "edge", validTo: "2100-01-01T00:00:00.000Z" },
      );
      const builder = await createMutationPlanBuilder(store, "clear");
      const mutations = mutationJsonRoundTrip(
        builder
          .updateNode("Item", a.id, {}, { clearValidTo: true })
          .updateEdge("links", edge.id, {}, { clearValidTo: true }).document,
      );
      const artifact = unwrap(
        await planMutations({ target: store, makeBackend, mutations }),
      );
      expect(artifact.writes.nodeUpserts[0]).toHaveProperty(
        "clearValidTo",
        true,
      );
      expect(artifact.writes.edgeUpserts[0]).toHaveProperty(
        "clearValidTo",
        true,
      );
      unwrap(
        await applyMergePlan(
          store,
          mutationJsonRoundTrip(artifact) as typeof artifact,
        ),
      );
      const nodeAfter = await store.nodes.Item.getById(a.id);
      expect(nodeAfter?.meta.validTo).toBeUndefined();
      const edgeAfter = await store.edges.links.getById(edge.id);
      expect(edgeAfter?.meta.validTo).toBeUndefined();
    });

    it("keeps the builder target and document when runtime options contain extra fields", async () => {
      const store = await context.createHistoryStore({
        ...graph,
        id: "builder_owned",
      });
      const other = await context.createHistoryStore({
        ...graph,
        id: "builder_other",
      });
      const empty = await createMutationPlanBuilder(store, "owned");
      const builder = empty.createNode("Item", "owned", { name: "owned" });
      const options = {
        makeBackend,
        target: other,
        mutations: { invalid: true },
      };
      const artifact = unwrap(await builder.plan(options));
      expect(artifact.target.graphId).toBe(store.graphId);
      unwrap(await applyMergePlan(store, artifact));
      expect(
        await store.nodes.Item.getById(asNodeId<typeof Item>("owned")),
      ).toMatchObject({ name: "owned" });
      expect(
        await other.nodes.Item.getById(asNodeId<typeof Item>("owned")),
      ).toBeUndefined();
    });

    it("reports the failing operation and preserves its native collection refusal", async () => {
      const store = await context.createHistoryStore({
        ...graph,
        id: "mutation_error_step",
      });
      const builder = await createMutationPlanBuilder(store, "invalid");
      const result = await builder
        .createNode("Item", "new", { name: "new" })
        .updateNode("Item", "missing", { name: "missing" })
        .plan({ makeBackend });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected operation refusal.");
      {
        expect(result.error.details).toMatchObject({
          operationIndex: 1,
          operation: { op: "node.update", id: "missing" },
        });
        expect(result.error.cause).toBeInstanceOf(Error);
      }
      expect(await store.nodes.Item.count()).toBe(0);
    });

    it("derives resurrection guards only from final live writes", async () => {
      const store = await context.createHistoryStore({
        ...graph,
        id: "mutation_final_guards",
      });
      const node = await store.nodes.Item.create(
        { name: "original" },
        { id: "reused" },
      );
      await store.nodes.Item.delete(node.id);
      const builder = await createMutationPlanBuilder(store, "guard");
      const one = unwrap(
        await builder
          .createNode("Item", node.id, { name: "replacement" })
          .updateNode("Item", node.id, { note: "patched" })
          .plan({ makeBackend }),
      );
      expect(one.guards.nodeResurrections).toEqual([
        { kind: "Item", id: node.id },
      ]);
      const none = unwrap(
        await builder
          .createNode("Item", node.id, { name: "replacement" })
          .deleteNode("Item", node.id)
          .plan({ makeBackend }),
      );
      expect(none.guards.nodeResurrections).toBeUndefined();
    });

    it("plans ordered creates, patches, property removal, and explicit edge-before-node deletion without target writes", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { name: "root", note: "remove" },
        { id: "root" },
      );
      const peer = await store.nodes.Item.create(
        { name: "peer" },
        { id: "peer" },
      );
      const edge = await store.edges.links.create(
        root,
        peer,
        { label: "old" },
        { id: "old" },
      );
      const before = await store.recordedNow();
      const builder = await createMutationPlanBuilder(store, "change-1");
      const operations = builder
        .createNode("Item", "created", { name: "created" })
        .updateNode("Item", root.id, { name: "patched", note: undefined })
        .deleteEdge("links", edge.id)
        .deleteNode("Item", peer.id)
        .createEdge(
          "links",
          "new-edge",
          root,
          { kind: "Item", id: "created" },
          { label: "new" },
        );
      expect(builder.operationCount).toBe(0);
      expect(operations.operationCount).toBe(5);
      expectTypeOf(operations).toEqualTypeOf<typeof builder>();
      const plan = unwrap(await operations.plan({ makeBackend }));
      expect(await store.recordedNow()).toBe(before);
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "root",
        note: "remove",
      });
      expect(await store.nodes.Item.getById(peer.id)).toBeDefined();
      expect(plan.writes.nodeDeletes).toEqual([{ kind: "Item", id: peer.id }]);
      unwrap(await applyMergePlan(store, plan));
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "patched",
      });
      expect(await store.nodes.Item.getById(root.id)).not.toHaveProperty(
        "note",
      );
      expect(await store.nodes.Item.getById(peer.id)).toBeUndefined();
      expect(await store.edges.links.getById(edge.id)).toBeUndefined();
      expect(
        await store.edges.links.getById("new-edge" as typeof edge.id),
      ).toMatchObject({ label: "new" });
    });

    it("preserves ordinary duplicate, missing-id, uniqueness, and restricted-delete refusals", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create(
        { name: "root" },
        { id: "root" },
      );
      const peer = await store.nodes.Item.create(
        { name: "peer" },
        { id: "peer" },
      );
      await store.edges.links.create(root, peer, { label: "existing" });
      const builder = await createMutationPlanBuilder(store, "refusals");
      for (const invalid of [
        builder.createNode("Item", root.id, { name: "duplicate id" }),
        builder.updateNode("Item", "missing", { name: "missing" }),
        builder.createNode("Item", "duplicate-name", { name: "root" }),
        builder.deleteNode("Item", root.id),
      ])
        expect(isErr(await invalid.plan({ makeBackend }))).toBe(true);
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "root",
      });
    });

    it("rejects stale authoring and stale application, and rolls back an apply callback failure", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create({ name: "root" });
      const staleBase = await createMutationPlanBuilder(store, "stale");
      const stale = staleBase.updateNode("Item", root.id, { name: "stale" });
      await store.nodes.Item.update(root.id, { name: "concurrent" });
      expect(isErr(await stale.plan({ makeBackend }))).toBe(true);
      const builder = await createMutationPlanBuilder(store, "apply");
      const plan = unwrap(
        await builder
          .createNode("Item", "new", { name: "new" })
          .plan({ makeBackend }),
      );
      const before = await store.recordedNow();
      expect(
        isErr(
          await applyMergePlan(store, plan, {
            afterApply() {
              throw new Error("rollback");
            },
          }),
        ),
      ).toBe(true);
      expect(await store.recordedNow()).toBe(before);
      await store.nodes.Item.create(
        { name: "new" },
        { id: "claims-rolled-back" },
      );
      expect(
        await store.nodes.Item.getById("new" as typeof root.id),
      ).toBeUndefined();
      await store.nodes.Item.update(root.id, { name: "advanced" });
      expect(isErr(await applyMergePlan(store, plan))).toBe(true);
    });

    it("preserves replacements and unique-key transfers through intermediate values", async () => {
      const store = await context.createHistoryStore(graph);
      const first = await store.nodes.Item.create({
        name: "first",
        note: "remove",
      });
      const second = await store.nodes.Item.create({ name: "second" });
      const builder = await createMutationPlanBuilder(store, "swap");
      const plan = unwrap(
        await builder
          .updateNode("Item", first.id, { name: "temporary" })
          .updateNode("Item", second.id, { name: "first" })
          .replaceNode("Item", first.id, { name: "second" })
          .plan({ makeBackend }),
      );
      unwrap(await applyMergePlan(store, plan));
      expect(await store.nodes.Item.getById(first.id)).toMatchObject({
        name: "second",
      });
      expect(await store.nodes.Item.getById(first.id)).not.toHaveProperty(
        "note",
      );
      expect(await store.nodes.Item.getById(second.id)).toMatchObject({
        name: "first",
      });
    });

    it("plans intentional create of a previously deleted identifier", async () => {
      const store = await context.createHistoryStore(graph);
      const original = await store.nodes.Item.create(
        { name: "original", note: "discarded" },
        { id: "reused" },
      );
      await store.nodes.Item.delete(original.id);
      const builder = await createMutationPlanBuilder(store, "recreate");
      const plan = unwrap(
        await builder
          .createNode("Item", original.id, { name: "replacement" })
          .plan({ makeBackend }),
      );
      unwrap(await applyMergePlan(store, plan));
      expect(await store.nodes.Item.getById(original.id)).toMatchObject({
        name: "replacement",
      });
      expect(await store.nodes.Item.getById(original.id)).not.toHaveProperty(
        "note",
      );
    });

    it("replaces a tombstone with a fresh native validity window", async () => {
      const store = await context.createHistoryStore({
        ...graph,
        id: "mutation_replace_tombstone",
      });
      const original = await store.nodes.Item.create(
        { name: "old", note: "remove" },
        {
          id: "replaced",
          validFrom: "2000-01-01T00:00:00.000Z",
          validTo: "2001-01-01T00:00:00.000Z",
        },
      );
      await store.nodes.Item.delete(original.id);
      const builder = await createMutationPlanBuilder(store, "replace");
      const artifact = unwrap(
        await builder
          .replaceNode("Item", original.id, { name: "new" })
          .plan({ makeBackend }),
      );
      expect(artifact.guards.nodeResurrections).toEqual([
        { kind: "Item", id: original.id },
      ]);
      unwrap(await applyMergePlan(store, artifact));
      const actual = await store.nodes.Item.getById(original.id);
      expect(actual).toMatchObject({ name: "new" });
      expect(actual).not.toHaveProperty("note");
      expect(actual?.meta.validTo).toBeUndefined();
    });

    it("refuses reusing a deleted edge id and observes cardinality peers", async () => {
      const exclusive = defineGraph({
        id: "mutation_cardinality",
        nodes: { Item: { type: Item } },
        edges: {
          links: { type: links, from: [Item], to: [Item], cardinality: "one" },
        },
      });
      const store = await context.createHistoryStore(exclusive);
      const root = await store.nodes.Item.create({ name: "root" });
      const peer = await store.nodes.Item.create({ name: "peer" });
      const edge = await store.edges.links.create(root, peer, {
        label: "existing",
      });
      const builder = await createMutationPlanBuilder(store, "cardinality");
      expect(
        isErr(
          await builder
            .createEdge("links", "conflict", root, peer, { label: "conflict" })
            .plan({ makeBackend }),
        ),
      ).toBe(true);
      const plan = unwrap(
        await builder
          .deleteEdge("links", edge.id)
          .createEdge("links", "replacement", root, peer, {
            label: "replacement",
          })
          .plan({ makeBackend }),
      );
      unwrap(await applyMergePlan(store, plan));
      const next = await createMutationPlanBuilder(store, "edge-refusal");
      const reused = await next
        .createEdge("links", edge.id, root, peer, { label: "reused" })
        .plan({ makeBackend });
      expect(isErr(reused)).toBe(true);
      if (!isErr(reused)) throw new Error("Expected edge create refusal.");
      expect(reused.error.details).toMatchObject({
        operationIndex: 0,
        operation: { op: "edge.create" },
      });
    });

    it("retains edge-kind ownership checks for tombstoned deletes", async () => {
      const otherLinks = defineEdge("otherLinks", {
        schema: z.object({ label: z.string() }),
      });
      const mixed = defineGraph({
        id: "mutation_edge_kind",
        nodes: { Item: { type: Item } },
        edges: {
          links: { type: links, from: [Item], to: [Item] },
          otherLinks: { type: otherLinks, from: [Item], to: [Item] },
        },
      });
      const store = await context.createHistoryStore(mixed);
      const root = await store.nodes.Item.create({ name: "root" });
      const peer = await store.nodes.Item.create({ name: "peer" });
      const edge = await store.edges.links.create(root, peer, {
        label: "deleted",
      });
      await store.edges.links.delete(edge.id);
      await expect(
        store.edges.otherLinks.delete(asEdgeId<typeof otherLinks>(edge.id)),
      ).rejects.toThrow(/belongs to links/u);
      const before = await store.recordedNow();
      const builder = await createMutationPlanBuilder(store, "edge-kind");
      const wrongKind = await builder
        .deleteEdge("otherLinks", edge.id)
        .plan({ makeBackend });
      expect(isErr(wrongKind)).toBe(true);
      if (!isErr(wrongKind)) throw new Error("Expected edge kind refusal.");
      expect(wrongKind.error.details).toMatchObject({
        operationIndex: 0,
        operation: { op: "edge.delete" },
      });
      expect(
        isErr(await builder.deleteEdge("links", edge.id).plan({ makeBackend })),
      ).toBe(false);
      expect(
        isErr(
          await builder
            .deleteEdge("otherLinks", "missing")
            .plan({ makeBackend }),
        ),
      ).toBe(false);
      expect(await store.recordedNow()).toBe(before);
    });

    it("includes incident edge deletions under cascade and disconnect policies", async () => {
      for (const onDelete of ["cascade", "disconnect"] as const) {
        const cascading = defineGraph({
          id: `mutation_${onDelete}`,
          nodes: { Item: { type: Item, onDelete } },
          edges: { links: { type: links, from: [Item], to: [Item] } },
        });
        const store = await context.createHistoryStore(cascading);
        const root = await store.nodes.Item.create({ name: "root" });
        const peer = await store.nodes.Item.create({ name: "peer" });
        const edge = await store.edges.links.create(root, peer, {
          label: "incident",
        });
        const builder = await createMutationPlanBuilder(
          store,
          `delete-${onDelete}`,
        );
        const plan = unwrap(
          await builder.deleteNode("Item", root.id).plan({ makeBackend }),
        );
        expect(plan.writes.edgeDeletes).toContainEqual({
          kind: "links",
          id: edge.id,
        });
        unwrap(await applyMergePlan(store, plan));
        expect(await store.nodes.Item.getById(root.id)).toBeUndefined();
        expect(await store.edges.links.getById(edge.id)).toBeUndefined();
        expect(await store.nodes.Item.getById(peer.id)).toBeDefined();
      }
    });

    it("captures arguments immutably and refuses a target changed during staging", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create({ name: "root" });
      const props = { name: "snapshot" };
      const builderBase = await createMutationPlanBuilder(store, "immutable");
      const builder = builderBase.updateNode("Item", root.id, props);
      props.name = "mutated";
      const plan = unwrap(await builder.plan({ makeBackend }));
      unwrap(await applyMergePlan(store, plan));
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "snapshot",
      });
      const staleBase = await createMutationPlanBuilder(store, "race");
      const stale = staleBase.updateNode("Item", root.id, { name: "stale" });
      let changed = false;
      expect(
        isErr(
          await stale.plan({
            makeBackend: async () => {
              if (!changed) {
                changed = true;
                await store.nodes.Item.update(root.id, { name: "concurrent" });
              }
              return makeBackend();
            },
          }),
        ),
      ).toBe(true);
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "concurrent",
      });
    });

    it("preserves date inputs and schema defaults through the native artifact", async () => {
      const Dated = defineNode("Dated", {
        schema: z.object({
          name: z.string(),
          at: z.coerce.date(),
          state: z.string().default("new"),
        }),
      });
      const dated = defineGraph({
        id: "mutation_dates",
        nodes: { Dated: { type: Dated } },
        edges: {},
      });
      const store = await context.createHistoryStore(dated);
      const at = new Date("2026-01-01T00:00:00.000Z");
      const ordinary = await store.nodes.Dated.create({ name: "ordinary", at });
      const expected = await store.nodes.Dated.getById(ordinary.id);
      const builder = await createMutationPlanBuilder(store, "dates");
      const plan = unwrap(
        await builder
          .createNode("Dated", "new", { name: "created", at })
          .plan({ makeBackend }),
      );
      unwrap(await applyMergePlan(store, plan));
      const node = await store.nodes.Dated.getById(
        "new" as Parameters<typeof store.nodes.Dated.getById>[0],
      );
      expect(node).toMatchObject({
        name: "created",
        at: expected?.at,
        state: "new",
      });
    });

    it("refuses postimages that the native wire codec would reject or transform again", async () => {
      const Unstable = defineNode("Unstable", {
        schema: z.object({
          name: z.string().transform((value) => `${value}!`),
        }),
      });
      const unstable = defineGraph({
        id: "mutation_unstable",
        nodes: { Unstable: { type: Unstable } },
        edges: {},
      });
      const store = await context.createHistoryStore(unstable);
      const builder = await createMutationPlanBuilder(store, "unstable");
      for (const planningScope of ["candidate", "full"] as const) {
        const result = await builder
          .createNode("Unstable", "new", { name: "once" })
          .plan({ makeBackend, planningScope });
        expect(result).toMatchObject({
          success: false,
          error: {
            name: "MergePlanCapabilityError",
            details: { capability: "stableMergePostimage" },
          },
        });
      }
      expect(
        await store.nodes.Unstable.getById(
          "new" as Parameters<typeof store.nodes.Unstable.getById>[0],
        ),
      ).toBeUndefined();
    });

    it("honors a persisted authoring fence instead of rebasing an older request", async () => {
      const store = await context.createHistoryStore(graph);
      const root = await store.nodes.Item.create({ name: "original" });
      const initial = await createMutationPlanBuilder(store, "original-base");
      const expectedTarget = structuredClone(initial.target);
      const authored = await createMutationPlanBuilder(store, "restored", {
        expectedTarget,
      });
      const plan = unwrap(
        await authored
          .updateNode("Item", root.id, { name: "reviewed" })
          .plan({ makeBackend }),
      );
      expect(plan.target).toEqual(expectedTarget);
      await store.nodes.Item.update(root.id, { name: "concurrent" });
      await expect(
        createMutationPlanBuilder(store, "stale-base", { expectedTarget }),
      ).rejects.toMatchObject({ name: "MergePlanningStaleError" });
      expect(isErr(await applyMergePlan(store, plan))).toBe(true);
      expect(await store.nodes.Item.getById(root.id)).toMatchObject({
        name: "concurrent",
      });
    });

    it("does not read unrelated rows as the graph grows", async () => {
      const base = context.getBackend();
      let rowsRead = 0;
      function readMembers(
        base: Pick<
          GraphBackend,
          "getNode" | "getNodes" | "findNodesByKind" | "findNodesAcrossKinds"
        >,
      ): Pick<
        GraphBackend,
        "getNode" | "getNodes" | "findNodesByKind" | "findNodesAcrossKinds"
      > {
        return {
          async getNode(...args) {
            const row = await base.getNode(...args);
            rowsRead += row === undefined ? 0 : 1;
            return row;
          },
          async findNodesByKind(params) {
            const rows = await base.findNodesByKind(params);
            rowsRead += rows.length;
            return rows;
          },
          ...(base.getNodes === undefined ?
            {}
          : {
              async getNodes(
                ...args: Parameters<NonNullable<GraphBackend["getNodes"]>>
              ) {
                const rows = await requireDefined(base.getNodes)(...args);
                rowsRead += rows.length;
                return rows;
              },
            }),
          ...(base.findNodesAcrossKinds === undefined ?
            {}
          : {
              async findNodesAcrossKinds(
                params: Parameters<
                  NonNullable<GraphBackend["findNodesAcrossKinds"]>
                >[0],
              ) {
                const rows = await requireDefined(base.findNodesAcrossKinds)(
                  params,
                );
                rowsRead += rows.length;
                return rows;
              },
            }),
        };
      }
      const backend = deriveBackend(base, {
        ...readMembers(base),
        transaction(callback, options) {
          return base.transaction(
            (tx) => callback(deriveBackend(tx, readMembers(tx))),
            options,
          );
        },
      });
      const [store] = await createStoreWithSchema(graph, backend, {
        history: true,
      });
      const root = await store.nodes.Item.create(
        { name: "root" },
        { id: "root" },
      );
      async function measure(
        planningScope: "candidate" | "full" = "candidate",
      ) {
        const builderBase = await createMutationPlanBuilder(store, "bounded");
        const builder = builderBase
          .updateNode("Item", root.id, { name: "updated" })
          .createNode("Item", "new", { name: "new" });
        rowsRead = 0;
        unwrap(await builder.plan({ makeBackend, planningScope }));
        return rowsRead;
      }
      const before = await measure();
      for (let index = 0; index < 40; index += 1)
        await store.nodes.Item.create({ name: `unrelated-${index}` });
      expect(await measure()).toBe(before);
      expect(before).toBeLessThan(20);
      expect(await measure("full")).toBeGreaterThan(40);
    });
  });
}
