import type { GraphDef, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  RestrictedDeleteError,
} from "@nicia-ai/typegraph";
import {
  applyMergePlan,
  branch,
  type GraphBranch,
  isErr,
  merge,
  MergeConstraintConflictError,
  mergeIncremental,
  planMerge,
  planMergeIncremental,
  RestrictedDeleteMergeConflictError,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { constructMergePlanArtifact } from "../../src/graph-merge/plan-wire";
import { createPgliteFixturePool } from "./pglite-fixture-pool";
import { backendMatrix, getStoreBackend } from "./test-utils";

const Item = defineNode("Item", {
  schema: z.object({ name: z.string() }),
});
const links = defineEdge("links", { schema: z.object({}) });
const graph = defineGraph({
  id: "merge-delete-order",
  nodes: { Item: { type: Item } },
  edges: { links: { type: links, from: [Item], to: [Item] } },
});

const MODES = ["merge", "incremental", "plan", "incremental-plan"] as const;
type Mode = (typeof MODES)[number];

async function apply<G extends GraphDef>(
  mode: Mode,
  target: Store<G>,
  source: GraphBranch<G>,
) {
  const recorded = await target.recordedNow();
  if (recorded === undefined) throw new Error("Missing recorded fork point");
  const incremental = {
    forkPoint: { recorded, base: source.base },
    target,
    branches: [source],
  };
  switch (mode) {
    case "merge": {
      return merge(target, [source]);
    }
    case "incremental": {
      return mergeIncremental(incremental);
    }
    case "plan": {
      return applyMergePlan(target, unwrap(await planMerge(target, [source])));
    }
    case "incremental-plan": {
      return applyMergePlan(
        target,
        unwrap(await planMergeIncremental(incremental)),
      );
    }
  }
}

for (const entry of backendMatrix()) {
  describe(`merge deletion dependencies (${entry.name})`, () => {
    const pool = createPgliteFixturePool();
    const cleanups: (() => Promise<void>)[] = [];

    afterEach(async () => {
      for (const cleanup of cleanups.reverse()) await cleanup();
      cleanups.length = 0;
    });
    afterAll(async () => pool.dispose());

    async function makeBackend() {
      const fixture =
        entry.name === "PGlite" ? await pool.makeFixture() : await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function seed() {
      const [target] = await createStoreWithSchema(graph, await makeBackend(), {
        history: true,
      });
      const left = await target.nodes.Item.create({ name: "left" });
      const right = await target.nodes.Item.create({ name: "right" });
      return {
        target,
        left: { kind: "Item", id: left.id } as const,
        right: { kind: "Item", id: right.id } as const,
      };
    }

    for (const mode of MODES) {
      for (const shape of [
        "outgoing",
        "incoming",
        "self-loop",
        "both",
      ] as const) {
        it(`${mode}: deletes an explicit ${shape} edge before its endpoint`, async () => {
          const { target, left, right } = await seed();
          const edge = await target.edges.links.create(
            shape === "incoming" ? right : left,
            shape === "self-loop" || shape === "incoming" ? left : right,
            {},
          );
          const before = await target.recordedNow();
          if (before === undefined) throw new Error("Missing recorded anchor");
          const source = unwrap(await branch(target, () => makeBackend()));
          await source.store.edges.links.delete(edge.id);
          await source.store.nodes.Item.delete(left.id);
          if (shape === "both") await source.store.nodes.Item.delete(right.id);

          // New edge endpoints must still be created before their edge is written.
          const added = await source.store.nodes.Item.create({ name: "added" });
          const addedRef = { kind: "Item", id: added.id } as const;
          const addedEdge = await source.store.edges.links.create(
            addedRef,
            addedRef,
            {},
          );

          unwrap(await apply(mode, target, source));

          expect(await target.nodes.Item.getById(left.id)).toBeUndefined();
          expect(await target.edges.links.getById(edge.id)).toBeUndefined();
          if (shape === "both") {
            expect(await target.nodes.Item.getById(right.id)).toBeUndefined();
          } else {
            expect(await target.nodes.Item.getById(right.id)).toBeDefined();
          }
          expect(await target.edges.links.getById(addedEdge.id)).toBeDefined();
          const historical = target.asOfRecorded(before);
          expect(await historical.nodes.Item.getById(left.id)).toBeDefined();
          expect(await historical.edges.links.getById(edge.id)).toBeDefined();
        });
      }
    }

    for (const mode of ["merge", "incremental"] as const) {
      it(`${mode}: refuses an undeleted edge in an externally populated branch`, async () => {
        const [base] = await createStoreWithSchema(graph, await makeBackend(), {
          revisionTracking: true,
        });
        const left = await base.nodes.Item.create({ name: "left" });
        const right = await base.nodes.Item.create({ name: "right" });
        const first = await base.edges.links.create(left, right, {});
        const remaining = await base.edges.links.create(right, left, {});
        const source = unwrap(await branch(base, () => makeBackend()));
        const target =
          mode === "merge" ? base : (
            unwrap(await branch(base, () => makeBackend())).store
          );
        await source.store.edges.links.delete(first.id);
        // A working copy can be populated outside the Store facade. Preserve
        // the other edge while tombstoning its endpoint to exercise the
        // target's restrict guard through the internal executor.
        await getStoreBackend(source.store).deleteNode({
          graphId: source.store.graphId,
          kind: "Item",
          id: left.id,
        });
        const before = await target.revisionNow();

        const result =
          mode === "merge" ?
            await merge(base, [source])
          : await mergeIncremental({
              forkPoint: base,
              target,
              branches: [source],
            });

        expect(isErr(result)).toBe(true);
        if (!isErr(result))
          throw new Error("Expected restricted node deletion");
        expect(result.error).toBeInstanceOf(RestrictedDeleteMergeConflictError);
        expect(result.error.cause).toBeInstanceOf(RestrictedDeleteError);
        expect(result.error.cause).toMatchObject({ details: { edgeCount: 1 } });
        expect(await target.nodes.Item.getById(left.id)).toBeDefined();
        expect(await target.edges.links.getById(first.id)).toBeDefined();
        expect(await target.edges.links.getById(remaining.id)).toBeDefined();
        expect(await target.revisionNow()).toEqual(before);
      });
    }

    it("refuses at plan time a restricted delete blocked by an edge the target added after the fork", async () => {
      const [forkPoint] = await createStoreWithSchema(
        graph,
        await makeBackend(),
        { revisionTracking: true },
      );
      const a = await forkPoint.nodes.Item.create({ name: "a" });
      const b = await forkPoint.nodes.Item.create({ name: "b" });
      const c = await forkPoint.nodes.Item.create({ name: "c" });
      const inherited = await forkPoint.edges.links.create(a, b, {});
      const source = unwrap(await branch(forkPoint, () => makeBackend()));
      const target = unwrap(await branch(forkPoint, () => makeBackend())).store;
      const blocking = await target.edges.links.create(c, b, {});
      await source.store.edges.links.delete(inherited.id);
      await source.store.nodes.Item.delete(b.id);

      const planned = await planMergeIncremental({
        forkPoint,
        target,
        branches: [source],
      });

      // The plan used to come back `ok`, listing the target's own blocking
      // edge under `dropped` as `edge:endpoint-deleted`, and its apply always
      // refused with RESTRICTED_DELETE.
      expect(isErr(planned)).toBe(true);
      if (!isErr(planned)) throw new Error("Expected a plan-time refusal");
      expect(planned.error).toBeInstanceOf(RestrictedDeleteMergeConflictError);
      expect(planned.error.cause).toBeInstanceOf(RestrictedDeleteError);
      expect(planned.error.details).toMatchObject({
        constraintCode: "RESTRICTED_DELETE",
        nodeId: b.id,
        edgeCount: 1,
        edgeKinds: ["links"],
      });
      expect(await target.edges.links.getById(blocking.id)).toBeDefined();
      expect(await target.nodes.Item.getById(b.id)).toBeDefined();
    });

    for (const onDelete of ["cascade", "disconnect"] as const) {
      for (const mode of MODES) {
        it(`${mode}: records explicit edge removals and emits their hooks under ${onDelete}`, async () => {
          const deletionEvents: string[] = [];
          const selectedGraph = defineGraph({
            id: `merge-delete-order-${onDelete}`,
            nodes: { Item: { type: Item, onDelete } },
            edges: graph.edges,
          });
          const [target] = await createStoreWithSchema(
            selectedGraph,
            await makeBackend(),
            {
              history: true,
              hooks: {
                onOperationEnd: (context) => {
                  if (context.operation === "delete") {
                    deletionEvents.push(`${context.entity}:${context.id}`);
                  }
                },
              },
            },
          );
          const left = await target.nodes.Item.create({ name: "left" });
          const right = await target.nodes.Item.create({ name: "right" });
          const first = await target.edges.links.create(left, right, {});
          const second = await target.edges.links.create(right, left, {});
          const before = await target.recordedNow();
          if (before === undefined) throw new Error("Missing recorded anchor");
          const source = unwrap(await branch(target, () => makeBackend()));
          await source.store.edges.links.delete(first.id);
          await source.store.edges.links.delete(second.id);
          await source.store.nodes.Item.delete(left.id);
          deletionEvents.length = 0;

          unwrap(await apply(mode, target, source));

          expect(deletionEvents).toHaveLength(3);
          expect(deletionEvents.slice(0, 2).sort()).toEqual(
            [`edge:${first.id}`, `edge:${second.id}`].sort(),
          );
          expect(deletionEvents[2]).toBe(`node:${left.id}`);
          expect(await target.nodes.Item.getById(left.id)).toBeUndefined();
          expect(await target.nodes.Item.getById(right.id)).toBeDefined();
          expect(await target.edges.links.getById(first.id)).toBeUndefined();
          expect(await target.edges.links.getById(second.id)).toBeUndefined();
          const after = await target.recordedNow();
          if (after === undefined) throw new Error("Missing recorded anchor");
          expect(after).not.toBe(before);
          const historical = target.asOfRecorded(before);
          expect(await historical.nodes.Item.getById(left.id)).toBeDefined();
          expect(await historical.edges.links.getById(first.id)).toBeDefined();
          expect(await historical.edges.links.getById(second.id)).toBeDefined();
          const committed = target.asOfRecorded(after);
          expect(await committed.nodes.Item.getById(left.id)).toBeUndefined();
          expect(await committed.edges.links.getById(first.id)).toBeUndefined();
          expect(
            await committed.edges.links.getById(second.id),
          ).toBeUndefined();
        });
      }
    }

    it("refuses a remaining edge and rolls back earlier explicit edge removals", async () => {
      const { target, left, right } = await seed();
      const first = await target.edges.links.create(left, right, {});
      const remaining = await target.edges.links.create(right, left, {});
      const source = unwrap(await branch(target, () => makeBackend()));
      await source.store.edges.links.delete(first.id);
      await source.store.edges.links.delete(remaining.id);
      await source.store.nodes.Item.delete(left.id);
      const artifact = unwrap(await planMerge(target, [source]));
      const { digest: _digest, ...input } = artifact;
      const partial = await constructMergePlanArtifact({
        ...input,
        proposed: {
          ...input.proposed,
          edges: {
            ...input.proposed.edges,
            deletions: input.proposed.edges.deletions - 1,
          },
        },
        writes: {
          ...input.writes,
          edgeDeletes: input.writes.edgeDeletes.filter(
            (deletion) => deletion.id !== remaining.id,
          ),
        },
      });
      const before = await target.revisionNow();

      const result = await applyMergePlan(target, partial);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected restricted node deletion");
      expect(result.error).toBeInstanceOf(MergeConstraintConflictError);
      expect(result.error.cause).toBeInstanceOf(RestrictedDeleteError);
      expect(result.error.cause).toMatchObject({ details: { edgeCount: 1 } });
      expect(await target.nodes.Item.getById(left.id)).toBeDefined();
      expect(await target.edges.links.getById(first.id)).toBeDefined();
      expect(await target.edges.links.getById(remaining.id)).toBeDefined();
      expect(await target.revisionNow()).toEqual(before);
    });

    it("rolls back successful deletions when a later apply callback fails", async () => {
      const { target, left, right } = await seed();
      const edge = await target.edges.links.create(left, right, {});
      const source = unwrap(await branch(target, () => makeBackend()));
      await source.store.edges.links.delete(edge.id);
      await source.store.nodes.Item.delete(left.id);
      const artifact = unwrap(await planMerge(target, [source]));
      const before = await target.revisionNow();
      const failure = new Error("Abort after plan writes");
      const result = await applyMergePlan(target, artifact, {
        afterApply: async (tx) => {
          expect(await tx.nodes.Item.getById(left.id)).toBeUndefined();
          throw failure;
        },
      });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected callback failure");
      expect(result.error.cause).toBe(failure);
      expect(await target.nodes.Item.getById(left.id)).toBeDefined();
      expect(await target.edges.links.getById(edge.id)).toBeDefined();
      expect(await target.revisionNow()).toEqual(before);
    });
  });
}
