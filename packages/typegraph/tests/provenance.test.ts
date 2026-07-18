import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createSqlSchema,
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  type HistoryStore,
  recordedRelation,
  searchable,
} from "../src";
import { createSqliteTables } from "../src/backend/sqlite";
import { createRetractionCapability } from "../src/provenance";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";
import {
  createCommitFailingBackend,
  InjectedCommitFailure,
} from "./trace-backend";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Fact = defineNode("Fact", {
  schema: z.object({ label: z.string() }),
});

const UniqueFact = defineNode("UniqueFact", {
  schema: z.object({ code: z.string() }),
});

const SearchableFact = defineNode("SearchableFact", {
  schema: z.object({ title: searchable({ language: "english" }) }),
});

const EmbeddedFact = defineNode("EmbeddedFact", {
  schema: z.object({ vector: embedding(3) }),
});

const Note = defineNode("Note", {
  schema: z.object({ label: z.string() }),
});

const ScannerSource = defineNode("ScannerSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const VendorSource = defineNode("VendorSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");
const attachedTo = defineEdge("attachedTo");

const graph = defineGraph({
  id: "provenance_contract",
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

const multiSourceGraph = defineGraph({
  id: "provenance_multi_source_contract",
  nodes: {
    ScannerSource: { type: ScannerSource },
    VendorSource: { type: VendorSource },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [ScannerSource, VendorSource],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [Fact],
    },
  },
});

const multiSourceConfig = {
  source: { kinds: ["ScannerSource", "VendorSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const uniqueFactGraph = defineGraph({
  id: "provenance_unique_fact_contract",
  nodes: {
    Source: { type: Source },
    UniqueFact: {
      type: UniqueFact,
      unique: [
        {
          name: "unique_fact_code",
          fields: ["code"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, UniqueFact],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [UniqueFact],
    },
  },
});

const uniqueFactConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["UniqueFact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const searchableFactGraph = defineGraph({
  id: "provenance_searchable_fact_contract",
  nodes: {
    Source: { type: Source },
    SearchableFact: { type: SearchableFact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, SearchableFact],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [SearchableFact],
    },
  },
});

const searchableFactConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["SearchableFact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const embeddedFactGraph = defineGraph({
  id: "provenance_embedded_fact_contract",
  nodes: {
    Source: { type: Source },
    EmbeddedFact: { type: EmbeddedFact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, EmbeddedFact],
      to: [Justification],
    },
    derives: {
      type: derives,
      from: [Justification],
      to: [EmbeddedFact],
    },
  },
});

const embeddedFactConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["EmbeddedFact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

const restrictedAttachedFactGraph = defineGraph({
  id: "provenance_restricted_attached_fact_contract",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact },
    Justification: { type: Justification },
    Note: { type: Note },
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
    attachedTo: {
      type: attachedTo,
      from: [Fact],
      to: [Note],
    },
  },
});

const disconnectAttachedFactGraph = defineGraph({
  id: "provenance_disconnect_attached_fact_contract",
  nodes: {
    Source: { type: Source },
    Fact: { type: Fact, onDelete: "disconnect" },
    Justification: { type: Justification },
    Note: { type: Note },
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
    attachedTo: {
      type: attachedTo,
      from: [Fact],
      to: [Note],
    },
  },
});

const attachedFactConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

async function seedLinearSupport(store: HistoryStore<typeof graph>) {
  const source = await store.nodes.Source.create(
    { label: "source-a", retracted: false },
    { id: "source-a" },
  );
  const fact = await store.nodes.Fact.create(
    { label: "fact-a" },
    { id: "fact-a" },
  );
  const justification = await store.nodes.Justification.create(
    { label: "justification-a" },
    { id: "justification-a" },
  );
  await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
  await store.edges.derives.create(justification, fact, {}, { id: "d1" });
  return { source, fact };
}

