import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  asEdgeId,
  asNodeId,
  CardinalityError,
  ConfigurationError,
  createStoreWithSchema,
  createVerifiedStore,
  defineEdge,
  defineGraph,
  defineNode,
  defineNodeIndex,
  DisjointError,
  disjointWith,
  EndpointNotFoundError,
  subClassOf,
  UniquenessError,
} from "@nicia-ai/typegraph";
import fc from "fast-check";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import type { TransactionBackend } from "../../src/backend/types";
import type { UniqueConstraint } from "../../src/core/types";
import { ingestionBranch } from "../../src/graph-merge";
import { branch } from "../../src/graph-merge/branch";
import {
  IdentityMergeConflictError,
  MergeConstraintConflictError,
} from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, unwrap } from "../../src/graph-merge/result";
import type {
  BranchId,
  GraphBranch,
  IngestionBranch,
} from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import {
  type GraphData,
  type GraphInterchangeChunk,
  importGraph,
  importGraphStream,
} from "../../src/interchange";
import { buildKindRegistry } from "../../src/registry";
import type { KindRegistry } from "../../src/registry/kind-registry";
import { parseSerializedSchema } from "../../src/schema";
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
} from "../../src/store/claims/axis";
import { nodeClaimEntries } from "../../src/store/claims/node-claims";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, createSqliteMergeBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});

const ClinicalEntity = defineNode("ClinicalEntity", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});

const Practitioner = defineNode("Practitioner", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});

const AdministrativeRecord = defineNode("AdministrativeRecord", {
  schema: z.object({ label: z.string() }),
});

const Facility = defineNode("Facility", {
  schema: z.object({ name: z.string() }),
});

const primaryFacility = defineEdge("primaryFacility", {
  schema: z.object({ source: z.string() }),
  from: [Patient],
  to: [Facility],
});

const patientMrnCandidates = defineNodeIndex(Patient, {
  name: "patient_mrn_candidates",
  fields: ["mrn"],
});

const ingestionGraph = defineGraph({
  id: "constraint-aware-ingestion",
  nodes: {
    ClinicalEntity: {
      type: ClinicalEntity,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    Patient: {
      type: Patient,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    Practitioner: {
      type: Practitioner,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kindWithSubClasses",
          collation: "binary",
        },
      ],
    },
    AdministrativeRecord: { type: AdministrativeRecord },
    Facility: { type: Facility },
  },
  edges: {
    primaryFacility: {
      type: primaryFacility,
      from: [Patient],
      to: [Facility],
      cardinality: "oneActive",
    },
  },
  indexes: [patientMrnCandidates],
  ontology: [
    subClassOf(Patient, ClinicalEntity),
    subClassOf(Practitioner, ClinicalEntity),
    disjointWith(Patient, AdministrativeRecord),
  ],
  identity: { sameIdAcrossKinds: "ignore" },
});

const relaxedIngestionGraph = defineGraph({
  id: "constraint-aware-ingestion",
  nodes: {
    ClinicalEntity: { type: ClinicalEntity },
    Patient: { type: Patient },
    Practitioner: { type: Practitioner },
    AdministrativeRecord: { type: AdministrativeRecord },
    Facility: { type: Facility },
  },
  edges: ingestionGraph.edges,
  indexes: [patientMrnCandidates],
  ontology: ingestionGraph.ontology,
  identity: { sameIdAcrossKinds: "ignore" },
});

