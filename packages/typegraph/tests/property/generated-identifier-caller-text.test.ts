/**
 * Caller text reaches SQL unchanged, whatever characters it holds.
 *
 * Generated identifiers are structured chunks of a statement, allocated
 * without reading its text, so a field name or string operand holding the
 * characters an in-band placeholder scheme would act on — the private-use
 * characters U+E000 and U+E001, double and single quotes, backslashes, JSON
 * path punctuation — is neither rewritten nor re-escaped. Each run defines a
 * node with an arbitrary field name, stores rows holding an arbitrary operand
 * and a near miss, and checks a filter and a projection over that field
 * against what was stored: the result the revision before structured
 * allocation returned for names that fit, and the result every revision must
 * return for names that do not.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineGraph, defineNode } from "../../src";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns } from "./run-budget";

const MAX_IDENTIFIER_BYTES = 63;

/** Characters that delimit, escape, or mark text somewhere in the pipeline. */
const SIGNIFICANT_CHARACTERS = [
  "",
  "",
  '"',
  "'",
  "\\",
  "$",
  ".",
  "[",
  "]",
  "_",
  ":",
  "é",
] as const;

const callerText = (minLength: number) =>
  fc.string({
    unit: fc.oneof(
      fc.constantFrom(...SIGNIFICANT_CHARACTERS),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
    ),
    minLength,
    maxLength: 12,
  });

/** Property names a node schema reserves for its own members. */
const RESERVED_FIELDS = new Set(["id", "kind", "meta", "name", "__proto__"]);

/** Whether a node schema accepts `field` as a property name. */
function isAcceptedField(field: string): boolean {
  return !RESERVED_FIELDS.has(field) && !field.startsWith("$");
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** Every name the compiler derives from `alias` and `field` fits. */
function namesFit(alias: string, field: string): boolean {
  return (
    utf8ByteLength(`${alias}_${field}`) <= MAX_IDENTIFIER_BYTES &&
    utf8ByteLength(`__tg_${alias.length}:${alias}:${field.length}:${field}`) <=
      MAX_IDENTIFIER_BYTES
  );
}

/**
 * Stores three rows and reads them back through `alias`. The builder types
 * aliases and fields as literal keys, which runtime-generated strings cannot
 * be; `"root"` and `"field"` are the labels the type checker sees in their
 * place, and every query runs with the generated text.
 */
async function filterAndProject(
  aliasText: string,
  fieldText: string,
  operand: string,
) {
  const alias = aliasText as "root";
  const field = fieldText as "field";
  const Item = defineNode("Item", {
    schema: z.object({ name: z.string(), [field]: z.string() }),
  });
  const graph = defineGraph({
    id: "caller_text_graph",
    nodes: { Item: { type: Item } },
    edges: {},
  });
  const store = createStore(graph, createTestBackend());
  await store.nodes.Item.create({ name: "first", [field]: operand });
  await store.nodes.Item.create({ name: "second", [field]: `${operand}~` });
  await store.nodes.Item.create({ name: "third", [field]: operand });

  const filtered = await store
    .query()
    .from("Item", alias)
    .whereNode(alias, (item) => item[field].eq(operand))
    .select((ctx) => requireDefined(ctx[alias]).name)
    .execute();
  const projected = await store
    .query()
    .from("Item", alias)
    .select((ctx) => {
      const item = requireDefined(ctx[alias]);
      return [item.name, item[field]] as const;
    })
    .execute();

  return { filtered: filtered.toSorted(), projected };
}

function expectStoredValues(
  result: Awaited<ReturnType<typeof filterAndProject>>,
  operand: string,
): void {
  expect(result.filtered).toEqual(["first", "third"]);
  expect(
    result.projected.toSorted(([left], [right]) => left.localeCompare(right)),
  ).toEqual([
    ["first", operand],
    ["second", `${operand}~`],
    ["third", operand],
  ]);
}

describe("caller text through generated identifiers", () => {
  it("filters and projects any field name and operand whose names fit", async () => {
    await fc.assert(
      fc.asyncProperty(callerText(1), callerText(0), async (field, operand) => {
        fc.pre(isAcceptedField(field) && namesFit("p", field));
        expectStoredValues(
          await filterAndProject("p", field, operand),
          operand,
        );
      }),
      { numRuns: propertyRuns({ ci: 60, local: 60 }) },
    );
  });

  it("filters and projects any field name and operand under a 63-character alias", async () => {
    const alias = `a${"b".repeat(61)}c`;
    await fc.assert(
      fc.asyncProperty(callerText(1), callerText(0), async (field, operand) => {
        fc.pre(isAcceptedField(field));
        expect(namesFit(alias, field)).toBe(false);
        expectStoredValues(
          await filterAndProject(alias, field, operand),
          operand,
        );
      }),
      { numRuns: propertyRuns({ ci: 40, local: 40 }) },
    );
  });
});
