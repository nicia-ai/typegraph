/**
 * Item E.2 — validating import and a required-existence composition part.
 *
 * Import writes every node row before any edge row (`processNodes` then
 * `processEdges`), so "does this part's composition edge arrive in the same
 * batch" can only be decided once the payload's whole edge set is known.
 * `pendingRequiredParts` (a frame-scoped accumulator, mirroring
 * `pendingMatchIdentityOwners`'s shape) tracks every required-existence part
 * this import CREATES; `assertImportedRequiredPartsAttached` resolves what
 * remains after both passes against the target (a part already attached
 * before this import is accepted) and records one per-row error — not a
 * thrown abort — for anything still unattached, removing that row's node in
 * the same transaction.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import {
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";
import { requireDefined } from "../../src/utils/presence";

const CeiSegment = defineNode("CeiSegment", { schema: z.object({}) });
const CeiEpisode = defineNode("CeiEpisode", { schema: z.object({}) });

const ceiSegmentOf = defineEdge("ceiSegmentOf", { schema: z.object({}) });

function buildGraph() {
  return defineGraph({
    id: "composition-existence-import",
    nodes: {
      CeiSegment: { type: CeiSegment },
      CeiEpisode: { type: CeiEpisode },
    },
    edges: {
      ceiSegmentOf: {
        type: ceiSegmentOf,
        from: [CeiSegment],
        to: [CeiEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CeiSegment, CeiEpisode, {
        via: ceiSegmentOf,
        existence: "required",
      }),
    ],
  });
}

function payload(data: Pick<GraphData, "nodes" | "edges">): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      type: "external",
      description: "composition-existence-import test",
    },
    ...data,
  };
}

describe("validating import: required composition existence", () => {
  it("accepts a required part whose composition edge is in the same batch", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraph(), backend);
      const episode = await store.nodes.CeiEpisode.create({});

      const result = await importGraph(
        store,
        payload({
          nodes: [{ kind: "CeiSegment", id: "seg-same-batch", properties: {} }],
          edges: [
            {
              kind: "ceiSegmentOf",
              id: "e-same-batch",
              from: { kind: "CeiSegment", id: "seg-same-batch" },
              to: { kind: "CeiEpisode", id: episode.id },
              properties: {},
            },
          ],
        }),
        { onConflict: "error", batchSize: 100 },
      );

      expect(result.errors).toHaveLength(0);
      expect(result.nodes.created).toBe(1);
      const segment = await store.nodes.CeiSegment.getById(
        "seg-same-batch" as never,
      );
      expect(segment).toBeDefined();
    } finally {
      await backend.close();
    }
  });

  it("accepts a required part already attached on the target before this import", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraph(), backend);
      const episode = await store.nodes.CeiEpisode.create({});
      await store.nodes.CeiSegment.create(
        {},
        { partOf: { kind: "CeiEpisode", id: episode.id } },
      );
      const [existingEdge] = await store.edges.ceiSegmentOf.find({});

      // Re-import the SAME part with no edge in this batch at all — it is
      // already attached on the target, so it must be accepted, not refused.
      const result = await importGraph(
        store,
        payload({
          nodes: [
            {
              kind: "CeiSegment",
              id: requireDefined(existingEdge).fromId,
              properties: {},
            },
          ],
          edges: [],
        }),
        { onConflict: "skip", batchSize: 100 },
      );

      expect(result.errors).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it("refuses a required part with neither an in-batch edge nor an existing whole — per-row error, no orphan node row survives, rest of the import commits", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraph(), backend);

      const result = await importGraph(
        store,
        payload({
          nodes: [
            { kind: "CeiSegment", id: "seg-orphan", properties: {} },
            { kind: "CeiEpisode", id: "episode-ok", properties: {} },
          ],
          edges: [],
        }),
        { onConflict: "error", batchSize: 100 },
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.entityType).toBe("node");
      expect(result.errors[0]?.id).toBe("seg-orphan");
      expect(result.errors[0]?.error).toMatch(/requires a whole/u);
      // The rest of the import commits: the unrelated episode row survives.
      expect(
        await store.nodes.CeiEpisode.getById("episode-ok" as never),
      ).toBeDefined();
      // No orphan node row survives for the refused part.
      expect(
        await store.nodes.CeiSegment.getById("seg-orphan" as never),
      ).toBeUndefined();
    } finally {
      await backend.close();
    }
  });
  // MUTATION CHECK: skip the `assertImportedRequiredPartsAttached` call in
  // `runImportWritePlanAttempt` (src/interchange/import.ts) — `seg-orphan`
  // then commits as a live, unattached required part, and the last
  // assertion above (`toBeUndefined()`) fails.
});
