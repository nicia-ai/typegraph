/**
 * Composition reads against a reference model, over random forests.
 *
 * A generated script builds a two-level forest on a fake clock — attaching,
 * ending and soft-deleting composition edges and ending part nodes — on a
 * graph whose two relations draw their populations independently, so one
 * relation can hold an "allRows" kind and the other an "openRows" kind:
 *
 *   PrRoot <-(prMidOf, partOf, population TOP)-- PrMid
 *   PrMid --(prHasLeaf, hasPart, population SUB)--> PrLeaf
 *
 * The model (plain TS, no store code) decides membership: an edge binds at
 * instant t when it is not soft-deleted (a soft-delete is retroactive for
 * every valid-time read), `validFrom <= t`, and — for a "oneActive" relation
 * only — `t < validTo`. Reads follow membership for edges and the read's
 * temporal filter for nodes: a part node the read cannot see is not returned,
 * nor is anything reachable only through it.
 *
 * At every sampled coordinate (current, includeEnded, includeTombstones, and
 * asOf instants on and just before the script's own write instants):
 * - `parts()`, `parts({ maxHops: 1 })`, `wholes()` and
 *   `subgraph({ composition: true })` equal the model;
 * - `p ∈ parts(w) ⇔ w ∈ wholes(p)`, judged on the reads alone;
 * and after every write `planDelete` of each root equals the model's
 * ownership closure now, ignoring node visibility (the cascade owns a hidden
 * part too). An asOf read at a write instant no later soft-delete rewrote,
 * with every node visible there, also equals the plan captured at that write.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  hasPart,
  type NodeDeletePlan,
  partOf,
} from "../../../src";
import { propertyRuns } from "../../property/run-budget";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const PrRoot = defineNode("PrRoot", { schema: z.object({}) });
const PrMid = defineNode("PrMid", { schema: z.object({}) });
const PrLeaf = defineNode("PrLeaf", { schema: z.object({}) });
const prMidOf = defineEdge("prMidOf", { schema: z.object({}) });
const prHasLeaf = defineEdge("prHasLeaf", { schema: z.object({}) });

type Population = "one" | "oneActive";
const POPULATIONS: readonly Population[] = ["one", "oneActive"];

const ROOT_COUNT = 2;
const MID_COUNT = 3;
const LEAF_COUNT = 3;
const CLOCK_START = Date.parse("2040-01-01T00:00:00.000Z");
const CLOCK_STEP_MS = 1000;

let graphIdCounter = 0;

function buildGraph(top: Population, sub: Population) {
  graphIdCounter += 1;
  return defineGraph({
    id: `composition_reads_model_${graphIdCounter}`,
    nodes: {
      PrRoot: { type: PrRoot },
      PrMid: { type: PrMid },
      PrLeaf: { type: PrLeaf },
    },
    edges: {
      prMidOf: {
        type: prMidOf,
        from: [PrMid],
        to: [PrRoot],
        cardinality: top,
      },
      prHasLeaf: {
        type: prHasLeaf,
        from: [PrMid],
        to: [PrLeaf],
        targetCardinality: sub,
      },
    },
    ontology: [
      partOf(PrMid, PrRoot, { via: prMidOf }),
      hasPart(PrMid, PrLeaf, { via: prHasLeaf }),
    ],
  });
}

type ModelGraph = ReturnType<typeof buildGraph>;
type ModelStore = InspectableStore<ModelGraph>;

type Op =
  | Readonly<{ type: "attachMid"; mid: number; root: number }>
  | Readonly<{ type: "attachLeaf"; leaf: number; mid: number }>
  | Readonly<{ type: "endEdge"; pick: number }>
  | Readonly<{ type: "deleteEdge"; pick: number }>
  | Readonly<{ type: "endNode"; pick: number }>;

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("attachMid" as const),
      mid: fc.nat({ max: MID_COUNT - 1 }),
      root: fc.nat({ max: ROOT_COUNT - 1 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("attachLeaf" as const),
      leaf: fc.nat({ max: LEAF_COUNT - 1 }),
      mid: fc.nat({ max: MID_COUNT - 1 }),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("endEdge" as const),
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("deleteEdge" as const),
      pick: fc.nat(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("endNode" as const),
      pick: fc.nat(),
    }),
  },
);

/** A starting forest: each mid under some root, each leaf under some mid, or unattached. */
const seedForestArbitrary: fc.Arbitrary<readonly Op[]> = fc
  .tuple(
    fc.array(fc.option(fc.nat({ max: ROOT_COUNT - 1 }), { freq: 4 }), {
      minLength: MID_COUNT,
      maxLength: MID_COUNT,
    }),
    fc.array(fc.option(fc.nat({ max: MID_COUNT - 1 }), { freq: 4 }), {
      minLength: LEAF_COUNT,
      maxLength: LEAF_COUNT,
    }),
  )
  .map(([midRoots, leafMids]) => [
    ...midRoots.flatMap((root, mid): Op[] =>
      root === null ? [] : [{ type: "attachMid", mid, root }],
    ),
    ...leafMids.flatMap((mid, leaf): Op[] =>
      mid === null ? [] : [{ type: "attachLeaf", leaf, mid }],
    ),
  ]);

