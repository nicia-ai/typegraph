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
import { createTestBackend } from "./test-utils";

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
      store.asOfRecorded(before!).nodes.Fact.getById(fact.id),
    ).resolves.toMatchObject({ id: "fact-a" });
    await expect(
      store.asOfRecorded(after!).nodes.Fact.getById(fact.id),
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
