import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createLocalSqliteBackend } from "../../../src/backend/sqlite/local";
import { importGraph } from "../../../src/interchange";
import { openStore, PAST_FROM, PAST_TO, payload } from "./fixture";

describe("import-state findings", () => {
  it("import-ended-oneactive-attachment-accepted", async () => {
    const { store, backend } = await openStore("oneActive");
    try {
      const root = await store.nodes.IsRoot.create({});
      const result = await importGraph(
        store,
        payload({
          nodes: [{ kind: "IsMid", id: "mid1", properties: {} }],
          edges: [
            {
              kind: "isMidOf",
              id: "e1",
              from: { kind: "IsMid", id: "mid1" },
              to: { kind: "IsRoot", id: root.id },
              properties: {},
              validFrom: PAST_FROM,
              validTo: PAST_TO,
            },
          ],
        }),
        { onConflict: "error" },
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(await store.nodes.IsMid.getById("mid1" as never)).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it("import-update-ends-live-required-attachment", async () => {
    const { store, backend } = await openStore("oneActive");
    try {
      const root = await store.nodes.IsRoot.create({});
      const mid = await store.nodes.IsMid.create(
        {},
        {
          partOf: {
            whole: { kind: "IsRoot", id: root.id },
            validFrom: PAST_FROM,
          },
        },
      );
      const [attachment] = await store.edges.isMidOf.find({});
      const result = await importGraph(
        store,
        payload({
          nodes: [],
          edges: [
            {
              kind: "isMidOf",
              id: attachment!.id,
              from: { kind: "IsMid", id: mid.id },
              to: { kind: "IsRoot", id: root.id },
              properties: {},
              validFrom: PAST_FROM,
              validTo: PAST_TO,
            },
          ],
        }),
        { onConflict: "update" },
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
      expect(result.edges.updated).toBe(0);
    } finally {
      await backend.close();
    }
  });

  it("import-purge-leaves-required-descendant-orphaned", async () => {
    const { store, backend } = await openStore("one");
    try {
      const result = await importGraph(
        store,
        payload({
          nodes: [
            { kind: "IsMid", id: "mid1", properties: {} },
            { kind: "IsLeaf", id: "leaf1", properties: {} },
          ],
          edges: [
            {
              kind: "isLeafOf",
              id: "e1",
              from: { kind: "IsLeaf", id: "leaf1" },
              to: { kind: "IsMid", id: "mid1" },
              properties: {},
            },
          ],
        }),
        { onConflict: "error" },
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
      const liveNodes =
        (await store.nodes.IsMid.find({})).length +
        (await store.nodes.IsLeaf.find({})).length;
      expect(result.nodes.created).toBe(liveNodes);
      expect(result.edges.created).toBe(
        (await store.edges.isLeafOf.find({})).length,
      );
    } finally {
      await backend.close();
    }
  });

  it("import-validate-references-false-ghost-whole", async () => {
    const { store, backend } = await openStore("one");
    try {
      await importGraph(
        store,
        payload({
          nodes: [{ kind: "IsMid", id: "mid1", properties: {} }],
          edges: [
            {
              kind: "isMidOf",
              id: "e1",
              from: { kind: "IsMid", id: "mid1" },
              to: { kind: "IsRoot", id: "ghost" },
              properties: {},
            },
          ],
        }),
        { onConflict: "error", validateReferences: false },
      );
      expect(await store.verifyConstraintFences()).toEqual([]);
    } finally {
      await backend.close();
    }
  });

  it("import-purge-stale-edge-counts", async () => {
    const Seg = defineNode("PsSeg", { schema: z.object({}) });
    const Ep = defineNode("PsEp", { schema: z.object({}) });
    const Tag = defineNode("PsTag", { schema: z.object({}) });
    const segOf = defineEdge("psSegOf", { schema: z.object({}) });
    const taggedBy = defineEdge("psTaggedBy", { schema: z.object({}) });
    const graph = defineGraph({
      id: "ps-purge-counts",
      nodes: { PsSeg: { type: Seg }, PsEp: { type: Ep }, PsTag: { type: Tag } },
      edges: {
        psSegOf: { type: segOf, from: [Seg], to: [Ep], cardinality: "one" },
        psTaggedBy: { type: taggedBy, from: [Seg], to: [Tag] },
      },
      ontology: [partOf(Seg, Ep, { via: segOf, existence: "required" })],
    });
    const { backend } = createLocalSqliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      const result = await importGraph(
        store,
        payload({
          nodes: [
            { kind: "PsSeg", id: "s1", properties: {} },
            { kind: "PsTag", id: "t1", properties: {} },
          ],
          edges: [
            {
              kind: "psTaggedBy",
              id: "tb1",
              from: { kind: "PsSeg", id: "s1" },
              to: { kind: "PsTag", id: "t1" },
              properties: {},
            },
          ],
        }),
        { onConflict: "error" },
      );
      expect(result.edges.created).toBe(
        (await store.edges.psTaggedBy.find({})).length,
      );
    } finally {
      await backend.close();
    }
  });
});
