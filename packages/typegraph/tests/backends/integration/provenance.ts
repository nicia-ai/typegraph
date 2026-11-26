import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  ConfigurationError,
  createAdapterStoreWithSchema,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
  NodeNotFoundError,
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
import {
  StaleVersionError,
  UnsupportedBackendCapabilityError,
} from "../../../src/errors-entry";
import { defineGraphExtension } from "../../../src/graph-extension";
import {
  createRetractionCapability,
  FactNotHoldingError,
} from "../../../src/provenance";
import type { HistoryStore } from "../../../src/store/store";
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

// An unrelated kind: evolving the provenance graph with it leaves every role
// the capability maps in place, so the evolved graph still validates.
const noteExtension = defineGraphExtension({
  nodes: {
    ProvenanceNote: {
      properties: { label: { type: "string", optional: true } },
    },
  },
});

// The provenance roles with `Decision` as a second fact kind, for an
// evolution that makes a `Decision` a required part of a `Fact`.
const decisionFactConfig = {
  ...config,
  fact: { kinds: ["Fact", "Decision"] },
} as const;

// Makes a `Decision` a required part of the `Fact` it is recorded under, so
// closing that fact closes the decision with it. Only the evolved graph's
// registry knows the composition: support computed with the original graph's
// registry leaves the decision live under a closed whole.
const recordedUnderExtension = defineGraphExtension({
  edges: {
    recordedUnder: {
      from: ["Decision"],
      to: ["Fact"],
      properties: {},
      cardinality: "one",
    },
  },
  ontology: [
    {
      metaEdge: "partOf",
      from: "Decision",
      to: "Fact",
      via: "recordedUnder",
      existence: "required",
    },
  ],
});

type ProvenanceStore = HistoryStore<typeof provenanceGraph>;
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

function ref<K extends string>(kind: K, id: string) {
  return { kind, id } as const;
}

function expectNotOwned(error: unknown, operation: string): void {
  expect(error).toBeInstanceOf(ConfigurationError);
  expect((error as ConfigurationError).details).toMatchObject({
    code: "PROVENANCE_TRANSACTION_NOT_OWNED",
    operation,
  });
}

/**
 * Records, in write order, the ids of the Source rows a store updates, as its
 * `onOperationEnd` hook reports them.
 */
function sourceUpdateRecorder() {
  const updated: string[] = [];
  const hooks = {
    onOperationEnd: (
      ctx: Readonly<{ operation: string; kind: string; id: string }>,
    ) => {
      if (ctx.operation === "update" && ctx.kind === "Source") {
        updated.push(ctx.id);
      }
    },
  };
  return { updated, hooks };
}

/** Returns what was recorded so far and clears it. */
function takeAll(updated: string[]): string[] {
  return updated.splice(0);
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
  return seedProvenance(await createHistoryStore(context));
}

