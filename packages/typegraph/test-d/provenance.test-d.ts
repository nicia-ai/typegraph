import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Store,
} from "..";
import type { AdapterHistoryStore } from "../dist/store-entry";
import {
  createRetractionCapability,
  FactNotHoldingError,
  type FactNotHoldingFailure,
  type FactNotHoldingJustification,
  type FactNotHoldingPremise,
  type FactNotHoldingPremiseReason,
  type FactNotHoldingReason,
  type ProvenanceFactInput,
  type ProvenanceFactRef,
  type ProvenanceNodeRef,
  type RetractionCapability,
  type RetractionReport,
  type SurvivedVia,
} from "../dist/provenance";

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

const graph = defineGraph({
  id: "provenance_types",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
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

const terminalGraph = defineGraph({
  id: "provenance_terminal_fact_types",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
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

const terminalConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact", "Decision"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

declare const backend: GraphBackend;
declare const historyStore: AdapterHistoryStore<typeof graph, never>;
declare const terminalHistoryStore: AdapterHistoryStore<
  typeof terminalGraph,
  never
>;
declare const sourceId: string;

const liveStore: Store<typeof graph> = createStore(graph, backend);

expectType<
  RetractionCapability<typeof graph, "Source", "Fact", "Justification">
>(createRetractionCapability(historyStore, config));
expectError(createRetractionCapability(liveStore, config));

const provenance = createRetractionCapability(historyStore, config);
expectType<Promise<RetractionReport<typeof graph, "Fact", "Justification">>>(
  provenance.retract({ kind: "Source", id: sourceId }),
);
expectType<Promise<RetractionReport<typeof graph, "Fact", "Justification">>>(
  provenance.unRetract({ kind: "Source", id: sourceId }),
);
expectType<Promise<RetractionReport<typeof graph, "Fact", "Justification">>>(
  provenance.retractMany([{ kind: "Source", id: sourceId }]),
);
expectType<Promise<RetractionReport<typeof graph, "Fact", "Justification">>>(
  provenance.unRetractMany([{ kind: "Source", id: sourceId }]),
);
expectType<Promise<readonly ProvenanceFactRef<typeof graph, "Fact">[]>>(
  provenance.holding(),
);

expectError(provenance.retract({ kind: "Missing", id: sourceId }));
expectError(provenance.retract({ kind: "Fact", id: sourceId }));
expectError(
  createRetractionCapability(historyStore, {
    ...config,
    source: { kind: "Missing" },
  }),
);

expectAssignable<ProvenanceNodeRef<typeof graph>>({
  kind: "Source",
  id: sourceId,
});
expectAssignable<ProvenanceNodeRef<typeof graph, "Source">>({
  kind: "Source",
  id: sourceId,
});
expectError<ProvenanceNodeRef<typeof graph, "Source">>({
  kind: "Fact",
  id: sourceId,
});
expectError<ProvenanceNodeRef<typeof graph>>({
  kind: "Missing",
  id: sourceId,
});

const terminalProvenance = createRetractionCapability(
  terminalHistoryStore,
  terminalConfig,
);
expectType<
  Promise<
    RetractionReport<typeof terminalGraph, "Fact" | "Decision", "Justification">
  >
>(terminalProvenance.retract({ kind: "Source", id: sourceId }));
expectType<
  Promise<
    readonly ProvenanceFactRef<typeof terminalGraph, "Fact" | "Decision">[]
  >
>(terminalProvenance.holding());

// assertHolds: facts are restricted to the configured fact kinds, and the
// result narrows fact and justification kinds from the configuration.
void liveStore.transaction(async (tx) => {
  expectType<
    Promise<readonly SurvivedVia<typeof graph, "Fact", "Justification">[]>
  >(provenance.assertHolds(tx, [{ kind: "Fact", id: sourceId }]));
  expectType<
    Promise<readonly SurvivedVia<typeof graph, "Fact", "Justification">[]>
  >(provenance.assertHolds(tx, []));
  expectType<Promise<readonly ProvenanceFactRef<typeof graph, "Fact">[]>>(
    provenance.holding(tx),
  );
  expectType<Promise<readonly ProvenanceFactRef<typeof graph, "Fact">[]>>(
    provenance.holding(),
  );

  const created = await tx.nodes.Fact.create({ label: "derived" });
  expectAssignable<ProvenanceFactInput<typeof graph, "Fact">>(created);
  await provenance.assertHolds(tx, [created]);

  const [held] = await provenance.assertHolds(tx, [created]);
  expectType<"Fact" | undefined>(held?.fact.kind);
  expectType<"Justification" | undefined>(held?.via[0]?.kind);
  expectType<ProvenanceFactRef<typeof graph, "Fact"> | undefined>(held?.fact);

  expectError(provenance.assertHolds(tx, [{ kind: "Source", id: sourceId }]));
  expectError(
    provenance.assertHolds(tx, [{ kind: "Justification", id: sourceId }]),
  );
  expectError(provenance.assertHolds(tx, [{ kind: "Missing", id: sourceId }]));
  expectError(provenance.assertHolds(tx, [sourceId]));
  expectError(provenance.assertHolds([{ kind: "Fact", id: sourceId }]));
  expectError(
    provenance.assertHolds(liveStore, [{ kind: "Fact", id: sourceId }]),
  );
  expectError(provenance.holding(liveStore));
});

const terminalStore: Store<typeof terminalGraph> = createStore(
  terminalGraph,
  backend,
);
void terminalStore.transaction(async (tx) => {
  expectType<
    Promise<
      readonly SurvivedVia<
        typeof terminalGraph,
        "Fact" | "Decision",
        "Justification"
      >[]
    >
  >(
    terminalProvenance.assertHolds(tx, [
      { kind: "Fact", id: sourceId },
      { kind: "Decision", id: sourceId },
    ]),
  );
  expectError(
    terminalProvenance.assertHolds(tx, [{ kind: "Source", id: sourceId }]),
  );
  // A transaction of another graph's store is not accepted.
  expectError(provenance.assertHolds(tx, [{ kind: "Fact", id: sourceId }]));
});

// FactNotHoldingError exposes the exact failure and reason unions.
declare const notHolding: FactNotHoldingError;
expectType<readonly FactNotHoldingFailure[]>(notHolding.failures);
expectType<string>(notHolding.failures[0]!.fact.id);
expectType<FactNotHoldingReason>(notHolding.failures[0]!.reason);
expectType<readonly FactNotHoldingJustification[]>(
  notHolding.failures[0]!.justifications,
);
expectType<readonly FactNotHoldingPremise[]>(
  notHolding.failures[0]!.justifications[0]!.premises,
);
expectType<FactNotHoldingPremiseReason>(
  notHolding.failures[0]!.justifications[0]!.premises[0]!.reason,
);

expectType<
  | "not-current"
  | "tombstoned"
  | "no-justification"
  | "no-firing-justification"
  | "composition-whole-unsupported"
>({} as FactNotHoldingReason);
expectType<"retracted" | "not-current" | "unsupported">(
  {} as FactNotHoldingPremiseReason,
);
expectError<FactNotHoldingReason>("unknown-reason");
expectError<FactNotHoldingPremiseReason>("tombstoned");
