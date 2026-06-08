/**
 * Step 0 contract: the candidate-SOURCE layer + the shared SCORING stage (§4).
 *
 * Proves the three-layer split (sources → scoring → reconciler) for the two staged
 * sources refactored out of the old fused `generateCandidates`:
 *
 *   - `exactKeySource` PROPOSES fuzzy pairs from the `block()` / unblocked buckets
 *     and decides no match itself (no forced edges, no base members).
 *   - `uniqueSource` PROPOSES forced (definitional) edges from the unique-constraint
 *     buckets and no fuzzy pairs.
 *   - the scoring stage is the single match-decision point: it thresholds fuzzy
 *     pairs, passes forced edges through unscored, and a forced pair is never also
 *     fuzzy-scored.
 *
 * Plus the behaviour-preserving guard: driving the sources through scoring yields
 * the BYTE-IDENTICAL edge set the back-compat `generateCandidates(blocks, …)`
 * composition produces over the same blocked input.
 */

import type { Node, UniqueIntrospection } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { blockNodes } from "../../src/graph-merge/blocking";
import { generateCandidates } from "../../src/graph-merge/candidate-gen";
import {
  compareMergeKeys,
  idOf,
  kindOf,
  mergeKey,
  mergeKeyOf,
} from "../../src/graph-merge/node-key";
import { isOk } from "../../src/graph-merge/result";
import type { CandidateEdge } from "../../src/graph-merge/scoring";
import {
  FORCED_MATCH_SCORE,
  scoreCandidates,
} from "../../src/graph-merge/scoring";
import type { SimilarityContext } from "../../src/graph-merge/similarity";
import {
  exactKeySource,
  forcedEdgesFromBlocks,
  ontologyRetypeEdges,
  pairsFromBlocks,
  uniqueSource,
} from "../../src/graph-merge/sources";
import type {
  ResolveConfig,
  SimilarityStrategy,
} from "../../src/graph-merge/types";
import { createSqliteMergeBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string().optional(),
    mrn: z.string().optional(),
  }),
});

