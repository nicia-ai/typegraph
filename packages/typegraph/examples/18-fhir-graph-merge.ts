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
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type Node,
  searchable,
  type Store,
} from "@nicia-ai/typegraph";
import {
  asBranchId,
  branch,
  type GraphBranch,
  isOk,
  type MakeBackend,
  merge,
  type MergeOptions,
  type MergeReport,
  type SimilarityStrategy,
  unwrap,
} from "@nicia-ai/typegraph/graph-merge";
import { z } from "zod";

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
    // FHIR-ish endpoint constraints. The bare `{ forPatient }` shorthand would
    // accept ANY node kind on either end; the explicit from/to pins each
    // care-context edge to its real shape.
    forPatient: {
      type: forPatient,
      from: [Encounter, Observation, MedicationRequest],
      to: [Patient],
    },
    duringEncounter: {
      type: duringEncounter,
      from: [Observation, MedicationRequest],
      to: [Encounter],
    },
    reasonFor: {
      type: reasonFor,
      from: [MedicationRequest],
      to: [Observation],
    },
  },
});

type CareGraph = typeof careGraph;
type CareStore = Store<CareGraph>;

const EHR_BRANCH = asBranchId("ehr-agent");
const CLAIMS_BRANCH = asBranchId("claims-agent");

const patientSimilarity: SimilarityStrategy<CareGraph> = {
  kind: "fulltext",
  fields: ["name"],
};

