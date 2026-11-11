/**
 * A stored document carrying the three-part `partOf(part, whole)` relation
 * (no `via`) can be moved forward by every schema-managed path: declaring
 * the realizing edge, or dropping the relation.
 *
 * The stored side of a diff is a delta input, never a registry a store reads
 * or writes through, so its composition shape is not enforced. A LOAD of
 * that document still refuses (`schema-composition-load.test.ts`).
 *
 * LOAD-BEARING CHECK: restoring the stored-side
 * `ONTOLOGY_COMPOSITION_VIA_REQUIRED` refusal in `buildValidatedKindRegistry`
 * makes every case here throw that `ConfigurationError`; classifying the
 * removal of a relation that realizes nothing as `breaking` again makes the
 * two `createStoreWithSchema` cases refuse with `breaking-change`.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  MigrationError,
  partOf,
} from "../src";
import {
  getActiveSchema,
  getSchemaChanges,
  migrateSchema,
} from "../src/schema";
import { computeSchemaHash, serializeSchema } from "../src/schema/serializer";
import { type SerializedSchema } from "../src/schema/types";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const GRAPH_ID = "legacy_composition_upgrade";
const INITIAL_VERSION = 1;

const Book = defineNode("Book", { schema: z.object({ title: z.string() }) });
const Chapter = defineNode("Chapter", {
  schema: z.object({ title: z.string() }),
});
const inBook = defineEdge("inBook", { schema: z.object({}) });

const nodes = { Book: { type: Book }, Chapter: { type: Chapter } };
const edges = {
  inBook: {
    type: inBook,
    from: [Chapter],
    to: [Book],
    cardinality: "one",
  },
} as const;

const withoutRelation = defineGraph({ id: GRAPH_ID, nodes, edges });
const withVia = defineGraph({
  id: GRAPH_ID,
  nodes,
  edges,
  ontology: [partOf(Chapter, Book, { via: inBook })],
});

const LEGACY_RELATION = { metaEdge: "partOf", from: "Chapter", to: "Book" };

/** The document the previous release wrote for `partOf(Chapter, Book)`. */
function legacyDocument(): SerializedSchema {
  const base = serializeSchema(withoutRelation, INITIAL_VERSION);
  return {
    ...base,
    ontology: { ...base.ontology, relations: [LEGACY_RELATION] },
  };
}

async function backendWithLegacyDocument(): Promise<GraphBackend> {
  const backend = createTestBackend();
  const schemaDocument = legacyDocument();
  await backend.commitSchemaVersion({
    graphId: GRAPH_ID,
    expected: { kind: "initial" },
    version: INITIAL_VERSION,
    schemaHash: await computeSchemaHash(schemaDocument),
    schemaDoc: schemaDocument,
  });
  return backend;
}

async function activeRelations(backend: GraphBackend): Promise<unknown> {
  const active = requireDefined(await getActiveSchema(backend, GRAPH_ID));
  return active.ontology.relations;
}

describe("a stored partOf relation with no `via` upgrades through every schema path", () => {
  it("getSchemaChanges reports declaring the realizing edge instead of throwing", async () => {
    const backend = await backendWithLegacyDocument();

    const diff = requireDefined(await getSchemaChanges(backend, withVia));

    console.log("legacy -> via diff:", JSON.stringify(diff.ontology));
    expect(
      diff.ontology.map((change) => [change.type, change.severity]),
    ).toEqual([
      ["removed", "safe"],
      ["added", "warning"],
    ]);
    expect(diff.hasBreakingChanges).toBe(false);
  });

  it("getSchemaChanges reports dropping the relation as safe", async () => {
    const backend = await backendWithLegacyDocument();

    const diff = requireDefined(
      await getSchemaChanges(backend, withoutRelation),
    );

    console.log("legacy -> removed diff:", JSON.stringify(diff.ontology));
    expect(
      diff.ontology.map((change) => [change.type, change.severity]),
    ).toEqual([["removed", "safe"]]);
  });

  it.each([
    ["declares the realizing edge", withVia],
    ["drops the relation", withoutRelation],
  ] as const)(
    "createStoreWithSchema migrates when the graph %s",
    async (_label, graph) => {
      const backend = await backendWithLegacyDocument();

      const [, result] = await createStoreWithSchema(graph, backend);

      console.log("createStoreWithSchema:", result.status);
      expect(result.status).toBe("migrated");
      expect(await activeRelations(backend)).toEqual(
        serializeSchema(graph, INITIAL_VERSION).ontology.relations,
      );
    },
  );

  it.each([
    ["declares the realizing edge", withVia],
    ["drops the relation", withoutRelation],
  ] as const)(
    "migrateSchema commits when the graph %s",
    async (_label, graph) => {
      const backend = await backendWithLegacyDocument();

      const version = await migrateSchema(backend, graph, INITIAL_VERSION);

      console.log("migrateSchema committed version:", version);
      expect(version).toBe(INITIAL_VERSION + 1);
      expect(await activeRelations(backend)).toEqual(
        serializeSchema(graph, INITIAL_VERSION).ontology.relations,
      );
    },
  );
});

