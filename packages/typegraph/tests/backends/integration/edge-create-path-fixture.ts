/**
 * The graph, seed and outside-view readers shared by the edge-create decline
 * harness (`edge-create-declines.ts`) and the refusal matrix
 * (`edge-create-refusal-matrix.ts`).
 *
 * Every edge kind here carries `{ label, weight? }` props, so an invalid
 * write is a `weight` of the wrong type: it leaves `label` — the durable
 * identity field — free to collide at the same time.
 *
 * Seed, per graph (every node and edge id is supplied):
 *
 *  - `MxItem` a, b, c, d live; `dead` tombstoned.
 *  - `mxAxes` (source `one`, target `one`, acyclic): `e-ab` a→b and `e-da`
 *    d→a. So a and d hold the taken source axes, a and b the taken target
 *    axes; c→d is free on both axes and closes no cycle; b→d closes
 *    d→a→b→d; a→d closes a cycle from a taken source; b→a closes a cycle
 *    onto a taken target.
 *  - `mxSource` (source `one` only) and `mxPlain` (no cardinality):
 *    `s-ab` a→b and `p-ab` a→b.
 *  - `mxBoth` (source and target `one`, not acyclic): `b-ab` a→b.
 *  - `mxIdentity`, `mxIdentitySource`, `mxIdentityTarget` (durable match
 *    identity on `label`; none, source `one`, target `one`): `i-ab`,
 *    `is-ab`, `it-ab` a→b labelled `ab`, and `i-cd` c→d labelled `cd`.
 *  - composition: `MxPart` p1 attached to `MxWhole` w1 through `mxMember`
 *    (`m-p1`), p2 unattached; `MxCappedPart` cp1 attached to w3 through
 *    `mxCappedMember`, whose whole takes at most one part (`cm-cp1`), cp2
 *    attached to w1 (`cm-cp2`); `MxIdentityPart` ip1 attached to w1 through
 *    `mxIdentityMember`, labelled `m` (`im-ip1`). `MxWhole` w1, w2, w3 live,
 *    `wdead` tombstoned.
 */
import { it, type TestContext } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  partOf,
} from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { type SqlDialect } from "../../../src/query/dialect/types";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { type EdgeClaimRow, readEdgeClaimRows } from "../../edge-claim-rows";
import { type InspectableStore } from "./test-context";

const EDGE_PROPS = z.object({
  label: z.string(),
  weight: z.number().optional(),
});

const MxItem = defineNode("MxItem", { schema: z.object({}) });
const MxWhole = defineNode("MxWhole", { schema: z.object({}) });
const MxPart = defineNode("MxPart", { schema: z.object({}) });
const MxCappedPart = defineNode("MxCappedPart", { schema: z.object({}) });
const MxIdentityPart = defineNode("MxIdentityPart", { schema: z.object({}) });

const mxAxes = defineEdge("mxAxes", { schema: EDGE_PROPS });
const mxSource = defineEdge("mxSource", { schema: EDGE_PROPS });
const mxPlain = defineEdge("mxPlain", { schema: EDGE_PROPS });
const mxBoth = defineEdge("mxBoth", { schema: EDGE_PROPS });
const mxIdentity = defineEdge("mxIdentity", { schema: EDGE_PROPS });
const mxIdentitySource = defineEdge("mxIdentitySource", { schema: EDGE_PROPS });
const mxIdentityTarget = defineEdge("mxIdentityTarget", { schema: EDGE_PROPS });
const mxMember = defineEdge("mxMember", { schema: EDGE_PROPS });
const mxCappedMember = defineEdge("mxCappedMember", { schema: EDGE_PROPS });
const mxIdentityMember = defineEdge("mxIdentityMember", { schema: EDGE_PROPS });

const LABEL_IDENTITY = { name: "mx-label", fields: ["label"] } as const;

