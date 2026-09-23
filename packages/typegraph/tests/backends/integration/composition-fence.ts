/**
 * The composition claim (item E), on every backend.
 *
 * R4: a part holds exactly one whole across every declared `partOf`/
 * `hasPart` pair, enforced by one claim row on the reserved, relation-wide
 * axis in `typegraph_edge_claims` — never one row per realizing edge kind.
 * D-10: the union of every composition-realizing edge kind, oriented part ->
 * whole, is ONE acyclic relation, checked by D.2's exhaustive reachability
 * probe with no code of its own.
 *
 * Each case states, in a comment, the mutation that must make it fail (the
 * revert/mutation check load-bearing tests require).
 *
 * The genuine-concurrency case (below, "two concurrent attaches") is what
 * stands in for a real-PostgreSQL contention test: this suite already runs
 * against the repo's PGlite lane (`tests/backends/postgres/
 * pglite-integration-suite.test.ts`), which is a real PostgreSQL SQL engine,
 * in-process. PGlite is single-connection and cannot demonstrate genuine
 * OS-level interleaving (see `tests/constraint-write-fence.test.ts`'s
 * docblock for the same caveat stated for cardinality), but composition's
 * fence is a claim ROW under a primary key, not a TypeScript-level
 * probe-then-write race window — correctness does not depend on genuine
 * parallelism, only on the database key actually being asked to arbitrate,
 * which `Promise.all` here does regardless of how PGlite schedules the two
 * statements underneath.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompositionError,
  defineEdge,
  defineGraph,
  defineNode,
  EdgeAcyclicityError,
  hasPart,
  partOf,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const CfChapter = defineNode("CfChapter", { schema: z.object({}) });
const CfBook = defineNode("CfBook", { schema: z.object({}) });
const CfAnthology = defineNode("CfAnthology", { schema: z.object({}) });
const CfSection = defineNode("CfSection", { schema: z.object({}) });
const CfCompendium = defineNode("CfCompendium", { schema: z.object({}) });
/**
 * A REFLEXIVE composition part/whole: the declaration-level hierarchical
 * cycle check (`detectHierarchicalCycles`) refuses two OPPOSITE `partOf`
 * declarations across two different kinds outright (a genuine kind-level
 * cycle is refused at `defineGraph` time, never reaching a runtime check at
 * all) — composition's instance-level cycle is only reachable through a
 * reflexive pair on ONE kind, exactly the shape `isReflexiveCompositionAllowed`
 * exempts from that check.
 */
const CfFolder = defineNode("CfFolder", { schema: z.object({}) });
const CfActivePart = defineNode("CfActivePart", { schema: z.object({}) });
const CfActiveWhole = defineNode("CfActiveWhole", { schema: z.object({}) });
const CfOnePart = defineNode("CfOnePart", { schema: z.object({}) });
const CfOneWhole = defineNode("CfOneWhole", { schema: z.object({}) });
/**
 * DualPart -> DualWhole, part `from`, declaring BOTH `cardinality: "one"`
 * (composition's own population axis) AND an orthogonal `targetCardinality:
 * "one"` — the shape that exposed E2/E3: a per-row re-derivation of "is this
 * a composition row" folded a composition edge kind's ORDINARY axis
 * violations onto the reserved composition axis too, regardless of which
 * declaration's query actually produced the row.
 */
const CfDualPart = defineNode("CfDualPart", { schema: z.object({}) });
const CfDualWhole = defineNode("CfDualWhole", { schema: z.object({}) });

