/**
 * `nextFrom` is a transition-log cursor, not a recorded-time anchor.
 * Passing it to `asOfRecorded` must fail to compile.
 */
import { expectError, expectNotAssignable } from "tsd";
import { z } from "zod";

import {
  type RecordedInstant,
  type Store,
  type TransitionPageCursor,
  defineGraph,
  defineNode,
} from "..";

const graph = defineGraph({
  id: "cursor",
  nodes: { Person: { type: defineNode("Person", { schema: z.object({}) }) } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

declare const store: Store<typeof graph>;
declare const cursor: TransitionPageCursor;
declare const recorded: RecordedInstant;

expectNotAssignable<RecordedInstant>(cursor);
expectError(store.asOfRecorded(cursor));

store.identity.transitionsOf(
  { kind: "Person", id: "ada" },
  { fromRecorded: cursor },
);
store.identity.transitionsOf(
  { kind: "Person", id: "ada" },
  { fromRecorded: recorded },
);
