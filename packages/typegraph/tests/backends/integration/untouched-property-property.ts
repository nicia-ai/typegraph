/**
 * The update rule as a property (#851): for a random kind schema built from
 * the wrapper × check matrix — a rewriting `.overwrite()`, `.catch()`,
 * `.default()`, a rewriting transform, coercion, a pipe, `.optional()` and
 * `.nullable()` over dates, strings, numbers, nested objects and arrays — and
 * a random patch written through `update`, `upsertById` or `updateWhere`:
 *
 *  - every property the patch does not state is stored byte for byte as it
 *    was before the write, whether the write succeeds or is refused;
 *  - every property it states is stored as that property's schema makes the
 *    stated value, exactly as a create stores it;
 *  - a refusal is a `ValidationError` and leaves the row untouched;
 *  - writing the same patch a second time stores the same bytes as once.
 *
 * Each run writes under a fresh graph id over the already-provisioned backend
 * (a bare `createStore` issues no DDL), so runs and shrinks are hermetic.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStore,
  defineGraph,
  defineNode,
  ValidationError,
} from "../../../src";
import { rowPropsToObject } from "../../../src/backend/types";
import { canonicalJson } from "../../../src/schema/canonical";
import { requireDefined } from "../../../src/utils/presence";
import { propertyRuns } from "../../property/run-budget";
import { type IntegrationTestContext } from "./test-context";

const DAY_MS = 86_400_000;

type Base = Readonly<{
  name: string;
  schema: () => z.ZodType;
  value: fc.Arbitrary<unknown>;
  fallback: unknown;
  /** A type-preserving rewrite a schema step applies on every parse. */
  rewrite: (value: unknown) => unknown;
  coerced?: () => z.ZodType;
}>;

const BASES: readonly Base[] = [
  {
    name: "string",
    schema: () => z.string(),
    value: fc.string({ maxLength: 6 }),
    fallback: "fallback",
    rewrite: (value) => `${String(value)}~`,
    coerced: () => z.coerce.string(),
  },
  {
    name: "number",
    schema: () => z.number(),
    value: fc.integer({ min: -100, max: 100 }),
    fallback: -1,
    rewrite: (value) => Number(value) + 1,
    coerced: () => z.coerce.number(),
  },
  {
    name: "date",
    schema: () => z.date(),
    value: fc.date({
      min: new Date("2000-01-01T00:00:00.000Z"),
      max: new Date("2030-01-01T00:00:00.000Z"),
      noInvalidDate: true,
    }),
    fallback: new Date("1999-01-01T00:00:00.000Z"),
    rewrite: (value) => new Date((value as Date).getTime() + DAY_MS),
    coerced: () => z.coerce.date(),
  },
  {
    name: "nested",
    schema: () => z.object({ label: z.string(), count: z.number() }),
    value: fc.record({
      label: fc.string({ maxLength: 4 }),
      count: fc.integer({ min: 0, max: 9 }),
    }),
    fallback: { label: "fallback", count: 0 },
    rewrite: (value) => {
      const nested = value as Readonly<{ label: string; count: number }>;
      return { ...nested, count: nested.count + 1 };
    },
  },
  {
    name: "array",
    schema: () => z.array(z.number()),
    value: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 3 }),
    fallback: [],
    rewrite: (value) => [...(value as readonly number[]), 0],
  },
];

const WRAPPERS = [
  "plain",
  "overwrite",
  "catch",
  "default",
  "transform",
  "coerce",
  "pipe",
  "optional",
  "nullable",
] as const;

type Wrapper = (typeof WRAPPERS)[number];

function propertySchema(base: Base, wrapper: Wrapper): z.ZodType {
  const schema = base.schema();
  switch (wrapper) {
    case "plain": {
      return schema;
    }
    case "overwrite": {
      return schema.overwrite((value) => base.rewrite(value));
    }
    case "catch": {
      return schema.catch(base.fallback as never);
    }
    case "default": {
      return schema.default(base.fallback as never);
    }
    case "transform": {
      return schema.transform((value) => base.rewrite(value));
    }
    case "coerce": {
      return base.coerced?.() ?? schema;
    }
    case "pipe": {
      return schema.pipe(
        base.schema().transform((value) => base.rewrite(value)),
      );
    }
    case "optional": {
      return schema.optional();
    }
    case "nullable": {
      return schema.nullable();
    }
  }
}

/** A value a caller may state for the property. */
function statedValue(base: Base, wrapper: Wrapper): fc.Arbitrary<unknown> {
  switch (wrapper) {
    case "optional": {
      return fc.option(base.value, { nil: undefined });
    }
    case "nullable": {
      // eslint-disable-next-line unicorn/no-null -- a nullable property states null
      return fc.option(base.value, { nil: null });
    }
    case "plain":
    case "overwrite":
    case "catch":
    case "default":
    case "transform":
    case "coerce":
    case "pipe": {
      return base.value;
    }
  }
}