const identityDisabledGraph = defineGraph({
  id: "constraint-aware-ingestion-without-identity",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

type IngestionGraph = typeof ingestionGraph;
type IngestionStore = Store<IngestionGraph>;

const INCOMING = asBranchId("incoming");

async function* interchangeChunks(
  chunks: readonly GraphInterchangeChunk[],
): AsyncIterable<GraphInterchangeChunk> {
  for (const chunk of chunks) {
    await Promise.resolve();
    yield chunk;
  }
}

const RESOLVED_BATCH_METHODS = new Set<PropertyKey>([
  "checkUniqueBatch",
  "insertUniqueBatch",
  "hardDeleteUniquesByNodeIds",
]);

function withoutResolvedBatchMethods(
  transaction: TransactionBackend,
): TransactionBackend {
  return new Proxy(transaction, {
    get(target, property, receiver) {
      return RESOLVED_BATCH_METHODS.has(property) ? undefined : (
          (Reflect.get(target, property, receiver) as unknown)
        );
    },
  });
}

function withoutResolvedBatchTransaction(backend: GraphBackend): GraphBackend {
  const transaction: GraphBackend["transaction"] = async (fn, options) =>
    backend.transaction(
      async (tx) => fn(withoutResolvedBatchMethods(tx)),
      options,
    );
  return new Proxy(backend, {
    get(target, property, receiver) {
      return property === "transaction" ? transaction : (
          (Reflect.get(target, property, receiver) as unknown)
        );
    },
  });
}

function incrementalOptions() {
  return {
    resolve: {
      Patient: {
        blockIndex: "patient_mrn_candidates",
        similarity: { kind: "fulltext" as const, fields: ["name"] },
        threshold: 0.8,
      },
    },
    onBasePropertyConflict: "flag" as const,
    branchOrder: [INCOMING],
  };
}

describe.each(backendMatrix())(
  "constraint-aware ingestion branch [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) await cleanup();
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeStore(
      options: Readonly<{ coalesceUnchangedUpserts?: boolean }> = {},
    ): Promise<IngestionStore> {
      const [store] = await createStoreWithSchema(
        ingestionGraph,
        await makeBackend(),
        { revisionTracking: true, ...options },
      );
      return store;
    }

    async function cloneStore(
      source: IngestionStore,
      id: BranchId,
    ): Promise<GraphBranch<IngestionGraph>> {
      return unwrap(
        await branch(source, () => makeBackend(), {
          id,
        }),
      );
    }

    async function makeIngestion(
      source: IngestionStore,
      id: BranchId = INCOMING,
    ): Promise<IngestionBranch<IngestionGraph>> {
      return unwrap(
        await ingestionBranch(source, () => makeBackend(), {
          id,
        }),
      );
    }

    async function seedCanonical(store: IngestionStore): Promise<void> {
      await store.nodes.Patient.create(
        { name: "Ana Rivera", mrn: "MRN-123" },
        { id: "patient-canonical" },
      );
      await store.nodes.Facility.create(
        { name: "General Hospital" },
        { id: "facility-1" },
      );
    }

    it("stages a repeated canonical key, recalls it through blockIndex, and repoints its edge on reviewed apply", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await seedCanonical(forkPoint);
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("persistent-target"),
      );
      const incoming = await makeIngestion(forkPoint);

      await incoming.nodes.Patient.create(
        { name: "Anna Rivera", mrn: "MRN-123" },
        { id: "patient-alias" },
      );
      await incoming.edges.primaryFacility.create(
        { kind: "Patient", id: "patient-alias" },
        { kind: "Facility", id: "facility-1" },
        { source: "provider-a" },
        { id: "edge-from-alias" },
      );

      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: incrementalOptions(),
        }),
      );
      expect(
        plan.review.resolutions.some(
          (resolution) =>
            resolution.canonicalId === "patient-canonical" &&
            resolution.memberIds.includes(asNodeId("patient-alias")) &&
            resolution.memberIds.includes(asNodeId("patient-canonical")),
        ),
      ).toBe(true);

      unwrap(await applyMergePlan(targetClone.store, plan));

      const patients = await targetClone.store.nodes.Patient.find();
      expect(patients.map((patient) => patient.id)).toEqual([
        "patient-canonical",
      ]);
      const edge = requireDefined(
        await targetClone.store.edges.primaryFacility.getById(
          asEdgeId<typeof primaryFacility>("edge-from-alias"),
        ),
      );
      expect(edge.fromId).toBe("patient-canonical");
      expect(edge.toId).toBe("facility-1");
    });

    it("accepts a complete interchange document as an ingestion target", async () => {
      cleanups = [];
      const base = await makeStore();
      await seedCanonical(base);
      const canonical = requireDefined(
        await base.nodes.Patient.getById(asNodeId("patient-canonical")),
      );
      const identityValidFrom = requireDefined(canonical.meta.validFrom);
      const incoming = await makeIngestion(base);
      const validFrom = "2025-01-01T00:00:00.000Z";
      const validTo = "2030-01-01T00:00:00.000Z";
      const document = {
        formatVersion: "2.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "external", description: "provider-a" },
        nodes: [
          {
            kind: "Patient",
            id: "patient-imported",
            properties: { name: "Anna Rivera", mrn: "MRN-123" },
            validFrom,
            validTo,
          },
          {
            kind: "Patient",
            id: "patient-identity-imported",
            properties: { name: "Ana Identity", mrn: "MRN-IDENTITY" },
            validFrom: identityValidFrom,
          },
        ],
        edges: [
          {
            kind: "primaryFacility",
            id: "edge-imported",
            from: { kind: "Patient", id: "patient-imported" },
            to: { kind: "Facility", id: "facility-1" },
            properties: { source: "provider-a" },
            validFrom,
            validTo,
          },
        ],
        identity: {
          profile: "typegraph-identity-v1",
          mode: "state",
          assertions: [
            {
              id: "identity-imported",
              relation: "same",
              a: { kind: "Patient", id: "patient-canonical" },
              b: { kind: "Patient", id: "patient-identity-imported" },
              validFrom: identityValidFrom,
            },
          ],
        },
      } satisfies GraphData;

      const result = await importGraph(incoming, document, {
        onConflict: "error",
      });

      expect(result.errors).toEqual([]);
      expect(result.success).toBe(true);
      expect(result.nodes.created).toBe(2);
      expect(result.edges.created).toBe(1);
      expect(result.identity).toEqual({ created: 1, skipped: 0 });
      expect(
        await incoming.nodes.Patient.getById(asNodeId("patient-imported"), {
          temporalMode: "includeEnded",
        }),
      ).toMatchObject({
        id: "patient-imported",
        meta: { validFrom, validTo },
      });
      expect(
        await incoming.edges.primaryFacility.getById(
          asEdgeId<typeof primaryFacility>("edge-imported"),
          { temporalMode: "includeEnded" },
        ),
      ).toMatchObject({
        fromId: "patient-imported",
        toId: "facility-1",
        meta: { validFrom, validTo },
      });
    });

    it("accepts an interchange stream as an ingestion target", async () => {
      cleanups = [];
      const base = await makeStore();
      await seedCanonical(base);
      const incoming = await makeIngestion(base);
      const header = {
        formatVersion: "2.0",
        exportedAt: "2026-01-01T00:00:00.000Z",
        source: { type: "external", description: "provider-b" },
      } as const;

      const result = await importGraphStream(
        incoming,
        interchangeChunks([
          { type: "header", header },
          {
            type: "nodes",
            nodes: [
              {
                kind: "Patient",
                id: "patient-streamed",
                properties: { name: "Ana R.", mrn: "MRN-123" },
              },
            ],
          },
          {
            type: "edges",
            edges: [
              {
                kind: "primaryFacility",
                id: "edge-streamed",
                from: { kind: "Patient", id: "patient-streamed" },
                to: { kind: "Facility", id: "facility-1" },
                properties: { source: "provider-b" },
              },
            ],
          },
        ]),
        { onConflict: "error" },
      );

      expect(result.success).toBe(true);
      expect(
        await incoming.edges.primaryFacility.getById(
          asEdgeId<typeof primaryFacility>("edge-streamed"),
        ),
      ).toMatchObject({
        fromId: "patient-streamed",
        toId: "facility-1",
      });
    });

    it("keeps ordinary branch uniqueness immediate", async () => {
      cleanups = [];
      const base = await makeStore();
      await seedCanonical(base);
      const ordinary = await cloneStore(base, asBranchId("ordinary"));

      await expect(
        ordinary.store.nodes.Patient.create(
          { name: "Anna Rivera", mrn: "MRN-123" },
          { id: "patient-alias" },
        ),
      ).rejects.toThrow(UniquenessError);
    });

    it("exposes identity writes without exposing identity reads", async () => {
      cleanups = [];
      const base = await makeStore();
      const incoming = await makeIngestion(base);

      expect("identity" in incoming).toBe(true);
      expectTypeOf(incoming).toHaveProperty("identity");
      expectTypeOf(incoming.identity).toHaveProperty("assertSame");
      expectTypeOf(incoming.identity).toHaveProperty("assertDifferent");
      expectTypeOf(incoming.identity).not.toHaveProperty("areSame");
      expectTypeOf(incoming.identity).not.toHaveProperty("membersOf");
      expectTypeOf(incoming.identity).not.toHaveProperty("retractAssertion");
      expectTypeOf(incoming.identity).not.toHaveProperty(
        "retractSameAssertion",
      );
      expectTypeOf(incoming.identity).not.toHaveProperty(
        "retractDifferentAssertion",
      );
      expectTypeOf(incoming.identity).not.toHaveProperty(
        "bulkRetractAssertions",
      );
      expect("areSame" in incoming.identity).toBe(false);
      expect("membersOf" in incoming.identity).toBe(false);
      expect("assertionsOf" in incoming.identity).toBe(false);
      expect("retractAssertion" in incoming.identity).toBe(false);
      expect("retractSameAssertion" in incoming.identity).toBe(false);
      expect("retractDifferentAssertion" in incoming.identity).toBe(false);
      expect("bulkRetractAssertions" in incoming.identity).toBe(false);
    });

    it("omits identity for identity-disabled graphs", async () => {
      cleanups = [];
      const [base] = await createStoreWithSchema(
        identityDisabledGraph,
        await makeBackend(),
        { revisionTracking: true },
      );
      const incoming = unwrap(
        await ingestionBranch(base, () => makeBackend(), { id: INCOMING }),
      );

      expectTypeOf(incoming).not.toHaveProperty("identity");
      expect("identity" in incoming).toBe(false);
    });

    it("stages bulk same and different assertions through the narrow facade", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("bulk-identity-target"),
      );
      const incoming = await makeIngestion(forkPoint);
      const created = await incoming.nodes.Patient.bulkCreate([
        {
          id: "same-left",
          props: { name: "Same left", mrn: "MRN-SAME-LEFT" },
        },
        {
          id: "same-right",
          props: { name: "Same right", mrn: "MRN-SAME-RIGHT" },
        },
        {
          id: "different-left",
          props: { name: "Different left", mrn: "MRN-DIFFERENT-LEFT" },
        },
        {
          id: "different-right",
          props: { name: "Different right", mrn: "MRN-DIFFERENT-RIGHT" },
        },
      ]);
      const sameLeft = requireDefined(created[0]);
      const sameRight = requireDefined(created[1]);
      const differentLeft = requireDefined(created[2]);
      const differentRight = requireDefined(created[3]);
      const sameResults = await incoming.identity.bulkAssertSame([
        { a: sameLeft, b: sameRight },
      ]);
      const differentResults = await incoming.identity.bulkAssertDifferent([
        { a: differentLeft, b: differentRight },
      ]);

      expect(sameResults.map((result) => result.action)).toEqual(["created"]);
      expect(differentResults.map((result) => result.action)).toEqual([
        "created",
      ]);
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      expect(
        await targetClone.store.identity.areSame(sameLeft, sameRight),
      ).toBe(true);
      expect(
        await targetClone.store.identity.areDifferent(
          differentLeft,
          differentRight,
        ),
      ).toBe(true);
    });

    it("preserves validity windows from single and bulk identity assertions", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("identity-validity-target"),
      );
      const incoming = await makeIngestion(forkPoint);
      const created = await incoming.nodes.Patient.bulkCreate(
        [
          "single-same-left",
          "single-same-right",
          "single-different-left",
          "single-different-right",
          "bulk-same-left",
          "bulk-same-right",
          "bulk-different-left",
          "bulk-different-right",
        ].map((id) => ({
          id,
          props: { name: id, mrn: `MRN-${id}` },
          validFrom: "2020-01-01T00:00:00.000Z",
        })),
      );
      const singleSameLeft = requireDefined(created[0]);
      const singleSameRight = requireDefined(created[1]);
      const singleDifferentLeft = requireDefined(created[2]);
      const singleDifferentRight = requireDefined(created[3]);
      const bulkSameLeft = requireDefined(created[4]);
      const bulkSameRight = requireDefined(created[5]);
      const bulkDifferentLeft = requireDefined(created[6]);
      const bulkDifferentRight = requireDefined(created[7]);
      const singleSame = await incoming.identity.assertSame(
        singleSameLeft,
        singleSameRight,
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
      );
      const singleDifferent = await incoming.identity.assertDifferent(
        singleDifferentLeft,
        singleDifferentRight,
        {
          validFrom: "2021-01-01T00:00:00.000Z",
          validTo: "2022-01-01T00:00:00.000Z",
        },
      );
      const [bulkSame] = await incoming.identity.bulkAssertSame([
        {
          a: bulkSameLeft,
          b: bulkSameRight,
          validFrom: "2022-01-01T00:00:00.000Z",
          validTo: "2023-01-01T00:00:00.000Z",
        },
      ]);
      const [bulkDifferent] = await incoming.identity.bulkAssertDifferent([
        {
          a: bulkDifferentLeft,
          b: bulkDifferentRight,
          validFrom: "2023-01-01T00:00:00.000Z",
          validTo: "2024-01-01T00:00:00.000Z",
        },
      ]);
      const expectedAssertions = [
        [singleSameLeft, singleSame.assertion, "2020-06-01T00:00:00.000Z"],
        [
          singleDifferentLeft,
          singleDifferent.assertion,
          "2021-06-01T00:00:00.000Z",
        ],
        [
          bulkSameLeft,
          requireDefined(bulkSame).assertion,
          "2022-06-01T00:00:00.000Z",
        ],
        [
          bulkDifferentLeft,
          requireDefined(bulkDifferent).assertion,
          "2023-06-01T00:00:00.000Z",
        ],
      ] as const;

      expect(
        expectedAssertions.map(([, assertion]) => ({
          validFrom: assertion.validFrom,
          validTo: assertion.validTo,
        })),
      ).toEqual([
        {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
        {
          validFrom: "2021-01-01T00:00:00.000Z",
          validTo: "2022-01-01T00:00:00.000Z",
        },
        {
          validFrom: "2022-01-01T00:00:00.000Z",
          validTo: "2023-01-01T00:00:00.000Z",
        },
        {
          validFrom: "2023-01-01T00:00:00.000Z",
          validTo: "2024-01-01T00:00:00.000Z",
        },
      ]);
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      for (const [ref, assertion, asOf] of expectedAssertions) {
        expect(
          await targetClone.store.asOf(asOf).identity.assertionsOf(ref),
        ).toEqual([assertion]);
      }
    });

    it("stages and merges a duplicate unique alias asserted as the same identity", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await seedCanonical(forkPoint);
      const canonical = requireDefined(
        await forkPoint.nodes.Patient.getById(asNodeId("patient-canonical")),
      );
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("identity-same-target"),
      );
      const incoming = await makeIngestion(forkPoint);

      const alias = await incoming.nodes.Patient.create(
        { name: "Anna Rivera", mrn: "MRN-123" },
        { id: "patient-alias" },
      );
      const assertion = await incoming.identity.assertSame(canonical, alias);

      expect(assertion.action).toBe("created");
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: incrementalOptions(),
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      expect(
        (await targetClone.store.nodes.Patient.find()).map((node) => node.id),
      ).toEqual(["patient-canonical"]);
    });

    it("stages a duplicate unique alias asserted as different and reports a merge conflict", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await seedCanonical(forkPoint);
      const canonical = requireDefined(
        await forkPoint.nodes.Patient.getById(asNodeId("patient-canonical")),
      );
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("identity-different-target"),
      );
      const incoming = await makeIngestion(forkPoint);

      const alias = await incoming.nodes.Patient.create(
        { name: "Anna Rivera", mrn: "MRN-123" },
        { id: "patient-alias" },
      );
      const assertion = await incoming.identity.assertDifferent(
        canonical,
        alias,
      );

      expect(assertion.action).toBe("created");
      const result = await planMergeIncremental({
        forkPoint,
        target: targetClone.store,
        branches: [incoming],
        options: incrementalOptions(),
      });

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    });

    it("validates the resolved write set as a set so unique-key swaps succeed", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.Patient.bulkCreate([
        {
          id: "patient-a",
          props: { name: "Patient A", mrn: "MRN-A" },
        },
        {
          id: "patient-b",
          props: { name: "Patient B", mrn: "MRN-B" },
        },
      ]);
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("persistent-target"),
      );
      const incoming = await makeIngestion(forkPoint);

      await incoming.nodes.Patient.update(asNodeId("patient-a"), {
        mrn: "MRN-B",
      });
      await incoming.nodes.Patient.update(asNodeId("patient-b"), {
        mrn: "MRN-A",
      });

      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      expect(
        await targetClone.store.nodes.Patient.getById(asNodeId("patient-a")),
      ).toMatchObject({ mrn: "MRN-B" });
      expect(
        await targetClone.store.nodes.Patient.getById(asNodeId("patient-b")),
      ).toMatchObject({ mrn: "MRN-A" });
    });

    it("allows one resolved row to release a unique key while another claims it", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.Patient.create(
        { name: "Previous holder", mrn: "MRN-SHARED" },
        { id: "previous-holder" },
      );
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("persistent-target"),
      );
      const incoming = await makeIngestion(forkPoint);
      await incoming.nodes.Patient.update(asNodeId("previous-holder"), {
        mrn: "MRN-MOVED",
      });
      await incoming.nodes.Patient.create(
        { name: "New holder", mrn: "MRN-SHARED" },
        { id: "new-holder" },
      );

      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      expect(
        await targetClone.store.nodes.Patient.getById(
          asNodeId("previous-holder"),
        ),
      ).toMatchObject({ mrn: "MRN-MOVED" });
      expect(
        await targetClone.store.nodes.Patient.getById(asNodeId("new-holder")),
      ).toMatchObject({ mrn: "MRN-SHARED" });
    });

    it("validates modification-only writes from their complete after-images", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      await forkPoint.nodes.Patient.bulkCreate([
        {
          id: "patient-a",
          props: { name: "Patient A", mrn: "MRN-A" },
        },
        {
          id: "patient-b",
          props: { name: "Patient B", mrn: "MRN-B" },
        },
      ]);
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("persistent-target"),
      );
      const incoming = await makeIngestion(forkPoint);
      await incoming.nodes.Patient.update(asNodeId("patient-a"), {
        name: "Updated A",
      });
      await incoming.nodes.Patient.update(asNodeId("patient-b"), {
        name: "Updated B",
      });

      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      unwrap(await applyMergePlan(targetClone.store, plan));

      expect(
        await targetClone.store.nodes.Patient.getById(asNodeId("patient-a")),
      ).toMatchObject({ name: "Updated A", mrn: "MRN-A" });
      expect(
        await targetClone.store.nodes.Patient.getById(asNodeId("patient-b")),
      ).toMatchObject({ name: "Updated B", mrn: "MRN-B" });
      await expect(
        targetClone.store.nodes.Patient.create({
          name: "Duplicate",
          mrn: "MRN-A",
        }),
      ).rejects.toThrow(UniquenessError);
    });

    it("rebuilds uniqueness sidecars when an unchanged canonical upsert is coalesced", async () => {
      cleanups = [];
      const base = await makeStore({ coalesceUnchangedUpserts: true });
      await seedCanonical(base);
      const incoming = await makeIngestion(base);
      await incoming.nodes.Patient.create(
        { name: "Ana Rivera", mrn: "MRN-123" },
        { id: "patient-alias" },
      );
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint: base,
          target: base,
          branches: [incoming],
          options: incrementalOptions(),
        }),
      );

      unwrap(await applyMergePlan(base, plan));

      await expect(
        base.nodes.Patient.create({
          name: "Duplicate",
          mrn: "MRN-123",
        }),
      ).rejects.toThrow(UniquenessError);
    });

    it("rebuilds the disjointness claims its preparation cleared", async () => {
      // The set preflight clears claims by OWNER, and a node's owned claims are
      // both families — so a rebuild that restored only uniqueness would leave
      // every merged node permanently unfenced against a disjoint namesake. The
      // coalesced upsert is the shape that makes it visible: the row write is
      // elided, so the final rebuild is the ONLY thing that can put the row back.
      cleanups = [];
      const backend = await makeBackend();
      const [base] = await createStoreWithSchema(ingestionGraph, backend, {
        revisionTracking: true,
        coalesceUnchangedUpserts: true,
      });
      await seedCanonical(base);
      const disjointnessClaim = {
        graphId: base.graphId,
        nodeKind: disjointnessClaimAxis(
          "Patient",
          "AdministrativeRecord",
          buildKindRegistry(ingestionGraph),
        ),
        constraintName: DISJOINT_CONSTRAINT_NAME,
        key: "patient-canonical",
      };
      expect(await backend.checkUnique(disjointnessClaim)).toMatchObject({
        concrete_kind: "Patient",
        node_id: "patient-canonical",
      });

      const incoming = await makeIngestion(base);
      await incoming.nodes.Patient.create(
        { name: "Ana Rivera", mrn: "MRN-123" },
        { id: "patient-alias" },
      );
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint: base,
          target: base,
          branches: [incoming],
          options: incrementalOptions(),
        }),
      );

      unwrap(await applyMergePlan(base, plan));

      expect(await backend.checkUnique(disjointnessClaim)).toMatchObject({
        concrete_kind: "Patient",
        node_id: "patient-canonical",
      });
    });

    it("produces the same canonical result for either alias ingestion order", async () => {
      cleanups = [];

      async function applyOrder(order: readonly string[]) {
        const forkPoint = await makeStore();
        await seedCanonical(forkPoint);
        const targetClone = await cloneStore(
          forkPoint,
          asBranchId(`target-${order.join("-")}`),
        );
        const incoming = await makeIngestion(forkPoint);
        await incoming.nodes.Patient.bulkCreate(
          order.map((id) => ({
            id,
            props: { name: "Anna Rivera", mrn: "MRN-123" },
          })),
        );

        const plan = unwrap(
          await planMergeIncremental({
            forkPoint,
            target: targetClone.store,
            branches: [incoming],
            options: incrementalOptions(),
          }),
        );
        unwrap(await applyMergePlan(targetClone.store, plan));
        return {
          patientIds: (await targetClone.store.nodes.Patient.find()).map(
            (patient) => patient.id,
          ),
          resolutions: plan.review.resolutions.map((resolution) => ({
            canonicalId: resolution.canonicalId,
            memberIds: [...resolution.memberIds].sort(),
          })),
        };
      }

      const forward = await applyOrder(["alias-a", "alias-b"]);
      const reverse = await applyOrder(["alias-b", "alias-a"]);
      expect(reverse).toEqual(forward);
      expect(forward.patientIds).toEqual(["patient-canonical"]);
    });

    it("still enforces endpoint, cardinality, and disjointness constraints while staging", async () => {
      cleanups = [];
      const base = await makeStore();
      const incoming = await makeIngestion(base);
      expectTypeOf(incoming.nodes.Patient).not.toHaveProperty(
        "findByConstraint",
      );
      await expect(
        incoming.nodes.Patient.create({
          name: "Invalid patient",
          mrn: 42 as unknown as string,
        }),
      ).rejects.toThrow();
      await incoming.nodes.Patient.create(
        { name: "Ana Rivera", mrn: "MRN-123" },
        { id: "patient-1" },
      );
      await incoming.nodes.Facility.create(
        { name: "General Hospital" },
        { id: "facility-1" },
      );
      await incoming.nodes.Facility.create(
        { name: "Specialty Clinic" },
        { id: "facility-2" },
      );

      await expect(
        incoming.edges.primaryFacility.create(
          { kind: "Patient", id: "missing-patient" },
          { kind: "Facility", id: "facility-1" },
          { source: "provider-a" },
        ),
      ).rejects.toThrow(EndpointNotFoundError);

      await incoming.edges.primaryFacility.create(
        { kind: "Patient", id: "patient-1" },
        { kind: "Facility", id: "facility-1" },
        { source: "provider-a" },
      );
      await expect(
        incoming.edges.primaryFacility.create(
          { kind: "Patient", id: "patient-1" },
          { kind: "Facility", id: "facility-2" },
          { source: "provider-a" },
        ),
      ).rejects.toThrow(CardinalityError);

      await expect(
        incoming.nodes.AdministrativeRecord.create(
          { label: "Patient billing record" },
          { id: "patient-1" },
        ),
      ).rejects.toThrow(DisjointError);
    });

    it("persists the derived schema and exposes no Store escape hatch", async () => {
      cleanups = [];
      const base = await makeStore();
      let ingestionBackend: GraphBackend | undefined;
      const incoming = unwrap(
        await ingestionBranch(
          base,
          async () => {
            ingestionBackend = await makeBackend();
            return ingestionBackend;
          },
          { id: INCOMING },
        ),
      );

      expect("store" in incoming).toBe(false);
      expectTypeOf(incoming).not.toHaveProperty("store");
      const activeSchema = requireDefined(
        await requireDefined(ingestionBackend).getActiveSchema(base.graphId),
      );
      const persisted = parseSerializedSchema(activeSchema.schema_doc);
      expect(persisted.nodes["Patient"]?.uniqueConstraints).toEqual([]);
      expect(persisted.nodes["Practitioner"]?.uniqueConstraints).toEqual([]);
      expect(persisted.edges["primaryFacility"]?.cardinality).toBe("oneActive");
      expect(persisted.indexes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "patient_mrn_candidates" }),
        ]),
      );

      const [reloaded] = await createVerifiedStore(
        relaxedIngestionGraph,
        requireDefined(ingestionBackend),
        { revisionTracking: true },
      );
      await reloaded.nodes.Patient.bulkCreate([
        {
          id: "reloaded-a",
          props: { name: "Reloaded A", mrn: "MRN-RELOADED" },
        },
        {
          id: "reloaded-b",
          props: { name: "Reloaded B", mrn: "MRN-RELOADED" },
        },
      ]);
      expect(await reloaded.nodes.Patient.count()).toBe(2);
    });

    it("refuses final validation when the target transaction lacks batch uniqueness operations", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const targetClone = unwrap(
        await branch(
          forkPoint,
          async () => withoutResolvedBatchTransaction(await makeBackend()),
          { id: asBranchId("limited-target") },
        ),
      );
      const incoming = await makeIngestion(forkPoint);
      await incoming.nodes.Patient.create(
        { name: "New patient", mrn: "MRN-NEW" },
        { id: "patient-new" },
      );
      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );

      const result = await applyMergePlan(targetClone.store, plan);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error.cause).toBeInstanceOf(ConfigurationError);
      expect((result.error.cause as ConfigurationError).details).toMatchObject({
        code: "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED",
      });
      expect(await targetClone.store.nodes.Patient.find()).toEqual([]);
    });

    it("returns an atomic MergeConstraintConflictError when cross-kind duplicates remain unresolved", async () => {
      cleanups = [];
      const forkPoint = await makeStore();
      const targetClone = await cloneStore(
        forkPoint,
        asBranchId("persistent-target"),
      );
      const incoming = await makeIngestion(forkPoint);
      await incoming.nodes.Patient.create(
        { name: "Ana Rivera", mrn: "SHARED-1" },
        { id: "shared-entity" },
      );
      await incoming.nodes.Practitioner.create(
        { name: "A. Rivera", mrn: "SHARED-1" },
        { id: "shared-entity" },
      );

      const plan = unwrap(
        await planMergeIncremental({
          forkPoint,
          target: targetClone.store,
          branches: [incoming],
          options: { onBasePropertyConflict: "flag" },
        }),
      );
      const result = await applyMergePlan(targetClone.store, plan);

      expect(isErr(result)).toBe(true);
      if (!isErr(result)) return;
      expect(result.error).toBeInstanceOf(MergeConstraintConflictError);
      expect(result.error.cause).toBeInstanceOf(UniquenessError);
      expect(await targetClone.store.nodes.Patient.find()).toEqual([]);
      expect(await targetClone.store.nodes.Practitioner.find()).toEqual([]);
    });
  },
);

