/**
 * Data-validated tightening for a newly-declared composition pair,
 * stacking on the schema-tightening preflight
 * (`src/schema/tightening-preflight.ts`, `prepareSchemaTighteningPreflight`).
 *
 * Before composition constraints existed, `partOf`/`hasPart` classified as `safe` in both directions
 * (shipped that way, pending composition's own constraints — see
 * `src/schema/ontology-change.ts`'s module docblock). Adding the FIRST
 * `partOf`/`hasPart` pair over two edge kinds that already exist as
 * ordinary, independent cardinality-`one` edges is exactly the shape that
 * can be dirty: nothing prevented one part from already holding a live edge
 * under EACH kind before the pair existed to say that is now one whole too
 * many.
 *
 * Each case states, in a comment, the mutation that must make it fail (the
 * revert/mutation check load-bearing tests require).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  MigrationError,
  partOf,
  subClassOf,
} from "../../../src";
import { getActiveSchema, migrateSchema } from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const CtChapter = defineNode("CtChapter", { schema: z.object({}) });
const CtBook = defineNode("CtBook", { schema: z.object({}) });
const CtAnthology = defineNode("CtAnthology", { schema: z.object({}) });

const ctChapterOf = defineEdge("ctChapterOf", { schema: z.object({}) });
const ctIncludedIn = defineEdge("ctIncludedIn", { schema: z.object({}) });

// Fixture for flipping an already-declared pair's `existence`.
const CtSegment = defineNode("CtSegment", { schema: z.object({}) });
const CtEpisode = defineNode("CtEpisode", { schema: z.object({}) });
const ctSegmentOf = defineEdge("ctSegmentOf", { schema: z.object({}) });

function buildFlipGraph(id: string, required: boolean) {
  return defineGraph({
    id,
    nodes: { CtSegment: { type: CtSegment }, CtEpisode: { type: CtEpisode } },
    edges: {
      ctSegmentOf: {
        type: ctSegmentOf,
        from: [CtSegment],
        to: [CtEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CtSegment, CtEpisode, {
        via: ctSegmentOf,
        ...(required ? { existence: "required" as const } : {}),
      }),
    ],
  });
}

// Fixture for two DIFFERENT part kinds sharing one realizing edge kind, only
// one of which is tightened to `existence: "required"`.
const CtTag = defineNode("CtTag", { schema: z.object({}) });
const CtClip = defineNode("CtClip", { schema: z.object({}) });
const CtEpisode2 = defineNode("CtEpisode2", { schema: z.object({}) });
const ctSharedOf = defineEdge("ctSharedOf", { schema: z.object({}) });

function buildSharedEdgeGraph(id: string, clipRequired: boolean) {
  return defineGraph({
    id,
    nodes: {
      CtTag: { type: CtTag },
      CtClip: { type: CtClip },
      CtEpisode2: { type: CtEpisode2 },
    },
    edges: {
      ctSharedOf: {
        type: ctSharedOf,
        from: [CtTag, CtClip],
        to: [CtEpisode2],
        cardinality: "one",
      },
    },
    ontology: [
      // CtTag stays `existence: "optional"` across both versions — an
      // unattached CtTag is legal forever and must never block a commit
      // that only tightens its edge-kind sibling, CtClip.
      partOf(CtTag, CtEpisode2, { via: ctSharedOf }),
      partOf(CtClip, CtEpisode2, {
        via: ctSharedOf,
        ...(clipRequired ? { existence: "required" as const } : {}),
      }),
    ],
  });
}

function buildGraph(id: string, composed: boolean) {
  return defineGraph({
    id,
    nodes: {
      CtChapter: { type: CtChapter },
      CtBook: { type: CtBook },
      CtAnthology: { type: CtAnthology },
    },
    edges: {
      ctChapterOf: {
        type: ctChapterOf,
        from: [CtChapter],
        to: [CtBook],
        cardinality: "one",
      },
      ctIncludedIn: {
        type: ctIncludedIn,
        from: [CtChapter],
        to: [CtAnthology],
        cardinality: "one",
      },
    },
    ...(composed ?
      {
        ontology: [
          partOf(CtChapter, CtBook, { via: ctChapterOf }),
          partOf(CtChapter, CtAnthology, { via: ctIncludedIn }),
        ],
      }
    : {}),
  });
}

// Fixture for a kind that INHERITS a required-existence part obligation by
// becoming a subclass of the declared part kind.
const CtDraft = defineNode("CtDraft", { schema: z.object({}) });

function buildInheritedPartGraph(id: string, draftIsSegment: boolean) {
  return defineGraph({
    id,
    nodes: {
      CtSegment: { type: CtSegment },
      CtEpisode: { type: CtEpisode },
      CtDraft: { type: CtDraft },
    },
    edges: {
      ctSegmentOf: {
        type: ctSegmentOf,
        from: [CtSegment],
        to: [CtEpisode],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(CtSegment, CtEpisode, {
        via: ctSegmentOf,
        existence: "required",
      }),
      ...(draftIsSegment ? [subClassOf(CtDraft, CtSegment)] : []),
    ],
  });
}

// Fixture for a commit that widens the composition relation's population
// rather than adding a pair: two reflexive realizing edges over one kind.
const CtCell = defineNode("CtCell", { schema: z.object({}) });
const ctCellUnder = defineEdge("ctCellUnder", { schema: z.object({}) });
const ctCellIn = defineEdge("ctCellIn", { schema: z.object({}) });

function buildCellGraph(
  id: string,
  under: Readonly<{ cardinality: "one" | "oneActive"; acyclic: boolean }>,
) {
  return defineGraph({
    id,
    nodes: { CtCell: { type: CtCell } },
    edges: {
      ctCellUnder: {
        type: ctCellUnder,
        from: [CtCell],
        to: [CtCell],
        cardinality: under.cardinality,
        ...(under.acyclic ? { acyclic: true } : {}),
      },
      // One part kind holds one composition population, so both realizing
      // edges declare the same one.
      ctCellIn: {
        type: ctCellIn,
        from: [CtCell],
        to: [CtCell],
        cardinality: under.cardinality,
      },
    },
    ontology: [
      partOf(CtCell, CtCell, { via: ctCellUnder, partSide: "from" }),
      partOf(CtCell, CtCell, { via: ctCellIn, partSide: "from" }),
    ],
  });
}

// Fixture for an edge kind dropped with its rows kept, then re-added as a
// composition pair's realizing edge.
const ctVolumeOf = defineEdge("ctVolumeOf", { schema: z.object({}) });

function buildReAddedVolumeGraph(
  id: string,
  state: "plain" | "dropped" | "composed",
) {
  return defineGraph({
    id,
    nodes: { CtChapter: { type: CtChapter }, CtBook: { type: CtBook } },
    edges:
      state === "dropped" ?
        {}
      : {
          ctVolumeOf: {
            type: ctVolumeOf,
            from: [CtChapter],
            to: [CtBook],
            cardinality: "one",
          },
        },
    ...(state === "composed" ?
      { ontology: [partOf(CtChapter, CtBook, { via: ctVolumeOf })] }
    : {}),
  });
}

/** A bound no test run reaches: later than any commit's clock. */
const FUTURE_INSTANT = "2999-01-01T00:00:00.000Z";