export function buildEdgeCreatePathGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      MxItem: { type: MxItem },
      MxWhole: { type: MxWhole },
      MxPart: { type: MxPart },
      MxCappedPart: { type: MxCappedPart },
      MxIdentityPart: { type: MxIdentityPart },
    },
    edges: {
      mxAxes: {
        type: mxAxes,
        from: [MxItem],
        to: [MxItem],
        cardinality: "one",
        targetCardinality: "one",
        acyclic: true,
      },
      mxSource: {
        type: mxSource,
        from: [MxItem],
        to: [MxItem],
        cardinality: "one",
      },
      mxPlain: { type: mxPlain, from: [MxItem], to: [MxItem] },
      mxBoth: {
        type: mxBoth,
        from: [MxItem],
        to: [MxItem],
        cardinality: "one",
        targetCardinality: "one",
      },
      mxIdentity: {
        type: mxIdentity,
        from: [MxItem],
        to: [MxItem],
        matchIdentity: LABEL_IDENTITY,
      },
      mxIdentitySource: {
        type: mxIdentitySource,
        from: [MxItem],
        to: [MxItem],
        cardinality: "one",
        matchIdentity: LABEL_IDENTITY,
      },
      mxIdentityTarget: {
        type: mxIdentityTarget,
        from: [MxItem],
        to: [MxItem],
        targetCardinality: "one",
        matchIdentity: LABEL_IDENTITY,
      },
      mxMember: {
        type: mxMember,
        from: [MxPart],
        to: [MxWhole],
        cardinality: "oneActive",
      },
      mxCappedMember: {
        type: mxCappedMember,
        from: [MxCappedPart],
        to: [MxWhole],
        cardinality: "oneActive",
        targetCardinality: "one",
      },
      mxIdentityMember: {
        type: mxIdentityMember,
        from: [MxIdentityPart],
        to: [MxWhole],
        cardinality: "oneActive",
        matchIdentity: LABEL_IDENTITY,
      },
    },
    ontology: [
      partOf(MxPart, MxWhole, { via: mxMember }),
      partOf(MxCappedPart, MxWhole, { via: mxCappedMember }),
      partOf(MxIdentityPart, MxWhole, { via: mxIdentityMember }),
    ],
  });
}

type EdgeCreatePathGraph = ReturnType<typeof buildEdgeCreatePathGraph>;
export type EdgeCreatePathStore = InspectableStore<EdgeCreatePathGraph>;
export type EdgeCreatePathSurface = Pick<
  EdgeCreatePathStore,
  "nodes" | "edges"
>;

let graphCounter = 0;

/** A graph id no other test in this process has used. */
export function nextEdgeCreatePathGraphId(prefix: string): string {
  graphCounter += 1;
  return `${prefix}_${graphCounter}`;
}

export const ITEM = {
  a: { kind: "MxItem", id: "a" },
  b: { kind: "MxItem", id: "b" },
  c: { kind: "MxItem", id: "c" },
  d: { kind: "MxItem", id: "d" },
  dead: { kind: "MxItem", id: "dead" },
} as const;

export const WHOLE = {
  w1: { kind: "MxWhole", id: "w1" },
  w2: { kind: "MxWhole", id: "w2" },
  w3: { kind: "MxWhole", id: "w3" },
  dead: { kind: "MxWhole", id: "wdead" },
} as const;

export const PART = {
  p1: { kind: "MxPart", id: "p1" },
  p2: { kind: "MxPart", id: "p2" },
  cp1: { kind: "MxCappedPart", id: "cp1" },
  cp2: { kind: "MxCappedPart", id: "cp2" },
  cp3: { kind: "MxCappedPart", id: "cp3" },
  ip1: { kind: "MxIdentityPart", id: "ip1" },
} as const;

