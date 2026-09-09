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
import { storeRuntime } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";

const CeiSegment = defineNode("CeiSegment", { schema: z.object({}) });
const CeiEpisode = defineNode("CeiEpisode", { schema: z.object({}) });
const CeiTag = defineNode("CeiTag", { schema: z.object({}) });

const ceiSegmentOf = defineEdge("ceiSegmentOf", { schema: z.object({}) });
const ceiTaggedBy = defineEdge("ceiTaggedBy", { schema: z.object({}) });

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

/**
 * Item E.2: the SAME required-existence pair, plus an ordinary (non-composition)
 * edge kind on the part — `CeiTag`, connected via `ceiTaggedBy`. A part
 * refused for lacking a whole may still carry live, non-composition edges
 * this same import created; the purge must not choke on those.
 */
function buildGraphWithTag() {
  return defineGraph({
    id: "composition-existence-import-tagged",
    nodes: {
      CeiSegment: { type: CeiSegment },
      CeiEpisode: { type: CeiEpisode },
      CeiTag: { type: CeiTag },
    },
    edges: {
      ceiSegmentOf: {
        type: ceiSegmentOf,
        from: [CeiSegment],
        to: [CeiEpisode],
        cardinality: "one",
      },
      ceiTaggedBy: {
        type: ceiTaggedBy,
        from: [CeiSegment],
        to: [CeiTag],
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

const CeiOther = defineNode("CeiOther", { schema: z.object({}) });

function buildIdentityEnabledGraph() {
  return defineGraph({
    id: "composition-existence-import-identity",
    nodes: {
      CeiSegment: { type: CeiSegment },
      CeiEpisode: { type: CeiEpisode },
      CeiOther: { type: CeiOther },
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
    identity: { sameIdAcrossKinds: "fold" },
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

  it("refuses an unattached required part that also carries a live, non-composition edge without aborting the whole import", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(buildGraphWithTag(), backend);

      // `seg-1` has no `partOf`/`ceiSegmentOf` edge at all (refused for
      // lacking a whole) but DOES carry a live `ceiTaggedBy` edge to
      // `tag-1` — an ordinary edge this same import creates alongside it.
      const result = await importGraph(
        store,
        payload({
          nodes: [
            { kind: "CeiSegment", id: "seg-1", properties: {} },
            { kind: "CeiTag", id: "tag-1", properties: {} },
          ],
          edges: [
            {
              kind: "ceiTaggedBy",
              id: "e-tag-1",
              from: { kind: "CeiSegment", id: "seg-1" },
              to: { kind: "CeiTag", id: "tag-1" },
              properties: {},
            },
          ],
        }),
        { onConflict: "error", batchSize: 100 },
      );

      // One per-row error for the refused part — not a thrown transaction
      // abort. Before the fix, `session.purgeNode`'s default `restrict`
      // policy saw the still-live `ceiTaggedBy` edge and threw
      // `RestrictedDeleteError` PAST this function's per-row error channel,
      // aborting the whole import.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.entityType).toBe("node");
      expect(result.errors[0]?.id).toBe("seg-1");
      expect(result.errors[0]?.error).toMatch(/requires a whole/u);

      // No orphan CeiSegment row survives for the refused part...
      expect(
        await store.nodes.CeiSegment.getById("seg-1" as never),
      ).toBeUndefined();
      // ...its ordinary edge is gone too (purge is a real hard-delete, not
      // a bare row removal that leaves the edge dangling)...
      expect(await store.edges.ceiTaggedBy.find({})).toHaveLength(0);
      // ...and — this IS the regression's signature — the unrelated
      // CeiTag/tag-1 row this same import created still commits.
      expect(await store.nodes.CeiTag.getById("tag-1" as never)).toBeDefined();
    } finally {
      await backend.close();
    }
  });
  // MUTATION CHECK: in `assertImportedRequiredPartsAttached`
  // (src/interchange/import.ts), drop the `{ enforceDeleteBehavior: false }`
  // argument from the `session.purgeNode` call (revert to the default
  // policy). `purgeNode` then throws `RestrictedDeleteError` for the live
  // `ceiTaggedBy` edge; the surrounding `try`/`catch` still catches it (so
  // the import itself does not abort), but the caught error is
  // `RestrictedDeleteError`'s message, not "requires a whole" — the
  // `result.errors[0].error` assertion above fails — and the segment row is
  // never purged at all (the restrict check runs before any deletion), so
  // the `CeiSegment.getById("seg-1")` assertion fails too.

  it("a purged required part leaves no identity membership behind on an identity-enabled store", async () => {
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(
        buildIdentityEnabledGraph(),
        backend,
      );
      // A materialized 2-member identity class needs a LIVE peer of another
      // kind sharing the same id (`hasMaterializedIdentityClass`'s
      // docblock: a singleton writes no closure row at all) — otherwise the
      // fold this test is about leaves nothing on disk to dangle.
      await store.nodes.CeiOther.create({}, { id: "shared-id" });

      // `foldImportedIdentityNodes` folds this node into identity — pairing
      // it with `CeiOther/shared-id` into one 2-member class — BEFORE
      // `assertImportedRequiredPartsAttached` gets a chance to refuse it
      // (the fold needs the complete node batch; the refusal needs every
      // edge processed too — neither can move ahead of the other). The
      // refusal must undo the fold it inherited, not just the row.
      const result = await importGraph(
        store,
        payload({
          nodes: [{ kind: "CeiSegment", id: "shared-id", properties: {} }],
          edges: [],
        }),
        { onConflict: "error", batchSize: 100 },
      );

      expect(result.errors).toHaveLength(1);
      expect(
        await store.nodes.CeiSegment.getById("shared-id" as never),
      ).toBeUndefined();
      expect(
        await store.nodes.CeiOther.getById("shared-id" as never),
      ).toBeDefined();

      // A dangling identity membership for the purged row would disagree
      // with the closure `validateIdentity()` recomputes from live rows —
      // it must resolve clean, not throw IDENTITY_SCHEMA_CONTRADICTION.
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    } finally {
      await backend.close();
    }
  });
  // MUTATION CHECK: remove the
  // `runtime.detachDeletedImportedIdentityNode(frame.target, ...)` call from
  // `assertImportedRequiredPartsAttached` (src/interchange/import.ts). The
  // `validateIdentity()` assertion above then rejects instead of resolving.
});
