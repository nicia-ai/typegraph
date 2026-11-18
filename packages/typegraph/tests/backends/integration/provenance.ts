import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
  partOf,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import type {
  AdapterBackend,
  GraphBackend,
  TransactionBackend,
} from "../../../src/backend/types";
import { UnsupportedBackendCapabilityError } from "../../../src/errors-entry";
import {
  createRetractionCapability,
  FactNotHoldingError,
} from "../../../src/provenance";
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

const Report = defineNode("Report", {
  schema: z.object({ label: z.string() }),
});

const Section = defineNode("Section", {
  schema: z.object({ label: z.string() }),
});

const sectionOf = defineEdge("sectionOf");

const compositionGraph = defineGraph({
  id: "provenance_assert_holds_composition_integration",
  nodes: {
    Source: { type: Source },
    Report: { type: Report },
    Section: { type: Section },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, Report, Section],
      to: [Justification],
    },
    derives: { type: derives, from: [Justification], to: [Report, Section] },
    sectionOf: {
      type: sectionOf,
      from: [Section],
      to: [Report],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Section, Report, {
      via: sectionOf,
      existence: "required",
    }),
  ],
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

async function captureRejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** `retracted-source` is retracted; `live-source` and `live-fact` hold. */
async function seedStore(context: IntegrationTestContext) {
  const store = await createHistoryStore(context);
  const retractedSource = await createSource(store, "retracted-source");
  const liveSource = await createSource(store, "live-source");
  const dying = await createFact(store, "dying-fact");
  const live = await createFact(store, "live-fact");
  await createJustification(store, "dying-j", [retractedSource], dying);
  await createJustification(store, "live-j", [liveSource], live);
  const provenance = createRetractionCapability(store, config);
  await provenance.retract(retractedSource);
  return { store, provenance };
}

async function captureNotHolding(
  work: Promise<unknown>,
): Promise<FactNotHoldingError> {
  const error = await captureRejection(work);
  expect(error).toBeInstanceOf(FactNotHoldingError);
  return error as FactNotHoldingError;
}

interface EndpointFilteredReadCount { value: number }

function isEndpointFiltered(
  params: Parameters<GraphBackend["findEdgesByKind"]>[0],
): boolean {
  return params.fromId !== undefined || params.toId !== undefined;
}

/**
 * The same backend with the set-oriented endpoint read projected away from the
 * root and from every transaction target, so the capability's closure read
 * can only take its per-endpoint fallback. Endpoint-filtered `findEdgesByKind`
 * reads are counted, so a test can see the fallback ran.
 */