// What "an ingestion branch defers node uniqueness" means where the store
// actually enforces it. A row's reservations are `nodeClaimEntries`, and the
// derivation removes `unique` — the only input to that list's uniqueness family.
// Asserting it through the list rather than through the declarations is what
// keeps "and nothing else" true: a derivation reaching one field too far would
// drop the disjointness entry here, and a claim family added later shows up in
// this comparison instead of silently surviving onto the clone.
describe("the ingestion derivation drops exactly the uniqueness claim family", () => {
  const canonicalRegistry = buildKindRegistry(ingestionGraph);
  const derivedRegistry = buildKindRegistry(relaxedIngestionGraph);

  function claimedFamilies(
    registry: KindRegistry,
    unique: readonly UniqueConstraint[],
  ): readonly string[] {
    return nodeClaimEntries(
      registry,
      "Patient",
      "patient-1",
      { name: "Ana Rivera", mrn: "MRN-123" },
      unique,
      "create",
    ).map((entry) => entry.refusal.kind);
  }

  it("owes both families on the canonical graph", () => {
    expect(
      claimedFamilies(
        canonicalRegistry,
        requireDefined(ingestionGraph.nodes.Patient.unique),
      ),
    ).toEqual(["disjointness", "uniqueness"]);
  });

  // The empty list is what the derivation leaves behind — "persists the derived
  // schema" above asserts the persisted registration's `uniqueConstraints` is
  // `[]`. This is the other half: given that, the row's claim entries lose the
  // uniqueness family and keep the disjointness one, which comes from the
  // registry the derivation does not touch.
  it("owes only the disjointness family on the derived graph", () => {
    expect(claimedFamilies(derivedRegistry, [])).toEqual(["disjointness"]);
  });
});

