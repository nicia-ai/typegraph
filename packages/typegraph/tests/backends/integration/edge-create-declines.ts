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
 *  - the edge and claim rows the graph holds afterwards, read from outside
 *    through the lane's own backend.
 *
 * Each case runs at the root and inside `store.transaction()` with the error
 * caught and the transaction left to commit. The decorated backend is a
 * derived root, so the bundled-root autocommit path is out of this harness's
 * reach: every root dispatch below runs on a store-opened transaction.
 *
 * Outcomes that leave a refused create's rows behind, or that make the
 * winning error depend on which dimension a port declined, are known
 * failures: they assert the correct outcome under `it.fails` with the design
 * note's label (`D2`, `D3`, `D6`).
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
  type CaseReceiver,
  type EdgeCreatePathDelta,
  type EdgeCreatePathSurface,
  expectedOutcome,
  ITEM,
  type KnownFailure,
  nextEdgeCreatePathGraphId,
  observeCreate,
  readEdgeCreatePathState,
  registerOutcomeCase,
  seedEdgeCreatePathGraph,
} from "./edge-create-path-fixture";
import { type IntegrationTestContext } from "./test-context";

const ENDPOINT = "EndpointNotFoundError[ENDPOINT_NOT_FOUND]";
const CARDINALITY = "CardinalityError[CARDINALITY_ERROR]";
const DURABLE_COMMAND_REFUSED = "ConfigurationError[CONFIGURATION_ERROR]";

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
const D2_CLAIM_RESIDUE: KnownFailure = {
  label: "D2",
  receivers: ["transaction"],
};

/**
 * D3: with a dead endpoint and a taken axis, declining `cardinalityClaim`
 * makes the claim refuse first, while declining `endpointPredicate` reports
 * the endpoint: the precedence follows the port's support, on every lane.
 */
const D3_PORT_DECIDES_PRECEDENCE: KnownFailure = { label: "D3" };

/**
 * D6: a durable create claims its cardinality only after the converge
 * command wrote its row. When that claim is refused and the caller catches
 * the error inside `store.transaction`, the row commits without its claim.
 */
const D6_ROW_BEFORE_CLAIM: KnownFailure = {
  label: "D6",
  receivers: ["transaction"],
};

type PerDialect<T> = Readonly<{ sqlite: T; postgres: T }>;

type DeclineCase = Readonly<{
  name: string;
  script: (graphId: string) => DispatchScript;
  run: (surface: EdgeCreatePathSurface) => Promise<unknown>;
  error: string;
  delta?: EdgeCreatePathDelta;
  /**
   * The dispatch log on every lane, or per dialect where they differ, given
   * the schema-fence marker a root plan carries ({@link fusedFence}).
   */
  dispatches: (
    fence: string,
  ) => readonly string[] | PerDialect<readonly string[]>;
  /** Scripted steps the Store never gave a dispatch to consume. */
  unconsumed?: readonly string[] | PerDialect<readonly string[]>;
  knownFailures?: readonly KnownFailure[];
}>;

function createSource(
  from: (typeof ITEM)[keyof typeof ITEM],
  to: (typeof ITEM)[keyof typeof ITEM],
) {
  return (surface: EdgeCreatePathSurface) =>
    surface.edges.mxSource.create(from, to, { label: "x" }, { id: "new" });
}

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

