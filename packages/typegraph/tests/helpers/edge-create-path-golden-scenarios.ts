/**
 * THE EDGE-CREATE PATH GOLDEN.
 *
 * A second matrix over the write-shape golden's recorder and runner
 * (`write-shape-golden-scenarios.ts`, `write-shape-recorder.ts`): one
 * deterministic statement trace for every route by which the Store creates
 * ONE edge, so a later consolidation of those routes is judged against what
 * each of them runs today, statement by statement.
 *
 * The write-shape golden's cardinality shape declares a source-side `one`
 * only, so the target-side axis, a kind declaring both axes (which never
 * takes the fused one-claim insert: `ManagedEdgeCreatePlan.cardinalityClaims`
 * carries at most one claim on the bundled ports), `oneActive`, a durable
 * match identity WITH a cardinality, and an acyclic kind had no trace. This
 * matrix covers:
 *
 *  - store shapes: `link` declaring no cardinality; source `one`; target
 *    `one`; both; source `oneActive`; a durable match identity, without and
 *    with a source `one`; `acyclic`; and the composition shape, whose
 *    attachment edge is created inside a node create as well as directly;
 *  - receivers: the bundled root, `store.transaction`, the non-interactive
 *    root on the SQLite drivers (PGlite always runs interactive
 *    transactions), and two roots whose command port declines
 *    (`helpers/declining-command-port.ts`): one declines every
 *    `edge.create` that carries a cardinality claim, as a port without the
 *    fused claim insert does; the other declines `endpointPredicate` on
 *    every edge command, as a port that cannot take the endpoint lock in its
 *    statement does. Each declined dispatch appears in the trace as a
 *    `port … -> declined …` line between the statements around it, so the
 *    trace shows what the Store runs after a dispatch that ran nothing;
 *  - writes: a create on free axes (generated and supplied id), each
 *    endpoint refusal, each taken axis, a taken axis together with a dead
 *    endpoint (the precedence issue #946 is about), an occupied id, a row
 *    born ended (which owes no `oneActive` claim), a cycle on the acyclic
 *    kind, a duplicated durable identity, and the get-or-create create leg
 *    (endpoint match, `matchOn`, and over a dead endpoint with a taken axis)
 *    beside its found leg.
 *
 * Every trace runs against its own graph seeded like the write-shape golden:
 * `item-a -link-live-> item-b`, a tombstoned `item-c -link-dead-> item-a`, a
 * tombstoned `item-dead`. So `item-b -> item-c` is free on every axis and
 * closes no cycle, `item-a` holds the only taken source axis, `item-b` the
 * only taken target axis, and `item-b -> item-a` closes `item-a -> item-b`
 * into a cycle.
 *
 * Snapshots live in `tests/__snapshots__/edge-create-path-golden/<driver>/`.
 * Regenerate them from `packages/typegraph` with:
 *
 *     pnpm exec vitest run tests/edge-create-path-golden-*.test.ts -u
 */
import { createStoreWithSchema } from "../../src";
import {
  decline,
  decliningCommandBackend,
  type DispatchPolicy,
} from "./declining-command-port";
import {
  type CollectionWrite,
  COMPOSITION_ENTITY,
  compositionSurface,
  EDGE_ENTITY,
  type GoldenMatrix,
  type GraphTraits,
  ITEM_A,
  ITEM_B,
  ITEM_C,
  ITEM_DEAD,
  ITEM_MISSING,
  OTHER_A,
  OTHER_B,
  PLAIN_TRAITS,
  type Receiver,
  RECEIVERS,
  registerGoldenMatrixFile,
  type StoreShape,
  type WriteSurface,
} from "./write-shape-golden-scenarios";
import {
  WRITE_SHAPE_DRIVERS,
  type WriteShapeDriver,
} from "./write-shape-recorder";

const OTHER_MISSING = { kind: "Other", id: "other-missing" } as const;

function edgeShape(name: string, traits: Partial<GraphTraits>): StoreShape {
  return {
    name,
    traits: { ...PLAIN_TRAITS, ...traits },
    options: {},
    entities: EDGE_ENTITY,
  };
}

const EDGE_CREATE_SHAPES: readonly StoreShape[] = [
  edgeShape("unconstrained", {}),
  edgeShape("source-one", { edgeCardinality: "one" }),
  edgeShape("target-one", { edgeTargetCardinality: "one" }),
  edgeShape("both-axes", {
    edgeCardinality: "one",
    edgeTargetCardinality: "one",
  }),
  edgeShape("source-one-active", { edgeCardinality: "oneActive" }),
  edgeShape("match-identity", { edgeMatchIdentity: true }),
  edgeShape("match-identity-source-one", {
    edgeMatchIdentity: true,
    edgeCardinality: "one",
  }),
  edgeShape("acyclic", { edgeAcyclic: true }),
  {
    name: "composition",
    traits: { ...PLAIN_TRAITS, feature: "composition" },
    options: {},
    entities: COMPOSITION_ENTITY,
  },
];

