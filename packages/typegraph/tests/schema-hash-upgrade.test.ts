/**
 * A stored schema version keeps the document and `schema_hash` the release
 * that wrote it produced. Every comparison against a graph serialized today
 * reads `activeSchemaHash`, which hashes the stored document in this
 * release's serialization, so a document an earlier release wrote for an
 * unchanged schema compares equal to its graph without being rewritten.
 */
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  equivalentTo,
  type GraphDef,
  subClassOf,
} from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  captureCandidateWriteSetTarget,
  isErr,
  planCandidateWriteSetReview,
  revalidateCandidateWriteSetReview,
} from "../src/graph-merge";
import { registerGraphTemplate } from "../src/schema/graph-templates";
import { activeSchemaHash, parseSerializedSchema } from "../src/schema/manager";
import { computeSchemaDiff } from "../src/schema/migration";
import {
  computeSchemaHash,
  getSchemaHash,
  serializeSchema,
} from "../src/schema/serializer";
import { type SerializedSchema } from "../src/schema/types";
import { createAdapterStoreWithSchema } from "../src/store/store";
import { requireDefined } from "../src/utils/presence";

const Animal = defineNode("UpgradeAnimal", {
  schema: z.object({ name: z.string() }),
});
const Dog = defineNode("UpgradeDog", {
  schema: z.object({ name: z.string() }),
});
const Hound = defineNode("UpgradeHound", {
  schema: z.object({ name: z.string() }),
});
const Kennel = defineNode("UpgradeKennel", { schema: z.object({}) });
const housedIn = defineEdge("upgradeHousedIn", { schema: z.object({}) });

const subClassGraph = defineGraph({
  id: "schema_hash_upgrade_subclass",
  nodes: { UpgradeAnimal: { type: Animal }, UpgradeDog: { type: Dog } },
  edges: {},
  ontology: [subClassOf(Dog, Animal)],
});

const equivalenceGraph = defineGraph({
  id: "schema_hash_upgrade_equivalence",
  nodes: {
    UpgradeAnimal: { type: Animal },
    UpgradeDog: { type: Dog },
    UpgradeHound: { type: Hound },
    UpgradeKennel: { type: Kennel },
  },
  edges: {
    upgradeHousedIn: { type: housedIn, from: [Dog], to: [Kennel] },
  },
  ontology: [subClassOf(Dog, Animal), equivalentTo(Hound, Dog)],
});

/** The same graph with one property changed: a real schema change. */
const ResizedKennel = defineNode("UpgradeKennel", {
  schema: z.object({ capacity: z.number() }),
});
const changedEquivalenceGraph = defineGraph({
  id: equivalenceGraph.id,
  nodes: {
    UpgradeAnimal: { type: Animal },
    UpgradeDog: { type: Dog },
    UpgradeHound: { type: Hound },
    UpgradeKennel: { type: ResizedKennel },
  },
  edges: {
    upgradeHousedIn: { type: housedIn, from: [Dog], to: [ResizedKennel] },
  },
  ontology: [subClassOf(Dog, Animal), equivalentTo(Hound, Dog)],
});

interface MutableDocument {
  ontology: {
    metaEdges: Record<string, Record<string, unknown>>;
    closures: Record<string, unknown>;
  };
}

/**
 * The document an earlier release wrote: every meta-edge entry carries the
 * fields that release serialized, and the subsumption closures were derived
 * without folding `equivalentTo` into them.
 */
function earlierReleaseDocument(current: SerializedSchema): SerializedSchema {
  const document = structuredClone(current) as unknown as MutableDocument;
  for (const metaEdge of Object.values(document.ontology.metaEdges)) {
    metaEdge["transitive"] = metaEdge["name"] !== "equivalentTo";
    metaEdge["symmetric"] = metaEdge["name"] === "equivalentTo";
    metaEdge["reflexive"] = false;
    metaEdge["inference"] =
      metaEdge["name"] === "equivalentTo" ? "substitution" : "subsumption";
  }
  document.ontology.closures["subClassAncestors"] = {
    UpgradeDog: ["UpgradeAnimal"],
  };
  document.ontology.closures["subClassDescendants"] = {
    UpgradeAnimal: ["UpgradeDog"],
  };
  return document as unknown as SerializedSchema;
}

type SqliteHandle = Readonly<{
  backend: ReturnType<typeof createLocalSqliteBackend>["backend"];
  client: Database.Database;
}>;

const backends: SqliteHandle["backend"][] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
});

function sqliteHandle(): SqliteHandle {
  const { backend, db } = createLocalSqliteBackend();
  backends.push(backend);
  const client = (db as unknown as Readonly<{ $client: Database.Database }>)
    .$client;
  return { backend, client };
}

