/**
 * On-graph provenance persistence — the sidecar provenance graph (open-item #5).
 *
 * With `persistProvenance: true`, the merge upserts one `{branch, sourceId}` row
 * per contribution into a sidecar graph on the SAME backend, queryable AFTER the
 * merge via `openProvenanceStore` / `readProvenance`. Asserted on BOTH backends:
 *
 *   1. the persisted rows match the in-memory `report.provenance.byBranch` index;
 *   2. a resolved canonical carries provenance from BOTH contributing branches
 *      (with the original fork-local `sourceId`s);
 *   3. edges are tagged too (`role: "edge"`);
 *   4. re-persisting is idempotent (deterministic ids → upsert, no duplicates);
 *   5. it is OFF by default (no `provenancePersisted`, no rows);
 *   6. a contribution the pipeline observes SEVERAL times (an edge id staged by two
 *      branches, an inherited edge modification seen by both delete/modify and the
 *      repoint fold — with two contributing branches or just one) is persisted and
 *      counted ONCE per distinct `(role, canonical, branch, source)` — while every
 *      genuinely distinct contributing branch is still credited;
 *   7. `persistProvenanceRecords` collapses hash-identical records for callers that
 *      reach it without going through a merge.
 *
 * A second group covers OWNERSHIP of the sidecar graph id — which occupant
 * `openProvenanceStore` may write to, and which refusal it names: a schema-less
 * application graph (rows but no schema row) and an exact-schema one are refused
 * untouched, an empty or unverifiable pre-marker sidecar is refused with
 * drop-this-id remediation, and a marker-less sidecar this module itself could
 * have written (interrupted creation, interrupted upgrade, or a racing opener)
 * is resumed rather than bricked.
 *
 * A final backend-independent block pins the row identity itself: the literal id a
 * contribution hashes to, and that no identifying field is missing from the key
 * every collapse is keyed on.
 */
import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStore,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { asEdgeId } from "../../src/core/types";
import { branch } from "../../src/graph-merge/branch";
import { merge } from "../../src/graph-merge/merge";
import type { ProvenanceNode } from "../../src/graph-merge/provenance-store";
import {
  contributionKey,
  openProvenanceStore,
  persistProvenanceRecords,
  provenanceGraphId,
  provenanceNodeId,
} from "../../src/graph-merge/provenance-store";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

// Deliberately mirrors the internal sidecar schema. Schema equality is not an
// ownership claim: an application is allowed to define these exact kinds at
// the conventional sidecar graph id.
const ApplicationProvenance = defineNode("Provenance", {
  schema: z.object({
    targetGraphId: z.string(),
    role: z.enum(["node", "edge"]),
    canonicalId: z.string(),
    canonicalKind: z.string(),
    branchId: z.string(),
    sourceId: z.string(),
  }),
});
const ApplicationProvenanceOwner = defineNode("ProvenanceOwner", {
  schema: z.object({
    owner: z.literal("@nicia-ai/typegraph/merge-provenance"),
    version: z.literal(1),
    targetGraphId: z.string(),
  }),
});

/** The row id the sidecar's durable ownership marker is stored under. */
const PROVENANCE_OWNER_ROW_ID = "merge-provenance-owner";
const PROVENANCE_OWNER = "@nicia-ai/typegraph/merge-provenance";

const careGraph = defineGraph({
  id: "provenance-test-care",
  nodes: { Patient: { type: Patient }, Encounter: { type: Encounter } },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
  },
});
type CareGraph = typeof careGraph;

const BRANCH_A = asBranchId("provider-a");
const BRANCH_B = asBranchId("provider-b");

/**
 * The graph a caller would define to sit at the sidecar id with the CURRENT
 * (owner-marker-bearing) sidecar shape. Its serialized schema — and therefore
 * its hash — is the one `openProvenanceStore` computes for its own graph, which
 * is what makes it usable both as the "creation crashed after the schema commit"
 * fixture and as the exact-schema application-graph fixture.
 */
