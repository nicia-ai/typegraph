/**
 * The edge-create decline harness, on every backend.
 *
 * A command port may answer `unsupported` for any dimension of `edge.create`
 * (`cardinalityClaim`, `endpointPredicate`, `schemaFence`) and of
 * `edge.converge-create` (`convergence`, `endpointPredicate`) without
 * executing any SQL, and the Store must then reach a correct outcome some
 * other way. Each case decorates the lane's command port with
 * `decliningCommandBackend` (`tests/helpers/declining-command-port.ts`, built
 * with `deriveBackend`), scripted per command kind: decline these dimensions,
 * pass to the lane's port, or plant rows on the dispatch's session first.
 *
 * Every case asserts:
 *
 *  - the dispatch log: each edge command the Store sent, on which session,
 *    with how many cardinality claims, whether it carried a schema fence, its
 *    match kind, and what answered it — plus any scripted step no dispatch
 *    consumed. A declined dispatch is answered by the decorator and never
 *    reaches the lane's port, so the port ran no SQL for it: "no SQL" is
 *    measured at the port, per dispatch. The statements around a declined
 *    dispatch are the edge-create path golden's declining receivers
 *    (`tests/edge-create-path-golden-*-declining.test.ts`);
 *  - the typed result or error;
 *  - the complete edge and claim state the graph holds afterwards, read from
 *    outside through the lane's own backend.
 *
 * Each case runs at the root and inside `store.transaction()` with the error
 * caught and the transaction left to commit. The decorated backend is a
 * derived root, so the bundled-root autocommit path is out of this harness's
 * reach: every root dispatch below runs on a store-opened transaction.
 *
 * The dispatch log is an ordinary assertion on every lane. Outcomes that
 * leave a refused create's rows behind, or that make the winning error
 * depend on which dimension a port declined, are known defects: the case
 * states the correct outcome and, with the design note's label (`D2`, `D3`,
 * `D6`), the exact outcome main produces today on the lanes it affects
 * (`tests/helpers/known-defect.ts`).
 */
import { describe, expect, it } from "vitest";

import { createStoreWithSchema } from "../../../src";
import {
  type ClaimEdgeCardinalityParams,
  type EdgeCreateCommand,
  type GraphBackend,
  type InsertEdgeParams,
  type TransactionBackend,
} from "../../../src/backend/types";
import { type SqlDialect } from "../../../src/query/dialect/types";
import { serializeSchema } from "../../../src/schema/serializer";
import { requireDefined } from "../../../src/utils/presence";
import {
  decline,
  decliningCommandBackend,
  type DispatchScript,
  scriptedPolicy,
} from "../../helpers/declining-command-port";
import {
  buildEdgeCreatePathGraph,
  CASE_RECEIVERS,
  caseLane,
  type CaseReceiver,
  type CreateDefect,
  type EdgeCreatePathDelta,
  type EdgeCreatePathSurface,
  expectCreateOutcome,
  type ExpectedCreate,
  ITEM,
  nextEdgeCreatePathGraphId,
  observeCreate,
  readEdgeCreatePathState,
  seedEdgeCreatePathGraph,
} from "./edge-create-path-fixture";
import { type IntegrationTestContext } from "./test-context";

const ENDPOINT = "EndpointNotFoundError[ENDPOINT_NOT_FOUND]";
const DURABLE_COMMAND_REFUSED = "ConfigurationError[CONFIGURATION_ERROR]";
/**
 * The schema write fence's refusal of a stale store. (`SchemaChangedError`
 * is the checked-read refusal; no write path raises it.)
 */
const STALE_SCHEMA = "StaleVersionError[STALE_SCHEMA_VERSION]";

/** A cardinality refusal on `direction`, naming `incumbent` as the holder. */
function cardinality(
  direction: "source" | "target",
  incumbent: string,
): string {
  return `CardinalityError[CARDINALITY_ERROR] ${direction} incumbent=${incumbent}`;
}

/** The created `mxSource` c->d `new` and its source claim. */
const SOURCE_EDGE_NEW: EdgeCreatePathDelta = {
  edges: ["mxSource:new c->d live"],
  claims: ['one:mxSource ["MxItem","c"] -> new'],
};

/**
 * One line of a dispatch log. Every root write through the decorated
 * (derived) root runs in a store-opened transaction, so every dispatch below
 * names the transaction session.
 */
function create(claims: number, answer: string, fence = ""): string {
  return `port transaction edge.create claims=${claims}${fence} -> ${answer}`;
}

function converge(
  match: "dynamic" | "durable",
  answer: string,
  fence = "",
): string {
  return `port transaction edge.converge-create claims=0${fence} match=${match} -> ${answer}`;
}