function isAcyclic(shape: StoreShape): boolean {
  return shape.traits.edgeAcyclic;
}

function hasMatchIdentity(shape: StoreShape): boolean {
  return shape.traits.edgeMatchIdentity;
}

/** The get-or-create `matchOn` option is refused on a durable identity kind. */
function convergesDynamically(shape: StoreShape): boolean {
  return !shape.traits.edgeMatchIdentity;
}

const BORN_ENDED = {
  validFrom: "2019-01-01T00:00:00.000Z",
  validTo: "2019-06-01T00:00:00.000Z",
} as const;

function action(result: Readonly<{ action: string }>): string {
  return result.action;
}

const SINGLE_EDGE_WRITES: readonly CollectionWrite[] = [
  {
    name: "edge.create on free axes, generated id",
    run: (surface) =>
      surface.edges.link.create(ITEM_B, ITEM_C, { label: "fresh" }),
  },
  {
    name: "edge.create on free axes, supplied id",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_B,
        ITEM_C,
        { label: "fresh" },
        { id: "link-new" },
      ),
  },
  {
    name: "edge.create born ended on free axes",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_B,
        ITEM_C,
        { label: "ended" },
        { id: "link-ended", ...BORN_ENDED },
      ),
  },
  {
    name: "edge.create to a missing target",
    run: (surface) =>
      surface.edges.link.create(ITEM_B, ITEM_MISSING, { label: "missing" }),
  },
  {
    name: "edge.create to a tombstoned target",
    run: (surface) =>
      surface.edges.link.create(ITEM_B, ITEM_DEAD, { label: "tombstoned" }),
  },
  {
    name: "edge.create from a tombstoned source",
    run: (surface) =>
      surface.edges.link.create(ITEM_DEAD, ITEM_C, { label: "tombstoned" }),
  },
  {
    name: "edge.create on a taken source axis",
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_C, { label: "second" }),
  },
  {
    name: "edge.create on a taken target axis",
    run: (surface) =>
      surface.edges.link.create(ITEM_C, ITEM_B, { label: "second" }),
  },
  {
    name: "edge.create on both taken axes",
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_B, { label: "parallel" }),
  },
  {
    name: "edge.create on a taken source axis to a tombstoned target",
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_DEAD, { label: "both" }),
  },
  {
    name: "edge.create on a taken target axis from a tombstoned source",
    run: (surface) =>
      surface.edges.link.create(ITEM_DEAD, ITEM_B, { label: "both" }),
  },
  {
    name: "edge.create with an occupied id",
    run: (surface) =>
      surface.edges.link.create(
        ITEM_B,
        ITEM_C,
        { label: "fresh" },
        { id: "link-live" },
      ),
  },
  {
    name: "edge.create closing a cycle",
    appliesTo: isAcyclic,
    run: (surface) =>
      surface.edges.link.create(ITEM_B, ITEM_A, { label: "cycle" }),
  },
  {
    name: "edge.create duplicating a durable identity",
    appliesTo: hasMatchIdentity,
    run: (surface) =>
      surface.edges.link.create(ITEM_A, ITEM_B, { label: "live" }),
  },
  {
    name: "edge.getOrCreateByEndpoints created",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(ITEM_B, ITEM_C, { label: "fresh" })
        .then((result) => action(result)),
  },
  {
    name: "edge.getOrCreateByEndpoints found",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(ITEM_A, ITEM_B, { label: "live" })
        .then((result) => action(result)),
  },
  {
    name: "edge.getOrCreateByEndpoints matchOn label created",
    appliesTo: convergesDynamically,
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(
          ITEM_B,
          ITEM_C,
          { label: "fresh" },
          { matchOn: ["label"] },
        )
        .then((result) => action(result)),
  },
  {
    name: "edge.getOrCreateByEndpoints on a taken source axis to a tombstoned target",
    run: (surface) =>
      surface.edges.link
        .getOrCreateByEndpoints(ITEM_A, ITEM_DEAD, { label: "both" })
        .then((result) => action(result)),
  },
];

function memberOf(surface: WriteSurface) {
  return compositionSurface(surface).edges.memberOf;
}

