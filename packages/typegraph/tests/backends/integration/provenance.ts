import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
} from "../../../src";
import { createRetractionCapability } from "../../../src/provenance";
import type { IntegrationTestContext } from "./test-context";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Fact = defineNode("Fact", {
  schema: z.object({ label: z.string() }),
});

const Decision = defineNode("Decision", {
  schema: z.object({ label: z.string() }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const provenanceGraph = defineGraph({
  id: "provenance_retraction_integration",
  nodes: {
    Source: { type: Source },
    Fact: {
      type: Fact,
      unique: [
        {
          name: "fact_label",
          fields: ["label"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Decision: { type: Decision },
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
      to: [Fact, Decision],
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

type ProvenanceStore = Awaited<ReturnType<typeof createHistoryStore>>;
type SourceRef = Node<typeof Source>;
type FactRef = Node<typeof Fact>;
type DecisionRef = Node<typeof Decision>;
type JustificationRef = Node<typeof Justification>;
type PremiseRef = SourceRef | FactRef;

async function createHistoryStore(context: IntegrationTestContext) {
  const [store] = await createStoreWithSchema(
    provenanceGraph,
    context.getStore().backend,
    { history: true },
  );
  return store;
}

async function createSource(
  store: ProvenanceStore,
  id: string,
): Promise<SourceRef> {
  return store.nodes.Source.create({ label: id, retracted: false }, { id });
}

async function createFact(
  store: ProvenanceStore,
  id: string,
  label = id,
): Promise<FactRef> {
  return store.nodes.Fact.create({ label }, { id });
}

async function createDecision(
  store: ProvenanceStore,
  id: string,
): Promise<DecisionRef> {
  return store.nodes.Decision.create({ label: id }, { id });
}

async function createJustification(
  store: ProvenanceStore,
  id: string,
  premises: readonly PremiseRef[],
  fact: FactRef | DecisionRef,
): Promise<JustificationRef> {
  const justification = await store.nodes.Justification.create(
    { label: id },
    { id },
  );
  for (const premise of premises) {
    await store.edges.premiseOf.create(
      premise,
      justification,
      {},
      {
        id: `${premise.kind}-${premise.id}-${id}`,
      },
    );
  }
  await store.edges.derives.create(
    justification,
    fact,
    {},
    {
      id: `${id}-${fact.id}`,
    },
  );
  return justification;
}

function sortedIds(references: readonly Readonly<{ id: string }>[]): string[] {
  return references
    .map((reference) => reference.id)
    .toSorted((left, right) => left.localeCompare(right));
}

export function registerProvenanceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("provenance retraction", () => {
    it("retracts a linear derived fact and captures the transition", async () => {
      const store = await createHistoryStore(context);
      const source = await createSource(store, "source-a");
      const fact = await createFact(store, "fact-a");
      await createJustification(store, "justification-a", [source], fact);
      const provenance = createRetractionCapability(store, config);

      const before = await store.recordedNow();
      expect(before).toBeDefined();
      expect(sortedIds(await provenance.holding())).toEqual(["fact-a"]);

      const report = await provenance.retract(source);
      const after = await store.recordedNow();

      expect(report.died).toEqual([{ kind: "Fact", id: "fact-a" }]);
      expect(report.survivedVia).toEqual([]);
      expect(await store.nodes.Fact.getById(fact.id)).toBeUndefined();
      await expect(
        store.asOfRecorded(before!).nodes.Fact.getById(fact.id),
      ).resolves.toMatchObject({ id: "fact-a" });
      await expect(
        store.asOfRecorded(after!).nodes.Fact.getById(fact.id),
      ).resolves.toBeUndefined();
      await expect(
        store.edges.derives.find({ to: fact }),
      ).resolves.toHaveLength(1);
    });

    it("keeps a fact current when an alternate justification still fires", async () => {
      const store = await createHistoryStore(context);
      const sourceA = await createSource(store, "source-a");
      const sourceB = await createSource(store, "source-b");
      const fact = await createFact(store, "fact-a");
      await createJustification(store, "justification-a", [sourceA], fact);
      await createJustification(store, "justification-b", [sourceB], fact);
      const provenance = createRetractionCapability(store, config);

      const report = await provenance.retract(sourceA);

      expect(report.died).toEqual([]);
      expect(report.survivedVia).toEqual([
        {
          fact: { kind: "Fact", id: "fact-a" },
          via: [{ kind: "Justification", id: "justification-b" }],
        },
      ]);
      await expect(store.nodes.Fact.getById(fact.id)).resolves.toMatchObject({
        id: "fact-a",
      });
    });

    it("releases unique fact keys when unsupported facts become non-current", async () => {
      const store = await createHistoryStore(context);
      const source = await createSource(store, "source-a");
      const fact = await createFact(store, "fact-a");
      await createJustification(store, "justification-a", [source], fact);
      const provenance = createRetractionCapability(store, config);

      await provenance.retract(source);

      const replacement = await createFact(store, "fact-replacement", "fact-a");
      expect(replacement.id).not.toBe(fact.id);
      await expect(provenance.unRetract(source)).rejects.toThrow(
        "Uniqueness violation",
      );
      await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
    });

    it("keeps unsupported cycles out and admits grounded cycles", async () => {
      const store = await createHistoryStore(context);
      const source = await createSource(store, "source-a");
      const factA = await createFact(store, "fact-a");
      const factB = await createFact(store, "fact-b");
      await createJustification(store, "cycle-a", [factA], factB);
      await createJustification(store, "cycle-b", [factB], factA);
      const provenance = createRetractionCapability(store, config);

      expect(await provenance.holding()).toEqual([]);

      await createJustification(store, "ground-a", [source], factA);

      expect(sortedIds(await provenance.holding())).toEqual([
        "fact-a",
        "fact-b",
      ]);
      await provenance.retract(source);
      expect(await provenance.holding()).toEqual([]);
    });

    it("reopens facts when a source is un-retracted", async () => {
      const store = await createHistoryStore(context);
      const source = await createSource(store, "source-a");
      const fact = await createFact(store, "fact-a");
      await createJustification(store, "justification-a", [source], fact);
      const provenance = createRetractionCapability(store, config);

      await provenance.retract(source);
      await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();

      const report = await provenance.unRetract(source);

      expect(report.survivedVia).toEqual([
        {
          fact: { kind: "Fact", id: "fact-a" },
          via: [{ kind: "Justification", id: "justification-a" }],
        },
      ]);
      await expect(store.nodes.Fact.getById(fact.id)).resolves.toMatchObject({
        id: "fact-a",
      });
    });

    it("supports terminal fact kinds and bulk source retraction", async () => {
      const store = await createHistoryStore(context);
      const sourceA = await createSource(store, "source-a");
      const sourceB = await createSource(store, "source-b");
      const fact = await createFact(store, "fact-a");
      const decision = await createDecision(store, "decision-a");
      await createJustification(store, "justification-a", [sourceA], fact);
      await createJustification(store, "justification-b", [sourceB], fact);
      await createJustification(
        store,
        "decision-justification",
        [fact],
        decision,
      );
      const provenance = createRetractionCapability(store, {
        ...config,
        fact: { kinds: ["Fact", "Decision"] },
      });

      const sourceAReport = await provenance.retract(sourceA);

      expect(sourceAReport.died).toEqual([]);
      expect(
        sortedIds(sourceAReport.survivedVia.map((entry) => entry.fact)),
      ).toEqual(["decision-a", "fact-a"]);
      await expect(
        store.nodes.Decision.getById(decision.id),
      ).resolves.toMatchObject({ id: "decision-a" });

      const sourceBReport = await provenance.retractMany([sourceB]);

      expect(sortedIds(sourceBReport.died)).toEqual(["decision-a", "fact-a"]);
      expect(sourceBReport.survivedVia).toEqual([]);
      await expect(
        store.nodes.Decision.getById(decision.id),
      ).resolves.toBeUndefined();
    });
  });
}