const scenarioArbitrary = fc.record({
  top: fc.constantFrom(...POPULATIONS),
  sub: fc.constantFrom(...POPULATIONS),
  ops: fc
    .tuple(seedForestArbitrary, fc.array(opArbitrary, { maxLength: 10 }))
    .map(([seedOps, ops]) => [...seedOps, ...ops]),
  asOfPicks: fc.array(fc.nat(), { minLength: 2, maxLength: 4 }),
});

type Scenario =
  typeof scenarioArbitrary extends fc.Arbitrary<infer T> ? T : never;

// ============================================================
// Reference model
// ============================================================

interface ModelNode {
  readonly kind: "PrRoot" | "PrMid" | "PrLeaf";
  readonly id: string;
  validTo: number | undefined;
}

type Relation = "prMidOf" | "prHasLeaf";

interface ModelEdge {
  readonly id: string;
  readonly relation: Relation;
  /** Node keys, part and whole, independent of the edge's direction. */
  readonly part: string;
  readonly whole: string;
  readonly validFrom: number;
  validTo: number | undefined;
  deleted: boolean;
}

type Model = Readonly<{
  populations: Readonly<Record<Relation, Population>>;
  nodes: Map<string, ModelNode>;
  edges: ModelEdge[];
}>;

/** A read's coordinate: which instant decides membership, and which nodes it sees. */
type Coordinate = Readonly<{
  label: string;
  /** The instant membership is judged at. */
  instant: number;
  /** The instant node windows are judged at; `undefined` sees every node. */
  nodeInstant: number | undefined;
}>;

function keyOf(node: Readonly<{ kind: string; id: string }>): string {
  return `${node.kind}:${node.id}`;
}

function edgeBinds(model: Model, edge: ModelEdge, instant: number): boolean {
  if (edge.deleted || edge.validFrom > instant) return false;
  if (model.populations[edge.relation] === "one") return true;
  return edge.validTo === undefined || instant < edge.validTo;
}

function nodeVisible(
  node: ModelNode,
  nodeInstant: number | undefined,
): boolean {
  if (nodeInstant === undefined) return true;
  // Every node is created at CLOCK_START, before any coordinate.
  return node.validTo === undefined || nodeInstant < node.validTo;
}

function requireNode(model: Model, key: string): ModelNode {
  const node = model.nodes.get(key);
  if (node === undefined) throw new Error(`model has no node ${key}`);
  return node;
}

/** Direct (part, whole, edge) bindings at a membership instant. */
function bindings(model: Model, instant: number): readonly ModelEdge[] {
  return model.edges.filter((edge) => edgeBinds(model, edge, instant));
}

