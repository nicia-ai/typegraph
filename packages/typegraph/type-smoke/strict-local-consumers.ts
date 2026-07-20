import {
  type EdgeId as CoreEdgeId,
  type GraphDef as CoreGraphDef,
  type NodeId as CoreNodeId,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph/core";
import {
  type FulltextStrategy,
  fts5Strategy,
  type InsertNodeParams,
  type NodeRow,
  sql as backendSql,
  type SqlIdentifierChunk,
  type SqlParameterChunk,
  type SqlPlaceholderChunk,
  type SqlTag,
  type SqlTextChunk,
  type TransactionOptions as BackendTransactionOptions,
} from "@nicia-ai/typegraph/backend";
import {
  type EdgeId as RootEdgeId,
  type GraphDef as RootGraphDef,
  type NodeId as RootNodeId,
  type AdapterStore,
  type AdapterBackend,
  type AdapterHistoryStore,
  type AdapterRecordedReadStore,
  type BackendCapabilities,
  type GraphBackend,
  type GraphExtension,
  type HistoryStore,
  type LiveStoreOptions,
  type RecordedReadStore,
  type Store,
  type StoreOptions,
  type StoreRef,
  type TransactionOptions,
  StoreView,
  createAdapterStore,
  createStore,
  createSqlSchema,
  recordedRelation,
} from "@nicia-ai/typegraph";
import { createLocalPgliteStore } from "@nicia-ai/typegraph/postgres/pglite";
import { createLocalSqliteStore } from "@nicia-ai/typegraph/sqlite/local";
import { defineGraphExtension } from "@nicia-ai/typegraph/graph-extension";
import { branch } from "@nicia-ai/typegraph/graph-merge";
import { exportGraph } from "@nicia-ai/typegraph/interchange";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { QueryProfiler } from "@nicia-ai/typegraph/profiler";
import { createRetractionCapability } from "@nicia-ai/typegraph/provenance";
import { serializeSchema } from "@nicia-ai/typegraph/schema";
import { z } from "zod";

void branch;
void createRetractionCapability;
void defineGraphExtension;
void exportGraph;
void QueryProfiler;
void serializeSchema;

const backendSqlTag: SqlTag = backendSql;
const chunkVocabulary: readonly (
  SqlIdentifierChunk | SqlParameterChunk | SqlPlaceholderChunk | SqlTextChunk
)[] = backendSql`SELECT ${true}`.chunks;
const builtInStrategy: FulltextStrategy = fts5Strategy;
const backendNodeParams: InsertNodeParams = {
  graphId: "strict-local-consumers",
  id: "fact-1",
  kind: "Fact",
  props: { statement: "typed" },
};
const backendNodeRow: NodeRow = {
  created_at: "2026-01-01T00:00:00.000Z",
  deleted_at: undefined,
  graph_id: "strict-local-consumers",
  id: "fact-1",
  kind: "Fact",
  props: { statement: "typed" },
  updated_at: "2026-01-01T00:00:00.000Z",
  valid_from: undefined,
  valid_to: undefined,
  version: 1,
};
const publicTransactionOptions: BackendTransactionOptions = {
  accessMode: "read_only",
};
const rootTransactionOptions: TransactionOptions = publicTransactionOptions;
if (false) {
  const privilegedOptions: BackendTransactionOptions = {
    // @ts-expect-error Internal temporary-write capabilities are not public transaction options.
    temporaryWrites: Symbol("not-a-capability"),
  };
  void privilegedOptions;
}
void backendNodeParams;
void backendNodeRow;
void backendSqlTag;
void rootTransactionOptions;
void builtInStrategy;
void chunkVocabulary;
void publicTransactionOptions;

const Fact = defineNode("Fact", {
  schema: z.object({ statement: z.string() }),
});

const Source = defineNode("Source", {
  schema: z.object({ url: z.url() }),
});

const supports = defineEdge("supports", {
  schema: z.object({ confidence: z.number().min(0).max(1) }),
});

// Pull the portable indexes entrypoint into the packed TypeScript program. Its
// declaration graph must remain Drizzle-free even though Drizzle itself is
// installed in the fixture to catch accidental reachability.
const factStatementIndex = defineNodeIndex(Fact, { fields: ["statement"] });
void factStatementIndex;

const graph = defineGraph({
  id: "strict-local-consumers",
  nodes: { Fact: { type: Fact }, Source: { type: Source } },
  edges: {
    supports: { type: supports, from: [Source], to: [Fact] },
  },
});

const localSchema = createSqlSchema({
  nodes: "strict_nodes",
  edges: "strict_edges",
  recordedNodes: "strict_recorded_nodes",
  recordedEdges: "strict_recorded_edges",
  recordedClock: "strict_recorded_clock",
  revisionOrigins: "strict_revision_origins",
  fulltext: "strict_fulltext",
  uniques: "strict_uniques",
});

// The packed declaration build must preserve nominal identity between the root
// and /core entrypoints. A second declaration build can silently fork the
// unique-symbol brands even when both entrypoints typecheck in isolation.
const rootGraph: RootGraphDef = graph;
const coreGraph: CoreGraphDef = rootGraph;
void coreGraph;

type NativeTransactionProbe = Readonly<{
  executeNative: (statement: string) => void;
}>;

function assertFactoryContracts(
  portableBackend: GraphBackend,
  adapterBackend: AdapterBackend<NativeTransactionProbe>,
): void {
  const portableStore = createStore(graph, portableBackend);
  const portableCapabilities: BackendCapabilities = portableStore.capabilities;
  void portableCapabilities.transactions;
  void portableCapabilities.vector?.metrics;
  const portableView = new StoreView(portableStore, {
    valid: { mode: "current" },
  });
  void portableView;

  // @ts-expect-error A capability-less backend cannot create an AdapterStore.
  createAdapterStore(graph, portableBackend);

  const adapterStore = createAdapterStore(graph, adapterBackend);
  const portableAdapterProjection: Store<typeof graph> = adapterStore;
  void portableAdapterProjection;
  void adapterStore.transaction((tx) => {
    if (false) {
      // @ts-expect-error Native handles require an explicit availability check.
      const leakedToUnknown: unknown = tx.sql;
      void leakedToUnknown;
    }
    if (tx.sqlAvailability === "available") {
      tx.sql.executeNative("select 1");
    }
    if (false) {
      // @ts-expect-error Adapter contexts mutate through the explicit native handle, not the TypeGraph backend.
      tx.backend.insertNode({});
      // @ts-expect-error Arbitrary raw SQL is not part of the read projection.
      tx.backend.executeRaw("DELETE FROM typegraph_nodes", []);
    }
    return Promise.resolve();
  });

  void portableStore.transaction((tx) => {
    if (false) {
      // @ts-expect-error Portable transaction contexts expose no native handle.
      tx.sql.executeNative("select 1");
      // @ts-expect-error Portable backend projections cannot mutate graph rows.
      tx.backend.insertNode({});
      // @ts-expect-error Portable backend projections cannot execute arbitrary raw SQL.
      tx.backend.executeRaw("DELETE FROM typegraph_nodes", []);
    }
    return Promise.resolve();
  });
}
void assertFactoryContracts;

function assertEvolutionFlavorContracts(
  extension: GraphExtension,
  portableStore: Store<typeof graph>,
  adapterStore: AdapterStore<typeof graph, NativeTransactionProbe>,
  historyStore: HistoryStore<typeof graph>,
  recordedReadStore: RecordedReadStore<typeof graph>,
  adapterHistoryStore: AdapterHistoryStore<
    typeof graph,
    NativeTransactionProbe
  >,
  adapterRecordedReadStore: AdapterRecordedReadStore<
    typeof graph,
    NativeTransactionProbe
  >,
): void {
  const portableRef: StoreRef<Store<typeof graph>> = {
    current: portableStore,
  };
  const adapterRef: StoreRef<
    AdapterStore<typeof graph, NativeTransactionProbe>
  > = { current: adapterStore };
  const historyRef: StoreRef<HistoryStore<typeof graph>> = {
    current: historyStore,
  };
  const recordedReadRef: StoreRef<RecordedReadStore<typeof graph>> = {
    current: recordedReadStore,
  };
  const adapterHistoryRef: StoreRef<
    AdapterHistoryStore<typeof graph, NativeTransactionProbe>
  > = { current: adapterHistoryStore };
  const adapterRecordedReadRef: StoreRef<
    AdapterRecordedReadStore<typeof graph, NativeTransactionProbe>
  > = { current: adapterRecordedReadStore };

  const evolvedAdapter: Promise<
    AdapterStore<typeof graph, NativeTransactionProbe>
  > = adapterStore.evolve(extension, { ref: adapterRef });
  const deprecatedAdapter: Promise<
    AdapterStore<typeof graph, NativeTransactionProbe>
  > = adapterStore.deprecateKinds([], { ref: adapterRef });
  const undeprecatedAdapter: Promise<
    AdapterStore<typeof graph, NativeTransactionProbe>
  > = adapterStore.undeprecateKinds([], { ref: adapterRef });
  const removedAdapter: Promise<
    AdapterStore<typeof graph, NativeTransactionProbe>
  > = adapterStore.removeKinds([], { ref: adapterRef });
  const evolvedPortable: Promise<Store<typeof graph>> = portableStore.evolve(
    extension,
    { ref: portableRef },
  );
  const evolvedHistory: Promise<HistoryStore<typeof graph>> =
    historyStore.evolve(extension, { ref: historyRef });
  const evolvedRecordedRead: Promise<RecordedReadStore<typeof graph>> =
    recordedReadStore.evolve(extension, { ref: recordedReadRef });
  const evolvedAdapterHistory: Promise<
    AdapterHistoryStore<typeof graph, NativeTransactionProbe>
  > = adapterHistoryStore.evolve(extension, { ref: adapterHistoryRef });
  const evolvedAdapterRecordedRead: Promise<
    AdapterRecordedReadStore<typeof graph, NativeTransactionProbe>
  > = adapterRecordedReadStore.evolve(extension, {
    ref: adapterRecordedReadRef,
  });

  if (false) {
    // @ts-expect-error Portable evolution cannot replace an adapter-only ref.
    void portableStore.evolve(extension, { ref: adapterRef });
    // @ts-expect-error History evolution cannot replace an adapter-only ref.
    void historyStore.evolve(extension, { ref: adapterRef });
    // @ts-expect-error Adapter evolution cannot replace a history-only ref.
    void adapterStore.evolve(extension, { ref: adapterHistoryRef });
  }

  void evolvedAdapter;
  void deprecatedAdapter;
  void undeprecatedAdapter;
  void removedAdapter;
  void evolvedPortable;
  void evolvedHistory;
  void evolvedRecordedRead;
  void evolvedAdapterHistory;
  void evolvedAdapterRecordedRead;
}
void assertEvolutionFlavorContracts;

type ExerciseResult = Readonly<{
  statement: string;
  confidence: number;
  queryCount: number;
  reachableCount: number;
  transactionFactCount: number;
}>;

async function exerciseStore(
  store: Store<typeof graph>,
): Promise<ExerciseResult> {
  try {
    const transactionResult = await store.transaction(async (tx) => {
      if (false) {
        // @ts-expect-error Managed transaction handles are opaque outputs.
        const leaked: Readonly<{ select: () => unknown }> = tx.sql;
        void leaked;
      }
      const source = await tx.nodes.Source.create({
        url: "https://example.com/source",
      });
      const fact = await tx.nodes.Fact.create({ statement: "draft" });
      const edge = await tx.edges.supports.create(source, fact, {
        confidence: 0.9,
      });
      const transactionFactCount = await tx.nodes.Fact.count();

      return { edge, fact, source, transactionFactCount };
    });

    if (false) {
      // @ts-expect-error The Fact schema requires a string statement.
      await store.nodes.Fact.create({ statement: 42 });
      await store.edges.supports.create(
        // @ts-expect-error The supports edge only accepts Source -> Fact.
        transactionResult.fact,
        transactionResult.source,
        { confidence: 0.5 },
      );
    }

    const rootFactId: RootNodeId<typeof Fact> = transactionResult.fact.id;
    const coreFactId: CoreNodeId<typeof Fact> = rootFactId;
    const rootFactIdAgain: RootNodeId<typeof Fact> = coreFactId;
    const rootSupportsId: RootEdgeId<typeof supports> =
      transactionResult.edge.id;
    const coreSupportsId: CoreEdgeId<typeof supports> = rootSupportsId;
    const rootSupportsIdAgain: RootEdgeId<typeof supports> = coreSupportsId;
    void rootFactIdAgain;
    void rootSupportsIdAgain;

    const queryResults = await store
      .query()
      .from("Fact", "fact")
      .whereNode("fact", (fact) => fact.statement.eq("draft"))
      .select((context) => context.fact)
      .execute();
    const reachable = await store.algorithms.reachable(
      transactionResult.source,
      { edges: ["supports"] },
    );
    const updatedFact = await store.nodes.Fact.update(
      transactionResult.fact.id,
      { statement: "verified" },
    );
    const fetchedEdge = await store.edges.supports.getById(
      transactionResult.edge.id,
    );
    if (fetchedEdge === undefined) {
      throw new Error("Packed local consumer could not read the created edge.");
    }

    await store.edges.supports.delete(transactionResult.edge.id);
    await store.nodes.Fact.delete(transactionResult.fact.id);
    await store.nodes.Source.delete(transactionResult.source.id);
    const remainingNodes =
      (await store.nodes.Fact.count()) + (await store.nodes.Source.count());
    if (remainingNodes !== 0) {
      throw new Error(
        "Packed local consumer could not delete created records.",
      );
    }

    return {
      statement: updatedFact.statement,
      confidence: fetchedEdge.confidence,
      queryCount: queryResults.length,
      reachableCount: reachable.length,
      transactionFactCount: transactionResult.transactionFactCount,
    };
  } finally {
    await store.close();
  }
}

export async function exerciseStrictLocalConsumers(): Promise<
  Readonly<{ pglite: ExerciseResult; sqlite: ExerciseResult }>
> {
  if (false) {
    const sqliteDefault: Store<typeof graph> = await createLocalSqliteStore(
      graph,
      undefined,
    );
    const pgliteDefault: Store<typeof graph> = await createLocalPgliteStore(
      graph,
      undefined,
    );
    const sqliteHistory: HistoryStore<typeof graph> =
      await createLocalSqliteStore(graph, { store: { history: true } });
    const pgliteHistory: HistoryStore<typeof graph> =
      await createLocalPgliteStore(graph, { store: { history: true } });
    const recordedRead = recordedRelation({ schema: localSchema });
    const sqliteRecorded: RecordedReadStore<typeof graph> =
      await createLocalSqliteStore(graph, { store: { recordedRead } });
    const pgliteRecorded: RecordedReadStore<typeof graph> =
      await createLocalPgliteStore(graph, { store: { recordedRead } });
    const widenedLiveOptions = {} as LiveStoreOptions;
    const widenedStoreOptions = {} as StoreOptions;
    const sqliteLive = await createLocalSqliteStore(graph, {
      store: widenedLiveOptions,
    });
    const pgliteAny = await createLocalPgliteStore(graph, {
      store: widenedStoreOptions,
    });
    const sqliteLiveUnion:
      Store<typeof graph> | RecordedReadStore<typeof graph> = sqliteLive;
    const pgliteFlavorUnion:
      | Store<typeof graph>
      | HistoryStore<typeof graph>
      | RecordedReadStore<typeof graph> = pgliteAny;
    void pgliteFlavorUnion;
    void pgliteDefault;
    void pgliteHistory;
    void pgliteRecorded;
    void sqliteHistory;
    void sqliteDefault;
    void sqliteLiveUnion;
    void sqliteRecorded;
  }
  const sqliteStore = await createLocalSqliteStore(graph, {
    pragmas: { busyTimeoutMs: 1000 },
    schemaManagement: { systemIndexes: "skip" },
    store: { schema: localSchema },
  });
  void sqliteStore.capabilities.transactions;
  void sqliteStore.capabilities.vector?.metrics;
  if (false) {
    // @ts-expect-error Managed stores omit caller-owned transaction adoption.
    sqliteStore.withTransaction({});
    // @ts-expect-error Managed stores cannot widen to an adapter-native slot.
    const widened: AdapterStore<typeof graph, unknown> = sqliteStore;
    void widened;
  }
  const sqlite = await exerciseStore(sqliteStore);
  const pgliteStore = await createLocalPgliteStore(graph, {
    schemaManagement: { systemIndexes: "skip" },
    store: { schema: localSchema },
    vector: false,
  });
  void pgliteStore.capabilities.transactions;
  void pgliteStore.capabilities.vector?.metrics;
  if (false) {
    // @ts-expect-error Managed stores omit caller-owned transaction adoption.
    pgliteStore.withTransaction({});
  }
  const pglite = await exerciseStore(pgliteStore);
  return { pglite, sqlite };
}
