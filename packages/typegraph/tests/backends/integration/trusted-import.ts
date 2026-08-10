import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  TrustedImportError,
} from "../../../src";
import {
  FORMAT_VERSION,
  type GraphData,
  type GraphInterchangeChunk,
  trustedImportGraph,
  trustedImportGraphStream,
} from "../../../src/interchange";
import type { IntegrationTestContext } from "./test-context";

const TrustedPerson = defineNode("CrossBackendTrustedPerson", {
  schema: z.object({ name: z.string() }),
});
const TrustedKnows = defineEdge("crossBackendTrustedKnows", {
  schema: z.object({ since: z.number() }),
});
const graph = defineGraph({
  id: "cross_backend_trusted_import",
  nodes: { CrossBackendTrustedPerson: { type: TrustedPerson } },
  edges: {
    crossBackendTrustedKnows: {
      type: TrustedKnows,
      from: [TrustedPerson],
      to: [TrustedPerson],
      cardinality: "many",
    },
  },
});

const SPECIAL_NAME = 'Alice "quoted" \\ path, {braces}\nand newline';

/** A historical end, so a row stating it alone is BORN ALREADY ENDED. */
const ENDED_AT = "2021-01-01T00:00:00.000Z";
const BEFORE_ENDED_AT = "2020-01-01T00:00:00.000Z";

function payload(): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "cross-backend trusted import" },
    nodes: [
      {
        kind: "CrossBackendTrustedPerson",
        id: "alice",
        properties: { name: SPECIAL_NAME },
      },
      {
        kind: "CrossBackendTrustedPerson",
        id: "bob",
        properties: { name: "Bob" },
      },
    ],
    edges: [
      {
        kind: "crossBackendTrustedKnows",
        id: "alice-knows-bob",
        from: { kind: "CrossBackendTrustedPerson", id: "alice" },
        to: { kind: "CrossBackendTrustedPerson", id: "bob" },
        properties: { since: 2020 },
      },
    ],
  };
}

function* chunks(
  values: readonly GraphInterchangeChunk[],
): Iterable<GraphInterchangeChunk> {
  yield* values;
}

export function registerTrustedImportIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("trusted import", () => {
    it("uses the native path when supported and rejects it explicitly otherwise", async () => {
      const store = await context.createStore(graph);
      const isSupported =
        context.getStore().backend.trustedImport !== undefined;
      const outcome = await trustedImportGraph(store, payload()).then(
        (result) => ({ status: "fulfilled" as const, result }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (isSupported && outcome.status === "rejected") throw outcome.error;
      expect(outcome).toMatchObject(
        isSupported ?
          { status: "fulfilled", result: { nodes: 2, edges: 1 } }
        : {
            status: "rejected",
            error: {
              code: "TRUSTED_IMPORT_ERROR",
              details: { reason: "backend_unsupported" },
            },
          },
      );
      const alice = await store.nodes.CrossBackendTrustedPerson.getById(
        asNodeId<typeof TrustedPerson>("alice"),
      );
      const edge = await store.edges.crossBackendTrustedKnows.getById(
        asEdgeId<typeof TrustedKnows>("alice-knows-bob"),
      );
      expect(alice?.name).toBe(isSupported ? SPECIAL_NAME : undefined);
      expect(edge?.since).toBe(isSupported ? 2020 : undefined);
    });

    it("stores no lower bound for a born-ended streamed row", async () => {
      // Trusted import bypasses the Drizzle insert builders entirely — it binds
      // its own INSERT per dialect for throughput — so it is the one write path
      // that can keep minting rows readable at no coordinate after the builders
      // stop. It carried a private copy of the lower-bound resolver until #407;
      // this is the only test that fails if that copy comes back.
      if (context.getStore().backend.trustedImport === undefined) return;
      const store = await context.createStore(graph);

      const data = payload();
      await trustedImportGraph(store, {
        ...data,
        nodes: data.nodes.map((node) =>
          node.id === "alice" ? { ...node, validTo: ENDED_AT } : node,
        ),
        edges: data.edges.map((edge) => ({ ...edge, validTo: ENDED_AT })),
      });

      const alice = await store.nodes.CrossBackendTrustedPerson.getById(
        asNodeId<typeof TrustedPerson>("alice"),
        { temporalMode: "includeEnded" },
      );
      expect(alice?.meta.validFrom).toBeUndefined();
      expect(alice?.meta.validTo).toBe(ENDED_AT);

      const edge = await store.edges.crossBackendTrustedKnows.getById(
        asEdgeId<typeof TrustedKnows>("alice-knows-bob"),
        { temporalMode: "includeEnded" },
      );
      expect(edge?.meta.validFrom).toBeUndefined();
      expect(edge?.meta.validTo).toBe(ENDED_AT);

      // The point of storing no bound rather than the write instant: the row
      // reads back before its end instead of at no coordinate at all.
      await expect(
        store.nodes.CrossBackendTrustedPerson.getById(
          asNodeId<typeof TrustedPerson>("alice"),
          { temporalMode: "asOf", asOf: BEFORE_ENDED_AT },
        ),
      ).resolves.toBeDefined();
    });

    it("rolls back earlier chunks when the stream fails", async () => {
      const store = await context.createStore(graph);
      const data = payload();
      const { nodes, edges, ...header } = data;
      const outcome = await trustedImportGraphStream(
        store,
        chunks([
          { type: "header", header },
          { type: "nodes", nodes },
          { type: "edges", edges },
          { type: "nodes", nodes: [] },
        ]),
      ).then(
        () => ({ reason: "fulfilled" }),
        (error: unknown) => ({
          reason:
            error instanceof TrustedImportError ?
              error.details["reason"]
            : "unknown",
        }),
      );

      expect(outcome.reason).toBe(
        context.getStore().backend.trustedImport === undefined ?
          "backend_unsupported"
        : "invalid_stream",
      );
      await expect(
        store.nodes.CrossBackendTrustedPerson.getById(
          asNodeId<typeof TrustedPerson>("alice"),
        ),
      ).resolves.toBeUndefined();
    });
  });
}