/**
 * The closure under `whole`, as `part<whole` pairs naming each part's own
 * whole. `nodeInstant` hides parts (and what only they reach); `undefined`
 * sees every node, the cascade's view.
 */
function closure(
  model: Model,
  whole: string,
  coordinate: Pick<Coordinate, "instant" | "nodeInstant">,
  maxHops = Number.POSITIVE_INFINITY,
): ReadonlyMap<string, string> {
  const bound = bindings(model, coordinate.instant);
  const reached = new Map<string, string>();
  if (!nodeVisible(requireNode(model, whole), coordinate.nodeInstant)) {
    return reached;
  }
  let frontier = [whole];
  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const edge of bound) {
        if (edge.whole !== current || reached.has(edge.part)) continue;
        if (!nodeVisible(requireNode(model, edge.part), coordinate.nodeInstant))
          continue;
        reached.set(edge.part, current);
        next.push(edge.part);
      }
    }
    frontier = next;
  }
  return reached;
}

function wholesOf(
  model: Model,
  part: string,
  coordinate: Coordinate,
): readonly string[] {
  if (!nodeVisible(requireNode(model, part), coordinate.nodeInstant)) {
    return [];
  }
  const bound = bindings(model, coordinate.instant);
  const found: string[] = [];
  let current = part;
  for (;;) {
    const up = bound.find((edge) => edge.part === current);
    if (up === undefined) break;
    if (!nodeVisible(requireNode(model, up.whole), coordinate.nodeInstant))
      break;
    found.push(up.whole);
    current = up.whole;
  }
  return found;
}

function liveEdges(model: Model): readonly ModelEdge[] {
  return model.edges.filter((edge) => !edge.deleted);
}

/** Only writes the store surely accepts: the model never predicts a refusal. */
function claimFree(model: Model, relation: Relation, part: string): boolean {
  return !model.edges.some(
    (edge) =>
      edge.relation === relation &&
      edge.part === part &&
      (model.populations[relation] === "one" || edge.validTo === undefined),
  );
}

function rootKey(index: number): string {
  return `PrRoot:r${index}`;
}

function midKey(index: number): string {
  return `PrMid:m${index}`;
}

function leafKey(index: number): string {
  return `PrLeaf:l${index}`;
}

function idOf(key: string): string {
  return key.slice(key.indexOf(":") + 1);
}

// ============================================================
// Store side
// ============================================================

function planPairs(plan: NodeDeletePlan): readonly string[] {
  return plan.cascadedParts
    .map((part) => `${keyOf(part)}<${keyOf(part.whole)}`)
    .toSorted();
}

function modelPairs(reached: ReadonlyMap<string, string>): readonly string[] {
  return [...reached].map(([part, whole]) => `${part}<${whole}`).toSorted();
}

async function planOf(store: ModelStore, root: string) {
  const plan = await store.nodes.PrRoot.planDelete(idOf(root) as never);
  if (plan === undefined) throw new Error(`no plan for ${root}`);
  return plan;
}

