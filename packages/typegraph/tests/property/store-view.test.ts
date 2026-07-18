/**
 * Property-Based Tests for StoreView
 *
 * The defining law of a `StoreView` is that pinning a coordinate is
 * equivalent to passing that same coordinate to every read by hand. For
 * randomly generated validity windows and a random `asOf` instant `t`:
 *
 *   store.asOf(t).<surface>  ≡  store.<surface>({ temporalMode: "asOf", asOf: t })
 *
 * across the node, edge, and query surfaces — plus the current-view
 * identity `store.view({ mode: "current" }) ≡ the live store`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../../src";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";

const Item = defineNode("Item", {
  schema: z.object({ label: z.string() }),
});

const link = defineEdge("link", { schema: z.object({}) });

const propertyGraph = defineGraph({
  id: "prop_store_view",
  nodes: { Item: { type: Item } },
  edges: { link: { type: link, from: [Item], to: [Item] } },
});

// ============================================================
// Arbitraries — canonical UTC ISO timestamps within a fixed window
// ============================================================

const BASE_MS = Date.UTC(2024, 0, 1);
const DAY_MS = 86_400_000;

/** A canonical (`.sssZ`) UTC ISO timestamp `d` days after 2024-01-01. */
function dayTimestamp(day: number): string {
  return new Date(BASE_MS + day * DAY_MS).toISOString();
}

const timestampArb = fc
  .integer({ min: 0, max: 20 })
  .map((day) => dayTimestamp(day));
const optionalTimestampArb = fc.option(timestampArb, { nil: undefined });

// `validFrom` is always set so the chosen `asOf` actually discriminates;
// `validTo` is optional.
const nodeSpecArb = fc.record({
  validFrom: timestampArb,
  validTo: optionalTimestampArb,
});

const edgeSpecArb = fc.record({
  from: fc.nat(),
  to: fc.nat(),
  validFrom: timestampArb,
  validTo: optionalTimestampArb,
});

const scenarioArb = fc.record({
  nodes: fc.array(nodeSpecArb, { minLength: 1, maxLength: 8 }),
  edges: fc.array(edgeSpecArb, { maxLength: 8 }),
  asOf: timestampArb,
});

// ============================================================
// Helpers
// ============================================================

function sortedIds(rows: readonly Readonly<{ id: string }>[]): string[] {
  return rows.map((row) => row.id).toSorted();
}

function withValidity(
  validFrom: string,
  validTo: string | undefined,
): Readonly<{ validFrom: string; validTo?: string }> {
  return validTo === undefined ? { validFrom } : { validFrom, validTo };
}

// ============================================================
// Property Tests
// ============================================================

describe("StoreView property tests", () => {
  it("asOf(t) view ≡ manual temporal('asOf', t) across surfaces", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const store = createStore(propertyGraph, createTestBackend());

        const ids: string[] = [];
        for (const spec of scenario.nodes) {
          const node = await store.nodes.Item.create(
            { label: "item" },
            withValidity(spec.validFrom, spec.validTo),
          );
          ids.push(node.id);
        }
        for (const spec of scenario.edges) {
          await store.edges.link.create(
            { kind: "Item", id: requireDefined(ids[spec.from % ids.length]) },
            { kind: "Item", id: requireDefined(ids[spec.to % ids.length]) },
            {},
            withValidity(spec.validFrom, spec.validTo),
          );
        }

        const t = scenario.asOf;
        const past = store.asOf(t);
        const manual = { temporalMode: "asOf", asOf: t } as const;

        // Node find
        expect(sortedIds(await past.nodes.Item.find())).toEqual(
          sortedIds(await store.nodes.Item.find(undefined, manual)),
        );

        // Node count
        expect(await past.nodes.Item.count()).toBe(
          await store.nodes.Item.count(manual),
        );

        // Query builder
        const viewQuery = await past
          .query()
          .from("Item", "i")
          .select((ctx) => ctx.i.id)
          .execute();
        const manualQuery = await store
          .query()
          .from("Item", "i")
          .temporal("asOf", t)
          .select((ctx) => ctx.i.id)
          .execute();
        expect([...viewQuery].toSorted()).toEqual([...manualQuery].toSorted());

        // Edge findFrom (from the first node)
        const ref = { kind: "Item", id: requireDefined(ids[0]) } as const;
        expect(sortedIds(await past.edges.link.findFrom(ref))).toEqual(
          sortedIds(await store.edges.link.findFrom(ref, manual)),
        );
      }),
      { numRuns: 25 },
    );
  }, 30_000);

  it("current view ≡ the live store", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        const store = createStore(propertyGraph, createTestBackend());

        const ids: string[] = [];
        for (const spec of scenario.nodes) {
          const node = await store.nodes.Item.create(
            { label: "item" },
            withValidity(spec.validFrom, spec.validTo),
          );
          ids.push(node.id);
        }
        for (const spec of scenario.edges) {
          await store.edges.link.create(
            { kind: "Item", id: requireDefined(ids[spec.from % ids.length]) },
            { kind: "Item", id: requireDefined(ids[spec.to % ids.length]) },
            {},
            withValidity(spec.validFrom, spec.validTo),
          );
        }

        const current = store.view({ mode: "current" });
        const ref = { kind: "Item", id: requireDefined(ids[0]) } as const;

        expect(sortedIds(await current.nodes.Item.find())).toEqual(
          sortedIds(await store.nodes.Item.find()),
        );
        expect(await current.nodes.Item.count()).toBe(
          await store.nodes.Item.count(),
        );
        expect(sortedIds(await current.edges.link.findFrom(ref))).toEqual(
          sortedIds(await store.edges.link.findFrom(ref)),
        );
      }),
      { numRuns: 25 },
    );
  }, 30_000);
});