async function seedMultiSourceSupport(
  store: HistoryStore<typeof multiSourceGraph>,
) {
  const scannerSource = await store.nodes.ScannerSource.create(
    { label: "scanner", retracted: false },
    { id: "scanner-a" },
  );
  const vendorSource = await store.nodes.VendorSource.create(
    { label: "vendor", retracted: false },
    { id: "vendor-a" },
  );
  const fact = await store.nodes.Fact.create(
    { label: "fact-a" },
    { id: "fact-a" },
  );
  const scannerJustification = await store.nodes.Justification.create(
    { label: "scanner-justification" },
    { id: "scanner-justification" },
  );
  const vendorJustification = await store.nodes.Justification.create(
    { label: "vendor-justification" },
    { id: "vendor-justification" },
  );
  await store.edges.premiseOf.create(
    scannerSource,
    scannerJustification,
    {},
    { id: "scanner-premise" },
  );
  await store.edges.premiseOf.create(
    vendorSource,
    vendorJustification,
    {},
    { id: "vendor-premise" },
  );
  await store.edges.derives.create(
    scannerJustification,
    fact,
    {},
    {
      id: "scanner-derives",
    },
  );
  await store.edges.derives.create(
    vendorJustification,
    fact,
    {},
    {
      id: "vendor-derives",
    },
  );
  return { scannerSource, vendorSource, fact };
}

async function seedUniqueFactSupport(
  store: HistoryStore<typeof uniqueFactGraph>,
) {
  const source = await store.nodes.Source.create(
    { label: "source-a", retracted: false },
    { id: "source-a" },
  );
  const fact = await store.nodes.UniqueFact.create(
    { code: "CVE-2026-0001" },
    { id: "unique-fact-a" },
  );
  const justification = await store.nodes.Justification.create(
    { label: "justification-a" },
    { id: "justification-a" },
  );
  await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
  await store.edges.derives.create(justification, fact, {}, { id: "d1" });
  return { source, fact };
}

async function seedSearchableFactSupport(
  store: HistoryStore<typeof searchableFactGraph>,
) {
  const source = await store.nodes.Source.create(
    { label: "source-a", retracted: false },
    { id: "source-a" },
  );
  const fact = await store.nodes.SearchableFact.create(
    { title: "withdrawable nebula advisory" },
    { id: "searchable-fact-a" },
  );
  const justification = await store.nodes.Justification.create(
    { label: "justification-a" },
    { id: "justification-a" },
  );
  await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
  await store.edges.derives.create(justification, fact, {}, { id: "d1" });
  return { source, fact };
}

async function seedEmbeddedFactSupport(
  store: HistoryStore<typeof embeddedFactGraph>,
) {
  const source = await store.nodes.Source.create(
    { label: "source-a", retracted: false },
    { id: "source-a" },
  );
  const fact = await store.nodes.EmbeddedFact.create(
    { vector: [1, 0, 0] },
    { id: "embedded-fact-a" },
  );
  const justification = await store.nodes.Justification.create(
    { label: "justification-a" },
    { id: "justification-a" },
  );
  await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
  await store.edges.derives.create(justification, fact, {}, { id: "d1" });
  return { source, fact };
}

