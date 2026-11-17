/**
 * The published description of the composition-orphan refusal must agree
 * with the planner: a part the plan deletes is not a `deleted` orphan but IS
 * refused as `moved` when the target holds it under a live whole the plan
 * keeps (see composition-orphan.test.ts). The changelog and the merge guide
 * therefore may not say that a part the plan deletes is never refused, and
 * must speak of all three causes.
 *
 * The changelog is read rather than the changeset that first carried the
 * text: a changeset file is deleted when its release is versioned, and the
 * changelog entry it becomes is what stays published.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const CHANGELOG_PATH = fileURLToPath(
  new URL("../../CHANGELOG.md", import.meta.url),
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
  "a part the plan deletes, moves or creates with its composition edge is not refused",
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
  it("does not claim a part the plan deletes is never refused", () => {
    const documents = {
      changelog: flattenWhitespace(readFileSync(CHANGELOG_PATH, "utf8")),
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
    expect(section).toContain("judges all three against the state");
    expect(section).not.toContain("judges both");
    expect(section).toContain('still refused as `"moved"`');
  });
});