it("refuses an unregistered ingestion import capability at the boundary", async () => {
  const forgedTarget = {} as unknown as IngestionBranch<IngestionGraph>;
  const emptyDocument = {
    formatVersion: "2.0",
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "external", description: "forged-target" },
    nodes: [],
    edges: [],
  } satisfies GraphData;

  await expect(
    importGraph(forgedTarget, emptyDocument, { onConflict: "error" }),
  ).rejects.toMatchObject({
    name: "ConfigurationError",
    details: { target: "unregistered-ingestion-target" },
  });
});

describe("resolved ingestion uniqueness properties", () => {
  it("preserves unique-key swaps for arbitrary distinct keys and either staging order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .tuple(
            fc.string({ minLength: 1, maxLength: 12 }),
            fc.string({ minLength: 1, maxLength: 12 }),
          )
          .filter(([left, right]) => left !== right),
        fc.boolean(),
        async ([leftKey, rightKey], reverseOrder) => {
          const fixtures: (() => Promise<void>)[] = [];
          async function makeBackend(): Promise<GraphBackend> {
            const fixture = createSqliteMergeBackend();
            fixtures.push(fixture.cleanup);
            return fixture.backend;
          }

          try {
            const [forkPoint] = await createStoreWithSchema(
              ingestionGraph,
              await makeBackend(),
              { revisionTracking: true },
            );
            await forkPoint.nodes.Patient.bulkCreate([
              {
                id: "patient-left",
                props: { name: "Left", mrn: leftKey },
              },
              {
                id: "patient-right",
                props: { name: "Right", mrn: rightKey },
              },
            ]);
            const target = unwrap(
              await branch(forkPoint, () => makeBackend(), {
                id: asBranchId("property-target"),
              }),
            );
            const incoming = unwrap(
              await ingestionBranch(forkPoint, () => makeBackend(), {
                id: INCOMING,
              }),
            );
            const updates = [
              { id: "patient-left", mrn: rightKey },
              { id: "patient-right", mrn: leftKey },
            ];
            for (const update of reverseOrder ?
              updates.toReversed()
            : updates) {
              await incoming.nodes.Patient.update(asNodeId(update.id), {
                mrn: update.mrn,
              });
            }

            const plan = unwrap(
              await planMergeIncremental({
                forkPoint,
                target: target.store,
                branches: [incoming],
                options: { onBasePropertyConflict: "flag" },
              }),
            );
            unwrap(await applyMergePlan(target.store, plan));

            const finalRows = (await target.store.nodes.Patient.find()).sort(
              (left, right) => left.id.localeCompare(right.id),
            );
            expect(finalRows.map((row) => row.mrn)).toEqual([
              rightKey,
              leftKey,
            ]);
            expect(new Set(finalRows.map((row) => row.mrn)).size).toBe(2);
          } finally {
            for (const cleanup of fixtures.toReversed()) await cleanup();
          }
        },
      ),
      { numRuns: 10 },
    );
  });
});
