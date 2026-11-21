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
 * - Closure law: for every fact, `assertHolds` (which loads only the closure
 *   behind the named facts) returns or refuses exactly as the whole-graph
 *   support snapshot says, with the same `via`, over graphs with fact-premise
 *   cycles, required composition parts, and sources in every currency state.
 *
 * The retraction laws run twice: with each verb in a transaction of its own,
 * and with each verb on a caller's transaction (`retract(s, tx)` inside
 * `store.transaction`), so both forms satisfy every law.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../src";
import {
  createRetractionCapability,
  FactNotHoldingError,
} from "../../src/provenance";
import { keyToRef, refKey } from "../../src/provenance/keys";
import { createCapabilityScope } from "../../src/provenance/scope";
import {
  availableSourceKeys,
  computeSupportSnapshot,
  type SupportSnapshot,
} from "../../src/provenance/support";
import {
  loadSupportClosure,
  loadSupportGraph,
} from "../../src/provenance/support-read";
import { storeBackend } from "../../src/store/runtime-port";
import type { HistoryStore } from "../../src/store-entry";
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

/**
 * Where a law's verbs run: in a transaction each verb opens itself, or on a
 * transaction the caller opened for that one call.
 */
const TRANSACTION_MODES = ["own transaction", "caller's transaction"] as const;
type TransactionMode = (typeof TRANSACTION_MODES)[number];

type LawProvenance = ReturnType<
  typeof createRetractionCapability<typeof graph, typeof config>
>;

/** `provenance` with every verb run in `mode`. */
function inTransactionMode(
  store: LawStore,
  provenance: LawProvenance,
  mode: TransactionMode,
): LawProvenance {
  if (mode === "own transaction") return provenance;
  return {
    ...provenance,
    retract: (source) =>
      store.transaction((tx) => provenance.retract(source, tx)),
    retractMany: (sources) =>
      store.transaction((tx) => provenance.retractMany(sources, tx)),
    unRetract: (source) =>
      store.transaction((tx) => provenance.unRetract(source, tx)),
    unRetractMany: (sources) =>
      store.transaction((tx) => provenance.unRetractMany(sources, tx)),
  };
}

