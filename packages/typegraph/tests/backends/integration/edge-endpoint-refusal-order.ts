/**
 * Which refusal wins when an edge write meets a non-live endpoint AND a
 * taken cardinality axis at once, on every edge write path (issue #946).
 *
 * The ruling: the endpoint check wins, on every backend, in a transaction and
 * outside one. A cardinality answer is about a relation the write is not
 * allowed to join, so it must never be given about an edge one of whose
 * endpoints is not live.
 *
 * Each kind below declares one constrained axis (or both, or one with a
 * durable match identity), so every axis this library has — source `one`,
 * `oneActive`, `unique`, target `one`, `oneActive` — and every create shape
 * (the fused one-claim insert, the portable two-claim path, the durable
 * identity command) is met. Each axis is taken twice over:
 *
 *  - `live holder`: the incumbent holds the axis on the write's LIVE
 *    endpoint, and the write's other endpoint is tombstoned;
 *  - `dead holder`: the incumbent holds the axis on the write's TOMBSTONED
 *    endpoint — the issue's own reproduction. No Store write links to a
 *    tombstoned node, so the incumbent is written by an import with
 *    `validateReferences: false`, which does not read its endpoints.
 *
 * Every Store write path runs at the root and inside `store.transaction()`
 * with the error caught and the transaction left to commit; import runs at
 * the root (it is one write transaction of its own and takes no transaction
 * receiver). Each case asserts the refusal, that no edge or claim row was
 * added or removed, and inside a transaction that the commit succeeded and
 * kept the transaction's other work.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  CardinalityError,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import {
  CASE_RECEIVERS,
  type CaseReceiver,
  nextEdgeCreatePathGraphId,
  readEdgeCreatePathState,
} from "./edge-create-path-fixture";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const EDGE_PROPS = z.object({ label: z.string() });

const EoItem = defineNode("EoItem", { schema: z.object({}) });

const LABEL_IDENTITY = { name: "eo-label", fields: ["label"] } as const;

const eoSource = defineEdge("eoSource", { schema: EDGE_PROPS });
const eoSourceActive = defineEdge("eoSourceActive", { schema: EDGE_PROPS });
const eoSourceUnique = defineEdge("eoSourceUnique", { schema: EDGE_PROPS });
const eoTarget = defineEdge("eoTarget", { schema: EDGE_PROPS });
const eoTargetActive = defineEdge("eoTargetActive", { schema: EDGE_PROPS });
const eoBoth = defineEdge("eoBoth", { schema: EDGE_PROPS });
const eoIdSource = defineEdge("eoIdSource", { schema: EDGE_PROPS });
const eoIdTarget = defineEdge("eoIdTarget", { schema: EDGE_PROPS });

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: { EoItem: { type: EoItem } },
    edges: {
      eoSource: {
        type: eoSource,
        from: [EoItem],
        to: [EoItem],
        cardinality: "one",
      },
      eoSourceActive: {
        type: eoSourceActive,
        from: [EoItem],
        to: [EoItem],
        cardinality: "oneActive",
      },
      eoSourceUnique: {
        type: eoSourceUnique,
        from: [EoItem],
        to: [EoItem],
        cardinality: "unique",
      },
      eoTarget: {
        type: eoTarget,
        from: [EoItem],
        to: [EoItem],
        targetCardinality: "one",
      },
      eoTargetActive: {
        type: eoTargetActive,
        from: [EoItem],
        to: [EoItem],
        targetCardinality: "oneActive",
      },
      eoBoth: {
        type: eoBoth,
        from: [EoItem],
        to: [EoItem],
        cardinality: "one",
        targetCardinality: "one",
      },
      eoIdSource: {
        type: eoIdSource,
        from: [EoItem],
        to: [EoItem],
        cardinality: "one",
        matchIdentity: LABEL_IDENTITY,
      },
      eoIdTarget: {
        type: eoIdTarget,
        from: [EoItem],
        to: [EoItem],
        targetCardinality: "one",
        matchIdentity: LABEL_IDENTITY,
      },
    },
  });
}

type OrderGraph = ReturnType<typeof buildGraph>;
type OrderStore = InspectableStore<OrderGraph>;
type OrderSurface = Pick<OrderStore, "getEdgeCollectionOrThrow">;
type OrderEdgeKind = Extract<keyof OrderGraph["edges"], string>;

type Endpoint = Readonly<{ kind: "EoItem"; id: string }>;

function item(id: string): Endpoint {
  return { kind: "EoItem", id };
}

/** Live a, b, c; `f` tombstoned. */
const LIVE_NODE_IDS = ["a", "b", "c"] as const;
const DEAD = item("f");

