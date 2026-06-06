import type { GraphBackend, Node } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { SimilarityUnavailableError } from "../../src/graph-merge/errors";
import { isErr, isOk } from "../../src/graph-merge/result";
import type { SimilarityContext } from "../../src/graph-merge/similarity";
import { diceTrigramSimilarity, scorePair } from "../../src/graph-merge/similarity";
import type { SimilarityStrategy } from "../../src/graph-merge/types";
import {
  backendMatrix,
  createSqliteMergeBackend,
  fakeEmbeddings,
} from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string().optional(),
  }),
});

const patientGraph = defineGraph({
  id: "similarity-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type PatientNode = Node<typeof Patient>;

/** Demo merge threshold frozen by the plan: Sørensen–Dice trigram @ 0.85. */
const DEMO_THRESHOLD = 0.85;

/**
 * Boots a real Patient store on a given backend and yields a node factory plus a
 * {@link SimilarityContext} over that backend. Using a real store keeps the test
 * honest about the public `Node` runtime shape (schema props spread at the top
 * level) the production scorer reads.
 */
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

describe("diceTrigramSimilarity (pure metric)", () => {
  it("is symmetric and bounded in [0, 1]", () => {
    const left = diceTrigramSimilarity("Anna Rivera", "Ana Rivera");
    const right = diceTrigramSimilarity("Ana Rivera", "Anna Rivera");
    expect(left).toBe(right);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(1);
  });

  it("scores an identical string at 1 and a fully-disjoint pair at 0", () => {
    expect(diceTrigramSimilarity("Anna Rivera", "Anna Rivera")).toBe(1);
    // No shared trigrams between these two short, disjoint tokens.
    expect(diceTrigramSimilarity("xyz", "qpw")).toBe(0);
  });

  it("ranks a near-duplicate name above an unrelated one and clears 0.85", () => {
    const close = diceTrigramSimilarity("Anna Rivera", "Ana Rivera");
    const far = diceTrigramSimilarity("Anna Rivera", "Bob Lee");
    expect(close).toBeGreaterThan(far);
    expect(close).toBeGreaterThanOrEqual(DEMO_THRESHOLD);
  });
});

describe.each(backendMatrix())("scorePair on $name", (entry) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("custom strategy is symmetric and clamped into [0, 1]", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera", "1974-03-09");
    const ana = await harness.create("Ana Rivera", "1974-03-09");

    // An asymmetric raw scorer (depends on first arg) that also returns
    // out-of-range values, to prove clamping AND that scorePair forwards the
    // caller's value (the caller owns symmetry).
    const asymmetric: SimilarityStrategy = {
      kind: "custom",
      score: (a) =>
        (a as unknown as { name: string }).name === "Anna Rivera" ? 1.5 : -0.5,
    };

    const forward = scorePair(anna, ana, asymmetric, harness.ctx);
    const reverse = scorePair(ana, anna, asymmetric, harness.ctx);
    expect(isOk(forward)).toBe(true);
    expect(isOk(reverse)).toBe(true);
    if (isOk(forward) && isOk(reverse)) {
      // 1.5 clamps to 1, -0.5 clamps to 0 — both inside the codomain.
      expect(forward.data).toBe(1);
      expect(reverse.data).toBe(0);
    }

    // A genuinely symmetric custom scorer round-trips identically.
    const symmetric: SimilarityStrategy = {
      kind: "custom",
      score: (a, b) =>
        diceTrigramSimilarity(
          (a as unknown as { name: string }).name,
          (b as unknown as { name: string }).name,
        ),
    };
    const sForward = scorePair(anna, ana, symmetric, harness.ctx);
    const sReverse = scorePair(ana, anna, symmetric, harness.ctx);
    expect(isOk(sForward) && isOk(sReverse)).toBe(true);
    if (isOk(sForward) && isOk(sReverse)) {
      expect(sForward.data).toBe(sReverse.data);
    }
  });

  it("fulltext ranks Anna~Ana above Anna~Bob and clears 0.85", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera");
    const ana = await harness.create("Ana Rivera");
    const bob = await harness.create("Bob Lee");

    const strategy: SimilarityStrategy = {
      kind: "fulltext",
      fields: ["name"],
    };

    const close = scorePair(anna, ana, strategy, harness.ctx);
    const far = scorePair(anna, bob, strategy, harness.ctx);
    expect(isOk(close) && isOk(far)).toBe(true);
    if (isOk(close) && isOk(far)) {
      // Relative behavior (per the plan): near-duplicate beats unrelated.
      expect(close.data).toBeGreaterThan(far.data);
      // Absolute behavior: the near-duplicate clears the demo threshold.
      expect(close.data).toBeGreaterThanOrEqual(DEMO_THRESHOLD);
      // And the unrelated pair does NOT clear it.
      expect(far.data).toBeLessThan(DEMO_THRESHOLD);
    }
  });

  it("fulltext scoring is symmetric across multiple fields", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera", "1974-03-09");
    const ana = await harness.create("Ana Rivera", "1974-03-09");

    const strategy: SimilarityStrategy = {
      kind: "fulltext",
      fields: ["name", "birthDate"],
    };
    const forward = scorePair(anna, ana, strategy, harness.ctx);
    const reverse = scorePair(ana, anna, strategy, harness.ctx);
    expect(isOk(forward) && isOk(reverse)).toBe(true);
    if (isOk(forward) && isOk(reverse)) {
      expect(forward.data).toBe(reverse.data);
    }
  });

  it("vector/hybrid with NO embedder configured yields SimilarityUnavailableError", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera");
    const ana = await harness.create("Ana Rivera");

    // harness.ctx carries no `embeddings` — i.e. MergeOptions.embedder was not
    // configured. vector/hybrid then fail with a typed error REGARDLESS of the
    // backend's own vector capability: merge scoring uses an injected in-memory
    // embedder, not the backend's index.
    for (const strategy of [
      { kind: "vector", field: "name" },
      { kind: "hybrid", fields: ["name"] },
    ] as const) {
      const result = scorePair(anna, ana, strategy, harness.ctx);
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(SimilarityUnavailableError);
      }
    }
  });

  it("vector strategy WITH an embedder ranks Anna~Ana above Anna~Bob", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera");
    const ana = await harness.create("Ana Rivera");
    const bob = await harness.create("Bob Lee");

    const ctx: SimilarityContext = {
      backend: fixture.backend,
      embeddings: await fakeEmbeddings([
        "Anna Rivera",
        "Ana Rivera",
        "Bob Lee",
      ]),
    };
    const strategy: SimilarityStrategy = { kind: "vector", field: "name" };

    const close = scorePair(anna, ana, strategy, ctx);
    const far = scorePair(anna, bob, strategy, ctx);
    expect(isOk(close) && isOk(far)).toBe(true);
    if (isOk(close) && isOk(far)) {
      // Cosine is symmetric, in [0, 1], and the near-duplicate beats the
      // unrelated pair (the determinism/relative contract the demo relies on).
      expect(close.data).toBeGreaterThan(far.data);
      expect(close.data).toBeLessThanOrEqual(1);
      expect(far.data).toBeGreaterThanOrEqual(0);
      const reverse = scorePair(ana, anna, strategy, ctx);
      if (isOk(reverse)) {
        expect(reverse.data).toBe(close.data);
      }
    }
  });

  it("hybrid strategy WITH an embedder blends cosine + trigram and ranks Anna~Ana above Anna~Bob", async () => {
    const fixture = await entry.make();
    cleanup = fixture.cleanup;
    const harness = await makeHarness(fixture.backend);

    const anna = await harness.create("Anna Rivera");
    const ana = await harness.create("Ana Rivera");
    const bob = await harness.create("Bob Lee");

    const ctx: SimilarityContext = {
      backend: fixture.backend,
      embeddings: await fakeEmbeddings([
        "Anna Rivera",
        "Ana Rivera",
        "Bob Lee",
      ]),
    };
    const strategy: SimilarityStrategy = { kind: "hybrid", fields: ["name"] };

    const close = scorePair(anna, ana, strategy, ctx);
    const far = scorePair(anna, bob, strategy, ctx);
    expect(isOk(close) && isOk(far)).toBe(true);
    if (isOk(close) && isOk(far)) {
      expect(close.data).toBeGreaterThan(far.data);
      expect(close.data).toBeLessThanOrEqual(1);
      // Symmetric blend.
      const reverse = scorePair(ana, anna, strategy, ctx);
      if (isOk(reverse)) {
        expect(reverse.data).toBe(close.data);
      }
    }
  });
});

describe("scorePair fulltext empty-field guard (F7)", () => {
  const birthDateSimilarity: SimilarityStrategy = {
    kind: "fulltext",
    fields: ["birthDate"],
  };

  it("scores two nodes both missing the configured field as MIN_SCORE, not 1.0", async () => {
    const fixture = createSqliteMergeBackend();
    try {
      const harness = await makeHarness(fixture.backend);
      // Neither patient carries a birthDate, so the configured fulltext field is
      // empty on both. They share NO comparable text — that must NOT score a
      // perfect 1.0 (which would emit a candidate edge and merge two distinct
      // entities). The pure metric still treats empty==empty as vacuously identical.
      const alice = await harness.create("Alice");
      const bob = await harness.create("Bob");
      const score = scorePair(alice, bob, birthDateSimilarity, harness.ctx);
      expect(isOk(score)).toBe(true);
      if (!isOk(score)) {
        return;
      }
      expect(score.data).toBe(0);
      expect(diceTrigramSimilarity("", "")).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });
});
