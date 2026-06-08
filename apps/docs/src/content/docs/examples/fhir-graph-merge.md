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
- Two patient pairs are reconciled by **two different mechanisms**, so you can
  see exact identity and fuzzy resolution side by side:
  - **`Anna Rivera` / `Ana Rivera`** share a unique MRN. The unique constraint
    forces this merge by **exact identity** — fuzzy scoring is bypassed, so the
    similarity threshold is irrelevant to their collapse.
  - **`Mohammed Ali` / `Mohamed Ali`** have **different** MRNs, so nothing forces
    them. Only the in-memory fulltext name similarity clearing the threshold
    collapses them — this is the case where similarity is actually decisive.
- Care-context edges from both branches are repointed onto each canonical
  patient. The output proves this by reading context through `forPatient` edges
  *into* the survivor, not via a blanket `.find()`.
- The merge report surfaces every spelling / identifier disagreement (name,
  MRN, FHIR id) instead of silently choosing a winner.
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
  EHR branch patients: 2
  claims branch patients: 2

After merge:
  merged nodes: 9
  merged edges: 10
  entity resolutions: 2
  conflicts:
    - Patient.fhirId on patient-ana: claims-agent="Patient/claims-ana", ehr-agent="Patient/ehr-anna"
    - Patient.name on patient-ana: claims-agent="Ana Rivera", ehr-agent="Anna Rivera"
    - Patient.fhirId on patient-mohamed: claims-agent="Patient/claims-mohamed", ehr-agent="Patient/ehr-mohammed"
    - Patient.mrn on patient-mohamed: claims-agent="MRN-205", ehr-agent="MRN-204"
    - Patient.name on patient-mohamed: claims-agent="Mohamed Ali", ehr-agent="Mohammed Ali"
  provenance:
    - ehr-agent: 6 node(s), 6 edge(s)
    - claims-agent: 5 node(s), 4 edge(s)

Canonical patients and their repointed care context:
  Ana Rivera (MRN-001, 1974-03-09)
    - Encounter: Hypertension follow-up (2026-04-11T09:30:00-07:00)
    - Encounter: Kidney function review (2026-04-14T10:00:00-07:00)
    - MedicationRequest: Lisinopril 10 MG Oral Tablet - Take one tablet by mouth daily
    - Observation: Blood pressure panel = 152/96 mmHg (high)
    - Observation: Estimated glomerular filtration rate = 54 mL/min/1.73m2 (low)
  Mohamed Ali (MRN-205, 1990-08-21)
    - Encounter: Cardiology consult (2026-05-02T13:00:00-07:00)
    - Observation: LDL cholesterol = 168 mg/dL (high)
```

The `Mohamed Ali` line is the proof that fuzzy resolution and edge repointing
both work: the two spellings carried **different** MRNs (so no exact match
forced them), yet they collapsed to one patient — and that patient now owns the
EHR branch's cardiology encounter *and* the claims branch's lab observation,
each repointed from its origin branch.

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

A shared unique value is a **definitional** identity source: when two staged
nodes share all of a constraint's fields, they are forced to merge and fuzzy
scoring is bypassed entirely. That is what collapses `Anna Rivera` / `Ana Rivera`
(both `MRN-001`) — the similarity threshold never enters into it. The merge still
reports their property disagreements (`name`, `fhirId`).

## Merge Configuration

The example configures entity resolution only for `Patient`; other kinds merge
by ID and keep their branch-specific clinical context.

```typescript
const mergeOptions = {
  resolve: {
    Patient: {
      // Block by shared birth date. The unique MRN constraint forces exact
      // matches in its own bucket, so blocking does not need the MRN — and using
      // it would split the different-MRN fuzzy pair apart.
      block: (node) => node.birthDate,
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
good default for bounded candidate dedup during merge. It is the **decisive**
signal for `Mohammed Ali` / `Mohamed Ali`: those records carry different MRNs,
so no unique match forces them — only the name score clearing `threshold`
collapses them.

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