/** Chapter -> Book, the ordinary "from"-side-part orientation. */
const cfChapterOf = defineEdge("cfChapterOf", { schema: z.object({}) });
/** Chapter -> Anthology, a SECOND whole kind realized by a different edge kind. */
const cfIncludedIn = defineEdge("cfIncludedIn", { schema: z.object({}) });
/** Section -> Book, "from"-side-part. */
const cfSectionOf = defineEdge("cfSectionOf", { schema: z.object({}) });
/** Anthology -> Section, "to"-side-part (a `has_*`-shaped realizing edge). */
const cfHasSection = defineEdge("cfHasSection", { schema: z.object({}) });
/** Compendium -> Section, a SECOND `has_*`-shaped edge over the same part kind. */
const cfHasSectionAlt = defineEdge("cfHasSectionAlt", { schema: z.object({}) });
/** Folder -> Folder, "from"-side-part: the source folder is part of the target. */
const cfContainsA = defineEdge("cfContainsA", { schema: z.object({}) });
/** Folder -> Folder, "from"-side-part, a SECOND edge kind over the same pair. */
const cfContainsB = defineEdge("cfContainsB", { schema: z.object({}) });
/** Folder -> Folder, "to"-side-part: the TARGET folder is part of the source — the REVERSED member. */
const cfContainsC = defineEdge("cfContainsC", { schema: z.object({}) });
/** ActivePart -> ActiveWhole, population `oneActive`. */
const cfActiveOf = defineEdge("cfActiveOf", { schema: z.object({}) });
/** OnePart -> OneWhole, population `one`. */
const cfOneOf = defineEdge("cfOneOf", { schema: z.object({}) });
/** DualPart -> DualWhole, `cardinality: "one"` AND `targetCardinality: "one"`. */
const cfDualOf = defineEdge("cfDualOf", { schema: z.object({}) });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      CfChapter: { type: CfChapter },
      CfBook: { type: CfBook },
      CfAnthology: { type: CfAnthology },
      CfSection: { type: CfSection },
      CfCompendium: { type: CfCompendium },
      CfFolder: { type: CfFolder },
      CfActivePart: { type: CfActivePart },
      CfActiveWhole: { type: CfActiveWhole },
      CfOnePart: { type: CfOnePart },
      CfOneWhole: { type: CfOneWhole },
      CfDualPart: { type: CfDualPart },
      CfDualWhole: { type: CfDualWhole },
    },
    edges: {
      cfChapterOf: {
        type: cfChapterOf,
        from: [CfChapter],
        to: [CfBook],
        cardinality: "one",
      },
      cfIncludedIn: {
        type: cfIncludedIn,
        from: [CfChapter],
        to: [CfAnthology],
        cardinality: "one",
      },
      cfSectionOf: {
        type: cfSectionOf,
        from: [CfSection],
        to: [CfBook],
        cardinality: "one",
      },
      cfHasSection: {
        type: cfHasSection,
        from: [CfAnthology],
        to: [CfSection],
        targetCardinality: "one",
      },
      cfHasSectionAlt: {
        type: cfHasSectionAlt,
        from: [CfCompendium],
        to: [CfSection],
        targetCardinality: "one",
      },
      cfContainsA: {
        type: cfContainsA,
        from: [CfFolder],
        to: [CfFolder],
        cardinality: "one",
      },
      cfContainsB: {
        type: cfContainsB,
        from: [CfFolder],
        to: [CfFolder],
        cardinality: "one",
      },
      cfContainsC: {
        type: cfContainsC,
        from: [CfFolder],
        to: [CfFolder],
        targetCardinality: "one",
      },
      cfActiveOf: {
        type: cfActiveOf,
        from: [CfActivePart],
        to: [CfActiveWhole],
        cardinality: "oneActive",
      },
      cfOneOf: {
        type: cfOneOf,
        from: [CfOnePart],
        to: [CfOneWhole],
        cardinality: "one",
      },
      cfDualOf: {
        type: cfDualOf,
        from: [CfDualPart],
        to: [CfDualWhole],
        cardinality: "one",
        targetCardinality: "one",
      },
    },
    ontology: [
      partOf(CfChapter, CfBook, { via: cfChapterOf }),
      partOf(CfChapter, CfAnthology, { via: cfIncludedIn }),
      partOf(CfSection, CfBook, { via: cfSectionOf }),
      hasPart(CfAnthology, CfSection, { via: cfHasSection }),
      hasPart(CfCompendium, CfSection, { via: cfHasSectionAlt }),
      partOf(CfFolder, CfFolder, { via: cfContainsA, partSide: "from" }),
      partOf(CfFolder, CfFolder, { via: cfContainsB, partSide: "from" }),
      hasPart(CfFolder, CfFolder, { via: cfContainsC, partSide: "to" }),
      partOf(CfActivePart, CfActiveWhole, { via: cfActiveOf }),
      partOf(CfOnePart, CfOneWhole, { via: cfOneOf }),
      partOf(CfDualPart, CfDualWhole, { via: cfDualOf }),
    ],
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `composition_fence_${graphIdCounter}`;
}

