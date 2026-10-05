import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../../src";
import { createTestBackend } from "../../test-utils";

const Org = defineNode("Org", {
  schema: z.object({ name: z.string().default("org") }),
});
const Dept = defineNode("Dept", {
  schema: z.object({ name: z.string().default("dept") }),
});
const Team = defineNode("Team", {
  schema: z.object({ name: z.string().default("team") }),
});
const Badge = defineNode("Badge", {
  schema: z.object({ name: z.string().default("badge") }),
});
const Auditor = defineNode("Auditor", { schema: z.object({}) });

const deptOf = defineEdge("deptOf", { schema: z.object({}) });
const teamOf = defineEdge("teamOf", { schema: z.object({}) });
const badgeOf = defineEdge("badgeOf", { schema: z.object({}) });
const reviewedBy = defineEdge("reviewedBy", { schema: z.object({}) });

export function buildOrgGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Org: { type: Org, onDelete: "disconnect" },
      Dept: {
        type: Dept,
        onDelete: "restrict",
        unique: [
          { name: "dept_name", fields: ["name"], scope: "kind", collation: "binary" },
        ],
      },
      Team: { type: Team, onDelete: "restrict" },
      Badge: { type: Badge },
      Auditor: { type: Auditor },
    },
    edges: {
      deptOf: { type: deptOf, from: [Dept], to: [Org], cardinality: "one" },
      teamOf: {
        type: teamOf,
        from: [Team],
        to: [Dept],
        cardinality: "oneActive",
      },
      badgeOf: {
        type: badgeOf,
        from: [Badge],
        to: [Org],
        cardinality: "oneActive",
      },
      reviewedBy: { type: reviewedBy, from: [Dept, Team], to: [Auditor] },
    },
    ontology: [
      partOf(Dept, Org, { via: deptOf, existence: "required" }),
      partOf(Team, Dept, { via: teamOf, existence: "required" }),
      partOf(Badge, Org, { via: badgeOf }),
    ],
  });
}

export type OrgGraph = ReturnType<typeof buildOrgGraph>;

export async function createOrgStore(id: string) {
  const backend = createTestBackend();
  const [store] = await createStoreWithSchema(buildOrgGraph(id), backend);
  return { store, backend };
}

export type OrgStore = Awaited<ReturnType<typeof createOrgStore>>["store"];

/** org -> dept -> team, plus a badge on the org. */
export async function seedOrg(store: OrgStore, suffix = "1") {
  const org = await store.nodes.Org.create({ name: `org-${suffix}` }, {
    id: `org-${suffix}`,
  });
  const dept = await store.nodes.Dept.create(
    { name: `dept-${suffix}` },
    { id: `dept-${suffix}`, partOf: { whole: org } },
  );
  const team = await store.nodes.Team.create(
    { name: `team-${suffix}` },
    { id: `team-${suffix}`, partOf: { whole: dept } },
  );
  const badge = await store.nodes.Badge.create(
    { name: `badge-${suffix}` },
    { id: `badge-${suffix}`, partOf: { whole: org } },
  );
  return { org, dept, team, badge };
}

export async function fenceViolations(store: OrgStore) {
  return store.verifyConstraintFences();
}