type Slot = Readonly<{ base: Base; wrapper: Wrapper }>;

const slotArb: fc.Arbitrary<Slot> = fc.record({
  base: fc.constantFrom(...BASES),
  wrapper: fc.constantFrom(...WRAPPERS),
});

type Scenario = Readonly<{
  slots: readonly Slot[];
  created: Readonly<Record<string, unknown>>;
  patch: Readonly<Record<string, unknown>>;
  write: "update" | "upsertById" | "updateWhere";
}>;

function key(index: number): string {
  return `p${index}`;
}

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .array(slotArb, { minLength: 1, maxLength: 4 })
  .chain((slots) =>
    fc.record({
      slots: fc.constant(slots),
      created: fc.record(
        Object.fromEntries(
          slots.map((slot, index) => [
            key(index),
            statedValue(slot.base, slot.wrapper),
          ]),
        ),
      ),
      patch: fc.record(
        Object.fromEntries(
          slots.map((slot, index) => [
            key(index),
            statedValue(slot.base, slot.wrapper),
          ]),
        ),
        { requiredKeys: [] },
      ),
      write: fc.constantFrom(
        "update" as const,
        "upsertById" as const,
        "updateWhere" as const,
      ),
    }),
  );

let runSequence = 0;

type PropertyCollection = Readonly<{
  create: (props: Record<string, unknown>) => Promise<{ id: string }>;
  update: (id: string, props: Record<string, unknown>) => Promise<unknown>;
  upsertById: (id: string, props: Record<string, unknown>) => Promise<unknown>;
  updateWhere: (args: {
    where: (node: { id: { eq: (value: string) => unknown } }) => unknown;
    patch: Record<string, unknown>;
  }) => Promise<unknown>;
}>;

/** Each stored property as its JSON text. */
function storedText(
  props: Readonly<Record<string, unknown>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(props).map(([name, value]) => [name, canonicalJson(value)]),
  );
}

export function registerUntouchedPropertyPropertyTests(
  context: IntegrationTestContext,
): void {
  describe("Untouched-property update property (#851)", () => {
    it("a write stores every unstated property as stored and every stated one as its schema makes it, idempotently", async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          runSequence += 1;
          const shape = Object.fromEntries(
            scenario.slots.map((slot, index) => [
              key(index),
              propertySchema(slot.base, slot.wrapper),
            ]),
          );
          const Kind = defineNode("UntouchedProperty", {
            schema: z.object(shape),
          });
          const graph = defineGraph({
            id: `untouched_property_${runSequence}`,
            nodes: { UntouchedProperty: { type: Kind } },
            edges: {},
          });
          const backend = context.getBackend();
          const store = createStore(graph, backend);
          const collection = store.nodes
            .UntouchedProperty as unknown as PropertyCollection;
          const { id } = await collection.create({ ...scenario.created });
          const read = async () =>
            storedText(
              rowPropsToObject(
                requireDefined(
                  await backend.getNode(store.graphId, "UntouchedProperty", id),
                ).props,
              ),
            );
          const patch = { ...scenario.patch };
          const write = async () => {
            if (
              scenario.write === "updateWhere" &&
              Object.keys(patch).length > 0
            ) {
              await collection.updateWhere({
                where: (node) => node.id.eq(id),
                patch,
              });
            } else if (scenario.write === "upsertById") {
              await collection.upsertById(id, patch);
            } else {
              await collection.update(id, patch);
            }
          };
          const stated = new Set(Object.keys(patch));
          const unstated = (stored: Readonly<Record<string, string>>) =>
            Object.fromEntries(
              Object.entries(stored).filter(([name]) => !stated.has(name)),
            );

          const before = await read();
          const outcome = await write().then(
            () => "written" as const,
            (error: unknown) => error,
          );
          const once = await read();
          const refused = outcome !== "written";
          // A refusal is a ValidationError that leaves the row untouched.
          expect(
            refused ?
              [outcome instanceof ValidationError, once]
            : [true, before],
          ).toEqual([true, before]);
          if (refused) return;
          expect(unstated(once)).toEqual(unstated(before));
          for (const name of stated) {
            const parsed = requireDefined(shape[name]).safeParse(patch[name]);
            expect(parsed.success).toBe(true);
            const expected =
              parsed.data === undefined ?
                undefined
              : canonicalJson(parsed.data);
            expect([name, once[name]]).toEqual([name, expected]);
          }

          await write();
          expect(await read()).toEqual(once);
        }),
        { numRuns: propertyRuns({ ci: 40, local: 80 }) },
      );
    });
  });
}
