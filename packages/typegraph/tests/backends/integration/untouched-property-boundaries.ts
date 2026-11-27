/**
 * The boundaries of the update rule (#851): a write that re-validates a stored
 * row stores every property it does not state as stored, and every one it
 * states as its schema makes it. Each case here is a way that rule could store
 * something other than what was validated or what a create stores:
 *
 *  - a stored object's key order, which PostgreSQL's JSONB chooses, must not
 *    leak into the value a uniqueness claim is keyed from;
 *  - a document value the schema coerces to another JSON type is input, not a
 *    stored value, so its parsed form is stored;
 *  - an object refinement must not approve a rewritten copy of a value the
 *    write then stores as it was;
 *  - a schema step that mutates its argument in place must not reach the
 *    stored value;
 *  - an undeclared key a refinement reports is not itself an invalid stored
 *    value;
 *  - a get-or-create must store the props it probed with;
 *  - a coalescing upsert compares the instant a `Date` holds;
 *  - a set update cannot fill a newly added default, so it is refused.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  ValidationError,
} from "../../../src";
import { rowPropsToObject } from "../../../src/backend/types";
import { STORED_PROPERTY_INVALID_CODE } from "../../../src/errors";
import { exportGraph, importGraph } from "../../../src/interchange";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const DAY_MS = 86_400_000;

const Tagged = defineNode("BoundaryTagged", {
  schema: z.object({
    title: z.string(),
    label: z.object({ zeta: z.string(), a: z.string() }),
  }),
});

const Counted = defineNode("BoundaryCounted", {
  schema: z.object({ title: z.string().optional(), n: z.coerce.number() }),
});

const Bounded = defineNode("BoundaryBounded", {
  schema: z
    .object({
      count: z.number().overwrite((value) => value + 1),
      minimum: z.number(),
    })
    .refine((value) => value.count >= value.minimum, {
      message: "count must reach minimum",
      path: ["count"],
    }),
});

const Mutated = defineNode("BoundaryMutated", {
  schema: z.object({
    title: z.string(),
    at: z
      .date()
      .optional()
      .overwrite((value) => {
        // Mutates its argument in place, then returns it.
        value?.setTime(value.getTime() + DAY_MS);
        return value;
      }),
  }),
});

const Flagged = defineNode("BoundaryFlagged", {
  schema: z
    .object({ title: z.string() })
    .loose()
    .superRefine((value, ctx) => {
      if (value.title === "bad") {
        ctx.addIssue({
          code: "custom",
          path: ["legacy"],
          message: "legacy conflicts with a bad title",
        });
      }
    }),
});

const Stamped = defineNode("BoundaryStamped", {
  schema: z.object({ title: z.string(), at: z.date() }),
});

const Defaulted = defineNode("BoundaryDefaulted", {
  schema: z.object({ title: z.string(), tier: z.string().default("basic") }),
});

let sequence = 0;

const sequenced = defineEdge("boundarySequenced", {
  schema: z.object({ seq: z.number().default(() => sequence++) }),
});

function boundaryGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      BoundaryTagged: {
        type: Tagged,
        unique: [
          {
            name: "boundary_tagged_label",
            fields: ["label"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      BoundaryCounted: { type: Counted },
      BoundaryBounded: { type: Bounded },
      BoundaryMutated: { type: Mutated },
      BoundaryFlagged: { type: Flagged },
      BoundaryStamped: { type: Stamped },
      BoundaryDefaulted: { type: Defaulted },
    },
    edges: {
      boundarySequenced: {
        type: sequenced,
        from: [Tagged],
        to: [Tagged],
      },
    },
  });
}

async function refusalOf(write: () => Promise<unknown>): Promise<unknown> {
  return write().then(
    () => "written",
    (error: unknown) => error,
  );
}

export function registerUntouchedPropertyBoundaryIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("the boundaries of the untouched-property rule (#851)", () => {
    it("an untouched object keeps its uniqueness claim whatever key order the backend returns it in", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_key_order"),
      );
      const label = { zeta: "z", a: "a" };
      const first = await store.nodes.BoundaryTagged.create({
        title: "a",
        label,
      });
      await store.nodes.BoundaryTagged.update(first.id, { title: "b" });
      await expect(
        store.nodes.BoundaryTagged.create({ title: "c", label }),
      ).rejects.toThrow();

      const target = await context.createStore(
        boundaryGraph("boundary_key_order_import"),
      );
      for (const onUnknownProperty of ["error", "strip", "allow"] as const) {
        const imported = await importGraph(target, await exportGraph(store), {
          onConflict: "update",
          onUnknownProperty,
        });
        expect([onUnknownProperty, imported.errors]).toEqual([
          onUnknownProperty,
          [],
        ]);
      }
      await expect(
        target.nodes.BoundaryTagged.create({ title: "d", label }),
      ).rejects.toThrow();
    });

    it("an imported value the schema coerces to another type is stored as parsed", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_coerced_import"),
      );
      const source = await context.createStore(
        boundaryGraph("boundary_coerced_source"),
      );
      const created = await source.nodes.BoundaryCounted.create({ n: 5 });
      const exported = await exportGraph(source);
      const document = {
        ...exported,
        nodes: exported.nodes.map((node) => ({
          ...node,
          properties: { ...node.properties, n: "7" },
        })),
      };
      const result = await importGraph(store, document, {
        onConflict: "error",
        onUnknownProperty: "error",
      });
      expect(result.errors).toEqual([]);
      const row = requireDefined(
        await store.backend.getNode(
          store.graphId,
          "BoundaryCounted",
          created.id,
        ),
      );
      expect(rowPropsToObject(row.props)["n"]).toBe(7);
      const matches = await store
        .query()
        .from("BoundaryCounted", "c")
        .whereNode("c", (node) => node.n.gt(6))
        .select((ctx) => ctx.c.id)
        .execute();
      expect(matches).toEqual([created.id]);
    });

    it("an object refinement that would check a rewritten unstated value refuses the write", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_refinement"),
      );
      const created = await store.nodes.BoundaryBounded.create({
        count: 0,
        minimum: 1,
      });
      // Stored count is 1. The parse sees it rewritten to 2, so the
      // refinement would pass for minimum 2 while the row keeps count 1.
      const refusal = await refusalOf(() =>
        store.nodes.BoundaryBounded.update(created.id, { minimum: 2 }),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      expect((refusal as ValidationError).details.issues).toEqual([
        expect.objectContaining({
          path: "count",
          code: STORED_PROPERTY_INVALID_CODE,
        }),
      ]);
      const row = requireDefined(
        await store.backend.getNode(
          store.graphId,
          "BoundaryBounded",
          created.id,
        ),
      );
      expect(rowPropsToObject(row.props)).toEqual({ count: 1, minimum: 1 });
      // Stating the property validates and stores what the schema makes.
      await store.nodes.BoundaryBounded.update(created.id, {
        count: 1,
        minimum: 2,
      });
      const restated = requireDefined(
        await store.backend.getNode(
          store.graphId,
          "BoundaryBounded",
          created.id,
        ),
      );
      expect(rowPropsToObject(restated.props)).toEqual({
        count: 2,
        minimum: 2,
      });
    });

    it("a schema step that mutates its argument in place does not change an untouched value", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_in_place"),
      );
      const created = await store.nodes.BoundaryMutated.create({
        title: "a",
        at: new Date("2024-01-01T00:00:00.000Z"),
      });
      const stored = created.at;
      await store.nodes.BoundaryMutated.update(created.id, { title: "b" });
      await store.nodes.BoundaryMutated.updateWhere({
        where: (node) => node.id.eq(created.id),
        patch: { title: "c" },
      });
      const read = await store.nodes.BoundaryMutated.getById(created.id);
      expect([read?.title, read?.at]).toEqual(["c", stored]);
    });

    it("an undeclared key a refinement reports keeps the refinement's issue", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_loose_refinement"),
      );
      const created = await store.nodes.BoundaryFlagged.create({
        title: "ok",
      });
      await store.backend.updateNode({
        graphId: store.graphId,
        kind: "BoundaryFlagged",
        id: created.id,
        props: { title: "ok", legacy: "x" },
        incrementVersion: true,
      });
      const refusal = await refusalOf(() =>
        store.nodes.BoundaryFlagged.update(created.id, { title: "bad" }),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      expect((refusal as ValidationError).details.issues).toEqual([
        expect.objectContaining({ path: "legacy", code: "custom" }),
      ]);
    });

    it("getOrCreateByEndpoints stores the props it probed with", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_probe_default"),
      );
      const from = await store.nodes.BoundaryTagged.create({
        title: "f",
        label: { zeta: "1", a: "1" },
      });
      const to = await store.nodes.BoundaryTagged.create({
        title: "t",
        label: { zeta: "2", a: "2" },
      });
      sequence = 100;
      const first = await store.edges.boundarySequenced.getOrCreateByEndpoints(
        from,
        to,
        {},
        { matchOn: ["seq"] },
      );
      expect([first.action, first.edge.seq]).toEqual(["created", 100]);
      sequence = 100;
      const again = await store.edges.boundarySequenced.getOrCreateByEndpoints(
        from,
        to,
        {},
        { matchOn: ["seq"] },
      );
      expect([again.action, again.edge.id]).toEqual(["found", first.edge.id]);
      sequence = 200;
      const [bulk] =
        await store.edges.boundarySequenced.bulkGetOrCreateByEndpoints(
          [{ from: to, to: from, props: {} }],
          { matchOn: ["seq"] },
        );
      expect([bulk?.action, bulk?.edge.seq]).toEqual(["created", 200]);
    });

    it("a coalescing upsert writes a Date whose own serializer names the stored instant", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_coalesce_date"),
        { coalesceUnchangedUpserts: true },
      );
      const stored = new Date("2024-01-01T00:00:00.000Z");
      const stated = new Date("2025-01-01T00:00:00.000Z");
      const created = await store.nodes.BoundaryStamped.create({
        title: "a",
        at: stored,
      });
      // Holds `stated`, but serializes as the stored instant.
      Object.defineProperty(stated, "toJSON", {
        value: () => stored.toISOString(),
      });
      await store.nodes.BoundaryStamped.upsertById(created.id, {
        title: "a",
        at: stated,
      });
      const read = await store.nodes.BoundaryStamped.getById(created.id);
      expect(read?.at).toBe("2025-01-01T00:00:00.000Z");
    });

    it("a set update over a row that lacks a newly added default is refused, and the row is unchanged", async () => {
      const store = await context.createStore(
        boundaryGraph("boundary_set_default"),
      );
      const created = await store.nodes.BoundaryDefaulted.create({
        title: "a",
      });
      await store.backend.updateNode({
        graphId: store.graphId,
        kind: "BoundaryDefaulted",
        id: created.id,
        props: { title: "a" },
        incrementVersion: true,
      });
      const refusal = await refusalOf(() =>
        store.nodes.BoundaryDefaulted.updateWhere({
          where: (node) => node.id.eq(created.id),
          patch: { title: "b" },
        }),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      const row = requireDefined(
        await store.backend.getNode(
          store.graphId,
          "BoundaryDefaulted",
          created.id,
        ),
      );
      expect(rowPropsToObject(row.props)).toEqual({ title: "a" });
      // The single-row update fills it.
      await store.nodes.BoundaryDefaulted.update(created.id, { title: "b" });
      const updated = requireDefined(
        await store.backend.getNode(
          store.graphId,
          "BoundaryDefaulted",
          created.id,
        ),
      );
      expect(rowPropsToObject(updated.props)).toEqual({
        title: "b",
        tier: "basic",
      });
    });
  });
}
