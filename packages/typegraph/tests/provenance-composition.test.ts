/**
 * A belief-status close reaches the REQUIRED composition parts of the whole it
 * closes, and a reopen brings back the ones that are otherwise supported.
 *
 * The support computation — not a cascade — is what carries this: a required
 * part cannot exist without a live whole, so it is support-dependent on it.
 * Each case states the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type HistoryStore,
  partOf,
} from "../src";
import { type GraphBackend } from "../src/backend/types";
import { createRetractionCapability } from "../src/provenance";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const PcSource = defineNode("PcSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const PcJustification = defineNode("PcJustification", {
  schema: z.object({ label: z.string() }),
});
const PcReport = defineNode("PcReport", { schema: z.object({}) });
const PcSection = defineNode("PcSection", { schema: z.object({}) });
const PcParagraph = defineNode("PcParagraph", { schema: z.object({}) });
const PcAnnex = defineNode("PcAnnex", { schema: z.object({}) });
/** A whole that carries no belief status of its own: not a fact kind. */
const PcDossier = defineNode("PcDossier", { schema: z.object({}) });
const PcExhibit = defineNode("PcExhibit", { schema: z.object({}) });

const pcPremiseOf = defineEdge("pcPremiseOf");
const pcDerives = defineEdge("pcDerives");
const pcSectionOf = defineEdge("pcSectionOf");
const pcParagraphOf = defineEdge("pcParagraphOf");
const pcAnnexOf = defineEdge("pcAnnexOf");
const pcExhibitOf = defineEdge("pcExhibitOf");

const FACT_TYPES = [PcReport, PcSection, PcParagraph, PcAnnex, PcExhibit];

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      PcSource: { type: PcSource },
      PcJustification: { type: PcJustification },
      PcReport: { type: PcReport },
      PcSection: { type: PcSection },
      PcParagraph: { type: PcParagraph },
      PcAnnex: { type: PcAnnex },
      PcDossier: { type: PcDossier },
      PcExhibit: { type: PcExhibit },
    },
    edges: {
      pcPremiseOf: {
        type: pcPremiseOf,
        from: [PcSource, ...FACT_TYPES],
        to: [PcJustification],
      },
      pcDerives: {
        type: pcDerives,
        from: [PcJustification],
        to: FACT_TYPES,
      },
      pcSectionOf: {
        type: pcSectionOf,
        from: [PcSection],
        to: [PcReport],
        cardinality: "one",
      },
      pcParagraphOf: {
        type: pcParagraphOf,
        from: [PcParagraph],
        to: [PcSection],
        cardinality: "one",
      },
      pcAnnexOf: {
        type: pcAnnexOf,
        from: [PcAnnex],
        to: [PcReport],
        cardinality: "one",
      },
      pcExhibitOf: {
        type: pcExhibitOf,
        from: [PcExhibit],
        to: [PcDossier],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(PcSection, PcReport, {
        via: pcSectionOf,
        existence: "required",
      }),
      partOf(PcParagraph, PcSection, {
        via: pcParagraphOf,
        existence: "required",
      }),
      // The contrast case: an optional part can exist with no whole, so its
      // belief status owes the whole nothing.
      partOf(PcAnnex, PcReport, { via: pcAnnexOf }),
      partOf(PcExhibit, PcDossier, {
        via: pcExhibitOf,
        existence: "required",
      }),
    ],
  });
}

const config = {
  source: { kind: "PcSource" },
  justification: { kind: "PcJustification" },
  fact: {
    kinds: ["PcReport", "PcSection", "PcParagraph", "PcAnnex", "PcExhibit"],
  },
  premiseOf: { kind: "pcPremiseOf" },
  derives: { kind: "pcDerives" },
} as const;

type CompositionGraph = ReturnType<typeof buildGraph>;

async function createCompositionStore(
  id: string,
): Promise<
  Readonly<{ store: HistoryStore<CompositionGraph>; backend: GraphBackend }>
> {
  const backend = createTestBackend();
  const [store] = await createStoreWithSchema(buildGraph(id), backend, {
    history: true,
  });
  return { store, backend };
}

