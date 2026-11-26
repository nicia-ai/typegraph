/**
 * A retraction verb run inside a caller's transaction, rejected at any of its
 * writes and caught so the caller commits the prefix, then re-run once, ends
 * exactly where the same verb run once without interruption ends — over
 * random composition trees of required parts, each part held through
 * sources of its own.
 *
 * Revert check: in `computeAffectedFactKeys` (`src/provenance/support.ts`)
 * stop descending through a part whose whole does not move, and a tree of
 * depth three whose middle level is reopened before the failure leaves its
 * deepest part closed after the re-run.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
} from "../../src";
import { createRetractionCapability } from "../../src/provenance";
import type { HistoryStore } from "../../src/store-entry";
import { requireDefined } from "../../src/utils/presence";
import { createTestBackend } from "../test-utils";
import { propertyRuns, propertyTestTimeout } from "./run-budget";

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});
const Report = defineNode("Report", {
  schema: z.object({ label: z.string() }),
});
const Section = defineNode("Section", {
  schema: z.object({ label: z.string() }),
});
const Paragraph = defineNode("Paragraph", {
  schema: z.object({ label: z.string() }),
});
const Clause = defineNode("Clause", {
  schema: z.object({ label: z.string() }),
});

const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");
const sectionOf = defineEdge("sectionOf");
const paragraphOf = defineEdge("paragraphOf");
const clauseOf = defineEdge("clauseOf");

const graph = defineGraph({
  id: "property_provenance_interrupted_composition",
  nodes: {
    Source: { type: Source },
    Justification: { type: Justification },
    Report: { type: Report },
    Section: { type: Section },
    Paragraph: { type: Paragraph },
    Clause: { type: Clause },
  },
  edges: {
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: {
      type: derives,
      from: [Justification],
      to: [Report, Section, Paragraph, Clause],
    },
    sectionOf: {
      type: sectionOf,
      from: [Section],
      to: [Report],
      cardinality: "one",
    },
    paragraphOf: {
      type: paragraphOf,
      from: [Paragraph],
      to: [Section],
      cardinality: "one",
    },
    clauseOf: {
      type: clauseOf,
      from: [Clause],
      to: [Paragraph],
      cardinality: "one",
    },
  },
  ontology: [
    partOf(Section, Report, { via: sectionOf, existence: "required" }),
    partOf(Paragraph, Section, { via: paragraphOf, existence: "required" }),
    partOf(Clause, Paragraph, { via: clauseOf, existence: "required" }),
  ],
});

const LEVEL_KINDS = ["Report", "Section", "Paragraph", "Clause"] as const;
type LevelKind = (typeof LEVEL_KINDS)[number];

type TreeStore = HistoryStore<typeof graph>;

type TreeNode = Readonly<{
  level: number;
  /** Index into the nodes of the level above; unused at level 0. */
  parentIndex: number;
  sourceIndexes: readonly number[];
}>;

type Scenario = Readonly<{
  sourceCount: number;
  nodes: readonly TreeNode[];
  sourceIndex: number;
  verb: "retract" | "unRetract";
  /**
   * Which of the verb's writes rejects: write `1 + failurePoint % writes`,
   * where `writes` is the count an uninterrupted run of the verb makes.
   */
  failurePoint: number;
}>;

const MAX_SOURCES = 3;

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .integer({ min: 1, max: MAX_SOURCES })
  .chain((sourceCount) =>
    fc.record({
      sourceCount: fc.constant(sourceCount),
      nodes: fc.array(
        fc.record({
          level: fc.integer({ min: 0, max: LEVEL_KINDS.length - 1 }),
          parentIndex: fc.nat({ max: 3 }),
          sourceIndexes: fc.uniqueArray(
            fc.integer({ min: 0, max: sourceCount - 1 }),
            { minLength: 1, maxLength: sourceCount },
          ),
        }),
        { minLength: 1, maxLength: 9 },
      ),
      sourceIndex: fc.integer({ min: 0, max: sourceCount - 1 }),
      verb: fc.constantFrom("retract" as const, "unRetract" as const),
      failurePoint: fc.nat({ max: 63 }),
    }),
  );

type PlacedNode = Readonly<{
  id: string;
  kind: LevelKind;
  parentId: string | undefined;
  sourceIndexes: readonly number[];
}>;

/**
 * Places the generated nodes level by level. A node whose level has no
 * populated level above it moves up to the deepest populated level plus
 * one, so every non-root node has a whole.
 */
function placeTree(nodes: readonly TreeNode[]): readonly PlacedNode[] {
  const byLevel: PlacedNode[][] = LEVEL_KINDS.map(() => []);
  const ordered = nodes.toSorted((left, right) => left.level - right.level);
  for (const [index, node] of ordered.entries()) {
    const populated = byLevel.findLastIndex((level) => level.length > 0);
    const level = Math.min(node.level, populated + 1);
    const above = level === 0 ? [] : requireDefined(byLevel[level - 1]);
    const parent =
      level === 0 ? undefined : above[node.parentIndex % above.length];
    requireDefined(byLevel[level]).push({
      id: `n${index}`,
      kind: requireDefined(LEVEL_KINDS[level]),
      parentId: parent?.id,
      sourceIndexes: node.sourceIndexes,
    });
  }
  return byLevel.flat();
}