// The store deliberately does NOT declare the `mrn` unique constraint: this suite
// exercises the SIGNATURE-blocking + scoring logic in isolation, hand-feeding the
// constraint to `blockNodes` via {@link MRN_CONSTRAINT}. (In a real merge the
// same-mrn duplicates live in separate branch stores, so no single store enforces
// uniqueness across them.)
const patientGraph = defineGraph({
  id: "sources-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type PatientNode = Node<typeof Patient>;

const DEMO_THRESHOLD = 0.85;

const fulltextName: SimilarityStrategy = { kind: "fulltext", fields: ["name"] };

const blockByBirthDate: ResolveConfig = {
  block: (node) => (node as unknown as { birthDate?: string }).birthDate,
  similarity: fulltextName,
  threshold: DEMO_THRESHOLD,
};

/** The kind's `mrn` unique constraint, as `store.introspect()` would surface it. */
const MRN_CONSTRAINT: readonly UniqueIntrospection[] = [
  { name: "mrn_unique", fields: ["mrn"], scope: "kind", collation: "binary" },
];

/**
 * A stable, comparable view of an edge set: bare `a|b` id keys (drops the float
 * score). Endpoints are composite `(kind, id)` keys; this projects them back to bare
 * ids so the single-kind expectations read in plain ids.
 */
function edgeKeys(edges: readonly CandidateEdge[]): string[] {
  return edges.map((edge) => `${idOf(edge.a)}|${idOf(edge.b)}`);
}

describe("candidate sources + scoring stage (step 0)", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup !== undefined) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function makeFixture(): Promise<
    Readonly<{
      create: (
        props: Readonly<{ name: string; birthDate?: string; mrn?: string }>,
      ) => Promise<PatientNode>;
      ctx: SimilarityContext;
    }>
  > {
    const fixture = createSqliteMergeBackend();
    cleanup = fixture.cleanup;
    const [store] = await createStoreWithSchema(patientGraph, fixture.backend);
    return {
      create: (props) => store.nodes.Patient.create(props),
      ctx: { backend: fixture.backend },
    };
  }

  it("exactKeySource proposes fuzzy pairs from block buckets; nothing forced or base", async () => {
    const { create } = await makeFixture();
    const anna = await create({ name: "Anna Rivera", birthDate: "1974-03-09" });
    const ana = await create({ name: "Ana Rivera", birthDate: "1974-03-09" });
    const other = await create({ name: "Bob Lee", birthDate: "1990-01-01" });

    const blocks = blockNodes([anna, ana, other], blockByBirthDate);
    const produced = await exactKeySource.generate({ kind: "Patient", blocks });

    const proposed = produced.pairs
      .map((pair) => `${idOf(pair.a)}|${idOf(pair.b)}`)
      .sort();
    console.info("[exactKey] proposed pairs:", proposed);
    console.info("[exactKey] forcedEdges:", produced.forcedEdges.length);
    console.info("[exactKey] baseMembers:", produced.baseMembers.length);

    // Only the same-birthDate cohort co-blocks: {anna, ana}. `other` is alone in
    // its block, so no pair references it.
    const expected = [anna.id, ana.id].sort();
    expect(proposed).toEqual([`${expected[0]}|${expected[1]}`]);
    expect(produced.forcedEdges).toEqual([]);
    expect(produced.baseMembers).toEqual([]);
  });

  it("uniqueSource proposes forced (definitional) edges from unique buckets; nothing fuzzy or base", async () => {
    const { create } = await makeFixture();
    // Same mrn, different birthDate, dissimilar names — a definitional match.
    const annaA = await create({
      name: "Anna Rivera",
      birthDate: "1974-03-09",
      mrn: "MRN-1",
    });
    const robertB = await create({
      name: "Robert Smith",
      birthDate: "1990-01-01",
      mrn: "MRN-1",
    });
    const distinct = await create({
      name: "Carol King",
      birthDate: "1980-05-05",
      mrn: "MRN-2",
    });

    const blocks = blockNodes(
      [annaA, robertB, distinct],
      blockByBirthDate,
      MRN_CONSTRAINT,
    );
    const produced = await uniqueSource.generate({ kind: "Patient", blocks });

    console.info(
      "[unique] forced edges:",
      produced.forcedEdges.map((e) => `${idOf(e.a)}|${idOf(e.b)}@${e.score}`),
    );

    const expected = [annaA.id, robertB.id].sort();
    expect(edgeKeys(produced.forcedEdges)).toEqual([
      `${expected[0]}|${expected[1]}`,
    ]);
    expect(produced.forcedEdges[0]?.score).toBe(FORCED_MATCH_SCORE);
    expect(produced.pairs).toEqual([]);
    expect(produced.baseMembers).toEqual([]);
  });

  it("scoring decides fuzzy pairs by threshold and passes forced edges through unscored", async () => {
    const { create, ctx } = await makeFixture();
    const anna = await create({ name: "Anna Rivera", birthDate: "1974-03-09" });
    const ana = await create({ name: "Ana Rivera", birthDate: "1974-03-09" });
    // A second cohort whose names are far apart (~0) and below threshold.
    const x = await create({ name: "Zoe Adams", birthDate: "2000-01-01" });
    const y = await create({ name: "Quinn Webb", birthDate: "2000-01-01" });

    const blocks = blockNodes([anna, ana, x, y], blockByBirthDate);
    const pairs = pairsFromBlocks(blocks);
    const xKey = mergeKeyOf(x);
    const yKey = mergeKeyOf(y);
    const forced: readonly CandidateEdge[] = [
      {
        a: compareMergeKeys(xKey, yKey) <= 0 ? xKey : yKey,
        b: compareMergeKeys(xKey, yKey) <= 0 ? yKey : xKey,
        score: FORCED_MATCH_SCORE,
      },
    ];

    const scored = scoreCandidates(
      { pairs, forcedEdges: forced },
      blockByBirthDate,
      ctx,
      "error",
    );
    expect(isOk(scored)).toBe(true);
    if (!isOk(scored)) {
      return;
    }
    console.info(
      "[scoring] edges:",
      scored.data.edges.map((e) => `${e.a}|${e.b}@${e.score.toFixed(3)}`),
    );

    // anna~ana clears 0.85 → a scored fuzzy edge. x~y would NOT clear the
    // threshold on similarity, but it was FORCED, so it survives at max score.
    const annaAna = [anna.id, ana.id].sort();
    const xy = [x.id, y.id].sort();
    expect(edgeKeys(scored.data.edges).sort()).toEqual(
      [`${annaAna[0]}|${annaAna[1]}`, `${xy[0]}|${xy[1]}`].sort(),
    );
    const forcedEdge = scored.data.edges.find(
      (e) => `${idOf(e.a)}|${idOf(e.b)}` === `${xy[0]}|${xy[1]}`,
    );
    expect(forcedEdge?.score).toBe(FORCED_MATCH_SCORE);
  });

  it("a forced (definitional) pair is never also fuzzy-scored (forced wins dedup)", async () => {
    const { create, ctx } = await makeFixture();
    // The SAME pair appears both as a fuzzy proposal (co-blocked) and forced.
    const anna = await create({ name: "Anna Rivera", birthDate: "1974-03-09" });
    const ana = await create({ name: "Ana Rivera", birthDate: "1974-03-09" });

    const blocks = blockNodes([anna, ana], blockByBirthDate);
    const pairs = pairsFromBlocks(blocks);
    expect(pairs).toHaveLength(1);
    const forced: readonly CandidateEdge[] = [
      { a: pairs[0]!.a, b: pairs[0]!.b, score: FORCED_MATCH_SCORE },
    ];

    const scored = scoreCandidates(
      { pairs, forcedEdges: forced },
      blockByBirthDate,
      ctx,
      "error",
    );
    expect(isOk(scored)).toBe(true);
    if (!isOk(scored)) {
      return;
    }
    // Exactly ONE edge — the forced one — not a forced AND a separate fuzzy edge.
    expect(scored.data.edges).toHaveLength(1);
    expect(scored.data.edges[0]?.score).toBe(FORCED_MATCH_SCORE);
  });

  it("never merges two textless fuzzy pairs, even at threshold 0 (#8)", async () => {
    const { create, ctx } = await makeFixture();
    // Two DISTINCT patients with no value in the scoring field (mrn) — their
    // comparison text is empty on both, so there is no evidence they match.
    const alice = await create({ name: "Alice", birthDate: "1974-03-09" });
    const bob = await create({ name: "Bob", birthDate: "1974-03-09" });

    // threshold 0 would let a MIN_SCORE (0) pair pass `score >= threshold`; the
    // empty-text guard must still exclude the pair (no comparable text).
    const textlessAtZero: ResolveConfig = {
      similarity: { kind: "fulltext", fields: ["mrn"] },
      threshold: 0,
    };

    const blocks = blockNodes([alice, bob], textlessAtZero);
    const pairs = pairsFromBlocks(blocks);
    expect(pairs).toHaveLength(1); // both unblocked → compared all-vs-all

    const scored = scoreCandidates(
      { pairs, forcedEdges: [] },
      textlessAtZero,
      ctx,
      "error",
    );
    expect(isOk(scored)).toBe(true);
    if (!isOk(scored)) {
      return;
    }
    expect(scored.data.edges).toEqual([]);
  });

  it("driving the sources through scoring equals generateCandidates over the same blocks", async () => {
    const { create, ctx } = await makeFixture();
    const annaA = await create({
      name: "Anna Rivera",
      birthDate: "1974-03-09",
      mrn: "MRN-1",
    });
    const robertB = await create({
      name: "Robert Smith",
      birthDate: "1990-01-01",
      mrn: "MRN-1",
    });
    const ana = await create({ name: "Ana Rivera", birthDate: "1974-03-09" });
    const distinct = await create({
      name: "Carol King",
      birthDate: "1980-05-05",
    });

    const nodes = [annaA, robertB, ana, distinct];
    const blocks = blockNodes(nodes, blockByBirthDate, MRN_CONSTRAINT);

    // Path A: drive the sources, then score.
    const fromSources = scoreCandidates(
      {
        pairs: pairsFromBlocks(blocks),
        forcedEdges: forcedEdgesFromBlocks(blocks),
      },
      blockByBirthDate,
      ctx,
      "error",
    );
    // Path B: the back-compat composition.
    const fromGenerate = generateCandidates(
      blocks,
      blockByBirthDate,
      ctx,
      "error",
    );

    expect(isOk(fromSources) && isOk(fromGenerate)).toBe(true);
    if (!isOk(fromSources) || !isOk(fromGenerate)) {
      return;
    }
    console.info("[equivalence] edges:", edgeKeys(fromSources.data.edges));
    expect(fromSources.data.edges).toEqual(fromGenerate.data.edges);
    expect(fromSources.data.warnings).toEqual(fromGenerate.data.warnings);
  });
});

