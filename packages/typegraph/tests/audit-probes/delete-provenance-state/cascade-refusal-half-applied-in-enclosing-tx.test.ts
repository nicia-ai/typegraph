import { describe, expect, it } from "vitest";

import { createOrgStore, fenceViolations, seedOrg } from "./fixture";

/**
 * Dept declares onDelete: "restrict" and has a non-composition edge, so
 * deleting its Org refuses AFTER the leaf-first cascade has already deleted
 * the Team beneath it. Outside a transaction the refusal rolls everything
 * back; a caller that catches it inside an enclosing store.transaction keeps
 * whatever the cascade wrote before the refusal.
 */
describe("cascade-refusal-half-applied-in-enclosing-tx", () => {
  it("a refused whole delete caught inside store.transaction leaves every row live", async () => {
    const { store } = await createOrgStore("cascade_refusal_half_applied");
    const { org, dept, team, badge } = await seedOrg(store);
    const auditor = await store.nodes.Auditor.create({});
    await store.edges.reviewedBy.create(dept, auditor, {});

    let refusal: unknown;
    await store.transaction(async (tx) => {
      try {
        await tx.nodes.Org.delete(org.id);
      } catch (error) {
        refusal = error;
      }
    });

    expect((refusal as Error | undefined)?.name).toBe("RestrictedDeleteError");
    const live = {
      org: await store.nodes.Org.getById(org.id),
      dept: await store.nodes.Dept.getById(dept.id),
      team: await store.nodes.Team.getById(team.id),
      badge: await store.nodes.Badge.getById(badge.id),
    };
    expect(Object.entries(live).filter(([, row]) => row === undefined)).toEqual(
      [],
    );
    expect(await fenceViolations(store)).toEqual([]);
  });
});
