/**
 * Algebraic laws of provenance retraction, checked over randomly generated
 * provenance graphs (multi-premise justifications, fact-as-premise chains,
 * premise-less always-firing justifications, shared unique keys via fulltext
 * fields — richer shapes than the example-based tests).
 *
 * - Inverse law: from a coherent state, `unRetract(s) ∘ retract(s)` restores
 *   the whole observable state (nodes, edges, uniques, fulltext).
 * - Frame law: `retract(s)` never touches edges, and only mutates the source
 *   itself plus fact rows reachable from it.
 * - Order independence: retracting a set of sources one-by-one (in either
 *   order) ends in exactly the state of `retractMany`.
 * - Model law: `holding()` always equals the reference TMS fixpoint
 *   (supported facts) intersected with the live fact rows.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
} from "../../src";
import { createRetractionCapability } from "../../src/provenance";
import { requireDefined } from "../../src/utils/presence";
import { dumpObservableState } from "../state-snapshot";
import { createTestBackend } from "../test-utils";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Fact = defineNode("Fact", {
  schema: z.object({ code: z.string() }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const Note = defineNode("Note", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");
const attachedTo = defineEdge("attachedTo");

const graph = defineGraph({
  id: "provenance_laws",
  nodes: {
    Source: { type: Source },
    Fact: {
      type: Fact,
      unique: [
        {
          name: "fact_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Justification: { type: Justification },
    Note: { type: Note },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, Fact],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [Fact],
    },
    attachedTo: {
      type: attachedTo,
      from: [Fact],
      to: [Note],
    },
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type LawStore = HistoryStore<typeof graph>;

/**
 * A justification's premises are indexes into sources (negative encoding
 * avoided by two arrays) and facts; its conclusions are fact indexes. An
 * empty premise list makes it fire unconditionally — such facts are outside
 * every source's reach and must never be touched by a transition.
 */
type JustificationSpec = Readonly<{
  sourcePremises: readonly number[];
  factPremises: readonly number[];
  derivedFacts: readonly number[];
}>;

type World = Readonly<{
  sourceCount: number;
  factCount: number;
  justifications: readonly JustificationSpec[];
  attachedFacts: readonly number[];
}>;

const worldArb: fc.Arbitrary<World> = fc
  .record({
    sourceCount: fc.integer({ min: 1, max: 3 }),
    factCount: fc.integer({ min: 1, max: 5 }),
  })
  .chain(({ sourceCount, factCount }) =>
    fc.record({
      sourceCount: fc.constant(sourceCount),
      factCount: fc.constant(factCount),
      justifications: fc.array(
        fc.record({
          sourcePremises: fc.uniqueArray(
            fc.integer({ min: 0, max: sourceCount - 1 }),
            { maxLength: sourceCount },
          ),
          factPremises: fc.uniqueArray(
            fc.integer({ min: 0, max: factCount - 1 }),
            { maxLength: 2 },
          ),
          derivedFacts: fc.uniqueArray(
            fc.integer({ min: 0, max: factCount - 1 }),
            { minLength: 1, maxLength: 2 },
          ),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      attachedFacts: fc.uniqueArray(
        fc.integer({ min: 0, max: factCount - 1 }),
        { maxLength: 2 },
      ),
    }),
  );

/**
 * Reference TMS fixpoint: the set of supported fact indexes given which
 * sources are retracted. Deliberately naive — an executable specification
 * the SQL-backed implementation is checked against.
 */
function modelSupportedFacts(
  world: World,
  retracted: ReadonlySet<number>,
): Set<number> {
  const supported = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const justification of world.justifications) {
      const fires =
        justification.sourcePremises.every(
          (sourceIndex) => !retracted.has(sourceIndex),
        ) &&
        justification.factPremises.every((factIndex) =>
          supported.has(factIndex),
        );
      if (!fires) continue;
      for (const factIndex of justification.derivedFacts) {
        if (!supported.has(factIndex)) {
          supported.add(factIndex);
          changed = true;
        }
      }
    }
  }
  return supported;
}

/**
 * Fact indexes reachable from a set of sources through justification edges —
 * the reference "affected" region for the frame law.
 */
function modelReachableFacts(
  world: World,
  sourceIndexes: ReadonlySet<number>,
): Set<number> {
  const reachable = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const justification of world.justifications) {
      const touchesFrontier =
        justification.sourcePremises.some((sourceIndex) =>
          sourceIndexes.has(sourceIndex),
        ) ||
        justification.factPremises.some((factIndex) =>
          reachable.has(factIndex),
        );
      if (!touchesFrontier) continue;
      for (const factIndex of justification.derivedFacts) {
        if (!reachable.has(factIndex)) {
          reachable.add(factIndex);
          changed = true;
        }
      }
    }
  }
  return reachable;
}