/** Rewrites the active v1 row to what an earlier release committed. */
async function storeEarlierReleaseRow(
  handle: SqliteHandle,
  graph: GraphDef,
): Promise<Readonly<{ schemaDoc: string; schemaHash: string }>> {
  const document = earlierReleaseDocument(serializeSchema(graph, 1));
  const schemaDocument = JSON.stringify(document);
  const schemaHash = await computeSchemaHash(document);
  handle.client
    .prepare(
      "UPDATE typegraph_schema_versions SET schema_doc = ?, schema_hash = ? WHERE graph_id = ? AND version = 1",
    )
    .run(schemaDocument, schemaHash, graph.id);
  return { schemaDoc: schemaDocument, schemaHash };
}

describe("activeSchemaHash", () => {
  it("equals the column for every row this release commits", async () => {
    const handle = sqliteHandle();
    for (const graph of [subClassGraph, equivalenceGraph]) {
      await createAdapterStoreWithSchema(graph, handle.backend);
      const row = requireDefined(
        await handle.backend.getActiveSchema(graph.id),
      );

      expect(await activeSchemaHash(row)).toBe(row.schema_hash);
    }
  });

  it("agrees with the schema diff on whether an earlier release's document describes the graph", async () => {
    const stored = earlierReleaseDocument(serializeSchema(equivalenceGraph, 1));
    const row = { schema_doc: JSON.stringify(stored) };
    const storedHash = await activeSchemaHash(row);
    const cases = [
      { label: "same graph", graph: equivalenceGraph },
      { label: "a changed property", graph: changedEquivalenceGraph },
      { label: "a removed relation", graph: subClassGraph },
    ];

    const verdicts = await Promise.all(
      cases.map(async ({ label, graph }) => {
        const current = serializeSchema(graph, 2);
        const diff = computeSchemaDiff(
          parseSerializedSchema(row.schema_doc),
          current,
        );
        return {
          label,
          semanticallyUnchanged: !diff.hasChanges,
          hashesEqual: storedHash === (await getSchemaHash(graph, 2)),
        };
      }),
    );

    expect(await computeSchemaHash(stored)).not.toBe(
      await getSchemaHash(equivalenceGraph, 2),
    );
    expect(verdicts).toEqual([
      { label: "same graph", semanticallyUnchanged: true, hashesEqual: true },
      {
        label: "a changed property",
        semanticallyUnchanged: false,
        hashesEqual: false,
      },
      {
        label: "a removed relation",
        semanticallyUnchanged: false,
        hashesEqual: false,
      },
    ]);
  });
  // MUTATION CHECK: hashing the parsed document without
  // `canonicalStoredSchemaDocument` makes "same graph" report
  // `hashesEqual: false` while the diff still calls it unchanged.
});

describe("a schema version an earlier release committed", () => {
  it("reopens unchanged without rewriting the row, and a template registers from it", async () => {
    const handle = sqliteHandle();
    await createAdapterStoreWithSchema(equivalenceGraph, handle.backend);
    const earlier = await storeEarlierReleaseRow(handle, equivalenceGraph);

    const [store, result] = await createAdapterStoreWithSchema(
      equivalenceGraph,
      handle.backend,
    );
    const row = requireDefined(
      await handle.backend.getActiveSchema(equivalenceGraph.id),
    );
    const template = await registerGraphTemplate(handle.backend, {
      templateId: "schema-hash-upgrade-template",
      reconciled: store.reconciledSchema,
    });

    expect(result.status).toBe("unchanged");
    expect(row.version).toBe(1);
    expect(row.schema_doc).toBe(earlier.schemaDoc);
    expect(row.schema_hash).toBe(earlier.schemaHash);
    expect(store.reconciledSchema.hash).toBe(
      await getSchemaHash(equivalenceGraph, 1),
    );
    expect(template.schemaHash).toBe(store.reconciledSchema.hash);
    expect(await store.refreshSchema()).toBe(store);
  });
  // MUTATION CHECK: reading `row.schema_hash` in `schemaMetadataFromRow`
  // (store.ts) makes `registerGraphTemplate` throw
  // GRAPH_TEMPLATE_RECONCILED_HASH_MISMATCH.

  it("plans and revalidates a candidate merge review against it", async () => {
    const handle = sqliteHandle();
    await createAdapterStoreWithSchema(equivalenceGraph, handle.backend, {
      history: true,
    });
    await storeEarlierReleaseRow(handle, equivalenceGraph);
    const [target] = await createAdapterStoreWithSchema(
      equivalenceGraph,
      handle.backend,
      { history: true },
    );
    const writeSet = {
      formatVersion: 1 as const,
      sourceId: "source",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "UpgradeKennel",
          id: "candidate",
          properties: {},
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    };
    const args = {
      target,
      makeBackend: () => Promise.resolve(createLocalSqliteBackend().backend),
      writeSet,
      policy: { id: "schema-hash-upgrade-policy", context: {} },
    };

    const planned = await planCandidateWriteSetReview(args);
    if (isErr(planned)) throw planned.error;
    const revalidated = await revalidateCandidateWriteSetReview({
      ...args,
      review: planned.data,
    });

    expect(isErr(revalidated)).toBe(false);
  });
  // MUTATION CHECK: reading `activeSchema.schema_hash` in
  // `captureMergePlanTargetFence` (merge.ts) makes revalidation refuse with
  // `incompatible-plan`.
});