/**
 * A root write fuses the schema fence into its first statement where the
 * plan allows (an unconstrained or a durable create); inside a caller's
 * transaction the fence is already held, so no plan carries one.
 */
function fusedFence(receiver: CaseReceiver): string {
  return receiver === "root" ? " +schemaFence" : "";
}

/**
 * D2: the session's claim-then-retry continuation issues the claim before
 * the retry finds the endpoint dead, so with the error caught inside
 * `store.transaction` the claim commits — on every lane once a port declines
 * the claim, not only on SQLite.
 */
const D2_CLAIM_RESIDUE: CreateDefect = {
  label: "D2",
  on: { receiver: ["transaction"] },
  today: {
    error: ENDPOINT,
    added: { edges: [], claims: ['one:mxSource ["MxItem","c"] -> new'] },
  },
};

/**
 * D3: with a dead endpoint and a taken axis, declining `cardinalityClaim`
 * makes the claim refuse first, while declining `endpointPredicate` reports
 * the endpoint: the precedence follows the port's support, on every lane.
 */
const D3_PORT_DECIDES_PRECEDENCE: CreateDefect = {
  label: "D3",
  on: {},
  today: { error: cardinality("source", "s-ab") },
};

/**
 * Plants, on the dispatch's own session, a live `mxIdentitySource` edge
 * `intruder` c->a with its source claim: a writer that bypassed the graph
 * fence after the Store's cardinality probe passed, which is the one state
 * in which the durable create's post-row claim is refused.
 */
async function plantSourceClaimHolder(
  backend: GraphBackend | TransactionBackend,
  graphId: string,
): Promise<void> {
  const params: InsertEdgeParams = {
    graphId,
    id: "intruder",
    kind: "mxIdentitySource",
    fromKind: "MxItem",
    fromId: ITEM.c.id,
    toKind: "MxItem",
    toId: ITEM.a.id,
    props: { label: "intruder" },
  };
  await backend.insertEdge(params);
  const outcome = await requireDefined(backend.claimEdgeCardinality)({
    graphId,
    direction: "source",
    cardinality: "one",
    edgeKind: params.kind,
    edgeId: params.id,
    fromKind: params.fromKind,
    fromId: params.fromId,
    toKind: params.toKind,
    toId: params.toId,
  });
  if (outcome.status !== "claimed") {
    throw new Error(`planting the intruder's claim was ${outcome.status}`);
  }
}

/** What the plant leaves when the transaction that ran it commits. */
const INTRUDER: EdgeCreatePathDelta = {
  edges: ["mxIdentitySource:intruder c->a live"],
  claims: ['one:mxIdentitySource ["MxItem","c"] -> intruder'],
};

/**
 * D6: a durable create claims its cardinality only after the converge
 * command wrote its row. When that claim is refused and the caller catches
 * the error inside `store.transaction`, the row commits without its claim,
 * beside the plant.
 */
const D6_ROW_BEFORE_CLAIM: CreateDefect = {
  label: "D6",
  on: { receiver: ["transaction"] },
  today: {
    error: cardinality("source", "intruder"),
    added: {
      edges: [...INTRUDER.edges, "mxIdentitySource:new c->d live"],
      claims: INTRUDER.claims,
    },
  },
};

type PerDialect<T> = Readonly<{ sqlite: T; postgres: T }>;
type PerReceiver<T> = Readonly<{ root: T; transaction: T }>;

type DeclineCase = Readonly<{
  name: string;
  script: (graphId: string) => DispatchScript;
  /**
   * Runs after the declining store is built and before the create: the
   * stale-store case commits a newer schema version behind its back here.
   */
  prepare?: (context: IntegrationTestContext, graphId: string) => Promise<void>;
  run: (surface: EdgeCreatePathSurface) => Promise<unknown>;
  /** The outcome the Store should reach, on every receiver or per receiver. */
  correct: ExpectedCreate | PerReceiver<ExpectedCreate>;
  /**
   * The dispatch log on every lane, or per dialect where they differ, given
   * the schema-fence marker a root plan carries ({@link fusedFence}).
   */
  dispatches: (
    fence: string,
    receiver: CaseReceiver,
  ) => readonly string[] | PerDialect<readonly string[]>;
  /** Scripted steps the Store never gave a dispatch to consume. */
  unconsumed?: (
    receiver: CaseReceiver,
  ) => readonly string[] | PerDialect<readonly string[]>;
  defects?: readonly CreateDefect[];
}>;

