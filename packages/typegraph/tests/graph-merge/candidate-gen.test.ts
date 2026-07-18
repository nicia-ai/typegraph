import type { GraphBackend, Node } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { blockNodes } from "../../src/graph-merge/blocking";
import type { CandidateEdge } from "../../src/graph-merge/candidate-gen";
import { generateCandidates } from "../../src/graph-merge/candidate-gen";
import {
  MergeError,
  SimilarityUnavailableError,
} from "../../src/graph-merge/errors";
import { idOf } from "../../src/graph-merge/node-key";
import { isErr, isOk } from "../../src/graph-merge/result";
import type { SimilarityContext } from "../../src/graph-merge/similarity";
import type {
  ResolveConfig,
  SimilarityStrategy,
} from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, fakeEmbeddings } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string().optional(),
  }),
});

const patientGraph = defineGraph({
  id: "candidate-gen-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type PatientNode = Node<typeof Patient>;

const DEMO_THRESHOLD = 0.85;

const fulltextName: SimilarityStrategy = {
  kind: "fulltext",
  fields: ["name"],
};

const blockByBirthDate: Pick<ResolveConfig, "block"> = {
  block: (node) => (node as unknown as { birthDate?: string }).birthDate,
};

/**
 * A stable, comparable view of an edge set: bare `a|b` id keys (drops the float
 * score). Endpoints are composite `(kind, id)` keys; project them to bare ids so the
 * single-kind expectations read in plain ids.
 */
function edgeKeys(edges: readonly CandidateEdge[]): string[] {
  return edges.map((edge) => `${idOf(edge.a)}|${idOf(edge.b)}`);
}

async function makeHarness(backend: GraphBackend): Promise<
  Readonly<{
    create: (name: string, birthDate?: string) => Promise<PatientNode>;
    ctx: SimilarityContext;
  }>
> {
  const [store] = await createStoreWithSchema(patientGraph, backend);
  return {
    create: (name, birthDate) =>
      store.nodes.Patient.create(
        birthDate === undefined ? { name } : { name, birthDate },
      ),
    ctx: { backend },
  };
}

describe.each(backendMatrix())("generateCandidates on $name", (entry) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("only pairs nodes that share a block", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    // A near-duplicate PAIR co-located in the 1974 block — this pair SHOULD emit
    // ("Anna Rivera" ~ "Ana Rivera" = 0.857, above the 0.85 threshold).
    const anna1974 = await harness.create("Anna Rivera", "1974-03-09");
    const ana1974 = await harness.create("Ana Rivera", "1974-03-09");
    // An IDENTICAL-named node in a DIFFERENT block. A perfect-score match, but it
    // shares no block with the 1974 cohort, so it must never be compared.
    const annaOther = await harness.create("Anna Rivera", "1990-01-01");

    const blocks = blockNodes([anna1974, ana1974, annaOther], blockByBirthDate);
    const config: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    const result = generateCandidates(blocks, config, harness.ctx, "error");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // Exactly one edge, within the 1974 block, never crossing blocks — even
      // though annaOther is a perfect name match for anna1974.
      const expected = [anna1974.id, ana1974.id].sort();
      expect(edgeKeys(result.data.edges)).toEqual([
        `${expected[0]}|${expected[1]}`,
      ]);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it("emits an identical edge set regardless of input node ordering", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera", "1974-03-09");
    const ana = await harness.create("Ana Rivera", "1974-03-09");
    const annah = await harness.create("Annah Rivera", "1974-03-09");
    const bob = await harness.create("Bob Lee", "1974-03-09");
    const nodes = [anna, ana, annah, bob];

    const config: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    const forward = generateCandidates(
      blockNodes(nodes, blockByBirthDate),
      config,
      harness.ctx,
      "error",
    );
    const reversed = generateCandidates(
      blockNodes([...nodes].reverse(), blockByBirthDate),
      config,
      harness.ctx,
      "error",
    );
    const rotated = generateCandidates(
      blockNodes(
        [
          requireDefined(nodes[2]),
          requireDefined(nodes[0]),
          requireDefined(nodes[3]),
          requireDefined(nodes[1]),
        ],
        blockByBirthDate,
      ),
      config,
      harness.ctx,
      "error",
    );

    expect(isOk(forward) && isOk(reversed) && isOk(rotated)).toBe(true);
    if (isOk(forward) && isOk(reversed) && isOk(rotated)) {
      expect(edgeKeys(reversed.data.edges)).toEqual(
        edgeKeys(forward.data.edges),
      );
      expect(edgeKeys(rotated.data.edges)).toEqual(
        edgeKeys(forward.data.edges),
      );
      // The output is genuinely sorted by (a, b), not merely stable.
      expect(edgeKeys(forward.data.edges)).toEqual(
        [...edgeKeys(forward.data.edges)].sort(),
      );
      // Only the Anna~Ana pair clears 0.85; Annah (<=0.783) and Bob (0) do not.
      const expected = [anna.id, ana.id].sort();
      expect(edgeKeys(forward.data.edges)).toEqual([
        `${expected[0]}|${expected[1]}`,
      ]);
      for (const edge of forward.data.edges) {
        expect(idOf(edge.a)).not.toBe(bob.id);
        expect(idOf(edge.b)).not.toBe(bob.id);
        expect(idOf(edge.a)).not.toBe(annah.id);
        expect(idOf(edge.b)).not.toBe(annah.id);
      }
    }
  });

  it("respects the threshold boundary (>= emits, just-below drops)", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera", "1974-03-09");
    const ana = await harness.create("Ana Rivera", "1974-03-09");
    const blocks = blockNodes([anna, ana], blockByBirthDate);

    const baseConfig: Omit<ResolveConfig, "threshold"> = {
      ...blockByBirthDate,
      similarity: fulltextName,
    };

    // At a threshold the pair clears, the edge is emitted.
    const clears = generateCandidates(
      blocks,
      { ...baseConfig, threshold: DEMO_THRESHOLD },
      harness.ctx,
      "error",
    );
    expect(isOk(clears)).toBe(true);
    const emittedScore =
      isOk(clears) && clears.data.edges.length === 1 ?
        requireDefined(clears.data.edges[0]).score
      : undefined;
    expect(emittedScore).toBeDefined();

    if (emittedScore !== undefined) {
      // A threshold exactly at the score still emits (>= is inclusive).
      const inclusive = generateCandidates(
        blocks,
        { ...baseConfig, threshold: emittedScore },
        harness.ctx,
        "error",
      );
      expect(isOk(inclusive) && inclusive.data.edges.length === 1).toBe(true);

      // A threshold just ABOVE the score drops the pair.
      const justAbove = generateCandidates(
        blocks,
        { ...baseConfig, threshold: Math.min(1, emittedScore + 1e-9) },
        harness.ctx,
        "error",
      );
      expect(isOk(justAbove) && justAbove.data.edges.length === 0).toBe(true);

      // A threshold of 1 drops any non-identical pair.
      const exactlyOne = generateCandidates(
        blocks,
        { ...baseConfig, threshold: 1 },
        harness.ctx,
        "error",
      );
      expect(isOk(exactlyOne) && exactlyOne.data.edges.length === 0).toBe(true);
    }
  });

  it('maxComparisonsPerKind with "error" fails the merge', async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    // Three nodes in one block => 3 unordered pairs > a ceiling of 2.
    const a = await harness.create("Anna Rivera", "1974-03-09");
    const b = await harness.create("Ana Rivera", "1974-03-09");
    const c = await harness.create("Annah Rivera", "1974-03-09");
    const blocks = blockNodes([a, b, c], blockByBirthDate);
    const config: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    const result = generateCandidates(blocks, config, harness.ctx, "error", 2);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(MergeError);
    }
  });

  it("honours ResolveConfig.keyless: windowing the no-key bucket avoids the all-vs-all ceiling (review #3)", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    // Four nodes with NO block key (undefined birthDate) → all in the "unblocked"
    // bucket. Sorted by name they are: "ana rivera", "anna rivera", "bob lee",
    // "carol king" — the two Riveras adjacent (Dice ≈ 0.857 ≥ 0.85).
    const ana = await harness.create("Ana Rivera");
    const anna = await harness.create("Anna Rivera");
    const bob = await harness.create("Bob Lee");
    const carol = await harness.create("Carol King");
    const blocks = blockNodes([ana, anna, bob, carol], blockByBirthDate);
    const baseConfig: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    // Without keyless: 6 all-vs-all pairs > ceiling 3 → the helper errors.
    const cliff = generateCandidates(
      blocks,
      baseConfig,
      harness.ctx,
      "error",
      3,
    );
    expect(isErr(cliff)).toBe(true);

    // With keyless window=1: 3 windowed pairs (≤ 3) → no ceiling, and only the adjacent
    // Riveras clear the threshold. Proves generateCandidates threads keyless (before the
    // fix it ignored it and still errored).
    const windowed = generateCandidates(
      blocks,
      { ...baseConfig, keyless: { window: 1 } },
      harness.ctx,
      "error",
      3,
    );
    expect(isOk(windowed)).toBe(true);
    if (isOk(windowed)) {
      expect(windowed.data.edges).toHaveLength(1);
      const edge = requireDefined(windowed.data.edges[0]);
      expect(new Set([idOf(edge.a), idOf(edge.b)])).toEqual(
        new Set([ana.id, anna.id]),
      );
    }
  });

  it('maxComparisonsPerKind with "mergeByIdOnly" skips similarity and warns', async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const a = await harness.create("Anna Rivera", "1974-03-09");
    const b = await harness.create("Ana Rivera", "1974-03-09");
    const c = await harness.create("Annah Rivera", "1974-03-09");
    const blocks = blockNodes([a, b, c], blockByBirthDate);
    const config: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    const result = generateCandidates(
      blocks,
      config,
      harness.ctx,
      "mergeByIdOnly",
      2,
    );
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // No candidate edges: the kind merges by id only downstream.
      expect(result.data.edges).toEqual([]);
      expect(result.data.warnings).toHaveLength(1);
      expect(requireDefined(result.data.warnings[0]).kind).toBe(
        "comparisonCeiling",
      );
      expect(requireDefined(result.data.warnings[0]).comparisons).toBe(3);
      expect(requireDefined(result.data.warnings[0]).limit).toBe(2);
    }
  });

  it("does not fire the ceiling when comparisons equal the limit", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    // Two nodes => exactly 1 pair; a ceiling of 1 must NOT trip.
    const a = await harness.create("Anna Rivera", "1974-03-09");
    const b = await harness.create("Ana Rivera", "1974-03-09");
    const blocks = blockNodes([a, b], blockByBirthDate);
    const config: ResolveConfig = {
      ...blockByBirthDate,
      similarity: fulltextName,
      threshold: DEMO_THRESHOLD,
    };

    const result = generateCandidates(blocks, config, harness.ctx, "error", 1);
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.data.edges).toHaveLength(1);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it("propagates SimilarityUnavailableError from a vector strategy with no configured embedder", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const a = await harness.create("Anna Rivera", "1974-03-09");
    const b = await harness.create("Ana Rivera", "1974-03-09");
    const blocks = blockNodes([a, b], blockByBirthDate);
    const vectorConfig: ResolveConfig = {
      ...blockByBirthDate,
      similarity: { kind: "vector", field: "name" },
      threshold: DEMO_THRESHOLD,
    };

    // harness.ctx carries no embeddings -> vector scoring is unavailable.
    const result = generateCandidates(
      blocks,
      vectorConfig,
      harness.ctx,
      "error",
    );
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(SimilarityUnavailableError);
    }
  });

  it("emits a candidate edge for a vector strategy WITH an embedder", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const a = await harness.create("Anna Rivera", "1974-03-09");
    const b = await harness.create("Ana Rivera", "1974-03-09");
    const blocks = blockNodes([a, b], blockByBirthDate);
    const vectorConfig: ResolveConfig = {
      ...blockByBirthDate,
      similarity: { kind: "vector", field: "name" },
      threshold: 0.5,
    };
    const ctx: SimilarityContext = {
      backend: fixture.backend,
      embeddings: await fakeEmbeddings(["Anna Rivera", "Ana Rivera"]),
    };

    const result = generateCandidates(blocks, vectorConfig, ctx, "error");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      // The near-duplicate pair clears the threshold under fake-embedding cosine.
      expect(result.data.edges).toHaveLength(1);
    }
  });
});