/** Applies one op when the model accepts it; returns whether it ran. */
async function applyOp(
  store: ModelStore,
  model: Model,
  op: Op,
  now: number,
): Promise<boolean> {
  const at = new Date(now).toISOString();
  switch (op.type) {
    case "attachMid":
    case "attachLeaf": {
      const [relation, part, whole]: [Relation, string, string] =
        op.type === "attachMid" ?
          ["prMidOf", midKey(op.mid), rootKey(op.root)]
        : ["prHasLeaf", leafKey(op.leaf), midKey(op.mid)];
      if (!claimFree(model, relation, part)) return false;
      if (requireNode(model, part).validTo !== undefined) return false;
      if (requireNode(model, whole).validTo !== undefined) return false;
      const id = `e${model.edges.length}`;
      await (relation === "prMidOf" ?
        store.edges.prMidOf.create(
          { kind: "PrMid", id: idOf(part) },
          { kind: "PrRoot", id: idOf(whole) },
          {},
          { id },
        )
      : store.edges.prHasLeaf.create(
          { kind: "PrMid", id: idOf(whole) },
          { kind: "PrLeaf", id: idOf(part) },
          {},
          { id },
        ));
      model.edges.push({
        id,
        relation,
        part,
        whole,
        validFrom: now,
        validTo: undefined,
        deleted: false,
      });
      return true;
    }
    case "endEdge": {
      const open = liveEdges(model).filter(
        (edge) => edge.validTo === undefined,
      );
      const edge = open[op.pick % Math.max(open.length, 1)];
      if (edge === undefined) return false;
      await store.edges[edge.relation].update(
        edge.id as never,
        {},
        { validTo: at },
      );
      edge.validTo = now;
      return true;
    }
    case "deleteEdge": {
      const live = liveEdges(model);
      const edge = live[op.pick % Math.max(live.length, 1)];
      if (edge === undefined) return false;
      await store.edges[edge.relation].delete(edge.id as never);
      edge.deleted = true;
      return true;
    }
    case "endNode": {
      const open = [...model.nodes.values()].filter(
        (node) => node.kind !== "PrRoot" && node.validTo === undefined,
      );
      const node = open[op.pick % Math.max(open.length, 1)];
      if (node === undefined) return false;
      await (node.kind === "PrMid" ?
        store.nodes.PrMid.update(node.id as never, {}, { validTo: at })
      : store.nodes.PrLeaf.update(node.id as never, {}, { validTo: at }));
      node.validTo = now;
      return true;
    }
  }
}

type View = ReturnType<ModelStore["view"]>;

function pairKey(whole: string, part: string): string {
  return `${part}<${whole}`;
}

async function readPartPairs(
  view: View,
  kind: "PrRoot" | "PrMid",
  maxHops?: number,
): Promise<readonly string[]> {
  const rows = await view
    .query()
    .from(kind, "w")
    .parts("p", maxHops === undefined ? undefined : { maxHops })
    .select((ctx) => ({
      whole: keyOf({ kind, id: ctx.w.id }),
      part: `${ctx.p.kind}:${ctx.p.id}`,
    }))
    .execute();
  return rows.map((row) => pairKey(row.whole, row.part));
}

async function readWholePairs(
  view: View,
  kind: "PrMid" | "PrLeaf",
): Promise<readonly string[]> {
  const rows = await view
    .query()
    .from(kind, "p")
    .wholes("w")
    .select((ctx) => ({
      part: keyOf({ kind, id: ctx.p.id }),
      whole: `${ctx.w.kind}:${ctx.w.id}`,
    }))
    .execute();
  return rows.map((row) => pairKey(row.whole, row.part));
}

