/**
 * Interchange of composition HISTORY: an ended `oneActive` composition row is
 * the record of a move, not a current attachment.
 *
 * Its meaning lives in its `validTo`, so the export carries temporal fields
 * for any graph with an active-only cardinality axis (a `oneActive`
 * composition pair included) and refuses to drop them, and the import judges
 * each ended row the way the store does: outside the composition relation's
 * claim and its acyclicity probe. A composition window that starts or ends
 * later than now is refused per row, as on every store write.
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
import {
  exportGraph,
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../src/interchange";
import { compareStrings } from "../../src/utils/compare";
import { createTestBackend } from "../test-utils";

const ChShow = defineNode("ChShow", { schema: z.object({}) });
const ChClip = defineNode("ChClip", { schema: z.object({}) });
const ChSection = defineNode("ChSection", { schema: z.object({}) });
const chClipOf = defineEdge("chClipOf", { schema: z.object({}) });
const chSectionOf = defineEdge("chSectionOf", { schema: z.object({}) });

const graph = defineGraph({
  id: "composition_history_roundtrip",
  nodes: {
    ChShow: { type: ChShow },
    ChClip: { type: ChClip },
    ChSection: { type: ChSection },
  },
  edges: {
    chClipOf: {
      type: chClipOf,
      from: [ChClip],
      to: [ChShow],
      cardinality: "oneActive",
    },
    chSectionOf: {
      type: chSectionOf,
      from: [ChSection],
      to: [ChSection],
      cardinality: "oneActive",
    },
  },
  ontology: [
    partOf(ChClip, ChShow, { via: chClipOf, existence: "required" }),
    partOf(ChSection, ChSection, { via: chSectionOf, partSide: "from" }),
  ],
});

function attachments(
  edges: readonly Readonly<{ fromId: string; toId: string }>[],
): readonly string[] {
  return edges
    .map((edge) => `${edge.fromId}->${edge.toId}`)
    .toSorted(compareStrings);
}

describe("composition history through export and import", () => {
  it("exports every composition window by default, so each reparented part re-imports under its current whole", async () => {
    const [source] = await createStoreWithSchema(graph, createTestBackend());
    const before = await source.nodes.ChShow.create({}, { id: "show-before" });
    const after = await source.nodes.ChShow.create({}, { id: "show-after" });
    for (let index = 0; index < 8; index += 1) {
      const clip = await source.nodes.ChClip.create(
        {},
        { id: `clip-${String(index)}`, partOf: { whole: before } },
      );
      await source.nodes.ChClip.reparent(clip.id, { whole: after });
    }

    // MUTATION CHECK: return `undefined` from `requiredTemporalFieldsRefusal`
    // for a graph without identity (src/interchange/export.ts) — the default
    // export then drops every `validTo`, each ended row re-imports as a
    // current attachment, and whichever of a part's two rows sorts first by
    // id takes its claim.
    const data = await exportGraph(source);
    expect(data.edges).toHaveLength(16);
    expect(
      data.edges.filter((edge) => edge.validTo !== undefined),
    ).toHaveLength(8);

    const [target] = await createStoreWithSchema(graph, createTestBackend());
    const result = await importGraph(target, data, { onConflict: "error" });
    expect(result.errors).toEqual([]);
    const current = await target.edges.chClipOf.find({});
    expect(current.every((edge) => edge.toId === after.id)).toBe(true);
    expect(
      await target.edges.chClipOf.find({}, { temporalMode: "includeEnded" }),
    ).toHaveLength(16);
    expect(await target.verifyConstraintFences()).toEqual([]);
  });

  it("refuses an export that disables temporal fields on a graph with an active-only cardinality", async () => {
    const [source] = await createStoreWithSchema(graph, createTestBackend());

    await expect(
      exportGraph(source, { includeTemporal: false }),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "ACTIVE_CARDINALITY_EXPORT_REQUIRES_TEMPORAL_FIELDS",
        edgeKinds: ["chClipOf", "chSectionOf"],
      },
    });
  });

  it("re-imports a reflexive composition history in either row order", async () => {
    const [source] = await createStoreWithSchema(graph, createTestBackend());
    const part = await source.nodes.ChSection.create({});
    const formerWhole = await source.nodes.ChSection.create({});
    const currentWhole = await source.nodes.ChSection.create({});
    await source.edges.chSectionOf.create(part, formerWhole, {});
    await source.nodes.ChSection.reparent(part.id, { whole: currentWhole });
    // The former whole now sits under the part: legal, because the row that
    // put the part under it is history.
    await source.edges.chSectionOf.create(formerWhole, part, {});
    expect(await source.verifyConstraintFences()).toEqual([]);
    const data = await exportGraph(source);

    // MUTATION CHECK: hand import's per-row acyclicity probe
    // (`processEdge`, src/interchange/import.ts) `validTo: undefined` — the
    // history row is then probed as a live member and refused as closing a
    // cycle in whichever order lands it after `formerWhole -> part`.
    for (const edges of [data.edges, [...data.edges].toReversed()]) {
      const [target] = await createStoreWithSchema(graph, createTestBackend());
      const result = await importGraph(
        target,
        { ...data, edges },
        { onConflict: "error" },
      );
      expect(result.errors).toEqual([]);
      expect(attachments(await target.edges.chSectionOf.find({}))).toEqual(
        attachments(await source.edges.chSectionOf.find({})),
      );
      expect(
        await target.edges.chSectionOf.find(
          {},
          { temporalMode: "includeEnded" },
        ),
      ).toHaveLength(3);
      expect(await target.verifyConstraintFences()).toEqual([]);
    }
  });

  it("reports a composition edge whose window ends or starts later than now as a per-row error", async () => {
    const [target] = await createStoreWithSchema(graph, createTestBackend());
    const whole = await target.nodes.ChSection.create({}, { id: "whole" });
    const later = "2999-01-01T00:00:00.000Z";
    const document: GraphData = {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: { type: "external", description: "future composition windows" },
      nodes: [
        { kind: "ChSection", id: "part-ends", properties: {} },
        { kind: "ChSection", id: "part-starts", properties: {} },
      ],
      edges: [
        {
          kind: "chSectionOf",
          id: "ends-later",
          from: { kind: "ChSection", id: "part-ends" },
          to: { kind: "ChSection", id: whole.id },
          properties: {},
          validTo: later,
        },
        {
          kind: "chSectionOf",
          id: "starts-later",
          from: { kind: "ChSection", id: "part-starts" },
          to: { kind: "ChSection", id: whole.id },
          properties: {},
          validFrom: later,
        },
      ],
    };

    // MUTATION CHECK: drop `importedCompositionWindowError` from the edge
    // validity checks in src/interchange/import.ts — both rows then import,
    // one a membership that silently ends later, the other one that starts
    // later, and `errors` is empty.
    const result = await importGraph(target, document, { onConflict: "error" });
    expect(
      result.errors
        .map((error) => [error.id, error.error.split(":")[0]])
        .toSorted((left, right) =>
          compareStrings(String(left[0]), String(right[0])),
        ),
    ).toEqual([
      ["ends-later", "COMPOSITION_VALIDITY_FUTURE_END"],
      ["starts-later", "COMPOSITION_VALIDITY_FUTURE_START"],
    ]);
    expect(
      await target.edges.chSectionOf.find({}, { temporalMode: "includeEnded" }),
    ).toEqual([]);
  });
});
