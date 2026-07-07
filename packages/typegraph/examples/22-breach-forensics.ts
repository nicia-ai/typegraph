/**
 * Example 22: Breach forensics over a bitemporal access graph
 *
 * After a security incident the first question is always the same:
 *
 *     "At the moment of the breach, what could the compromised account reach?"
 *
 * That question has TWO time axes, and getting either wrong misstates the
 * blast radius. Valid time: was the grant IN EFFECT at the breach instant?
 * (a contractor's grant is time-boxed to a maintenance window via
 * `validFrom` / `validTo`.) Recorded time: what did the store KNOW?
 * (incident response deletes the dangerous grant, so a live query can't
 * see the path the attacker had.) Pin both axes and ask directly:
 *
 *     store.asOf(breachAt).asOfRecorded(alertAnchor).reachable(account, ...)
 *
 * — "per what we knew when the alert fired, which grants were in effect at
 * the breach instant, and what did they reach?" Run with:
 *   npx tsx examples/22-breach-forensics.ts
 */
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type RecordedStoreView,
  type Store,
} from "@nicia-ai/typegraph";
import { z } from "zod";

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

// Fixed valid-time instants (canonical UTC ISO-8601, as the API requires).
const JAN_1 = "2024-01-01T00:00:00.000Z"; // baseline access model takes effect
const MAR_1 = "2024-03-01T00:00:00.000Z"; // maintenance window opens
const BREACH_AT = "2024-03-05T00:00:00.000Z"; // the compromise, mid-window
const MAR_8 = "2024-03-08T00:00:00.000Z"; // maintenance window closes
const MAR_20 = "2024-03-20T00:00:00.000Z"; // a quiet day after the window

// The reads forensics needs — a live `store.view(...)` and a composed
// `store.asOf(...).asOfRecorded(...)` both satisfy it (same code, any pin).
type AccessView = Pick<RecordedStoreView<typeof graph>, "reachable" | "query">;

type ExposedResource = Readonly<{ name: string; sensitivity: string }>;

// Which resources can the account reach, under a given view?
async function exposedResources(
  view: AccessView,
  accountId: string,
): Promise<readonly ExposedResource[]> {
  const reached = await view.reachable(accountId, {
    edges: [...ACCESS_EDGES],
    maxHops: 10,
  });
  const resourceIds = reached
    .filter((node) => node.kind === "Resource")
    .map((node) => node.id);
  if (resourceIds.length === 0) return [];
  const resources = await view
    .query()
    .from("Resource", "r")
    .whereNode("r", (r) => r.id.in(resourceIds))
    .select((ctx) => ({ name: ctx.r.name, sensitivity: ctx.r.sensitivity }))
    .execute();
  return [...resources].toSorted((a, b) => a.name.localeCompare(b.name));
}

const EXPOSED_LEVELS = new Set(["high", "critical"]);

function printExposure(resources: readonly ExposedResource[]): void {
  for (const resource of resources) {
    const flag = EXPOSED_LEVELS.has(resource.sensitivity) ? " ◀── EXPOSED" : "";
    console.log(
      `    • ${resource.name.padEnd(14)} (${resource.sensitivity})${flag}`,
    );
  }
}

// Edge kind for a hop; the schema makes each node-kind pair unambiguous.
function hopLabel(fromKind: string, toKind: string): string {
  if (fromKind === "Account") return "assumes";
  return toKind === "Role" ? "escalates" : "grants";
}

