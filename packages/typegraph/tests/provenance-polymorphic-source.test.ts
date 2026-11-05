/**
 * The retraction verbs accept a polymorphic query row as a source, as every
 * other node-reference input does: a default read of a source supertype
 * returns rows whose `kind` is `string`, and `retract`, `retractMany`,
 * `unRetract` and `unRetractMany` take them when the capability's configured
 * source kinds include the row's kind. The runtime source-kind check stays
 * authoritative: a row of a subclass the configuration leaves out compiles
 * and is refused with `ConfigurationError`.
 *
 * Load-bearing: narrowing the verbs back to `ProvenanceNodeRef` fails the
 * typecheck on every call below, and dropping the runtime source-kind check
 * lets the unconfigured subclass through.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
  type Node,
  subClassOf,
} from "../src";
import { createRetractionCapability } from "../src/provenance";
import { createTestBackend } from "./test-utils";

const sourceSchema = z.object({
  label: z.string(),
  retracted: z.boolean().default(false),
});
const Source = defineNode("Source", { schema: sourceSchema });
const ScannerSource = defineNode("ScannerSource", { schema: sourceSchema });
const VendorSource = defineNode("VendorSource", { schema: sourceSchema });
const Fact = defineNode("Fact", { schema: z.object({ label: z.string() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "provenance_polymorphic_source",
  nodes: {
    Source: { type: Source },
    ScannerSource: { type: ScannerSource },
    VendorSource: { type: VendorSource },
    Fact: { type: Fact },
    Justification: { type: Justification },
  },
  edges: {
    premiseOf: {
      type: premiseOf,
      from: [Source, ScannerSource, VendorSource],
      to: [Justification],
    },
    derives: { type: derives, from: [Justification], to: [Fact] },
  },
  ontology: [
    subClassOf(ScannerSource, Source),
    subClassOf(VendorSource, Source),
  ],
});

const config = {
  source: { kinds: ["Source", "ScannerSource"] },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type GraphStore = HistoryStore<typeof graph>;

async function openStore(): Promise<GraphStore> {
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    history: true,
  });
  return store;
}

async function seedSupport(
  store: GraphStore,
  source: Node<typeof ScannerSource> | Node<typeof VendorSource>,
  label: string,
) {
  const justification = await store.nodes.Justification.create({ label });
  const fact = await store.nodes.Fact.create({ label });
  await store.edges.premiseOf.create(source, justification, {});
  await store.edges.derives.create(justification, fact, {});
  return fact;
}

async function sourceRow(store: GraphStore, label: string) {
  const rows = await store
    .query()
    .from("Source", "s")
    .whereNode("s", (s) => s.label.eq(label))
    .select((ctx) => ctx.s)
    .execute();
  const row = rows[0];
  if (row === undefined) throw new Error(`no Source row labelled ${label}`);
  return row;
}

describe("provenance retraction of a polymorphic source row", () => {
  it("retracts and restores a configured subclass through a supertype row", async () => {
    const store = await openStore();
    const scanner = await store.nodes.ScannerSource.create({ label: "scan" });
    const fact = await seedSupport(store, scanner, "scan");
    const row = await sourceRow(store, "scan");
    expect(row.kind).toBe("ScannerSource");
    const provenance = createRetractionCapability(store, config);

    const retracted = await provenance.retract(row);
    console.info("polymorphic source retraction", retracted);
    expect(retracted.died).toEqual([{ kind: "Fact", id: fact.id }]);
    const restored = await provenance.unRetract(row);
    expect(restored.died).toEqual([]);
    expect(await store.nodes.Fact.getById(fact.id)).toBeDefined();

    const many = await provenance.retractMany([row]);
    expect(many.died).toEqual([{ kind: "Fact", id: fact.id }]);
    await provenance.unRetractMany([row]);
    expect(await store.nodes.Fact.getById(fact.id)).toBeDefined();
  });

  it("refuses a row of a subclass the configuration leaves out", async () => {
    const store = await openStore();
    const vendor = await store.nodes.VendorSource.create({ label: "vendor" });
    await seedSupport(store, vendor, "vendor");
    const row = await sourceRow(store, "vendor");
    const provenance = createRetractionCapability(store, config);

    const refusal = await provenance
      .retract(row)
      .catch((error: unknown) => error);
    console.info("unconfigured subclass retraction refusal", refusal);
    expect(refusal).toBeInstanceOf(ConfigurationError);
    expect((refusal as ConfigurationError).details).toMatchObject({
      expectedKinds: ["Source", "ScannerSource"],
      actualKind: "VendorSource",
    });
  });
});