function createSource(
  from: (typeof ITEM)[keyof typeof ITEM],
  to: (typeof ITEM)[keyof typeof ITEM],
) {
  return (surface: EdgeCreatePathSurface) =>
    surface.edges.mxSource.create(from, to, { label: "x" }, { id: "new" });
}

/**
 * Commits the next schema version of `graphId` straight to the lane, so a
 * store built before it is stale: its next write must fail on the schema
 * fence and leave nothing behind.
 */
async function commitNewerSchemaVersion(
  context: IntegrationTestContext,
  graphId: string,
): Promise<void> {
  const lane = context.getBackend();
  const active = requireDefined(await lane.getActiveSchema(graphId));
  const next = active.version + 1;
  await lane.commitSchemaVersion({
    graphId,
    expected: { kind: "active", version: active.version },
    version: next,
    schemaHash: `edge-create-decline-stale-${next}`,
    schemaDoc: serializeSchema(buildEdgeCreatePathGraph(graphId), next),
  });
}

const DECLINE_CASES: readonly DeclineCase[] = [
  {
    name: "one axis, cardinalityClaim declined: the session claims, then retries without the claim",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.c, ITEM.d),
    correct: { error: "ok", added: SOURCE_EDGE_NEW },
    dispatches: () => [
      create(1, "declined cardinalityClaim"),
      create(0, "created"),
    ],
  },
  {
    name: "one axis, cardinalityClaim declined, and then the claim-free retry declined endpointPredicate",
    script: () => ({
      "edge.create": [
        decline("cardinalityClaim"),
        decline("endpointPredicate"),
      ],
    }),
    run: createSource(ITEM.c, ITEM.d),
    correct: { error: "ok", added: SOURCE_EDGE_NEW },
    dispatches: () => [
      create(1, "declined cardinalityClaim"),
      create(0, "declined endpointPredicate"),
    ],
  },
  {
    name: "one axis, cardinalityClaim declined, dead target on a free axis",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.c, ITEM.dead),
    correct: { error: ENDPOINT },
    dispatches: () => [
      create(1, "declined cardinalityClaim"),
      create(0, "rejected"),
    ],
    defects: [D2_CLAIM_RESIDUE],
  },
  {
    name: "one axis, cardinalityClaim declined, dead target on a taken source axis",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.a, ITEM.dead),
    correct: { error: ENDPOINT },
    dispatches: () => [create(1, "declined cardinalityClaim")],
    defects: [D3_PORT_DECIDES_PRECEDENCE],
  },
  {
    name: "one axis, endpointPredicate declined, free axis",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: createSource(ITEM.c, ITEM.d),
    correct: { error: "ok", added: SOURCE_EDGE_NEW },
    dispatches: () => [create(1, "declined endpointPredicate")],
  },
  {
    name: "one axis, endpointPredicate declined, dead target on a taken source axis",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: createSource(ITEM.a, ITEM.dead),
    correct: { error: ENDPOINT },
    dispatches: () => [create(1, "declined endpointPredicate")],
  },
  {
    name: "one axis, schemaFence declined although the plan carries no schema fence",
    script: () => ({ "edge.create": [decline("schemaFence")] }),
    run: createSource(ITEM.c, ITEM.d),
    correct: { error: "ok", added: SOURCE_EDGE_NEW },
    dispatches: () => [create(1, "declined schemaFence")],
  },
  {
    name: "unconstrained, schemaFence declined",
    script: () => ({ "edge.create": [decline("schemaFence")] }),
    run: (surface) =>
      surface.edges.mxPlain.create(
        ITEM.c,
        ITEM.d,
        { label: "x" },
        { id: "new" },
      ),
    correct: {
      error: "ok",
      added: { edges: ["mxPlain:new c->d live"], claims: [] },
    },
    dispatches: (fence) => [create(0, "declined schemaFence", fence)],
  },
  {
    name: "unconstrained, nothing declined, on a store a newer schema version made stale (control: the fused fence refuses)",
    script: () => ({}),
    prepare: commitNewerSchemaVersion,
    run: (surface) =>
      surface.edges.mxPlain.create(
        ITEM.c,
        ITEM.d,
        { label: "x" },
        { id: "new" },
      ),
    correct: {
      root: { error: STALE_SCHEMA },
      transaction: {
        error: "not reached",
        commit: STALE_SCHEMA,
        sentinel: "lost",
      },
    },
    dispatches: (fence, receiver) =>
      receiver === "root" ? [create(0, "rejected", fence)] : [],
  },
  {
    name: "unconstrained, schemaFence declined, on a store a newer schema version made stale",
    script: () => ({ "edge.create": [decline("schemaFence")] }),
    prepare: commitNewerSchemaVersion,
    run: (surface) =>
      surface.edges.mxPlain.create(
        ITEM.c,
        ITEM.d,
        { label: "x" },
        { id: "new" },
      ),
    // At the root the fused fence is declined, so only the portable fence
    // the Store must fall back to can refuse the write. A caller's
    // transaction takes the portable fence when it opens, before any write.
    correct: {
      root: { error: STALE_SCHEMA },
      transaction: {
        error: "not reached",
        commit: STALE_SCHEMA,
        sentinel: "lost",
      },
    },
    dispatches: (fence, receiver) =>
      receiver === "root" ? [create(0, "declined schemaFence", fence)] : [],
    unconsumed: (receiver) => (receiver === "root" ? [] : ["edge.create #0"]),
  },
  {
    name: "unconstrained, endpointPredicate declined, dead target",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: (surface) =>
      surface.edges.mxPlain.create(
        ITEM.c,
        ITEM.dead,
        { label: "x" },
        { id: "new" },
      ),
    correct: { error: ENDPOINT },
    dispatches: (fence) => [create(0, "declined endpointPredicate", fence)],
  },
  {
    name: "two axes: the Store sends no command at all, so there is nothing to decline (D5)",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: (surface) =>
      surface.edges.mxBoth.create(
        ITEM.c,
        ITEM.d,
        { label: "x" },
        { id: "new" },
      ),
    correct: {
      error: "ok",
      added: {
        edges: ["mxBoth:new c->d live"],
        claims: [
          'one:mxBoth ["MxItem","c"] -> new',
          'to:one:mxBoth ["MxItem","d"] -> new',
        ],
      },
    },
    dispatches: () => [],
    unconsumed: () => ["edge.create #0"],
  },
  {
    name: "dynamic get-or-create, convergence declined",
    script: () => ({ "edge.converge-create": [decline("convergence")] }),
    run: (surface) =>
      surface.edges.mxPlain.getOrCreateByEndpoints(ITEM.c, ITEM.d, {
        label: "x",
      }),
    correct: {
      error: "ok:created",
      added: { edges: ["mxPlain:<generated> c->d live"], claims: [] },
    },
    // The SQLite drivers' write lock carries no command coordination, so the
    // Store answers a dynamic convergence `unsupported` itself and never
    // dispatches it (D4).
    dispatches: () => ({
      sqlite: [create(0, "created")],
      postgres: [
        converge("dynamic", "declined convergence"),
        create(0, "created"),
      ],
    }),
    unconsumed: () => ({ sqlite: ["edge.converge-create #0"], postgres: [] }),
  },
  {
    name: "dynamic get-or-create, endpointPredicate declined, dead target",
    script: () => ({ "edge.converge-create": [decline("endpointPredicate")] }),
    run: (surface) =>
      surface.edges.mxPlain.getOrCreateByEndpoints(ITEM.c, ITEM.dead, {
        label: "x",
      }),
    correct: { error: ENDPOINT },
    dispatches: () => ({
      sqlite: [create(0, "rejected")],
      postgres: [
        converge("dynamic", "declined endpointPredicate"),
        create(0, "rejected"),
      ],
    }),
    unconsumed: () => ({ sqlite: ["edge.converge-create #0"], postgres: [] }),
  },
  {
    name: "durable create, convergence declined",
    script: () => ({ "edge.converge-create": [decline("convergence")] }),
    run: (surface) =>
      surface.edges.mxIdentity.create(
        ITEM.b,
        ITEM.c,
        { label: "bc" },
        { id: "new" },
      ),
    correct: { error: DURABLE_COMMAND_REFUSED },
    dispatches: (fence) => [converge("durable", "declined convergence", fence)],
  },
  {
    name: "durable create, endpointPredicate declined, dead target",
    script: () => ({ "edge.converge-create": [decline("endpointPredicate")] }),
    run: (surface) =>
      surface.edges.mxIdentity.create(
        ITEM.b,
        ITEM.dead,
        { label: "bc" },
        { id: "new" },
      ),
    correct: { error: DURABLE_COMMAND_REFUSED },
    dispatches: (fence) => [
      converge("durable", "declined endpointPredicate", fence),
    ],
  },
  {
    name: "durable get-or-create, convergence declined",
    script: () => ({ "edge.converge-create": [decline("convergence")] }),
    run: (surface) =>
      surface.edges.mxIdentity.getOrCreateByEndpoints(ITEM.b, ITEM.c, {
        label: "bc",
      }),
    correct: { error: DURABLE_COMMAND_REFUSED },
    dispatches: (fence) => [converge("durable", "declined convergence", fence)],
  },
  {
    name: "durable create on a source axis whose claim, taken after the row, is refused",
    script: (graphId) => ({
      "edge.converge-create": [
        { plant: (backend) => plantSourceClaimHolder(backend, graphId) },
      ],
    }),
    run: (surface) =>
      surface.edges.mxIdentitySource.create(
        ITEM.c,
        ITEM.d,
        { label: "cd" },
        { id: "new" },
      ),
    // The plant runs inside the attempt: a root attempt's rollback discards
    // it, while a caught refusal inside `store.transaction` lets it commit —
    // and only it.
    correct: {
      root: { error: cardinality("source", "intruder") },
      transaction: {
        error: cardinality("source", "intruder"),
        added: INTRUDER,
      },
    },
    // A constrained kind takes the portable schema fence: no plan carries it.
    dispatches: () => [converge("durable", "planted, then created")],
    defects: [D6_ROW_BEFORE_CLAIM],
  },
];