type Holder = "live holder" | "dead holder";

/**
 * One taken axis: the incumbent `inc` and the write that meets both it and
 * the tombstoned `f`. The incumbent's label differs from the write's, so a
 * durable identity never matches and a get-or-create on `label` finds
 * nothing.
 */
type OrderScenario = Readonly<{
  kind: OrderEdgeKind;
  holder: Holder;
  incumbent: Readonly<{ from: Endpoint; to: Endpoint }>;
  write: Readonly<{ from: Endpoint; to: Endpoint }>;
}>;

const SOURCE_AXIS_KINDS = [
  "eoSource",
  "eoSourceActive",
  "eoBoth",
  "eoIdSource",
] as const satisfies readonly OrderEdgeKind[];

const TARGET_AXIS_KINDS = [
  "eoTarget",
  "eoTargetActive",
  "eoBoth",
  "eoIdTarget",
] as const satisfies readonly OrderEdgeKind[];

const SCENARIOS: readonly OrderScenario[] = [
  ...SOURCE_AXIS_KINDS.flatMap((kind): OrderScenario[] => [
    {
      kind,
      holder: "live holder",
      incumbent: { from: item("a"), to: item("b") },
      write: { from: item("a"), to: DEAD },
    },
    {
      kind,
      holder: "dead holder",
      incumbent: { from: DEAD, to: item("b") },
      write: { from: DEAD, to: item("c") },
    },
  ]),
  // `unique` bounds the (from, to) pair, so its holder is both endpoints.
  {
    kind: "eoSourceUnique",
    holder: "dead holder",
    incumbent: { from: item("a"), to: DEAD },
    write: { from: item("a"), to: DEAD },
  },
  ...TARGET_AXIS_KINDS.flatMap((kind): OrderScenario[] => [
    {
      kind,
      holder: "live holder",
      incumbent: { from: item("a"), to: item("b") },
      write: { from: DEAD, to: item("b") },
    },
    {
      kind,
      holder: "dead holder",
      incumbent: { from: item("a"), to: DEAD },
      write: { from: item("c"), to: DEAD },
    },
  ]),
];

const INCUMBENT_ID = "inc";
const WRITE_ID = "new";
const WRITE_PROPS = { label: "new" } as const;
const SENTINEL_ID = "sentinel";

async function seedScenario(
  store: OrderStore,
  scenario: OrderScenario,
): Promise<void> {
  for (const id of [...LIVE_NODE_IDS, DEAD.id]) {
    await store.nodes.EoItem.create({}, { id });
  }
  await store.nodes.EoItem.delete(asNodeId<typeof EoItem>(DEAD.id));
  const result = await importGraph(
    store,
    {
      formatVersion: FORMAT_VERSION,
      exportedAt: "2026-01-01T00:00:00.000Z",
      source: { type: "external", description: "an incumbent axis holder" },
      nodes: [],
      edges: [
        {
          kind: scenario.kind,
          id: INCUMBENT_ID,
          from: scenario.incumbent.from,
          to: scenario.incumbent.to,
          properties: { label: "inc" },
        },
      ],
    },
    {
      onConflict: "error",
      onUnknownProperty: "error",
      validateReferences: false,
      batchSize: 100,
      refreshStatistics: false,
    },
  );
  expect(result.errors).toEqual([]);
  expect(result.edges.created).toBe(1);
}

/** Every edge write path that can create an edge, as a Store surface call. */
const STORE_PATHS = {
  create: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .create(write.from, write.to, WRITE_PROPS, { id: WRITE_ID }),
  bulkCreate: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .bulkCreate([{ ...write, props: WRITE_PROPS, id: WRITE_ID }]),
  bulkInsert: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .bulkInsert([{ ...write, props: WRITE_PROPS, id: WRITE_ID }]),
  bulkUpsertById: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .bulkUpsertById([{ ...write, props: WRITE_PROPS, id: WRITE_ID }]),
  getOrCreateByEndpoints: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .getOrCreateByEndpoints(write.from, write.to, WRITE_PROPS, {
        matchOn: ["label"],
      }),
  bulkGetOrCreateByEndpoints: (surface, { kind, write }) =>
    surface
      .getEdgeCollectionOrThrow(kind)
      .bulkGetOrCreateByEndpoints([{ ...write, props: WRITE_PROPS }], {
        matchOn: ["label"],
      }),
} as const satisfies Record<
  string,
  (surface: OrderSurface, scenario: OrderScenario) => Promise<unknown>
>;

type StorePath = keyof typeof STORE_PATHS;

