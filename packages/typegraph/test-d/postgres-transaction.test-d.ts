import { drizzle } from "drizzle-orm/node-postgres";
import { expectError, expectType } from "tsd";
import { z } from "zod";

import {
  createAdapterStore,
  defineGraph,
  defineNode,
  type AdapterStore,
  type AdapterTransactionContext,
} from "..";
import {
  type AnyPgTransaction,
  createPostgresBackend,
} from "../dist/backend/postgres";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const graph = defineGraph({
  id: "postgres_transaction_type_test",
  nodes: { Person: { type: Person } },
  edges: {},
});

const db = drizzle.mock();
const store = createAdapterStore(graph, createPostgresBackend(db));

expectType<AdapterStore<typeof graph, AnyPgTransaction>>(store);
expectError(store.withTransaction(db));

void db.transaction(async (transaction) => {
  expectType<AdapterTransactionContext<typeof graph, AnyPgTransaction>>(
    store.withTransaction(transaction),
  );
});