async function seedWorld(world: World): Promise<{
  store: LawStore;
  provenance: ReturnType<
    typeof createRetractionCapability<typeof graph, typeof config>
  >;
}> {
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    history: true,
  });

  const sources = [];
  for (let index = 0; index < world.sourceCount; index += 1) {
    sources.push(
      await store.nodes.Source.create(
        { label: `source-${index}`, retracted: false },
        { id: `source-${index}` },
      ),
    );
  }
  const facts = [];
  for (let index = 0; index < world.factCount; index += 1) {
    facts.push(
      await store.nodes.Fact.create(
        { code: `code-${index}` },
        { id: `fact-${index}` },
      ),
    );
  }
  for (const [
    justificationIndex,
    justification,
  ] of world.justifications.entries()) {
    const justificationNode = await store.nodes.Justification.create(
      { label: `justification-${justificationIndex}` },
      { id: `justification-${justificationIndex}` },
    );
    for (const sourceIndex of justification.sourcePremises) {
      await store.edges.premiseOf.create(
        requireDefined(sources[sourceIndex]),
        justificationNode,
        {},
        { id: `premise-s-${justificationIndex}-${sourceIndex}` },
      );
    }
    for (const factIndex of justification.factPremises) {
      await store.edges.premiseOf.create(
        requireDefined(facts[factIndex]),
        justificationNode,
        {},
        { id: `premise-f-${justificationIndex}-${factIndex}` },
      );
    }
    for (const factIndex of justification.derivedFacts) {
      await store.edges.derives.create(
        justificationNode,
        requireDefined(facts[factIndex]),
        {},
        { id: `derives-${justificationIndex}-${factIndex}` },
      );
    }
  }
  for (const factIndex of world.attachedFacts) {
    const note = await store.nodes.Note.create(
      { label: `note-${factIndex}` },
      { id: `note-${factIndex}` },
    );
    await store.edges.attachedTo.create(
      requireDefined(facts[factIndex]),
      note,
      {},
      {
        id: `attached-${factIndex}`,
      },
    );
  }

  const provenance = createRetractionCapability(store, config);
  return { store, provenance };
}

function sourceRef(index: number): { kind: "Source"; id: string } {
  return { kind: "Source", id: `source-${index}` };
}

/**
 * Brings a freshly seeded world into a coherent state (live ⟺ supported for
 * every fact in some source's reach): retract every source (closing all
 * reachable facts), then un-retract them all (reopening the supported ones).
 * The inverse law only holds on the coherent subspace — a live-but-never
 * -supported fact inside a source's reach is legitimately closed by the
 * first transition and never comes back.
 */
async function stabilize(
  provenance: Awaited<ReturnType<typeof seedWorld>>["provenance"],
  world: World,
): Promise<void> {
  const allSources = Array.from({ length: world.sourceCount }, (_, index) =>
    sourceRef(index),
  );
  await provenance.retractMany(allSources);
  await provenance.unRetractMany(allSources);
}

