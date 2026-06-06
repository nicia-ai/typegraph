---
title: FHIR Graph Merge
description: Reconcile overlapping FHIR-style records from independent branches into one canonical patient care graph.
---

This example shows TypeGraph's graph-merge primitive on a concrete healthcare
interoperability problem: two independent ingestion agents extract overlapping
FHIR-style records, disagree on patient spelling, and produce separate care
context. TypeGraph branches isolate those writes. `merge()` folds them into one
base graph, resolves the duplicate patient, repoints each branch's clinical
edges, and reports the conflict/provenance trail.

:::tip[Just want the code?]
Full source on GitHub:
[`packages/typegraph/examples/18-fhir-graph-merge.ts`](https://github.com/nicia-ai/typegraph/blob/main/packages/typegraph/examples/18-fhir-graph-merge.ts)
:::

:::caution[Synthetic demo data only]
This is an interoperability and data-exploration example. It is not clinical
decision support and should not be run on protected health information as-is.
The bundled patient record is synthetic and intentionally small.
:::

## What It Demonstrates

- `branch()` creates isolated working copies over fresh local SQLite backends.
- Two branches create overlapping `Patient` records with the same MRN and birth
  date but different spellings: `Anna Rivera` and `Ana Rivera`.
- `merge()` resolves the duplicate patient with a portable in-memory fulltext
  similarity strategy plus the graph's unique MRN constraint.
- Care-context edges from both branches are repointed to the canonical patient.
- The merge report surfaces the spelling conflict instead of silently choosing a
  winner.
- Report provenance shows which branch contributed the canonical nodes and
  edges.

## Run It

From the repository root:

```bash
pnpm --filter @nicia-ai/typegraph exec tsx examples/18-fhir-graph-merge.ts
```

Or from `packages/typegraph`:

```bash
npx tsx examples/18-fhir-graph-merge.ts
```

The example uses in-memory SQLite backends, so it does not require Docker, a
FHIR server, or external services.

## Sample Output

```text
=== FHIR Graph Merge ===

Before merge:
  base patients: 0
  EHR branch patients: 1
  claims branch patients: 1

After merge:
  canonical patient: Ana Rivera (MRN-001, 1974-03-09)
  merged nodes: 6
  merged edges: 8
  entity resolutions: 1
  conflicts:
    - Patient.fhirId on patient-ana: claims-agent="Patient/claims-ana", ehr-agent="Patient/ehr-anna"
    - Patient.name on patient-ana: claims-agent="Ana Rivera", ehr-agent="Anna Rivera"
  provenance:
    - ehr-agent: 4 node(s), 5 edge(s)
    - claims-agent: 3 node(s), 3 edge(s)

Canonical patient care context:
  - Encounter: Hypertension follow-up (2026-04-11T09:30:00-07:00)
  - Encounter: Kidney function review (2026-04-14T10:00:00-07:00)
  - MedicationRequest: Lisinopril 10 MG Oral Tablet - Take one tablet by mouth daily
  - Observation: Blood pressure panel = 152/96 mmHg (high)
  - Observation: Estimated glomerular filtration rate = 54 mL/min/1.73m2 (low)
```

## Graph Model

The example keeps the schema intentionally small:

| TypeGraph kind | FHIR-ish source | Purpose |
| -------------- | --------------- | ------- |
| `Patient` | `Patient` | The canonical person being reconciled |
| `Encounter` | `Encounter` | Clinical visit context |
| `Observation` | `Observation` | Vitals and lab evidence |
| `MedicationRequest` | `MedicationRequest` | Medication order |
| `forPatient` | `subject` references | Connects clinical resources to the patient |
| `duringEncounter` | `encounter` references | Connects observations/orders to visits |
| `reasonFor` | `reasonReference` | Connects an order to supporting evidence |

The `Patient` kind declares a unique MRN constraint:

```typescript
const careGraph = defineGraph({
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
  },
});
```

A shared unique value is a definitional identity source. The merge still reports
property disagreements on the resolved patient, such as `name` and `fhirId`.

## Merge Configuration

The example configures entity resolution only for `Patient`; other kinds merge
by ID and keep their branch-specific clinical context.

```typescript
const mergeOptions = {
  resolve: {
    Patient: {
      block: (node) => node.mrn ?? node.birthDate,
      similarity: { kind: "fulltext", fields: ["name"] },
      threshold: 0.78,
    },
  },
  onPropertyConflict: "flag",
  branchOrder: [EHR_BRANCH, CLAIMS_BRANCH],
  provenance: true,
};
```

The `fulltext` strategy is an in-memory trigram scorer. It does not require
embeddings, database fulltext indexes, or a specific backend, which makes it a
good default for bounded candidate dedup during merge.

## Why This Matters

FHIR imports often arrive from multiple systems: EHR exports, claims feeds,
lab feeds, patient-reported questionnaires, and agent-produced extraction
passes. Each source can be useful, but naive append-only ingestion leaves
duplicates and broken care context.

Graph merge gives you a deterministic reconciliation step:

1. Run each extractor in an isolated branch.
2. Keep all writes type-checked by the same TypeGraph schema.
3. Resolve entities by exact identity, blocking keys, and similarity.
4. Preserve branch-specific context by repointing edges.
5. Return a merge report that callers can inspect, persist, or route for human
   review.

See [Graph Merge](/graph-merge) for the API reference and option semantics.
