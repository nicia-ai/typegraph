import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode, type Node } from "../../../src";
import { createRetractionCapability } from "../../../src/provenance";
import { requireDefined } from "../../../src/utils/presence";
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

// A fact kind folded into identity with a non-fact kind by shared id, and a
// second fact asserted `same` with it: a belief close must take the fact out
// of both classes exactly as a delete would, and a reopen must fold it back.
const Mirror = defineNode("Mirror", {
  schema: z.object({ label: z.string() }),
});

const identityProvenanceGraph = defineGraph({
  id: "provenance_retraction_identity_integration",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Mirror: { type: Mirror },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
  identity: { sameIdAcrossKinds: "fold" },
});

type ProvenanceStore = Awaited<ReturnType<typeof createHistoryStore>>;
type SourceRef = Node<typeof Source>;
type FactRef = Node<typeof Fact>;
type DecisionRef = Node<typeof Decision>;
type JustificationRef = Node<typeof Justification>;
type PremiseRef = SourceRef | FactRef;

async function createHistoryStore(context: IntegrationTestContext) {
  return context.createHistoryStore(provenanceGraph);
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
        store.asOfRecorded(requireDefined(before)).nodes.Fact.getById(fact.id),
      ).resolves.toMatchObject({ id: "fact-a" });
      await expect(
        store.asOfRecorded(requireDefined(after)).nodes.Fact.getById(fact.id),
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

    // Load-bearing: a belief close/reopen runs through the transaction's own
    // node delete/revive owners, which carry the identity detach and restore
    // fold. Revert check: close with `applyNodeSoftDelete` and reopen with
    // `applyNodeResurrect` directly (the pipeline steps without the identity
    // hooks) and the closed fact stays in `Mirror:shared`'s class, with no
    // `detach` or `restore` transition noted.
    it("detaches a closed fact from its identity class and restores it on reopen", async () => {
      const store = await context.createHistoryStore(identityProvenanceGraph);
      const source = await store.nodes.Source.create(
        { label: "source-a", retracted: false },
        { id: "source-a" },
      );
      const peerSource = await store.nodes.Source.create(
        { label: "source-b", retracted: false },
        { id: "source-b" },
      );
      const fact = await store.nodes.Fact.create(
        { label: "shared" },
        { id: "shared" },
      );
      const peer = await store.nodes.Fact.create(
        { label: "peer" },
        { id: "peer" },
      );
      const mirror = await store.nodes.Mirror.create(
        { label: "shared" },
        { id: "shared" },
      );
      for (const [premise, derived] of [
        [source, fact],
        [peerSource, peer],
      ] as const) {
        const justification = await store.nodes.Justification.create(
          { label: derived.id },
          { id: `justification-${derived.id}` },
        );
        await store.edges.premiseOf.create(premise, justification);
        await store.edges.derives.create(justification, derived);
      }
      await store.identity.assertSame(fact, peer);
      const mirrorRef = { kind: "Mirror", id: mirror.id } as const;
      const causes = async () => {
        const history = await store.identity.transitionsOf(mirrorRef);
        return history.transitions.map((transition) => transition.cause);
      };
      expect(sortedIds(await store.identity.membersOf(mirrorRef))).toEqual([
        "peer",
        "shared",
        "shared",
      ]);
      expect(await causes()).not.toContain("detach");

      const provenance = createRetractionCapability(store, config);
      const report = await provenance.retract(source);

      expect(report.died).toEqual([{ kind: "Fact", id: "shared" }]);
      expect(await store.identity.membersOf(mirrorRef)).toEqual([mirrorRef]);
      await expect(store.identity.areSame(fact, peer)).resolves.toBe(false);
      expect(await causes()).toContain("detach");
      expect(await causes()).not.toContain("restore");

      await provenance.unRetract(source);

      await expect(store.identity.areSame(fact, mirror)).resolves.toBe(true);
      expect(await causes()).toContain("restore");
    });
  });
}
