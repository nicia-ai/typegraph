import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
  type Node,
} from "../../src";
import { createRetractionCapability } from "../../src/provenance";
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

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "property_provenance_retraction",
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
  },
});

const config = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type ProvenanceStore = HistoryStore<typeof graph>;
type SourceRef = Node<typeof Source>;
type FactSpec = Readonly<{ sourceIndexes: readonly number[] }>;
type Scenario = Readonly<{
  sourceCount: number;
  facts: readonly FactSpec[];
  retractedIndexes: readonly number[];
}>;

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: 4 })
  .chain((sourceCount) =>
    fc.record({
      sourceCount: fc.constant(sourceCount),
      facts: fc.array(
        fc.record({
          sourceIndexes: fc.uniqueArray(
            fc.integer({ min: 0, max: sourceCount - 1 }),
            { minLength: 1, maxLength: sourceCount },
          ),
        }),
        { minLength: 1, maxLength: 6 },
      ),
      retractedIndexes: fc.uniqueArray(
        fc.integer({ min: 0, max: sourceCount - 1 }),
        { maxLength: sourceCount },
      ),
    }),
  );

function sortedIds(references: readonly Readonly<{ id: string }>[]): string[] {
  return references.map((reference) => reference.id).toSorted();
}

function isSupportedAfterRetraction(
  fact: FactSpec,
  retracted: ReadonlySet<number>,
): boolean {
  return fact.sourceIndexes.some((sourceIndex) => !retracted.has(sourceIndex));
}

async function createSources(
  store: ProvenanceStore,
  count: number,
): Promise<SourceRef[]> {
  const sources: SourceRef[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `source-${index}`;
    sources.push(
      await store.nodes.Source.create({ label: id, retracted: false }, { id }),
    );
  }
  return sources;
}

async function createSupportedFact(
  store: ProvenanceStore,
  sources: readonly SourceRef[],
  factIndex: number,
  fact: FactSpec,
): Promise<void> {
  const factNode = await store.nodes.Fact.create(
    { code: `fact-code-${factIndex}` },
    { id: `fact-${factIndex}` },
  );
  for (const sourceIndex of fact.sourceIndexes) {
    const source = sources[sourceIndex]!;
    const justification = await store.nodes.Justification.create(
      { label: `justification-${factIndex}-${sourceIndex}` },
      { id: `justification-${factIndex}-${sourceIndex}` },
    );
    await store.edges.premiseOf.create(
      source,
      justification,
      {},
      {
        id: `premise-${factIndex}-${sourceIndex}`,
      },
    );
    await store.edges.derives.create(
      justification,
      factNode,
      {},
      {
        id: `derives-${factIndex}-${sourceIndex}`,
      },
    );
  }
}

describe("provenance retraction property tests", () => {
  it("releases unique keys exactly for facts that lose all support", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const [store] = await createStoreWithSchema(
          graph,
          createTestBackend(),
          { history: true },
        );
        const sources = await createSources(store, scenario.sourceCount);
        for (const [factIndex, fact] of scenario.facts.entries()) {
          await createSupportedFact(store, sources, factIndex, fact);
        }

        const retracted = new Set(scenario.retractedIndexes);
        const provenance = createRetractionCapability(store, config);
        await provenance.retractMany(
          scenario.retractedIndexes.map((sourceIndex) => sources[sourceIndex]!),
        );

        const expectedHeldIds = scenario.facts
          .flatMap((fact, factIndex) =>
            isSupportedAfterRetraction(fact, retracted) ?
              [`fact-${factIndex}`]
            : [],
          )
          .toSorted();
        expect(sortedIds(await provenance.holding())).toEqual(expectedHeldIds);

        const supportedFactIndexes = scenario.facts.flatMap(
          (fact, factIndex) =>
            isSupportedAfterRetraction(fact, retracted) ? [factIndex] : [],
        );
        const unsupportedFactIndexes = scenario.facts.flatMap(
          (fact, factIndex) =>
            isSupportedAfterRetraction(fact, retracted) ? [] : [factIndex],
        );

        for (const factIndex of supportedFactIndexes) {
          const createReplacement = store.nodes.Fact.create(
            { code: `fact-code-${factIndex}` },
            { id: `replacement-${factIndex}` },
          );
          await expect(createReplacement).rejects.toThrow(
            "Uniqueness violation",
          );
        }

        for (const factIndex of unsupportedFactIndexes) {
          const createReplacement = store.nodes.Fact.create(
            { code: `fact-code-${factIndex}` },
            { id: `replacement-${factIndex}` },
          );
          await expect(createReplacement).resolves.toMatchObject({
            id: `replacement-${factIndex}`,
          });
        }
      }),
      { numRuns: 20 },
    );
  }, 30_000);
});