async function seedProvenance<S extends ProvenanceStore>(store: S) {
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

/** Every function member of a backend object, own or inherited. */
function functionMemberNames(target: object): readonly string[] {
  const names = new Set<string>();
  for (
    let level: object | null = target;
    level !== null && level !== Object.prototype;
    level = Reflect.getPrototypeOf(level)
  ) {
    for (const key of Reflect.ownKeys(level)) {
      if (typeof key !== "string") continue;
      if (typeof Reflect.get(target, key) === "function") names.add(key);
    }
  }
  return [...names];
}

/**
 * The transaction target with every function member, and its command port's
 * `execute`, recording its name in `calls` before it runs: each is a
 * statement, or several, on the transaction's session.
 */
function recordingTransactionTarget(
  target: TransactionBackend,
  calls: string[],
): TransactionBackend {
  const overlay: Record<string, unknown> = {};
  for (const name of functionMemberNames(target)) {
    const member = Reflect.get(target, name) as (
      ...args: readonly unknown[]
    ) => unknown;
    overlay[name] = (...args: readonly unknown[]) => {
      calls.push(name);
      return member(...args);
    };
  }
  const { commands } = target;
  overlay["commands"] = {
    ...commands,
    execute: (...args: Parameters<typeof commands.execute>) => {
      calls.push("commands.execute");
      return commands.execute(...args);
    },
  };
  return deriveBackend(target, overlay as Partial<TransactionBackend>);
}

/**
 * `backend` with every transaction it opens handing its callback a
 * {@link recordingTransactionTarget}, so a test can count the statements a
 * call inside a store transaction issued.
 */
function recordTransactionCalls(
  backend: AdapterBackend<unknown>,
): Readonly<{ backend: AdapterBackend<unknown>; calls: string[] }> {
  const calls: string[] = [];
  return {
    calls,
    backend: deriveBackend(backend, {
      transaction: (fn, options) =>
        backend.transaction(
          (target) => fn(recordingTransactionTarget(target, calls)),
          options,
        ),
    }),
  };
}

/** A backend that cannot adopt a schema write refuses the evolved transaction. */
async function expectUnsupportedAdoption(
  run: () => Promise<unknown>,
): Promise<void> {
  await expect(run()).rejects.toThrow(UnsupportedBackendCapabilityError);
}

async function captureNotHolding(
  work: Promise<unknown>,
): Promise<FactNotHoldingError> {
  const error = await captureRejection(work);
  expect(error).toBeInstanceOf(FactNotHoldingError);
  return error as FactNotHoldingError;
}

interface EndpointFilteredReadCount {
  value: number;
}

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

    it("checks ownership for an empty list: returns [] for an owned transaction, read-only included, and refuses a foreign or retained one", async () => {
      const { store, provenance } = await seedStore(context);
      const otherStore = await createHistoryStore(context);

      await expect(
        store.transaction((tx) => provenance.assertHolds(tx, [])),
      ).resolves.toEqual([]);
      await expect(
        store.transaction((tx) => provenance.assertHolds(tx, []), {
          accessMode: "read_only",
        }),
      ).resolves.toEqual([]);

      const foreign = await captureRejection(
        otherStore.transaction((tx) => provenance.assertHolds(tx, [])),
      );
      const retained = await store.transaction((tx) => Promise.resolve(tx));
      const pastCallback = await captureRejection(
        provenance.assertHolds(retained, []),
      );
      for (const refusal of [foreign, pastCallback]) {
        expect(refusal).toBeInstanceOf(ConfigurationError);
        expect((refusal as ConfigurationError).details).toMatchObject({
          code: "PROVENANCE_TRANSACTION_NOT_OWNED",
          operation: "provenance.assertHolds()",
        });
      }
    });

    it("holding(tx) on a stale store handle refuses a read-write transaction with StaleVersionError and still answers read-only and with no argument", async () => {
      const { store, provenance } = await seedStore(context);
      await store.evolve(noteExtension);

      const stale = await captureRejection(
        store.transaction((tx) => provenance.holding(tx)),
      );
      expect(stale).toBeInstanceOf(StaleVersionError);

      await expect(
        store.transaction((tx) => provenance.holding(tx), {
          accessMode: "read_only",
        }),
      ).resolves.toEqual([fact("live-fact")]);
      await expect(provenance.holding()).resolves.toEqual([fact("live-fact")]);
    });

    it("judges inside withEvolvedTransaction against the evolved graph: refuses and rolls the evolution back, or passes and commits it", async () => {
      const backend = context.getBackend();
      const [adapterStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        backend,
        { history: true },
      );
      const { store, provenance } = await seedProvenance(adapterStore);
      const plan = await store.planEvolution(noteExtension);
      if (plan.status !== "change") throw new Error("Expected change plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await expectUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            store.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }

      const refusal = await captureNotHolding(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await deriveInTransaction(
              tx,
              [{ kind: "Source", id: "retracted-source" }],
              "evolved-dead-j",
              "evolved-dead",
            );
            await provenance.assertHolds(tx, [fact("evolved-dead")]);
          }),
        ),
      );
      expect(refusal.failures).toEqual([
        {
          fact: fact("evolved-dead"),
          reason: "no-firing-justification",
          justifications: [
            {
              justification: { kind: "Justification", id: "evolved-dead-j" },
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
      await expect(backend.getActiveSchema(store.graphId)).resolves.toEqual(
        expect.objectContaining({ version: plan.baseline.version }),
      );
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("evolved-dead")),
      ).resolves.toBeUndefined();

      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          store.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            await deriveInTransaction(
              tx,
              [{ kind: "Source", id: "live-source" }],
              "evolved-held-j",
              "evolved-held",
            );
            const held = await provenance.assertHolds(tx, [
              fact("evolved-held"),
            ]);
            return { held, believed: await provenance.holding(tx) };
          }),
      );
      expect(outcome.result.held).toEqual([
        {
          fact: fact("evolved-held"),
          via: [{ kind: "Justification", id: "evolved-held-j" }],
        },
      ]);
      expect(outcome.result.believed).toEqual([
        fact("evolved-held"),
        fact("live-fact"),
      ]);
      await expect(backend.getActiveSchema(store.graphId)).resolves.toEqual(
        expect.objectContaining({ version: plan.result.version }),
      );
    });

    it("judges inside withRecordedTransaction: refuses and leaves no rows, or passes and sees the transaction's writes in holding(tx)", async () => {
      const backend = context.getBackend();
      const [adapterStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        backend,
        { history: true },
      );
      const { store, provenance } = await seedProvenance(adapterStore);

      const refusal = await captureNotHolding(
        backend.transactionWithNative(async (_target, nativeTx) =>
          store.withRecordedTransaction(nativeTx, async (tx) => {
            await deriveInTransaction(
              tx,
              [{ kind: "Source", id: "retracted-source" }],
              "recorded-dead-j",
              "recorded-dead",
            );
            await provenance.assertHolds(tx, [fact("recorded-dead")]);
          }),
        ),
      );
      expect(refusal.failures.map((failure) => failure.reason)).toEqual([
        "no-firing-justification",
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("recorded-dead")),
      ).resolves.toBeUndefined();

      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          store.withRecordedTransaction(nativeTx, async (tx) => {
            await deriveInTransaction(
              tx,
              [{ kind: "Source", id: "live-source" }],
              "recorded-held-j",
              "recorded-held",
            );
            const held = await provenance.assertHolds(tx, [
              fact("recorded-held"),
            ]);
            return { held, believed: await provenance.holding(tx) };
          }),
      );
      expect(outcome.result.held).toEqual([
        {
          fact: fact("recorded-held"),
          via: [{ kind: "Justification", id: "recorded-held-j" }],
        },
      ]);
      expect(outcome.result.believed).toEqual([
        fact("live-fact"),
        fact("recorded-held"),
      ]);
      expect(outcome.receipt.recorded).toBeDefined();
    });

    it("judges on a tx.measure scope: refuses, or passes with the scope's writes counted in its receipt", async () => {
      const { store, provenance } = await seedStore(context);

      const refusal = await captureNotHolding(
        store.transactionWithReceipt((tx) =>
          tx.measure(async (scoped) => {
            await deriveInTransaction(
              scoped,
              [{ kind: "Source", id: "retracted-source" }],
              "scoped-dead-j",
              "scoped-dead",
            );
            await provenance.assertHolds(scoped, [fact("scoped-dead")]);
          }),
        ),
      );
      expect(refusal.failures.map((failure) => failure.reason)).toEqual([
        "no-firing-justification",
      ]);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>("scoped-dead")),
      ).resolves.toBeUndefined();

      const outcome = await store.transactionWithReceipt((tx) =>
        tx.measure(async (scoped) => {
          await deriveInTransaction(
            scoped,
            [{ kind: "Source", id: "live-source" }],
            "scoped-held-j",
            "scoped-held",
          );
          const held = await provenance.assertHolds(scoped, [
            fact("scoped-held"),
          ]);
          return { held, believed: await provenance.holding(scoped) };
        }),
      );
      expect(outcome.result.result.held).toEqual([
        {
          fact: fact("scoped-held"),
          via: [{ kind: "Justification", id: "scoped-held-j" }],
        },
      ]);
      expect(outcome.result.result.believed).toEqual([
        fact("live-fact"),
        fact("scoped-held"),
      ]);
      expect(outcome.result.receipt.writes.total).toBe(4);
    });
  });
  describe("provenance retraction in a caller's transaction", () => {
    type CallerTransaction = Parameters<
      Parameters<ProvenanceStore["transaction"]>[0]
    >[0];

    const keepSource = ref("Source", "keep-source");
    const dropSource = ref("Source", "drop-source");
    const keepFact = ref("Fact", "keep-fact");
    const dropFact = ref("Fact", "drop-fact");

    /**
     * `keep-fact` holds through `keep-source`, `drop-fact` through
     * `drop-source`, and `shared-fact` through either; `decision` is the
     * caller's own row, not a fact.
     */
    async function seedCallerWorld(
      store: ProvenanceStore,
    ): Promise<
      ReturnType<
        typeof createRetractionCapability<typeof provenanceGraph, typeof config>
      >
    > {
      const keep = await createSource(store, keepSource.id);
      const drop = await createSource(store, dropSource.id);
      const keepNode = await createFact(store, keepFact.id);
      const dropNode = await createFact(store, dropFact.id);
      const shared = await createFact(store, "shared-fact");
      await createJustification(store, "keep-j", [keep], keepNode);
      await createJustification(store, "drop-j", [drop], dropNode);
      await createJustification(store, "shared-keep-j", [keep], shared);
      await createJustification(store, "shared-drop-j", [drop], shared);
      await createDecision(store, "decision");
      return createRetractionCapability(store, config);
    }

    async function decisionLabel(
      reader: Readonly<{
        nodes: Readonly<{
          Decision: Pick<ProvenanceStore["nodes"]["Decision"], "getById">;
        }>;
      }>,
    ): Promise<string | undefined> {
      const decision = await reader.nodes.Decision.getById(
        asNodeId<typeof Decision>("decision"),
      );
      return decision?.label;
    }

    async function sourceFlag(
      store: ProvenanceStore,
      id: string,
    ): Promise<boolean | undefined> {
      const source = await store.nodes.Source.getById(
        asNodeId<typeof Source>(id),
      );
      return source?.retracted;
    }

    // Load-bearing: the transition runs on the caller's transaction, so its
    // writes are visible to that transaction's later reads and commit or roll
    // back with it. Revert check: make `runTransition` ignore `request.tx`
    // (always `store.transaction`) and on PostgreSQL the call waits on the
    // graph lock the caller's transaction already holds; on SQLite the
    // rollback branch keeps the retraction, so both `believed` checks after
    // the rollback fail.
    it("retracts, changes the caller's own row and asserts in one transaction: a commit keeps all of it and a rollback none", async () => {
      const store = await createHistoryStore(context);
      const provenance = await seedCallerWorld(store);

      const refusal = await captureNotHolding(
        store.transaction(async (tx) => {
          const report = await provenance.retract(dropSource, tx);
          expect(report.died).toEqual([dropFact]);
          await tx.nodes.Decision.update(
            asNodeId<typeof Decision>("decision"),
            {
              label: "withdrawn",
            },
          );
          await expect(
            tx.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
          ).resolves.toBeUndefined();
          await provenance.assertHolds(tx, [keepFact, dropFact]);
        }),
      );
      expect(refusal.failures.map((failure) => failure.fact)).toEqual([
        dropFact,
      ]);
      expect(sortedIds(await provenance.holding())).toEqual([
        "drop-fact",
        "keep-fact",
        "shared-fact",
      ]);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);
      await expect(decisionLabel(store)).resolves.toBe("decision");

      const committed = await store.transaction(async (tx) => {
        const report = await provenance.retract(dropSource, tx);
        await tx.nodes.Decision.update(asNodeId<typeof Decision>("decision"), {
          label: "withdrawn",
        });
        const held = await provenance.assertHolds(tx, [
          keepFact,
          ref("Fact", "shared-fact"),
        ]);
        return {
          report,
          held,
          believed: await provenance.holding(tx),
          ownRead: await decisionLabel(tx),
        };
      });
      expect(committed.report).toEqual({
        died: [dropFact],
        survivedVia: [
          {
            fact: ref("Fact", "shared-fact"),
            via: [ref("Justification", "shared-keep-j")],
          },
        ],
        unaffected: [keepFact],
      });
      expect(committed.held).toEqual([
        { fact: keepFact, via: [ref("Justification", "keep-j")] },
        {
          fact: ref("Fact", "shared-fact"),
          via: [ref("Justification", "shared-keep-j")],
        },
      ]);
      expect(sortedIds(committed.believed)).toEqual([
        "keep-fact",
        "shared-fact",
      ]);
      expect(committed.ownRead).toBe("withdrawn");
      expect(sortedIds(await provenance.holding())).toEqual([
        "keep-fact",
        "shared-fact",
      ]);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(true);
      await expect(decisionLabel(store)).resolves.toBe("withdrawn");
    });

    it("unRetract in a caller's transaction reopens what a rollback then discards, and a commit keeps", async () => {
      const store = await createHistoryStore(context);
      const provenance = await seedCallerWorld(store);
      await provenance.retract(dropSource);

      await expect(
        store.transaction(async (tx) => {
          await provenance.unRetract(dropSource, tx);
          expect(sortedIds(await provenance.holding(tx))).toEqual([
            "drop-fact",
            "keep-fact",
            "shared-fact",
          ]);
          throw new Error("caller rollback");
        }),
      ).rejects.toThrow("caller rollback");
      expect(sortedIds(await provenance.holding())).toEqual([
        "keep-fact",
        "shared-fact",
      ]);

      await store.transaction(async (tx) => {
        await provenance.unRetract(dropSource, tx);
        await provenance.assertHolds(tx, [dropFact]);
      });
      expect(sortedIds(await provenance.holding())).toEqual([
        "drop-fact",
        "keep-fact",
        "shared-fact",
      ]);
    });

    // Load-bearing for the stated order contract: each store records the
    // order its source rows were written in through its hooks, so a path that
    // flipped the sources in another order than the other fails here even
    // though the reports, sorted, and the final holding set would agree.
    // Revert check: reverse the source write loop of `transitionInTransaction`
    // for a caller's transaction only, and the update sequences differ.
    it("reports and orders retractMany and unRetractMany identically with and without a caller's transaction", async () => {
      // Two stores of one graph on separate databases, seeded alike.
      const ownWrites = sourceUpdateRecorder();
      const callerWrites = sourceUpdateRecorder();
      const own = await context.createHistoryStore(provenanceGraph, {
        hooks: ownWrites.hooks,
      });
      const [caller] = await createStoreWithSchema(
        provenanceGraph,
        await context.createIsolatedBackend(),
        { history: true, hooks: callerWrites.hooks },
      );
      const ownProvenance = await seedCallerWorld(own);
      const callerProvenance = await seedCallerWorld(caller);
      takeAll(ownWrites.updated);
      takeAll(callerWrites.updated);
      // Unsorted, with a duplicate, and not a palindrome: the sources apply
      // in first-occurrence order, so retracting writes drop then keep and
      // restoring the reversed list writes keep then drop.
      const sources = [dropSource, keepSource, keepSource];

      const ownRetract = await ownProvenance.retractMany(sources);
      const callerRetract = await caller.transaction((tx) =>
        callerProvenance.retractMany(sources, tx),
      );
      expect(callerRetract).toEqual(ownRetract);
      expect(sortedIds(ownRetract.died)).toEqual([
        "drop-fact",
        "keep-fact",
        "shared-fact",
      ]);
      expect(takeAll(ownWrites.updated)).toEqual([
        dropSource.id,
        keepSource.id,
      ]);
      expect(takeAll(callerWrites.updated)).toEqual([
        dropSource.id,
        keepSource.id,
      ]);

      const ownRestore = await ownProvenance.unRetractMany(
        sources.toReversed(),
      );
      const callerRestore = await caller.transaction((tx) =>
        callerProvenance.unRetractMany(sources.toReversed(), tx),
      );
      expect(callerRestore).toEqual(ownRestore);
      expect(await callerProvenance.holding()).toEqual(
        await ownProvenance.holding(),
      );
      expect(takeAll(ownWrites.updated)).toEqual([
        keepSource.id,
        dropSource.id,
      ]);
      expect(takeAll(callerWrites.updated)).toEqual([
        keepSource.id,
        dropSource.id,
      ]);

      const ownSingle = await ownProvenance.retract(keepSource);
      const callerSingle = await caller.transaction((tx) =>
        callerProvenance.retract(keepSource, tx),
      );
      expect(callerSingle).toEqual(ownSingle);
      const ownUnSingle = await ownProvenance.unRetract(keepSource);
      const callerUnSingle = await caller.transaction((tx) =>
        callerProvenance.unRetract(keepSource, tx),
      );
      expect(callerUnSingle).toEqual(ownUnSingle);
      expect(takeAll(callerWrites.updated)).toEqual(takeAll(ownWrites.updated));
    });

    // Load-bearing: the verb's writes go through the caller's transaction
    // context, so its success hooks are buffered until that transaction
    // commits and dropped to onError when it rolls back.
    it("reports the verb's hooks at the caller's commit, and none as completed when it rolls back", async () => {
      const events: string[] = [];
      const store = await context.createHistoryStore(provenanceGraph, {
        hooks: {
          onOperationEnd: (ctx) => {
            events.push(`end:${ctx.operation}:${ctx.kind}:${ctx.id}`);
          },
        },
      });
      const provenance = await seedCallerWorld(store);
      events.length = 0;

      await expect(
        store.transaction(async (tx) => {
          await provenance.retract(dropSource, tx);
          throw new Error("caller rollback");
        }),
      ).rejects.toThrow("caller rollback");
      expect(events).toEqual([]);

      const insideCallback: string[] = [];
      await store.transaction(async (tx) => {
        await provenance.retract(dropSource, tx);
        await tx.nodes.Decision.update(asNodeId<typeof Decision>("decision"), {
          label: "withdrawn",
        });
        insideCallback.push(...events);
      });
      expect(insideCallback).toEqual([]);
      expect(events.toSorted()).toEqual([
        "end:delete:Fact:drop-fact",
        "end:update:Decision:decision",
        "end:update:Source:drop-source",
      ]);
    });

    // Load-bearing for the adopted-hook contract the docs state: an adopted
    // context runs hooks as each operation completes, not at the native
    // commit, so a retraction the native caller then rolls back has already
    // been reported. Revert check: give the adopted context a runner that
    // fires no hooks and the in-callback expectation fails.
    it("in withRecordedTransaction reports the verb's hooks as each write completes, before the native caller's rollback", async () => {
      const events: string[] = [];
      const backend = context.getBackend();
      const [adapterStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        backend,
        {
          history: true,
          hooks: {
            onOperationEnd: (ctx) => {
              events.push(`end:${ctx.operation}:${ctx.kind}:${ctx.id}`);
            },
          },
        },
      );
      const provenance = await seedCallerWorld(adapterStore);
      events.length = 0;

      const insideCallback: string[] = [];
      await expect(
        backend.transactionWithNative(async (_target, nativeTx) => {
          await adapterStore.withRecordedTransaction(nativeTx, async (tx) => {
            await provenance.retract(dropSource, tx);
            insideCallback.push(...events);
          });
          throw new Error("native rollback");
        }),
      ).rejects.toThrow("native rollback");

      expect(insideCallback.toSorted()).toEqual([
        "end:delete:Fact:drop-fact",
        "end:update:Source:drop-source",
      ]);
      expect(events.toSorted()).toEqual(insideCallback.toSorted());
      // The rollback undid what the hooks reported.
      await expect(sourceFlag(adapterStore, dropSource.id)).resolves.toBe(
        false,
      );
      await expect(
        adapterStore.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
      ).resolves.toMatchObject({ id: dropFact.id });
    });

    it("counts the verb's writes in the caller's receipt and measure scope, at the caller's one recorded revision", async () => {
      const store = await createHistoryStore(context);
      const provenance = await seedCallerWorld(store);
      const before = requireDefined(await store.recordedNow());

      const outcome = await store.transactionWithReceipt(async (tx) => {
        await tx.nodes.Decision.update(asNodeId<typeof Decision>("decision"), {
          label: "withdrawn",
        });
        const scoped = await tx.measure((scope) =>
          provenance.retract(dropSource, scope),
        );
        return scoped.receipt.writes;
      });

      // The source flip and the fact close, in the scope that ran them.
      expect(outcome.result.total).toBe(2);
      expect(outcome.result.nodes).toEqual({ Source: 1, Fact: 1 });
      expect(outcome.receipt.writes.total).toBe(3);
      const recorded = requireDefined(outcome.receipt.recorded);
      await expect(store.recordedNow()).resolves.toBe(recorded);
      const atBefore = store.asOfRecorded(before);
      const atRecorded = store.asOfRecorded(recorded);
      await expect(
        atBefore.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
      ).resolves.toMatchObject({ id: dropFact.id });
      await expect(decisionLabel(atBefore)).resolves.toBe("decision");
      await expect(
        atRecorded.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
      ).resolves.toBeUndefined();
      await expect(decisionLabel(atRecorded)).resolves.toBe("withdrawn");

      // The reopen counts as the fact's write too.
      const reopened = await store.transactionWithReceipt((tx) =>
        provenance.unRetract(dropSource, tx),
      );
      expect(reopened.result.survivedVia.map((entry) => entry.fact)).toEqual([
        dropFact,
        ref("Fact", "shared-fact"),
      ]);
      expect(reopened.receipt.writes.nodes).toEqual({ Source: 1, Fact: 1 });
      expect(reopened.receipt.writes.total).toBe(2);
    });

    // Load-bearing: each refusal precedes every statement on the foreign
    // transaction. Revert check: move `resolveScope(tx, request.operation)`
    // in `runTransition` (`src/provenance/transition.ts`) after a read of
    // the source row through `enterTransactionOperation(tx)` and `issued`
    // records it.
    it("refuses another store's or graph's transaction and one kept past its callback, before any statement", async () => {
      const recorded = recordTransactionCalls(context.getBackend());
      const [store] = await createAdapterStoreWithSchema(
        provenanceGraph,
        recorded.backend,
        { history: true },
      );
      const provenance = await seedCallerWorld(store);
      const [otherStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        recorded.backend,
        { history: true },
      );
      const [otherGraphStore] = await createAdapterStoreWithSchema(
        identityProvenanceGraph,
        recorded.backend,
        { history: true },
      );
      const retained = await store.transaction((tx) => Promise.resolve(tx));

      /** The refusal `work` raised, and the calls it made on any transaction. */
      async function refusalAndIssued(work: () => Promise<unknown>) {
        const before = recorded.calls.length;
        const refusal = await captureRejection(work());
        return { refusal, issued: recorded.calls.slice(before) };
      }

      const otherStoreOutcome = await otherStore.transaction(async (tx) => {
        const outcome = await refusalAndIssued(() =>
          provenance.retract(dropSource, tx),
        );
        // Control: the recorder sees this transaction's statements.
        const controlStart = recorded.calls.length;
        await tx.nodes.Source.getById(asNodeId<typeof Source>(dropSource.id));
        return {
          ...outcome,
          controlIssued: recorded.calls.length - controlStart,
        };
      });
      const otherGraphOutcome = await otherGraphStore.transaction((tx) =>
        refusalAndIssued(() =>
          provenance.retractMany(
            [dropSource],
            tx as unknown as CallerTransaction,
          ),
        ),
      );
      const retainedSingle = await refusalAndIssued(() =>
        provenance.unRetract(dropSource, retained),
      );
      const retainedMany = await refusalAndIssued(() =>
        provenance.unRetractMany([dropSource], retained),
      );

      expectNotOwned(
        otherStoreOutcome.refusal,
        "provenance.retract(source, tx)",
      );
      expectNotOwned(
        otherGraphOutcome.refusal,
        "provenance.retractMany(sources, tx)",
      );
      expectNotOwned(
        retainedSingle.refusal,
        "provenance.unRetract(source, tx)",
      );
      expectNotOwned(
        retainedMany.refusal,
        "provenance.unRetractMany(sources, tx)",
      );
      expect(otherStoreOutcome.issued).toEqual([]);
      expect(otherGraphOutcome.issued).toEqual([]);
      expect(retainedSingle.issued).toEqual([]);
      expect(retainedMany.issued).toEqual([]);
      expect(otherStoreOutcome.controlIssued).toBeGreaterThan(0);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);
    });

    // Load-bearing: two verbs overlapping on one transaction would each
    // decide from a support read that predates the other's writes, so
    // retracting both sources of `shared-fact` at once would keep it live on
    // the support each believed the other left. The second call is refused
    // before any statement, the transaction stays usable, and an awaited
    // verb after it runs. Revert check: run `transitionInExclusiveSection`
    // directly from `transitionInTransaction` (`src/provenance/transition.ts`)
    // and both calls commit their flags with `shared-fact` still live.
    it("refuses a verb that overlaps another verb on the same transaction, before any statement, leaving the transaction usable", async () => {
      const [store] = await createAdapterStoreWithSchema(
        provenanceGraph,
        context.getBackend(),
        { history: true },
      );
      const provenance = await seedCallerWorld(store);

      const settled = await store.transaction(async (tx) => {
        const outcomes = await Promise.allSettled([
          provenance.retract(keepSource, tx),
          provenance.retract(dropSource, tx),
        ]);
        // The transaction is still usable for an awaited verb.
        const afterwards = await provenance.retract(dropSource, tx);
        return { outcomes, afterwards };
      });

      const [first, second] = settled.outcomes;
      expect(first.status).toBe("fulfilled");
      expect(second.status).toBe("rejected");
      const refusal = (second as PromiseRejectedResult).reason as unknown;
      expect(refusal).toBeInstanceOf(ConfigurationError);
      expect((refusal as ConfigurationError).details).toMatchObject({
        code: "PROVENANCE_TRANSITION_OVERLAPPING",
        operation: "provenance.retract(source, tx)",
        runningOperation: "provenance.retract(source, tx)",
      });
      expect(sortedIds(settled.afterwards.died)).toEqual([
        "drop-fact",
        "shared-fact",
      ]);
      await expect(sourceFlag(store, keepSource.id)).resolves.toBe(true);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(true);
      const live = sortedIds([...(await store.nodes.Fact.find())]);
      expect(live).toEqual([]);
      expect(await provenance.holding()).toEqual([]);
    });

    // Load-bearing: handing a verb straight to an array method passes the
    // element's index where the transaction goes. Revert check: drop the
    // `isTransactionContext` refusal from the capability's transaction
    // resolver and these calls fail with the generic
    // PROVENANCE_TRANSACTION_NOT_OWNED instead. Every transaction the store
    // opens is recorded, so a refusal reached only after a statement (say,
    // `runTransition` taking the write locks in a transaction of its own
    // before it resolves the caller's) leaves calls in `issued`.
    it("refuses a second argument that is not a transaction context, naming it, before any statement", async () => {
      const recorded = recordTransactionCalls(context.getBackend());
      const [store] = await createAdapterStoreWithSchema(
        provenanceGraph,
        recorded.backend,
        { history: true },
      );
      const provenance = await seedCallerWorld(store);
      const refusalsStart = recorded.calls.length;
      const single = [dropSource];
      const lists = [[dropSource]];

      function expectNotAContext(
        error: unknown,
        operation: string,
        received: string,
        receivedType: string,
      ): void {
        expect(error).toBeInstanceOf(ConfigurationError);
        const refusal = error as ConfigurationError;
        expect(refusal.details).toMatchObject({
          code: "PROVENANCE_TRANSACTION_ARGUMENT_INVALID",
          operation,
          receivedType,
        });
        expect(refusal.message).toContain(
          `${operation} received ${received} where a transaction context was expected.`,
        );
        expect(refusal.suggestion).toContain(
          "sources.map((source) => provenance.retract(source))",
        );
      }

      /* eslint-disable unicorn/no-array-callback-reference, unicorn/no-null -- the
         misuse under test: a verb handed straight to `.map`, and a null
         transaction. */
      expectNotAContext(
        await captureRejection(
          // @ts-expect-error the array index is not a transaction context
          Promise.all(single.map(provenance.retract)),
        ),
        "provenance.retract(source, tx)",
        "the number 0",
        "number",
      );
      expectNotAContext(
        await captureRejection(
          // @ts-expect-error the array index is not a transaction context
          Promise.all(lists.map(provenance.retractMany)),
        ),
        "provenance.retractMany(sources, tx)",
        "the number 0",
        "number",
      );
      expectNotAContext(
        await captureRejection(
          // @ts-expect-error the array index is not a transaction context
          Promise.all(single.map(provenance.unRetract)),
        ),
        "provenance.unRetract(source, tx)",
        "the number 0",
        "number",
      );
      expectNotAContext(
        await captureRejection(
          // @ts-expect-error the array index is not a transaction context
          Promise.all(lists.map(provenance.unRetractMany)),
        ),
        "provenance.unRetractMany(sources, tx)",
        "the number 0",
        "number",
      );
      expectNotAContext(
        await captureRejection(
          provenance.retract(dropSource, null as unknown as CallerTransaction),
        ),
        "provenance.retract(source, tx)",
        "null",
        "null",
      );
      expectNotAContext(
        await captureRejection(
          provenance.retract(dropSource, {} as unknown as CallerTransaction),
        ),
        "provenance.retract(source, tx)",
        "a value of type object that is not a transaction context",
        "object",
      );
      /* eslint-enable unicorn/no-array-callback-reference, unicorn/no-null */
      // The capability's other transaction entry points share the refusal.
      expectNotAContext(
        await captureRejection(
          provenance.holding(0 as unknown as CallerTransaction),
        ),
        "provenance.holding(tx)",
        "the number 0",
        "number",
      );
      expectNotAContext(
        await captureRejection(
          provenance.assertHolds(0 as unknown as CallerTransaction, [keepFact]),
        ),
        "provenance.assertHolds()",
        "the number 0",
        "number",
      );
      expect(recorded.calls.slice(refusalsStart), "issued").toEqual([]);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);

      // The documented replacement: a function that passes the source alone.
      // Control: the recorder sees the transaction it opens.
      const replacementStart = recorded.calls.length;
      const reports = await Promise.all(
        single.map((source) => provenance.retract(source)),
      );
      expect(reports[0]?.died).toEqual([dropFact]);
      expect(recorded.calls.length).toBeGreaterThan(replacementStart);
    });

    // Load-bearing: the write-access refusal precedes every statement.
    // Revert check: read the source row (`backend.getNode`) before
    // `acquireCapabilityWriteLocks` in `transitionInTransaction`
    // (`src/provenance/transition.ts`) and `issued` records it.
    it("refuses a read-only transaction before any statement, leaving it usable", async () => {
      const recorded = recordTransactionCalls(context.getBackend());
      const [store] = await createAdapterStoreWithSchema(
        provenanceGraph,
        recorded.backend,
        { history: true },
      );
      const provenance = await seedCallerWorld(store);

      const outcome = await store.transaction(
        async (tx) => {
          const before = recorded.calls.length;
          const refusal = await captureRejection(
            provenance.retract(dropSource, tx),
          );
          const issued = recorded.calls.slice(before);
          const holdingStart = recorded.calls.length;
          const holding = await provenance.holding(tx);
          return {
            refusal,
            issued,
            holdingIssued: recorded.calls.length - holdingStart,
            holding,
          };
        },
        { accessMode: "read_only" },
      );

      expect(outcome.issued).toEqual([]);
      // The recorder sees this transaction's statements: the read after the
      // refusal issued some.
      expect(outcome.holdingIssued).toBeGreaterThan(0);

      expect(outcome.refusal).toBeInstanceOf(UnsupportedBackendCapabilityError);
      expect(
        (outcome.refusal as UnsupportedBackendCapabilityError).details,
      ).toMatchObject({
        operation: "provenance.retract(source, tx)",
        capability: "write transaction access",
        accessMode: "read_only",
      });
      expect(sortedIds(outcome.holding)).toEqual([
        "drop-fact",
        "keep-fact",
        "shared-fact",
      ]);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);
    });

    it("refuses a stale store handle's transaction with StaleVersionError, and a source of another kind with ConfigurationError", async () => {
      const store = await createHistoryStore(context);
      const provenance = await seedCallerWorld(store);

      const wrongKind = await captureRejection(
        store.transaction((tx) =>
          provenance.retract(
            // @ts-expect-error Fact is not a configured source kind
            keepFact,
            tx,
          ),
        ),
      );
      expect(wrongKind).toBeInstanceOf(ConfigurationError);
      expect((wrongKind as ConfigurationError).details).toMatchObject({
        expectedKinds: ["Source"],
        actualKind: "Fact",
      });

      await store.evolve(noteExtension);
      const stale = await captureRejection(
        store.transaction((tx) => provenance.retract(dropSource, tx)),
      );
      expect(stale).toBeInstanceOf(StaleVersionError);
    });

    // Load-bearing: an evolved callback's transaction is read with the
    // evolved graph's registry. The evolution makes `ruling` a required part
    // of `drop-fact`, so retracting `drop-source` closes both. Revert check:
    // make the capability's transaction resolver return the store's original
    // scope for an evolved callback, and the transition leaves `ruling` live
    // under the closed fact, so `died` and `believed` both fail.
    it("retracts inside withEvolvedTransaction against the evolved graph and commits with the evolution", async () => {
      const backend = context.getBackend();
      const [adapterStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        backend,
        { history: true },
      );
      // No decision exists before the evolution: the composition it declares
      // would refuse a decision recorded under no fact.
      const keep = await createSource(adapterStore, keepSource.id);
      const drop = await createSource(adapterStore, dropSource.id);
      const keepNode = await createFact(adapterStore, keepFact.id);
      const dropNode = await createFact(adapterStore, dropFact.id);
      await createJustification(adapterStore, "keep-j", [keep], keepNode);
      await createJustification(adapterStore, "drop-j", [drop], dropNode);
      const provenance = createRetractionCapability(
        adapterStore,
        decisionFactConfig,
      );
      const plan = await adapterStore.planEvolution(recordedUnderExtension);
      if (plan.status !== "change") throw new Error("Expected change plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await expectUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            adapterStore.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }

      const ruling = ref("Decision", "ruling");
      const outcome = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          adapterStore.withEvolvedTransaction(nativeTx, plan, async (tx) => {
            // `ruling` holds through `keep-source` and is recorded under
            // `drop-fact`, which holds through `drop-source` alone.
            await tx.nodes.Decision.create(
              { label: ruling.id },
              // The original graph declares no composition for `Decision`, so
              // its typed options cannot name a whole; the evolved one does.
              { id: ruling.id, partOf: { whole: dropFact as never } },
            );
            await tx.nodes.Justification.create(
              { label: "ruling-j" },
              { id: "ruling-j" },
            );
            const rulingJustification = ref("Justification", "ruling-j");
            await tx.edges.premiseOf.create(
              keepSource,
              rulingJustification,
              {},
            );
            await tx.edges.derives.create(rulingJustification, ruling, {});
            const before = await provenance.holding(tx);
            const report = await provenance.retract(dropSource, tx);
            return {
              before,
              report,
              believed: await provenance.holding(tx),
            };
          }),
      );
      expect(sortedIds(outcome.result.before)).toEqual([
        "drop-fact",
        "keep-fact",
        "ruling",
      ]);
      expect(outcome.result.report.died).toEqual([ruling, dropFact]);
      expect(sortedIds(outcome.result.believed)).toEqual(["keep-fact"]);
      await expect(
        backend.getActiveSchema(adapterStore.graphId),
      ).resolves.toEqual(
        expect.objectContaining({ version: plan.result.version }),
      );
      await expect(sourceFlag(adapterStore, dropSource.id)).resolves.toBe(true);
      await expect(
        adapterStore.nodes.Decision.getById(
          asNodeId<typeof Decision>("ruling"),
        ),
      ).resolves.toBeUndefined();
    });

    // A caught failure keeps what the verb wrote before it failed: no
    // savepoint is taken, exactly as for any other call inside
    // `store.transaction()`.
    it("a caught failure keeps nothing when refused before the first write, and the writes before it otherwise", async () => {
      const store = await createHistoryStore(context);
      const provenance = await seedCallerWorld(store);

      const missing = await store.transaction(async (tx) => {
        const error = await captureRejection(
          provenance.retractMany([dropSource, ref("Source", "missing")], tx),
        );
        await tx.nodes.Decision.update(asNodeId<typeof Decision>("decision"), {
          label: "after-missing",
        });
        return error;
      });
      expect(missing).toBeInstanceOf(NodeNotFoundError);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);
      await expect(decisionLabel(store)).resolves.toBe("after-missing");

      // drop-fact's label is taken while it is closed, so reopening it fails
      // its uniqueness check after the source flag was cleared.
      await provenance.retract(dropSource);
      await createFact(store, "replacement", dropFact.id);
      const conflict = await store.transaction(async (tx) => {
        const error = await captureRejection(
          provenance.unRetract(dropSource, tx),
        );
        return { error, believed: await provenance.holding(tx) };
      });
      expect(String(conflict.error)).toContain("Uniqueness violation");
      expect(sortedIds(conflict.believed)).toEqual([
        "keep-fact",
        "shared-fact",
      ]);
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(false);
      await expect(
        store.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
      ).resolves.toBeUndefined();
    });

    /**
     * What survives when an adopted callback rejects and the native caller
     * catches the error and COMMITS instead of rolling back.
     *
     * This pins current, general behaviour of both adoption APIs, not of the
     * verbs: the adopted Store path flushes recorded-time capture only when
     * the callback resolves, so a rejected callback's writes reach the live
     * rows while recorded time never sees them. A retraction and an ordinary
     * node write behave alike. The documented contract is therefore that a
     * rejected adopted callback must be followed by a rollback of the native
     * transaction.
     */
    async function expectCommittedButUnrecorded(
      store: ProvenanceStore,
      expected: Readonly<{ retracted: boolean; label: string }>,
    ): Promise<void> {
      await expect(sourceFlag(store, dropSource.id)).resolves.toBe(
        expected.retracted,
      );
      await expect(decisionLabel(store)).resolves.toBe(expected.label);
      const liveFact = await store.nodes.Fact.getById(
        asNodeId<typeof Fact>(dropFact.id),
      );
      expect(liveFact === undefined).toBe(expected.retracted);
      // Recorded time still shows the state before the rejected callback.
      const recorded = store.asOfRecorded(
        requireDefined(await store.recordedNow()),
      );
      await expect(
        recorded.nodes.Source.getById(asNodeId<typeof Source>(dropSource.id)),
      ).resolves.toMatchObject({ retracted: false });
      await expect(decisionLabel(recorded)).resolves.toBe("decision");
      await expect(
        recorded.nodes.Fact.getById(asNodeId<typeof Fact>(dropFact.id)),
      ).resolves.toMatchObject({ id: dropFact.id });
    }

    const CALLBACK_FAILURE = "callback failed after its writes";

    // The ordinary-node-write row is a control, not a pin of the verbs: it
    // calls no retraction verb and passes without them, pinning issue #930's
    // current adopted-callback behaviour so the retraction row is read
    // against it. Only the retraction row needs `retract(source, tx)`.
    describe.each([
      ["an ordinary node write (control: #930's current behaviour)", false],
      ["a retraction", true],
    ] as const)(
      "withRecordedTransaction whose callback rejects after %s, caught and committed by the native caller",
      (_label, retract) => {
        it("commits the live write without recording it (pinned current behaviour)", async () => {
          const backend = context.getBackend();
          const [adapterStore] = await createAdapterStoreWithSchema(
            provenanceGraph,
            backend,
            { history: true },
          );
          const provenance = await seedCallerWorld(adapterStore);
          const recordedBefore = await adapterStore.recordedNow();

          const caught = await backend.transactionWithNative(
            async (_target, nativeTx) =>
              captureRejection(
                adapterStore.withRecordedTransaction(nativeTx, async (tx) => {
                  await (retract ?
                    provenance.retract(dropSource, tx)
                  : tx.nodes.Decision.update(
                      asNodeId<typeof Decision>("decision"),
                      { label: "withdrawn" },
                    ));
                  throw new Error(CALLBACK_FAILURE);
                }),
              ),
          );

          expect(String(caught)).toContain(CALLBACK_FAILURE);
          await expect(adapterStore.recordedNow()).resolves.toBe(
            recordedBefore,
          );
          await expectCommittedButUnrecorded(adapterStore, {
            retracted: retract,
            label: retract ? "decision" : "withdrawn",
          });
        });
      },
    );

    it("withEvolvedTransaction whose callback rejects after a retraction and a node write, caught and committed by the native caller, commits the evolution and the live writes without recording them (pinned current behaviour)", async () => {
      const backend = context.getBackend();
      const [adapterStore] = await createAdapterStoreWithSchema(
        provenanceGraph,
        backend,
        { history: true },
      );
      const provenance = await seedCallerWorld(adapterStore);
      const plan = await adapterStore.planEvolution(noteExtension);
      if (plan.status !== "change") throw new Error("Expected change plan.");
      if (backend.adoptSchemaWriteTransaction === undefined) {
        await expectUnsupportedAdoption(() =>
          backend.transactionWithNative(async (_target, nativeTx) =>
            adapterStore.withEvolvedTransaction(nativeTx, plan, async () => {
              await Promise.resolve();
            }),
          ),
        );
        return;
      }
      const recordedBefore = await adapterStore.recordedNow();

      const caught = await backend.transactionWithNative(
        async (_target, nativeTx) =>
          captureRejection(
            adapterStore.withEvolvedTransaction(nativeTx, plan, async (tx) => {
              await provenance.retract(dropSource, tx);
              await tx.nodes.Decision.update(
                asNodeId<typeof Decision>("decision"),
                { label: "withdrawn" },
              );
              throw new Error(CALLBACK_FAILURE);
            }),
          ),
      );

      expect(String(caught)).toContain(CALLBACK_FAILURE);
      await expect(
        backend.getActiveSchema(adapterStore.graphId),
      ).resolves.toEqual(
        expect.objectContaining({ version: plan.result.version }),
      );
      await expect(adapterStore.recordedNow()).resolves.toBe(recordedBefore);
      await expectCommittedButUnrecorded(adapterStore, {
        retracted: true,
        label: "withdrawn",
      });
    });
  });

  /**
   * A caught failure at any of a verb's writes leaves no fact live without
   * live support and no required part live under a closed whole. The verb
   * takes no savepoint (a TypeGraph-owned savepoint's rollback would undo
   * overlapping calls' writes), so a caller that catches the failure and
   * commits keeps the writes made before it. The verb orders them so every
   * prefix is safe: it closes the facts that lose their support first, each
   * required part before its whole, then flips the source flags, then reopens
   * the facts that regain it, each whole before its parts. A prefix can leave
   * a fact closed whose support stands (or a source flagged whose facts are
   * already closed), never a live fact with no support nor a required part
   * live under a closed whole, and re-running the verb completes it.
   *
   * The fixture runs with its fact kinds configured in both orders, so a
   * write order that followed the configured kind order would close a whole
   * before its part in one of them and reopen a part before its whole in the
   * other.
   *
   * Revert checks: flip the source flags before the close pass in
   * `transitionInTransaction` (`src/provenance/transition.ts`) and a
   * `retractMany` rejection after the first flag leaves a fact held only by
   * the flagged source live and unsupported; order the close and reopen
   * passes by configured kind instead of by composition depth and a
   * rejection between a whole's write and its part's leaves the part live
   * under a closed whole, which `verifyConstraintFences()` reports as
   * `compositionExistence`.
   */
  describe("provenance retraction: a failure caught at each of a verb's writes", () => {
    type CompositionStore = HistoryStore<typeof compositionGraph>;
    type CallerTransaction = Parameters<
      Parameters<CompositionStore["transaction"]>[0]
    >[0];

    const sourceOne = ref("Source", "source-one");
    const sourceTwo = ref("Source", "source-two");
    const sourceOther = ref("Source", "source-other");
    const REJECTED_WRITE = "rejected verb write";
    const report = (id: string) => ({ kind: "Report", id }) as const;
    const section = (id: string) => ({ kind: "Section", id }) as const;

    /**
     * Per source, a whole and the required part under it, both held by that
     * source; a whole held by either source; and one held by a third.
     */
    async function seedTwoSourceWorld(store: CompositionStore): Promise<void> {
      for (const { id } of [sourceOne, sourceTwo, sourceOther]) {
        await store.nodes.Source.create(
          { label: id, retracted: false },
          { id },
        );
      }
      for (const id of ["whole-one", "whole-two", "either", "unrelated"]) {
        await store.nodes.Report.create({ label: id }, { id });
      }
      for (const [id, whole] of [
        ["part-one", "whole-one"],
        ["part-two", "whole-two"],
      ] as const) {
        await store.nodes.Section.create(
          { label: id },
          { id, partOf: { whole: report(whole) } },
        );
      }
      const derive = async (
        justificationId: string,
        premises: readonly Readonly<{ kind: "Source"; id: string }>[],
        derived: Readonly<{ kind: "Report" | "Section"; id: string }>,
      ) => {
        await store.nodes.Justification.create(
          { label: justificationId },
          { id: justificationId },
        );
        for (const premise of premises) {
          await store.edges.premiseOf.create(
            premise,
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
      await derive("whole-one-j", [sourceOne], report("whole-one"));
      await derive("part-one-j", [sourceOne], section("part-one"));
      await derive("whole-two-j", [sourceTwo], report("whole-two"));
      await derive("part-two-j", [sourceTwo], section("part-two"));
      await derive("either-one-j", [sourceOne], report("either"));
      await derive("either-two-j", [sourceTwo], report("either"));
      await derive("unrelated-j", [sourceOther], report("unrelated"));
    }

    function capabilityFor(
      store: CompositionStore,
      factKinds: readonly ("Report" | "Section")[],
    ) {
      return createRetractionCapability(store, {
        ...config,
        fact: { kinds: factKinds },
      });
    }

    type Capability = ReturnType<typeof capabilityFor>;

    const ALL_FACTS = [
      "either",
      "part-one",
      "part-two",
      "unrelated",
      "whole-one",
      "whole-two",
    ];

    const VERBS = [
      {
        name: "retract",
        prepare: (_provenance: Capability) => Promise.resolve(),
        run: (provenance: Capability, tx?: CallerTransaction) =>
          provenance.retract(sourceOne, tx),
        // Two fact closes and one source flag.
        writes: 3,
        believedAfter: ["either", "part-two", "unrelated", "whole-two"],
      },
      {
        name: "retractMany",
        prepare: (_provenance: Capability) => Promise.resolve(),
        run: (provenance: Capability, tx?: CallerTransaction) =>
          provenance.retractMany([sourceOne, sourceTwo], tx),
        // Five fact closes and two source flags.
        writes: 7,
        believedAfter: ["unrelated"],
      },
      {
        name: "unRetract",
        prepare: (provenance: Capability) => provenance.retract(sourceOne),
        run: (provenance: Capability, tx?: CallerTransaction) =>
          provenance.unRetract(sourceOne, tx),
        // One source flag and two fact reopens.
        writes: 3,
        believedAfter: ALL_FACTS,
      },
      {
        name: "unRetractMany",
        prepare: (provenance: Capability) =>
          provenance.retractMany([sourceOne, sourceTwo]),
        run: (provenance: Capability, tx?: CallerTransaction) =>
          provenance.unRetractMany([sourceOne, sourceTwo], tx),
        // Two source flags and five fact reopens.
        writes: 7,
        believedAfter: ALL_FACTS,
      },
    ] as const;

    const KIND_ORDERS = [
      { order: "whole kind first", factKinds: ["Report", "Section"] },
      { order: "part kind first", factKinds: ["Section", "Report"] },
    ] as const;

    const CASES = KIND_ORDERS.flatMap(({ order, factKinds }) =>
      VERBS.flatMap((verb) =>
        Array.from({ length: verb.writes }, (_unused, position) => ({
          order,
          factKinds,
          verb,
          position,
        })),
      ),
    );

    async function liveFactIds(store: CompositionStore): Promise<string[]> {
      return sortedIds([
        ...(await store.nodes.Report.find()),
        ...(await store.nodes.Section.find()),
      ]);
    }

    it.each(CASES)(
      "$verb.name ($order) rejected at write $position, caught and committed, leaves no live fact without support and no constraint violation, and re-running it completes it",
      async ({ factKinds, verb, position }) => {
        const armed = { on: false, started: 0 };
        const [store] = await createAdapterStoreWithSchema(
          compositionGraph,
          context.getBackend(),
          {
            history: true,
            hooks: {
              onOperationStart: () => {
                if (!armed.on) return;
                armed.started += 1;
                if (armed.started === position + 1) {
                  throw new Error(REJECTED_WRITE);
                }
              },
            },
          },
        );
        await seedTwoSourceWorld(store);
        const provenance = capabilityFor(store, factKinds);
        await verb.prepare(provenance);

        const caught = await store.transaction(async (tx) => {
          armed.on = true;
          try {
            return await captureRejection(verb.run(provenance, tx));
          } finally {
            armed.on = false;
          }
        });

        expect(String(caught)).toContain(REJECTED_WRITE);
        expect(armed.started).toBe(position + 1);
        const live = await liveFactIds(store);
        const believed = sortedIds(await provenance.holding());
        expect(
          live.filter((id) => !believed.includes(id)),
          "live facts without live support",
        ).toEqual([]);
        expect(await store.verifyConstraintFences()).toEqual([]);

        await verb.run(provenance);
        expect(sortedIds(await provenance.holding())).toEqual(
          verb.believedAfter,
        );
        expect(await liveFactIds(store)).toEqual(verb.believedAfter);
        expect(await store.verifyConstraintFences()).toEqual([]);
      },
    );

    it.each(
      KIND_ORDERS.flatMap(({ order, factKinds }) =>
        VERBS.map((verb) => ({ order, factKinds, verb })),
      ),
    )(
      "$verb.name ($order) with no rejection makes exactly the writes the positions above cover (control)",
      async ({ factKinds, verb }) => {
        const armed = { on: false, started: 0 };
        const [store] = await createAdapterStoreWithSchema(
          compositionGraph,
          context.getBackend(),
          {
            history: true,
            hooks: {
              onOperationStart: () => {
                if (armed.on) armed.started += 1;
              },
            },
          },
        );
        await seedTwoSourceWorld(store);
        const provenance = capabilityFor(store, factKinds);
        await verb.prepare(provenance);

        await store.transaction(async (tx) => {
          armed.on = true;
          try {
            await verb.run(provenance, tx);
          } finally {
            armed.on = false;
          }
        });

        expect(armed.started).toBe(verb.writes);
        expect(sortedIds(await provenance.holding())).toEqual(
          verb.believedAfter,
        );
        expect(await liveFactIds(store)).toEqual(verb.believedAfter);
        expect(await store.verifyConstraintFences()).toEqual([]);
      },
    );

    // A caught failure can leave a whole closed while the support it needs
    // stands (the safe prefix above). A later verb that reaches only a
    // required part of that whole, through a source of the part's own, must
    // not reopen the part while its whole stays closed: that would be a
    // required part live under a closed whole. The part stays closed until
    // the whole reopens; re-running the interrupted verb reopens both.
    // Revert check: drop the closed-whole filter from `reopenFacts`
    // (`src/provenance/transition.ts`) and `unRetract(sourceOther)` reopens
    // `part-one` under the closed `whole-one`, which
    // `verifyConstraintFences()` reports as `compositionExistence`.
    it.each(KIND_ORDERS)(
      "($order) a later verb reaching only a required part leaves it closed while a caught failure keeps its whole closed, and re-running the interrupted verb reopens both",
      async ({ factKinds }) => {
        const armed = { on: false, started: 0 };
        const [store] = await createAdapterStoreWithSchema(
          compositionGraph,
          context.getBackend(),
          {
            history: true,
            hooks: {
              onOperationStart: () => {
                if (!armed.on) return;
                armed.started += 1;
                // Write 0 restores `sourceOne`; write 1 reopens its whole.
                if (armed.started === 2) throw new Error(REJECTED_WRITE);
              },
            },
          },
        );
        await seedTwoSourceWorld(store);
        // `part-one` also holds through `sourceOther`, on its own.
        await store.nodes.Justification.create(
          { label: "part-one-other-j" },
          { id: "part-one-other-j" },
        );
        await store.edges.premiseOf.create(
          sourceOther,
          { kind: "Justification", id: "part-one-other-j" },
          {},
        );
        await store.edges.derives.create(
          { kind: "Justification", id: "part-one-other-j" },
          section("part-one"),
          {},
        );
        const provenance = capabilityFor(store, factKinds);
        await provenance.retractMany([sourceOne, sourceOther]);

        const caught = await store.transaction(async (tx) => {
          armed.on = true;
          try {
            return await captureRejection(provenance.unRetract(sourceOne, tx));
          } finally {
            armed.on = false;
          }
        });
        expect(String(caught)).toContain(REJECTED_WRITE);
        expect(await liveFactIds(store)).not.toContain("whole-one");

        await provenance.unRetract(sourceOther);
        const live = await liveFactIds(store);
        expect(live).not.toContain("part-one");
        expect(await store.verifyConstraintFences()).toEqual([]);

        await provenance.unRetract(sourceOne);
        expect(await liveFactIds(store)).toEqual(ALL_FACTS);
        expect(await store.verifyConstraintFences()).toEqual([]);
      },
    );

    // A caught failure can also land between a whole's reopen and its
    // required part's. The whole is then live and supported, so a re-run
    // reaches it with nothing to change; the part, held through a source of
    // its own and reached only through that whole, must still come into the
    // re-run's scope, or re-running the interrupted verb leaves it closed
    // while its support stands.
    // Revert check: in `computeAffectedFactKeys` (`src/provenance/support.ts`)
    // carry a whole's parts only when the whole itself moves, and the re-run
    // leaves `part-one` closed.
    it.each(KIND_ORDERS)(
      "($order) re-running a verb interrupted between a whole's reopen and its required part's reopens the part, though the whole is already live",
      async ({ factKinds }) => {
        const armed = { on: false, started: 0 };
        const [store] = await createAdapterStoreWithSchema(
          compositionGraph,
          context.getBackend(),
          {
            history: true,
            hooks: {
              onOperationStart: () => {
                if (!armed.on) return;
                armed.started += 1;
                // Write 0 restores `sourceOne`, write 1 reopens `whole-one`
                // (`either` stays live through `sourceTwo`); write 2 would
                // reopen `part-one`.
                if (armed.started === 3) throw new Error(REJECTED_WRITE);
              },
            },
          },
        );
        await seedTwoSourceWorld(store);
        // `part-one` holds only through `sourceOther` (and its whole), so
        // `sourceOne` reaches it only through `whole-one`.
        const [ownPremise] = await store.edges.premiseOf.find({
          from: sourceOne,
          to: { kind: "Justification", id: "part-one-j" },
        });
        await store.edges.premiseOf.hardDelete(requireDefined(ownPremise).id);
        await store.edges.premiseOf.create(
          sourceOther,
          { kind: "Justification", id: "part-one-j" },
          {},
        );
        const provenance = capabilityFor(store, factKinds);
        await provenance.retract(sourceOne);
        expect(await liveFactIds(store)).not.toContain("part-one");

        const caught = await store.transaction(async (tx) => {
          armed.on = true;
          try {
            return await captureRejection(provenance.unRetract(sourceOne, tx));
          } finally {
            armed.on = false;
          }
        });
        expect(String(caught)).toContain(REJECTED_WRITE);
        const interrupted = await liveFactIds(store);
        expect(interrupted).toContain("whole-one");
        expect(interrupted).not.toContain("part-one");
        expect(await store.verifyConstraintFences()).toEqual([]);

        await provenance.unRetract(sourceOne);
        expect(await liveFactIds(store)).toEqual(ALL_FACTS);
        expect(sortedIds(await provenance.holding())).toEqual(ALL_FACTS);
        expect(await store.verifyConstraintFences()).toEqual([]);
      },
    );
  });
}