async function seed(
  store: TreeStore,
  scenario: Scenario,
): Promise<readonly PlacedNode[]> {
  for (let index = 0; index < scenario.sourceCount; index += 1) {
    const id = `source-${index}`;
    await store.nodes.Source.create({ label: id, retracted: false }, { id });
  }
  const placed = placeTree(scenario.nodes);
  for (const node of placed) {
    const properties = { label: node.id };
    switch (node.kind) {
      case "Report": {
        await store.nodes.Report.create(properties, { id: node.id });
        break;
      }
      case "Section": {
        await store.nodes.Section.create(properties, {
          id: node.id,
          partOf: {
            whole: { kind: "Report", id: requireDefined(node.parentId) },
          },
        });
        break;
      }
      case "Paragraph": {
        await store.nodes.Paragraph.create(properties, {
          id: node.id,
          partOf: {
            whole: { kind: "Section", id: requireDefined(node.parentId) },
          },
        });
        break;
      }
      case "Clause": {
        await store.nodes.Clause.create(properties, {
          id: node.id,
          partOf: {
            whole: { kind: "Paragraph", id: requireDefined(node.parentId) },
          },
        });
        break;
      }
    }
    for (const sourceIndex of node.sourceIndexes) {
      const justificationId = `${node.id}-j${sourceIndex}`;
      await store.nodes.Justification.create(
        { label: justificationId },
        { id: justificationId },
      );
      await store.edges.premiseOf.create(
        { kind: "Source", id: `source-${sourceIndex}` },
        { kind: "Justification", id: justificationId },
        {},
      );
      await store.edges.derives.create(
        { kind: "Justification", id: justificationId },
        { kind: node.kind, id: node.id },
        {},
      );
    }
  }
  return placed;
}

const REJECTED_WRITE = "rejected verb write";

type Outcome = Readonly<{ live: string[]; held: string[]; writes: number }>;

/**
 * Seeds the tree, retracts the source first when the verb restores it, then
 * runs the verb. With `failAtWrite`, the verb first runs inside a caller's
 * transaction that catches the rejection of that write and commits, and then
 * runs once more on its own. `writes` counts the operations of the last run.
 */
async function runScenario(
  scenario: Scenario,
  failAtWrite: number | undefined,
): Promise<Outcome> {
  const armed = { on: false, failing: false, started: 0 };
  const [store] = await createStoreWithSchema(graph, createTestBackend(), {
    history: true,
    hooks: {
      onOperationStart: () => {
        if (!armed.on) return;
        armed.started += 1;
        if (armed.failing && armed.started === failAtWrite) {
          throw new Error(REJECTED_WRITE);
        }
      },
    },
  });
  await seed(store, scenario);
  const provenance = createRetractionCapability(store, {
    source: { kind: "Source" },
    justification: { kind: "Justification" },
    fact: { kinds: LEVEL_KINDS },
    premiseOf: { kind: "premiseOf" },
    derives: { kind: "derives" },
  });
  const source = {
    kind: "Source",
    id: `source-${scenario.sourceIndex}`,
  } as const;
  if (scenario.verb === "unRetract") await provenance.retract(source);
  const run = (tx?: Parameters<Parameters<TreeStore["transaction"]>[0]>[0]) =>
    scenario.verb === "retract" ?
      provenance.retract(source, tx)
    : provenance.unRetract(source, tx);

  if (failAtWrite !== undefined) {
    await store.transaction(async (tx) => {
      armed.on = true;
      armed.failing = true;
      try {
        await run(tx);
      } catch (error) {
        if (!String(error).includes(REJECTED_WRITE)) throw error;
      } finally {
        armed.on = false;
        armed.failing = false;
      }
    });
    expect(await store.verifyConstraintFences()).toEqual([]);
  }
  armed.started = 0;
  armed.on = true;
  try {
    await run();
  } finally {
    armed.on = false;
  }
  const writes = armed.started;
  expect(await store.verifyConstraintFences()).toEqual([]);

  const live = [
    ...(await store.nodes.Report.find()),
    ...(await store.nodes.Section.find()),
    ...(await store.nodes.Paragraph.find()),
    ...(await store.nodes.Clause.find()),
  ]
    .map((node) => node.id)
    .toSorted();
  const holding = await provenance.holding();
  const held = holding.map((node) => node.id).toSorted();
  return { live, held, writes };
}

describe("provenance retraction: an interrupted verb over a composition tree", () => {
  it(
    "re-running a verb a caught failure interrupted ends where one uninterrupted run ends",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          const expected = await runScenario(scenario, undefined);
          fc.pre(expected.writes > 0);
          const failAtWrite = 1 + (scenario.failurePoint % expected.writes);
          const actual = await runScenario(scenario, failAtWrite);
          expect({ live: actual.live, held: actual.held }).toEqual({
            live: expected.live,
            held: expected.held,
          });
        }),
        {
          numRuns: propertyRuns({ ci: 80, local: 150 }),
          // Report → Section → Paragraph, each held by its own source and the
          // Section and Paragraph also by source 1: restoring source 0 fails
          // after the Report and Section reopen and before the Paragraph.
          examples: [
            [
              {
                sourceCount: 2,
                nodes: [
                  { level: 0, parentIndex: 0, sourceIndexes: [0] },
                  { level: 1, parentIndex: 0, sourceIndexes: [1] },
                  { level: 2, parentIndex: 0, sourceIndexes: [1] },
                ],
                sourceIndex: 0,
                verb: "unRetract",
                failurePoint: 3,
              },
            ],
          ],
        },
      );
    },
    propertyTestTimeout(180_000),
  );
});
