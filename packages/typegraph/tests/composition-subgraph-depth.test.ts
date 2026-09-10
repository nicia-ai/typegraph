/**
 * `subgraph({ composition: true })` returns the COMPLETE owned unit at any
 * depth — including a part chain longer than `MAX_EXPLICIT_RECURSIVE_DEPTH`,
 * the hop ceiling every explicit traversal is capped at.
 *
 * A dedicated file rather than a case in the cross-backend suite: the chain
 * has to be longer than 1000 hops to say anything, and paying that on every
 * engine's lane buys no parity signal — the closure is ONE shared SQL builder
 * (`buildExhaustiveDirectedReachableCte`), and the cross-backend suite already
 * exercises it on every backend with shallow trees
 * (`tests/backends/integration/composition-navigation.ts`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import { type GraphBackend } from "../src/backend/types";
import { MAX_EXPLICIT_RECURSIVE_DEPTH } from "../src/query/compiler/recursive";
import { type CompiledRowsSql } from "../src/query/sql-intent";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const SdFolder = defineNode("SdFolder", {
  schema: z.object({ depth: z.number().int() }),
});
const sdParentFolder = defineEdge("sdParentFolder", { schema: z.object({}) });

/**
 * A reflexive composition pair: one kind whose parts are its own kind, which
 * is the only shape that can build an arbitrarily deep part chain without
 * declaring one node kind per level.
 */
function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { SdFolder: { type: SdFolder } },
    edges: {
      sdParentFolder: {
        type: sdParentFolder,
        from: [SdFolder],
        to: [SdFolder],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(SdFolder, SdFolder, { via: sdParentFolder, partSide: "from" }),
    ],
  });
}

/**
 * An engine that stopped the statement, in the shape
 * `isStatementCutShortError` classifies structurally (never by message):
 * SQLite's `SQLITE_INTERRUPT`, which is how a statement timeout is delivered
 * on this engine.
 */
function interruptingBackend(
  base: GraphBackend,
  shouldInterrupt: (text: string) => boolean,
): GraphBackend {
  return deriveBackend(base, {
    execute: async <T>(compiled: CompiledRowsSql): Promise<readonly T[]> => {
      const text = compiled.chunks
        .map((chunk) => (chunk.kind === "text" ? chunk.value : ""))
        .join("");
      if (shouldInterrupt(text)) {
        throw Object.assign(new Error("interrupted"), {
          code: "SQLITE_INTERRUPT",
        });
      }
      return base.execute<T>(compiled);
    },
  });
}

/** Two levels past the ceiling, so truncation at it is unmistakable. */
const CHAIN_LENGTH = MAX_EXPLICIT_RECURSIVE_DEPTH + 2;

describe("subgraph({ composition: true }) completeness", () => {
  it(`returns every part of a chain ${CHAIN_LENGTH} levels deep`, async () => {
    const backend = createTestBackend();
    const [store] = await createStoreWithSchema(
      buildGraph("sd_deep_chain"),
      backend,
    );

    // One batch: every row is inserted before any composition edge is
    // attached, so each item can name the item above it as its whole.
    const ids = Array.from(
      { length: CHAIN_LENGTH },
      (_unused, index) => `sd-folder-${String(index).padStart(5, "0")}`,
    );
    await store.nodes.SdFolder.bulkCreate(
      ids.map((id, index) => ({
        id,
        props: { depth: index },
        ...(index === 0 ?
          {}
        : {
            partOf: {
              kind: "SdFolder" as const,
              id: requireDefined(ids[index - 1]),
            },
          }),
      })),
    );

    const root = asNodeId<typeof SdFolder>(requireDefined(ids[0]));
    // MUTATION CHECK: bound the closure by hops again — pass
    // `maxHops: MAX_EXPLICIT_RECURSIVE_DEPTH` (with `cyclePolicy: "prevent"`)
    // through a hop-bounded builder in `buildSubgraphCompositionReachableCte`
    // (src/store/subgraph.ts) instead of
    // `buildExhaustiveDirectedReachableCte`. The unit then comes back
    // truncated at the ceiling — 1001 nodes instead of 1002 — which is the
    // silent partial export this test exists to forbid.
    const unit = await store.subgraph(root, { edges: [], composition: true });

    expect(unit.nodes.size).toBe(CHAIN_LENGTH);
    // Every level's realizing edge came back with it.
    const attachments = [...unit.reverseAdjacency.values()].flatMap(
      (byKind) => byKind.get("sdParentFolder") ?? [],
    );
    expect(attachments).toHaveLength(CHAIN_LENGTH - 1);
    // The deepest leaf — the first row a hop ceiling drops — is present.
    const depths = [...unit.nodes.values()].map((node) => node.depth);
    expect(Math.max(...depths)).toBe(CHAIN_LENGTH - 1);
  });

  it("refuses with a typed error when the engine cuts the closure statement short", async () => {
    const base = createTestBackend();
    // Only the composition closure's own statement is interrupted. Its
    // frontier is exactly `(id, kind)` — the set-semantics shape that makes it
    // exhaustive — where the caller's `edges` traversal carries `depth` and
    // `path` columns, so the column list tells the two apart.
    const backend = interruptingBackend(base, (text) =>
      text.includes("RECURSIVE reachable(id, kind)"),
    );
    const [store] = await createStoreWithSchema(
      buildGraph("sd_cut_short"),
      backend,
    );

    const parent = await store.nodes.SdFolder.create({ depth: 0 });
    await store.nodes.SdFolder.create(
      { depth: 1 },
      { partOf: { kind: "SdFolder", id: parent.id } },
    );

    // MUTATION CHECK: drop the `isStatementCutShortError` arm from
    // `fetchCompositionClosureIds` (src/store/subgraph.ts) — the caller then
    // gets the raw driver error, indistinguishable from a transport failure,
    // and the "delivered or refused, never partial" promise has no refusal
    // behind it.
    const refusal = await store
      .subgraph(parent.id, { edges: [], composition: true })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ConfigurationError);
    const details = (refusal as ConfigurationError).details;
    expect(details["code"]).toBe("COMPOSITION_UNIT_INDETERMINATE");
    expect(details["rootId"]).toBe(parent.id);
    expect((refusal as ConfigurationError).cause).toMatchObject({
      code: "SQLITE_INTERRUPT",
    });
  });
});
