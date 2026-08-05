/**
 * Round-trip laws for the interchange format, checked over randomly
 * generated stores (unique constraints, fulltext fields, soft-deleted rows,
 * edges, unknown properties under `onUnknownProperty: "allow"`).
 *
 * - Fresh-target law: `import(export(store))` into an empty store reproduces
 *   the source's CURRENT observable state — rows, uniqueness reservations,
 *   and fulltext rows (export deliberately omits tombstones).
 * - Convergence law: importing the same document again — with `skip` or with
 *   `update` — changes nothing.
 * - Fidelity law: under `"allow"`, properties survive byte-for-byte across
 *   repeated export→import cycles, unknown keys included.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
} from "../../src";
import {
  exportGraph,
  exportGraphStream,
  importGraph,
  importGraphStream,
} from "../../src/interchange";
import {
  type GraphData,
  ImportOptionsSchema,
} from "../../src/interchange/types";
import { dumpObservableState, type ObservableState } from "../state-snapshot";
import { createTestBackend } from "../test-utils";

const Person = defineNode("Person", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    bio: searchable({ language: "english" }),
  }),
});

const knows = defineEdge("knows", {
  schema: z.object({ weight: z.number() }),
});

const graph = defineGraph({
  id: "interchange_roundtrip_laws",
  nodes: {
    Person: {
      type: Person,
      onDelete: "cascade",
      unique: [
        {
          name: "person_email",
          fields: ["email"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
  },
});

type World = Readonly<{
  nodeCount: number;
  deleted: readonly boolean[];
  edges: readonly Readonly<{ from: number; to: number; weight: number }>[];
}>;

const worldArb: fc.Arbitrary<World> = fc
  .integer({ min: 1, max: 6 })
  .chain((nodeCount) =>
    fc.record({
      nodeCount: fc.constant(nodeCount),
      deleted: fc.array(fc.boolean(), {
        minLength: nodeCount,
        maxLength: nodeCount,
      }),
      edges: fc.array(
        fc.record({
          from: fc.integer({ min: 0, max: nodeCount - 1 }),
          to: fc.integer({ min: 0, max: nodeCount - 1 }),
          weight: fc.integer({ min: 0, max: 100 }),
        }),
        { maxLength: 8 },
      ),
    }),
  );

function importOptions(
  overrides: Partial<z.input<typeof ImportOptionsSchema>>,
) {
  return ImportOptionsSchema.parse(overrides);
}

async function seedWorld(world: World) {
  const [store] = await createStoreWithSchema(graph, createTestBackend());
  for (let index = 0; index < world.nodeCount; index += 1) {
    await store.nodes.Person.create(
      {
        name: `person-${index}`,
        email: `person-${index}@example.com`,
        bio: `bio text ${index}`,
      },
      { id: `person-${index}` },
    );
  }
  for (const [edgeIndex, edge] of world.edges.entries()) {
    await store.edges.knows.create(
      { kind: "Person", id: `person-${edge.from}` } as never,
      { kind: "Person", id: `person-${edge.to}` } as never,
      { weight: edge.weight },
      { id: `knows-${edgeIndex}` },
    );
  }
  // Deletes run last so edges to a deleted endpoint cascade away.
  for (const [index, isDeleted] of world.deleted.entries()) {
    if (isDeleted) await store.nodes.Person.delete(`person-${index}` as never);
  }
  return store;
}

/** The live (query-observable) slice of a snapshot. */
function currentState(state: ObservableState): ObservableState {
  return {
    nodes: state.nodes.filter((node) => !node.deleted),
    edges: state.edges.filter((edge) => !edge.deleted),
    uniques: state.uniques,
    fulltext: state.fulltext,
  };
}

describe("interchange round-trip laws", () => {
  it("import(export(store)) into a fresh store reproduces the current state", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        const source = await seedWorld(world);
        const document = await exportGraph(source);

        const [target] = await createStoreWithSchema(
          graph,
          createTestBackend(),
        );
        const result = await importGraph(
          target,
          document,
          importOptions({ onConflict: "error" }),
        );
        expect(result.success).toBe(true);

        const sourceState = currentState(await dumpObservableState(source));
        const targetState = currentState(await dumpObservableState(target));
        expect(targetState).toEqual(sourceState);
      }),
      { numRuns: 20 },
    );
  }, 60_000);

  it("re-importing the same document converges (skip and update)", async () => {
    await fc.assert(
      fc.asyncProperty(
        worldArb,
        fc.constantFrom("skip" as const, "update" as const),
        async (world, onConflict) => {
          const source = await seedWorld(world);
          const document = await exportGraph(source);

          const [target] = await createStoreWithSchema(
            graph,
            createTestBackend(),
          );
          await importGraph(
            target,
            document,
            importOptions({ onConflict: "error" }),
          );
          const first = await dumpObservableState(target);

          const again = await importGraph(
            target,
            document,
            importOptions({ onConflict }),
          );
          expect(again.success).toBe(true);
          const second = await dumpObservableState(target);

          expect(second).toEqual(first);
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);

  it("streaming export/import reproduces the current state without graph-sized chunks", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        const source = await seedWorld(world);
        const [target] = await createStoreWithSchema(
          graph,
          createTestBackend(),
        );
        const result = await importGraphStream(
          target,
          exportGraphStream(source, { batchSize: 2 }),
          importOptions({ onConflict: "error" }),
        );
        expect(result.success).toBe(true);
        expect(currentState(await dumpObservableState(target))).toEqual(
          currentState(await dumpObservableState(source)),
        );
      }),
      { numRuns: 20 },
    );
  }, 60_000);

  it("allow preserves properties byte-for-byte across repeated cycles", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.string({ maxLength: 12 }),
            extraKey: fc.constantFrom("annotation", "sourceRef", "x"),
            extraValue: fc.string({ maxLength: 12 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        async (rows) => {
          // Hand-authored documents whose properties carry unknown keys.
          const document: GraphData = {
            formatVersion: "2.0",
            exportedAt: "2024-01-01T00:00:00.000Z",
            source: { type: "external" },
            nodes: rows.map((row, index) => ({
              kind: "Person",
              id: `person-${index}`,
              properties: {
                name: row.name,
                email: `person-${index}@example.com`,
                bio: `bio ${index}`,
                [row.extraKey]: row.extraValue,
              },
            })),
            edges: [],
          };

          const [first] = await createStoreWithSchema(
            graph,
            createTestBackend(),
          );
          const initial = await importGraph(
            first,
            document,
            importOptions({ onConflict: "error", onUnknownProperty: "allow" }),
          );
          expect(initial.success).toBe(true);

          // Two full export→import cycles must be byte-stable.
          const [cycleOne] = await createStoreWithSchema(
            graph,
            createTestBackend(),
          );
          await importGraph(
            cycleOne,
            await exportGraph(first),
            importOptions({ onConflict: "error", onUnknownProperty: "allow" }),
          );
          const [cycleTwo] = await createStoreWithSchema(
            graph,
            createTestBackend(),
          );
          await importGraph(
            cycleTwo,
            await exportGraph(cycleOne),
            importOptions({ onConflict: "error", onUnknownProperty: "allow" }),
          );

          const stateOne = await dumpObservableState(cycleOne);
          const stateTwo = await dumpObservableState(cycleTwo);
          expect(stateTwo).toEqual(stateOne);
          expect(stateOne.nodes.map((node) => node.props)).toEqual(
            document.nodes.map((node) => node.properties),
          );
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});