function withoutEndpointSetRead(
  backend: AdapterBackend<unknown>,
  endpointFilteredReads: EndpointFilteredReadCount,
): GraphBackend {
  const counted = (target: GraphBackend | TransactionBackend) => ({
    findEdgesByKind(params: Parameters<GraphBackend["findEdgesByKind"]>[0]) {
      if (isEndpointFiltered(params)) endpointFilteredReads.value += 1;
      return target.findEdgesByKind(params);
    },
  });
  const projected: GraphBackend = projectBackendWithout(backend, [
    "findEdgesByEndpointSet",
  ]);
  return deriveBackend(projected, {
    ...counted(projected),
    transaction<T>(
      fn: (target: TransactionBackend) => Promise<T>,
      options?: Parameters<GraphBackend["transaction"]>[1],
    ): Promise<T> {
      return backend.transaction(
        (target) =>
          fn(
            deriveBackend(
              projectBackendWithout(target, ["findEdgesByEndpointSet"]),
              counted(target),
            ),
          ),
        options,
      );
    },
  });
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

  describe("provenance assertHolds", () => {
    type AssertTransaction = Parameters<
      Parameters<ProvenanceStore["transaction"]>[0]
    >[0];
    type FactReference = Readonly<{ kind: "Fact"; id: string }>;

    const fact = (id: string): FactReference => ({ kind: "Fact", id });

    async function deriveInTransaction(
      tx: AssertTransaction,
      premises: readonly Readonly<{ kind: "Source" | "Fact"; id: string }>[],
      justificationId: string,
      factId: string,
    ): Promise<void> {
      await tx.nodes.Justification.create(
        { label: justificationId },
        { id: justificationId },
      );
      if (!(await tx.nodes.Fact.getById(asNodeId<typeof Fact>(factId)))) {
        await tx.nodes.Fact.create({ label: factId }, { id: factId });
      }
      for (const premise of premises) {
        await tx.edges.premiseOf.create(
          premise,
          { kind: "Justification", id: justificationId },
          {},
        );
      }
      await tx.edges.derives.create(
        { kind: "Justification", id: justificationId },
        fact(factId),
        {},
      );
    }

    async function nodeAndEdgeCounts(store: ProvenanceStore) {
      const [facts, justifications, premises, derivations] = await Promise.all([
        store.nodes.Fact.find({}),
        store.nodes.Justification.find({}),
        store.edges.premiseOf.find({}),
        store.edges.derives.find({}),
      ]);
      return {
        facts: facts.length,
        justifications: justifications.length,
        premises: premises.length,
        derivations: derivations.length,
      };
    }

    it("refuses a fact derived from a retracted source and leaves no rows", async () => {
      const { store, provenance } = await seedStore(context);
      const before = await nodeAndEdgeCounts(store);

      const refusal = await captureNotHolding(
        store.transaction(async (tx) => {
          await deriveInTransaction(
            tx,
            [{ kind: "Source", id: "retracted-source" }],
            "sum-j",
            "sum",
          );
          await provenance.assertHolds(tx, [fact("sum")]);
        }),
      );

      expect(refusal.code).toBe("FACT_NOT_HOLDING");
      expect(refusal.failures).toEqual([
        {
          fact: fact("sum"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "sum-j" },
              premises: [
                {
                  premise: { kind: "Source", id: "retracted-source" },
                  reason: "retracted",
                },
              ],
            },
          ],
        },
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("sum")),
      ).resolves.toBeUndefined();
      await expect(
        store.nodes.Justification.getById(
          asNodeId<typeof Justification>("sum-j"),
        ),
      ).resolves.toBeUndefined();
      await expect(nodeAndEdgeCounts(store)).resolves.toEqual(before);
    });

    it("refuses a fact derived from a live but unsupported fact with premise reason unsupported", async () => {
      const { store, provenance } = await seedStore(context);
      await store.transaction(async (tx) => {
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "retracted-source" }],
          "sum-j",
          "sum",
        );
      });
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("sum")),
      ).resolves.toBeDefined();
      expect(await provenance.holding()).toEqual([fact("live-fact")]);

      const refusal = await captureNotHolding(
        store.transaction(async (tx) => {
          await deriveInTransaction(tx, [fact("sum")], "chain-j", "chain");
          await provenance.assertHolds(tx, [fact("chain")]);
        }),
      );

      expect(refusal.failures).toEqual([
        {
          fact: fact("chain"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "chain-j" },
              premises: [{ premise: fact("sum"), reason: "unsupported" }],
            },
          ],
        },
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("chain")),
      ).resolves.toBeUndefined();
    });

    it("passes a fact with an alternate firing justification and names only the firing one in via", async () => {
      const { store, provenance } = await seedStore(context);

      const held = await store.transaction(async (tx) => {
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "retracted-source" }],
          "dead-j",
          "summary",
        );
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "live-source" }],
          "firing-j",
          "summary",
        );
        return provenance.assertHolds(tx, [fact("summary")]);
      });

      expect(held).toEqual([
        {
          fact: fact("summary"),
          via: [{ kind: "Justification", id: "firing-j" }],
        },
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("summary")),
      ).resolves.toBeDefined();
    });

    it("passes a fact derived by a premise-less justification with that justification in via", async () => {
      const { store, provenance } = await seedStore(context);

      const held = await store.transaction(async (tx) => {
        await deriveInTransaction(tx, [], "axiom-j", "axiom");
        return provenance.assertHolds(tx, [fact("axiom")]);
      });

      expect(held).toEqual([
        {
          fact: fact("axiom"),
          via: [{ kind: "Justification", id: "axiom-j" }],
        },
      ]);
    });

    it("refuses a required part with no supported whole as composition-whole-unsupported", async () => {
      const store = await context.createHistoryStore(compositionGraph);
      const provenance = createRetractionCapability(store, {
        ...config,
        fact: { kinds: ["Report", "Section"] },
      });
      await store.nodes.Source.create(
        { label: "live", retracted: false },
        { id: "live-source" },
      );

      const refusal = await captureNotHolding(
        store.transaction(async (tx) => {
          await tx.nodes.Report.create({ label: "report" }, { id: "report" });
          await tx.nodes.Section.create(
            { label: "section" },
            {
              id: "section",
              partOf: { whole: { kind: "Report", id: "report" } },
            },
          );
          await tx.nodes.Justification.create(
            { label: "section-j" },
            { id: "section-j" },
          );
          await tx.edges.premiseOf.create(
            { kind: "Source", id: "live-source" },
            { kind: "Justification", id: "section-j" },
            {},
          );
          await tx.edges.derives.create(
            { kind: "Justification", id: "section-j" },
            { kind: "Section", id: "section" },
            {},
          );
          await provenance.assertHolds(tx, [
            { kind: "Section", id: "section" },
          ]);
        }),
      );

      expect(refusal.failures).toEqual([
        {
          fact: { kind: "Section", id: "section" },
          reason: "composition-whole-unsupported",
          justifications: [],
        },
      ]);
      await expect(store.nodes.Section.find({})).resolves.toEqual([]);
      await expect(store.nodes.Report.find({})).resolves.toEqual([]);
    });

    it("refuses a fact absent from the snapshot as not-current, never written or outside its validity window", async () => {
      const { store, provenance } = await seedStore(context);
      await store.nodes.Fact.create(
        { label: "future" },
        { id: "future", validFrom: "2999-01-01T00:00:00.000Z" },
      );
      await createJustification(
        store,
        "future-j",
        [{ kind: "Source", id: "live-source" } as SourceRef],
        { kind: "Fact", id: "future" } as FactRef,
      );

      const refusal = await captureNotHolding(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [fact("never-written"), fact("future")]),
        ),
      );

      expect(refusal.failures).toEqual([
        { fact: fact("future"), reason: "not-current", justifications: [] },
        {
          fact: fact("never-written"),
          reason: "not-current",
          justifications: [],
        },
      ]);
    });

    it("refuses a supported but tombstoned fact as tombstoned", async () => {
      const { store, provenance } = await seedStore(context);
      // A raw delete tombstones the row and keeps its derivation edge, so the
      // fact stays supported; the collection delete would refuse over that edge.
      await store.backend.deleteNode({
        graphId: provenanceGraph.id,
        kind: "Fact",
        id: "live-fact",
      });
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("live-fact")),
      ).resolves.toBeUndefined();

      const refusal = await captureNotHolding(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [fact("live-fact")]),
        ),
      );

      expect(refusal.failures).toEqual([
        { fact: fact("live-fact"), reason: "tombstoned", justifications: [] },
      ]);
    });

    it("reports every failing fact in one error, sorted by id, and omits facts that hold", async () => {
      const { store, provenance } = await seedStore(context);

      const refusal = await captureNotHolding(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [
            fact("zeta-missing"),
            fact("live-fact"),
            fact("dying-fact"),
            fact("alpha-missing"),
          ]),
        ),
      );

      expect(refusal.failures.map((failure) => failure.fact.id)).toEqual([
        "alpha-missing",
        "dying-fact",
        "zeta-missing",
      ]);
      expect(refusal.failures).toEqual([
        {
          fact: fact("alpha-missing"),
          reason: "not-current",
          justifications: [],
        },
        {
          fact: fact("dying-fact"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "dying-j" },
              premises: [
                {
                  premise: { kind: "Source", id: "retracted-source" },
                  reason: "retracted",
                },
              ],
            },
          ],
        },
        {
          fact: fact("zeta-missing"),
          reason: "not-current",
          justifications: [],
        },
      ]);
      expect(refusal.details.failures).toBe(refusal.failures);
    });

    it("judges duplicate facts once and returns an empty result for an empty list", async () => {
      const { store, provenance } = await seedStore(context);

      const held = await store.transaction((tx) =>
        provenance.assertHolds(tx, [
          fact("live-fact"),
          { kind: "Fact", id: "live-fact" },
          fact("live-fact"),
        ]),
      );
      expect(held).toEqual([
        {
          fact: fact("live-fact"),
          via: [{ kind: "Justification", id: "live-j" }],
        },
      ]);

      const refusal = await captureNotHolding(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [fact("ghost"), fact("ghost")]),
        ),
      );
      expect(refusal.failures).toHaveLength(1);

      await expect(
        store.transaction((tx) => provenance.assertHolds(tx, [])),
      ).resolves.toEqual([]);
    });

    it("sees facts written earlier in the same transaction", async () => {
      const { store, provenance } = await seedStore(context);

      const held = await store.transaction(async (tx) => {
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "live-source" }],
          "mid-j",
          "mid",
        );
        await deriveInTransaction(tx, [fact("mid")], "top-j", "top");
        return provenance.assertHolds(tx, [fact("mid"), fact("top")]);
      });

      expect(held).toEqual([
        { fact: fact("mid"), via: [{ kind: "Justification", id: "mid-j" }] },
        { fact: fact("top"), via: [{ kind: "Justification", id: "top-j" }] },
      ]);
    });

    it("holding(tx) includes a held fact written earlier in the transaction and excludes an unsupported one", async () => {
      const { store, provenance } = await seedStore(context);

      const holding = await store.transaction(async (tx) => {
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "live-source" }],
          "held-j",
          "held",
        );
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "retracted-source" }],
          "unsupported-j",
          "unsupported",
        );
        return provenance.holding(tx);
      });

      expect(holding).toEqual([fact("held"), fact("live-fact")]);
    });

    it("acquires without deadlock when assertHolds runs before any write and again after a write", async () => {
      const { store, provenance } = await seedStore(context);

      const [before, after] = await store.transaction(async (tx) => {
        const first = await provenance.assertHolds(tx, [fact("live-fact")]);
        await deriveInTransaction(
          tx,
          [{ kind: "Source", id: "live-source" }],
          "late-j",
          "late",
        );
        const second = await provenance.assertHolds(tx, [fact("late")]);
        return [first, second] as const;
      });

      expect(before).toEqual([
        {
          fact: fact("live-fact"),
          via: [{ kind: "Justification", id: "live-j" }],
        },
      ]);
      expect(after).toEqual([
        { fact: fact("late"), via: [{ kind: "Justification", id: "late-j" }] },
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("late")),
      ).resolves.toBeDefined();
    });

    it("refuses a transaction from another store with ConfigurationError", async () => {
      const { provenance } = await seedStore(context);
      const otherStore = await createHistoryStore(context);

      const error = await captureRejection(
        otherStore.transaction((tx) =>
          provenance.assertHolds(tx, [fact("live-fact")]),
        ),
      );

      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toMatchObject({
        code: "PROVENANCE_TRANSACTION_NOT_OWNED",
        operation: "provenance.assertHolds()",
      });
    });

    it("refuses a fact of a non-fact kind with ConfigurationError", async () => {
      const { store, provenance } = await seedStore(context);

      const error = await captureRejection(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [
            // @ts-expect-error Source is not a configured fact kind
            { kind: "Source", id: "live-source" },
          ]),
        ),
      );

      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toMatchObject({
        expectedKinds: ["Fact"],
        actualKind: "Source",
      });
    });

    it("refuses a transaction kept past its callback, and holding(tx) on a transaction from another store", async () => {
      const { store, provenance } = await seedStore(context);
      const otherStore = await createHistoryStore(context);

      const retained = await store.transaction((tx) => Promise.resolve(tx));
      const pastCallback = await captureRejection(
        provenance.assertHolds(retained, [fact("live-fact")]),
      );
      expect(pastCallback).toBeInstanceOf(ConfigurationError);
      expect((pastCallback as ConfigurationError).details).toMatchObject({
        code: "PROVENANCE_TRANSACTION_NOT_OWNED",
        operation: "provenance.assertHolds()",
      });

      const foreign = await captureRejection(
        otherStore.transaction((tx) => provenance.holding(tx)),
      );
      expect(foreign).toBeInstanceOf(ConfigurationError);
      expect((foreign as ConfigurationError).details).toMatchObject({
        code: "PROVENANCE_TRANSACTION_NOT_OWNED",
        operation: "provenance.holding(tx)",
      });
    });

    it("refuses assertHolds in a read-only transaction, where holding(tx) still answers", async () => {
      const { store, provenance } = await seedStore(context);

      const outcome = await store.transaction(
        async (tx) => {
          const refusal = await captureRejection(
            provenance.assertHolds(tx, [fact("live-fact")]),
          );
          // The refusal issued no statement, so the transaction is still
          // usable for the read that does not need the write locks.
          return { refusal, holding: await provenance.holding(tx) };
        },
        { accessMode: "read_only" },
      );

      expect(outcome.refusal).toBeInstanceOf(UnsupportedBackendCapabilityError);
      expect(
        (outcome.refusal as UnsupportedBackendCapabilityError).details,
      ).toMatchObject({
        operation: "provenance.assertHolds()",
        capability: "write transaction access",
        accessMode: "read_only",
      });
      expect(
        (outcome.refusal as UnsupportedBackendCapabilityError).suggestion,
      ).toContain("provenance.holding(tx)");
      expect(outcome.holding).toEqual([fact("live-fact")]);
    });

    it("refuses a fact whose source premise is validity-expired or tombstoned as not-current", async () => {
      const { store, provenance } = await seedStore(context);
      await store.nodes.Source.create(
        { label: "expired", retracted: false },
        {
          id: "expired-source",
          validFrom: "2000-01-01T00:00:00.000Z",
          validTo: "2001-01-01T00:00:00.000Z",
        },
      );
      const expiredFact = await createFact(store, "expired-fact");
      await createJustification(
        store,
        "expired-j",
        [{ kind: "Source", id: "expired-source" } as SourceRef],
        expiredFact,
      );
      const tombstonedSource = await createSource(store, "tombstoned-source");
      const tombstonedFact = await createFact(store, "tombstoned-source-fact");
      await createJustification(
        store,
        "tombstoned-j",
        [tombstonedSource],
        tombstonedFact,
      );
      // A raw delete tombstones the source and keeps its premise edge, which
      // stays current; the collection delete would refuse over that edge.
      await store.backend.deleteNode({
        graphId: provenanceGraph.id,
        kind: "Source",
        id: "tombstoned-source",
      });
      await expect(
        store.edges.premiseOf.find({ from: tombstonedSource }),
      ).resolves.toHaveLength(1);

      const refusal = await captureNotHolding(
        store.transaction((tx) =>
          provenance.assertHolds(tx, [
            fact("tombstoned-source-fact"),
            fact("expired-fact"),
          ]),
        ),
      );

      expect(refusal.failures).toEqual([
        {
          fact: fact("expired-fact"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "expired-j" },
              premises: [
                {
                  premise: { kind: "Source", id: "expired-source" },
                  reason: "not-current",
                },
              ],
            },
          ],
        },
        {
          fact: fact("tombstoned-source-fact"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "tombstoned-j" },
              premises: [
                {
                  premise: { kind: "Source", id: "tombstoned-source" },
                  reason: "not-current",
                },
              ],
            },
          ],
        },
      ]);
    });

    it("judges the closure the same through the per-endpoint fallback as through the set read", async () => {
      const store = await context.createHistoryStore(compositionGraph);
      const sources = [
        ["live-source", false, {}],
        ["retracted-source", true, {}],
        [
          "expired-source",
          false,
          {
            validFrom: "2000-01-01T00:00:00.000Z",
            validTo: "2001-01-01T00:00:00.000Z",
          },
        ],
      ] as const;
      for (const [id, retracted, validity] of sources) {
        await store.nodes.Source.create(
          { label: id, retracted },
          { id, ...validity },
        );
      }
      const derive = async (
        justificationId: string,
        premises: readonly Readonly<{ kind: string; id: string }>[],
        derived: Readonly<{ kind: "Report" | "Section"; id: string }>,
      ) => {
        await store.nodes.Justification.create(
          { label: justificationId },
          { id: justificationId },
        );
        for (const premise of premises) {
          await store.edges.premiseOf.create(
            premise as never,
            { kind: "Justification", id: justificationId },
            {},
          );
        }
        await store.edges.derives.create(
          { kind: "Justification", id: justificationId },
          derived,
          {},
        );
      };
      const report = (id: string) => ({ kind: "Report", id }) as const;
      const section = (id: string) => ({ kind: "Section", id }) as const;
      const source = (id: string) => ({ kind: "Source", id }) as const;
      for (const id of ["base", "chained", "dead", "dead-chained", "expired"]) {
        await store.nodes.Report.create({ label: id }, { id });
      }
      for (const [id, whole] of [
        ["part-of-base", "base"],
        ["part-of-dead", "dead"],
      ] as const) {
        await store.nodes.Section.create(
          { label: id },
          { id, partOf: { whole: report(whole) } },
        );
      }
      await derive("base-j", [source("live-source")], report("base"));
      await derive("chained-j", [report("base")], report("chained"));
      await derive("dead-j", [source("retracted-source")], report("dead"));
      await derive("dead-chained-j", [report("dead")], report("dead-chained"));
      await derive("expired-j", [source("expired-source")], report("expired"));
      await derive(
        "part-of-base-j",
        [source("live-source")],
        section("part-of-base"),
      );
      await derive(
        "part-of-dead-j",
        [source("live-source")],
        section("part-of-dead"),
      );
      const holdingFacts = [
        report("base"),
        report("chained"),
        section("part-of-base"),
      ];
      const failingFacts = [
        report("dead"),
        report("dead-chained"),
        report("expired"),
        section("part-of-dead"),
      ];

      const endpointFilteredReads = { value: 0 };
      const [fallbackStore] = await createStoreWithSchema(
        compositionGraph,
        withoutEndpointSetRead(context.getBackend(), endpointFilteredReads),
        { history: true },
      );
      const factKinds = { fact: { kinds: ["Report", "Section"] } } as const;
      const viaSetRead = createRetractionCapability(store, {
        ...config,
        ...factKinds,
      });
      const viaFallback = createRetractionCapability(fallbackStore, {
        ...config,
        ...factKinds,
      });

      const setHeld = await store.transaction((tx) =>
        viaSetRead.assertHolds(tx, holdingFacts),
      );
      expect(endpointFilteredReads.value).toBe(0);
      const fallbackHeld = await fallbackStore.transaction((tx) =>
        viaFallback.assertHolds(tx, holdingFacts),
      );
      expect(endpointFilteredReads.value).toBeGreaterThan(0);
      expect(fallbackHeld).toEqual(setHeld);
      expect(setHeld).toEqual([
        {
          fact: report("base"),
          via: [{ kind: "Justification", id: "base-j" }],
        },
        {
          fact: report("chained"),
          via: [{ kind: "Justification", id: "chained-j" }],
        },
        {
          fact: section("part-of-base"),
          via: [{ kind: "Justification", id: "part-of-base-j" }],
        },
      ]);

      const setRefusal = await captureNotHolding(
        store.transaction((tx) => viaSetRead.assertHolds(tx, failingFacts)),
      );
      const fallbackRefusal = await captureNotHolding(
        fallbackStore.transaction((tx) =>
          viaFallback.assertHolds(tx, failingFacts),
        ),
      );
      expect(fallbackRefusal.failures).toEqual(setRefusal.failures);
      expect(
        setRefusal.failures.map((failure) => [failure.fact.id, failure.reason]),
      ).toEqual([
        ["dead", "no-firing-justification"],
        ["dead-chained", "no-firing-justification"],
        ["expired", "no-firing-justification"],
        ["part-of-dead", "composition-whole-unsupported"],
      ]);
    });
  });
}