function forReceiver(
  value: ExpectedCreate | PerReceiver<ExpectedCreate>,
  receiver: CaseReceiver,
): ExpectedCreate {
  return "root" in value ? value[receiver] : value;
}

function forDialect(
  value: readonly string[] | PerDialect<readonly string[]>,
  dialect: SqlDialect,
): readonly string[] {
  return Array.isArray(value) ? value : (
      (value as PerDialect<readonly string[]>)[dialect]
    );
}

export function registerEdgeCreateDeclineIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge create decline harness", () => {
    describe.each(CASE_RECEIVERS)("%s", (receiver) => {
      for (const declineCase of DECLINE_CASES) {
        it.for([declineCase.name])("%s", async () => {
          const graphId = nextEdgeCreatePathGraphId("edge_create_decline");
          const graph = buildEdgeCreatePathGraph(graphId);
          const lane = context.getBackend();
          await seedEdgeCreatePathGraph(await context.createStore(graph));
          const scripted = scriptedPolicy(declineCase.script(graphId));
          const declining = decliningCommandBackend(lane, scripted.policy);
          const [store] = await createStoreWithSchema(graph, declining.backend);
          await declineCase.prepare?.(context, graphId);
          const observation = await observeCreate(
            lane,
            graphId,
            store,
            receiver,
            declineCase.run,
          );
          expect({
            dispatches: declining.dispatches,
            unconsumed: scripted.unconsumed(),
          }).toEqual({
            dispatches: forDialect(
              declineCase.dispatches(fusedFence(receiver), receiver),
              lane.dialect,
            ),
            unconsumed: forDialect(
              declineCase.unconsumed?.(receiver) ?? [],
              lane.dialect,
            ),
          });
          expectCreateOutcome({
            lane: caseLane(context, receiver),
            receiver,
            observation,
            correct: forReceiver(declineCase.correct, receiver),
            ...(declineCase.defects === undefined ?
              {}
            : { defects: declineCase.defects }),
          });
        });
      }
    });

    it("the lane's port refuses a two-claim edge.create plan before running any SQL (D5)", async () => {
      const graphId = nextEdgeCreatePathGraphId("edge_create_decline");
      const lane = context.getBackend();
      await seedEdgeCreatePathGraph(
        await context.createStore(buildEdgeCreatePathGraph(graphId)),
      );
      const before = await readEdgeCreatePathState(lane, graphId);
      const params: InsertEdgeParams = {
        graphId,
        id: "new",
        kind: "mxBoth",
        fromKind: "MxItem",
        fromId: ITEM.c.id,
        toKind: "MxItem",
        toId: ITEM.d.id,
        props: { label: "x" },
      };
      const claim = (
        direction: "source" | "target",
      ): ClaimEdgeCardinalityParams => ({
        graphId,
        direction,
        cardinality: "one",
        edgeKind: params.kind,
        edgeId: params.id,
        fromKind: params.fromKind,
        fromId: params.fromId,
        toKind: params.toKind,
        toId: params.toId,
      });
      const command: EdgeCreateCommand = {
        kind: "edge.create",
        plan: {
          entity: "edge",
          params,
          cardinalityClaims: [claim("source"), claim("target")],
        },
      };
      const result = await lane.transaction((transaction) =>
        transaction.commands.execute(command, {
          session: "transaction",
          coordination: "none",
        }),
      );
      expect(result).toEqual({
        outcome: "unsupported",
        entity: "edge",
        dimensions: ["cardinalityClaim"],
      });
      expect(await readEdgeCreatePathState(lane, graphId)).toEqual(before);
    });
  });
}