/** Every path in {@link STORE_PATHS}, read off the table so none is skipped. */
const STORE_PATH_NAMES = Object.keys(STORE_PATHS).filter(
  (name): name is StorePath => Object.hasOwn(STORE_PATHS, name),
);

const ENDPOINT = "EndpointNotFoundError";

/** A refusal as the case compares it: its class, and a cardinality's axis. */
async function settle(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "ok";
  } catch (error: unknown) {
    if (error instanceof CardinalityError) {
      return `CardinalityError ${error.details.direction}`;
    }
    return error instanceof Error ? error.constructor.name : String(error);
  }
}

/** An import row refusal, rendered as the Store refusal it reports. */
function importRefusal(message: string): string {
  if (/^(From|To) node not found: /u.test(message)) return ENDPOINT;
  if (/cardinality/iu.test(message)) return "CardinalityError";
  return message;
}

function scenarioKey(scenario: OrderScenario): string {
  return `${scenario.kind} ${scenario.holder} ${scenario.write.from.id}->${scenario.write.to.id}`;
}

async function settleStorePath(
  store: OrderStore,
  receiver: CaseReceiver,
  path: StorePath,
  scenario: OrderScenario,
): Promise<Readonly<{ error: string; commit?: string; sentinel?: boolean }>> {
  const write = STORE_PATHS[path];
  if (receiver === "root") {
    return { error: await settle(() => write(store, scenario)) };
  }
  let error = "not reached";
  const commit = await settle(() =>
    store.transaction(async (tx) => {
      await tx.nodes.EoItem.create({}, { id: SENTINEL_ID });
      error = await settle(() => write(tx, scenario));
    }),
  );
  const sentinel =
    (await store.nodes.EoItem.getById(asNodeId<typeof EoItem>(SENTINEL_ID))) !==
    undefined;
  return { error, commit, sentinel };
}

/** A fresh graph holding `scenario`'s nodes and incumbent. */
async function openScenario(
  context: IntegrationTestContext,
  scenario: OrderScenario,
): Promise<Readonly<{ store: OrderStore; graphId: string }>> {
  const graphId = nextEdgeCreatePathGraphId("edge_endpoint_order");
  const store = await context.createStore(buildGraph(graphId));
  await seedScenario(store, scenario);
  return { store, graphId };
}

export function registerEdgeEndpointRefusalOrderIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge write onto a non-live endpoint with a taken axis (#946)", () => {
    describe.each(CASE_RECEIVERS)("%s", (receiver) => {
      describe.each(STORE_PATH_NAMES)("%s", (path) => {
        it.for(
          SCENARIOS.map(
            (scenario) => [scenarioKey(scenario), scenario] as const,
          ),
        )("%s", async ([, scenario]) => {
          const { store, graphId } = await openScenario(context, scenario);
          const lane = context.getBackend();
          const before = await readEdgeCreatePathState(lane, graphId);
          const outcome = await settleStorePath(
            store,
            receiver,
            path,
            scenario,
          );
          const after = await readEdgeCreatePathState(lane, graphId);
          expect({ ...outcome, state: after }).toEqual({
            error: ENDPOINT,
            ...(receiver === "transaction" ?
              { commit: "ok", sentinel: true }
            : {}),
            state: before,
          });
        });
      });
    });

    describe("root", () => {
      describe("importGraph", () => {
        it.for(
          SCENARIOS.map(
            (scenario) => [scenarioKey(scenario), scenario] as const,
          ),
        )("%s", async ([, scenario]) => {
          const { store, graphId } = await openScenario(context, scenario);
          const lane = context.getBackend();
          const before = await readEdgeCreatePathState(lane, graphId);
          const result = await importGraph(
            store,
            {
              formatVersion: FORMAT_VERSION,
              exportedAt: "2026-01-01T00:00:00.000Z",
              source: { type: "external", description: "the write" },
              nodes: [],
              edges: [
                {
                  kind: scenario.kind,
                  id: WRITE_ID,
                  from: scenario.write.from,
                  to: scenario.write.to,
                  properties: WRITE_PROPS,
                },
              ],
            },
            {
              onConflict: "error",
              onUnknownProperty: "error",
              validateReferences: true,
              batchSize: 100,
              refreshStatistics: false,
            },
          );
          const after = await readEdgeCreatePathState(lane, graphId);
          expect({
            errors: result.errors.map((error) => importRefusal(error.error)),
            created: result.edges.created,
            state: after,
          }).toEqual({ errors: [ENDPOINT], created: 0, state: before });
        });
      });
    });
  });
}
