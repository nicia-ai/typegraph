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
 *
 * Three more composition kinds carry no seed rows; the refusal-matrix cases
 * that need them write their own: `mxNest` (reflexive `MxSection` →
 * `MxSection`, `oneActive`), `mxChapterNest` (reflexive `MxChapter` →
 * `MxChapter`, `oneActive`, durable identity on `label`) and `mxHolds`
 * (`hasPart(MxHolder, MxHeld)`: the part is the TARGET, `oneActive`, and
 * the holder takes source `one`).
 */
import { z } from "zod";

import {
  asNodeId,
  CardinalityError,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  hasPart,
  partOf,
} from "../../../src";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { type EdgeClaimRow, readEdgeClaimRows } from "../../edge-claim-rows";
import {
  type DefectScope,
  expectObservation,
  type LaneFacets,
} from "../../helpers/known-defect";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const EDGE_PROPS = z.object({
  label: z.string(),
  weight: z.number().optional(),
});

const MxItem = defineNode("MxItem", { schema: z.object({}) });
const MxWhole = defineNode("MxWhole", { schema: z.object({}) });
const MxPart = defineNode("MxPart", { schema: z.object({}) });
const MxCappedPart = defineNode("MxCappedPart", { schema: z.object({}) });
const MxIdentityPart = defineNode("MxIdentityPart", { schema: z.object({}) });
const MxSection = defineNode("MxSection", { schema: z.object({}) });
const MxChapter = defineNode("MxChapter", { schema: z.object({}) });
const MxHolder = defineNode("MxHolder", { schema: z.object({}) });
const MxHeld = defineNode("MxHeld", { schema: z.object({}) });

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
const mxNest = defineEdge("mxNest", { schema: EDGE_PROPS });
const mxChapterNest = defineEdge("mxChapterNest", { schema: EDGE_PROPS });
const mxHolds = defineEdge("mxHolds", { schema: EDGE_PROPS });

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
      MxSection: { type: MxSection },
      MxChapter: { type: MxChapter },
      MxHolder: { type: MxHolder },
      MxHeld: { type: MxHeld },
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
      mxNest: {
        type: mxNest,
        from: [MxSection],
        to: [MxSection],
        cardinality: "oneActive",
      },
      mxChapterNest: {
        type: mxChapterNest,
        from: [MxChapter],
        to: [MxChapter],
        cardinality: "oneActive",
        matchIdentity: LABEL_IDENTITY,
      },
      mxHolds: {
        type: mxHolds,
        from: [MxHolder],
        to: [MxHeld],
        cardinality: "one",
        targetCardinality: "oneActive",
      },
    },
    ontology: [
      partOf(MxPart, MxWhole, { via: mxMember }),
      partOf(MxCappedPart, MxWhole, { via: mxCappedMember }),
      partOf(MxIdentityPart, MxWhole, { via: mxIdentityMember }),
      partOf(MxSection, MxSection, { via: mxNest, partSide: "from" }),
      partOf(MxChapter, MxChapter, { via: mxChapterNest, partSide: "from" }),
      hasPart(MxHolder, MxHeld, { via: mxHolds }),
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
  store: Pick<EdgeCreatePathStore, "transaction">,
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

/** Rows a write is expected to add, per relation. */
export type EdgeCreatePathDelta = Readonly<{
  edges: readonly string[];
  claims: readonly string[];
}>;

const NO_ROWS: EdgeCreatePathDelta = { edges: [], claims: [] };

/**
 * The COMPLETE state a write should leave: `baseline` plus exactly the rows
 * `added` names. A case compares it whole against the state read afterwards,
 * so a write that removes or rewrites a row it had no business touching — an
 * incumbent edge, an incumbent's claim — fails as surely as one that leaves
 * a row behind.
 */
function stateAfter(
  baseline: EdgeCreatePathState,
  added: EdgeCreatePathDelta,
): EdgeCreatePathState {
  return {
    edges: [...baseline.edges, ...added.edges].toSorted(),
    claims: [...baseline.claims, ...added.claims].toSorted(),
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
 * A `CardinalityError`'s direction and the incumbent it names, so a source
 * refusal and a target refusal — one class, one code — stay apart, and so
 * does a refusal naming the wrong holder.
 */
function cardinalityDetails(error: Error): string | undefined {
  if (!(error instanceof CardinalityError)) return undefined;
  const incumbent = error.details.incumbentEdgeId ?? "<none>";
  return `${error.details.direction} incumbent=${incumbent}`;
}

/**
 * How a write settled: `ok` (with a get-or-create's `action`), or the
 * refusal's class name and, when it carries one, its code, followed by the
 * validation issue paths or the cardinality direction and incumbent.
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
    const cardinality = cardinalityDetails(error);
    if (paths !== undefined) return `${name} at ${paths}`;
    return cardinality === undefined ? name : `${name} ${cardinality}`;
  }
}

/** The receivers every case runs on. */
export const CASE_RECEIVERS = ["root", "transaction"] as const;

export type CaseReceiver = (typeof CASE_RECEIVERS)[number];

/**
 * How one create settled and what the graph holds afterwards: the error (or
 * `ok`), inside `store.transaction` how the transaction settled and whether
 * the sentinel it wrote first survived, and the complete edge and claim
 * state read from outside.
 */
export type CreateOutcome = Readonly<{
  error: string;
  commit?: string;
  sentinel?: "kept" | "lost";
  state: EdgeCreatePathState;
}>;

/** An outcome, and the state the graph held before the create. */
export type CreateObservation = Readonly<{
  baseline: EdgeCreatePathState;
  outcome: CreateOutcome;
}>;

/**
 * How a case expects a create to settle: `error`, the rows it adds (none by
 * default), and inside `store.transaction` how the commit settles (`ok` by
 * default) and whether the sentinel survives (`kept` by default) — a caught
 * refusal must not cost the transaction its other work. At the root, `commit`
 * and `sentinel` do not apply and are ignored.
 */
export type ExpectedCreate = Readonly<{
  error: string;
  added?: EdgeCreatePathDelta;
  commit?: string;
  sentinel?: "kept" | "lost";
}>;

function expectedOutcome(
  receiver: CaseReceiver,
  baseline: EdgeCreatePathState,
  expected: ExpectedCreate,
): CreateOutcome {
  const state = stateAfter(baseline, expected.added ?? NO_ROWS);
  return receiver === "root" ?
      { error: expected.error, state }
    : {
        error: expected.error,
        commit: expected.commit ?? "ok",
        sentinel: expected.sentinel ?? "kept",
        state,
      };
}

type CaseStore = Pick<EdgeCreatePathStore, "nodes" | "edges" | "transaction">;

/**
 * Runs `write` on `receiver` of `store` and reads, through `lane` — the
 * lane's own backend, never the store under test — what the graph holds
 * before and afterwards. Inside `store.transaction` the case first writes the
 * sentinel node, catches the write's error, and lets the transaction commit.
 */
export async function observeCreate(
  lane: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  store: CaseStore,
  receiver: CaseReceiver,
  write: (surface: EdgeCreatePathSurface) => Promise<unknown>,
): Promise<CreateObservation> {
  const baseline = await readEdgeCreatePathState(lane, graphId);
  if (receiver === "root") {
    const error = await settle(() => write(store));
    const state = await readEdgeCreatePathState(lane, graphId);
    return { baseline, outcome: { error, state } };
  }
  let error = "not reached";
  const commit = await settle(() =>
    store.transaction(async (tx) => {
      await tx.nodes.MxItem.create({}, { id: SENTINEL_ID });
      error = await settle(() => write(tx));
    }),
  );
  const state = await readEdgeCreatePathState(lane, graphId);
  return {
    baseline,
    outcome: {
      error,
      commit,
      sentinel: await readSentinel(lane, graphId),
      state,
    },
  };
}

/**
 * A defect a create case is known to hit: the issue or design-note label,
 * the lanes it affects (facets `lane`, `dialect`, `receiver`; see
 * {@link caseLane}), and how the create settles there today.
 */
export type CreateDefect = Readonly<{
  label: string;
  on: DefectScope;
  today: ExpectedCreate;
}>;

/**
 * The facets a create case's lane is named by: the integration lane's name
 * (`SQLite`, `libsql`, `PGlite`, `PostgreSQL`, `PostgreSQL (postgres-js)`),
 * its dialect, and the receiver.
 */
export function caseLane(
  context: Pick<IntegrationTestContext, "lane" | "getBackend">,
  receiver: CaseReceiver,
): LaneFacets {
  return {
    lane: context.lane,
    dialect: context.getBackend().dialect,
    receiver,
  };
}

/**
 * Asserts a create's outcome through {@link expectObservation}: on a lane a
 * defect covers, exactly its today value; elsewhere, `correct`. Both are
 * stated as additions to the observed baseline and compared as the complete
 * state.
 */
export function expectCreateOutcome(
  params: Readonly<{
    lane: LaneFacets;
    receiver: CaseReceiver;
    observation: CreateObservation;
    correct: ExpectedCreate;
    defects?: readonly CreateDefect[];
  }>,
): void {
  const { lane, receiver, observation } = params;
  const { baseline } = observation;
  expectObservation({
    lane,
    observed: observation.outcome,
    correct: expectedOutcome(receiver, baseline, params.correct),
    defects: (params.defects ?? []).map((defect) => ({
      label: defect.label,
      on: defect.on,
      today: expectedOutcome(receiver, baseline, defect.today),
    })),
  });
}