async function expectReadsMatchModel(
  view: View,
  model: Model,
  coordinate: Coordinate,
  context: string,
): Promise<void> {
  const label = `${context} @ ${coordinate.label}`;
  const roots = [...model.nodes.keys()].filter((key) =>
    key.startsWith("PrRoot:"),
  );
  const mids = [...model.nodes.keys()].filter((key) =>
    key.startsWith("PrMid:"),
  );
  const leaves = [...model.nodes.keys()].filter((key) =>
    key.startsWith("PrLeaf:"),
  );

  const expectedParts = (wholes: readonly string[], maxHops?: number) =>
    wholes
      .flatMap((whole) =>
        [...closure(model, whole, coordinate, maxHops).keys()].map((part) =>
          pairKey(whole, part),
        ),
      )
      .toSorted();
  const expectedWholes = (parts: readonly string[]) =>
    parts
      .flatMap((part) =>
        wholesOf(model, part, coordinate).map((whole) => pairKey(whole, part)),
      )
      .toSorted();

  const partsFromRoots = await readPartPairs(view, "PrRoot");
  const partsFromMids = await readPartPairs(view, "PrMid");
  expect(partsFromRoots.toSorted(), `${label}: parts() of roots`).toEqual(
    expectedParts(roots),
  );
  expect(partsFromMids.toSorted(), `${label}: parts() of mids`).toEqual(
    expectedParts(mids),
  );
  const directPartsFromRoots = await readPartPairs(view, "PrRoot", 1);
  expect(
    directPartsFromRoots.toSorted(),
    `${label}: parts({ maxHops: 1 }) of roots`,
  ).toEqual(expectedParts(roots, 1));

  const wholesFromMids = await readWholePairs(view, "PrMid");
  const wholesFromLeaves = await readWholePairs(view, "PrLeaf");
  expect(wholesFromMids.toSorted(), `${label}: wholes() of mids`).toEqual(
    expectedWholes(mids),
  );
  expect(wholesFromLeaves.toSorted(), `${label}: wholes() of leaves`).toEqual(
    expectedWholes(leaves),
  );

  // Duality on the reads alone: every (whole, part) pair parts() reports is
  // one wholes() reports, and the reverse.
  expect(
    [...partsFromRoots, ...partsFromMids].toSorted(),
    `${label}: p ∈ parts(w) ⇔ w ∈ wholes(p)`,
  ).toEqual([...wholesFromMids, ...wholesFromLeaves].toSorted());

  const bound = bindings(model, coordinate.instant);
  for (const root of roots) {
    const reached = closure(model, root, coordinate);
    const unit = await view.subgraph(
      { kind: "PrRoot", id: idOf(root) } as never,
      { edges: [], composition: true },
    );
    expect(
      unit.nodes
        .map((node) => keyOf(node))
        .filter((key) => key !== root)
        .toSorted(),
      `${label}: subgraph(${root}) nodes`,
    ).toEqual([...reached.keys()].toSorted());
    expect(
      unit.edges.map((edge) => edge.id).toSorted(),
      `${label}: subgraph(${root}) edges`,
    ).toEqual(
      bound
        .filter((edge) => reached.get(edge.part) === edge.whole)
        .map((edge) => edge.id)
        .toSorted(),
    );
  }
}

type Capture = Readonly<{
  instant: number;
  /** Whether this write ended a window, so its instant is a `<` / `<=` boundary. */
  endedWindow: boolean;
  /** How many soft-deletes the script had made when the plan was taken. */
  deletesSoFar: number;
  plans: ReadonlyMap<string, readonly string[]>;
}>;

