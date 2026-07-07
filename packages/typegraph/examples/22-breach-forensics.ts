/**
 * Example 22: Breach forensics over a bitemporal access graph
 *
 * After a security incident the first question is always the same:
 *
 *     "At the moment of the breach, what could the compromised account reach?"
 *
 * The honest answer needs the access graph *as it was recorded at breach time*
 * — not as it is now. By the time you investigate, the dangerous grant has been
 * revoked and deleted, so a live query understates the blast radius and a plain
 * audit log can't traverse the permission chain.
 *
 * With recorded-time capture (`history: true`) you pin the graph to the breach
 * instant and run reachability over it — reconstructing the exact exposure,
 * including the over-permissive edge that has since been removed.
 *
 *     store.asOfRecorded(breachTime).reachable(account, { edges: [...] })
 *
 * Bitemporal + graph + one line. Run with:
 *   npx tsx examples/22-breach-forensics.ts
 */
import { z } from "zod";

import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedStoreView,
} from "@nicia-ai/typegraph";
import { createExampleBackend, requireRecordedNow } from "./_helpers";

// ============================================================
// Schema: a minimal identity-and-access graph
// ============================================================

const Account = defineNode("Account", {
  schema: z.object({ name: z.string() }),
});
const Role = defineNode("Role", { schema: z.object({ name: z.string() }) });
const Resource = defineNode("Resource", {
  schema: z.object({ name: z.string(), sensitivity: z.string() }),
});

const assumes = defineEdge("assumes", { schema: z.object({}) }); // Account → Role
const escalates = defineEdge("escalates", { schema: z.object({}) }); // Role → Role
const grants = defineEdge("grants", { schema: z.object({}) }); // Role → Resource

const ACCESS_EDGES = ["assumes", "escalates", "grants"] as const;

const graph = defineGraph({
  id: "breach_forensics",
  nodes: {
    Account: { type: Account },
    Role: { type: Role },
    Resource: { type: Resource },
  },
  edges: {
    assumes: { type: assumes, from: [Account], to: [Role] },
    escalates: { type: escalates, from: [Role], to: [Role] },
    grants: { type: grants, from: [Role], to: [Resource] },
  },
});

export async function main(): Promise<void> {
  const [store] = await createStoreWithSchema(graph, createExampleBackend(), {
    history: true,
  });

  console.log("━".repeat(70));
  console.log(" Breach forensics over a bitemporal access graph");
  console.log("━".repeat(70));

  // ----------------------------------------------------------
  // Stand up the access graph (writes are sequential under history)
  // ----------------------------------------------------------
  //
  //   svc-deploy ──assumes──▶ deployer ──grants──▶ ci-secrets
  //                              │
  //                          escalates  ◀── the dangerous misconfiguration
  //                              ▼
  //                            admin ──grants──▶ prod-db, customer-pii

  const account = await store.nodes.Account.create({ name: "svc-deploy" });
  const deployer = await store.nodes.Role.create({ name: "deployer" });
  const admin = await store.nodes.Role.create({ name: "admin" });

  const ciSecrets = await store.nodes.Resource.create({
    name: "ci-secrets",
    sensitivity: "medium",
  });
  const prodDb = await store.nodes.Resource.create({
    name: "prod-db",
    sensitivity: "high",
  });
  const pii = await store.nodes.Resource.create({
    name: "customer-pii",
    sensitivity: "critical",
  });

  await store.edges.assumes.create(account, deployer, {});
  await store.edges.grants.create(deployer, ciSecrets, {});
  await store.edges.grants.create(admin, prodDb, {});
  await store.edges.grants.create(admin, pii, {});
  // The over-permissive edge: a deploy role that can escalate to admin.
  const overGrant = await store.edges.escalates.create(deployer, admin, {});

  // ----------------------------------------------------------
  // The breach happens — note the instant
  // ----------------------------------------------------------

  // The breach instant — a deterministic recorded anchor. A real one comes from
  // your alert/SIEM; here we capture the recorded high-water mark.
  const breachTime = await requireRecordedNow(store);
  console.log(`\n  ⚠  svc-deploy compromised at ${breachTime}\n`);

  // The reads forensics needs. A live `store.view(...)` and a recorded
  // `store.asOfRecorded(...)` both satisfy this surface, so the same code runs
  // at either pin.
  type AccessView = Pick<
    RecordedStoreView<typeof graph>,
    "reachable" | "nodes"
  >;

  // Which resources can `account` reach, under a given view?
  async function exposedResources(
    view: AccessView,
  ): Promise<readonly { name: string; sensitivity: string }[]> {
    const reached = await view.reachable(account.id, {
      edges: [...ACCESS_EDGES],
      maxHops: 10,
    });
    // `reachable()` walks mixed node kinds in one pass, so its result is
    // deliberately kind-erased (`id: string`) — unlike a `.select()`
    // projection, there's no single statically-known kind to brand against.
    // The `kind` filter is a runtime check TypeScript can't turn into a
    // `NodeId<Resource>` narrowing, so re-branding the id at this boundary
    // is still required — `asNodeId` does that with a checked cast instead
    // of an unsafe one.
    const resourceIds = reached
      .filter((node) => node.kind === "Resource")
      .map((node) => asNodeId<typeof Resource>(node.id));
    const resources = await view.nodes.Resource.getByIds(resourceIds);
    return resources.filter((r): r is NonNullable<typeof r> => r !== undefined);
  }

  // ----------------------------------------------------------
  // Incident response tightens permissions — and removes the evidence
  // ----------------------------------------------------------

  console.log("─".repeat(70));
  console.log("  Incident response revokes the deployer→admin escalation");
  console.log("  (the grant is removed entirely — not just disabled).");
  console.log("─".repeat(70));

  await store.edges.escalates.hardDelete(overGrant.id);

  // ----------------------------------------------------------
  // Two reads of "what could svc-deploy reach?"
  // ----------------------------------------------------------

  const liveExposure = await exposedResources(store.view({ mode: "current" }));
  console.log("\n  Reachable resources on the CURRENT graph:");
  for (const r of liveExposure) {
    console.log(`    • ${r.name.padEnd(14)} (${r.sensitivity})`);
  }
  console.log(
    "    Looks contained — but the escalation was deleted, so a live",
  );
  console.log("    query can't see the path the attacker actually had.");

  const breachExposure = await exposedResources(store.asOfRecorded(breachTime));
  console.log("\n  Reachable resources reconstructed AT THE BREACH INSTANT");
  console.log("  via store.asOfRecorded(breachTime).reachable(...):");
  for (const r of breachExposure) {
    const flag =
      r.sensitivity === "critical" || r.sensitivity === "high" ?
        " ◀── EXPOSED"
      : "";
    console.log(`    • ${r.name.padEnd(14)} (${r.sensitivity})${flag}`);
  }
  console.log(
    "    The real blast radius — including prod-db and customer-pii,",
  );
  console.log("    reachable only through the since-deleted escalation edge.");

  console.log("\n" + "━".repeat(70));
  console.log(
    " Bitemporal + graph: pin the access graph to the breach instant",
  );
  console.log(
    " and traverse it. The evidence survives even after you delete it.",
  );
  console.log("━".repeat(70) + "\n");

  await store.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