/**
 * The composition shape: `item-c` is part of `other-a` through `member-c`,
 * `other-b` is an empty whole, and `item-b` is part of nothing.
 */
const COMPOSITION_CREATE_WRITES: readonly CollectionWrite[] = [
  {
    name: "node.create attached to a whole",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.create(
        { name: "part" },
        { id: "item-part", partOf: { whole: OTHER_A } },
      ),
  },
  {
    name: "node.create attached to a missing whole",
    run: (surface) =>
      compositionSurface(surface).nodes.Item.create(
        { name: "part" },
        { id: "item-part", partOf: { whole: OTHER_MISSING } },
      ),
  },
  {
    name: "edge.create attaching an unattached part",
    run: (surface) => memberOf(surface).create(ITEM_B, OTHER_B, {}),
  },
  {
    name: "edge.create attaching an attached part",
    run: (surface) => memberOf(surface).create(ITEM_C, OTHER_B, {}),
  },
  {
    name: "edge.create attaching a part to a missing whole",
    run: (surface) => memberOf(surface).create(ITEM_B, OTHER_MISSING, {}),
  },
  {
    name: "edge.create attaching an attached part to a missing whole",
    run: (surface) => memberOf(surface).create(ITEM_C, OTHER_MISSING, {}),
  },
];

function namedReceivers(...names: readonly string[]): readonly Receiver[] {
  return RECEIVERS.filter((receiver) => names.includes(receiver.name));
}

/**
 * A root whose command port follows `policy`, its dispatches annotated into
 * the trace. The seed rows go through an undecorated store over the same
 * database, so only the traced write meets the declining port.
 */
function decliningReceiver(name: string, policy: DispatchPolicy): Receiver {
  return {
    name,
    drivers: WRITE_SHAPE_DRIVERS,
    open: async (engine, graph, options) => {
      const [seedStore] = await createStoreWithSchema(
        graph,
        engine.root,
        options,
      );
      const declining = decliningCommandBackend(engine.root, policy, (line) => {
        engine.recorder.annotate(line);
      });
      const [store] = await createStoreWithSchema(
        graph,
        declining.backend,
        options,
      );
      return { seedStore, write: (run) => run(store), store };
    },
  };
}

/**
 * The receiver groups, one test file per (driver, group) so that no file
 * boots more PGlite databases than a minute affords:
 *
 *  - `root`: the bundled root, and the non-interactive root;
 *  - `transaction`: `store.transaction`;
 *  - `claim-declining-port`: a root whose port declines every
 *    `edge.create` that carries a cardinality claim (as a port without the
 *    fused claim insert does — the SQLite drivers' own port among them);
 *  - `endpoint-declining-port`: a root whose port declines
 *    `endpointPredicate` on every edge command.
 */
const RECEIVER_GROUPS = {
  root: namedReceivers("root", "non-interactive-root"),
  transaction: namedReceivers("transaction"),
  "claim-declining-port": [
    decliningReceiver("claim-declining-port", (command) =>
      (
        command.kind === "edge.create" &&
        (command.plan.cardinalityClaims?.length ?? 0) > 0
      ) ?
        decline("cardinalityClaim")
      : "pass",
    ),
  ],
  "endpoint-declining-port": [
    decliningReceiver("endpoint-declining-port", () =>
      decline("endpointPredicate"),
    ),
  ],
} as const satisfies Readonly<Record<string, readonly Receiver[]>>;

export type EdgeCreatePathReceiverGroup = keyof typeof RECEIVER_GROUPS;

function edgeCreatePathMatrix(
  group: EdgeCreatePathReceiverGroup,
): GoldenMatrix {
  return {
    title: `edge-create path golden (${group})`,
    snapshotDir: "edge-create-path-golden",
    shapes: EDGE_CREATE_SHAPES,
    receivers: RECEIVER_GROUPS[group],
    collectionWrites: (shape) =>
      shape.traits.feature === "composition" ?
        COMPOSITION_CREATE_WRITES
      : SINGLE_EDGE_WRITES,
    storeWrites: [],
    coverageSubject: "single-edge create method",
    requiredMethods: [
      "edge.create",
      "edge.getOrCreateByEndpoints",
      "node.create",
    ],
  };
}

/**
 * Registers one driver's edge-create path golden files for one receiver
 * group. The calling test file must mock `nanoid` with `traceIds`, as the
 * write-shape golden's do.
 */
export function registerEdgeCreatePathGoldenFile(
  driver: WriteShapeDriver,
  group: EdgeCreatePathReceiverGroup,
): void {
  registerGoldenMatrixFile(driver, edgeCreatePathMatrix(group));
}
