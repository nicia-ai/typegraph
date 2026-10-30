/**
 * The published description of `MergePlanReview.compositionOrphans` must agree
 * with the planner: a part the plan deletes is not a `deleted` orphan but IS
 * reported as `moved` when the target holds it under a live whole the plan
 * keeps (see composition-orphan.test.ts). The changeset and the merge guide
 * therefore may not say that a part the plan deletes is never reported, and
 * must speak of all three causes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CHANGESET_PATH = fileURLToPath(
  new URL("../../../../.changeset/composition.md", import.meta.url),
);
const MERGE_GUIDE_PATH = fileURLToPath(
  new URL(
    "../../../../apps/docs/src/content/docs/graph-merge.md",
    import.meta.url,
  ),
);
const NEVER_REPORTED_CLAIMS = [
  "a part the plan deletes, moves or creates with its composition edge is not reported",
  "are not orphans and are not reported",
] as const;

function flattenWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

function compositionOrphanGuideSection(): string {
  const guide = readFileSync(MERGE_GUIDE_PATH, "utf8");
  const start = guide.indexOf("### Composition orphans");
  const end = guide.indexOf("\n### ", start + 1);
  return flattenWhitespace(guide.slice(start, end === -1 ? undefined : end));
}

describe("composition orphan documentation", () => {
  it("does not claim a part the plan deletes is never reported", () => {
    const documents = {
      changeset: flattenWhitespace(readFileSync(CHANGESET_PATH, "utf8")),
      guide: compositionOrphanGuideSection(),
    };
    for (const [name, text] of Object.entries(documents)) {
      for (const claim of NEVER_REPORTED_CLAIMS) {
        expect(text, `${name} claims: ${claim}`).not.toContain(claim);
      }
    }
  });

  it("scopes the guide's judged-against-the-plan statement to all three causes", () => {
    const section = compositionOrphanGuideSection();
    expect(section).toContain("judge all three against the state");
    expect(section).not.toContain("judge both");
    expect(section).toContain('still reported as `"moved"`');
  });
});
