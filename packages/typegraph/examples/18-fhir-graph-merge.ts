/**
 * Example 18: FHIR Graph Merge
 *
 * Two independent ingestion agents extract overlapping FHIR-style records into
 * isolated TypeGraph branches. `merge()` folds both branches back into the base
 * graph, resolves the duplicate patient, repoints each branch's care-context
 * edges onto the canonical patient, and reports the conflict/provenance trail.
 *
 * Run with:
 *   npx tsx examples/18-fhir-graph-merge.ts
 */
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
  type GraphBackend,
  type Node,
  type Store,
} from "@nicia-ai/typegraph";
import {
  asBranchId,
  branch,
  isOk,
  merge,
  unwrap,
  type GraphBranch,
  type MergeOptions,
  type MergeReport,
  type SimilarityStrategy,
} from "@nicia-ai/typegraph/graph-merge";
import { createExampleBackend } from "./_helpers";

// ============================================================
// FHIR-flavored schema
// ============================================================

const Patient = defineNode("Patient", {
  schema: z.object({
    fhirId: z.string(),
    name: searchable({ language: "english" }),
    birthDate: z.string(),
    mrn: z.string(),
  }),
});

const Encounter = defineNode("Encounter", {
  schema: z.object({
    fhirId: z.string(),
    reason: searchable({ language: "english" }),
    startedAt: z.string(),
  }),
});

const Observation = defineNode("Observation", {
  schema: z.object({
    fhirId: z.string(),
    display: searchable({ language: "english" }),
    value: z.string(),
    interpretation: z.enum(["normal", "high", "low"]),
  }),
});

const MedicationRequest = defineNode("MedicationRequest", {
  schema: z.object({
    fhirId: z.string(),
    medication: searchable({ language: "english" }),
    dosage: z.string(),
  }),
});

const forPatient = defineEdge("forPatient", {
  schema: z.object({ sourcePath: z.string() }),
});

const duringEncounter = defineEdge("duringEncounter", {
  schema: z.object({ sourcePath: z.string() }),
});

const reasonFor = defineEdge("reasonFor", {
  schema: z.object({ sourcePath: z.string() }),
});

const careGraph = defineGraph({
  id: "fhir_merge_demo",
  nodes: {
    Patient: {
      type: Patient,
      unique: [
        {
          name: "patient_mrn",
          fields: ["mrn"],
          scope: "kind",
          collation: "caseInsensitive",
        },
      ],
    },
    Encounter: { type: Encounter },
    Observation: { type: Observation },
    MedicationRequest: { type: MedicationRequest },
  },
  edges: {
    forPatient,
    duringEncounter,
    reasonFor,
  },
});

type CareGraph = typeof careGraph;
type CareStore = Store<CareGraph>;

const EHR_BRANCH = asBranchId("ehr-agent");
const CLAIMS_BRANCH = asBranchId("claims-agent");

async function makeExampleBackend(): Promise<GraphBackend> {
  return createExampleBackend();
}

const patientSimilarity: SimilarityStrategy<CareGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

function blockPatient(node: Node): string | undefined {
  const patient = node as unknown as {
    birthDate?: string;
    mrn?: string;
  };
  return patient.mrn ?? patient.birthDate;
}

const mergeOptions: MergeOptions<CareGraph> = {
  resolve: {
    Patient: {
      block: blockPatient,
      similarity: patientSimilarity,
      // "Anna Rivera" and "Ana Rivera" clear this threshold. The shared MRN
      // unique constraint also gives the merge an exact identity source.
      threshold: 0.78,
    },
  },
  onPropertyConflict: "flag",
  branchOrder: [EHR_BRANCH, CLAIMS_BRANCH],
  provenance: true,
};

// ============================================================
// Branch seeding
// ============================================================

async function createBranch(
  base: CareStore,
  id: typeof EHR_BRANCH | typeof CLAIMS_BRANCH,
): Promise<GraphBranch<CareGraph>> {
  return unwrap(await branch(base, makeExampleBackend, { id }));
}

async function seedEhrBranch(branchStore: CareStore): Promise<void> {
  const patient = await branchStore.nodes.Patient.create({
    fhirId: "Patient/ehr-anna",
    name: "Anna Rivera",
    birthDate: "1974-03-09",
    mrn: "MRN-001",
  }, {
    id: "patient-anna",
  });
  const encounter = await branchStore.nodes.Encounter.create({
    fhirId: "Encounter/ehr-follow-up",
    reason: "Hypertension follow-up",
    startedAt: "2026-04-11T09:30:00-07:00",
  }, {
    id: "encounter-follow-up",
  });
  const bloodPressure = await branchStore.nodes.Observation.create({
    fhirId: "Observation/ehr-bp",
    display: "Blood pressure panel",
    value: "152/96 mmHg",
    interpretation: "high",
  }, {
    id: "observation-blood-pressure",
  });
  const medication = await branchStore.nodes.MedicationRequest.create({
    fhirId: "MedicationRequest/ehr-lisinopril",
    medication: "Lisinopril 10 MG Oral Tablet",
    dosage: "Take one tablet by mouth daily",
  }, {
    id: "medication-lisinopril",
  });

  await branchStore.edges.forPatient.create(encounter, patient, {
    sourcePath: "Encounter.subject",
  });
  await branchStore.edges.forPatient.create(bloodPressure, patient, {
    sourcePath: "Observation.subject",
  });
  await branchStore.edges.forPatient.create(medication, patient, {
    sourcePath: "MedicationRequest.subject",
  });
  await branchStore.edges.duringEncounter.create(medication, encounter, {
    sourcePath: "MedicationRequest.encounter",
  });
  await branchStore.edges.reasonFor.create(medication, bloodPressure, {
    sourcePath: "MedicationRequest.reasonReference",
  });
}

