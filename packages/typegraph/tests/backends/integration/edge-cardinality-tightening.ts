/**
 * Data-validated tightening for edge cardinality (issue #610), stacking on the schema-tightening preflight
 * (`src/schema/tightening-preflight.ts`, `prepareSchemaTighteningPreflight`).
 *
 * Every case states, in its own comment, the mutation that must make it
 * fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  createStore,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  MigrationError,
} from "../../../src";
import { projectBackendWithout } from "../../../src/backend/derive-backend";
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
  options: Readonly<{
    cardinality?: "one" | "oneActive";
    targetCardinality?: "one" | "oneActive";
  }>,
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

    it("plans a cardinality-only tightening as an edge-tightening requirement, never an empty ontology one", async () => {
      const id = "edge_cardinality_tightening_plan_requirement";
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

      const plan = await evolved.planEvolution(
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
      );

      if (plan.status !== "change") throw new Error("Expected a change plan.");
      expect(
        plan.requirements.filter(
          (requirement) =>
            requirement.kind === "ontology-tightening" ||
            requirement.kind === "edge-tightening",
        ),
      ).toEqual([
        {
          kind: "edge-tightening",
          edgeKinds: ["tighteningTagged"],
          edgeCardinalityAxes: [
            {
              direction: "target",
              cardinality: "one",
              edgeKind: "tighteningTagged",
            },
          ],
        },
      ]);
    });
    // MUTATION CHECK: emitting the requirement as `ontology-tightening`
    // again (empty `changes`, the axes beside it) fails the equality.

    describe("a commit that tightens an edge kind two ways at once", () => {
      const linkedTo = defineEdge("tighteningLinkedTo", {
        schema: z.object({}),
      });

      function buildLinkGraph(
        id: string,
        options: Readonly<{ acyclic?: true; targetCardinality?: "one" }>,
      ) {
        return defineGraph({
          id,
          nodes: { TighteningPerson: { type: Person } },
          edges: {
            tighteningLinkedTo: {
              type: linkedTo,
              from: [Person],
              to: [Person],
              ...options,
            },
          },
        });
      }

      async function seedCycleWithTwoIncoming(id: string): Promise<void> {
        const store = await context.createStore(buildLinkGraph(id, {}));
        const first = await store.nodes.TighteningPerson.create({});
        const second = await store.nodes.TighteningPerson.create({});
        const third = await store.nodes.TighteningPerson.create({});
        await store.edges.tighteningLinkedTo.create(first, second, {});
        await store.edges.tighteningLinkedTo.create(second, first, {});
        await store.edges.tighteningLinkedTo.create(third, first, {});
      }

      it("refuses once, reporting every violated family, so one repair covers both", async () => {
        const id = "edge_cardinality_tightening_combined";
        await seedCycleWithTwoIncoming(id);
        const proposed = buildLinkGraph(id, {
          acyclic: true,
          targetCardinality: "one",
        });

        const error = await migrateSchema(
          context.getBackend(),
          proposed,
          await activeVersion(context, id),
        ).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(MigrationError);
        const details = (error as MigrationError).details;
        if (details.reason !== "edge-cardinality-tightening-violated") {
          throw new Error(
            `expected edge-cardinality-tightening-violated, got ${details.reason}`,
          );
        }
        expect(
          details.violations.map((violation) => violation.family).toSorted(),
        ).toEqual(["edgeAcyclicity", "edgeCardinality"]);
        expect(details.edgeKinds).toEqual(["tighteningLinkedTo"]);
        expect(details.changes).toEqual([]);
        const audited = await createStore(
          proposed,
          context.getBackend(),
        ).verifyConstraintFences();
        expect(audited.map((violation) => violation.family).toSorted()).toEqual(
          ["edgeAcyclicity", "edgeCardinality"],
        );
        expect(await activeVersion(context, id)).toBe(1);
      });
      // MUTATION CHECK: filtering `details.violations` back down to the
      // `edgeCardinality` rows (the previous refusal) drops `edgeAcyclicity`
      // from the first assertion.

      it("names the keyed nodes and edge kind of a cardinality violation in plain values", async () => {
        const id = "edge_cardinality_tightening_plain_values";
        await seedCycleWithTwoIncoming(id);

        const error = await migrateSchema(
          context.getBackend(),
          buildLinkGraph(id, { targetCardinality: "one" }),
          await activeVersion(context, id),
        ).catch((error_: unknown) => error_);

        const details = (error as MigrationError).details;
        if (details.reason !== "edge-cardinality-tightening-violated") {
          throw new Error(
            `expected edge-cardinality-tightening-violated, got ${details.reason}`,
          );
        }
        expect(details.violations).toEqual([
          expect.objectContaining({
            family: "edgeCardinality",
            edgeKind: "tighteningLinkedTo",
            direction: "target",
            cardinality: "one",
            keyedOn: {
              to: {
                kind: "TighteningPerson",
                id: expect.any(String) as string,
              },
            },
          }),
        ]);
      });
      // MUTATION CHECK: dropping `plainContention`'s plain fields from the
      // `edgeCardinality` violation (`src/store/claims/verify.ts`) leaves
      // only `target`, whose `axis` and `key` are storage encodings.

      it("reports acyclic in the edge diff, never in the ontology diff", async () => {
        const id = "edge_cardinality_tightening_diff_placement";
        await context.createStore(buildLinkGraph(id, {}));

        const diff = await getSchemaChanges(
          context.getBackend(),
          buildLinkGraph(id, { acyclic: true }),
        );

        expect(diff?.ontology).toEqual([]);
        expect(diff?.edges.map((change) => change.details)).toEqual([
          'Edge "tighteningLinkedTo" declared acyclic: true',
        ]);
      });
      // MUTATION CHECK: removing the `acyclicFlagTransition` arm from
      // `diffEdgeDef` (`src/schema/migration.ts`) leaves `diff.edges` empty.
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
    // generalization covers axes the original tightening plan never touched.

    for (const direction of ["source", "target"] as const) {
      const declare = (cardinality: "one" | "oneActive") =>
        direction === "source" ?
          { cardinality }
        : { targetCardinality: cardinality };

      it(`commits ${direction} one -> oneActive over populated edges with no preflight, on a backend without the atomic primitive`, async () => {
        const id = `edge_cardinality_loosening_${direction}`;
        const store = await context.createStore(buildGraph(id, declare("one")));
        const alice = await store.nodes.TighteningPerson.create({});
        const target = await store.nodes.TighteningTarget.create({});
        const edge = await store.edges.tighteningAssignedTo.create(
          alice,
          target,
          {},
        );
        await store.edges.tighteningAssignedTo.update(
          edge.id,
          {},
          { validTo: new Date().toISOString() },
        );

        // A backend with no atomic preflight primitive refuses every commit
        // that owes a data check, so committing through it proves none is owed.
        const [upgraded] = await createAdapterStoreWithSchema(
          buildGraph(id, declare("oneActive")),
          projectBackendWithout(context.getBackend(), [
            "commitSchemaVersionWithPreflight",
          ]),
        );
        expect(await activeVersion(context, id)).toBe(2);

        // The ended row no longer occupies the axis.
        const otherTarget = await upgraded.nodes.TighteningTarget.create({});
        const otherPerson = await upgraded.nodes.TighteningPerson.create({});
        await expect(
          direction === "source" ?
            upgraded.edges.tighteningAssignedTo.create(alice, otherTarget, {})
          : upgraded.edges.tighteningAssignedTo.create(otherPerson, target, {}),
        ).resolves.toBeDefined();
      });
      // MUTATION CHECK (verified): make `cardinalityLoosens`
      // (`src/schema/edge-cardinality-change.ts`) return `false`. The axis is
      // then probed, the restricted backend refuses with
      // EDGE_CARDINALITY_TIGHTENING_REQUIRES_ATOMIC_BACKEND, and the version
      // stays 1.

      it(`probes ${direction} oneActive -> one as a tightening and refuses an ended row beside an open one`, async () => {
        const id = `edge_cardinality_tightening_active_${direction}`;
        const store = await context.createStore(
          buildGraph(id, declare("oneActive")),
        );
        const alice = await store.nodes.TighteningPerson.create({});
        const bob = await store.nodes.TighteningPerson.create({});
        const target = await store.nodes.TighteningTarget.create({});
        const otherTarget = await store.nodes.TighteningTarget.create({});
        const ended = await store.edges.tighteningAssignedTo.create(
          alice,
          target,
          {},
        );
        await store.edges.tighteningAssignedTo.update(
          ended.id,
          {},
          { validTo: new Date().toISOString() },
        );
        await (direction === "source" ?
          store.edges.tighteningAssignedTo.create(alice, otherTarget, {})
        : store.edges.tighteningAssignedTo.create(bob, target, {}));

        const error = await createAdapterStoreWithSchema(
          buildGraph(id, declare("one")),
          context.getBackend(),
        ).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(MigrationError);
        expect((error as MigrationError).details).toMatchObject({
          reason: "edge-cardinality-tightening-violated",
          axes: [
            { direction, cardinality: "one", edgeKind: "tighteningAssignedTo" },
          ],
        });
        expect(await activeVersion(context, id)).toBe(1);
      });
      // MUTATION CHECK (verified): make `cardinalityLoosens` also accept
      // `oneActive` -> `one`. The commit then succeeds and the version reads 2.
    }
  });
}
