import { expectAssignable, expectError, expectType } from "tsd";
import { z } from "zod";

import {
  type AdapterHistoryStore,
  type GraphBackend,
  defineGraph,
  defineEdge,
  defineNode,
  type Store,
  type TransactionContext,
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
  type MergePlanApplyOptions,
  type MergePlanApplied,
  type MergePlanReadContext,
  type MergeOptions,
  MergeConstraintConflictError,
  type MergeConstraintConflictErrorDetails,
  MergeError,
  type MergeReport,
  type MergeReviewArtifact,
  type MergeReviewRevalidation,
  MergeReviewError,
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
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
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

declare const constraintConflict: MergeConstraintConflictError;
expectAssignable<MergeError>(constraintConflict);
expectType<"GRAPH_MERGE_CONSTRAINT_CONFLICT">(constraintConflict.code);
expectType<"constraint">(constraintConflict.category);
expectType<MergeConstraintConflictErrorDetails>(constraintConflict.details);
expectType<string>(constraintConflict.details.constraintCode);

const reviewPolicy = { id: "review-v1", context: {} } as const;
expectType<Promise<Result<MergeReviewArtifact, MergeError>>>(
  planCandidateWriteSetReview({
    target: store,
    makeBackend,
    writeSet: {} as unknown,
    policy: reviewPolicy,
  }),
);
expectType<Promise<Result<MergeReviewRevalidation, MergeError>>>(
  revalidateCandidateWriteSetReview({
    target: store,
    makeBackend,
    review: {} as unknown,
    policy: reviewPolicy,
  }),
);
expectError(
  planCandidateWriteSetReview({ target: store, makeBackend, writeSet: {} }),
);
declare const reviewed: MergeReviewArtifact;
expectError((reviewed.digest = mergePlan.digest));
expectError(
  reviewed.baseline.rows.push({ role: "node", kind: "Person", id: "x" }),
);
declare const revalidation: MergeReviewRevalidation;
if (revalidation.status === "compatible") {
  expectType<MergePlanArtifact>(revalidation.plan);
} else {
  expectType<MergePlanArtifact | undefined>(revalidation.plan);
}
declare const reviewError: MergeReviewError;
expectAssignable<MergeError>(reviewError);
expectType<"GRAPH_MERGE_REVIEW">(reviewError.code);
// Merge callbacks remain graph-specific and cannot expose an unfenced writer.
const applyOptions: MergePlanApplyOptions<typeof graph> = {
  beforeApply: async (reads) => {
    expectType<MergePlanReadContext<typeof graph>>(reads);
    await reads.nodes.Person.count();
    expectError(reads.nodes.Person.create({ birthDate: "2000", name: "Ada" }));
    expectError(reads.nodes.Person.update);
    expectError(reads.nodes.Person.delete);
    expectError(reads.backend);
    expectError(reads.transaction);
    expectError(reads.getNodeCollection);
    expectError(reads.identity);
    expectError(reads.nodes.Unknown);
  },
  afterApply: async (tx, applied) => {
    expectType<TransactionContext<typeof graph>>(tx);
    expectType<MergePlanApplied>(applied);
    expectType<number>(applied.merged.nodes);
    await tx.nodes.Person.create({ birthDate: "2000", name: "Ada" });
    expectError(tx.nodes.Person.create({ name: "Missing birth date" }));
    expectError(tx.nodes.Unknown);
    expectError(applied.provenance);
    expectError((applied.merged.nodes = 2));
  },
};
expectType<Promise<Result<MergeReport<typeof graph>, MergeError>>>(
  applyMergePlan(store, mergePlan, applyOptions),
);
expectError(
  applyMergePlan(store, mergePlan, {
    beforeApply: async () => ({ success: false, error: new Error("refused") }),
  }),
);
expectError(
  applyMergePlan(store, mergePlan, {
    afterApply: async () => ({ success: false, error: new Error("refused") }),
  }),
);
expectError(applyMergePlan(store, mergePlan, { beforeApply: () => {} }));
declare const transaction: TransactionContext<typeof graph>;
expectError(applyMergePlan(transaction, mergePlan));

const related = defineEdge("related", { schema: z.object({}) });
const identityGraph = defineGraph({
  id: "merge_callbacks_identity_typetest",
  nodes: { Person: { type: Person } },
  edges: { related: { type: related, from: [Person], to: [Person] } },
  identity: { sameIdAcrossKinds: "ignore" },
});
declare const identityStore: Store<typeof identityGraph>;
applyMergePlan(identityStore, mergePlan, {
  beforeApply: async (reads) => {
    await reads.edges.related.count();
    expectError(reads.edges.related.create);
    expectError(reads.identity.assertSame);
    expectError(reads.identity.retractAssertion);
    const people = await reads.nodes.Person.find();
    if (people[0] !== undefined) {
      expectType<boolean>(await reads.identity.areSame(people[0], people[0]));
    }
  },
  afterApply: async (tx) => {
    const first = await tx.nodes.Person.create({
      name: "First",
      birthDate: "2000",
    });
    const second = await tx.nodes.Person.create({
      name: "Second",
      birthDate: "2001",
    });
    await tx.edges.related.create(first, second, {});
    await tx.identity.assertSame(first, second);
  },
});
