import { describe, expect, it } from "vitest";

import { createOrgStore, fenceViolations, seedOrg } from "./fixture";

/**
 * A required-existence part whose whole was deleted (the cascade tombstoned
 * it and removed its composition edge) can only come back with a whole:
 * `create({ id })` refuses it with COMPOSITION_WHOLE_REQUIRED. The upsert
 * family resurrects the same tombstone through the update leg instead.
 */
describe("resurrect-required-part-without-whole", () => {
  const entryPoints = {
    upsertById: (store: Awaited<ReturnType<typeof createOrgStore>>["store"], id: string) =>
      store.nodes.Dept.upsertById(id, { name: "back" }),
    bulkUpsertById: (store: Awaited<ReturnType<typeof createOrgStore>>["store"], id: string) =>
      store.nodes.Dept.bulkUpsertById([{ id, props: { name: "back" } }]),
    bulkReplaceById: (store: Awaited<ReturnType<typeof createOrgStore>>["store"], id: string) =>
      store.nodes.Dept.bulkReplaceById([{ id, props: { name: "back" } }]),
  } as const;

  for (const [name, resurrect] of Object.entries(entryPoints)) {
    it(`${name} leaves no live required part without a whole`, async () => {
      const { store } = await createOrgStore(`resurrect_required_${name}`);
      const { org, dept } = await seedOrg(store);
      await store.nodes.Org.delete(org.id);

      // Either refusal is acceptable; a successful write must not orphan.
      await resurrect(store, dept.id).catch(() => undefined);

      expect(await fenceViolations(store)).toEqual([]);
    });
  }
});
