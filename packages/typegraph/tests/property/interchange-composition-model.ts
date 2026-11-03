/**
 * A composition + identity graph, a random history over it, and the readers
 * whose answers an interchange round trip must preserve.
 *
 * The graph declares every population/existence pairing a composition axis
 * can take — `one`/`oneActive` × `required`/optional — plus a reflexive
 * `oneActive` pair (so a history can refuse cycles), a non-composition edge
 * with ended windows, a `one` cardinality edge and a unique constraint. Every
 * kind draws ids from one small pool, so equal ids across kinds are the norm.
 *
 * Histories run on fixed past instants: node rows open at {@link BASE_INSTANT}
 * and step `n` acts at `instantAt(n)`, so reparents, ended windows and the
 * `asOf` coordinates the readers sample never depend on the wall clock.
 */
import fc from "fast-check";
import { expect } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  isTypeGraphError,
  partOf,
} from "../../src";
import { exportGraph, importGraph } from "../../src/interchange";
import type { Store } from "../../src/store/store";
import { compareStrings } from "../../src/utils/compare";
import { dumpRoundTripState, type RoundTripState } from "../state-snapshot";

const Whole = defineNode("RtWhole", { schema: z.object({ name: z.string() }) });
const PartOne = defineNode("RtPartOne", { schema: z.object({}) });
const PartActive = defineNode("RtPartActive", { schema: z.object({}) });
const PartOptional = defineNode("RtPartOptional", { schema: z.object({}) });
const PartLoose = defineNode("RtPartLoose", { schema: z.object({}) });
const Section = defineNode("RtSection", { schema: z.object({}) });

const partOneOf = defineEdge("rtPartOneOf", { schema: z.object({}) });
const partActiveOf = defineEdge("rtPartActiveOf", { schema: z.object({}) });
const partOptionalOf = defineEdge("rtPartOptionalOf", { schema: z.object({}) });
const partLooseOf = defineEdge("rtPartLooseOf", { schema: z.object({}) });
const sectionOf = defineEdge("rtSectionOf", { schema: z.object({}) });
const link = defineEdge("rtLink", { schema: z.object({ weight: z.number() }) });
const primary = defineEdge("rtPrimary", { schema: z.object({}) });