/** Seeds the rows the module comment lists, in one transaction. */
export async function seedEdgeCreatePathGraph(
  store: EdgeCreatePathStore,
): Promise<void> {
  await store.transaction(async (tx) => {
    for (const id of ["a", "b", "c", "d", "dead"]) {
      await tx.nodes.MxItem.create({}, { id });
    }
    for (const id of ["w1", "w2", "w3", "wdead"]) {
      await tx.nodes.MxWhole.create({}, { id });
    }
    for (const id of ["p1", "p2"]) await tx.nodes.MxPart.create({}, { id });
    for (const id of ["cp1", "cp2", "cp3"]) {
      await tx.nodes.MxCappedPart.create({}, { id });
    }
    await tx.nodes.MxIdentityPart.create({}, { id: "ip1" });

    await tx.edges.mxAxes.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "e-ab" },
    );
    await tx.edges.mxAxes.create(
      ITEM.d,
      ITEM.a,
      { label: "da" },
      { id: "e-da" },
    );
    await tx.edges.mxSource.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "s-ab" },
    );
    await tx.edges.mxPlain.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "p-ab" },
    );
    await tx.edges.mxBoth.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "b-ab" },
    );
    await tx.edges.mxIdentity.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "i-ab" },
    );
    await tx.edges.mxIdentity.create(
      ITEM.c,
      ITEM.d,
      { label: "cd" },
      { id: "i-cd" },
    );
    await tx.edges.mxIdentitySource.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "is-ab" },
    );
    await tx.edges.mxIdentityTarget.create(
      ITEM.a,
      ITEM.b,
      { label: "ab" },
      { id: "it-ab" },
    );
    await tx.edges.mxMember.create(
      PART.p1,
      WHOLE.w1,
      { label: "m" },
      { id: "m-p1" },
    );
    await tx.edges.mxCappedMember.create(
      PART.cp1,
      WHOLE.w3,
      { label: "m" },
      { id: "cm-cp1" },
    );
    await tx.edges.mxCappedMember.create(
      PART.cp2,
      WHOLE.w1,
      { label: "m" },
      { id: "cm-cp2" },
    );
    await tx.edges.mxIdentityMember.create(
      PART.ip1,
      WHOLE.w1,
      { label: "m" },
      { id: "im-ip1" },
    );

    await tx.nodes.MxItem.delete(asNodeId<typeof MxItem>(ITEM.dead.id));
    await tx.nodes.MxWhole.delete(asNodeId<typeof MxWhole>(WHOLE.dead.id));
  });
}

type EdgeStateRow = Readonly<{
  id: string;
  kind: string;
  from_id: string;
  to_id: string;
  state: string;
}>;

/**
 * A store-generated id (21 URL-safe characters) renders as `<generated>`:
 * the outside view names which row survived, not which id it was minted.
 * Every id this module's fixtures supply is shorter.
 */
const GENERATED_ID = /^[\w-]{21}$/u;

function renderEdgeId(id: string): string {
  return GENERATED_ID.test(id) ? "<generated>" : id;
}

/** One edge row as the outside view renders it. */
function renderEdgeRow(row: EdgeStateRow): string {
  return `${row.kind}:${renderEdgeId(row.id)} ${row.from_id}->${row.to_id} ${row.state}`;
}

/**
 * One claim row as the outside view renders it. A target-side axis is
 * stored with a control-character prefix (`\u001eto\u001e`); it renders as
 * `to:`.
 */
const TARGET_AXIS_PREFIX = "\u001Eto\u001E";

function renderClaimRow(row: EdgeClaimRow): string {
  const axis =
    row.axis.startsWith(TARGET_AXIS_PREFIX) ?
      `to:${row.axis.slice(TARGET_AXIS_PREFIX.length)}`
    : row.axis;
  return `${axis} ${row.key} -> ${renderEdgeId(row.edge_id)}`;
}

/**
 * What a graph's edge and claim relations hold, read through `backend` —
 * the lane's own backend, never the store under test or its decorator.
 */
export type EdgeCreatePathState = Readonly<{
  edges: readonly string[];
  claims: readonly string[];
}>;

export async function readEdgeCreatePathState(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
): Promise<EdgeCreatePathState> {
  const schema = createSqlSchema(backend.tableNames);
  const edgeRows = await backend.execute<EdgeStateRow>(
    asCompiledRowsSql(sql`
      SELECT id, kind, from_id, to_id,
        CASE WHEN deleted_at IS NULL THEN 'live' ELSE 'deleted' END AS state
      FROM ${sql.identifier(schema.tables.edges)}
      WHERE graph_id = ${graphId}
    `),
  );
  const claimRows = await readEdgeClaimRows(backend, graphId);
  return {
    edges: edgeRows.map((row) => renderEdgeRow(row)).toSorted(),
    claims: claimRows.map((row) => renderClaimRow(row)).toSorted(),
  };
}