/**
 * Two independent sources. `report-source` supports the whole; `part-source`
 * supports every part on its own, so a part that closes can only have closed
 * because of its whole.
 */
async function seedComposedReport(store: HistoryStore<CompositionGraph>) {
  const reportSource = await store.nodes.PcSource.create(
    { label: "report", retracted: false },
    { id: "report-source" },
  );
  const partSource = await store.nodes.PcSource.create(
    { label: "part", retracted: false },
    { id: "part-source" },
  );
  const report = await store.nodes.PcReport.create({}, { id: "report-1" });
  const section = await store.nodes.PcSection.create(
    {},
    { id: "section-1", partOf: { kind: "PcReport", id: report.id } },
  );
  const paragraph = await store.nodes.PcParagraph.create(
    {},
    { id: "paragraph-1", partOf: { kind: "PcSection", id: section.id } },
  );
  const annex = await store.nodes.PcAnnex.create(
    {},
    { id: "annex-1", partOf: { kind: "PcReport", id: report.id } },
  );

  const reportJustification = await store.nodes.PcJustification.create(
    { label: "report" },
    { id: "report-justification" },
  );
  const partJustification = await store.nodes.PcJustification.create(
    { label: "parts" },
    { id: "part-justification" },
  );
  await store.edges.pcPremiseOf.create(reportSource, reportJustification);
  await store.edges.pcPremiseOf.create(partSource, partJustification);
  await store.edges.pcDerives.create(reportJustification, report);
  for (const fact of [section, paragraph, annex]) {
    await store.edges.pcDerives.create(partJustification, fact);
  }

  return { reportSource, partSource, report, section, paragraph, annex };
}

/**
 * The non-fact-whole shape: a dossier that carries no belief status, a required
 * exhibit under it, and TWO independent sources supporting that exhibit, so a
 * transition can reach the exhibit without removing its own grounding.
 */
async function seedExhibitUnderDossier(
  store: HistoryStore<CompositionGraph>,
  dossierWindow?: Readonly<{ validFrom: string; validTo: string }>,
) {
  const sourceOne = await store.nodes.PcSource.create(
    { label: "scanner", retracted: false },
    { id: "exhibit-source-1" },
  );
  const sourceTwo = await store.nodes.PcSource.create(
    { label: "vendor", retracted: false },
    { id: "exhibit-source-2" },
  );
  const dossier = await store.nodes.PcDossier.create(
    {},
    { id: "dossier-1", ...dossierWindow },
  );
  const exhibit = await store.nodes.PcExhibit.create(
    {},
    { id: "exhibit-1", partOf: { kind: "PcDossier", id: dossier.id } },
  );
  const attachments = await store.edges.pcExhibitOf.find({});
  const attachment = requireDefined(
    attachments[0],
    "the exhibit's composition edge",
  );
  for (const [index, source] of [sourceOne, sourceTwo].entries()) {
    const justification = await store.nodes.PcJustification.create(
      { label: `exhibits-${index}` },
      { id: `exhibit-justification-${index}` },
    );
    await store.edges.pcPremiseOf.create(source, justification);
    await store.edges.pcDerives.create(justification, exhibit);
  }
  return { sourceOne, sourceTwo, dossier, exhibit, attachment };
}

/** Every currently live fact, as the report spells a fact reference. */
async function liveFacts(
  store: HistoryStore<CompositionGraph>,
): Promise<readonly Readonly<{ kind: string; id: string }>[]> {
  const byKind = await Promise.all([
    store.nodes.PcReport.find({}),
    store.nodes.PcSection.find({}),
    store.nodes.PcParagraph.find({}),
    store.nodes.PcAnnex.find({}),
    store.nodes.PcExhibit.find({}),
  ]);
  return byKind
    .flat()
    .map((row) => ({ kind: row.kind, id: row.id }))
    .toSorted((left, right) =>
      `${left.kind}/${left.id}`.localeCompare(`${right.kind}/${right.id}`),
    );
}

/**
 * Runs `transition` and returns which facts it actually tombstoned, so a case
 * can assert the report NAMES every close. A close the report cannot mention is
 * invisible data loss — the defect the whole-liveness predicate must not
 * reintroduce.
 */