describe("provenance retraction contract", () => {
  it("requires TypeGraph-managed history capture", () => {
    const backend = createTestBackend();
    const store = createStore(graph, backend);

    expect(() =>
      createRetractionCapability(
        store as unknown as HistoryStore<typeof graph>,
        config,
      ),
    ).toThrow("requires a store created with { history: true }");
  });

  it("rejects a recordedRead-only store because it cannot capture mutations", () => {
    const backend = createTestBackend();
    const schema = createSqlSchema();
    const store = createStore(graph, backend, {
      recordedRead: recordedRelation({ schema }),
    });

    expect(() =>
      createRetractionCapability(
        store as unknown as HistoryStore<typeof graph>,
        config,
      ),
    ).toThrow("requires a store created with { history: true }");
  });

  it("captures retraction with custom table names", async () => {
    const tableNames = {
      nodes: "prov_nodes",
      edges: "prov_edges",
      fulltext: "prov_fulltext",
      uniques: "prov_uniques",
      recordedNodes: "prov_recorded_nodes",
      recordedEdges: "prov_recorded_edges",
      recordedClock: "prov_recorded_clock",
    } as const;
    const backend = createTestBackend(createSqliteTables(tableNames));
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
      schema: createSqlSchema(tableNames),
    });
    const { source, fact } = await seedLinearSupport(store);
    const provenance = createRetractionCapability(store, config);
    const before = await store.recordedNow();

    await provenance.retract(source);
    const after = await store.recordedNow();

    await expect(
      store.asOfRecorded(requireDefined(before)).nodes.Fact.getById(fact.id),
    ).resolves.toMatchObject({ id: "fact-a" });
    await expect(
      store.asOfRecorded(requireDefined(after)).nodes.Fact.getById(fact.id),
    ).resolves.toBeUndefined();
  });

  it("accepts distinct source kinds without a discriminator node", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(multiSourceGraph, backend, {
      history: true,
    });
    const { scannerSource, vendorSource, fact } =
      await seedMultiSourceSupport(store);
    const provenance = createRetractionCapability(store, multiSourceConfig);

    const scannerReport = await provenance.retract(scannerSource);

    expect(scannerReport.died).toEqual([]);
    expect(scannerReport.survivedVia).toEqual([
      {
        fact: { kind: "Fact", id: "fact-a" },
        via: [{ kind: "Justification", id: "vendor-justification" }],
      },
    ]);

    const vendorReport = await provenance.retract(vendorSource);

    expect(vendorReport.died).toEqual([{ kind: "Fact", id: "fact-a" }]);
    await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
  });

  it("correctly loses support when its two independent sources are retracted concurrently", async () => {
    // #187 regression: concurrent transitions on a graph must be fully
    // serialized so a fact supported by two disjoint justification chains
    // never observes a torn cross-table read (one chain's premise/derive
    // rows from before the other's commit, source rows from after it).
    // Without serialization, a concurrent pair like this could each
    // conclude the OTHER source was still available and leave the fact
    // incorrectly believed.
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(multiSourceGraph, backend, {
      history: true,
    });
    const { scannerSource, vendorSource, fact } =
      await seedMultiSourceSupport(store);
    const provenance = createRetractionCapability(store, multiSourceConfig);

    const [scannerReport, vendorReport] = await Promise.all([
      provenance.retract(scannerSource),
      provenance.retract(vendorSource),
    ]);

    const died = [...scannerReport.died, ...vendorReport.died];
    expect(died).toEqual([{ kind: "Fact", id: "fact-a" }]);
    await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
  });

  it("supports no-premise justifications as axioms", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const fact = await store.nodes.Fact.create(
      { label: "axiom-fact" },
      { id: "axiom-fact" },
    );
    const justification = await store.nodes.Justification.create(
      { label: "axiom-justification" },
      { id: "axiom-justification" },
    );
    await store.edges.derives.create(
      justification,
      fact,
      {},
      { id: "axiom-derives" },
    );
    const provenance = createRetractionCapability(store, config);

    await expect(provenance.holding()).resolves.toEqual([
      { kind: "Fact", id: "axiom-fact" },
    ]);
  });

  it("preserves node IDs containing NUL bytes in reports", async () => {
    const separator = "\u0000";
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: `source${separator}a` },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: `fact${separator}a` },
    );
    const justification = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: `justification${separator}a` },
    );
    await store.edges.premiseOf.create(
      source,
      justification,
      {},
      { id: "premise-with-nul" },
    );
    await store.edges.derives.create(
      justification,
      fact,
      {},
      { id: "derives-with-nul" },
    );
    const provenance = createRetractionCapability(store, config);

    const report = await provenance.retract(source);

    expect(report.died).toEqual([{ kind: "Fact", id: `fact${separator}a` }]);
  });

  it("deduplicates repeated derives edges in survivedVia reports", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const sourceA = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );
    const sourceB = await store.nodes.Source.create(
      { label: "source-b", retracted: false },
      { id: "source-b" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const justificationA = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    const justificationB = await store.nodes.Justification.create(
      { label: "justification-b" },
      { id: "justification-b" },
    );
    await store.edges.premiseOf.create(
      sourceA,
      justificationA,
      {},
      { id: "premise-a" },
    );
    await store.edges.premiseOf.create(
      sourceB,
      justificationB,
      {},
      { id: "premise-b" },
    );
    await store.edges.derives.create(
      justificationA,
      fact,
      {},
      { id: "derives-a" },
    );
    await store.edges.derives.create(
      justificationB,
      fact,
      {},
      { id: "derives-b-1" },
    );
    await store.edges.derives.create(
      justificationB,
      fact,
      {},
      { id: "derives-b-2" },
    );
    const provenance = createRetractionCapability(store, config);

    const report = await provenance.retract(sourceA);

    expect(report.survivedVia).toEqual([
      {
        fact: { kind: "Fact", id: "fact-a" },
        via: [{ kind: "Justification", id: "justification-b" }],
      },
    ]);
  });

  it("runs fact currency hooks and increments fact version on reopen", async () => {
    const operations: string[] = [];
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
      hooks: {
        onOperationStart: (ctx) => {
          operations.push(
            `${ctx.operation}:${ctx.entity}:${ctx.kind}:${ctx.id}`,
          );
        },
      },
    });
    const { source, fact } = await seedLinearSupport(store);
    const provenance = createRetractionCapability(store, config);
    operations.length = 0;

    await provenance.retract(source);

    expect(operations).toContain("update:node:Source:source-a");
    expect(operations).toContain("delete:node:Fact:fact-a");
    operations.length = 0;

    await provenance.unRetract(source);

    expect(operations).toContain("update:node:Source:source-a");
    expect(operations).toContain("update:node:Fact:fact-a");
    const restoredFact = await store.nodes.Fact.getById(fact.id);
    expect(restoredFact?.id).toBe("fact-a");
    expect(restoredFact?.meta.version).toBe(2);
  });

  it("reports transition hooks only after the transaction commits", async () => {
    const failing = createCommitFailingBackend(createTestBackend());
    const events: string[] = [];
    const [store] = await createStoreWithSchema(graph, failing.backend, {
      history: true,
      hooks: {
        onOperationStart: (ctx) => {
          events.push(`start:${ctx.operation}:${ctx.kind}`);
        },
        onOperationEnd: (ctx) => {
          events.push(`end:${ctx.operation}:${ctx.kind}`);
        },
        onError: (ctx, error) => {
          events.push(`error:${error.name}`);
        },
      },
    });
    const { source, fact } = await seedLinearSupport(store);
    const provenance = createRetractionCapability(store, config);
    events.length = 0;

    failing.arm();
    await expect(provenance.retract(source)).rejects.toThrow(
      InjectedCommitFailure,
    );
    failing.disarm();

    // The transition rolled back: the source flip and the fact close ran
    // inside the transaction, so their success hooks must be converted to
    // onError — never reported as onOperationEnd.
    expect(events.some((event) => event.startsWith("end:"))).toBe(false);
    expect(events).toContain("error:InjectedCommitFailure");
    await expect(store.nodes.Fact.getById(fact.id)).resolves.toMatchObject({
      id: "fact-a",
    });

    events.length = 0;
    await provenance.retract(source);
    expect(events).toContain("end:update:Source");
    expect(events).toContain("end:delete:Fact");
  });

  it("closes fact currency without enforcing restrict delete behavior", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      restrictedAttachedFactGraph,
      backend,
      { history: true },
    );
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const note = await store.nodes.Note.create(
      { label: "attached-note" },
      { id: "note-a" },
    );
    const justification = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
    await store.edges.derives.create(justification, fact, {}, { id: "d1" });
    const attached = await store.edges.attachedTo.create(
      fact,
      note,
      {},
      { id: "attached-a" },
    );
    const provenance = createRetractionCapability(store, attachedFactConfig);

    // Closing a fact's currency is a belief-status change, not a domain
    // delete: `restrict` does not block it, and the fact's edges survive.
    const report = await provenance.retract(source);

    expect(report.died).toEqual([{ kind: "Fact", id: "fact-a" }]);
    await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
    await expect(store.nodes.Source.getById(source.id)).resolves.toMatchObject({
      retracted: true,
    });
    await expect(
      backend.getEdge(store.graphId, attached.id),
    ).resolves.toMatchObject({ deleted_at: undefined });
  });

  it("preserves non-provenance fact edges across a retract/unRetract round trip", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      disconnectAttachedFactGraph,
      backend,
      { history: true },
    );
    const source = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const note = await store.nodes.Note.create(
      { label: "attached-note" },
      { id: "note-a" },
    );
    const justification = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    await store.edges.premiseOf.create(source, justification, {}, { id: "p1" });
    await store.edges.derives.create(justification, fact, {}, { id: "d1" });
    const attached = await store.edges.attachedTo.create(
      fact,
      note,
      {},
      { id: "attached-a" },
    );
    const provenance = createRetractionCapability(store, attachedFactConfig);

    await provenance.retract(source);

    await expect(store.nodes.Fact.getById(fact.id)).resolves.toBeUndefined();
    // Delete behavior (`disconnect`) is not enforced for a currency close:
    // the attached edge survives untouched so unRetract is an exact inverse.
    await expect(
      backend.getEdge(store.graphId, attached.id),
    ).resolves.toMatchObject({ deleted_at: undefined });
    await expect(store.edges.derives.find({ to: fact })).resolves.toHaveLength(
      1,
    );

    await provenance.unRetract(source);

    await expect(store.nodes.Fact.getById(fact.id)).resolves.toMatchObject({
      id: "fact-a",
    });
    await expect(
      store.edges.attachedTo.find({ from: fact }),
    ).resolves.toHaveLength(1);
  });

  it("leaves unsupported facts outside the transition's reach untouched", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const { source } = await seedLinearSupport(store);
    // A fact created ahead of its justification links: live but unsupported.
    const pending = await store.nodes.Fact.create(
      { label: "pending" },
      { id: "fact-pending" },
    );
    const provenance = createRetractionCapability(store, config);

    const report = await provenance.retract(source);

    expect(report.died).toEqual([{ kind: "Fact", id: "fact-a" }]);
    // The unlinked fact is not reachable from the retracted source, so the
    // transition must not tombstone it.
    await expect(store.nodes.Fact.getById(pending.id)).resolves.toMatchObject({
      id: "fact-pending",
    });
  });

  it("closes before reopening so a unique key can move between affected facts", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(uniqueFactGraph, backend, {
      history: true,
    });
    const provenance = createRetractionCapability(store, uniqueFactConfig);

    // factB holds the unique code, supported by sourceB; retract it.
    const sourceB = await store.nodes.Source.create(
      { label: "source-b", retracted: false },
      { id: "source-b" },
    );
    const factB = await store.nodes.UniqueFact.create(
      { code: "CVE-2026-0002" },
      { id: "unique-fact-b" },
    );
    const justificationB = await store.nodes.Justification.create(
      { label: "justification-b" },
      { id: "justification-b" },
    );
    await store.edges.premiseOf.create(
      sourceB,
      justificationB,
      {},
      { id: "pb" },
    );
    await store.edges.derives.create(justificationB, factB, {}, { id: "db" });
    await provenance.retract(sourceB);
    await expect(
      store.nodes.UniqueFact.getById(factB.id),
    ).resolves.toBeUndefined();

    // factA takes over the released code, supported by sourceA. Its
    // justification also derives factB, making factB reachable from sourceA.
    const sourceA = await store.nodes.Source.create(
      { label: "source-a", retracted: false },
      { id: "source-a" },
    );
    const factA = await store.nodes.UniqueFact.create(
      { code: "CVE-2026-0002" },
      { id: "unique-fact-z" },
    );
    const justificationA = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    await store.edges.premiseOf.create(
      sourceA,
      justificationA,
      {},
      { id: "pa" },
    );
    await store.edges.derives.create(justificationA, factA, {}, { id: "da" });
    // Link the closed factB back into sourceA's justification and give it
    // independent support. The collection API refuses edges to a tombstoned
    // endpoint, so these arrive via the raw backend — the same shape a raw
    // write or interchange import produces. No transition has run since, so
    // factB is still tombstoned despite being supported.
    const sourceC = await store.nodes.Source.create(
      { label: "source-c", retracted: false },
      { id: "source-c" },
    );
    const justificationC = await store.nodes.Justification.create(
      { label: "justification-c" },
      { id: "justification-c" },
    );
    await store.edges.premiseOf.create(
      sourceC,
      justificationC,
      {},
      { id: "pc" },
    );
    await backend.insertEdge({
      graphId: store.graphId,
      id: "dab",
      kind: "derives",
      fromKind: "Justification",
      fromId: justificationA.id,
      toKind: "UniqueFact",
      toId: factB.id,
      props: {},
    });
    await backend.insertEdge({
      graphId: store.graphId,
      id: "dcb",
      kind: "derives",
      fromKind: "Justification",
      fromId: justificationC.id,
      toKind: "UniqueFact",
      toId: factB.id,
      props: {},
    });

    // Retracting sourceA closes factA (releasing the code) and reopens the
    // still-supported factB (re-claiming it). Reopening first would hit the
    // code factA still holds — closes must run first.
    const report = await provenance.retract(sourceA);

    expect(report.died).toEqual([{ kind: "UniqueFact", id: "unique-fact-z" }]);
    await expect(
      store.nodes.UniqueFact.getById(factA.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.UniqueFact.getById(factB.id),
    ).resolves.toMatchObject({ code: "CVE-2026-0002" });
  });

  it("treats validity-expired sources as unavailable support", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(graph, backend, {
      history: true,
    });
    const expired = await store.nodes.Source.create(
      { label: "expired-source", retracted: false },
      { id: "source-expired", validTo: "2020-01-01T00:00:00.000Z" },
    );
    const fact = await store.nodes.Fact.create(
      { label: "fact-a" },
      { id: "fact-a" },
    );
    const justification = await store.nodes.Justification.create(
      { label: "justification-a" },
      { id: "justification-a" },
    );
    await store.edges.premiseOf.create(
      expired,
      justification,
      {},
      { id: "p1" },
    );
    await store.edges.derives.create(justification, fact, {}, { id: "d1" });
    const provenance = createRetractionCapability(store, config);

    // The source's validity ended, so — matching the collection API's
    // current-time reads — it supports nothing and the fact is not believed.
    await expect(provenance.holding()).resolves.toEqual([]);
  });

  it("releases and restores uniqueness sidecars when fact currency changes", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(uniqueFactGraph, backend, {
      history: true,
    });
    const { source, fact } = await seedUniqueFactSupport(store);
    const provenance = createRetractionCapability(store, uniqueFactConfig);

    await provenance.retract(source);

    await expect(
      store.nodes.UniqueFact.create(
        { code: "CVE-2026-0001" },
        { id: "unique-fact-replacement" },
      ),
    ).resolves.toMatchObject({ id: "unique-fact-replacement" });

    await expect(provenance.unRetract(source)).rejects.toThrow(
      "Uniqueness violation",
    );
    await expect(
      store.nodes.UniqueFact.getById(fact.id),
    ).resolves.toBeUndefined();
  });

  it("removes and restores fulltext sidecars when fact currency changes", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(searchableFactGraph, backend, {
      history: true,
    });
    const { source, fact } = await seedSearchableFactSupport(store);
    const provenance = createRetractionCapability(store, searchableFactConfig);

    const before = await store.search.fulltext("SearchableFact", {
      query: "withdrawable nebula",
      limit: 10,
    });
    expect(before.some((result) => result.node.id === fact.id)).toBe(true);

    await provenance.retract(source);

    const closed = await store.search.fulltext("SearchableFact", {
      query: "withdrawable nebula",
      limit: 10,
    });
    expect(closed.every((result) => result.node.id !== fact.id)).toBe(true);

    await provenance.unRetract(source);

    const reopened = await store.search.fulltext("SearchableFact", {
      query: "withdrawable nebula",
      limit: 10,
    });
    expect(reopened.some((result) => result.node.id === fact.id)).toBe(true);
  });

  it("removes and restores embedding sidecars when fact currency changes", async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(embeddedFactGraph, backend, {
      history: true,
    });
    const { source, fact } = await seedEmbeddedFactSupport(store);
    const provenance = createRetractionCapability(store, embeddedFactConfig);

    const before = await store.search.vector("EmbeddedFact", {
      fieldPath: "vector",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(before.some((result) => result.node.id === fact.id)).toBe(true);

    await provenance.retract(source);

    const closed = await store.search.vector("EmbeddedFact", {
      fieldPath: "vector",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(closed.every((result) => result.node.id !== fact.id)).toBe(true);

    await provenance.unRetract(source);

    const reopened = await store.search.vector("EmbeddedFact", {
      fieldPath: "vector",
      queryEmbedding: [1, 0, 0],
      limit: 10,
    });
    expect(reopened.some((result) => result.node.id === fact.id)).toBe(true);
  });
});
