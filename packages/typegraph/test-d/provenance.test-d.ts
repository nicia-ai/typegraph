import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type HistoryStore,
  type Store,
} from "..";
import {
  createRetractionCapability,
  type ProvenanceFactRef,
  type ProvenanceNodeRef,
  type RetractionCapability,
  type RetractionReport,
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
declare const historyStore: HistoryStore<typeof graph>;
declare const terminalHistoryStore: HistoryStore<typeof terminalGraph>;
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
