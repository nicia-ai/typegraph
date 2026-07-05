import { expectAssignable, expectNotAssignable, expectType } from "tsd";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineNode,
  type EdgeId,
  type NodeId,
} from "..";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const worksAt = defineEdge("worksAt", {
  schema: z.object({ role: z.string() }),
});

const knows = defineEdge("knows", {
  schema: z.object({ since: z.string() }),
});

expectType<NodeId<typeof Person>>(asNodeId<typeof Person>("person-1"));
expectType<EdgeId<typeof worksAt>>(asEdgeId<typeof worksAt>("edge-1"));

expectAssignable<string>(asNodeId<typeof Person>("person-1"));
expectAssignable<string>(asEdgeId<typeof worksAt>("edge-1"));

expectNotAssignable<NodeId<typeof Person>>("person-1");
expectNotAssignable<EdgeId<typeof worksAt>>("edge-1");

expectNotAssignable<NodeId<typeof Company>>(
  asNodeId<typeof Person>("person-1"),
);
expectNotAssignable<EdgeId<typeof knows>>(asEdgeId<typeof worksAt>("edge-1"));
