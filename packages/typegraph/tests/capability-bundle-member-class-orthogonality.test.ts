/**
 * Bundles partition `GraphBackend`'s optional members by FEATURE FAMILY;
 * `GRAPH_BACKEND_MEMBER_CLASSES` (`src/backend/member-classes.ts`) partitions
 * ALL of `GraphBackend` by WRITE-PIPELINE ROLE. The two partitions must stay
 * independent — a bundle member classified nowhere, or in two classes, would
 * be a third, undeclared theory of what a member is.
 */
import { describe, expect, it } from "vitest";

import { CAPABILITY_BUNDLES } from "../src/backend/capabilities/bundle-registry";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../src/backend/member-classes";

function pilotMembers(): readonly string[] {
  const members: string[] = [];
  for (const bundle of CAPABILITY_BUNDLES) {
    if ("core" in bundle) members.push(...bundle.core);
    if ("extras" in bundle) {
      for (const extra of bundle.extras) members.push(...extra.members);
    }
  }
  return members;
}

function classFor(member: string): readonly string[] {
  const owners: string[] = [];
  for (const [className, classMembers] of Object.entries(
    GRAPH_BACKEND_MEMBER_CLASSES,
  )) {
    if ((classMembers as readonly string[]).includes(member)) {
      owners.push(className);
    }
  }
  return owners;
}

describe("pilot bundle members × GRAPH_BACKEND_MEMBER_CLASSES orthogonality", () => {
  it("every one of the 15 pilot members appears in exactly one member class", () => {
    const members = pilotMembers();
    expect(members.length).toBe(15);

    const map: Record<string, string> = {};
    for (const member of members) {
      const owners = classFor(member);
      expect(
        owners.length,
        `"${member}" is classified by ${JSON.stringify(owners)}, expected exactly one`,
      ).toBe(1);
      const [owner] = owners;
      if (owner !== undefined) map[member] = owner;
    }

    // The member→class map, reported for the reviewer (as the spec requires).
    expect(map).toEqual({
      claimEdgeCardinality: "sidecarWrite",
      claimEdgeCardinalityBatch: "sidecarWrite",
      purgeEdgeClaims: "sidecarWrite",
      hardDeleteUniquesByConcreteKind: "sidecarWrite",
      insertUniqueBatch: "sidecarWrite",
      checkUniqueBatch: "read",
      hardDeleteUniquesByNodeIds: "sidecarWrite",
      getNodes: "read",
      getEdges: "read",
      executeStatement: "rawSql",
      verifyContributions: "read",
      repairContributions: "maintenance",
      rebuildContribution: "maintenance",
      probeContributions: "read",
      ensureRevisionOriginsTable: "provisioning",
    });
  });
});