function sidecarShapedGraph() {
  return defineGraph({
    id: provenanceGraphId(careGraph.id),
    nodes: {
      Provenance: { type: ApplicationProvenance },
      ProvenanceOwner: { type: ApplicationProvenanceOwner },
    },
    edges: {},
  });
}

/** The pre-marker (legacy) sidecar shape: the `Provenance` kind alone. */
function legacyShapedGraph() {
  return defineGraph({
    id: provenanceGraphId(careGraph.id),
    nodes: { Provenance: { type: ApplicationProvenance } },
    edges: {},
  });
}

/** Reads the durable ownership marker row straight from the backend. */
async function readOwnerMarker(
  backend: GraphBackend,
): Promise<Readonly<{ id: string }> | undefined> {
  return backend.getNode(
    provenanceGraphId(careGraph.id),
    "ProvenanceOwner",
    PROVENANCE_OWNER_ROW_ID,
  );
}

/** A contribution the sidecar can hold, plus its deterministic row id. */
const SIDECAR_RECORD = {
  role: "node",
  canonicalId: "canonical-resumed",
  canonicalKind: "Patient",
  branchId: BRANCH_A,
  sourceId: "source-resumed",
} as const;

/** Committed endpoints both branches fork with, so their edges share an identity. */
const COMMITTED_PATIENT = "pat-committed";
const COMMITTED_ENCOUNTER = "enc-committed";
const COMMITTED_BIRTH_DATE = "1961-11-02";
const SHARED_EDGE = "edge-shared";
const SHARED_EDGE_ID = asEdgeId<typeof hadEncounter>(SHARED_EDGE);

/**
 * The contribution identity a persisted row stands for — the exact tuple
 * {@link provenanceNodeId} hashes into the row's id. Two rows agreeing on it are
 * the same contribution, so a duplicate is what an over-count is MADE of.
 */
function contributionOf(node: ProvenanceNode): string {
  return JSON.stringify([
    node.role,
    node.canonicalKind,
    node.canonicalId,
    node.branchId,
    node.sourceId,
  ]);
}

/** Edge contributions in a stable, readable order (persisted ids are hashes). */
function edgeContributions(
  nodes: readonly ProvenanceNode[],
): readonly Readonly<{
  branchId: string;
  canonicalId: string;
  sourceId: string;
}>[] {
  return nodes
    .filter((node) => node.role === "edge")
    .map((node) => ({
      branchId: node.branchId,
      canonicalId: node.canonicalId,
      sourceId: node.sourceId,
    }))
    .sort((left, right) => left.branchId.localeCompare(right.branchId));
}

/** Fulltext name match (no embedder): "Anna Rivera" ~ "Ana Rivera" clears 0.85. */
function provMergeOptions(persistProvenance: boolean): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { birthDate?: string }).birthDate,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH_A, BRANCH_B],
    persistProvenance,
  };
}

type Fixture = Readonly<{
  backend: GraphBackend;
  base: Store<CareGraph>;
  branches: readonly GraphBranch<CareGraph>[];
}>;