describe("ontologyRetypeEdges (cross-kind ontology retype source)", () => {
  // Stands in for the reconciler's most-specific-common-kind test: only
  // {Doctor, SpecialistDoctor} is subtype-compatible; any set touching another kind
  // (Patient/Encounter siblings) is not.
  const isRetypeCompatible = (kinds: readonly string[]): boolean =>
    [...new Set(kinds)].every(
      (kind) => kind === "Doctor" || kind === "SpecialistDoctor",
    );

  it("fuses same-id subtype-compatible identities; leaves unrelated kinds and single kinds apart", () => {
    const identities = [
      mergeKey("Doctor", "x"),
      mergeKey("SpecialistDoctor", "x"), // compatible at id x → ONE forced edge
      mergeKey("Patient", "y"),
      mergeKey("Encounter", "y"), // unrelated kinds at id y → no edge (no corruption)
      mergeKey("Doctor", "z"), // single kind at id z → no edge
    ];

    const edges = ontologyRetypeEdges(identities, isRetypeCompatible);

    expect(edges).toHaveLength(1);
    const edge = edges[0]!;
    expect(idOf(edge.a)).toBe("x");
    expect(idOf(edge.b)).toBe("x");
    expect(new Set([kindOf(edge.a), kindOf(edge.b)])).toEqual(
      new Set(["Doctor", "SpecialistDoctor"]),
    );
    expect(edge.score).toBe(FORCED_MATCH_SCORE);
  });

  it("partitions a mixed bucket: an unrelated kind at the id does NOT suppress the valid retype pair", () => {
    // Doctor:x / SpecialistDoctor:x are a valid refinement; the unrelated Encounter:x
    // shares the bare id but is its own group, so the Doctor↔SpecialistDoctor edge is
    // still emitted (and Encounter:x stays a separate identity — no corruption).
    const identities = [
      mergeKey("Doctor", "x"),
      mergeKey("SpecialistDoctor", "x"),
      mergeKey("Encounter", "x"),
    ];

    const edges = ontologyRetypeEdges(identities, isRetypeCompatible);

    expect(edges).toHaveLength(1);
    expect(new Set([kindOf(edges[0]!.a), kindOf(edges[0]!.b)])).toEqual(
      new Set(["Doctor", "SpecialistDoctor"]),
    );
    // No edge touches the unrelated Encounter identity.
    const touched = edges.flatMap((edge) => [kindOf(edge.a), kindOf(edge.b)]);
    expect(touched).not.toContain("Encounter");
  });

  it("connects N compatible identities at one id with an (N-1)-edge star anchored at the min", () => {
    const identities = [
      mergeKey("Gamma", "x"),
      mergeKey("Alpha", "x"),
      mergeKey("Beta", "x"),
    ];

    const edges = ontologyRetypeEdges(identities, () => true);

    expect(edges).toHaveLength(2); // 3 identities → star of 2 edges → one cluster
    const min = [...identities].sort(compareMergeKeys)[0]!;
    expect(edges.every((edge) => edge.a === min)).toBe(true);
  });

  it("dedups a repeated identity (same kind+id from two branches) before counting", () => {
    const identities = [
      mergeKey("Doctor", "x"),
      mergeKey("Doctor", "x"), // duplicate identity — one kind at x, not a retype
    ];
    expect(ontologyRetypeEdges(identities, () => true)).toEqual([]);
  });

  it("emits nothing for an empty set or all-distinct ids", () => {
    expect(ontologyRetypeEdges([], () => true)).toEqual([]);
    expect(
      ontologyRetypeEdges(
        [mergeKey("Doctor", "a"), mergeKey("Patient", "b")],
        () => true,
      ),
    ).toEqual([]);
  });

  // A REAL subtype lattice (not the monotone set-membership stand-in above): the
  // set-membership mock is monotone over subsets and so can never model a group that is
  // pairwise-compatible yet whole-group-incompatible — the exact case the whole-group
  // recheck in `ontologyRetypeEdges` exists for. This closure mirrors
  // `mostSpecificCommonKind`: a kind set collapses iff one of its kinds is at-or-below
  // every other (a single most-specific kind).
  const subtypeParent: Readonly<Record<string, string | undefined>> = {
    SpecialistDoctor: "Doctor", // Doctor > SpecialistDoctor
    Surgeon: "Doctor", //          Doctor > Surgeon  (sibling of SpecialistDoctor)
    PediatricSpecialist: "SpecialistDoctor", // SpecialistDoctor > PediatricSpecialist
  };
  const isAtOrBelow = (lower: string, upper: string): boolean => {
    let cursor: string | undefined = lower;
    while (cursor !== undefined) {
      if (cursor === upper) {
        return true;
      }
      cursor = subtypeParent[cursor];
    }
    return false;
  };
  const collapsesToOneKind = (kinds: readonly string[]): boolean => {
    const distinct = [...new Set(kinds)];
    return distinct.some((candidate) =>
      distinct.every((other) => isAtOrBelow(candidate, other)),
    );
  };

  it("does NOT fuse a DIAMOND: pairwise-compatible siblings with no single most-specific kind stay apart", () => {
    // {Doctor, SpecialistDoctor} and {Doctor, Surgeon} each collapse, so union-find
    // pulls all three into one group THROUGH Doctor — but {SpecialistDoctor, Surgeon}
    // are siblings and the whole trio has no single most-specific kind, so the
    // reconciler would FLAG it. The source must refuse to force-fuse it.
    const identities = [
      mergeKey("Doctor", "x"),
      mergeKey("SpecialistDoctor", "x"),
      mergeKey("Surgeon", "x"),
    ];
    expect(ontologyRetypeEdges(identities, collapsesToOneKind)).toEqual([]);
  });

  it("fuses a CHAIN: A<B<C collapses to the single most-specific kind", () => {
    // A genuine chain (each kind below the next) DOES have a single most-specific kind
    // (PediatricSpecialist), so it must still fuse — guarding the whole-group recheck
    // against over-rejecting a valid multi-kind refinement.
    const identities = [
      mergeKey("Doctor", "x"),
      mergeKey("SpecialistDoctor", "x"),
      mergeKey("PediatricSpecialist", "x"),
    ];
    const edges = ontologyRetypeEdges(identities, collapsesToOneKind);
    expect(edges).toHaveLength(2); // 3 identities → star of 2 edges → one cluster
    const min = [...identities].sort(compareMergeKeys)[0]!;
    expect(edges.every((edge) => edge.a === min)).toBe(true);
  });
});
