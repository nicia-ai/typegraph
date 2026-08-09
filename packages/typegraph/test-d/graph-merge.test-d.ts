import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type AdapterHistoryStore,
  type GraphBackend,
  defineGraph,
  defineNode,
  type Store,
} from "..";
import {
  applyMergePlan,
  BranchError,
  type CandidateDiagnostics,
  type EntityResolution,
  type GraphBranch,
  type MakeBackend,
  type MatchEvidence,
  type MergePlanArtifact,
  type MergeOptions,
  MergeError,
  type MergeReport,
  type ReconcileTypesMode,
  type Result,
  type WorkingCopyStrategy,
  branch,
  cloneWorkingCopyStrategy,
  isErr,
  isOk,
  merge,
  normalizeMergeOptions,
  openProvenanceStore,
  planMerge,
  planMergeIncremental,
  type ProvenanceGraph,
  unwrap,
} from "../dist/graph-merge";

const Person = defineNode("Person", {
  schema: z.object({
    birthDate: z.string(),
    name: z.string(),
  }),
});

const graph = defineGraph({
  id: "graph_merge_typetest",
  nodes: { Person: { type: Person } },
  edges: {},
});

declare const backend: GraphBackend;
declare const store: Store<typeof graph>;
declare const adapterHistoryStore: AdapterHistoryStore<typeof graph, unknown>;
declare const branches: readonly GraphBranch<typeof graph>[];

const makeBackend: MakeBackend = () => Promise.resolve(backend);
const strategy = cloneWorkingCopyStrategy<typeof graph>(makeBackend);
expectAssignable<MakeBackend>(makeBackend);
expectAssignable<WorkingCopyStrategy<typeof graph>>(strategy);

const options: MergeOptions<typeof graph> = {
  resolve: {
    Person: {
      block: () => "same-day",
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.85,
    },
  },
  reconcileTypes: "ontology",
  onPropertyConflict: "flag",
  candidateDiagnostics: { limit: 100 },
};

// A resolve key that is not a node kind of `graph` is a COMPILE error, not a
// silently-ignored config that would let those nodes merge by id only (#6 / B2).
expectError<MergeOptions<typeof graph>>({
  resolve: {
    Patient: {
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.85,
    },
  },
});
expectError<MergeOptions<typeof graph>>({ candidateDiagnostics: {} });

const normalized = normalizeMergeOptions(options);
expectType<ReconcileTypesMode>(normalized.reconcileTypes);

expectType<Promise<Result<GraphBranch<typeof graph>, BranchError>>>(
  branch(store, makeBackend),
);
expectType<Promise<Result<MergeReport<typeof graph>, MergeError>>>(
  merge(store, branches, options),
);
expectType<Promise<Result<MergePlanArtifact, MergeError>>>(
  planMerge(store, branches, options),
);
expectType<Promise<Result<MergePlanArtifact, MergeError>>>(
  planMergeIncremental({
    forkPoint: store,
    target: store,
    branches,
    options,
  }),
);

declare const mergePlan: MergePlanArtifact;
expectType<Promise<Result<MergeReport<typeof graph>, MergeError>>>(
  applyMergePlan(store, mergePlan),
);
expectError(applyMergePlan(store, {} as unknown));
expectError((mergePlan.digest = "tampered"));

declare const resolution: EntityResolution;
expectType<readonly MatchEvidence[]>(resolution.decisiveEdges);
declare const evidence: MatchEvidence;
if (evidence.decision === "scored") {
  expectType<number>(evidence.score);
  expectType<number>(evidence.threshold);
} else {
  expectError(evidence.score);
}

declare const diagnostics: CandidateDiagnostics;
expectType<number>(diagnostics.total);
expectType<number>(diagnostics.limit);
expectType<boolean>(diagnostics.truncated);
expectType<"accepted" | "rejected">(diagnostics.entries[0]!.scoreDecision);
expectType<Promise<Store<ProvenanceGraph>>>(openProvenanceStore(store));
expectType<Promise<Store<ProvenanceGraph>>>(
  openProvenanceStore(adapterHistoryStore),
);
expectType<Promise<Store<ProvenanceGraph>>>(
  openProvenanceStore(backend, graph.id),
);

declare const mergeResult: Result<MergeReport<typeof graph>, MergeError>;
if (isOk(mergeResult)) {
  expectAssignable<MergeReport<typeof graph>>(mergeResult.data);
}
if (isErr(mergeResult)) {
  expectAssignable<MergeError>(mergeResult.error);
}
expectAssignable<MergeReport<typeof graph>>(unwrap(mergeResult));