const DECLINE_CASES: readonly DeclineCase[] = [
  {
    name: "one axis, cardinalityClaim declined: the session claims, then retries without the claim",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.c, ITEM.d),
    error: "ok",
    delta: SOURCE_EDGE_NEW,
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
    error: "ok",
    delta: SOURCE_EDGE_NEW,
    dispatches: () => [
      create(1, "declined cardinalityClaim"),
      create(0, "declined endpointPredicate"),
    ],
  },
  {
    name: "one axis, cardinalityClaim declined, dead target on a free axis",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.c, ITEM.dead),
    error: ENDPOINT,
    dispatches: () => [
      create(1, "declined cardinalityClaim"),
      create(0, "rejected"),
    ],
    knownFailures: [D2_CLAIM_RESIDUE],
  },
  {
    name: "one axis, cardinalityClaim declined, dead target on a taken source axis",
    script: () => ({ "edge.create": [decline("cardinalityClaim")] }),
    run: createSource(ITEM.a, ITEM.dead),
    error: ENDPOINT,
    dispatches: () => [create(1, "declined cardinalityClaim")],
    knownFailures: [D3_PORT_DECIDES_PRECEDENCE],
  },
  {
    name: "one axis, endpointPredicate declined, free axis",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: createSource(ITEM.c, ITEM.d),
    error: "ok",
    delta: SOURCE_EDGE_NEW,
    dispatches: () => [create(1, "declined endpointPredicate")],
  },
  {
    name: "one axis, endpointPredicate declined, dead target on a taken source axis",
    script: () => ({ "edge.create": [decline("endpointPredicate")] }),
    run: createSource(ITEM.a, ITEM.dead),
    error: ENDPOINT,
    dispatches: () => [create(1, "declined endpointPredicate")],
  },
  {
    name: "one axis, schemaFence declined although the plan carries no schema fence",
    script: () => ({ "edge.create": [decline("schemaFence")] }),
    run: createSource(ITEM.c, ITEM.d),
    error: "ok",
    delta: SOURCE_EDGE_NEW,
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
    error: "ok",
    delta: { edges: ["mxPlain:new c->d live"], claims: [] },
    dispatches: (fence) => [create(0, "declined schemaFence", fence)],
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
    error: ENDPOINT,
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
    error: "ok",
    delta: {
      edges: ["mxBoth:new c->d live"],
      claims: [
        'one:mxBoth ["MxItem","c"] -> new',
        'to:one:mxBoth ["MxItem","d"] -> new',
      ],
    },
    dispatches: () => [],
    unconsumed: ["edge.create #0"],
  },
  {
    name: "dynamic get-or-create, convergence declined",
    script: () => ({ "edge.converge-create": [decline("convergence")] }),
    run: (surface) =>
      surface.edges.mxPlain.getOrCreateByEndpoints(ITEM.c, ITEM.d, {
        label: "x",
      }),
    error: "ok:created",
    delta: { edges: ["mxPlain:<generated> c->d live"], claims: [] },
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
    unconsumed: { sqlite: ["edge.converge-create #0"], postgres: [] },
  },
  {
    name: "dynamic get-or-create, endpointPredicate declined, dead target",
    script: () => ({ "edge.converge-create": [decline("endpointPredicate")] }),
    run: (surface) =>
      surface.edges.mxPlain.getOrCreateByEndpoints(ITEM.c, ITEM.dead, {
        label: "x",
      }),
    error: ENDPOINT,
    dispatches: () => ({
      sqlite: [create(0, "rejected")],
      postgres: [
        converge("dynamic", "declined endpointPredicate"),
        create(0, "rejected"),
      ],
    }),
    unconsumed: { sqlite: ["edge.converge-create #0"], postgres: [] },
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
    error: DURABLE_COMMAND_REFUSED,
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
    error: DURABLE_COMMAND_REFUSED,
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
    error: DURABLE_COMMAND_REFUSED,
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
    error: CARDINALITY,
    // A constrained kind takes the portable schema fence: no plan carries it.
    dispatches: () => [converge("durable", "planted, then created")],
    knownFailures: [D6_ROW_BEFORE_CLAIM],
  },
];

/**
 * The rows a case should leave. The D6 plant runs inside the attempt: a
 * root attempt's rollback discards it, while a caught refusal inside
 * `store.transaction` lets it commit — and only it.
 */
function expectedDelta(
  declineCase: DeclineCase,
  receiver: CaseReceiver,
): EdgeCreatePathDelta | undefined {
  const plants = declineCase.knownFailures?.includes(D6_ROW_BEFORE_CLAIM);
  return plants === true && receiver === "transaction" ?
      INTRUDER
    : declineCase.delta;
}

function forDialect(
  value: readonly string[] | PerDialect<readonly string[]>,
  dialect: SqlDialect,
): readonly string[] {
  return Array.isArray(value) ? value : (
      (value as PerDialect<readonly string[]>)[dialect]
    );
}

type DispatchObservation = Readonly<{
  dispatches: readonly string[];
  unconsumed: readonly string[];
}>;

export function registerEdgeCreateDeclineIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("edge create decline harness", () => {
    describe.each(CASE_RECEIVERS)("%s", (receiver) => {
      for (const declineCase of DECLINE_CASES) {
        let observed: DispatchObservation | undefined;
        registerOutcomeCase(context, {
          title: declineCase.name,
          receiver,
          knownFailures: declineCase.knownFailures ?? [],
          assertCorrect: async () => {
            const graphId = nextEdgeCreatePathGraphId("edge_create_decline");
            const graph = buildEdgeCreatePathGraph(graphId);
            const lane = context.getBackend();
            await seedEdgeCreatePathGraph(await context.createStore(graph));
            const scripted = scriptedPolicy(declineCase.script(graphId));
            const declining = decliningCommandBackend(lane, scripted.policy);
            const [store] = await createStoreWithSchema(
              graph,
              declining.backend,
            );
            const outcome = await observeCreate(
              lane,
              graphId,
              store,
              receiver,
              declineCase.run,
            );
            observed = {
              dispatches: declining.dispatches,
              unconsumed: scripted.unconsumed(),
            };
            const delta = expectedDelta(declineCase, receiver);
            expect(outcome).toEqual(
              expectedOutcome(receiver, {
                error: declineCase.error,
                ...(delta === undefined ? {} : { delta }),
              }),
            );
          },
          characterize: () => {
            const dialect = context.getBackend().dialect;
            expect(observed).toEqual({
              dispatches: forDialect(
                declineCase.dispatches(fusedFence(receiver)),
                dialect,
              ),
              unconsumed: forDialect(declineCase.unconsumed ?? [], dialect),
            });
          },
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
