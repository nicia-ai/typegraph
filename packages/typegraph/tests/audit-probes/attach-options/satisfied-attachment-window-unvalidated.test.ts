/**
 * Contract A: a malformed or inverted attachment window is refused with a typed
 * error on every path that accepts it. `create` / `bulkCreate` refuse it, but an
 * already-satisfied get-or-create never reads the window, so the same input is
 * accepted without being validated at all.
 */
import { describe, expect, it } from "vitest";

import { createFixtureStore, WINDOW_FROM, WINDOW_TO } from "./fixture";
import { isTypedRefusal, outcomeOf } from "./helpers";

type Window = Readonly<{ validFrom?: string; validTo?: string }>;

const MALFORMED_WINDOWS: Readonly<Record<string, Window>> = {
  garbageValidFrom: { validFrom: "garbage" },
  garbageValidTo: { validTo: "garbage" },
  inverted: { validFrom: WINDOW_TO, validTo: WINDOW_FROM },
};

describe("attach-options: window validation", () => {
  it("satisfied-attachment-window-unvalidated", async () => {
    const accepted: string[] = [];
    for (const [name, window] of Object.entries(MALFORMED_WINDOWS)) {
      const store = await createFixtureStore();
      const show = await store.nodes.AoShow.create({});
      await store.nodes.AoClip.getOrCreateByConstraint(
        "slug",
        { slug: "a" },
        { partOf: { whole: show } },
      );
      const createRefused = isTypedRefusal(
        await outcomeOf(() =>
          store.nodes.AoClip.create(
            { slug: "fresh" },
            { partOf: { whole: show, ...window } },
          ),
        ),
      );
      expect(createRefused, `${name}: create must refuse`).toBe(true);

      const satisfiedRefused = isTypedRefusal(
        await outcomeOf(() =>
          store.nodes.AoClip.getOrCreateByConstraint(
            "slug",
            { slug: "a" },
            { partOf: { whole: show, ...window } },
          ),
        ),
      );
      if (!satisfiedRefused) accepted.push(`found.${name}`);

      const bulkRefused = isTypedRefusal(
        await outcomeOf(() =>
          store.nodes.AoClip.bulkGetOrCreateByConstraint(
            "slug",
            [{ props: { slug: "a" } }],
            { partOf: { whole: show, ...window } },
          ),
        ),
      );
      if (!bulkRefused) accepted.push(`bulkFound.${name}`);
    }
    expect(accepted).toEqual([]);
  });
});