async function runForensics(store: Store<typeof graph>): Promise<void> {
  console.log("━".repeat(70));
  console.log(" Breach forensics over a bitemporal access graph");
  console.log("━".repeat(70));

  // ----------------------------------------------------------
  // Stand up the access graph (writes are sequential under history)
  // ----------------------------------------------------------
  //
  //   svc-deploy ──assumes──▶ deployer ──grants──▶ ci-secrets
  //                              │
  //                          escalates  ◀── contractor grant, valid ONLY
  //                              ▼          for the Mar 1–8 window
  //                            admin ──grants──▶ prod-db, customer-pii
  //
  // The baseline model is effective Jan 1; the escalation is time-boxed.

  const eff = { validFrom: JAN_1 };
  const account = await store.nodes.Account.create({ name: "svc-deploy" }, eff);
  const deployer = await store.nodes.Role.create({ name: "deployer" }, eff);
  const admin = await store.nodes.Role.create({ name: "admin" }, eff);
  const ciSecrets = await store.nodes.Resource.create(
    { name: "ci-secrets", sensitivity: "medium" },
    eff,
  );
  const productionDb = await store.nodes.Resource.create(
    { name: "prod-db", sensitivity: "high" },
    eff,
  );
  const pii = await store.nodes.Resource.create(
    { name: "customer-pii", sensitivity: "critical" },
    eff,
  );

  await store.edges.assumes.create(account, deployer, {}, eff);
  await store.edges.grants.create(deployer, ciSecrets, {}, eff);
  await store.edges.grants.create(admin, productionDb, {}, eff);
  await store.edges.grants.create(admin, pii, {}, eff);
  // The dangerous grant: a contractor's deploy role may escalate to admin —
  // but only during the March maintenance window.
  const windowGrant = await store.edges.escalates.create(
    deployer,
    admin,
    {},
    { validFrom: MAR_1, validTo: MAR_8 },
  );

  const nodeName = new Map<string, string>(
    [account, deployer, admin, ciSecrets, productionDb, pii].map(
      (node) => [node.id, node.name] as [string, string],
    ),
  );

  // ----------------------------------------------------------
  // The breach happens — anchor BOTH clocks
  // ----------------------------------------------------------

  // When the alert fires, capture `store.recordedNow()` and persist it with
  // the incident record: `asOfRecorded` takes a branded RecordedInstant
  // obtained from that clock — not a wall-clock timestamp from your SIEM
  // (recorded instants are monotonic and can run ahead of the wall clock).
  const alertAnchor = await requireRecordedNow(store);
  console.log(`\n  ⚠  svc-deploy compromised at ${BREACH_AT} (valid time)`);
  console.log(`     alert anchor: recordedNow() = ${alertAnchor}\n`);

  // ----------------------------------------------------------
  // Incident response tightens permissions — and removes the evidence
  // ----------------------------------------------------------

  console.log("─".repeat(70));
  console.log("  Incident response deletes the deployer→admin escalation");
  console.log("  outright — removed entirely, not just disabled.");
  console.log("─".repeat(70));

  await store.edges.escalates.hardDelete(windowGrant.id);

  // ----------------------------------------------------------
  // Three reads of "what could svc-deploy reach?"
  // ----------------------------------------------------------

  const live = store.view({ mode: "current" });
  console.log("\n  [1] CURRENT graph (live read):");
  printExposure(await exposedResources(live, account.id));
  console.log("      Looks contained — the deleted grant is invisible live.");

  // Valid pin = the breach instant; recorded pin = what we knew at the alert.
  const atBreach = store.asOf(BREACH_AT).asOfRecorded(alertAnchor);
  console.log("\n  [2] store.asOf(breachAt).asOfRecorded(alertAnchor):");
  printExposure(await exposedResources(atBreach, account.id));
  console.log("      The real blast radius: the window grant was in effect");
  console.log("      on Mar 5 AND captured at the anchor — both axes agree.");

  // Same recorded pin, different valid time: the axes are independent.
  const afterWindow = store.asOf(MAR_20).asOfRecorded(alertAnchor);
  console.log("\n  [3] store.asOf(mar20).asOfRecorded(alertAnchor):");
  printExposure(await exposedResources(afterWindow, account.id));
  console.log("      Same recorded pin, later valid time: the window grant");
  console.log("      had expired — no exposure even in the reconstruction.");

  // ----------------------------------------------------------
  // Not just WHAT was exposed — HOW: the escalation path itself
  // ----------------------------------------------------------

  console.log("\n" + "━".repeat(70));
  console.log(" The escalation path, reconstructed on the pinned view");
  console.log("━".repeat(70));

  const pathAtBreach = await atBreach.shortestPath(account.id, pii.id, {
    edges: [...ACCESS_EDGES],
    maxHops: 10,
  });
  if (pathAtBreach === undefined) throw new Error("expected a pinned path");
  const chain = pathAtBreach.nodes
    .map((node, index) => {
      const name = nodeName.get(node.id) ?? node.id;
      if (index === 0) return name;
      const label = hopLabel(pathAtBreach.nodes[index - 1]!.kind, node.kind);
      const gone = label === "escalates" ? " (edge later DELETED)" : "";
      return `─${label}${gone}→ ${name}`;
    })
    .join(" ");
  console.log("\n  atBreach.shortestPath(svc-deploy, customer-pii):");
  console.log(`    ${chain}   [${pathAtBreach.depth} hops]`);

  const pathLive = await live.shortestPath(account.id, pii.id, {
    edges: [...ACCESS_EDGES],
    maxHops: 10,
  });
  const liveVerdict =
    pathLive === undefined ? "no path — the deleted edge is gone" : "??";
  console.log(`\n  Same shortestPath on the live graph: ${liveVerdict}`);

  console.log("\n" + "━".repeat(70));
  console.log(" valid time asks 'was the grant in effect?' · recorded time");
  console.log(
    " asks 'what did we know?' Pin both: deleted evidence traverses.",
  );
  console.log("━".repeat(70) + "\n");
}

export async function main(): Promise<void> {
  const [store] = await createStoreWithSchema(graph, createExampleBackend(), {
    history: true,
  });
  try {
    await runForensics(store);
  } finally {
    await store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