async function closedFactsDuring<T>(
  store: HistoryStore<CompositionGraph>,
  transition: () => Promise<T>,
): Promise<Readonly<{ result: T; closed: readonly string[] }>> {
  const before = await liveFacts(store);
  const result = await transition();
  const factsAfter = await liveFacts(store);
  const after = new Set(factsAfter.map((fact) => `${fact.kind}/${fact.id}`));
  return {
    result,
    closed: before
      .map((fact) => `${fact.kind}/${fact.id}`)
      .filter((key) => !after.has(key)),
  };
}

describe("provenance composition existence", () => {
  it("closes the required parts of a closed whole and leaves the optional part believed", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_close",
    );
    const seeded = await seedComposedReport(store);
    const provenance = createRetractionCapability(store, config);

    const { result: report, closed } = await closedFactsDuring(store, () =>
      provenance.retract(seeded.reportSource),
    );

    // Leaf-first is irrelevant here (no edge is touched), but every closed
    // part must be NAMED: a part that died invisibly would be data loss the
    // report cannot explain.
    expect(closed).toEqual(
      report.died.map((fact) => `${fact.kind}/${fact.id}`).toSorted(),
    );
    expect(report.died).toEqual([
      { kind: "PcParagraph", id: "paragraph-1" },
      { kind: "PcReport", id: "report-1" },
      { kind: "PcSection", id: "section-1" },
    ]);
    // The optional part is not even in scope: nothing this transition can
    // reach decides its belief status.
    expect(report.survivedVia).toEqual([]);
    expect(report.unaffected).toEqual([{ kind: "PcAnnex", id: "annex-1" }]);

    await expect(
      store.nodes.PcReport.getById(seeded.report.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.PcSection.getById(seeded.section.id),
    ).resolves.toBeUndefined();
    await expect(
      store.nodes.PcParagraph.getById(seeded.paragraph.id),
    ).resolves.toBeUndefined();
    // The optional part keeps its attachment to a closed whole and its own
    // belief status: it can exist with no whole at all.
    await expect(
      store.nodes.PcAnnex.getById(seeded.annex.id),
    ).resolves.toMatchObject({ id: "annex-1" });
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcAnnex", id: "annex-1" },
    ]);

    // A closed required part is tombstoned, not orphaned, so the audit that
    // reports live unattached required parts must stay silent.
    const violations = await store.verifyConstraintFences();
    expect(
      violations.filter(
        (violation) => violation.family === "compositionExistence",
      ),
    ).toEqual([]);
  });
  // MUTATION CHECK: make `compositionExistenceSupported`
  // (src/provenance/index.ts) return `true` unconditionally. The section and
  // paragraph stay believed and both the `died` list and the two `getById`
  // assertions fail.

  it("reopens the parts its close closed once the whole is supported again", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_reopen",
    );
    const { reportSource } = await seedComposedReport(store);
    const provenance = createRetractionCapability(store, config);

    await provenance.retract(reportSource);
    const report = await provenance.unRetract(reportSource);

    // Reopen is driven by support, exactly as a close is: the parts come back
    // because their own justification still fires AND their whole is
    // supported again. There is no ledger of what a close closed.
    expect(report.died).toEqual([]);
    expect(report.survivedVia).toEqual([
      {
        fact: { kind: "PcParagraph", id: "paragraph-1" },
        via: [{ kind: "PcJustification", id: "part-justification" }],
      },
      {
        fact: { kind: "PcReport", id: "report-1" },
        via: [{ kind: "PcJustification", id: "report-justification" }],
      },
      {
        fact: { kind: "PcSection", id: "section-1" },
        via: [{ kind: "PcJustification", id: "part-justification" }],
      },
    ]);
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcAnnex", id: "annex-1" },
      { kind: "PcParagraph", id: "paragraph-1" },
      { kind: "PcReport", id: "report-1" },
      { kind: "PcSection", id: "section-1" },
    ]);
  });
  // MUTATION CHECK: drop the part propagation from
  // `computeAffectedFactKeys` (the `partKeysByWholeKey` walk). The section and
  // paragraph fall out of `affected`, so the reopen pass never reaches them
  // and `holding()` returns the annex and the report alone.

  it("keeps a part closed while its own source is retracted and its whole is not", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_part_source",
    );
    const { partSource } = await seedComposedReport(store);
    const provenance = createRetractionCapability(store, config);

    // The mirror of the first case: retracting the PART source closes the
    // parts and leaves the whole believed — the dependency runs one way.
    const report = await provenance.retract(partSource);

    expect(report.died).toEqual([
      { kind: "PcAnnex", id: "annex-1" },
      { kind: "PcParagraph", id: "paragraph-1" },
      { kind: "PcSection", id: "section-1" },
    ]);
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcReport", id: "report-1" },
    ]);
  });
  // MUTATION CHECK: make `compositionExistenceSupported` return `false` for
  // every fact. The report closes too and `holding()` comes back empty.

  it("holds a required part whose whole is a live node that carries no belief status", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_nonfact",
    );
    const source = await store.nodes.PcSource.create(
      { label: "exhibits", retracted: false },
      { id: "exhibit-source" },
    );
    const dossier = await store.nodes.PcDossier.create({}, { id: "dossier-1" });
    const exhibit = await store.nodes.PcExhibit.create(
      {},
      { id: "exhibit-1", partOf: { kind: "PcDossier", id: dossier.id } },
    );
    const justification = await store.nodes.PcJustification.create(
      { label: "exhibits" },
      { id: "exhibit-justification" },
    );
    await store.edges.pcPremiseOf.create(source, justification);
    await store.edges.pcDerives.create(justification, exhibit);
    const provenance = createRetractionCapability(store, config);

    // A whole that is not a fact has no support to read, so its liveness is
    // the whole of the dependency.
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcExhibit", id: "exhibit-1" },
    ]);
  });
  // MUTATION CHECK: make the non-fact arm of `compositionExistenceSupported`
  // return `false` (or skip the `liveWholeKeys` read in
  // `readCompositionExistenceDependencies`). The exhibit is never held.

  it("keeps holding a required part whose non-fact whole has an ENDED validity window", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_ended_window",
    );
    const { sourceOne } = await seedExhibitUnderDossier(store, {
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: "2021-01-01T00:00:00.000Z",
    });
    const provenance = createRetractionCapability(store, config);

    // A whole whose window has closed is still a LIVE row, and the write path
    // would accept it as a whole today, so the part is still held up. Judging
    // it dead here made the part unbelieved BEFORE a transition and tombstoned
    // BY one, a close no report could name.
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcExhibit", id: "exhibit-1" },
    ]);

    const { result: report, closed } = await closedFactsDuring(store, () =>
      provenance.retract(sourceOne),
    );

    expect(closed).toEqual([]);
    expect(report.died).toEqual([]);
    expect(report.survivedVia).toEqual([
      {
        fact: { kind: "PcExhibit", id: "exhibit-1" },
        via: [{ kind: "PcJustification", id: "exhibit-justification-1" }],
      },
    ]);
  });
  // MUTATION CHECK: restore the validity-window conjunct in
  // `readCompositionExistenceDependencies` (reject a whole row whose window
  // does not contain the read instant). `holding()` comes back empty, `closed`
  // names the exhibit, and `died` stays empty — the unnamed close.

  it("stops holding a required part whose non-fact whole is tombstoned", async () => {
    const { store, backend } = await createCompositionStore(
      "provenance_composition_dead_whole",
    );
    const { dossier } = await seedExhibitUnderDossier(store);
    const provenance = createRetractionCapability(store, config);
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcExhibit", id: "exhibit-1" },
    ]);

    // Tombstoned through the backend, which is what leaves the part behind:
    // the store's own delete would cascade to it.
    await backend.deleteNode({
      graphId: store.graphId,
      kind: "PcDossier",
      id: dossier.id,
    });

    await expect(provenance.holding()).resolves.toEqual([]);
    // The same state the audit reports, from the same liveness verdict.
    const violations = await store.verifyConstraintFences();
    expect(
      violations.filter(
        (violation) => violation.family === "compositionExistence",
      ),
    ).toEqual([
      {
        family: "compositionExistence",
        partKind: "PcExhibit",
        parts: [{ kind: "PcExhibit", id: "exhibit-1" }],
      },
    ]);
  });
  // MUTATION CHECK: drop the `isLiveNodeRow` check in
  // `readLiveCompositionWholes` (treat every read row as live). The exhibit is
  // still held after its whole is tombstoned, and the audit reports nothing.

  it("names a part it closes whose whole was already tombstoned before the transition", async () => {
    const { store, backend } = await createCompositionStore(
      "provenance_composition_already_dead_whole",
    );
    const { sourceOne, dossier } = await seedExhibitUnderDossier(store);
    const provenance = createRetractionCapability(store, config);

    // The whole dies outside the store's own paths, so the part is already
    // unsupported when the transition arrives — the state
    // `verifyConstraintFences()` reports as a `compositionExistence`
    // violation.
    await backend.deleteNode({
      graphId: store.graphId,
      kind: "PcDossier",
      id: dossier.id,
    });

    const { result: report, closed } = await closedFactsDuring(store, () =>
      provenance.retract(sourceOne),
    );

    // The transition still ends this row's currency, so the report must name
    // it: a tombstone the report cannot mention is invisible data loss, no
    // matter what made the fact unsupported beforehand.
    expect(closed).toEqual(["PcExhibit/exhibit-1"]);
    expect(report.died).toEqual([{ kind: "PcExhibit", id: "exhibit-1" }]);
  });
  // MUTATION CHECK: restore the `believedBefore` filter in `buildReport`
  // (`died` = believed before and unsupported after). The row is still
  // tombstoned and `died` comes back empty.

  it("stops holding a required part whose composition edge is gone", async () => {
    const { store, backend } = await createCompositionStore(
      "provenance_composition_no_edge",
    );
    const { attachment } = await seedExhibitUnderDossier(store);
    const provenance = createRetractionCapability(store, config);
    await expect(provenance.holding()).resolves.toEqual([
      { kind: "PcExhibit", id: "exhibit-1" },
    ]);

    // Hard-deleted through the backend: detaching a live required part is
    // refused by the write path, which is the point — only a direct write can
    // reach this state, and support must not pretend the part still hangs
    // from something.
    await backend.hardDeleteEdge({
      graphId: store.graphId,
      kind: "pcExhibitOf",
      id: attachment.id,
    });

    await expect(provenance.holding()).resolves.toEqual([]);
  });
  // MUTATION CHECK: in `compositionExistenceSupported`, return `true` when
  // `wholeKey === undefined`. The exhibit is held with no whole at all.

  it("refuses a configuration whose fact kind owns a required part that is not a fact", async () => {
    const { store } = await createCompositionStore(
      "provenance_composition_unreachable_part",
    );

    // PcSection and PcParagraph are required parts under fact wholes, so a
    // configuration that tracks the wholes without them could close a whole
    // and leave a live required part hanging from it.
    expect(() =>
      createRetractionCapability(store, {
        source: { kind: "PcSource" },
        justification: { kind: "PcJustification" },
        fact: { kinds: ["PcReport"] },
        premiseOf: { kind: "pcPremiseOf" },
        derives: { kind: "pcDerives" },
      }),
    ).toThrow(/PcSection.*is not a fact kind/);

    const error = (() => {
      try {
        createRetractionCapability(store, {
          source: { kind: "PcSource" },
          justification: { kind: "PcJustification" },
          fact: { kinds: ["PcReport", "PcAnnex"] },
          premiseOf: { kind: "pcPremiseOf" },
          derives: { kind: "pcDerives" },
        });
      } catch (error_) {
        return error_;
      }
      return;
    })();
    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as ConfigurationError).details).toMatchObject({
      code: "PROVENANCE_REQUIRED_PART_NOT_A_FACT",
      wholeKind: "PcReport",
      partKind: "PcSection",
    });
  });
  // MUTATION CHECK: delete the
  // `assertRequiredPartsOfFactWholesAreFacts(store.registry, normalized)` call
  // in `createRetractionCapability`. Both configurations above are accepted.
});