export function buildRoundTripGraph(
  options: Readonly<{ id: string; identity: boolean }>,
) {
  return defineGraph({
    id: options.id,
    nodes: {
      RtWhole: {
        type: Whole,
        onDelete: "cascade",
        unique: [
          {
            name: "rt_whole_name",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      RtPartOne: { type: PartOne },
      RtPartActive: { type: PartActive },
      RtPartOptional: { type: PartOptional },
      RtPartLoose: { type: PartLoose },
      RtSection: { type: Section },
    },
    edges: {
      rtPartOneOf: {
        type: partOneOf,
        from: [PartOne],
        to: [Whole],
        cardinality: "one",
      },
      rtPartActiveOf: {
        type: partActiveOf,
        from: [PartActive],
        to: [Whole],
        cardinality: "oneActive",
      },
      rtPartOptionalOf: {
        type: partOptionalOf,
        from: [PartOptional],
        to: [Whole],
        cardinality: "oneActive",
      },
      rtPartLooseOf: {
        type: partLooseOf,
        from: [PartLoose],
        to: [Whole],
        cardinality: "one",
      },
      rtSectionOf: {
        type: sectionOf,
        from: [Section],
        to: [Section],
        cardinality: "oneActive",
      },
      rtLink: { type: link, from: [Whole], to: [Whole] },
      rtPrimary: {
        type: primary,
        from: [Whole],
        to: [Whole],
        cardinality: "one",
      },
    },
    ontology: [
      partOf(PartOne, Whole, { via: partOneOf, existence: "required" }),
      partOf(PartActive, Whole, { via: partActiveOf, existence: "required" }),
      partOf(PartOptional, Whole, { via: partOptionalOf }),
      partOf(PartLoose, Whole, { via: partLooseOf }),
      partOf(Section, Section, { via: sectionOf, partSide: "from" }),
    ],
    ...(options.identity ? { identity: { sameIdAcrossKinds: "ignore" } } : {}),
  });
}

export type RoundTripGraph = ReturnType<typeof buildRoundTripGraph>;
export type RoundTripStore = Store<RoundTripGraph>;

export const WHOLE_KIND = "RtWhole";
export const SECTION_KIND = "RtSection";

/** Each part kind and the edge kind that binds it to its whole. */
export const PART_RELATIONS = [
  { part: "RtPartOne", via: "rtPartOneOf", whole: WHOLE_KIND },
  { part: "RtPartActive", via: "rtPartActiveOf", whole: WHOLE_KIND },
  { part: "RtPartOptional", via: "rtPartOptionalOf", whole: WHOLE_KIND },
  { part: "RtPartLoose", via: "rtPartLooseOf", whole: WHOLE_KIND },
  { part: SECTION_KIND, via: "rtSectionOf", whole: SECTION_KIND },
] as const;

type PartRelation = (typeof PART_RELATIONS)[number];
type CompositionEdgeKind = PartRelation["via"];

export const NODE_KINDS = [
  WHOLE_KIND,
  ...PART_RELATIONS.filter((relation) => relation.part !== SECTION_KIND).map(
    (relation) => relation.part,
  ),
  SECTION_KIND,
] as const;

export const ID_POOL = ["n0", "n1", "n2", "n3"] as const;
const NAME_POOL = ["alpha", "beta", "gamma"] as const;

export const BASE_INSTANT = "2019-01-01T00:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_STEP_MS = Date.parse("2020-01-01T00:00:00.000Z");

/** The instant step `step` of a history acts at: one day apart, all past. */
export function instantAt(step: number): string {
  return new Date(FIRST_STEP_MS + step * DAY_MS).toISOString();
}

/** Halfway between two steps: inside every window that spans the step. */
export function instantBetween(step: number): string {
  return new Date(FIRST_STEP_MS + step * DAY_MS + DAY_MS / 2).toISOString();
}

type NodeRef = Readonly<{ kind: string; id: string }>;

/**
 * One random step. A `pick` names the `pick % n`-th of the n live nodes of
 * the kind the step needs (sorted by id) at the moment it runs, so steps act
 * on nodes that exist and shrink toward the first one; ids a step CREATES are
 * drawn from {@link ID_POOL} instead, so a create can collide.
 */
export type HistoryOp =
  | Readonly<{ type: "createWhole"; id: string; name: string }>
  | Readonly<{ type: "createSection"; id: string }>
  | Readonly<{
      type: "createPart";
      relation: number;
      id: string;
      whole: number;
    }>
  | Readonly<{
      type: "reparent";
      relation: number;
      part: number;
      whole: number;
    }>
  | Readonly<{ type: "endAttachment"; relation: number; part: number }>
  | Readonly<{ type: "deleteAttachment"; relation: number; part: number }>
  | Readonly<{ type: "deleteNode"; kind: string; pick: number }>
  | Readonly<{
      type: "link";
      from: number;
      to: number;
      ended: boolean;
      primary: boolean;
    }>
  | Readonly<{ type: "deleteLink"; from: number }>
  | Readonly<{
      type: "assert";
      relation: "same" | "different";
      a: number;
      b: number;
    }>
  | Readonly<{ type: "retract"; a: number }>;

const idArb = fc.constantFrom(...ID_POOL);
const relationArb = fc.integer({ min: 0, max: PART_RELATIONS.length - 1 });
const pickArb = fc.nat({ max: 15 });

function historyOpArb(identity: boolean): fc.Arbitrary<HistoryOp> {
  const weighted = (
    weight: number,
    arbitrary: fc.Arbitrary<HistoryOp>,
  ): fc.WeightedArbitrary<HistoryOp> => ({ weight, arbitrary });
  return fc.oneof(
    weighted(
      1,
      fc.record({
        type: fc.constant("createWhole" as const),
        id: idArb,
        name: fc.constantFrom(...NAME_POOL),
      }),
    ),
    weighted(
      1,
      fc.record({ type: fc.constant("createSection" as const), id: idArb }),
    ),
    weighted(
      5,
      fc.record({
        type: fc.constant("createPart" as const),
        relation: relationArb,
        id: idArb,
        whole: pickArb,
      }),
    ),
    weighted(
      4,
      fc.record({
        type: fc.constant("reparent" as const),
        relation: relationArb,
        part: pickArb,
        whole: pickArb,
      }),
    ),
    weighted(
      2,
      fc.record({
        type: fc.constant("endAttachment" as const),
        relation: relationArb,
        part: pickArb,
      }),
    ),
    weighted(
      1,
      fc.record({
        type: fc.constant("deleteAttachment" as const),
        relation: relationArb,
        part: pickArb,
      }),
    ),
    weighted(
      1,
      fc.record({
        type: fc.constant("deleteNode" as const),
        kind: fc.constantFrom(...NODE_KINDS),
        pick: pickArb,
      }),
    ),
    weighted(
      2,
      fc.record({
        type: fc.constant("link" as const),
        from: pickArb,
        to: pickArb,
        ended: fc.boolean(),
        primary: fc.boolean(),
      }),
    ),
    weighted(
      1,
      fc.record({ type: fc.constant("deleteLink" as const), from: pickArb }),
    ),
    ...(identity ?
      [
        weighted(
          4,
          fc.record({
            type: fc.constant("assert" as const),
            relation: fc.constantFrom("same" as const, "different" as const),
            a: pickArb,
            b: pickArb,
          }),
        ),
        weighted(
          1,
          fc.record({ type: fc.constant("retract" as const), a: pickArb }),
        ),
      ]
    : []),
  );
}

/**
 * Wholes for most of the id pool first, then one or two unattached sections
 * as roots, so the random steps after them mostly act on nodes that exist.
 */
const seedArb: fc.Arbitrary<readonly HistoryOp[]> = fc
  .tuple(
    fc.subarray([...ID_POOL], { minLength: 2 }),
    fc.subarray([...ID_POOL], { minLength: 1, maxLength: 2 }),
  )
  .map(([wholeIds, sectionIds]) => [
    ...wholeIds.map((id, index): HistoryOp => ({
      type: "createWhole",
      id,
      name: NAME_POOL[index % NAME_POOL.length] ?? "alpha",
    })),
    ...sectionIds.map((id): HistoryOp => ({ type: "createSection", id })),
  ]);

export function historyArb(
  identity: boolean,
): fc.Arbitrary<readonly HistoryOp[]> {
  return fc
    .tuple(
      seedArb,
      fc.array(historyOpArb(identity), { minLength: 4, maxLength: 20 }),
    )
    .map(([seed, steps]) => [...seed, ...steps]);
}

export type HistoryOutcome = Readonly<{ applied: number; refused: number }>;

function relationAt(index: number): PartRelation {
  const relation = PART_RELATIONS[index];
  if (relation === undefined) throw new RangeError(`relation ${index}`);
  return relation;
}

/**
 * The untyped collection surface: the history picks kinds at random, so it
 * addresses collections by name rather than through the typed facade.
 */
type DynamicNodes = Record<
  string,
  Readonly<{
    create: (
      props: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    reparent: (
      id: string,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    delete: (id: string) => Promise<void>;
    find: () => Promise<readonly Readonly<{ id: string }>[]>;
    planDelete: (id: string) => Promise<unknown>;
  }>
>;
type DynamicEdges = Record<
  string,
  Readonly<{
    create: (
      from: NodeRef,
      to: NodeRef,
      props: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) => Promise<unknown>;
    update: (
      id: string,
      props: Record<string, unknown>,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    delete: (id: string) => Promise<void>;
    findFrom: (from: NodeRef) => Promise<readonly Readonly<{ id: string }>[]>;
  }>
>;

export function dynamicNodes(store: RoundTripStore): DynamicNodes {
  return store.nodes as unknown as DynamicNodes;
}

function dynamicEdges(store: RoundTripStore): DynamicEdges {
  return store.edges as unknown as DynamicEdges;
}

async function currentEdgeId(
  store: RoundTripStore,
  edgeKind: CompositionEdgeKind | "rtLink",
  from: NodeRef,
): Promise<string | undefined> {
  const edges = await dynamicEdges(store)[edgeKind]?.findFrom(from);
  return edges?.[0]?.id;
}

/** The live nodes of `kinds`, in a stable order for {@link HistoryOp} picks. */
async function liveNodes(
  store: RoundTripStore,
  kinds: readonly string[],
): Promise<readonly NodeRef[]> {
  const found: NodeRef[] = [];
  for (const kind of kinds) {
    const rows = await dynamicNodes(store)[kind]?.find();
    for (const row of rows ?? []) found.push({ kind, id: row.id });
  }
  return found.toSorted(
    (left, right) =>
      compareStrings(left.kind, right.kind) ||
      compareStrings(left.id, right.id),
  );
}

async function pickNode(
  store: RoundTripStore,
  kinds: readonly string[],
  pick: number,
): Promise<NodeRef | undefined> {
  const nodes = await liveNodes(store, kinds);
  return nodes.length === 0 ? undefined : nodes[pick % nodes.length];
}

async function applyOp(
  store: RoundTripStore,
  op: HistoryOp,
  step: number,
): Promise<void> {
  const nodes = dynamicNodes(store);
  const edges = dynamicEdges(store);
  const at = instantAt(step);
  switch (op.type) {
    case "createWhole": {
      await nodes[WHOLE_KIND]?.create(
        { name: op.name },
        { id: op.id, validFrom: BASE_INSTANT },
      );
      return;
    }
    case "createSection": {
      await nodes[SECTION_KIND]?.create(
        {},
        { id: op.id, validFrom: BASE_INSTANT },
      );
      return;
    }
    case "createPart": {
      const relation = relationAt(op.relation);
      const whole = await pickNode(store, [relation.whole], op.whole);
      if (whole === undefined) return;
      await nodes[relation.part]?.create(
        {},
        {
          id: op.id,
          validFrom: BASE_INSTANT,
          partOf: { whole, validFrom: at },
        },
      );
      return;
    }
    case "reparent": {
      const relation = relationAt(op.relation);
      const part = await pickNode(store, [relation.part], op.part);
      const whole = await pickNode(store, [relation.whole], op.whole);
      if (part === undefined || whole === undefined) return;
      await nodes[relation.part]?.reparent(part.id, { whole, at });
      return;
    }
    case "endAttachment":
    case "deleteAttachment": {
      const relation = relationAt(op.relation);
      const part = await pickNode(store, [relation.part], op.part);
      if (part === undefined) return;
      const edgeId = await currentEdgeId(store, relation.via, part);
      if (edgeId === undefined) return;
      await (op.type === "endAttachment" ?
        edges[relation.via]?.update(edgeId, {}, { validTo: at })
      : edges[relation.via]?.delete(edgeId));
      return;
    }
    case "deleteNode": {
      const node = await pickNode(store, [op.kind], op.pick);
      if (node !== undefined) await nodes[node.kind]?.delete(node.id);
      return;
    }
    case "link": {
      const from = await pickNode(store, [WHOLE_KIND], op.from);
      const to = await pickNode(store, [WHOLE_KIND], op.to);
      if (from === undefined || to === undefined) return;
      await (op.primary ?
        edges["rtPrimary"]?.create(from, to, {}, { validFrom: at })
      : edges["rtLink"]?.create(
          from,
          to,
          { weight: step },
          {
            validFrom: at,
            ...(op.ended ? { validTo: instantAt(step + 1) } : {}),
          },
        ));
      return;
    }
    case "deleteLink": {
      const from = await pickNode(store, [WHOLE_KIND], op.from);
      if (from === undefined) return;
      const edgeId = await currentEdgeId(store, "rtLink", from);
      if (edgeId !== undefined) await edges["rtLink"]?.delete(edgeId);
      return;
    }
    case "assert": {
      const a = await pickNode(store, NODE_KINDS, op.a);
      const b = await pickNode(store, NODE_KINDS, op.b);
      if (a === undefined || b === undefined) return;
      await (op.relation === "same" ?
        store.identity.assertSame(a as never, b as never)
      : store.identity.assertDifferent(a as never, b as never));
      return;
    }
    case "retract": {
      const node = await pickNode(store, NODE_KINDS, op.a);
      if (node === undefined) return;
      const [assertion] = await store.identity.assertionsOf(node as never);
      if (assertion !== undefined) {
        await store.identity.retractAssertion(assertion.id);
      }
      return;
    }
  }
}

/**
 * Runs a history, one fixed instant per step. A typed refusal is a legal
 * outcome of a random step (a second whole, a cycle, a contradiction) and is
 * counted; anything else is a defect and propagates.
 */
export async function applyHistory(
  store: RoundTripStore,
  history: readonly HistoryOp[],
): Promise<HistoryOutcome> {
  let applied = 0;
  let refused = 0;
  for (const [step, op] of history.entries()) {
    try {
      await applyOp(store, op, step);
      applied += 1;
    } catch (error) {
      if (!isTypeGraphError(error)) throw error;
      refused += 1;
    }
  }
  return { applied, refused };
}

function refLabel(node: NodeRef): string {
  return `${node.kind}:${node.id}`;
}

function sortedLabels(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings);
}

/**
 * What the composition readers answer at one valid-time coordinate:
 * `parts()` of every whole and section, `wholes()` of every part kind, and
 * `subgraph({ composition: true })` under each live whole.
 */
async function readCoordinate(
  store: RoundTripStore,
  asOf: string | undefined,
  roots: readonly NodeRef[],
): Promise<unknown> {
  const view = asOf === undefined ? store : store.asOf(asOf);
  const parts: string[] = [];
  for (const kind of [WHOLE_KIND, SECTION_KIND]) {
    const rows = await view
      .query()
      .from(kind as never, "w")
      .parts("p")
      .select((ctx) => ({
        whole: refLabel(ctx.w as NodeRef),
        part: refLabel(ctx.p as NodeRef),
      }))
      .execute();
    parts.push(...rows.map((row) => `${row.whole} > ${row.part}`));
  }
  const wholes: string[] = [];
  for (const kind of NODE_KINDS) {
    if (kind === WHOLE_KIND) continue;
    const rows = await view
      .query()
      .from(kind as never, "p")
      .wholes("w")
      .select((ctx) => ({
        part: refLabel(ctx.p as NodeRef),
        whole: refLabel(ctx.w as NodeRef),
      }))
      .execute();
    wholes.push(...rows.map((row) => `${row.part} < ${row.whole}`));
  }
  const units: Record<string, unknown> = {};
  for (const root of roots) {
    const unit = await view.subgraph(root as never, {
      edges: [],
      composition: true,
    });
    units[refLabel(root)] = {
      nodes: sortedLabels(unit.nodes.map((node) => refLabel(node))),
      edges: sortedLabels(unit.edges.map((edge) => edge.id)),
    };
  }
  return {
    parts: sortedLabels(parts),
    wholes: sortedLabels(wholes),
    units,
  };
}

/**
 * The cascade plan of every live whole and section now, and the composition
 * readers at `now` plus each sampled past coordinate — every answer a
 * consumer reads through the composition surface.
 */
export async function readCompositionAnswers(
  store: RoundTripStore,
  coordinates: readonly string[],
): Promise<unknown> {
  const roots: NodeRef[] = [];
  const plans: Record<string, unknown> = {};
  for (const kind of [WHOLE_KIND, SECTION_KIND]) {
    for (const id of ID_POOL) {
      const answer = await planDeleteAnswer(store, kind, id);
      if (answer === undefined) continue;
      roots.push({ kind, id });
      plans[`${kind}:${id}`] = answer;
    }
  }
  const reads: Record<string, unknown> = {
    now: await readCoordinate(store, undefined, roots),
  };
  for (const coordinate of coordinates) {
    reads[coordinate] = await readCoordinate(store, coordinate, roots);
  }
  return { plans, reads };
}

/** The node's delete plan, or the code a refused plan names; `undefined` when absent. */
async function planDeleteAnswer(
  store: RoundTripStore,
  kind: string,
  id: string,
): Promise<unknown> {
  try {
    const plan = await dynamicNodes(store)[kind]?.planDelete(id);
    return plan === undefined ? undefined : normalizePlan(plan);
  } catch (error) {
    if (!isTypeGraphError(error)) throw error;
    return { refused: error.code };
  }
}

function normalizePlan(plan: unknown): unknown {
  const { cascadedParts, removedEdgeIds } = plan as Readonly<{
    cascadedParts: readonly Readonly<{
      kind: string;
      id: string;
      whole: NodeRef;
      viaEdgeKind: string;
    }>[];
    removedEdgeIds: readonly string[];
  }>;
  return {
    cascadedParts: sortedLabels(
      cascadedParts.map(
        (part) =>
          `${refLabel(part)} < ${refLabel(part.whole)} via ${part.viaEdgeKind}`,
      ),
    ),
    removedEdgeIds: sortedLabels(removedEdgeIds),
  };
}

/** Valid-time coordinates worth reading after a history of `steps` steps. */
export function sampleCoordinates(steps: number): readonly string[] {
  const picks = new Set<number>([0, Math.floor(steps / 2), steps - 1]);
  return [...picks].flatMap((step) =>
    step < 0 ? [] : [instantAt(step), instantBetween(step)],
  );
}

/**
 * The slice of a store an interchange document carries: the live graph — no
 * tombstoned row, and no identity assertion naming one (an archival export
 * omits those too).
 */
export function liveSlice(state: RoundTripState): RoundTripState {
  const liveNodes = new Set(
    state.nodes
      .filter((node) => !node.deleted)
      .map((node) => `${node.kind}:${node.id}`),
  );
  return {
    ...state,
    nodes: state.nodes.filter((node) => !node.deleted),
    edges: state.edges.filter((edge) => !edge.deleted),
    identity: {
      ...state.identity,
      assertions: state.identity.assertions.filter(
        (assertion) => liveNodes.has(assertion.a) && liveNodes.has(assertion.b),
      ),
    },
  };
}

/** Runs one round trip and checks every agreement; returns the source's outcome. */
export async function checkRoundTrip(
  history: readonly HistoryOp[],
  options: Readonly<{
    identity: boolean;
    createStore: (identity: boolean) => Promise<RoundTripStore>;
  }>,
): Promise<HistoryOutcome> {
  const source = await options.createStore(options.identity);
  const outcome = await applyHistory(source, history);
  const document = await exportGraph(
    source,
    options.identity ? { identityMode: "archival" } : {},
  );

  const target = await options.createStore(options.identity);
  const result = await importGraph(target, document, { onConflict: "error" });
  expect(result.errors).toEqual([]);

  expect(
    liveSlice(await dumpRoundTripState(target, { transitions: "restored" })),
  ).toEqual(
    liveSlice(await dumpRoundTripState(source, { transitions: "all" })),
  );

  const coordinates = sampleCoordinates(history.length);
  expect(await readCompositionAnswers(target, coordinates)).toEqual(
    await readCompositionAnswers(source, coordinates),
  );
  expect(await target.verifyConstraintFences()).toEqual([]);
  return outcome;
}