describe("provenance retraction laws", () => {
  it("inverse law: unRetract ∘ retract restores the observable state", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.nat(), async (world, sourcePick) => {
        const { store, provenance } = await seedWorld(world);
        await stabilize(provenance, world);
        const sourceIndex = sourcePick % world.sourceCount;

        const before = await dumpObservableState(store);
        await provenance.retract(sourceRef(sourceIndex));
        await provenance.unRetract(sourceRef(sourceIndex));
        const after = await dumpObservableState(store);

        expect(after).toEqual(before);
      }),
      { numRuns: 20 },
    );
  }, 60_000);

  it("frame law: retract never touches edges or anything outside the source's reach", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.nat(), async (world, sourcePick) => {
        const { store, provenance } = await seedWorld(world);
        await stabilize(provenance, world);
        const sourceIndex = sourcePick % world.sourceCount;
        const reach = modelReachableFacts(world, new Set([sourceIndex]));
        const reachIds = new Set(
          [...reach].map((factIndex) => `fact-${factIndex}`),
        );

        const before = await dumpObservableState(store);
        await provenance.retract(sourceRef(sourceIndex));
        const after = await dumpObservableState(store);

        // Edges are NEVER touched by a transition.
        expect(after.edges).toEqual(before.edges);

        // Only the flipped source and facts in its reach may change.
        const beforeNodes = new Map(
          before.nodes.map((node) => [`${node.kind}/${node.id}`, node]),
        );
        for (const node of after.nodes) {
          const key = `${node.kind}/${node.id}`;
          const previous = beforeNodes.get(key);
          if (JSON.stringify(previous) === JSON.stringify(node)) continue;
          const isFlippedSource =
            node.kind === "Source" && node.id === `source-${sourceIndex}`;
          const isReachableFact = node.kind === "Fact" && reachIds.has(node.id);
          expect(
            isFlippedSource || isReachableFact,
            `unexpected mutation of ${key}`,
          ).toBe(true);
        }

        // Sidecar rows may change only for facts in reach.
        const changedUniques = [...after.uniques, ...before.uniques].filter(
          (row) =>
            !after.uniques.some(
              (candidate) => JSON.stringify(candidate) === JSON.stringify(row),
            ) ||
            !before.uniques.some(
              (candidate) => JSON.stringify(candidate) === JSON.stringify(row),
            ),
        );
        for (const row of changedUniques) {
          expect(reachIds.has(row.nodeId)).toBe(true);
        }
      }),
      { numRuns: 20 },
    );
  }, 60_000);

  it("order independence: one-by-one retraction (either order) equals retractMany", async () => {
    await fc.assert(
      fc.asyncProperty(
        worldArb,
        fc.uniqueArray(fc.nat(), { minLength: 1, maxLength: 3 }),
        async (world, picks) => {
          const indexes = [
            ...new Set(picks.map((pick) => pick % world.sourceCount)),
          ];
          const references = indexes.map((index) => sourceRef(index));

          const run = async (
            transition: (
              provenance: Awaited<ReturnType<typeof seedWorld>>["provenance"],
            ) => Promise<void>,
          ) => {
            const { store, provenance } = await seedWorld(world);
            await stabilize(provenance, world);
            await transition(provenance);
            return dumpObservableState(store);
          };

          const batched = await run(async (provenance) => {
            await provenance.retractMany(references);
          });
          const forward = await run(async (provenance) => {
            for (const ref of references) await provenance.retract(ref);
          });
          const backward = await run(async (provenance) => {
            for (const ref of references.toReversed())
              await provenance.retract(ref);
          });

          expect(forward).toEqual(batched);
          expect(backward).toEqual(batched);
        },
      ),
      { numRuns: 15 },
    );
  }, 60_000);

  it("concurrency law: concurrent retractions converge to the serial state", async () => {
    await fc.assert(
      fc.asyncProperty(
        worldArb,
        fc.uniqueArray(fc.nat(), { minLength: 2, maxLength: 3 }),
        async (world, picks) => {
          const indexes = [
            ...new Set(picks.map((pick) => pick % world.sourceCount)),
          ];
          const references = indexes.map((index) => sourceRef(index));

          const serialWorld = await seedWorld(world);
          await stabilize(serialWorld.provenance, world);
          for (const ref of references)
            await serialWorld.provenance.retract(ref);
          const serial = await dumpObservableState(serialWorld.store);

          const concurrentWorld = await seedWorld(world);
          await stabilize(concurrentWorld.provenance, world);
          await Promise.all(
            references.map((ref) => concurrentWorld.provenance.retract(ref)),
          );
          const concurrent = await dumpObservableState(concurrentWorld.store);

          expect(concurrent).toEqual(serial);
        },
      ),
      { numRuns: 10 },
    );
  }, 60_000);

  it("model law: holding() equals the reference fixpoint over live facts", async () => {
    await fc.assert(
      fc.asyncProperty(
        worldArb,
        fc.array(fc.record({ pick: fc.nat(), retract: fc.boolean() }), {
          minLength: 1,
          maxLength: 5,
        }),
        async (world, transitions) => {
          const { store, provenance } = await seedWorld(world);

          const retracted = new Set<number>();
          for (const transition of transitions) {
            const index = transition.pick % world.sourceCount;
            if (transition.retract) {
              await provenance.retract(sourceRef(index));
              retracted.add(index);
            } else {
              await provenance.unRetract(sourceRef(index));
              retracted.delete(index);
            }
          }

          const supported = modelSupportedFacts(world, retracted);
          const state = await dumpObservableState(store);
          const liveFactIds = new Set(
            state.nodes
              .filter((node) => node.kind === "Fact" && !node.deleted)
              .map((node) => node.id),
          );
          const expected = [...supported]
            .map((factIndex) => `fact-${factIndex}`)
            .filter((id) => liveFactIds.has(id))
            .toSorted();

          const held = await provenance.holding();
          const holding = held.map((ref) => ref.id).toSorted();
          expect(holding).toEqual(expected);
        },
      ),
      { numRuns: 20 },
    );
  }, 60_000);
});
