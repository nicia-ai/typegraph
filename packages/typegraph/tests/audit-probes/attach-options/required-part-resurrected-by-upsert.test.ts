/**
 * Contract B (required existence): a part of an `existence: "required"` kind
 * never ends a successful call live with no live whole. get-or-create refuses
 * to resurrect one without a `partOf`, and `update` refuses a tombstone, but the
 * upsert family resurrects the tombstone with its composition edge still
 * deleted, so `verifyConstraintFences()` reports a `compositionExistence`
 * violation after only public-API calls.
 */
import { describe, expect, it } from "vitest";

import { createFixtureStore } from "./fixture";
import { isTypedRefusal, outcomeOf } from "./helpers";

type Store = Awaited<ReturnType<typeof createFixtureStore>>;

const RESURRECTING_UPSERTS: Readonly<
  Record<string, (store: Store, id: string) => Promise<unknown>>
> = {
  upsertById: (store, id) =>
    store.nodes.AoReqClip.upsertById(id, { slug: "a" }),
  bulkUpsertById: (store, id) =>
    store.nodes.AoReqClip.bulkUpsertById([{ id, props: { slug: "a" } }]),
  bulkReplaceById: (store, id) =>
    store.nodes.AoReqClip.bulkReplaceById([{ id, props: { slug: "a" } }]),
};

describe("attach-options: required part resurrection", () => {
  it("required-part-resurrected-by-upsert", async () => {
    const orphaning: string[] = [];
    for (const [name, run] of Object.entries(RESURRECTING_UPSERTS)) {
      const store = await createFixtureStore();
      const show = await store.nodes.AoShow.create({});
      const part = await store.nodes.AoReqClip.create(
        { slug: "a" },
        { partOf: { whole: show } },
      );
      await store.nodes.AoReqClip.delete(part.id);

      const outcome = await outcomeOf(() => run(store, part.id));
      expect(
        outcome === undefined || isTypedRefusal(outcome),
        `${name}: unexpected non-typed failure ${String(outcome)}`,
      ).toBe(true);
      const violations = await store.verifyConstraintFences();
      if (violations.length > 0) orphaning.push(name);
    }
    expect(orphaning).toEqual([]);
  });
});