function futureWindowViolations(error: unknown): readonly unknown[] {
  expect(error).toBeInstanceOf(MigrationError);
  const details = (error as MigrationError).details;
  if (details.reason !== "ontology-tightening-violated") {
    throw new Error(
      `expected ontology-tightening-violated, got ${details.reason}`,
    );
  }
  return details.violations;
}

/**
 * `part` was under `whole` through `ctCellUnder` — that row is ended history,
 * outside the composition relation — and `whole` now sits under `part`
 * through `via`. Legal while `ctCellUnder` counts only its open rows.
 */
async function seedEndedCompositionCycle(
  context: IntegrationTestContext,
  id: string,
  via: "ctCellUnder" | "ctCellIn",
): Promise<void> {
  const store = await context.createStore(
    buildCellGraph(id, { cardinality: "oneActive", acyclic: false }),
  );
  const part = await store.nodes.CtCell.create({});
  const whole = await store.nodes.CtCell.create({});
  await store.edges.ctCellUnder.create(
    part,
    whole,
    {},
    {
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2021-01-01T00:00:00.000Z",
    },
  );
  await requireDefined(store.getEdgeCollection(via)).create(whole, part, {});
  expect(await store.verifyConstraintFences()).toEqual([]);
}

function expectCompositionCycleRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(MigrationError);
  const details = (error as MigrationError).details;
  if (details.reason !== "ontology-tightening-violated") {
    throw new Error(
      `expected ontology-tightening-violated, got ${details.reason}`,
    );
  }
  expect(details.violations).toContainEqual(
    expect.objectContaining({
      family: "edgeAcyclicity",
      relation: "composition",
    }),
  );
}

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

