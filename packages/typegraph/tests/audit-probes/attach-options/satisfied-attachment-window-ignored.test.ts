/**
 * The pair is the population-`one` chapter pair, where a windowed attachment is
 * still the held attachment (an ended `oneActive` edge is not), so a restated
 * call genuinely lands on the satisfied arm.
 *
 * Contract A: a stated `partOf.validFrom` / `partOf.validTo` on an
 * already-satisfied attachment (same whole, same realizing edge) is either
 * applied, verified equal, or refused. Today the satisfied arm of
 * `decideCompositionIncumbent` compares whole + via + props and never reads
 * `attachment.edgeWindow`, so a CONFLICTING window is accepted and dropped.
 */
import { describe, expect, it } from "vitest";

import {
  createFixtureStore,
  OTHER_FROM,
  OTHER_TO,
  WINDOW_FROM,
  WINDOW_TO,
} from "./fixture";
import { isTypedRefusal, outcomeOf } from "./helpers";

type Field = "validFrom" | "validTo";
type Path = "found" | "updated" | "bulkFound" | "bulkUpdated" | "txFound";

const PATHS: readonly Path[] = [
  "found",
  "updated",
  "bulkFound",
  "bulkUpdated",
  "txFound",
];
const FIELDS: readonly Field[] = ["validFrom", "validTo"];
const STORED = { validFrom: WINDOW_FROM, validTo: WINDOW_TO } as const;
const CONFLICTING = { validFrom: OTHER_FROM, validTo: OTHER_TO } as const;

const VIA = "aoChapterOf";

async function silentlyDropped(path: Path, field: Field): Promise<boolean> {
  const store = await createFixtureStore();
  const book = await store.nodes.AoBook.create({});
  await store.nodes.AoChapter.getOrCreateByConstraint(
    "slug",
    { slug: "a" },
    { partOf: { whole: book, via: VIA, ...STORED } },
  );
  const partOf = { whole: book, via: VIA, [field]: CONFLICTING[field] };
  const calls: Record<Path, () => Promise<unknown>> = {
    found: () =>
      store.nodes.AoChapter.getOrCreateByConstraint(
        "slug",
        { slug: "a" },
        { partOf },
      ),
    updated: () =>
      store.nodes.AoChapter.getOrCreateByConstraint(
        "slug",
        { slug: "a", title: "t" },
        { ifExists: "update", partOf },
      ),
    bulkFound: () =>
      store.nodes.AoChapter.bulkGetOrCreateByConstraint(
        "slug",
        [{ props: { slug: "a" } }],
        { partOf },
      ),
    bulkUpdated: () =>
      store.nodes.AoChapter.bulkGetOrCreateByConstraint(
        "slug",
        [{ props: { slug: "a", title: "t" } }],
        { ifExists: "update", partOf },
      ),
    txFound: () =>
      store.transaction((tx) =>
        tx.nodes.AoChapter.getOrCreateByConstraint(
          "slug",
          { slug: "a" },
          { partOf },
        ),
      ),
  };

  const outcome = await outcomeOf(calls[path]);
  if (isTypedRefusal(outcome)) return false;
  const [edge] = await store.edges.aoChapterOf.find({});
  return edge?.meta[field] !== CONFLICTING[field];
}

describe("attach-options: satisfied attachment window", () => {
  it("satisfied-attachment-window-ignored", async () => {
    const dropped: string[] = [];
    for (const path of PATHS) {
      for (const field of FIELDS) {
        if (await silentlyDropped(path, field)) dropped.push(`${path}.${field}`);
      }
    }
    expect(dropped).toEqual([]);
  });
});