describe.each(backendMatrix())("provenance persistence [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const cleanup of cleanups ?? []) {
      await cleanup();
    }
    cleanups = [];
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  /**
   * Base + two branches: each adds a near-duplicate Patient (same birthDate) plus
   * its own Encounter joined by a hadEncounter edge. The merge resolves the two
   * Patients into one canonical and repoints both edges onto it.
   */
  async function materialize(): Promise<Fixture> {
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );

    await branchA.store.nodes.Patient.bulkCreate([
      {
        id: "pat-anna",
        props: { name: "Anna Rivera", birthDate: "1974-03-09" },
      },
    ]);
    await branchA.store.nodes.Encounter.bulkCreate([
      { id: "enc-a", props: { reason: "checkup" } },
    ]);
    await branchA.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-a",
        from: { kind: "Patient", id: "pat-anna" },
        to: { kind: "Encounter", id: "enc-a" },
        props: { on: "1974-03-09" },
      },
    ]);

    await branchB.store.nodes.Patient.bulkCreate([
      { id: "pat-ana", props: { name: "Ana Rivera", birthDate: "1974-03-09" } },
    ]);
    await branchB.store.nodes.Encounter.bulkCreate([
      { id: "enc-b", props: { reason: "referral" } },
    ]);
    await branchB.store.edges.hadEncounter.bulkCreate([
      {
        id: "edge-b",
        from: { kind: "Patient", id: "pat-ana" },
        to: { kind: "Encounter", id: "enc-b" },
        props: { on: "1974-03-09" },
      },
    ]);

    return { backend, base, branches: [branchA, branchB] };
  }

  /**
   * A base holding the Patient and Encounter both branches fork with, so every
   * `hadEncounter` edge they stage lands on the SAME committed endpoints and
   * therefore in one repoint fold set. With `withEdge` the joining edge is
   * committed too, so both branches INHERIT it instead of authoring it.
   */
  async function materializeSharedEndpoints(
    withEdge: boolean,
  ): Promise<Fixture> {
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    await base.nodes.Patient.bulkCreate([
      {
        id: COMMITTED_PATIENT,
        props: { name: "Nadia Okonkwo", birthDate: COMMITTED_BIRTH_DATE },
      },
    ]);
    await base.nodes.Encounter.bulkCreate([
      { id: COMMITTED_ENCOUNTER, props: { reason: "intake" } },
    ]);
    if (withEdge) {
      await base.edges.hadEncounter.bulkCreate([
        {
          id: SHARED_EDGE,
          from: { kind: "Patient", id: COMMITTED_PATIENT },
          to: { kind: "Encounter", id: COMMITTED_ENCOUNTER },
          props: { on: "2024-01-01" },
        },
      ]);
    }
    const branchA = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch<CareGraph>(base, () => makeBackend(), { id: BRANCH_B }),
    );
    return { backend, base, branches: [branchA, branchB] };
  }

  it("counts an edge id staged by two branches once per branch, not once per staged copy", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(false);
    const [branchA, branchB] = branches;

    // Both branches author the SAME caller-chosen edge id between the same
    // committed endpoints, so the fold set holds one member per branch and its
    // `mergedIds` names that id TWICE. Each member re-offers the id's full branch
    // set, so the recording loop sees all FOUR (branch, source) pairs though only
    // two contributions exist.
    for (const [contributor, on] of [
      [requireDefined(branchA), "2024-02-01"],
      [requireDefined(branchB), "2024-02-02"],
    ] as const) {
      await contributor.store.edges.hadEncounter.bulkCreate([
        {
          id: SHARED_EDGE,
          from: { kind: "Patient", id: COMMITTED_PATIENT },
          to: { kind: "Encounter", id: COMMITTED_ENCOUNTER },
          props: { on },
        },
      ]);
    }

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    // Read the sidecar back — the count is only meaningful against the rows that
    // actually landed, never against the report's own arithmetic.
    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);

    // Both branches are still credited: the collapse drops re-observations of one
    // contribution, never a second contributor.
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
      {
        branchId: BRANCH_B,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("counts an inherited edge modified by two branches once per branch", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(true);
    const [branchA, branchB] = branches;

    // An inherited edge modification is observed TWICE: once as a surviving
    // delete/modify contribution (per branch) and again as the repoint fold's
    // source (for the branch reconcile kept). The reconcile winner is therefore
    // offered to the recording loop twice.
    await requireDefined(branchA).store.edges.hadEncounter.update(
      SHARED_EDGE_ID,
      {
        on: "2024-03-01",
      },
    );
    await requireDefined(branchB).store.edges.hadEncounter.update(
      SHARED_EDGE_ID,
      {
        on: "2024-03-02",
      },
    );

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
      {
        branchId: BRANCH_B,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("credits a lone branch's inherited-edge modification once, seen by two phases", async () => {
    cleanups = [];
    const { base, branches } = await materializeSharedEndpoints(true);
    const onlyBranch = requireDefined(branches[0]);

    // The MINIMAL trigger, and the one a single-contributor merge hits in ordinary
    // use: no second branch is needed for the same contribution to be observed
    // twice — delete/modify credits the modification, then the repoint fold reads
    // it as a source. One contribution, so one row and a count of one.
    await onlyBranch.store.edges.hadEncounter.update(SHARED_EDGE_ID, {
      on: "2024-04-04",
    });

    const report = unwrap(
      await merge<CareGraph>(base, [onlyBranch], provMergeOptions(true)),
    );
    expect(report.warnings).toEqual([]);

    const persisted = await (
      await openProvenanceStore(base)
    ).nodes.Provenance.find();
    expect(new Set(persisted.map((node) => contributionOf(node))).size).toBe(
      persisted.length,
    );
    expect(report.provenancePersisted?.count).toBe(persisted.length);
    expect(edgeContributions(persisted)).toEqual([
      {
        branchId: BRANCH_A,
        canonicalId: SHARED_EDGE,
        sourceId: SHARED_EDGE,
      },
    ]);
  });

  it("collapses hash-identical records offered to persistProvenanceRecords directly", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [base] = await createStoreWithSchema(careGraph, backend);
    const provStore = await openProvenanceStore(base);

    // The exported helper takes ANY record list, so a caller reaching it without
    // going through a merge can offer one contribution twice as two objects. They
    // hash to a single id, and a `bulkUpsertById` batch cannot CREATE the same id
    // twice — so the helper must collapse them into the one row it reports rather
    // than throw on a sidecar that does not hold the row yet.
    const record = {
      role: "node",
      canonicalId: COMMITTED_PATIENT,
      canonicalKind: "Patient",
      branchId: BRANCH_A,
      sourceId: "pat-fork-local",
    } as const;
    const written = await persistProvenanceRecords(provStore, base.graphId, [
      record,
      { ...record },
    ]);

    expect(written).toBe(1);
    expect(await provStore.nodes.Provenance.find()).toHaveLength(1);
  });

  it("opens from a backend and graph id without the target GraphDef", async () => {
    cleanups = [];
    const { backend, base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(backend, base.graphId);
    expect(await provStore.nodes.Provenance.find()).not.toHaveLength(0);
  });

  it("persists {branch, sourceId} rows that match the report index", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const result = await merge<CareGraph>(
      base,
      branches,
      provMergeOptions(true),
    );
    expect(isOk(result)).toBe(true);
    const report = unwrap(result);

    // The report announces the sidecar graph + the row count.
    expect(report.provenancePersisted?.graphId).toBe(
      provenanceGraphId(base.graphId),
    );
    expect(report.provenancePersisted?.count).toBeGreaterThan(0);
    expect(report.warnings).toEqual([]);

    const provStore = await openProvenanceStore(base);

    // Every node id the in-memory index credits to a branch is persisted for it.
    for (const branchId of [BRANCH_A, BRANCH_B]) {
      const reported = report.provenance.byBranch(branchId);
      const persisted = await provStore.nodes.Provenance.find();
      const persistedNodeIds = new Set(
        persisted
          .filter((p) => p.branchId === branchId && p.role === "node")
          .map((p) => p.canonicalId),
      );
      for (const nodeId of reported.nodeIds) {
        expect(persistedNodeIds.has(nodeId)).toBe(true);
      }
    }
  });

  it("tags the resolved canonical with BOTH branches and keeps each source id", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const patients = await base.nodes.Patient.find();
    expect(patients).toHaveLength(1);
    const canonicalId = requireDefined(patients[0]).id;

    const provStore = await openProvenanceStore(base);
    const forCanonical = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.canonicalId === canonicalId,
    );

    // Two contributions — one per branch — each keeping the fork-local source id.
    expect(new Set(forCanonical.map((p) => p.branchId))).toEqual(
      new Set([BRANCH_A, BRANCH_B]),
    );
    expect(new Set(forCanonical.map((p) => p.sourceId))).toEqual(
      new Set(["pat-anna", "pat-ana"]),
    );

    // Edges are tagged too.
    const edges = (await provStore.nodes.Provenance.find()).filter(
      (p) => p.role === "edge",
    );
    expect(edges.length).toBeGreaterThanOrEqual(2);
  });

  it("is idempotent: re-persisting the same records upserts (no duplicates)", async () => {
    cleanups = [];
    const { base, branches } = await materialize();
    unwrap(await merge<CareGraph>(base, branches, provMergeOptions(true)));

    const provStore = await openProvenanceStore(base);
    const firstCount = (await provStore.nodes.Provenance.find()).length;

    // Re-persist the SAME records (as a re-run would): deterministic ids → upsert.
    const records = (await provStore.nodes.Provenance.find()).map((p) => ({
      role: p.role,
      canonicalId: p.canonicalId,
      canonicalKind: p.canonicalKind,
      branchId: asBranchId(p.branchId),
      sourceId: p.sourceId,
    }));
    await persistProvenanceRecords(provStore, base.graphId, records);

    const secondCount = (await provStore.nodes.Provenance.find()).length;
    expect(secondCount).toBe(firstCount);
  });

  it("is OFF by default: no provenancePersisted, no rows", async () => {
    cleanups = [];
    const { base, branches } = await materialize();

    const report = unwrap(
      await merge<CareGraph>(base, branches, provMergeOptions(false)),
    );
    expect(report.provenancePersisted).toBeUndefined();

    const provStore = await openProvenanceStore(base);
    expect(await provStore.nodes.Provenance.find()).toHaveLength(0);
  });

  it("refuses an existing application graph at the sidecar id without modifying it", async () => {
    const backend = await makeBackend();
    const applicationGraph = defineGraph({
      id: provenanceGraphId(careGraph.id),
      nodes: { Patient: { type: Patient } },
      edges: {},
    });
    const [applicationStore] = await createStoreWithSchema(
      applicationGraph,
      backend,
    );
    await applicationStore.nodes.Patient.create(
      { name: "Existing", birthDate: "1970-01-01" },
      { id: "existing" },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: { code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION" },
    });
    await expect(
      applicationStore.nodes.Patient.getById("existing" as never),
    ).resolves.toMatchObject({ id: "existing", name: "Existing" });
  });

  it("refuses a SCHEMA-LESS application graph at the sidecar id without touching it", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const applicationGraph = defineGraph({
      id: provenanceGraphId(careGraph.id),
      nodes: { Patient: { type: Patient } },
      edges: {},
    });
    // Plain `createStore` — documented basic usage — registers NO schema row, so
    // the sidecar id reads as unregistered while holding application data. An
    // ownership decision keyed only on the active schema would register the
    // sidecar schema OVER this graph and write into its namespace.
    const applicationStore = createStore(applicationGraph, backend);
    await applicationStore.nodes.Patient.create(
      { name: "Existing", birthDate: "1970-01-01" },
      { id: "existing" },
    );

    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "application-graph",
      },
    });

    // Refused BEFORE any modification: no sidecar schema over the application's
    // graph id, no ownership marker, and its row untouched.
    await expect(
      backend.getActiveSchema(provenanceGraphId(careGraph.id)),
    ).resolves.toBeUndefined();
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
    await expect(
      applicationStore.nodes.Patient.getById("existing" as never),
    ).resolves.toMatchObject({ id: "existing", name: "Existing" });
  });

  it("resumes a sidecar creation whose ownership marker never committed", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // Exactly production's FIRST write and nothing after it: the owned sidecar
    // schema is committed, the marker row is not. Reachable by a crash between
    // the two separately committed writes.
    await createStoreWithSchema(sidecarShapedGraph(), backend);
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();

    const resumed = await openProvenanceStore(backend, careGraph.id);
    await expect(readOwnerMarker(backend)).resolves.toMatchObject({
      id: PROVENANCE_OWNER_ROW_ID,
    });
    expect(
      await persistProvenanceRecords(resumed, careGraph.id, [SIDECAR_RECORD]),
    ).toBe(1);

    // The next open takes the plain owned path (marker present).
    const reopened = await openProvenanceStore(backend, careGraph.id);
    expect(await reopened.nodes.Provenance.find()).toHaveLength(1);
  });

  it("resumes an interrupted upgrade that already carries verified sidecar rows", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // The legacy-upgrade path has the same two-write window: schema evolved,
    // marker not yet written, rows already present and verifying.
    const [staged] = await createStoreWithSchema(sidecarShapedGraph(), backend);
    const rowId = await provenanceNodeId(careGraph.id, SIDECAR_RECORD);
    await staged.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: rowId },
    );

    const resumed = await openProvenanceStore(backend, careGraph.id);
    await expect(
      resumed.nodes.Provenance.getById(rowId as never),
    ).resolves.toMatchObject({ id: rowId, canonicalId: "canonical-resumed" });
    await expect(readOwnerMarker(backend)).resolves.toMatchObject({
      id: PROVENANCE_OWNER_ROW_ID,
    });
  });

  it("does not refuse an opener that raced between the schema and marker writes", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // Driven sequentially on purpose (a real concurrency test would be flaky):
    // opener A commits the schema, opener B reads the owned hash with no marker
    // yet — the interleaving that used to surface as a permanent-looking
    // collision — and A's marker write lands afterwards.
    const [openerA] = await createStoreWithSchema(
      sidecarShapedGraph(),
      backend,
    );
    const openerB = await openProvenanceStore(backend, careGraph.id);
    await openerA.nodes.ProvenanceOwner.upsertById(PROVENANCE_OWNER_ROW_ID, {
      owner: PROVENANCE_OWNER,
      version: 1,
      targetGraphId: careGraph.id,
    });

    expect(
      await persistProvenanceRecords(openerB, careGraph.id, [SIDECAR_RECORD]),
    ).toBe(1);
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).resolves.toBeDefined();
    // Both openers claim the SAME marker id, so the race leaves one marker row.
    expect(await openerA.nodes.ProvenanceOwner.find()).toHaveLength(1);
  });

  it("refuses an EMPTY pre-marker sidecar and says to drop that graph id", async () => {
    cleanups = [];
    const backend = await makeBackend();
    // A real fleet state: the old persist path created the sidecar before
    // writing records, so a zero-record merge left an empty legacy sidecar.
    await createStoreWithSchema(legacyShapedGraph(), backend);

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "empty-legacy-sidecar",
      },
    });
    // The remediation must name dropping this id — renaming an application
    // graph is advice for a state this is not.
    expect((refusal as { suggestion?: string }).suggestion).toContain(
      `Drop graph id "${provenanceGraphId(careGraph.id)}"`,
    );
  });

  it("refuses a pre-marker sidecar whose rows do not recompute to their ids", async () => {
    cleanups = [];
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    // A row an older release could have written under an ambiguous id: valid
    // provenance props, but not the id the tuple hashes to today.
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...SIDECAR_RECORD },
      { id: "prov_ambiguous-legacy-id" },
    );

    const refusal = await openProvenanceStore(backend, careGraph.id).catch(
      (error: unknown) => error,
    );
    expect(refusal).toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unupgradeable-legacy-sidecar",
      },
    });
    expect((refusal as { suggestion?: string }).suggestion).toContain(
      "drop it",
    );
    // Fail-closed: the unupgradeable sidecar is left exactly as it was.
    await expect(
      legacyStore.nodes.Provenance.getById("prov_ambiguous-legacy-id" as never),
    ).resolves.toMatchObject({ id: "prov_ambiguous-legacy-id" });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("refuses an exact-schema application graph without the internal owner marker", async () => {
    const backend = await makeBackend();
    const applicationGraph = sidecarShapedGraph();
    const [applicationStore] = await createStoreWithSchema(
      applicationGraph,
      backend,
    );
    await applicationStore.nodes.Provenance.create(
      {
        targetGraphId: careGraph.id,
        role: "node",
        canonicalId: "application-canonical",
        canonicalKind: "Patient",
        branchId: "application-branch",
        sourceId: "application-source",
      },
      { id: "application-owned-row" },
    );

    // `unowned-exact-schema-graph` is reachable ONLY on the branch where the
    // active schema hash EQUALS the sidecar's and the marker is missing, so the
    // discriminant pins this test to the missing-marker branch rather than to
    // any hash mismatch. (The same graph definition with no rows is ADOPTED by
    // the interrupted-creation test above — the other half of that proof.)
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).rejects.toMatchObject({
      name: "ConfigurationError",
      details: {
        code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
        reason: "unowned-exact-schema-graph",
      },
    });
    await expect(
      applicationStore.nodes.Provenance.getById(
        "application-owned-row" as never,
      ),
    ).resolves.toMatchObject({ id: "application-owned-row" });
    await expect(readOwnerMarker(backend)).resolves.toBeUndefined();
  });

  it("upgrades a populated legacy sidecar and preserves its contributions", async () => {
    const backend = await makeBackend();
    const [legacyStore] = await createStoreWithSchema(
      legacyShapedGraph(),
      backend,
    );
    const legacyRecord = {
      role: "node",
      canonicalId: "legacy-canonical",
      canonicalKind: "Patient",
      branchId: BRANCH_A,
      sourceId: "legacy-source",
    } as const;
    const legacyId = await provenanceNodeId(careGraph.id, legacyRecord);
    await legacyStore.nodes.Provenance.create(
      { targetGraphId: careGraph.id, ...legacyRecord },
      { id: legacyId },
    );

    const upgraded = await openProvenanceStore(backend, careGraph.id);
    await expect(
      upgraded.nodes.Provenance.getById(legacyId as never),
    ).resolves.toMatchObject({
      id: legacyId,
      canonicalId: "legacy-canonical",
      sourceId: "legacy-source",
    });

    // A second open must use the durable marker written by the upgrade rather
    // than falling back to the legacy schema/content recognition path.
    await expect(
      openProvenanceStore(backend, careGraph.id),
    ).resolves.toBeDefined();
  });
});

