/**
 * A composition move re-imported into a backend whose transaction offers no
 * savepoint: import applies a move's two rows as one unit, and without a
 * savepoint it cannot take the first row back once the second is refused. A
 * refused move therefore aborts the whole import transaction — never a
 * committed half move — while a move that lands needs no rollback at all.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../src";
import {
  projectBackendWithout,
  projectGraphBackend,
} from "../../src/backend/derive-backend";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";
import { createStoreWithSchema } from "../../src/store";
import { requireDefined } from "../../src/utils/presence";

const Part = defineNode("CmsPart", { schema: z.object({}) });
const Whole = defineNode("CmsWhole", { schema: z.object({}) });
const partOfWhole = defineEdge("cmsPartOf", { schema: z.object({}) });

function moveGraph(existence: "optional" | "required") {
  return defineGraph({
    id: `composition_move_import_savepoint_${existence}`,
    nodes: { CmsPart: { type: Part }, CmsWhole: { type: Whole } },
    edges: {
      cmsPartOf: {
        type: partOfWhole,
        from: [Part],
        to: [Whole],
        cardinality: "oneActive",
      },
    },
    ontology: [partOf(Part, Whole, { via: partOfWhole, existence })],
  });
}

const ATTACHED_AT = "2020-01-01T00:00:00.000Z";
const MOVED_AT = "2021-01-01T00:00:00.000Z";
const INSIDE_INCUMBENT = "2020-06-01T00:00:00.000Z";

async function seededWithoutSavepoints(
  existence: "optional" | "required" = "required",
) {
  const graph = moveGraph(existence);
  const { backend } = createLocalSqliteBackend();
  const [setup] = await createStoreWithSchema(graph, backend);
  const oldWhole = await setup.nodes.CmsWhole.create({});
  const newWhole = await setup.nodes.CmsWhole.create({});
  const part = await setup.nodes.CmsPart.create(
    {},
    { partOf: { whole: oldWhole, validFrom: ATTACHED_AT } },
  );
  const [incumbent] = await setup.edges.cmsPartOf.find({});
  // The root verdict promises no statement execution, so no import frame on
  // this store may count on a savepoint.
  const store = createStore(
    graph,
    projectBackendWithout(projectGraphBackend(backend), ["executeStatement"]),
  );
  const move = (attachFrom: string): GraphData => ({
    formatVersion: FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "move without savepoints" },
    nodes: [],
    edges: [
      {
        kind: "cmsPartOf",
        id: requireDefined(incumbent).id,
        from: { kind: "CmsPart", id: part.id },
        to: { kind: "CmsWhole", id: oldWhole.id },
        properties: {},
        validFrom: ATTACHED_AT,
        validTo: MOVED_AT,
      },
      {
        kind: "cmsPartOf",
        id: "cms-moved",
        from: { kind: "CmsPart", id: part.id },
        to: { kind: "CmsWhole", id: newWhole.id },
        properties: {},
        validFrom: attachFrom,
      },
    ],
  });
  const openAttachments = async () => {
    const open = await setup.edges.cmsPartOf.find({});
    return open.map((edge) => edge.toId);
  };
  /** The move's end, then one attach under each of `ids` naming a whole that does not exist. */
  const moveToMissingWhole = (ids: readonly string[]): GraphData => {
    const [end, attach] = move(MOVED_AT).edges;
    return {
      ...move(MOVED_AT),
      edges: [
        requireDefined(end),
        ...ids.map((id) => ({
          ...requireDefined(attach),
          id,
          to: { kind: "CmsWhole", id: "no-such-whole" },
        })),
      ],
    };
  };
  return {
    backend,
    incumbentId: requireDefined(incumbent).id,
    store,
    move,
    moveToMissingWhole,
    openAttachments,
    oldWhole,
    newWhole,
  };
}

describe("composition move import without savepoints", () => {
  it("aborts the import rather than commit the end of a move whose attach was refused", async () => {
    const seeded = await seededWithoutSavepoints();
    try {
      const attempt = importGraph(seeded.store, seeded.move(INSIDE_INCUMBENT), {
        onConflict: "update",
        batchSize: 1,
      });
      await expect(attempt).rejects.toBeInstanceOf(ConfigurationError);
      await expect(attempt).rejects.toMatchObject({
        details: { code: "IMPORT_COMPOSITION_MOVE_REQUIRES_SAVEPOINT" },
      });
      expect(await seeded.openAttachments()).toEqual([seeded.oldWhole.id]);
    } finally {
      await seeded.backend.close();
    }
  });

  it("refuses an optional part's end without a savepoint when every attach is refused before anything is written", async () => {
    // Two distinct attach rows, neither of which can land: the classification
    // alone settles that no row attaches the part again.
    const seeded = await seededWithoutSavepoints("optional");
    try {
      const result = await importGraph(
        seeded.store,
        seeded.moveToMissingWhole(["cms-first", "cms-second"]),
        { onConflict: "update", batchSize: 1 },
      );
      expect(
        result.errors.map((entry) => [entry.id, entry.error.split(":")[0]]),
      ).toEqual([
        ["cms-first", "To node not found"],
        ["cms-second", "To node not found"],
        [seeded.incumbentId, "INTERCHANGE_COMPOSITION_MOVE_INCOMPLETE"],
      ]);
      expect(await seeded.openAttachments()).toEqual([seeded.oldWhole.id]);
    } finally {
      await seeded.backend.close();
    }
  });

  it("aborts the import rather than commit an optional part's end whose attach is refused after the end is written", async () => {
    // The repeat of the refused attach is applied after the end, so only then
    // is the end known to stand alone.
    const seeded = await seededWithoutSavepoints("optional");
    try {
      const attempt = importGraph(
        seeded.store,
        seeded.moveToMissingWhole(["cms-moved", "cms-moved"]),
        {
          onConflict: "update",
          batchSize: 1,
        },
      );
      await expect(attempt).rejects.toMatchObject({
        details: { code: "IMPORT_COMPOSITION_MOVE_REQUIRES_SAVEPOINT" },
      });
      expect(await seeded.openAttachments()).toEqual([seeded.oldWhole.id]);
    } finally {
      await seeded.backend.close();
    }
  });

  it("applies a move that lands without needing a savepoint", async () => {
    const seeded = await seededWithoutSavepoints();
    try {
      const result = await importGraph(seeded.store, seeded.move(MOVED_AT), {
        onConflict: "update",
        batchSize: 1,
      });
      expect(result.errors).toEqual([]);
      expect(await seeded.openAttachments()).toEqual([seeded.newWhole.id]);
    } finally {
      await seeded.backend.close();
    }
  });
});
