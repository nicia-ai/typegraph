import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
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

export function registerMutationPlanningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("bounded mutation planning", () => {
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
      expect(
        isErr(
          await next
            .createEdge("links", edge.id, root, peer, { label: "reused" })
            .plan({ makeBackend }),
        ),
      ).toBe(true);
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