export function registerCompositionTighteningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("composition tightening (data-validated)", () => {
    it("refuses declaring partOf/hasPart against a part that already has two live wholes", async () => {
      const id = "composition_tightening_dirty";
      const store = await context.createStore(buildGraph(id, false));
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const anthology = await store.nodes.CtAnthology.create({});
      // Both edges are independently valid under the UN-composed schema:
      // each kind's own cardinality axis sees exactly one edge per chapter.
      await store.edges.ctChapterOf.create(chapter, book, {});
      await store.edges.ctIncludedIn.create(chapter, anthology, {});

      const error = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      const compositionViolation = details.violations.find(
        (violation) => violation.family === "composition",
      );
      expect(compositionViolation).toBeDefined();
      if (compositionViolation?.family !== "composition") {
        throw new Error("expected a composition violation");
      }
      expect(compositionViolation.edgeIds).toHaveLength(2);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: flip the `META_EDGE_PART_OF` / `META_EDGE_HAS_PART`
    // arm in `classifyKnownRelationSeverity`
    // (src/schema/ontology-change.ts) back to
    // `{ severity: "safe", probeKinds: [] }` for `"added"`. The commit above
    // then succeeds and `activeVersion` reads 2 instead of 1.

    it("migrates cleanly when the part has exactly one whole", async () => {
      const id = "composition_tightening_clean";
      const store = await context.createStore(buildGraph(id, false));
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      await store.edges.ctChapterOf.create(chapter, book, {});

      const version = await migrateSchema(
        context.getBackend(),
        buildGraph(id, true),
        await activeVersion(context, id),
      );
      expect(version).toBe(2);

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      );
      const anthology = await upgradedStore.nodes.CtAnthology.create({});
      await expect(
        upgradedStore.edges.ctIncludedIn.create(chapter, anthology, {}),
      ).rejects.toMatchObject({ code: "COMPOSITION_WHOLE_OCCUPIED" });
    });

    it("refuses a bulk attach to a second whole when the incumbent predates the declaration", async () => {
      const id = "composition_tightening_clean_bulk";
      const store = await context.createStore(buildGraph(id, false));
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const incumbent = await store.edges.ctChapterOf.create(chapter, book, {});

      await migrateSchema(
        context.getBackend(),
        buildGraph(id, true),
        await activeVersion(context, id),
      );
      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      );
      const anthology = await upgradedStore.nodes.CtAnthology.create({});

      // The incumbent was written before `partOf` existed, so it holds no
      // composition claim row; only the batch claim's incumbent read sees it.
      await expect(
        upgradedStore.edges.ctIncludedIn.bulkCreate([
          { from: chapter, to: anthology },
        ]),
      ).rejects.toMatchObject({
        code: "COMPOSITION_WHOLE_OCCUPIED",
        details: { incumbentEdgeId: incumbent.id },
      });
      expect(await upgradedStore.edges.ctIncludedIn.findFrom(chapter)).toEqual(
        [],
      );
    });
    // MUTATION CHECK: make `readClaimlessIncumbents`
    // (src/backend/drizzle/operation-backend-core.ts) return an empty map.
    // The batch lock then inserts a fresh composition claim for the new edge,
    // the bulk create commits, and the chapter holds two wholes.

    it("names the occupying edge when a single create attaches a second whole, claimed or not", async () => {
      const id = "composition_tightening_incumbent_id";
      const store = await context.createStore(buildGraph(id, false));
      const unclaimedChapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const unclaimed = await store.edges.ctChapterOf.create(
        unclaimedChapter,
        book,
        {},
      );

      await migrateSchema(
        context.getBackend(),
        buildGraph(id, true),
        await activeVersion(context, id),
      );
      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      );
      const anthology = await upgradedStore.nodes.CtAnthology.create({});
      const claimedChapter = await upgradedStore.nodes.CtChapter.create({});
      const claimed = await upgradedStore.edges.ctChapterOf.create(
        claimedChapter,
        book,
        {},
      );

      // Written before `partOf`: the incumbent holds no composition claim
      // row, so the guard's incumbent read is the only thing that names it.
      await expect(
        upgradedStore.edges.ctIncludedIn.create(
          unclaimedChapter,
          anthology,
          {},
        ),
      ).rejects.toMatchObject({
        code: "COMPOSITION_WHOLE_OCCUPIED",
        details: { incumbentEdgeId: unclaimed.id },
      });
      await expect(
        upgradedStore.edges.ctIncludedIn.create(claimedChapter, anthology, {}),
      ).rejects.toMatchObject({
        code: "COMPOSITION_WHOLE_OCCUPIED",
        details: { incumbentEdgeId: claimed.id },
      });
    });
    // MUTATION CHECK: in `claimEdgeCardinalityGuarded`
    // (src/backend/drizzle/operation-backend-core.ts), report the lock's
    // `holder_edge_id` instead of `incumbent_edge_id`. For the unclaimed
    // incumbent the lock inserted the writing edge's own claim, so the
    // refusal names the refused edge rather than `unclaimed.id`.

    it('flipping an already-declared pair to existence: "required" refuses a DIRTY graph directly through ensureSchema, never reaching "breaking-change"', async () => {
      const id = "composition_tightening_flip_required";
      const store = await context.createStore(buildFlipGraph(id, false));
      const orphan = await store.nodes.CtSegment.create({});

      // An in-place `existence` flip classifies as a `modified` change
      // (`classifyExistenceChange`, src/schema/ontology-change.ts) — never
      // as remove + add — so it is backwards-compatible on its own and
      // reaches `prepareSchemaTighteningPreflight` through the ordinary
      // `ensureSchema`/`createAdapterStoreWithSchema` auto-migrate path,
      // exactly like any other `warning`-severity tightening. No explicit
      // `migrateSchema()` call is needed.
      const error = await createAdapterStoreWithSchema(
        buildFlipGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      const violation = details.violations.find(
        (candidate) => candidate.family === "compositionExistence",
      );
      expect(violation).toBeDefined();
      if (violation?.family !== "compositionExistence") {
        throw new Error("expected a compositionExistence violation");
      }
      expect(violation.partKind).toBe("CtSegment");
      expect(violation.parts).toEqual([{ kind: "CtSegment", id: orphan.id }]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: restore `relation.existence ?? ""` as a fifth element
    // of `relationMapKey`'s tuple (src/schema/ontology-change.ts). The flip
    // then diffs as remove (breaking) + add, `createAdapterStoreWithSchema`
    // throws `MigrationError` reason `"breaking-change"` instead of
    // `"ontology-tightening-violated"`, and the test above fails on the
    // `details.reason` check before ever reaching the composition
    // violation assertions.

    it('flipping an already-declared pair to existence: "required" auto-migrates a CLEAN graph directly through ensureSchema', async () => {
      const id = "composition_tightening_flip_required_clean";
      const store = await context.createStore(buildFlipGraph(id, false));
      const segment = await store.nodes.CtSegment.create({});
      const episode = await store.nodes.CtEpisode.create({});
      await store.edges.ctSegmentOf.create(segment, episode, {});

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildFlipGraph(id, true),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      await expect(
        upgradedStore.nodes.CtSegment.create({}),
      ).rejects.toMatchObject({ code: "COMPOSITION_WHOLE_REQUIRED" });
    });
    // MUTATION CHECK: change the `partOf`/`hasPart` `removed` arm in
    // `classifyKnownRelationSeverity` from unconditional `breaking` to
    // `safe`. `classifyExistenceChange` is a separate function so this
    // mutation does not directly touch it, but it demonstrates the OLD
    // fold-into-remove+add path would have reached this exact commit as a
    // (previously refused) breaking change now silently accepted with no
    // data probe at all; the test's `COMPOSITION_WHOLE_REQUIRED`
    // assertion is the behavioral guarantee this test actually pins.

    it('loosening an already-declared pair from existence: "required" to optional is safe and auto-migrates through ensureSchema (a pure loosening is always safe)', async () => {
      const id = "composition_tightening_flip_loosen";
      const store = await context.createStore(buildFlipGraph(id, true));
      const episode = await store.nodes.CtEpisode.create({});
      // `existence: "required"` refuses a bare create with no `partOf` —
      // the episode must exist first, and the segment must name it.
      await store.nodes.CtSegment.create(
        {},
        { partOf: { whole: { kind: "CtEpisode", id: episode.id } } },
      );

      // Loosening never needs a data probe — no `migrateSchema()` call,
      // straight through `ensureSchema`/`createAdapterStoreWithSchema`.
      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildFlipGraph(id, false),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      // What "loosened" means in practice: a part with no live whole is now
      // legal, where it was refused a moment ago.
      await expect(
        upgradedStore.nodes.CtSegment.create({}),
      ).resolves.toBeDefined();
    });
    // MUTATION CHECK: in `classifyExistenceChange`
    // (src/schema/ontology-change.ts), flip the `afterExistence ===
    // "optional"` branch's severity from `"safe"` to `"breaking"`.
    // `createAdapterStoreWithSchema` then throws `MigrationError` reason
    // `"breaking-change"` instead of returning an upgraded store, and this
    // test fails on the destructuring `const [upgradedStore] = await …`.

    it("tightening one part kind never blocks on an unrelated OPTIONAL sibling sharing its edge kind", async () => {
      const id = "composition_tightening_shared_edge_kind";
      const store = await context.createStore(buildSharedEdgeGraph(id, false));
      // Legal forever: CtTag's existence stays "optional" in both versions.
      await store.nodes.CtTag.create({});

      const version = await migrateSchema(
        context.getBackend(),
        buildSharedEdgeGraph(id, true),
        await activeVersion(context, id),
      );
      expect(version).toBe(2);

      const [upgradedStore] = await createAdapterStoreWithSchema(
        buildSharedEdgeGraph(id, true),
        context.getBackend(),
      );
      await expect(upgradedStore.nodes.CtClip.create({})).rejects.toThrow(
        /required/i,
      );
    });
    // MUTATION CHECK: in `readCompositionUnattachedPartsForEdgeKinds`
    // (src/schema/tightening-preflight.ts), drop the
    // `requiredPartKinds.has(concreteKind)` filter (scan every pair sharing
    // the probe's edge kinds, not only the required ones). The unattached
    // CtTag planted above then makes the migration refuse, and `migrateSchema`
    // throws instead of returning `2`.

    it("refuses a subClassOf addition that makes live rows required parts with no whole", async () => {
      const id = "composition_tightening_inherited_required";
      const store = await context.createStore(
        buildInheritedPartGraph(id, false),
      );
      const orphan = await store.nodes.CtDraft.create({});

      const error = await createAdapterStoreWithSchema(
        buildInheritedPartGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.violations).toEqual([
        {
          family: "compositionExistence",
          partKind: "CtDraft",
          parts: [{ kind: "CtDraft", id: orphan.id }],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: drop `"compositionExistence"` from the added
    // `subClassOf`/`equivalentTo`/`sameAs` arm of
    // `classifyKnownRelationSeverity` (src/schema/ontology-change.ts). The
    // commit then migrates, and `createAdapterStoreWithSchema` resolves to a
    // store instead of the `MigrationError` asserted above.

    it("refuses redeclaring a oneActive realizing edge `one` when its ended rows would close a composition cycle", async () => {
      const id = "composition_tightening_population_widened";
      await seedEndedCompositionCycle(context, id, "ctCellUnder");

      // MUTATION CHECK: probe the composition relation only when the commit
      // adds a pair (drop the `compositionRelationWidened` arm of
      // `acyclicRelationsToProbe`, src/schema/tightening-preflight.ts) — the
      // commit then lands, its ended row now counts, and the audit reports the
      // cycle it closes.
      const error = await createAdapterStoreWithSchema(
        buildCellGraph(id, { cardinality: "one", acyclic: false }),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expectCompositionCycleRefusal(error);
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses declaring `acyclic: true` on a composition realizing edge whose ended row closes a cycle through another realizing edge", async () => {
      const id = "composition_tightening_acyclic_widened";
      // The cycle spans two realizing edges, so `ctCellUnder` alone holds
      // none: only the composition relation it widens does.
      await seedEndedCompositionCycle(context, id, "ctCellIn");

      // MUTATION CHECK: probe a newly `acyclic: true` kind only as its own
      // standalone relation (the composition relation left out of
      // `acyclicRelationsToProbe`, src/schema/tightening-preflight.ts) — the
      // commit then lands, and every later write probes the composition
      // relation that already holds the cycle.
      const error = await createAdapterStoreWithSchema(
        buildCellGraph(id, { cardinality: "oneActive", acyclic: true }),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expectCompositionCycleRefusal(error);
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses redeclaring oneActive realizing edges `one` when a part's ended row under one edge kind and open row under another would make two wholes", async () => {
      const id = "composition_tightening_population_widened_occupancy";
      const store = await context.createStore(
        buildCellGraph(id, { cardinality: "oneActive", acyclic: false }),
      );
      const part = await store.nodes.CtCell.create({});
      const formerWhole = await store.nodes.CtCell.create({});
      const currentWhole = await store.nodes.CtCell.create({});
      const endedEdge = await store.edges.ctCellUnder.create(
        part,
        formerWhole,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      const openEdge = await store.edges.ctCellIn.create(
        part,
        currentWhole,
        {},
      );
      expect(await store.verifyConstraintFences()).toEqual([]);

      // MUTATION CHECK: audit composition occupancy only for the edge kinds
      // of pairs the commit adds (drop the widened-membership arm of
      // `compositionDeclarationsToAudit`, src/schema/tightening-preflight.ts).
      // Each edge kind holds one row per part, so the per-kind cardinality
      // probe stays clean, the commit lands, and the audit then reports the
      // part holding two wholes.
      const error = await createAdapterStoreWithSchema(
        buildCellGraph(id, { cardinality: "one", acyclic: false }),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      const compositionViolation = details.violations.find(
        (violation) => violation.family === "composition",
      );
      if (compositionViolation?.family !== "composition") {
        throw new Error(
          `expected a composition violation, got ${JSON.stringify(details.violations)}`,
        );
      }
      expect(compositionViolation.edgeIds.toSorted()).toEqual(
        [endedEdge.id, openEdge.id].toSorted(),
      );
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("auto-migrates the same redeclaration when the part's ended row is its only whole", async () => {
      const id = "composition_tightening_population_widened_clean";
      const store = await context.createStore(
        buildCellGraph(id, { cardinality: "oneActive", acyclic: false }),
      );
      const part = await store.nodes.CtCell.create({});
      const formerWhole = await store.nodes.CtCell.create({});
      await store.edges.ctCellUnder.create(
        part,
        formerWhole,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );

      const [upgradedStore, result] = await createAdapterStoreWithSchema(
        buildCellGraph(id, { cardinality: "one", acyclic: false }),
        context.getBackend(),
      );

      expect(result.status).toBe("migrated");
      expect(await upgradedStore.verifyConstraintFences()).toEqual([]);
    });

    it("refuses declaring partOf/hasPart over edge kinds whose stored rows start or end later than the commit", async () => {
      const id = "composition_tightening_future_window";
      const store = await context.createStore(buildGraph(id, false));
      const endingChapter = await store.nodes.CtChapter.create({});
      const startingChapter = await store.nodes.CtChapter.create({});
      const endedChapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const anthology = await store.nodes.CtAnthology.create({});
      // Legal while neither kind realizes a pair: only a composition edge is
      // held to a window that is not in the future.
      const futureEnd = await store.edges.ctChapterOf.create(
        endingChapter,
        book,
        {},
        { validTo: FUTURE_INSTANT },
      );
      const futureStart = await store.edges.ctIncludedIn.create(
        startingChapter,
        anthology,
        {},
        { validFrom: FUTURE_INSTANT },
      );
      // Ended in the past: settled history, which the pair may adopt.
      await store.edges.ctChapterOf.create(
        endedChapter,
        book,
        {},
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );

      const error = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(futureWindowViolations(error)).toEqual([
        {
          family: "compositionFutureWindow",
          edgeKind: "ctChapterOf",
          edgeIds: [futureEnd.id],
        },
        {
          family: "compositionFutureWindow",
          edgeKind: "ctIncludedIn",
          edgeIds: [futureStart.id],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);

      // Resolving the rows is what lets the same commit through: a deleted
      // row is no longer a composition row at all.
      await store.edges.ctChapterOf.delete(futureEnd.id);
      await store.edges.ctIncludedIn.delete(futureStart.id);
      const [, result] = await createAdapterStoreWithSchema(
        buildGraph(id, true),
        context.getBackend(),
      );
      expect(result.status).toBe("migrated");
    });
    // MUTATION CHECK: drop `futureWindowViolations` from the preflight's
    // violation list in `prepareSchemaTighteningPreflight`
    // (src/schema/tightening-preflight.ts). The first commit then lands with
    // both rows as composition rows and `createAdapterStoreWithSchema`
    // resolves instead of refusing.

    it("refuses re-adding an edge kind as a pair's realizing edge over rows a discarded drop left with a future window", async () => {
      const id = "composition_tightening_future_window_readded";
      const store = await context.createStore(
        buildReAddedVolumeGraph(id, "plain"),
      );
      const chapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      const scheduled = await store.edges.ctVolumeOf.create(
        chapter,
        book,
        {},
        { validTo: FUTURE_INSTANT },
      );
      await migrateSchema(
        context.getBackend(),
        buildReAddedVolumeGraph(id, "dropped"),
        1,
        { discardDroppedKindRows: true },
      );

      const error = await createAdapterStoreWithSchema(
        buildReAddedVolumeGraph(id, "composed"),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(futureWindowViolations(error)).toEqual([
        {
          family: "compositionFutureWindow",
          edgeKind: "ctVolumeOf",
          edgeIds: [scheduled.id],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK: as above — the re-added kind arrives with its pair in
    // the same commit, so the pair's `composition` probe is the only check
    // that reads the left-behind row.

    it("verifyConstraintFences reports a composition row planted with a future window", async () => {
      const id = "composition_tightening_future_window_audit";
      const store = await context.createStore(buildGraph(id, true));
      const chapter = await store.nodes.CtChapter.create({});
      const plantedChapter = await store.nodes.CtChapter.create({});
      const book = await store.nodes.CtBook.create({});
      await store.edges.ctChapterOf.create(chapter, book, {});
      // Beneath the store: no write path would accept this window.
      await store.backend.insertEdge({
        graphId: store.graphId,
        id: "ct-planted-future-end",
        kind: "ctChapterOf",
        fromKind: "CtChapter",
        fromId: plantedChapter.id,
        toKind: "CtBook",
        toId: book.id,
        props: {},
        validTo: FUTURE_INSTANT,
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "compositionFutureWindow",
          edgeKind: "ctChapterOf",
          edgeIds: ["ct-planted-future-end"],
        },
      ]);
    });
    // MUTATION CHECK: drop the `compositionFutureWindow` read from
    // `verifyConstraintFences` (src/store/claims/verify.ts). The audit then
    // reports a clean graph.

    it("auto-migrates the same subClassOf addition when no row of the new part kind exists", async () => {
      const id = "composition_tightening_inherited_required_clean";
      await context.createStore(buildInheritedPartGraph(id, false));

      const [upgradedStore, result] = await createAdapterStoreWithSchema(
        buildInheritedPartGraph(id, true),
        context.getBackend(),
      );

      expect(result.status).toBe("migrated");
      await expect(upgradedStore.nodes.CtDraft.create({})).rejects.toThrow(
        /required/i,
      );
    });
  });
}
