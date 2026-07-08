/**
 * Example 17: Batched Index Lookup — Import Reconciliation
 *
 * `store.nodes.<Kind>.bulkFindByIndex(indexName, items, options?)` takes many
 * in-memory records and, for each one, returns the live nodes that share its
 * declared index key. It is the batched primitive for:
 *
 * - import reconciliation (decide create-new vs. merge for each incoming row)
 * - dedup-candidate discovery (find rows that might be the same entity)
 * - joining incoming records against the graph by a declared composite key
 *
 * The index may be non-unique, so each input yields its own (possibly empty)
 * array of candidates — this is candidate retrieval, not a uniqueness
 * guarantee. For unique lookups use `bulkFindByConstraint` instead.
 *
 * This example demonstrates:
 * - composite, non-unique keys and org-scoped matching
 * - the empty bucket → "create new" reconciliation decision
 * - null-safe equality (a missing key field matches a stored NULL)
 * - `limitPerInput` to cap each candidate bucket
 */
import { createStore, defineGraph, defineNode } from "@nicia-ai/typegraph";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

import { createExampleBackend } from "./_helpers";

// ============================================================
// Schema Definition
// ============================================================

const Contact = defineNode("Contact", {
  schema: z.object({
    orgId: z.string(),
    fullName: z.string(),
    email: z.string().optional(),
    sourceSystem: z.string(),
  }),
});

// Reconciliation key: many contacts can share (orgId, fullName) — duplicates
// imported from different source systems — so this index is non-unique.
const contactByOrgName = defineNodeIndex(Contact, {
  name: "contact_by_org_name",
  fields: ["orgId", "fullName"],
});

// Email key: `email` is optional, so stored rows without one carry NULL.
// Probing with no email matches those NULL rows via null-safe equality.
const contactByOrgEmail = defineNodeIndex(Contact, {
  name: "contact_by_org_email",
  fields: ["orgId", "email"],
});

const graph = defineGraph({
  id: "crm_import",
  nodes: { Contact: { type: Contact } },
  edges: {},
  indexes: [contactByOrgName, contactByOrgEmail],
});

// ============================================================
// Demonstrate Batched Index Lookup
// ============================================================

export async function main() {
  const backend = createExampleBackend();
  const store = createStore(graph, backend);

  try {
    console.log("=== Batched Index Lookup (bulkFindByIndex) ===\n");

    // Existing graph state: contacts already imported from various systems.
    // Note the deliberate duplicates and the email-less rows.
    console.log("Seeding the existing contact graph...\n");
    const seed = [
      { orgId: "acme", fullName: "Jane Doe", email: "jane@acme.com", sourceSystem: "salesforce" },
      { orgId: "acme", fullName: "Jane Doe", email: "jane.doe@acme.com", sourceSystem: "hubspot" },
      { orgId: "acme", fullName: "John Smith", email: "john@acme.com", sourceSystem: "salesforce" },
      { orgId: "acme", fullName: "Mystery Contact", sourceSystem: "manual" }, // no email → NULL
      { orgId: "acme", fullName: "Walk-in Lead", sourceSystem: "manual" }, // no email → NULL
      { orgId: "globex", fullName: "Jane Doe", email: "jane@globex.com", sourceSystem: "salesforce" },
    ];
    for (const record of seed) {
      await store.nodes.Contact.create(record);
    }
    console.log(`  Seeded ${seed.length} contacts across 2 orgs\n`);

    // ============================================================
    // Reconcile an incoming import batch by (orgId, fullName)
    // ============================================================

    console.log("=== Reconcile incoming batch by (orgId, fullName) ===\n");

    const incoming = [
      { orgId: "acme", fullName: "Jane Doe" }, // 2 candidates → needs merge review
      { orgId: "acme", fullName: "John Smith" }, // 1 candidate → likely the same person
      { orgId: "acme", fullName: "Grace Hopper" }, // 0 candidates → create new
      { orgId: "globex", fullName: "Jane Doe" }, // 1 candidate → org-scoped, not acme's Janes
    ];

    // bulkFindByIndex takes records shaped as { props }, one per input. Each
    // input's candidates come back in the same position, ordered by node id.
    const candidates = await store.nodes.Contact.bulkFindByIndex(
      "contact_by_org_name",
      incoming.map((record) => ({ props: record })),
    );

    for (const [index, record] of incoming.entries()) {
      const bucket = candidates[index] ?? [];
      const decision = bucket.length === 0 ? "CREATE NEW" : `REVIEW (${bucket.length} candidate(s))`;
      console.log(`  ${record.orgId}/${record.fullName} → ${decision}`);
      for (const candidate of bucket) {
        console.log(`      ↳ ${candidate.id} via ${candidate.sourceSystem}`);
      }
    }

    // ============================================================
    // Null-safe matching by (orgId, email)
    // ============================================================

    console.log("\n=== Null-safe matching by (orgId, email) ===\n");

    // A probe that omits `email` matches stored rows whose email is NULL —
    // not every acme row. A probe with a concrete email matches that value.
    const emailProbes = [
      { orgId: "acme" }, // email omitted → matches the two NULL-email rows
      { orgId: "acme", email: "jane@acme.com" }, // matches the one salesforce Jane
    ];
    const emailMatches = await store.nodes.Contact.bulkFindByIndex(
      "contact_by_org_email",
      emailProbes.map((record) => ({ props: record })),
    );

    console.log("  acme / (no email) →");
    for (const match of emailMatches[0] ?? []) {
      console.log(`      ↳ ${match.fullName} (email: ${match.email ?? "none"})`);
    }
    console.log("  acme / jane@acme.com →");
    for (const match of emailMatches[1] ?? []) {
      console.log(`      ↳ ${match.fullName} (${match.sourceSystem})`);
    }

    // ============================================================
    // Capping candidates with limitPerInput
    // ============================================================

    console.log("\n=== Capping candidates with limitPerInput ===\n");

    // Low-selectivity keys can return many candidates. `limitPerInput` caps each
    // bucket (lowest node ids kept). On backends with SQL window functions the
    // cap runs in-database via ROW_NUMBER(); otherwise it is applied in memory
    // with the same result.
    const [capped] = await store.nodes.Contact.bulkFindByIndex(
      "contact_by_org_name",
      [{ props: { orgId: "acme", fullName: "Jane Doe" } }],
      { limitPerInput: 1 },
    );
    console.log(`  acme/Jane Doe with limitPerInput: 1 → ${capped?.length ?? 0} candidate (of 2)`);

    console.log("\n=== Batched index lookup example complete ===");
  } finally {
    await backend.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
