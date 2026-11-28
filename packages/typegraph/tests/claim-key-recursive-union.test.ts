/**
 * The key owner's walk is linear in the value under a recursive union.
 *
 * Walking every branch of a union at every level is exponential in the depth
 * when each branch descends into the same child value: a depth-20 value with
 * two recursive branches is about a million branch walks, run synchronously on
 * every write and lookup that keys it. Two things keep the walk linear, and
 * each case below fails without the one it names:
 *
 *  - a branch that structurally cannot hold the value (a discriminator
 *    literal it does not carry) is not walked — the discriminated case gives
 *    each branch its own lazy schema, so no shared walk can stand in;
 *  - a value is walked at a schema once per derivation — the undiscriminated
 *    case has both branches accept every level, through one shared recursive
 *    schema.
 *
 * Visits are counted as calls of the recursive schema's lazy getter, so the
 * assertions are independent of the machine's speed.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  claimKeyValue,
  uniqueKeyValueText,
} from "../src/constraints/claim-key";

const DEPTHS = [20, 200] as const;

/**
 * A union of two shapes told apart by `kind`, each recursing through its own
 * lazy schema, so no value is walked twice at one schema and only excluding
 * the branch the discriminator rules out keeps a level to one visit.
 */
function discriminatedTree(): Readonly<{
  schema: z.ZodType;
  visits: () => number;
}> {
  let visits = 0;
  const child = () =>
    z
      .lazy(() => {
        visits += 1;
        return tree;
      })
      .optional();
  const tree: z.ZodType = z.union([
    z.object({ kind: z.literal("leaf"), at: z.date(), child: child() }),
    z.object({ kind: z.literal("branch"), at: z.date(), child: child() }),
  ]);
  return { schema: tree, visits: () => visits };
}

/** A union of two shapes that both accept every level, sharing `next`. */
function undiscriminatedTree(): Readonly<{
  schema: z.ZodType;
  visits: () => number;
}> {
  let visits = 0;
  const tree: z.ZodType = z.lazy(() => {
    visits += 1;
    return union;
  });
  const union = z.union([
    z.object({ next: tree.optional(), left: z.string().optional() }),
    z.object({ next: tree.optional(), right: z.number().optional() }),
  ]);
  return { schema: tree, visits: () => visits };
}

/**
 * A union of two shapes that both accept every level, each recursing through
 * its own lazy schema: two schemas walk each level, and a level walked at one
 * of them while the other is still walking the level above must stay
 * recorded.
 */
function undiscriminatedTreeOfTwoLazies(): Readonly<{
  schema: z.ZodType;
  visits: () => number;
}> {
  let visits = 0;
  const child = () =>
    z
      .lazy(() => {
        visits += 1;
        return tree;
      })
      .optional();
  const tree: z.ZodType = z.union([
    z.object({ next: child(), left: z.string().optional() }),
    z.object({ next: child(), right: z.number().optional() }),
  ]);
  return { schema: tree, visits: () => visits };
}

/** A stored chain `depth` levels deep, its dates as their stored ISO text. */
function storedChain(
  depth: number,
  level: (index: number) => Record<string, unknown>,
  childKey: string,
): Record<string, unknown> {
  let value: Record<string, unknown> = level(depth - 1);
  for (let index = depth - 2; index >= 0; index -= 1) {
    value = { ...level(index), [childKey]: value };
  }
  return value;
}

const STORED_AT = "2024-01-02T03:04:05.000Z";

describe("the key owner's walk under a recursive union", () => {
  for (const depth of DEPTHS) {
    it(`resolves a discriminated recursive union once per level at depth ${depth}`, () => {
      const { schema, visits } = discriminatedTree();
      // Stored order: `at` before `kind`, and the date as text.
      const stored = storedChain(
        depth,
        (index) => ({
          at: STORED_AT,
          kind: index % 2 === 0 ? "branch" : "leaf",
        }),
        "child",
      );
      const parsed = schema.parse(
        storedChain(
          depth,
          (index) => ({
            kind: index % 2 === 0 ? "branch" : "leaf",
            at: new Date(STORED_AT),
          }),
          "child",
        ),
      );
      const before = visits();

      const keyed = claimKeyValue(schema, stored);

      // One visit per level below the root, which is the union itself.
      expect(visits() - before).toBe(depth - 1);
      // The discriminator selects one branch, so the stored rendering keys
      // as the parse output does.
      expect(uniqueKeyValueText(keyed)).toBe(uniqueKeyValueText(parsed));
    });

    it(`walks a value two branches share once at depth ${depth}`, () => {
      const { schema, visits } = undiscriminatedTree();
      const stored = storedChain(depth, () => ({}), "next");
      const before = visits();

      const keyed = claimKeyValue(schema, stored);

      expect(visits() - before).toBe(depth);
      expect(keyed).toBe(stored);
    });

    it(`walks each level once at each of two recursive schemas at depth ${depth}`, () => {
      const { schema, visits } = undiscriminatedTreeOfTwoLazies();
      const stored = storedChain(depth, () => ({}), "next");
      const before = visits();

      const keyed = claimKeyValue(schema, stored);

      // Two visits per level below the root, one per branch's lazy schema.
      expect(visits() - before).toBe(2 * (depth - 1));
      expect(keyed).toBe(stored);
    });
  }

  it("lets a branch of another primitive type have no say", () => {
    // At a top-level field, where a `Date` keys as its quoted ISO text and a
    // string as itself, so a disagreement would key the text unquoted.
    const schema = z.union([z.date(), z.number()]);

    expect(uniqueKeyValueText(claimKeyValue(schema, STORED_AT))).toBe(
      uniqueKeyValueText(new Date(STORED_AT)),
    );
  });

  it("walks every branch with a say when none can hold the value", () => {
    // Neither shape carries `kind: "other"`; both reorder alike, so the
    // value is canonicalised as it was before branches were excluded.
    const schema = z.union([
      z.object({ kind: z.literal("a"), x: z.string(), y: z.string() }),
      z.object({ kind: z.literal("b"), x: z.string(), y: z.string() }),
    ]);

    expect(
      Object.keys(
        claimKeyValue(schema, { y: "1", kind: "other", x: "2" }) as object,
      ),
    ).toEqual(["kind", "x", "y"]);
  });
});
