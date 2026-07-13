import { expectError, expectType } from "tsd";
import { z } from "zod";

import { defineGraph, defineNode, type Store } from "..";
import {
  exportGraphStream,
  type GraphInterchangeChunk,
  importGraphStream,
  type ImportResult,
} from "../dist/interchange";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "interchange_type_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

declare const store: Store<typeof graph>;

const stream = exportGraphStream(store, { batchSize: 100 });
expectType<AsyncIterable<GraphInterchangeChunk>>(stream);
expectError(exportGraphStream(store, { batchSize: "100" }));

expectType<Promise<ImportResult>>(
  importGraphStream(store, stream, { onConflict: "error" }),
);
