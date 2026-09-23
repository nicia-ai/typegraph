/**
 * Data-validated tightening for edge cardinality (issue #610, acceptance
 * criterion 7), stacking on item A's schema-tightening preflight
 * (`src/schema/tightening-preflight.ts`, `prepareSchemaTighteningPreflight`).
 *
 * Every case states, in its own comment, the mutation that must make it
 * fail; the revert/mutation checks actually performed are recorded in the
 * scratchpad `lane-D1-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  MigrationError,
} from "../../../src";
import {
  getActiveSchema,
  getSchemaChanges,
  migrateSchema,
} from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("TighteningPerson", { schema: z.object({}) });
const Target = defineNode("TighteningTarget", { schema: z.object({}) });
const assignedTo = defineEdge("tighteningAssignedTo", { schema: z.object({}) });

function buildGraph(
  id: string,
  options: Readonly<{ cardinality?: "one"; targetCardinality?: "one" }>,
) {
  return defineGraph({
    id,
    nodes: {
      TighteningPerson: { type: Person },
      TighteningTarget: { type: Target },
    },
    edges: {
      tighteningAssignedTo: {
        type: assignedTo,
        from: [Person],
        to: [Target],
        ...options,
      },
    },
  });
}

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

export function registerEdgeCardinalityTighteningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge cardinality tightening (data-validated)", () => {
    it("refuses tightening targetCardinality against a target that already has two incoming edges", async () => {
      const id = "edge_cardinality_tightening_target_dirty";
      const store = await context.createStore(buildGraph(id, {}));
      const alice = await store.nodes.TighteningPerson.create({});
      const bob = await store.nodes.TighteningPerson.create({});
      const target = await store.nodes.TighteningTarget.create({});
      await store.edges.tighteningAssignedTo.create(alice, target, {});
      await store.edges.tighteningAssignedTo.create(bob, target, {});

      const error = await createAdapterStoreWithSchema(
        buildGraph(id, { targetCardinality: "one" }),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "edge-cardinality-tightening-violated") {
        throw new Error(
          `expected edge-cardinality-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.axes).toEqual([
        {
          direction: "target",
          cardinality: "one",
          edgeKind: "tighteningAssignedTo",
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (verified): make `newlyConstrainedEdgeAxes`
    // (`src/schema/edge-cardinality-change.ts`) return `[]` unconditionally.
    // The commit then succeeds and `activeVersion` reads 2 instead of 1.

    it("establishes enforcement once tightening commits against clean data", async () => {
      const id = "edge_cardinality_tightening_target_clean";
      const store = await context.createStore(buildGraph(id, {}));
      const alice = await store.nodes.TighteningPerson.create({});
      const bob = await store.nodes.TighteningPerson.create({});
      const target = await store.nodes.TighteningTarget.create({});
      await store.edges.tighteningAssignedTo.create(alice, target, {});

      const version = await migrateSchema(
        context.getBackend(),
        buildGraph(id, { targetCardinality: "one" }),
        await activeVersion(context, id),
      );
      expect(version).toBe(2);

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildGraph(id, { targetCardinality: "one" }),
        context.getBackend(),
      );
      await expect(
        upgradedStore.edges.tighteningAssignedTo.create(bob, target, {}),
      ).rejects.toMatchObject({ details: { direction: "target" } });
    });

    it("reports the change through getSchemaChanges before the upgrade is attempted", async () => {
      const id = "edge_cardinality_tightening_get_changes";
      await context.createStore(buildGraph(id, {}));

      const diff = await getSchemaChanges(
        context.getBackend(),
        buildGraph(id, { targetCardinality: "one" }),
      );
      expect(diff?.hasChanges).toBe(true);
      const change = diff?.edges.find(
        (candidate) => candidate.kind === "tighteningAssignedTo",
      );
      expect(change?.details).toContain("Target cardinality");
      // Read-only: reporting the diff must not itself publish a version.
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses the same tightening through Store.evolve()", async () => {
      const id = "edge_cardinality_tightening_evolve";
      const store = await context.createStore(
        defineGraph({
          id,
          nodes: { TighteningPerson: { type: Person } },
          edges: {},
        }),
      );
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: {
            TighteningTag: { properties: { label: { type: "string" } } },
          },
          edges: {
            tighteningTagged: {
              from: ["TighteningTag"],
              to: ["TighteningPerson"],
              properties: {},
            },
          },
        }),
      );
      const alice = await evolved.nodes.TighteningPerson.create({});
      const tagCol = requireDefined(evolved.getNodeCollection("TighteningTag"));
      const tagA = (await tagCol.create({ label: "a" })) as unknown as {
        kind: string;
        id: string;
      };
      const tagB = (await tagCol.create({ label: "b" })) as unknown as {
        kind: string;
        id: string;
      };
      const taggedCol = requireDefined(
        evolved.getEdgeCollection("tighteningTagged"),
      );
      await taggedCol.create(
        { kind: "TighteningTag", id: tagA.id },
        { kind: "TighteningPerson", id: alice.id },
        {},
      );
      await taggedCol.create(
        { kind: "TighteningTag", id: tagB.id },
        { kind: "TighteningPerson", id: alice.id },
        {},
      );

      const error = await evolved
        .evolve(
          defineGraphExtension({
            edges: {
              tighteningTagged: {
                from: ["TighteningTag"],
                to: ["TighteningPerson"],
                properties: {},
                targetCardinality: "one",
              },
            },
          }),
        )
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "edge-cardinality-tightening-violated") {
        throw new Error(
          `expected edge-cardinality-tightening-violated, got ${details.reason}`,
        );
      }
    });

    it("applies the same data probe to a source-side tightening (many -> one)", async () => {
      const id = "edge_cardinality_tightening_source_dirty";
      const store = await context.createStore(buildGraph(id, {}));
      const alice = await store.nodes.TighteningPerson.create({});
      const target1 = await store.nodes.TighteningTarget.create({});
      const target2 = await store.nodes.TighteningTarget.create({});
      await store.edges.tighteningAssignedTo.create(alice, target1, {});
      await store.edges.tighteningAssignedTo.create(alice, target2, {});

      const error = await createAdapterStoreWithSchema(
        buildGraph(id, { cardinality: "one" }),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "edge-cardinality-tightening-violated") {
        throw new Error(
          `expected edge-cardinality-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.axes).toEqual([
        {
          direction: "source",
          cardinality: "one",
          edgeKind: "tighteningAssignedTo",
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (verified): in `newlyConstrainedEdgeAxes`
    // (`src/schema/edge-cardinality-change.ts`), skip the `direction ===
    // "source"` ref entirely (only ever push target refs). This case then
    // commits and `activeVersion` reads 2 instead of 1 — pinning that the
    // generalization covers the axis item A's own plan never touched.
  });
}