describe("provenance row identity", () => {
  const record = {
    role: "node",
    canonicalId: "pat-canonical",
    canonicalKind: "Patient",
    branchId: BRANCH_A,
    sourceId: "pat-fork",
  } as const;

  it("preserves application graph ids that predate the sidecar convention", () => {
    expect(
      defineGraph({
        id: provenanceGraphId("care-graph"),
        nodes: { Patient: { type: Patient } },
        edges: {},
      }).id,
    ).toBe("care-graph::merge-provenance");
  });

  it("hashes a contribution to a stable id across versions", async () => {
    // Pinned as a literal because the id is a CROSS-VERSION contract: rows in a
    // sidecar written by an earlier release are re-upserted rather than orphaned
    // and duplicated only while the same contribution keeps hashing to this id.
    expect(await provenanceNodeId("care-graph", record)).toBe(
      "prov_4d724f22030e40e5603682bd44f6ca0d",
    );
  });

  it("keeps every identifying field in the key collapses are keyed on", () => {
    // A key NARROWER than the row identity would silently merge two genuinely
    // distinct contributions, which is the one way a collapse can lose data.
    const keys = new Set([
      contributionKey(record),
      contributionKey({ ...record, role: "edge" }),
      contributionKey({ ...record, canonicalKind: "Encounter" }),
      contributionKey({ ...record, canonicalId: "other-canonical" }),
      contributionKey({ ...record, branchId: BRANCH_B }),
      contributionKey({ ...record, sourceId: "other-fork" }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("does not collapse contributions when a NUL moves between fields", async () => {
    const left = {
      ...record,
      canonicalId: "canonical\0branch",
      branchId: asBranchId("source"),
    };
    const right = {
      ...record,
      canonicalId: "canonical",
      branchId: asBranchId("branch\0source"),
    };

    expect(contributionKey(left)).not.toBe(contributionKey(right));
    expect(await provenanceNodeId("care-graph", left)).not.toBe(
      await provenanceNodeId("care-graph", right),
    );
  });
});
