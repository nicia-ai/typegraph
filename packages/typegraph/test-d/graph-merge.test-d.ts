import { expectAssignable, expectType } from "tsd";
import { z } from "zod";

import { type GraphBackend, defineGraph, defineNode, type Store } from "..";
import {
  BranchError,
  type GraphBranch,
  type MakeBackend,
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
declare const branches: readonly GraphBranch<typeof graph>[];

const makeBackend: MakeBackend = () => Promise.resolve(backend);
const strategy = cloneWorkingCopyStrategy<typeof graph>(makeBackend);
expectAssignable<MakeBackend>(makeBackend);
expectAssignable<WorkingCopyStrategy<typeof graph>>(strategy);

const options: MergeOptions<typeof graph> = {
  resolve: {
    Patient: {
      block: () => "same-day",
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.85,
    },
  },
  reconcileTypes: "ontology",
  onPropertyConflict: "flag",
};

const normalized = normalizeMergeOptions(options);
expectType<ReconcileTypesMode>(normalized.reconcileTypes);

expectType<Promise<Result<GraphBranch<typeof graph>, BranchError>>>(
  branch(store, makeBackend),
);
expectType<Promise<Result<MergeReport<typeof graph>, MergeError>>>(
  merge(store, branches, options),
);

declare const mergeResult: Result<MergeReport<typeof graph>, MergeError>;
if (isOk(mergeResult)) {
  expectAssignable<MergeReport<typeof graph>>(mergeResult.data);
}
if (isErr(mergeResult)) {
  expectAssignable<MergeError>(mergeResult.error);
}
expectAssignable<MergeReport<typeof graph>>(unwrap(mergeResult));