async function seedClaimsBranch(branchStore: CareStore): Promise<void> {
  const patient = await branchStore.nodes.Patient.create({
    fhirId: "Patient/claims-ana",
    name: "Ana Rivera",
    birthDate: "1974-03-09",
    mrn: "MRN-001",
  }, {
    id: "patient-ana",
  });
  const encounter = await branchStore.nodes.Encounter.create({
    fhirId: "Encounter/claims-kidney-review",
    reason: "Kidney function review",
    startedAt: "2026-04-14T10:00:00-07:00",
  }, {
    id: "encounter-kidney-review",
  });
  const kidneyLab = await branchStore.nodes.Observation.create({
    fhirId: "Observation/claims-egfr",
    display: "Estimated glomerular filtration rate",
    value: "54 mL/min/1.73m2",
    interpretation: "low",
  }, {
    id: "observation-egfr",
  });

  await branchStore.edges.forPatient.create(encounter, patient, {
    sourcePath: "Encounter.subject",
  });
  await branchStore.edges.forPatient.create(kidneyLab, patient, {
    sourcePath: "Observation.subject",
  });
  await branchStore.edges.duringEncounter.create(kidneyLab, encounter, {
    sourcePath: "Observation.encounter",
  });
}

// ============================================================
// Reporting helpers
// ============================================================

function summarizePatient(node: Node<typeof Patient>): string {
  return `${node.name} (${node.mrn}, ${node.birthDate})`;
}

async function mergedCareContext(store: CareStore): Promise<readonly string[]> {
  const encounters = await store.nodes.Encounter.find();
  const observations = await store.nodes.Observation.find();
  const medications = await store.nodes.MedicationRequest.find();

  return [
    ...encounters.map(
      (encounter) => `Encounter: ${encounter.reason} (${encounter.startedAt})`,
    ),
    ...observations.map(
      (observation) =>
        `Observation: ${observation.display} = ${observation.value} (${observation.interpretation})`,
    ),
    ...medications.map(
      (medication) =>
        `MedicationRequest: ${medication.medication} - ${medication.dosage}`,
    ),
  ].sort((left, right) =>
    left < right ? -1
    : left > right ? 1
    : 0,
  );
}

function printConflicts(report: MergeReport<CareGraph>): void {
  if (report.conflicts.length === 0) {
    console.log("  conflicts: none");
    return;
  }

  console.log("  conflicts:");
  for (const conflict of report.conflicts) {
    const values = conflict.values
      .map((value) => `${value.branchId}=${JSON.stringify(value.value)}`)
      .join(", ");
    console.log(
      `    - ${conflict.kind}.${conflict.property} on ${conflict.entityId}: ${values}`,
    );
  }
}

function printProvenance(report: MergeReport<CareGraph>): void {
  console.log("  provenance:");
  for (const branchId of [EHR_BRANCH, CLAIMS_BRANCH]) {
    const contribution = report.provenance.byBranch(branchId);
    console.log(
      `    - ${branchId}: ${contribution.nodeIds.length} node(s), ${contribution.edgeIds.length} edge(s)`,
    );
  }
}

// ============================================================
// Demo
// ============================================================

async function main() {
  const backend = await makeExampleBackend();
  const [base] = await createStoreWithSchema(careGraph, backend);

  const ehr = await createBranch(base, EHR_BRANCH);
  const claims = await createBranch(base, CLAIMS_BRANCH);

  await seedEhrBranch(ehr.store);
  await seedClaimsBranch(claims.store);

  console.log("=== FHIR Graph Merge ===\n");
  console.log("Before merge:");
  console.log("  base patients:", (await base.nodes.Patient.find()).length);
  console.log("  EHR branch patients:", (await ehr.store.nodes.Patient.find()).length);
  console.log(
    "  claims branch patients:",
    (await claims.store.nodes.Patient.find()).length,
  );

  const result = await merge(base, [ehr, claims], mergeOptions);
  if (!isOk(result)) {
    throw result.error;
  }

  const report = result.data;
  const patients = await base.nodes.Patient.find();
  const [patient] = patients;
  if (patient === undefined) {
    throw new Error("Expected a canonical patient after merge");
  }

  console.log("\nAfter merge:");
  console.log(`  canonical patient: ${summarizePatient(patient)}`);
  console.log(`  merged nodes: ${report.merged.nodes}`);
  console.log(`  merged edges: ${report.merged.edges}`);
  console.log(`  entity resolutions: ${report.resolutions.length}`);
  printConflicts(report);
  printProvenance(report);

  const timeline = await mergedCareContext(base);
  console.log("\nCanonical patient care context:");
  for (const item of timeline) {
    console.log(`  - ${item}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
