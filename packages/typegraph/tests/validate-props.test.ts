/**
 * `validateProps` returns the schema's own output: a write encodes a `Date`
 * as the instant it holds where the `Date` becomes stored text, so the
 * validation boundary neither clones nor replaces what the schema returned.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { validateProps } from "../src/schema";

const CONTEXT = {
  entityType: "node",
  kind: "Doc",
  operation: "create",
} as const;

class TaggedDate extends Date {
  readonly tag = "tagged";
}

describe("validateProps", () => {
  it("returns a Date subclass the schema requires as that subclass", () => {
    const schema = z.object({ at: z.instanceof(TaggedDate) });
    const at = new TaggedDate("2024-01-02T03:04:05.678Z");
    const validated = validateProps(schema, { at }, CONTEXT);
    expect(validated.at).toBeInstanceOf(TaggedDate);
    expect(validated.at.tag).toBe("tagged");
  });

  it("returns a readonly object holding a Date still frozen", () => {
    const schema = z.object({ at: z.date() }).readonly();
    const validated = validateProps(
      schema,
      { at: new Date("2024-01-02T03:04:05.678Z") },
      CONTEXT,
    );
    expect(Object.isFrozen(validated)).toBe(true);
  });
});