async function runScenario(
  context: IntegrationTestContext,
  scenario: Scenario,
): Promise<void> {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    let now = CLOCK_START;
    vi.setSystemTime(now);
    const store = await context.createStore(
      buildGraph(scenario.top, scenario.sub),
    );
    const model: Model = {
      populations: { prMidOf: scenario.top, prHasLeaf: scenario.sub },
      nodes: new Map(),
      edges: [],
    };
    for (let index = 0; index < ROOT_COUNT; index += 1) {
      const node = await store.nodes.PrRoot.create({}, { id: `r${index}` });
      model.nodes.set(keyOf(node), {
        kind: "PrRoot",
        id: node.id,
        validTo: undefined,
      });
    }
    for (let index = 0; index < MID_COUNT; index += 1) {
      const node = await store.nodes.PrMid.create({}, { id: `m${index}` });
      model.nodes.set(keyOf(node), {
        kind: "PrMid",
        id: node.id,
        validTo: undefined,
      });
    }
    for (let index = 0; index < LEAF_COUNT; index += 1) {
      const node = await store.nodes.PrLeaf.create({}, { id: `l${index}` });
      model.nodes.set(keyOf(node), {
        kind: "PrLeaf",
        id: node.id,
        validTo: undefined,
      });
    }
    const roots = [...model.nodes.keys()].filter((key) =>
      key.startsWith("PrRoot:"),
    );

    const captures: Capture[] = [];
    let deletes = 0;
    for (const [step, op] of scenario.ops.entries()) {
      now += CLOCK_STEP_MS;
      vi.setSystemTime(now);
      const ran = await applyOp(store, model, op, now);
      if (!ran) continue;
      if (op.type === "deleteEdge") deletes += 1;
      const plans = new Map<string, readonly string[]>();
      for (const root of roots) {
        const plan = planPairs(await planOf(store, root));
        // The cascade owns every bound part, hidden or not.
        expect(plan, `step ${step} ${op.type}: planDelete(${root})`).toEqual(
          modelPairs(
            closure(model, root, { instant: now, nodeInstant: undefined }),
          ),
        );
        plans.set(root, plan);
      }
      captures.push({
        instant: now,
        endedWindow: op.type === "endEdge" || op.type === "endNode",
        deletesSoFar: deletes,
        plans,
      });
    }

    now += CLOCK_STEP_MS;
    vi.setSystemTime(now);
    const scriptLabel = `${scenario.top}/${scenario.sub} ${JSON.stringify(scenario.ops)}`;
    const modeCoordinates: readonly (Coordinate &
      Readonly<{ mode: "current" | "includeEnded" | "includeTombstones" }>)[] =
      [
        { label: "current", mode: "current", instant: now, nodeInstant: now },
        {
          label: "includeEnded",
          mode: "includeEnded",
          instant: now,
          nodeInstant: undefined,
        },
        {
          label: "includeTombstones",
          mode: "includeTombstones",
          instant: now,
          nodeInstant: undefined,
        },
      ];
    for (const coordinate of modeCoordinates) {
      await expectReadsMatchModel(
        store.view({ mode: coordinate.mode }),
        model,
        coordinate,
        scriptLabel,
      );
    }

    // Every instant a window ended at, plus sampled write instants (the
    // `validFrom` / `validTo` a write stamped) and the millisecond before
    // each: the boundaries where `<` versus `<=` decides.
    const instants = captures.flatMap((capture) => [
      capture.instant,
      capture.instant - 1,
    ]);
    const sampled = new Set([
      ...captures
        .filter((capture) => capture.endedWindow)
        .map((capture) => capture.instant),
      ...scenario.asOfPicks.flatMap((pick) => {
        const instant = instants[pick % Math.max(instants.length, 1)];
        return instant === undefined ? [] : [instant];
      }),
    ]);
    for (const instant of sampled) {
      const coordinate: Coordinate = {
        label: `asOf ${new Date(instant).toISOString()}`,
        instant,
        nodeInstant: instant,
      };
      const view = store.asOf(new Date(instant).toISOString());
      await expectReadsMatchModel(view, model, coordinate, scriptLabel);

      const capture = captures.find((entry) => entry.instant === instant);
      const everyNodeVisible = [...model.nodes.values()].every((node) =>
        nodeVisible(node, instant),
      );
      if (capture?.deletesSoFar !== deletes || !everyNodeVisible) continue;
      for (const root of roots) {
        const unit = await view.subgraph(
          { kind: "PrRoot", id: idOf(root) } as never,
          { edges: [], composition: true },
        );
        expect(
          unit.nodes
            .map((node) => keyOf(node))
            .filter((key) => key !== root)
            .toSorted(),
          `${scriptLabel} @ ${coordinate.label}: subgraph(${root}) vs the plan captured then`,
        ).toEqual(
          (capture.plans.get(root) ?? [])
            .map((pair) => pair.slice(0, pair.indexOf("<")))
            .toSorted(),
        );
      }
    }
  } finally {
    vi.useRealTimers();
  }
}

export function registerCompositionReadsModelIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Composition reads against a reference model (random forests)", () => {
    it("parts(), wholes(), subgraph({ composition }) and planDelete agree with the model at every sampled coordinate", async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArbitrary, async (scenario) => {
          await runScenario(context, scenario);
        }),
        { numRuns: propertyRuns({ ci: 16, local: 24 }) },
      );
    }, 120_000);
  });
}