const mergeOptions: MergeOptions<CareGraph> = {
  resolve: {
    Patient: {
      // Block by shared birth date. `block` is typed to THIS kind's node shape,
      // so `node.birthDate` needs no cast. The unique MRN constraint forces
      // exact-identity matches in its own bucket independently of blocking, so
      // blocking does not need the MRN — and using it would split the
      // different-MRN fuzzy pair apart.
      block: (node) => node.birthDate,
      similarity: patientSimilarity,
      // This demo exercises BOTH resolution paths:
      //   - Anna/Ana share MRN-001, so the unique constraint forces that merge
      //     (definitional identity — fuzzy scoring is bypassed for them). The
      //     threshold is irrelevant to their collapse.
      //   - Mohammed/Mohamed have DIFFERENT MRNs, so nothing forces them; only
      //     the fulltext name similarity clearing this threshold collapses them.
      //     This is the case where the threshold is actually decisive.
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
  makeBackend: MakeBackend,
  id: typeof EHR_BRANCH  ,
): Promise<GraphBranch<CareGraph>> {
  return unwrap(await branch(base, makeBackend, { id }));
}

async function seedEhrBranch(branchStore: CareStore): Promise<void> {
  const patient = await branchStore.nodes.Patient.create(
    {
      fhirId: "Patient/ehr-anna",
      name: "Anna Rivera",
      birthDate: "1974-03-09",
      mrn: "MRN-001",
    },
    {
      id: "patient-anna",
    },
  );
  const encounter = await branchStore.nodes.Encounter.create(
    {
      fhirId: "Encounter/ehr-follow-up",
      reason: "Hypertension follow-up",
      startedAt: "2026-04-11T09:30:00-07:00",
    },
    {
      id: "encounter-follow-up",
    },
  );
  const bloodPressure = await branchStore.nodes.Observation.create(
    {
      fhirId: "Observation/ehr-bp",
      display: "Blood pressure panel",
      value: "152/96 mmHg",
      interpretation: "high",
    },
    {
      id: "observation-blood-pressure",
    },
  );
  const medication = await branchStore.nodes.MedicationRequest.create(
    {
      fhirId: "MedicationRequest/ehr-lisinopril",
      medication: "Lisinopril 10 MG Oral Tablet",
      dosage: "Take one tablet by mouth daily",
    },
    {
      id: "medication-lisinopril",
    },
  );

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

  // A SECOND patient whose MRN differs from the claims branch's, so the unique
  // constraint can NOT force a match — only the fulltext name similarity can
  // collapse "Mohammed Ali" / "Mohamed Ali".
  const mohammed = await branchStore.nodes.Patient.create(
    {
      fhirId: "Patient/ehr-mohammed",
      name: "Mohammed Ali",
      birthDate: "1990-08-21",
      mrn: "MRN-204",
    },
    { id: "patient-mohammed" },
  );
  const cardiology = await branchStore.nodes.Encounter.create(
    {
      fhirId: "Encounter/ehr-cardiology",
      reason: "Cardiology consult",
      startedAt: "2026-05-02T13:00:00-07:00",
    },
    { id: "encounter-cardiology" },
  );
  await branchStore.edges.forPatient.create(cardiology, mohammed, {
    sourcePath: "Encounter.subject",
  });
}

async function seedClaimsBranch(branchStore: CareStore): Promise<void> {
  const patient = await branchStore.nodes.Patient.create(
    {
      fhirId: "Patient/claims-ana",
      name: "Ana Rivera",
      birthDate: "1974-03-09",
      mrn: "MRN-001",
    },
    {
      id: "patient-ana",
    },
  );
  const encounter = await branchStore.nodes.Encounter.create(
    {
      fhirId: "Encounter/claims-kidney-review",
      reason: "Kidney function review",
      startedAt: "2026-04-14T10:00:00-07:00",
    },
    {
      id: "encounter-kidney-review",
    },
  );
  const kidneyLab = await branchStore.nodes.Observation.create(
    {
      fhirId: "Observation/claims-egfr",
      display: "Estimated glomerular filtration rate",
      value: "54 mL/min/1.73m2",
      interpretation: "low",
    },
    {
      id: "observation-egfr",
    },
  );

  await branchStore.edges.forPatient.create(encounter, patient, {
    sourcePath: "Encounter.subject",
  });
  await branchStore.edges.forPatient.create(kidneyLab, patient, {
    sourcePath: "Observation.subject",
  });
  await branchStore.edges.duringEncounter.create(kidneyLab, encounter, {
    sourcePath: "Observation.encounter",
  });

  // The claims-side spelling of the second patient, with a DIFFERENT MRN. Same
  // birth date (so they block together), close name (so fulltext collapses them).
  const mohamed = await branchStore.nodes.Patient.create(
    {
      fhirId: "Patient/claims-mohamed",
      name: "Mohamed Ali",
      birthDate: "1990-08-21",
      mrn: "MRN-205",
    },
    { id: "patient-mohamed" },
  );
  const ldl = await branchStore.nodes.Observation.create(
    {
      fhirId: "Observation/claims-ldl",
      display: "LDL cholesterol",
      value: "168 mg/dL",
      interpretation: "high",
    },
    { id: "observation-ldl" },
  );
  await branchStore.edges.forPatient.create(ldl, mohamed, {
    sourcePath: "Observation.subject",
  });
}

// ============================================================
// Reporting helpers
// ============================================================

function compareStrings(left: string, right: string): number {
  return (
    left < right ? -1
    : left > right ? 1
    : 0
  );
}

function summarizePatient(node: Node<typeof Patient>): string {
  return `${node.name} (${node.mrn}, ${node.birthDate})`;
}

/** An `id -> human-readable label` map for every clinical resource in the store. */
async function resourceDisplays(
  store: CareStore,
): Promise<Map<string, string>> {
  const displays = new Map<string, string>();
  for (const encounter of await store.nodes.Encounter.find()) {
    displays.set(
      encounter.id,
      `Encounter: ${encounter.reason} (${encounter.startedAt})`,
    );
  }
  for (const observation of await store.nodes.Observation.find()) {
    displays.set(
      observation.id,
      `Observation: ${observation.display} = ${observation.value} (${observation.interpretation})`,
    );
  }
  for (const medication of await store.nodes.MedicationRequest.find()) {
    displays.set(
      medication.id,
      `MedicationRequest: ${medication.medication} - ${medication.dosage}`,
    );
  }
  return displays;
}

/**
 * The resources linked to a canonical patient, found by FOLLOWING `forPatient`
 * edges INTO that patient. Membership comes from the edges (not a blanket
 * `.find()`), so this proves edge repointing: a resource appears under a patient
 * only because its `forPatient` edge now points at the canonical survivor. A
 * mis-repointed edge would simply not show up here.
 */
async function careContextFor(
  store: CareStore,
  patient: Node<typeof Patient>,
  displays: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  const edges = await store.edges.forPatient.findTo(patient);
  return edges
    .map(
      (edge) => displays.get(edge.fromId) ?? `${edge.fromKind} ${edge.fromId}`,
    )
    .toSorted((left, right) => compareStrings(left, right));
}

/**
 * Prints each entity resolution: which branch records collapsed onto which
 * canonical patient, and which branches contributed the members.
 */
async function printResolutions(
  store: CareStore,
  report: MergeReport<CareGraph>,
): Promise<void> {
  const patientNamesById = new Map<string, string>();
  for (const patient of await store.nodes.Patient.find()) {
    patientNamesById.set(patient.id, patient.name);
  }
  console.log(`  entity resolutions (${report.resolutions.length}):`);
  const resolutions = [...report.resolutions].toSorted((left, right) =>
    compareStrings(left.canonicalId, right.canonicalId),
  );
  for (const resolution of resolutions) {
    const display =
      patientNamesById.get(resolution.canonicalId) ?? resolution.canonicalId;
    console.log(
      `    - ${resolution.kind} "${display}": [${resolution.memberIds.join(", ")}] -> canonical "${resolution.canonicalId}" (branches: ${resolution.branchOrigins.join(", ")})`,
    );
  }
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
  console.log(
    "  note: fhirId is a source-scoped record id, so cross-system fhirId\n" +
      "  conflicts are EXPECTED — the real signal is the name/mrn disagreements.",
  );
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

async function main(): Promise<void> {
  // Every backend this example opens — directly or through `branch()`'s factory —
  // is tracked here and closed in the finally below.
  const openedBackends: GraphBackend[] = [];
  function makeBackend(): Promise<GraphBackend> {
    const backend = createExampleBackend();
    openedBackends.push(backend);
    return Promise.resolve(backend);
  }

  try {
    const [base] = await createStoreWithSchema(careGraph, await makeBackend());

    const ehr = await createBranch(base, makeBackend, EHR_BRANCH);
    const claims = await createBranch(base, makeBackend, CLAIMS_BRANCH);

    await seedEhrBranch(ehr.store);
    await seedClaimsBranch(claims.store);

    console.log("=== FHIR Graph Merge ===\n");
    console.log("Before merge:");
    const basePatients = await base.nodes.Patient.find();
    const ehrPatients = await ehr.store.nodes.Patient.find();
    const claimsPatients = await claims.store.nodes.Patient.find();
    console.log("  base patients:", basePatients.length);
    console.log("  EHR branch patients:", ehrPatients.length);
    console.log("  claims branch patients:", claimsPatients.length);

    const result = await merge(base, [ehr, claims], mergeOptions);
    if (!isOk(result)) {
      throw result.error;
    }
    const report = result.data;

    console.log("\nAfter merge:");
    console.log(`  merged nodes: ${report.merged.nodes}`);
    console.log(`  merged edges: ${report.merged.edges}`);
    await printResolutions(base, report);
    printConflicts(report);
    printProvenance(report);

    // Two patients collapsed by two different mechanisms — Anna/Ana by the shared
    // MRN (exact identity), Mohammed/Mohamed by fulltext name similarity. The care
    // context below is read by following `forPatient` edges INTO each survivor, so
    // it proves both branches' edges were repointed onto the canonical patient.
    const mergedPatients = await base.nodes.Patient.find();
    const patients = mergedPatients.toSorted((left, right) =>
      compareStrings(left.name, right.name),
    );
    const displays = await resourceDisplays(base);
    console.log("\nCanonical patients and their repointed care context:");
    for (const patient of patients) {
      console.log(`  ${summarizePatient(patient)}`);
      for (const line of await careContextFor(base, patient, displays)) {
        console.log(`    - ${line}`);
      }
    }
  } finally {
    await Promise.all(openedBackends.map((backend) => backend.close()));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