// A `oneActive` realizing edge keeps history, so its stored rows can carry
// windows that would overlap once the relation becomes a composition pair.
const LEGACY_HISTORY_GRAPH_ID = "legacy_composition_upgrade_history";
const Show = defineNode("Show", { schema: z.object({}) });
const Clip = defineNode("Clip", { schema: z.object({}) });
const inShow = defineEdge("inShow", { schema: z.object({}) });
const historyNodes = { Show: { type: Show }, Clip: { type: Clip } };
const historyEdges = {
  inShow: {
    type: inShow,
    from: [Clip],
    to: [Show],
    cardinality: "oneActive",
  },
} as const;
const historyWithVia = defineGraph({
  id: LEGACY_HISTORY_GRAPH_ID,
  nodes: historyNodes,
  edges: historyEdges,
  ontology: [partOf(Clip, Show, { via: inShow })],
});

/** The previous release's `partOf(Clip, Show)` document over the history rows. */
async function backendWithLegacyHistory(
  windows: readonly Readonly<{ validFrom: string; validTo: string }>[],
): Promise<GraphBackend> {
  const backend = createTestBackend();
  const base = serializeSchema(
    defineGraph({
      id: LEGACY_HISTORY_GRAPH_ID,
      nodes: historyNodes,
      edges: historyEdges,
    }),
    INITIAL_VERSION,
  );
  const schemaDocument: SerializedSchema = {
    ...base,
    ontology: {
      ...base.ontology,
      relations: [{ metaEdge: "partOf", from: "Clip", to: "Show" }],
    },
  };
  await backend.commitSchemaVersion({
    graphId: LEGACY_HISTORY_GRAPH_ID,
    expected: { kind: "initial" },
    version: INITIAL_VERSION,
    schemaHash: await computeSchemaHash(schemaDocument),
    schemaDoc: schemaDocument,
  });
  const since = "2018-01-01T00:00:00.000Z";
  await backend.insertNode({
    graphId: LEGACY_HISTORY_GRAPH_ID,
    kind: "Clip",
    id: "clip",
    props: {},
    validFrom: since,
  });
  for (const [index, window] of windows.entries()) {
    await backend.insertNode({
      graphId: LEGACY_HISTORY_GRAPH_ID,
      kind: "Show",
      id: `show-${String(index)}`,
      props: {},
      validFrom: since,
    });
    await backend.insertEdge({
      graphId: LEGACY_HISTORY_GRAPH_ID,
      id: `in-show-${String(index)}`,
      kind: "inShow",
      fromKind: "Clip",
      fromId: "clip",
      toKind: "Show",
      toId: `show-${String(index)}`,
      props: {},
      ...window,
    });
  }
  return backend;
}

describe("a stored partOf relation with no `via` over a oneActive edge's history", () => {
  // MUTATION CHECK: drop `windowOverlapViolations` from the preflight's
  // violation list in `prepareSchemaTighteningPreflight`
  // (src/schema/tightening-preflight.ts) — the upgrade then commits and the
  // clip reads under two shows at once in 2021.
  it("refuses the upgrade to a composition pair while a part's history overlaps", async () => {
    const backend = await backendWithLegacyHistory([
      {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      },
      {
        validFrom: "2021-01-01T00:00:00.000Z",
        validTo: "2023-01-01T00:00:00.000Z",
      },
    ]);

    const error = await createStoreWithSchema(historyWithVia, backend).catch(
      (error_: unknown) => error_,
    );

    expect(error).toBeInstanceOf(MigrationError);
    const details = (error as MigrationError).details;
    console.log("legacy history upgrade refusal:", JSON.stringify(details));
    if (details.reason !== "ontology-tightening-violated") {
      throw new Error(
        `expected ontology-tightening-violated, got ${details.reason}`,
      );
    }
    expect(details.violations).toEqual([
      {
        family: "compositionWindowOverlap",
        partKind: "Clip",
        partId: "clip",
        edgeIds: ["in-show-0", "in-show-1"],
      },
    ]);
    expect(
      requireDefined(await getActiveSchema(backend, LEGACY_HISTORY_GRAPH_ID))
        .version,
    ).toBe(INITIAL_VERSION);
  });

  it("migrates the same upgrade when the part's history abuts", async () => {
    const backend = await backendWithLegacyHistory([
      {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2021-01-01T00:00:00.000Z",
      },
      {
        validFrom: "2021-01-01T00:00:00.000Z",
        validTo: "2023-01-01T00:00:00.000Z",
      },
    ]);

    const [store, result] = await createStoreWithSchema(
      historyWithVia,
      backend,
    );

    expect(result.status).toBe("migrated");
    expect(await store.verifyConstraintFences()).toEqual([]);
  });
});