/** The node a transaction case writes before its create, to see it survive. */
const SENTINEL_ID = "sentinel";

/**
 * Whether the sentinel node a transaction case wrote before its create is
 * live after the transaction settled. A caught refusal that poisoned the
 * transaction loses it even where COMMIT reports success: PostgreSQL answers
 * COMMIT of an aborted transaction with a rollback, and not every driver
 * raises on that.
 */
async function readSentinel(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
): Promise<"kept" | "lost"> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<Readonly<{ id: string }>>(
    asCompiledRowsSql(sql`
      SELECT id FROM ${sql.identifier(schema.tables.nodes)}
      WHERE graph_id = ${graphId} AND id = ${SENTINEL_ID}
        AND deleted_at IS NULL
    `),
  );
  return rows.length === 1 ? "kept" : "lost";
}

/** The rows `after` holds that `before` did not, per relation. */
export type EdgeCreatePathDelta = Readonly<{
  edges: readonly string[];
  claims: readonly string[];
}>;

function addedRows(
  previous: readonly string[],
  next: readonly string[],
): readonly string[] {
  return next.filter((row) => !previous.includes(row));
}

function stateDelta(
  before: EdgeCreatePathState,
  after: EdgeCreatePathState,
): EdgeCreatePathDelta {
  return {
    edges: addedRows(before.edges, after.edges),
    claims: addedRows(before.claims, after.claims),
  };
}

function errorCode(error: Error): string | undefined {
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}

/**
 * The issue paths a validation refusal names, so a duplicate id (`id`) and
 * an invalid property (`weight`) — both `ValidationError` — stay apart.
 */
function issuePaths(error: Error): string | undefined {
  const details: unknown = Reflect.get(error, "details");
  if (typeof details !== "object" || details === null) return undefined;
  const issues: unknown = Reflect.get(details, "issues");
  if (!Array.isArray(issues) || issues.length === 0) return undefined;
  return issues
    .map((issue: unknown) => {
      const path: unknown =
        typeof issue === "object" && issue !== null ?
          Reflect.get(issue, "path")
        : undefined;
      return Array.isArray(path) ? path.join(".") : String(path);
    })
    .join(",");
}

/**
 * How a write settled: `ok` (with a get-or-create's `action`), or the
 * refusal's class name and, when it carries one, its code.
 */
async function settle(write: () => Promise<unknown>): Promise<string> {
  try {
    const result: unknown = await write();
    const action: unknown =
      typeof result === "object" && result !== null ?
        Reflect.get(result, "action")
      : undefined;
    return typeof action === "string" ? `ok:${action}` : "ok";
  } catch (error: unknown) {
    if (!(error instanceof Error)) return String(error);
    const code = errorCode(error);
    const paths = issuePaths(error);
    const name =
      code === undefined ?
        error.constructor.name
      : `${error.constructor.name}[${code}]`;
    return paths === undefined ? name : `${name} at ${paths}`;
  }
}

/** The receivers every case runs on. */
export const CASE_RECEIVERS = ["root", "transaction"] as const;

export type CaseReceiver = (typeof CASE_RECEIVERS)[number];

/**
 * How one create settled and what it left: the error (or `ok`), and inside
 * `store.transaction` how the transaction settled and whether the sentinel
 * it wrote first survived; then the edge and claim rows added, read from
 * outside.
 */
export type CreateOutcome = Readonly<{
  error: string;
  commit?: string;
  sentinel?: "kept" | "lost";
  delta: EdgeCreatePathDelta;
}>;

/** The delta a refused create should leave: none. */
const NO_DELTA: EdgeCreatePathDelta = { edges: [], claims: [] };

/**
 * The outcome a case expects on `receiver`: `error` and `delta` (none by
 * default), and inside `store.transaction` a commit that succeeds with the
 * sentinel kept — a caught refusal must not cost the transaction its other
 * work.
 */
