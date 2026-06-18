/**
 * Type-level contract for the {@link RecordedInstant} brand.
 *
 * The brand exists to turn a real footgun — passing a raw wall-clock string to
 * `store.asOfRecorded`, which can silently omit the most recent same-millisecond
 * commits because the recorded clock is a monotonic logical instant that runs
 * briefly ahead of wall time — into a compile error. This test pins that
 * protection: `asOfRecorded` accepts only a `RecordedInstant`, the brand can
 * originate only from `recordedNow()` / `asRecordedInstant(...)`, and a plain
 * string is rejected at the call site.
 */
import {
  expectAssignable,
  expectError,
  expectNotAssignable,
  expectType,
} from "tsd";
import { z } from "zod";

import {
  asRecordedInstant,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedInstant,
  type RecordedStoreView,
  type Store,
  type StoreView,
} from "..";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });

const graph = defineGraph({
  id: "recorded_instant_types",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

declare const store: Store<typeof graph>;
declare const view: StoreView<typeof graph>;

const CANONICAL = "2026-01-01T00:00:00.000Z";

// `recordedNow()` yields the branded instant (or undefined before first write).
expectType<Promise<RecordedInstant | undefined>>(store.recordedNow());

// `asRecordedInstant` is the escape hatch that brands a plain string.
expectType<RecordedInstant>(asRecordedInstant(CANONICAL));

// A `RecordedInstant` IS a string (so it round-trips through untyped storage),
// but a plain string is NOT a `RecordedInstant` (so the brand can't be forged).
expectAssignable<string>(asRecordedInstant(CANONICAL));
expectNotAssignable<RecordedInstant>(CANONICAL);
expectNotAssignable<RecordedInstant>("2026-01-01T00:00:00.000Z");

// The footgun is a compile error: a raw wall-clock / literal string is rejected.
expectError(store.asOfRecorded(CANONICAL));
expectError(store.asOfRecorded(new Date().toISOString()));
expectError(view.asOfRecorded(CANONICAL));

// The sanctioned anchors compile and resolve to the narrow recorded view.
declare const anchor: RecordedInstant;
expectType<RecordedStoreView<typeof graph>>(store.asOfRecorded(anchor));
expectType<RecordedStoreView<typeof graph>>(
  store.asOfRecorded(asRecordedInstant(CANONICAL)),
);
expectType<RecordedStoreView<typeof graph>>(view.asOfRecorded(anchor));
