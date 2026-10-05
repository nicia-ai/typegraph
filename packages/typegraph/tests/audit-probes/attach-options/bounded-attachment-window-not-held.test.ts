/**
 * Contract A/B: `getOrCreateByConstraint`'s `partOf` is a postcondition and a
 * repeated identical call is idempotent; a DIFFERENT live whole is refused. On a
 * `oneActive` pair a stated `validTo` (past or future) makes the attachment it
 * writes invisible to the incumbent read (only open-ended rows count), so:
 *  - every repeat of the identical call inserts one more identical edge, and
 *  - naming a different whole for a part whose membership is bounded but still
 *    in force is not refused; the part then reads under two wholes at one
 *    valid-time coordinate.
 */
import { describe, expect, it } from "vitest";

import { createFixtureStore, WINDOW_FROM, WINDOW_TO } from "./fixture";
import { isTypedRefusal, outcomeOf } from "./helpers";

const ENDED_AT = "2022-01-01T00:00:00.000Z";
const REPEATS = 3;
const INSIDE_BOUNDED_WINDOW = "2030-01-01T00:00:00.000Z";
const ALL = { temporalMode: "includeEnded" } as const;

async function repeatedEdgeCount(validTo: string): Promise<number> {
  const store = await createFixtureStore();
  const show = await store.nodes.AoShow.create({});
  const partOf = { whole: show, validFrom: WINDOW_FROM, validTo };
  for (let call = 0; call < REPEATS; call += 1) {
    const outcome = await outcomeOf(() =>
      store.nodes.AoClip.getOrCreateByConstraint(
        "slug",
        { slug: "a" },
        { partOf },
      ),
    );
    if (outcome !== undefined && !isTypedRefusal(outcome)) throw outcome;
  }
  return (await store.edges.aoClipOf.find({}, ALL)).length;
}

describe("attach-options: bounded attachment windows", () => {
  it("bounded-attachment-window-not-held", async () => {
    const failures: string[] = [];

    if ((await repeatedEdgeCount(ENDED_AT)) > 1) {
      failures.push("identical ended-window call piles up edges");
    }
    if ((await repeatedEdgeCount(WINDOW_TO)) > 1) {
      failures.push("identical future-bounded call piles up edges");
    }

    const store = await createFixtureStore();
    const first = await store.nodes.AoShow.create({});
    const second = await store.nodes.AoShow.create({});
    await store.nodes.AoClip.getOrCreateByConstraint(
      "slug",
      { slug: "x" },
      { partOf: { whole: first, validFrom: WINDOW_FROM, validTo: WINDOW_TO } },
    );
    const refusal = await outcomeOf(() =>
      store.nodes.AoClip.getOrCreateByConstraint(
        "slug",
        { slug: "x" },
        { partOf: { whole: second } },
      ),
    );
    const wholesInForce = await store
      .asOf(INSIDE_BOUNDED_WINDOW)
      .edges.aoClipOf.find({});
    if (!isTypedRefusal(refusal) && wholesInForce.length > 1) {
      failures.push(
        `different whole accepted; ${wholesInForce.length} wholes in force at ${INSIDE_BOUNDED_WINDOW}`,
      );
    }

    expect(failures).toEqual([]);
  });
});