export function expectedOutcome(
  receiver: CaseReceiver,
  expected: Readonly<{ error: string; delta?: EdgeCreatePathDelta }>,
): CreateOutcome {
  const delta = expected.delta ?? NO_DELTA;
  return receiver === "root" ?
      { error: expected.error, delta }
    : { error: expected.error, commit: "ok", sentinel: "kept", delta };
}

type CaseStore = Pick<EdgeCreatePathStore, "nodes" | "edges" | "transaction">;

/**
 * Runs `write` on `receiver` of `store` and reads, through `lane` — the
 * lane's own backend, never the store under test — what the graph holds
 * afterwards. Inside `store.transaction` the case first writes the sentinel
 * node, catches the write's error, and lets the transaction commit.
 */
export async function observeCreate(
  lane: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  store: CaseStore,
  receiver: CaseReceiver,
  write: (surface: EdgeCreatePathSurface) => Promise<unknown>,
): Promise<CreateOutcome> {
  const before = await readEdgeCreatePathState(lane, graphId);
  if (receiver === "root") {
    const error = await settle(() => write(store));
    const after = await readEdgeCreatePathState(lane, graphId);
    return { error, delta: stateDelta(before, after) };
  }
  let error = "not reached";
  const commit = await settle(() =>
    store.transaction(async (tx) => {
      await tx.nodes.MxItem.create({}, { id: SENTINEL_ID });
      error = await settle(() => write(tx));
    }),
  );
  const after = await readEdgeCreatePathState(lane, graphId);
  return {
    error,
    commit,
    sentinel: await readSentinel(lane, graphId),
    delta: stateDelta(before, after),
  };
}

/**
 * A defect a case is known to hit: on which lanes (by dialect; every lane
 * when omitted) and receivers (both when omitted), under which label — an
 * issue number, or the design note's `D<n>`.
 */
export type KnownFailure = Readonly<{
  label: string;
  dialects?: readonly SqlDialect[];
  receivers?: readonly CaseReceiver[];
}>;

function knownFailureApplies(
  failure: KnownFailure,
  dialect: SqlDialect,
  receiver: CaseReceiver,
): boolean {
  return (
    (failure.dialects?.includes(dialect) ?? true) &&
    (failure.receivers?.includes(receiver) ?? true)
  );
}

/**
 * Registers one case on one receiver as a plain test on the lanes no known
 * failure applies to, and, per known failure, as an `it.fails` test on the
 * lanes it applies to. Both bodies assert the CORRECT outcome; the plain one
 * also asserts `characterize` (a dispatch log, say), which a known failure
 * leaves out so that it fails only for the defect it names. The lane is
 * known only once the suite's backend exists, so each test skips itself on
 * the lanes it does not cover.
 */
export function registerOutcomeCase(
  context: Readonly<{ getBackend: () => Readonly<{ dialect: SqlDialect }> }>,
  params: Readonly<{
    title: string;
    receiver: CaseReceiver;
    knownFailures: readonly KnownFailure[];
    assertCorrect: () => Promise<void>;
    characterize?: () => void;
  }>,
): void {
  const { title, receiver, knownFailures } = params;
  const failing = (dialect: SqlDialect): readonly KnownFailure[] =>
    knownFailures.filter((failure) =>
      knownFailureApplies(failure, dialect, receiver),
    );
  it.for([title])("%s", async (_title, testContext: TestContext) => {
    if (failing(context.getBackend().dialect).length > 0) {
      testContext.skip("a known failure covers this lane");
    }
    await params.assertCorrect();
    params.characterize?.();
  });
  const failureTitles = new Map(
    knownFailures.map((failure) => [
      `[known failure ${failure.label}] ${title}`,
      failure,
    ]),
  );
  it.fails.for([...failureTitles.keys()])(
    "%s",
    async (failureTitle, testContext: TestContext) => {
      const failure = failureTitles.get(failureTitle);
      if (
        failure === undefined ||
        !failing(context.getBackend().dialect).includes(failure)
      ) {
        testContext.skip("this known failure does not cover this lane");
      }
      await params.assertCorrect();
    },
  );
}