/** Asserts `error` is a `CompositionError` naming `partId` as already occupied. */
function expectWholeOccupied(error: unknown, partId: string): void {
  expect(error).toBeInstanceOf(CompositionError);
  expect((error as CompositionError).details.partId).toBe(partId);
}

export function registerCompositionFenceIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("composition claim (R4: one whole per part, relation-wide)", () => {
    it("refuses a second whole realized by a DIFFERENT edge kind (two-relation single-whole violation)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const chapter = await store.nodes.CfChapter.create({});
      const book = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      await store.edges.cfChapterOf.create(chapter, book, {});

      const error = await store.edges.cfIncludedIn
        .create(chapter, anthology, {})
        .catch((error_: unknown) => error_);
      expectWholeOccupied(error, chapter.id);
      expect((error as CompositionError).details.wholeId).toBe(anthology.id);
      expect((error as CompositionError).details.edgeKind).toBe("cfIncludedIn");
    });
    // MUTATION CHECK: drop the composition claim from `edgeInsertClaims`
    // (src/store/claims/composition-claims.ts) — both per-edge cardinality
    // claims are satisfied independently (chapter has no OTHER cfChapterOf
    // edge, no OTHER cfIncludedIn edge), so this write then succeeds and
    // chapter ends up with two live wholes.

    it("refuses a second whole realized by a DIFFERENT `has_*`-shaped edge kind (both to-side)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const section = await store.nodes.CfSection.create({});
      const anthology = await store.nodes.CfAnthology.create({});
      const compendium = await store.nodes.CfCompendium.create({});

      await store.edges.cfHasSection.create(anthology, section, {});

      const error = await store.edges.cfHasSectionAlt
        .create(compendium, section, {})
        .catch((error_: unknown) => error_);
      expectWholeOccupied(error, section.id);
    });

    it("refuses a second whole across ONE relation in each orientation for the same part kind (one row, one refusal)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const section = await store.nodes.CfSection.create({});
      const book = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      // `cfSectionOf`: the part is the edge's `from` (direction: "source").
      await store.edges.cfSectionOf.create(section, book, {});

      // `cfHasSection`: the part is the SAME section, but as the edge's `to`
      // (direction: "target"). Both claims must fold onto ONE row, or this
      // write would wrongly succeed.
      const error = await store.edges.cfHasSection
        .create(anthology, section, {})
        .catch((error_: unknown) => error_);
      expectWholeOccupied(error, section.id);
    });
    // MUTATION CHECK: force `direction: "source"` unconditionally in
    // `compositionClaim` (src/store/claims/composition-claims.ts). The
    // mixed-orientation case above then writes two DIFFERENT keys (both
    // computed as if `cfHasSection`'s part were its `from` endpoint, i.e.
    // the anthology) and admits two wholes for one section.

    it("refuses a cross-kind cycle over the composition union even though neither edge kind is acyclic alone", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const folderA = await store.nodes.CfFolder.create({});
      const folderB = await store.nodes.CfFolder.create({});

      // folderA partOf folderB via cfContainsA.
      await store.edges.cfContainsA.create(folderA, folderB, {});
      // folderB partOf folderA via cfContainsB (a DIFFERENT realizing edge
      // kind, so this is not merely one relation contending with itself)
      // closes folderA -> folderB -> folderA in the union relation. The two
      // parts (folderA, folderB) are distinct, so R4's claim is untouched —
      // this is purely D-10's acyclicity.
      const error = await store.edges.cfContainsB
        .create(folderB, folderA, {})
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EdgeAcyclicityError);
      // The relation name reaching the public error is the printable
      // "composition", never the reserved U+001E-prefixed claim axis it is
      // stored as internally (R1).
      expect((error as EdgeAcyclicityError).details.relation).toBe(
        "composition",
      );
    });
    // MUTATION CHECK: narrow `compositionAcyclicRelation`
    // (src/store/acyclicity.ts) to return `undefined` (or restrict
    // `registry.compositionEdgeKinds()` to the single edge kind being
    // written). The second create then passes: cfContainsB alone has no
    // cycle.

    it("refuses a cycle formed with a REVERSED (has_*-shaped) member, proving D-10's orientation flag", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const folderA = await store.nodes.CfFolder.create({});
      const folderB = await store.nodes.CfFolder.create({});

      // folderA partOf folderB via cfContainsA (stored A -> B, walked
      // forward: reversed: false).
      await store.edges.cfContainsA.create(folderA, folderB, {});
      // hasPart(folderA, folderB) via cfContainsC means "folderB partOf
      // folderA", but the edge itself is ALSO stored A -> B (cfContainsC's
      // own endpoints, `partSide: "to"`): only walking it REVERSED (B -> A)
      // closes the cycle A -> B -> A. Walked forward (the defect this test
      // exists to catch), the union would see A -> B twice and report no
      // cycle.
      const error = await store.edges.cfContainsC
        .create(folderA, folderB, {})
        .catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(EdgeAcyclicityError);
      expect((error as EdgeAcyclicityError).details.relation).toBe(
        "composition",
      );
    });
    // MUTATION CHECK: hard-code `reversed: false` in `compositionAcyclicRelation`
    // (src/store/acyclicity.ts) instead of reading
    // `registry.compositionPartSide(edgeKind) === "to"`. This case then
    // passes (no cycle found) while the previous one still fails, proving the
    // flag — not just the union's existence — is load-bearing.

    it("`oneActive` reparents once the incumbent's window ends, with no delete required", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const part = await store.nodes.CfActivePart.create({});
      const wholeA = await store.nodes.CfActiveWhole.create({});
      const wholeB = await store.nodes.CfActiveWhole.create({});

      const first = await store.edges.cfActiveOf.create(
        part,
        wholeA,
        {},
        { validFrom: "2019-01-01T00:00:00.000Z" },
      );
      await expect(
        store.edges.cfActiveOf.create(part, wholeB, {}),
      ).rejects.toBeInstanceOf(CompositionError);

      // Ending the window (no delete) frees an ACTIVE-ONLY axis in place.
      await store.edges.cfActiveOf.update(
        first.id,
        {},
        { validTo: "2020-01-01T00:00:00.000Z" },
      );
      await expect(
        store.edges.cfActiveOf.create(part, wholeB, {}),
      ).resolves.toBeDefined();
    });

    it("`one` keeps refusing a reattach until the incumbent edge is actually deleted", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const part = await store.nodes.CfOnePart.create({});
      const wholeA = await store.nodes.CfOneWhole.create({});
      const wholeB = await store.nodes.CfOneWhole.create({});

      const first = await store.edges.cfOneOf.create(
        part,
        wholeA,
        {},
        { validFrom: "2019-01-01T00:00:00.000Z" },
      );
      // Ending the window does NOT free a `claimsWhenBornEnded: true` axis —
      // `one`'s population counts every live edge, active or not.
      await store.edges.cfOneOf.update(
        first.id,
        {},
        { validTo: "2020-01-01T00:00:00.000Z" },
      );
      await expect(
        store.edges.cfOneOf.create(part, wholeB, {}),
      ).rejects.toBeInstanceOf(CompositionError);

      await store.edges.cfOneOf.delete(first.id);
      await expect(
        store.edges.cfOneOf.create(part, wholeB, {}),
      ).resolves.toBeDefined();
    });
    // MUTATION CHECK: force `holderLiveness: "live"` to read as
    // `"liveAndActive"` for `source:one` in `EDGE_CARDINALITY_SPECS`
    // (src/store/claims/edge-claims.ts). The "one" case above then reparents
    // right after `validTo` is set, without the delete, and its first
    // `rejects` assertion fails.

    it("a bulk create of composition edges reserves both parts' axes — no custom-port fallback leaves a partial claim", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const chapterA = await store.nodes.CfChapter.create({});
      const chapterB = await store.nodes.CfChapter.create({});
      const bookA = await store.nodes.CfBook.create({});
      const bookB = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      await store.edges.cfChapterOf.bulkCreate([
        { from: chapterA, to: bookA },
        { from: chapterB, to: bookB },
      ]);

      // Both rows landed...
      expect(await store.edges.cfChapterOf.findFrom(chapterA)).toHaveLength(1);
      expect(await store.edges.cfChapterOf.findFrom(chapterB)).toHaveLength(1);
      // ...and each one's composition claim was genuinely taken: attaching
      // EITHER chapter to a second whole through a different edge kind is
      // still refused. A silently unwritten composition claim (the fused
      // path applying only the ordinary axis) would let this succeed.
      await expect(
        store.edges.cfIncludedIn.create(chapterA, anthology, {}),
      ).rejects.toBeInstanceOf(CompositionError);
    });
    // MUTATION CHECK (verified, reverted, via
    // tests/atomic-generated-edge-batch.test.ts's dedicated eligibility
    // case — this suite's default backend never marks atomic-batch
    // support, so the fused path is not reachable through THIS test):
    // narrowing `compositionAcyclicRelation` to return `undefined` makes
    // `resolveAtomicEdgeBatchExecutor` resolve the fused executor for a
    // composition kind wherever a backend's bundled root declares atomic
    // batch support, and the fused program never applies the composition
    // claim.

    it("a bulk create's stale-claim takeover cannot steal a live incumbent held by a DIFFERENT composition edge kind", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const chapter = await store.nodes.CfChapter.create({});
      const book = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      await store.edges.cfChapterOf.create(chapter, book, {});

      // The batch claim path's initial lock reports an existing holder of a
      // DIFFERENT edge id (`cfChapterOf`'s) than this write's own
      // (`cfIncludedIn`'s), so it falls to the stale-claim takeover
      // statement. That statement's liveness check must read every
      // composition-scope holder kind, not only the WRITING edge's own kind
      // — otherwise the live `cfChapterOf` incumbent is invisible to it and
      // the axis is stolen out from under a still-live edge.
      await expect(
        store.edges.cfIncludedIn.bulkCreate([{ from: chapter, to: anthology }]),
      ).rejects.toBeInstanceOf(CompositionError);

      // The part still holds exactly its original whole.
      expect(await store.edges.cfChapterOf.findFrom(chapter)).toHaveLength(1);
      expect(await store.edges.cfIncludedIn.findFrom(chapter)).toHaveLength(0);
    });
    // MUTATION CHECK: revert the `claimHolderTerms` call inside
    // `recordedClaimHolderIsLivePredicate`, which `buildTakeOverEdgeClaim`
    // reads (src/backend/drizzle/operations/edge-claims.ts), back to the
    // inline `edges.kind = values.edgeKind` +
    // `endpointTerms(...)` spelling. The takeover's liveness sub-select then
    // filters on the WRITING edge's own kind (`cfIncludedIn`) instead of
    // every composition holder kind, finds no live `cfIncludedIn` row at the
    // part, and the stale-claim takeover wrongly succeeds: `bulkCreate`
    // resolves instead of rejecting, and the part ends up with two live
    // wholes (verified, reverted).

    it("self-heals across a DIFFERENT edge kind once the incumbent is hard-deleted behind the store's back", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const backend = store.backend;
      const chapter = await store.nodes.CfChapter.create({});
      const bookA = await store.nodes.CfBook.create({});
      const bookB = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      const incumbent = await store.edges.cfChapterOf.create(
        chapter,
        bookA,
        {},
      );

      await backend.hardDeleteEdge({
        graphId: store.graphId,
        id: incumbent.id,
        kind: "cfChapterOf",
      });

      // The axis self-heals across a DIFFERENT realizing edge kind — the
      // liveness predicate reads the entity relation directly, never a
      // claim-row release path.
      const replacement = await store.edges.cfIncludedIn.create(
        chapter,
        anthology,
        {},
      );
      expect(replacement.toId).toBe(anthology.id);

      // And the axis is genuinely held by the replacement: a third whole
      // through the FIRST edge kind is still refused.
      await expect(
        store.edges.cfChapterOf.create(chapter, bookB, {}),
      ).rejects.toBeInstanceOf(CompositionError);
    });

    it("verifyConstraintFences reports a family: composition violation for a part with two live wholes planted directly", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const backend = store.backend;
      const chapter = await store.nodes.CfChapter.create({});
      const book = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      const first = await store.edges.cfChapterOf.create(chapter, book, {});
      // Bypasses the store entirely — no claim is written for this second
      // row, exactly the shape a trusted import or a pre-upgrade database
      // leaves behind.
      await backend.insertEdge({
        graphId: store.graphId,
        id: "cf-planted-second-whole",
        kind: "cfIncludedIn",
        fromKind: "CfChapter",
        fromId: chapter.id,
        toKind: "CfAnthology",
        toId: anthology.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const compositionViolation = violations.find(
        (violation) => violation.family === "composition",
      );
      expect(compositionViolation).toBeDefined();
      if (compositionViolation?.family !== "composition") {
        throw new Error("expected a composition violation");
      }
      expect([...compositionViolation.edgeIds].toSorted()).toEqual(
        [first.id, "cf-planted-second-whole"].toSorted(),
      );
    });
    // REVERT CHECK: remove the `family: "composition"` arm — i.e. let
    // `edgeCardinalityViolations` (src/store/claims/verify.ts) fold every
    // row through the ordinary per-edge-kind axis unconditionally. The two
    // rows above then fold onto two DIFFERENT axes (`one:cfChapterOf` and
    // `one:cfIncludedIn`), each with exactly one holder, and this test finds
    // a clean graph instead of the violation.

    it("verifyConstraintFences still reports a composition edge kind's OWN orthogonal axis violation (E2/E3)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const backend = store.backend;
      const partA = await store.nodes.CfDualPart.create({});
      const partB = await store.nodes.CfDualPart.create({});
      const whole = await store.nodes.CfDualWhole.create({});

      // Two DIFFERENT parts attached to the SAME whole: a genuine
      // `targetCardinality: "one"` violation on `cfDualOf`'s own ordinary
      // target axis. Neither part holds more than one whole, so this is NOT
      // a composition (R4) violation — planted directly, bypassing the
      // store's claims entirely, the shape a trusted import or a
      // pre-upgrade database leaves behind.
      await backend.insertEdge({
        graphId: store.graphId,
        id: "cf-dual-row-a",
        kind: "cfDualOf",
        fromKind: "CfDualPart",
        fromId: partA.id,
        toKind: "CfDualWhole",
        toId: whole.id,
        props: {},
      });
      await backend.insertEdge({
        graphId: store.graphId,
        id: "cf-dual-row-b",
        kind: "cfDualOf",
        fromKind: "CfDualPart",
        fromId: partB.id,
        toKind: "CfDualWhole",
        toId: whole.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const cardinalityViolation = violations.find(
        (violation) => violation.family === "edgeCardinality",
      );
      expect(cardinalityViolation).toBeDefined();
      if (cardinalityViolation?.family !== "edgeCardinality") {
        throw new Error("expected an edgeCardinality violation");
      }
      expect([...cardinalityViolation.edgeIds].toSorted()).toEqual(
        ["cf-dual-row-a", "cf-dual-row-b"].toSorted(),
      );
      // No composition (R4) violation: each part still holds exactly one
      // whole, and no `edgeIds` entry repeats (E3's double-count).
      expect(
        violations.some((violation) => violation.family === "composition"),
      ).toBe(false);
    });
    // MUTATION CHECK: restore the per-row `compositionClaim(registry, row)`
    // re-derivation in `edgeCardinalityViolations` (src/store/claims/
    // verify.ts) instead of reading the row's own `scope`. Both planted rows
    // are of a composition-realizing edge kind (`cfDualOf`), so the
    // re-derivation folds them onto the reserved composition axis
    // regardless of which query produced them; grouped there they share one
    // axis with 2 edge ids, so `family: "composition"` becomes truthy above
    // and the genuine `edgeCardinality` violation disappears (verified,
    // reverted).

    it("verifyConstraintFences resolves (no raw TypeError) over a composition row whose part-side endpoint kind is undeclared (E4)", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const backend = store.backend;
      // `CfBook` is never a declared composition PART kind anywhere in this
      // graph — it is only ever a WHOLE (`cfChapterOf`, `cfSectionOf`) — so
      // `registry.compositionPopulation("CfBook")` is `undefined`. Using it
      // as `cfChapterOf`'s `from` endpoint (declared `from: [CfChapter]`) is
      // exactly the input that used to throw a raw TypeError when
      // `edgeCardinalityViolations` re-derived the composition claim per row
      // instead of reading the row's own `scope` (E4). Two rows sharing this
      // same (bogus) part identity is what makes the composition audit's
      // peer query select both, so the throw — if it regressed — would fire
      // during THIS test's `verifyConstraintFences()` call, not silently.
      const fakePart = await store.nodes.CfBook.create({});
      const wholeA = await store.nodes.CfBook.create({});
      const wholeB = await store.nodes.CfBook.create({});
      await backend.insertEdge({
        graphId: store.graphId,
        id: "cf-bad-part-row-a",
        kind: "cfChapterOf",
        fromKind: "CfBook",
        fromId: fakePart.id,
        toKind: "CfBook",
        toId: wholeA.id,
        props: {},
      });
      await backend.insertEdge({
        graphId: store.graphId,
        id: "cf-bad-part-row-b",
        kind: "cfChapterOf",
        fromKind: "CfBook",
        fromId: fakePart.id,
        toKind: "CfBook",
        toId: wholeB.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const endpointViolation = violations.find(
        (violation) =>
          violation.family === "edgeEndpointAssignability" &&
          violation.edgeKind === "cfChapterOf",
      );
      expect(endpointViolation).toBeDefined();
      if (endpointViolation?.family !== "edgeEndpointAssignability") {
        throw new Error("expected an edgeEndpointAssignability violation");
      }
      expect(
        endpointViolation.edges.map((edge) => edge.edgeId).toSorted(),
      ).toEqual(["cf-bad-part-row-a", "cf-bad-part-row-b"].toSorted());
    });
    // REVERT CHECK: reintroduce a per-row `registry.compositionPopulation()`
    // lookup on the fence-audit read path (for example, re-deriving the
    // composition claim in `edgeCardinalityViolations` instead of reading
    // `row.scope`, or resolving the part's population while enriching a
    // composition violation's payload). `store.verifyConstraintFences()`
    // above then throws `"cfChapterOf" is a composition edge kind but
    // "CfBook" has no recorded composition population` instead of resolving.

    it("two concurrent attaches of one part to two different wholes: exactly one commits", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const chapter = await store.nodes.CfChapter.create({});
      const book = await store.nodes.CfBook.create({});
      const anthology = await store.nodes.CfAnthology.create({});

      const results = await Promise.allSettled([
        store.edges.cfChapterOf.create(chapter, book, {}),
        store.edges.cfIncludedIn.create(chapter, anthology, {}),
      ]);

      const fulfilled = results.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(requireDefined(rejected[0]).reason).toBeInstanceOf(
        CompositionError,
      );

      // Whichever won, the part is left with exactly one live whole.
      const wholesHeld = [
        ...(await store.edges.cfChapterOf.findFrom(chapter)),
        ...(await store.edges.cfIncludedIn.findFrom(chapter)),
      ];
      expect(wholesHeld).toHaveLength(1);
    });
  });
}