async function seedWorld(
  world: World,
  mode: TransactionMode,
): Promise<{
  store: LawStore;
  provenance: LawProvenance;
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
  return { store, provenance: inTransactionMode(store, provenance, mode) };
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

describe.each(TRANSACTION_MODES)("provenance retraction laws, %s", (mode) => {
  it("inverse law: unRetract ∘ retract restores the observable state", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.nat(), async (world, sourcePick) => {
        const { store, provenance } = await seedWorld(world, mode);
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
        const { store, provenance } = await seedWorld(world, mode);
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
            const { store, provenance } = await seedWorld(world, mode);
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

          const serialWorld = await seedWorld(world, mode);
          await stabilize(serialWorld.provenance, world);
          for (const ref of references)
            await serialWorld.provenance.retract(ref);
          const serial = await dumpObservableState(serialWorld.store);

          const concurrentWorld = await seedWorld(world, mode);
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
          const { store, provenance } = await seedWorld(world, mode);

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

/**
 * Closure law. The graph adds required composition parts: a `Section` is a
 * required part of a `Fact` (a whole that carries its own belief status) and
 * an `Exhibit` a required part of a `Dossier` (a whole that does not). Facts
 * of all three kinds share one index space so premises and conclusions can
 * form cycles across kinds, including through a part and its whole. A
 * `Paragraph` is a required part of a `Section`, so a part can itself be a
 * whole and a verdict can depend on a chain of wholes.
 */
const Section = defineNode("Section", { schema: z.object({}) });
const Exhibit = defineNode("Exhibit", { schema: z.object({}) });
const Paragraph = defineNode("Paragraph", { schema: z.object({}) });
const Dossier = defineNode("Dossier", { schema: z.object({}) });
const sectionOf = defineEdge("sectionOf");
const exhibitOf = defineEdge("exhibitOf");
const paragraphOf = defineEdge("paragraphOf");

const CLOSURE_FACT_TYPES = [Fact, Section, Exhibit, Paragraph];

const closureGraph = defineGraph({
  id: "provenance_closure_laws",
  nodes: {
    Source: { type: Source, onDelete: "disconnect" },
    Justification: { type: Justification, onDelete: "disconnect" },
    Fact: { type: Fact, onDelete: "disconnect" },
    Section: { type: Section, onDelete: "disconnect" },
    Exhibit: { type: Exhibit, onDelete: "disconnect" },
    Paragraph: { type: Paragraph, onDelete: "disconnect" },
    Dossier: { type: Dossier },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, ...CLOSURE_FACT_TYPES],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: CLOSURE_FACT_TYPES,
    },
    sectionOf: {
      type: sectionOf,
      from: [Section],
      to: [Fact],
      cardinality: "one",
    },
    exhibitOf: {
      type: exhibitOf,
      from: [Exhibit],
      to: [Dossier],
      cardinality: "one",
    },
    paragraphOf: {
      type: paragraphOf,
      from: [Paragraph],
      to: [Section],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Section, Fact, { via: sectionOf, existence: "required" }),
    partOf(Exhibit, Dossier, { via: exhibitOf, existence: "required" }),
    partOf(Paragraph, Section, { via: paragraphOf, existence: "required" }),
  ],
});

const closureConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact", "Section", "Exhibit", "Paragraph"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type ClosureStore = HistoryStore<typeof closureGraph>;
type FactReference = Readonly<{
  kind: "Fact" | "Section" | "Exhibit" | "Paragraph";
  id: string;
}>;

/**
 * How a source stands when the facts are judged: `live`; `flagged` (the
 * retracted flag set by a plain write, so facts behind it stay live but
 * unsupported); `retracted` (through the capability, which also closes the
 * facts it reaches); `restored` (retracted, then the flag cleared by a plain
 * write, so the facts it closed are supported again but stay tombstoned);
 * `deleted` (soft-deleted, so no current row); `expired` (its validity window
 * ended, so it has no current row either, though it is not soft-deleted).
 */
const SOURCE_STATES = [
  "live",
  "flagged",
  "retracted",
  "restored",
  "deleted",
  "expired",
] as const;
type SourceState = (typeof SOURCE_STATES)[number];

type ClosureWorld = Readonly<{
  sourceStates: readonly SourceState[];
  factCount: number;
  sectionWholes: readonly number[];
  exhibitCount: number;
  /** Per paragraph, the index of the section it is a required part of. */
  paragraphWholes: readonly number[];
  justifications: readonly ClosureJustificationSpec[];
  futureFacts: readonly number[];
}>;

type ClosureJustificationSpec = JustificationSpec &
  Readonly<{ deleted: boolean }>;

/**
 * Index space of the facts a justification can name: `Fact` indexes first,
 * then `Section`, then `Exhibit`, then `Paragraph`.
 */
function closureFactReferences(world: ClosureWorld): readonly FactReference[] {
  return [
    ...Array.from({ length: world.factCount }, (_, index) => ({
      kind: "Fact" as const,
      id: `fact-${index}`,
    })),
    ...world.sectionWholes.map((_, index) => ({
      kind: "Section" as const,
      id: `section-${index}`,
    })),
    ...Array.from({ length: world.exhibitCount }, (_, index) => ({
      kind: "Exhibit" as const,
      id: `exhibit-${index}`,
    })),
    ...world.paragraphWholes.map((_, index) => ({
      kind: "Paragraph" as const,
      id: `paragraph-${index}`,
    })),
  ];
}

function closureWorldArb(): fc.Arbitrary<ClosureWorld> {
  return fc
    .record({
      sourceStates: fc.array(fc.constantFrom(...SOURCE_STATES), {
        minLength: 1,
        maxLength: 3,
      }),
      factCount: fc.integer({ min: 1, max: 3 }),
      sectionCount: fc.integer({ min: 0, max: 3 }),
      exhibitCount: fc.integer({ min: 0, max: 2 }),
      paragraphCount: fc.integer({ min: 0, max: 2 }),
    })
    .chain((shape) => {
      const paragraphCount =
        shape.sectionCount === 0 ? 0 : shape.paragraphCount;
      const totalFacts =
        shape.factCount +
        shape.sectionCount +
        shape.exhibitCount +
        paragraphCount;
      return fc.record({
        sourceStates: fc.constant(shape.sourceStates),
        factCount: fc.constant(shape.factCount),
        sectionWholes: fc.array(
          fc.integer({ min: 0, max: shape.factCount - 1 }),
          { minLength: shape.sectionCount, maxLength: shape.sectionCount },
        ),
        exhibitCount: fc.constant(shape.exhibitCount),
        paragraphWholes: fc.array(
          fc.integer({ min: 0, max: Math.max(shape.sectionCount - 1, 0) }),
          { minLength: paragraphCount, maxLength: paragraphCount },
        ),
        justifications: fc.array(
          fc.record({
            sourcePremises: fc.uniqueArray(
              fc.integer({ min: 0, max: shape.sourceStates.length - 1 }),
              { maxLength: shape.sourceStates.length },
            ),
            factPremises: fc.uniqueArray(
              fc.integer({ min: 0, max: totalFacts - 1 }),
              { maxLength: 2 },
            ),
            derivedFacts: fc.uniqueArray(
              fc.integer({ min: 0, max: totalFacts - 1 }),
              { minLength: 1, maxLength: 2 },
            ),
            deleted: fc.integer({ min: 0, max: 9 }).map((roll) => roll === 0),
          }),
          { minLength: 1, maxLength: 7 },
        ),
        futureFacts: fc.uniqueArray(
          fc.integer({ min: 0, max: totalFacts - 1 }),
          { maxLength: 1 },
        ),
      });
    });
}

const FUTURE_VALID_FROM = "2999-01-01T00:00:00.000Z";
const EXPIRED_VALIDITY = {
  validFrom: "2000-01-01T00:00:00.000Z",
  validTo: "2001-01-01T00:00:00.000Z",
} as const;

type ClosureCapability = ReturnType<
  typeof createRetractionCapability<typeof closureGraph, typeof closureConfig>
>;

async function seedClosureWorld(world: ClosureWorld): Promise<
  Readonly<{
    store: ClosureStore;
    provenance: ClosureCapability;
    facts: readonly FactReference[];
  }>
> {
  const [store] = await createStoreWithSchema(
    closureGraph,
    createTestBackend(),
    {
      history: true,
    },
  );
  const facts = closureFactReferences(world);
  const futureFacts = new Set(world.futureFacts);

  await store.nodes.Dossier.create({}, { id: "dossier-0" });
  for (const [index, fact] of facts.entries()) {
    const validity =
      futureFacts.has(index) ? { validFrom: FUTURE_VALID_FROM } : {};
    switch (fact.kind) {
      case "Fact": {
        await store.nodes.Fact.create(
          { code: fact.id },
          { id: fact.id, ...validity },
        );
        break;
      }
      case "Section": {
        const wholeIndex = requireDefined(
          world.sectionWholes[index - world.factCount],
        );
        await store.nodes.Section.create(
          {},
          {
            id: fact.id,
            ...validity,
            partOf: { whole: { kind: "Fact", id: `fact-${wholeIndex}` } },
          },
        );
        break;
      }
      case "Exhibit": {
        await store.nodes.Exhibit.create(
          {},
          {
            id: fact.id,
            ...validity,
            partOf: { whole: { kind: "Dossier", id: "dossier-0" } },
          },
        );
        break;
      }
      case "Paragraph": {
        const wholeIndex = requireDefined(
          world.paragraphWholes[
            index -
              world.factCount -
              world.sectionWholes.length -
              world.exhibitCount
          ],
        );
        await store.nodes.Paragraph.create(
          {},
          {
            id: fact.id,
            ...validity,
            partOf: { whole: { kind: "Section", id: `section-${wholeIndex}` } },
          },
        );
        break;
      }
    }
  }
  const sources = [];
  for (const [index, state] of world.sourceStates.entries()) {
    sources.push(
      await store.nodes.Source.create(
        { label: `source-${index}`, retracted: false },
        {
          id: `source-${index}`,
          ...(state === "expired" ? EXPIRED_VALIDITY : {}),
        },
      ),
    );
  }
  const justificationNodes = [];
  for (const [index, justification] of world.justifications.entries()) {
    const justificationRef = {
      kind: "Justification",
      id: `justification-${index}`,
    } as const;
    justificationNodes.push(
      await store.nodes.Justification.create(
        { label: justificationRef.id },
        { id: justificationRef.id },
      ),
    );
    for (const sourceIndex of justification.sourcePremises) {
      await store.edges.premiseOf.create(
        sourceRef(sourceIndex),
        justificationRef,
        {},
        { id: `premise-s-${index}-${sourceIndex}` },
      );
    }
    for (const factIndex of justification.factPremises) {
      await store.edges.premiseOf.create(
        requireDefined(facts[factIndex]),
        justificationRef,
        {},
        { id: `premise-f-${index}-${factIndex}` },
      );
    }
    for (const factIndex of justification.derivedFacts) {
      await store.edges.derives.create(
        justificationRef,
        requireDefined(facts[factIndex]),
        {},
        { id: `derives-${index}-${factIndex}` },
      );
    }
  }

  const provenance = createRetractionCapability(store, closureConfig);
  for (const [index, state] of world.sourceStates.entries()) {
    const source = requireDefined(sources[index]);
    if (state === "retracted" || state === "restored") {
      await provenance.retract(sourceRef(index));
    }
    if (state === "flagged") {
      await store.nodes.Source.update(source.id, { retracted: true });
    }
    if (state === "restored") {
      await store.nodes.Source.update(source.id, { retracted: false });
    }
    if (state === "deleted") await store.nodes.Source.delete(source.id);
  }
  for (const [index, justification] of world.justifications.entries()) {
    if (justification.deleted) {
      await store.nodes.Justification.delete(
        requireDefined(justificationNodes[index]).id,
      );
    }
  }
  return { store, provenance, facts };
}

/** The whole-graph verdict every closure-loaded answer must agree with. */
async function loadWholeVerdict(store: ClosureStore) {
  const scope = createCapabilityScope(store, closureConfig);
  const graph = await loadSupportGraph(
    storeBackend(store),
    scope.registry,
    scope.graphId,
    scope.config,
    scope.batchPointRead,
  );
  const snapshot = computeSupportSnapshot(
    graph,
    availableSourceKeys(graph.sourceRows, scope.config.retractedField),
  );
  return { scope, graph, snapshot };
}

type WholeVerdict = Awaited<ReturnType<typeof loadWholeVerdict>>;

function expectedVia(
  verdict: WholeVerdict,
  fact: FactReference,
): readonly Readonly<{ kind: string; id: string }>[] {
  return (
    verdict.snapshot.firingJustificationKeysByFact.get(refKey(fact)) ?? []
  )
    .map((key) => keyToRef(key))
    .toSorted(compareReferences);
}

function expectedReason(verdict: WholeVerdict, fact: FactReference): string {
  const key = refKey(fact);
  const { snapshot, graph } = verdict;
  if (!snapshot.facts.has(key)) return "not-current";
  if (snapshot.supportedFactKeys.has(key)) return "tombstoned";
  const derivedBy = [...graph.supportEdges.factsByJustification].filter(
    ([justificationKey, derived]) =>
      graph.roles.justifications.has(justificationKey) && derived.includes(key),
  );
  if (derivedBy.length === 0) return "no-justification";
  if (!snapshot.firingJustificationKeysByFact.has(key)) {
    return "no-firing-justification";
  }
  return "composition-whole-unsupported";
}

function compareReferences(
  left: Readonly<{ kind: string; id: string }>,
  right: Readonly<{ kind: string; id: string }>,
): number {
  return (
    left.kind.localeCompare(right.kind, "en") ||
    (left.id < right.id ? -1
    : left.id > right.id ? 1
    : 0)
  );
}

function plainRef(fact: FactReference): Readonly<{ kind: string; id: string }> {
  return { kind: fact.kind, id: fact.id };
}

/** What a call returned or was refused with, as comparable plain data. */
function summarizeOutcome(
  outcome: Awaited<ReturnType<typeof captureAssertHolds>>,
) {
  return "held" in outcome ?
      { held: outcome.held }
    : {
        refused: outcome.refused.failures.map((failure) => ({
          fact: failure.fact,
          reason: failure.reason,
        })),
      };
}

async function captureAssertHolds(
  store: ClosureStore,
  provenance: ClosureCapability,
  facts: readonly FactReference[],
) {
  try {
    const held = await store.transaction((tx) =>
      provenance.assertHolds(tx, facts),
    );
    return { held } as const;
  } catch (error) {
    if (error instanceof FactNotHoldingError)
      return { refused: error } as const;
    throw error;
  }
}

/**
 * The closure law for one seeded world: every named fact (each of the world's
 * facts plus kinds' never-written ids), judged alone and all together, gets
 * the whole-graph snapshot's verdict, reason and `via`; and the closure
 * loader's own snapshot agrees with the whole one on every fact it loaded.
 */
async function expectClosureAgreesWithWholeGraph(
  seeded: Awaited<ReturnType<typeof seedClosureWorld>>,
): Promise<void> {
  const { store, provenance, facts } = seeded;
  const verdict = await loadWholeVerdict(store);
  const absent: readonly FactReference[] = [
    { kind: "Fact", id: "fact-never-written" },
    { kind: "Section", id: "section-never-written" },
    { kind: "Exhibit", id: "exhibit-never-written" },
    { kind: "Paragraph", id: "paragraph-never-written" },
  ];
  const named = [...facts, ...absent];
  const believes = (fact: FactReference) =>
    verdict.snapshot.believedFactKeys.has(refKey(fact));

  for (const fact of named) {
    const outcome = await captureAssertHolds(store, provenance, [fact]);
    expect({ fact: refKey(fact), outcome: summarizeOutcome(outcome) }).toEqual({
      fact: refKey(fact),
      outcome:
        believes(fact) ?
          { held: [{ fact: plainRef(fact), via: expectedVia(verdict, fact) }] }
        : {
            refused: [
              { fact: plainRef(fact), reason: expectedReason(verdict, fact) },
            ],
          },
    });
  }

  const failing = named
    .filter((fact) => !believes(fact))
    .toSorted((left, right) => compareReferences(left, right));
  const together = await captureAssertHolds(store, provenance, named);
  expect(summarizeOutcome(together)).toEqual(
    failing.length === 0 ?
      {
        held: named.map((fact) => ({
          fact: plainRef(fact),
          via: expectedVia(verdict, fact),
        })),
      }
    : {
        refused: failing.map((fact) => ({
          fact: plainRef(fact),
          reason: expectedReason(verdict, fact),
        })),
      },
  );

  for (const fact of facts) {
    const closure = await loadSupportClosure(
      storeBackend(store),
      verdict.scope.registry,
      verdict.scope.graphId,
      verdict.scope.config,
      [fact],
      verdict.scope,
    );
    const closureSnapshot = computeSupportSnapshot(
      closure,
      availableSourceKeys(
        closure.sourceRows,
        verdict.scope.config.retractedField,
      ),
    );
    for (const key of closure.roles.facts.keys()) {
      const factVerdict = (snapshot: SupportSnapshot) => ({
        fact: key,
        supported: snapshot.supportedFactKeys.has(key),
        believed: snapshot.believedFactKeys.has(key),
        firing: snapshot.firingJustificationKeysByFact.get(key)?.toSorted(),
      });
      expect(factVerdict(closureSnapshot)).toEqual(
        factVerdict(verdict.snapshot),
      );
    }
  }
}

/**
 * A deterministic fact-premise chain: `source-0 → j0 → fact-0 → j1 → fact-1 →
 * …`, the last fact named. The upstream source is live, flagged, retracted
 * through the capability, or restored after that (supported, facts closed); a bypass justification fed by the always-live
 * `source-1` may support one mid-chain fact. Every chain has at least one
 * justification whose premise is a fact, so a loader that does not follow fact
 * premises cannot produce the whole-graph verdict for it.
 */
type ChainWorld = Readonly<{
  world: ClosureWorld;
  depth: number;
  upstream: "live" | "flagged" | "retracted" | "restored";
  bypassAt: number | undefined;
}>;

function chainJustification(index: number) {
  return { kind: "Justification", id: `justification-${index}` };
}

/**
 * The outcome naming the last fact of `chain` must have, worked out from the
 * chain's shape alone and never from a support computation.
 */
function expectedChainOutcome(chain: ChainWorld, last: FactReference) {
  const premiseSupported =
    chain.upstream === "live" ||
    chain.upstream === "restored" ||
    (chain.bypassAt !== undefined && chain.bypassAt <= chain.depth - 2);
  const via = [
    ...(premiseSupported ? [chainJustification(chain.depth - 1)] : []),
    ...(chain.bypassAt === chain.depth - 1 ?
      [chainJustification(chain.depth)]
    : []),
  ];
  if (via.length === 0) {
    return { refused: [{ fact: last, reason: "no-firing-justification" }] };
  }
  if (chain.upstream === "restored" && chain.bypassAt === undefined) {
    return { refused: [{ fact: last, reason: "tombstoned" }] };
  }
  return { held: [{ fact: last, via }] };
}

/** A section whose whole fact is derived from `upstream`; the section's own justification has no premise. */
function partOfFactWorld(upstream: SourceState): ClosureWorld {
  return {
    sourceStates: [upstream],
    factCount: 1,
    sectionWholes: [0],
    exhibitCount: 0,
    paragraphWholes: [],
    justifications: [
      {
        sourcePremises: [0],
        factPremises: [],
        derivedFacts: [0],
        deleted: false,
      },
      {
        sourcePremises: [],
        factPremises: [],
        derivedFacts: [1],
        deleted: false,
      },
    ],
    futureFacts: [],
  };
}

const chainWorldArb: fc.Arbitrary<ChainWorld> = fc
  .record({
    depth: fc.integer({ min: 2, max: 4 }),
    upstream: fc.constantFrom(
      "live",
      "flagged",
      "retracted",
      "restored" as const,
    ),
    bypass: fc.option(fc.nat(), { nil: undefined }),
  })
  .map(({ depth, upstream, bypass }) => {
    const bypassAt =
      bypass === undefined ? undefined : 1 + (bypass % (depth - 1));
    const links: ClosureJustificationSpec[] = Array.from(
      { length: depth },
      (_, index) => ({
        sourcePremises: index === 0 ? [0] : [],
        factPremises: index === 0 ? [] : [index - 1],
        derivedFacts: [index],
        deleted: false,
      }),
    );
    const bypassLink: readonly ClosureJustificationSpec[] =
      bypassAt === undefined ?
        []
      : [
          {
            sourcePremises: [1],
            factPremises: [],
            derivedFacts: [bypassAt],
            deleted: false,
          },
        ];
    return {
      depth,
      upstream,
      bypassAt,
      world: {
        sourceStates: [upstream, "live"],
        factCount: depth,
        sectionWholes: [],
        exhibitCount: 0,
        paragraphWholes: [],
        justifications: [...links, ...bypassLink],
        futureFacts: [],
      },
    };
  });

describe("provenance closure law", () => {
  it("the closure arbitrary produces three-tier compositions and validity-expired sources", () => {
    const worlds = fc.sample(closureWorldArb(), { numRuns: 300, seed: 11 });
    expect(worlds.some((world) => world.paragraphWholes.length > 0)).toBe(true);
    expect(worlds.some((world) => world.sourceStates.includes("expired"))).toBe(
      true,
    );
  });

  it("assertHolds over a fact's closure agrees with the whole-graph snapshot", async () => {
    await fc.assert(
      fc.asyncProperty(closureWorldArb(), async (world) => {
        await expectClosureAgreesWithWholeGraph(await seedClosureWorld(world));
      }),
      { numRuns: 40 },
    );
  }, 120_000);

  it("a fact-premise chain is judged through every link, whatever stands upstream", async () => {
    await fc.assert(
      fc.asyncProperty(chainWorldArb, async (chain) => {
        const seeded = await seedClosureWorld(chain.world);
        const last = requireDefined(seeded.facts.at(-1));
        const outcome = await captureAssertHolds(
          seeded.store,
          seeded.provenance,
          [last],
        );
        expect(summarizeOutcome(outcome)).toEqual(
          expectedChainOutcome(chain, last),
        );
        await expectClosureAgreesWithWholeGraph(seeded);
      }),
      { numRuns: 30 },
    );
  }, 120_000);

  it("a required part holds only while its fact whole is supported and its own row is live", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<SourceState>(
          "live",
          "flagged",
          "retracted",
          "restored",
        ),
        async (upstream) => {
          const seeded = await seedClosureWorld(partOfFactWorld(upstream));
          const section = { kind: "Section", id: "section-0" } as const;
          const outcome = await captureAssertHolds(
            seeded.store,
            seeded.provenance,
            [section],
          );
          expect(summarizeOutcome(outcome)).toEqual(
            upstream === "live" ?
              {
                held: [
                  {
                    fact: section,
                    via: [{ kind: "Justification", id: "justification-1" }],
                  },
                ],
              }
            : {
                refused: [
                  {
                    fact: section,
                    reason:
                      upstream === "restored" ? "tombstoned" : (
                        "composition-whole-unsupported"
                      ),
                  },
                ],
              },
          );
          await expectClosureAgreesWithWholeGraph(seeded);
        },
      ),
      { numRuns: 6 },
    );
  }, 120_000);

  it("the chain arbitrary produces every shape the law above depends on", () => {
    const shapes = fc.sample(chainWorldArb, { numRuns: 200, seed: 7 });
    const has = (matches: (chain: ChainWorld) => boolean) =>
      shapes.some((chain) => matches(chain));
    expect(has((chain) => chain.upstream === "live")).toBe(true);
    expect(
      has(
        (chain) =>
          chain.upstream === "retracted" && chain.bypassAt === undefined,
      ),
    ).toBe(true);
    expect(
      has(
        (chain) => chain.upstream === "flagged" && chain.bypassAt !== undefined,
      ),
    ).toBe(true);
    expect(
      has(
        (chain) =>
          chain.upstream === "restored" && chain.bypassAt === undefined,
      ),
    ).toBe(true);
    expect(has((chain) => chain.depth >= 4)).toBe(true);
  });
});
