/**
 * The temporal ORACLE suite: randomized bitemporal histories, replayed against
 * an independent TypeScript model of the valid-time semantics
 * (`./temporal-oracle-model`) on every backend in the integration matrix.
 *
 * WHAT IT CHECKS, AND WHY EACH PROPERTY EXISTS
 *
 * - **P1 / P1b — storage invariants.** No row this library writes carries a
 *   window readable at no coordinate (I1), and no write that STAMPS a bound the
 *   caller did not state produces one (I1b). No read-side test can express
 *   these: an invisible row is invisible to every read. Both halves of I1's
 *   scope are checked — the live relations in P1's own property, and the
 *   `recorded_*` relations (an independent binder of the same columns) inside
 *   P5, the only property whose store writes them.
 * - **P2 — bound provenance (I2).** Scoped to what the ledger can prove. Its
 *   never-updated clause is an EQUALITY (`valid_from === created_at` for a bound
 *   nobody stated), which is the only ledger-visible detector for an insert
 *   builder that samples its own clock instead of binding the `timestamp` it
 *   also stamps into `created_at`.
 * - **P3 — four-way visibility equality (I3/I4/I6/I7).** The compiled query, the
 *   SQL-filtered collection read, the in-memory `#temporalRowMatcher` behind
 *   `getByIds`, and the model. Any three agreeing is not evidence.
 * - **P4' — projection parity.** `valid_from` has two normalization owners:
 *   `src/backend/row-mappers.ts` (through `formatTimestamp`) and
 *   `src/query/execution/result-mapper.ts` (a bare `nullToUndefined`). This
 *   binds them on every driver in the matrix — on which bounds exist, on which
 *   instant each names, and on the runtime type of a present bound. Their
 *   RENDERING already diverges on postgres.js; that is issue #463.
 * - **P5 — the bitemporal grid.** `asOfRecorded(r) x asOf(t)` against the model
 *   derived from the `recorded_*` rows, plus the current-mode recorded pin —
 *   and I1/I1b over those same rows, which is where the recorded half of the
 *   storage invariants is checked.
 * - **P6 — interchange round-trip (I8).** `(valid_from, valid_to)` survives
 *   export/import exactly, `NULL` included.
 * - **P7 — merge window laws (I11).** Order-independence of the least-claim
 *   rule, deletion absorbing an ending, and a `validFrom` divergence being
 *   reported rather than dropped.
 *
 * EVERY GENERATED HISTORY CARRIES AN EXPLICITLY OPEN-LEFT ITEM. An interchange
 * import stating `validFrom: null` is, on this tree, the only store-level path
 * that produces `valid_from = NULL`. Without it, deleting the
 * `valid_from IS NULL OR` disjunct from the SQL — or inverting the in-memory
 * matcher's `valid_from` branch — changes no outcome, and the four-way check
 * would certify nothing for the very shape it was widened to cover.
 *
 * ISOLATION. Each fast-check run builds a FRESH graph id over the already
 * provisioned backend and a bare `createStore` (a plain constructor: it issues
 * no DDL). `graph_id` is a fence every compiled query and every collection read
 * already carries, so the query under test is the query users write — no
 * id-prefix predicate is bolted onto it — and shrinking stays hermetic.
 *
 * CLOSED CONTRACT GAPS. The model encodes TODAY'S contract, so this suite passed
 * unchanged on `main`; that is the evidence it is an equivalence check rather
 * than a restatement of behavior a later batch introduces. The three cells where
 * the tree violated an invariant this workstream states were declared in a
 * `KNOWN_CONTRACT_GAPS` table that withheld their op shapes from the generator
 * and carried one still-reproduces test each. All three are now closed, each in
 * the diff that measurably closed it, and the table is gone. What replaces it is
 * the `closed contract gaps` block below: the SAME scripts those reproductions
 * ran, with every assertion turned around. The generator draws from the whole
 * op vocabulary again.
 */
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  type Node,
  type RecordedInstant,
} from "../../../src";
import type { GraphBackend } from "../../../src/backend/types";
import {
  recordedInstantRevision,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import { mergeKey } from "../../../src/graph-merge/node-key";
import { asBranchId, type BranchId } from "../../../src/graph-merge/types";
import {
  resolveEndClaims,
  resolveValidWindows,
  WINDOW_NOT_APPLICABLE_DROP_REASON,
} from "../../../src/graph-merge/valid-window";
import {
  exportGraph,
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../../src/interchange";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { canonicalizeDatabaseTimestamp } from "../../../src/utils/date";
import { requireDefined } from "../../../src/utils/presence";
import { recordedInstantFromDriver } from "../../test-utils";
import {
  allLedgerRows,
  type Instant,
  intervalIsEmpty,
  intervalOf,
  type LedgerRow,
  liveLedgerRows,
  readTemporalLedger,
  type RowKey,
  rowKeyOf,
  rowSatisfiesOrderedWindow,
  TEMPORAL_OP_SHAPES,
  type TemporalCoordinate,
  type TemporalLedger,
  type TemporalOpShape,
  traversableEdgesAt,
  visibleAt,
} from "./temporal-oracle-model";
import { type IntegrationTestContext } from "./test-context";

// ============================================================
// The graph under test
// ============================================================

const OraclePerson = defineNode("OraclePerson", {
  schema: z.object({ name: z.string() }),
});

const oracleKnows = defineEdge("oracleKnows", {
  schema: z.object({ since: z.string() }),
});

/**
 * "Confirmed open-left", the one interchange value that stores
 * `valid_from = NULL`. Hoisted to a constant so the rule waiver sits on a line
 * of its own that the formatter will not reflow into the object literal.
 */
// eslint-disable-next-line unicorn/no-null -- the interchange wire value
const CONFIRMED_OPEN_LEFT = null;

const NODE_KIND = "OraclePerson";
const EDGE_KIND = "oracleKnows";

function oracleGraph(id: string) {
  return defineGraph({
    id,
    // Cascade, so a soft-deleted node takes its edges with it. The default
    // (`restrict`) would make `soft-delete` refuse whenever the generator had
    // already attached an edge, silently thinning the op vocabulary.
    nodes: { OraclePerson: { type: OraclePerson, onDelete: "cascade" } },
    edges: {
      oracleKnows: {
        type: oracleKnows,
        from: [OraclePerson],
        to: [OraclePerson],
        cardinality: "many",
      },
    },
  });
}

type OracleGraph = ReturnType<typeof oracleGraph>;
type OracleStore = ReturnType<typeof createStore<OracleGraph>>;

/** Per-process run counter: each fast-check run gets its own `graph_id` fence. */
let runSequence = 0;

function nextRunGraphId(label: string): string {
  runSequence += 1;
  return `temporal_oracle_${label}_${runSequence}`;
}

function freshStore(backend: GraphBackend, label: string): OracleStore {
  return createStore(oracleGraph(nextRunGraphId(label)), backend);
}

function freshHistoryStore(backend: GraphBackend, label: string): OracleStore {
  return createStore(oracleGraph(nextRunGraphId(label)), backend, {
    history: true,
  });
}

// ============================================================
// Budget
// ============================================================

/**
 * The one owner of the run budget. At the default this suite is honestly a SMOKE
 * gate — the boundary-heavy coordinate generator is what finds bugs, not the run
 * count — and a deep run is `TYPEGRAPH_ORACLE_RUNS=100 pnpm test`.
 *
 * Bracket access because `noPropertyAccessFromIndexSignature` is on.
 */
function oracleRunConfig(): fc.Parameters<unknown> {
  return {
    numRuns: Number(process.env["TYPEGRAPH_ORACLE_RUNS"] ?? 8),
    endOnFailure: true,
  };
}

// ============================================================
// The instant lattice
// ============================================================

/**
 * Eight canonical anchors spanning 2020 -> 2100, four strictly before any write
 * this suite makes and four strictly after. The split is what lets "a lone
 * `validTo` in the past" and "a lone `validTo` in the future" be op SHAPES
 * rather than observed outcomes, which is what makes the gap restrictions
 * deterministic.
 */
const PAST_ANCHORS = [
  "2020-01-01T00:00:00.000Z",
  "2021-06-01T00:00:00.000Z",
  "2022-01-01T00:00:00.000Z",
  "2024-03-01T00:00:00.000Z",
] as const;

const FUTURE_ANCHORS = [
  "2060-01-01T00:00:00.000Z",
  "2070-06-01T00:00:00.000Z",
  "2080-01-01T00:00:00.000Z",
  "2100-01-01T00:00:00.000Z",
] as const;

const ANCHORS: readonly Instant[] = [...PAST_ANCHORS, ...FUTURE_ANCHORS];

const FIRST_PAST_ANCHOR = requireDefined(PAST_ANCHORS[0], "past anchor");
const LAST_FUTURE_ANCHOR = requireDefined(FUTURE_ANCHORS[3], "future anchor");

function pastAnchor(pick: number): Instant {
  return requireDefined(
    PAST_ANCHORS[pick % PAST_ANCHORS.length],
    "past anchor",
  );
}

function futureAnchor(pick: number): Instant {
  return requireDefined(
    FUTURE_ANCHORS[pick % FUTURE_ANCHORS.length],
    "future anchor",
  );
}

/** A stated window whose endpoints are ordered and never zero width. */
function statedWindow(
  lowerPick: number,
  upperPick: number,
): Readonly<{ validFrom: Instant; validTo: Instant }> {
  const validFrom = pastAnchor(lowerPick);
  const candidates = ANCHORS.filter((anchor) => anchor > validFrom);
  const validTo = requireDefined(
    candidates[upperPick % candidates.length],
    "upper anchor",
  );
  return { validFrom, validTo };
}

function shiftedInstant(instant: Instant, milliseconds: number): Instant {
  return new Date(new Date(instant).getTime() + milliseconds).toISOString();
}

/**
 * Boundary-heavy coordinates: the lattice, every bound the run actually stored,
 * one millisecond either side of each, and now. Derived from the LEDGER rather
 * than from the write calls, so a write whose stored shape differs from the one
 * the script asked for is still checked against what it stored.
 */
function candidateCoordinates(ledger: TemporalLedger): readonly Instant[] {
  const bounds = allLedgerRows(ledger).flatMap((row) =>
    [row.validFrom, row.validTo].filter(
      (bound): bound is Instant => bound !== undefined,
    ),
  );
  const around = bounds.flatMap((bound) => [
    bound,
    shiftedInstant(bound, -1),
    shiftedInstant(bound, 1),
  ]);
  return [
    ...new Set([...ANCHORS, ...around, new Date().toISOString()]),
  ].toSorted();
}

function pickCoordinates(
  ledger: TemporalLedger,
  picks: readonly number[],
): readonly Instant[] {
  const candidates = candidateCoordinates(ledger);
  return [
    ...new Set(
      picks.map((pick) =>
        requireDefined(candidates[pick % candidates.length], "coordinate"),
      ),
    ),
  ];
}

// ============================================================
// The history generator
// ============================================================

type GeneratedOp = Readonly<{
  shape: TemporalOpShape;
  lowerPick: number;
  upperPick: number;
  targetPick: number;
}>;

/**
 * Exported for `tests/temporal-oracle-imports.test.ts`, which SAMPLES it to
 * assert the shapes it can draw are exactly the declared vocabulary. Comparing
 * one spelling of that vocabulary against another proves nothing; only the
 * generator's own draws can show the script really covers what the list claims.
 * This is what stood behind the gap table's restrictions while it existed, and
 * it is what keeps the reopened shapes genuinely emitted now that it is gone.
 */
export function generatedOpArb(): fc.Arbitrary<GeneratedOp> {
  return fc.record({
    shape: fc.constantFrom(...TEMPORAL_OP_SHAPES),
    lowerPick: fc.nat({ max: 7 }),
    upperPick: fc.nat({ max: 7 }),
    targetPick: fc.nat({ max: 31 }),
  });
}

type GeneratedHistory = Readonly<{
  ops: readonly GeneratedOp[];
  coordinatePicks: readonly number[];
}>;

function generatedHistoryArb(maxOps: number): fc.Arbitrary<GeneratedHistory> {
  return fc.record({
    ops: fc.array(generatedOpArb(), { minLength: 4, maxLength: maxOps }),
    coordinatePicks: fc.array(fc.nat({ max: 255 }), {
      minLength: 8,
      maxLength: 8,
    }),
  });
}

/**
 * What the SCRIPT said, as opposed to what the clock did — the only knowledge
 * the oracle keeps outside the ledger, and the only kind that cannot flake: it
 * is what the test asked for, never what a write instant happened to be.
 */
type ScriptFacts = Readonly<{
  /** `(kind, id)` -> the lower bounds some write STATED as a string. */
  statedLowerBounds: ReadonlyMap<RowKey, ReadonlySet<Instant>>;
  /** `(kind, id)` for which some write stated a lower bound at all, `null` included. */
  boundWasStated: ReadonlySet<RowKey>;
  nodeIds: readonly string[];
  edgeIds: readonly string[];
}>;

interface ScriptState {
  liveNodes: string[];
  tombstonedNodes: string[];
  allNodes: string[];
  liveEdges: string[];
  allEdges: string[];
  edgeEndpoints: Map<string, Readonly<{ from: string; to: string }>>;
  nodesById: Map<string, Node<typeof OraclePerson>>;
  namesById: Map<string, string>;
  statedLowerBounds: Map<RowKey, Set<Instant>>;
  boundWasStated: Set<RowKey>;
  sequence: number;
}

function newScriptState(): ScriptState {
  return {
    liveNodes: [],
    tombstonedNodes: [],
    allNodes: [],
    liveEdges: [],
    allEdges: [],
    edgeEndpoints: new Map(),
    nodesById: new Map(),
    namesById: new Map(),
    statedLowerBounds: new Map(),
    boundWasStated: new Set(),
    sequence: 0,
  };
}

function noteStatedLowerBound(
  state: ScriptState,
  kind: string,
  id: string,
  validFrom: Instant | undefined,
): void {
  const key = rowKeyOf({ kind, id });
  state.boundWasStated.add(key);
  if (validFrom === undefined) return;
  const bounds = state.statedLowerBounds.get(key) ?? new Set<Instant>();
  bounds.add(validFrom);
  state.statedLowerBounds.set(key, bounds);
}

function pickFrom(pool: readonly string[], pick: number): string | undefined {
  return pool.length === 0 ? undefined : pool[pick % pool.length];
}

function takeTombstoned(state: ScriptState, pick: number): string | undefined {
  if (state.tombstonedNodes.length === 0) return undefined;
  const index = pick % state.tombstonedNodes.length;
  const [id] = state.tombstonedNodes.splice(index, 1);
  return id;
}

function nextId(state: ScriptState, prefix: string): string {
  state.sequence += 1;
  return `${prefix}${state.sequence}`;
}

function trackCreatedNode(
  state: ScriptState,
  node: Node<typeof OraclePerson>,
): void {
  state.nodesById.set(node.id, node);
  state.namesById.set(node.id, node.name);
  if (!state.allNodes.includes(node.id)) state.allNodes.push(node.id);
  if (!state.liveNodes.includes(node.id)) state.liveNodes.push(node.id);
}

function dropNode(state: ScriptState, id: string): void {
  state.liveNodes = state.liveNodes.filter((candidate) => candidate !== id);
  state.tombstonedNodes.push(id);
  // `onDelete: "cascade"` takes the incident edges with the node.
  state.liveEdges = state.liveEdges.filter((edgeId) => {
    const endpoints = state.edgeEndpoints.get(edgeId);
    return (
      endpoints !== undefined && endpoints.from !== id && endpoints.to !== id
    );
  });
}

/**
 * The open-left item every history carries. Interchange is the one store-level
 * path that can state "no lower bound", and a `valid_from = NULL` row is what
 * makes the NULL-handling half of every read path load-bearing.
 *
 * It is deliberately WITHHELD from the op target pool (`liveNodes`): a history
 * that soft-deleted it would take the run's only `valid_from = NULL` row with
 * it, and with it P3's NULL-branch coverage and P6's precondition — silently,
 * on some seeds and not others. It stays in `allNodes`, so every read path and
 * the model still see it.
 */
async function importOpenLeftItem(
  store: OracleStore,
  state: ScriptState,
  upperPick: number,
): Promise<void> {
  const id = nextId(state, "n");
  const name = `open-left-${id}`;
  const data: GraphData = {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description: "temporal oracle open-left item" },
    nodes: [
      {
        kind: NODE_KIND,
        id,
        properties: { name },
        validFrom: CONFIRMED_OPEN_LEFT,
        validTo: pastAnchor(upperPick),
      },
    ],
    edges: [],
  };
  await importGraph(store, data, { onConflict: "error" });
  noteStatedLowerBound(state, NODE_KIND, id, undefined);
  state.namesById.set(id, name);
  state.allNodes.push(id);
}

async function applyNodeOp(
  store: OracleStore,
  state: ScriptState,
  op: GeneratedOp,
): Promise<boolean> {
  switch (op.shape) {
    case "create-open": {
      const id = nextId(state, "n");
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.create({ name: `open-${id}` }, { id }),
      );
      return true;
    }
    case "create-stated-window": {
      const id = nextId(state, "n");
      const window = statedWindow(op.lowerPick, op.upperPick);
      noteStatedLowerBound(state, NODE_KIND, id, window.validFrom);
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.create(
          { name: `stated-${id}` },
          { id, ...window },
        ),
      );
      return true;
    }
    case "create-scheduled-end": {
      const id = nextId(state, "n");
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.create(
          { name: `scheduled-${id}` },
          { id, validTo: futureAnchor(op.upperPick) },
        ),
      );
      return true;
    }
    case "create-born-ended": {
      const id = nextId(state, "n");
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.create(
          { name: `born-ended-${id}` },
          { id, validTo: pastAnchor(op.upperPick) },
        ),
      );
      return true;
    }
    case "create-on-tombstone":
    case "create-on-tombstone-born-ended": {
      const id = takeTombstoned(state, op.targetPick);
      if (id === undefined) return true;
      const validTo =
        op.shape === "create-on-tombstone-born-ended" ?
          { validTo: pastAnchor(op.upperPick) }
        : {};
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.create(
          { name: `revived-${id}` },
          { id, ...validTo },
        ),
      );
      return true;
    }
    case "update-props": {
      const id = pickFrom(state.liveNodes, op.targetPick);
      if (id === undefined) return true;
      const name = `updated-${id}-${state.sequence}`;
      state.namesById.set(id, name);
      await store.nodes.OraclePerson.update(asNodeId<typeof OraclePerson>(id), {
        name,
      });
      return true;
    }
    case "update-scheduled-end": {
      const id = pickFrom(state.liveNodes, op.targetPick);
      if (id === undefined) return true;
      await store.nodes.OraclePerson.update(
        asNodeId<typeof OraclePerson>(id),
        {},
        { validTo: futureAnchor(op.upperPick) },
      );
      return true;
    }
    case "soft-delete": {
      const id = pickFrom(state.liveNodes, op.targetPick);
      if (id === undefined) return true;
      await store.nodes.OraclePerson.delete(asNodeId<typeof OraclePerson>(id));
      dropNode(state, id);
      return true;
    }
    case "upsert-resurrect":
    case "upsert-resurrect-born-ended": {
      const id = takeTombstoned(state, op.targetPick);
      if (id === undefined) return true;
      const name = `resurrected-${id}`;
      state.namesById.set(id, name);
      const options =
        op.shape === "upsert-resurrect-born-ended" ?
          { validTo: pastAnchor(op.upperPick) }
        : {};
      trackCreatedNode(
        state,
        await store.nodes.OraclePerson.upsertById(id, { name }, options),
      );
      return true;
    }
    case "upsert-unchanged": {
      const id = pickFrom(state.liveNodes, op.targetPick);
      if (id === undefined) return true;
      const name = requireDefined(state.namesById.get(id), "tracked name");
      await store.nodes.OraclePerson.upsertById(id, { name });
      return true;
    }
    case "bulk-create": {
      const first = nextId(state, "n");
      const second = nextId(state, "n");
      const created = await store.nodes.OraclePerson.bulkCreate([
        { props: { name: `bulk-${first}` }, id: first },
        {
          props: { name: `bulk-${second}` },
          id: second,
          validTo: futureAnchor(op.upperPick),
        },
      ]);
      for (const node of created) trackCreatedNode(state, node);
      return true;
    }
    case "bulk-upsert-repeated-id": {
      const id = nextId(state, "n");
      const name = `repeated-${id}-final`;
      state.namesById.set(id, name);
      const upserted = await store.nodes.OraclePerson.bulkUpsertById([
        { id, props: { name: `repeated-${id}-first` } },
        { id, props: { name } },
      ]);
      for (const node of upserted) trackCreatedNode(state, node);
      return true;
    }
    // The edge half of the vocabulary, handled by `applyEdgeOp`. Named rather
    // than defaulted so a new shape is a compile error here, not a silent no-op.
    case "edge-create-open":
    case "edge-create-stated-window":
    case "edge-create-scheduled-end":
    case "edge-create-born-ended":
    case "edge-soft-delete": {
      return false;
    }
  }
}

/** The edge-create shapes, i.e. every edge shape but the soft delete. */
type EdgeCreateShape = Exclude<
  Extract<TemporalOpShape, `edge-${string}`>,
  "edge-soft-delete"
>;

function edgeWindowOptions(
  state: ScriptState,
  id: string,
  op: GeneratedOp & Readonly<{ shape: EdgeCreateShape }>,
): Readonly<{ validFrom?: Instant; validTo?: Instant }> {
  switch (op.shape) {
    case "edge-create-stated-window": {
      const window = statedWindow(op.lowerPick, op.upperPick);
      noteStatedLowerBound(state, EDGE_KIND, id, window.validFrom);
      return window;
    }
    case "edge-create-scheduled-end": {
      return { validTo: futureAnchor(op.upperPick) };
    }
    case "edge-create-born-ended": {
      return { validTo: pastAnchor(op.upperPick) };
    }
    case "edge-create-open": {
      return {};
    }
  }
}

function isEdgeCreateOp(
  op: GeneratedOp,
): op is GeneratedOp & Readonly<{ shape: EdgeCreateShape }> {
  return op.shape.startsWith("edge-create-");
}

async function applyEdgeOp(
  store: OracleStore,
  state: ScriptState,
  op: GeneratedOp,
): Promise<void> {
  if (op.shape === "edge-soft-delete") {
    const id = pickFrom(state.liveEdges, op.targetPick);
    if (id === undefined) return;
    await store.edges.oracleKnows.delete(asEdgeId<typeof oracleKnows>(id));
    state.liveEdges = state.liveEdges.filter((candidate) => candidate !== id);
    return;
  }
  if (!isEdgeCreateOp(op)) return;
  if (state.liveNodes.length < 2) return;
  const fromId = requireDefined(
    pickFrom(state.liveNodes, op.targetPick),
    "edge source",
  );
  const toId = requireDefined(
    pickFrom(state.liveNodes, op.targetPick + 1),
    "edge target",
  );
  const from = state.nodesById.get(fromId);
  const to = state.nodesById.get(toId);
  if (from === undefined || to === undefined) return;
  const id = nextId(state, "e");
  const options = edgeWindowOptions(state, id, op);
  await store.edges.oracleKnows.create(
    from,
    to,
    { since: `since-${id}` },
    { id, ...options },
  );
  state.allEdges.push(id);
  state.liveEdges.push(id);
  state.edgeEndpoints.set(id, { from: fromId, to: toId });
}

async function runHistory(
  store: OracleStore,
  history: GeneratedHistory,
  afterOp?: () => Promise<void>,
): Promise<ScriptFacts> {
  const state = newScriptState();
  await importOpenLeftItem(store, state, history.ops.length);
  await afterOp?.();
  // Three ordinary creates seed the history so the generated script has
  // something to act on. Without them a run whose ops all need an existing row
  // degenerates to the open-left item alone: the edge shapes never fire, and the
  // STAMPED lower bound — the shape P2's equality clause is about — is absent
  // from the run entirely.
  //
  // The FIRST is pinned out of the op target pool for the same reason the
  // open-left item is: between them the two guarantee the export carries one row
  // of each lower-bound shape (`NULL` and stamped), so P6's preconditions are
  // properties of the harness rather than of the seed fast-check happened to
  // draw. The other two are ordinary targets.
  for (const [index, seed] of ["pinned", "seed-a", "seed-b"].entries()) {
    const id = nextId(state, "n");
    const node = await store.nodes.OraclePerson.create(
      { name: `${seed}-${id}` },
      { id },
    );
    if (index === 0) {
      state.nodesById.set(node.id, node);
      state.namesById.set(node.id, node.name);
      state.allNodes.push(node.id);
    } else {
      trackCreatedNode(state, node);
    }
    await afterOp?.();
  }
  for (const op of history.ops) {
    const handled = await applyNodeOp(store, state, op);
    if (!handled) await applyEdgeOp(store, state, op);
    await afterOp?.();
  }
  return {
    statedLowerBounds: state.statedLowerBounds,
    boundWasStated: state.boundWasStated,
    nodeIds: state.allNodes,
    edgeIds: state.allEdges,
  };
}

// ============================================================
// Assertions
// ============================================================

function describeRow(row: LedgerRow): string {
  return `${row.relation} ${rowKeyOf(row)} [${row.validFrom ?? "NULL"}, ${row.validTo ?? "NULL"})`;
}

/**
 * P1 (I1): no stored window is backwards, on any of the four relations.
 *
 * Quantified over `allLedgerRows`, so the caller decides the scope by deciding
 * what it read. The `recorded_*` half is NOT decoration: those columns have
 * their own binder (`recordedCommonCells` in
 * `src/store/recorded-capture/relations.ts`), i.e. the second of the two write
 * paths I1 covers, and a live store has no such rows to read. That is why this
 * runs in the P5 property too, over a history store's full ledger.
 */
function assertOrderedWindows(ledger: TemporalLedger): void {
  const violations = allLedgerRows(ledger)
    .filter((row) => !rowSatisfiesOrderedWindow(row))
    .map((row) => describeRow(row));
  expect(violations).toEqual([]);
}

/**
 * P1b (I1b): a bound nobody stated never yields a window empty at every instant.
 *
 * Emptiness is the MODEL's decision (`intervalIsEmpty`), never a second
 * comparison spelled here: this assertion's inputs change shape in the batch
 * that lifts the born-ended restrictions, and a private copy would be edited on
 * its own exactly then. Same scope as {@link assertOrderedWindows}, for the
 * same reason.
 */
function assertStampedBoundsAreNonEmpty(
  ledger: TemporalLedger,
  facts: ScriptFacts,
): void {
  const violations = allLedgerRows(ledger)
    .filter((row) => !facts.boundWasStated.has(rowKeyOf(row)))
    .filter((row) => intervalIsEmpty(intervalOf(row)))
    .map((row) => describeRow(row));
  expect(violations).toEqual([]);
}

/**
 * P2 (I2): bound provenance, scoped to what the ledger can classify.
 *
 * The never-updated clause is an EQUALITY, not a range: it is the ledger's only
 * detector for an insert builder that reads its own clock instead of binding the
 * timestamp it stamps into `created_at`. The reset-by-resurrection clause admits
 * the bounds the SCRIPT stated — script knowledge, not clock knowledge — because
 * a resurrection writes a stated bound verbatim and it may legitimately precede
 * `created_at`.
 */
function assertBoundProvenance(
  ledger: TemporalLedger,
  facts: ScriptFacts,
): void {
  const violations: string[] = [];
  for (const row of liveLedgerRows(ledger)) {
    if (row.validFrom === undefined) continue;
    const stated =
      facts.statedLowerBounds.get(rowKeyOf(row)) ?? new Set<Instant>();
    if (stated.has(row.validFrom)) continue;
    const neverUpdated =
      (row.version === undefined || row.version === 1) &&
      row.createdAt === row.updatedAt &&
      row.deletedAt === undefined;
    if (neverUpdated) {
      if (row.validFrom !== row.createdAt) {
        violations.push(
          `${describeRow(row)} valid_from != created_at ${row.createdAt}`,
        );
      }
      continue;
    }
    if (row.validFrom < row.createdAt || row.validFrom > row.updatedAt) {
      violations.push(
        `${describeRow(row)} outside [${row.createdAt}, ${row.updatedAt}]`,
      );
    }
  }
  expect(violations).toEqual([]);
}

function nodeKeys(ids: readonly string[]): readonly RowKey[] {
  return ids.map((id) => rowKeyOf({ kind: NODE_KIND, id })).toSorted();
}

function edgeKeys(ids: readonly string[]): readonly RowKey[] {
  return ids.map((id) => rowKeyOf({ kind: EDGE_KIND, id })).toSorted();
}

function definedIds(
  rows: readonly (Readonly<{ id: string }> | undefined)[],
): readonly string[] {
  return rows
    .filter((row) => row !== undefined)
    .map((row) => requireDefined(row, "row").id);
}

/** P3 (I3/I4/I6/I7): the four-way visibility equality at one coordinate. */
async function assertVisibilityAgreesAt(
  store: OracleStore,
  ledger: TemporalLedger,
  facts: ScriptFacts,
  asOf: Instant,
): Promise<void> {
  const coordinate: TemporalCoordinate = { mode: "asOf", asOf };
  const options = { temporalMode: "asOf", asOf } as const;

  const compiled = await store
    .query()
    .from("OraclePerson", "p")
    .temporal("asOf", asOf)
    .select((ctx) => ctx.p.id)
    .execute();
  const collection = await store.nodes.OraclePerson.find(
    { limit: 500 },
    options,
  );
  const byIds = await store.nodes.OraclePerson.getByIds(
    facts.nodeIds.map((id) => asNodeId<typeof OraclePerson>(id)),
    options,
  );

  const expectedNodes = visibleAt(ledger.nodes, coordinate);
  expect({
    at: asOf,
    compiled: nodeKeys(compiled),
    collection: nodeKeys(collection.map((node) => node.id)),
    byIds: nodeKeys(definedIds(byIds)),
  }).toEqual({
    at: asOf,
    compiled: expectedNodes,
    collection: expectedNodes,
    byIds: expectedNodes,
  });

  const edgeCollection = await store.edges.oracleKnows.find(
    { limit: 500 },
    options,
  );
  const edgeByIds = await store.edges.oracleKnows.getByIds(
    facts.edgeIds.map((id) => asEdgeId<typeof oracleKnows>(id)),
    options,
  );
  const traversed = await store
    .query()
    .from("OraclePerson", "p")
    .temporal("asOf", asOf)
    .traverse("oracleKnows", "e")
    .to("OraclePerson", "q")
    .select((ctx) => ctx.e.id)
    .execute();

  const expectedEdges = visibleAt(ledger.edges, coordinate);
  expect({
    at: asOf,
    collection: edgeKeys(edgeCollection.map((edge) => edge.id)),
    byIds: edgeKeys(definedIds(edgeByIds)),
    traversed: edgeKeys([...new Set(traversed)]),
  }).toEqual({
    at: asOf,
    collection: expectedEdges,
    byIds: expectedEdges,
    traversed: traversableEdgesAt(ledger, coordinate),
  });
}

type WindowedRow = Readonly<{
  id: string;
  meta: Readonly<{
    validFrom: string | undefined;
    validTo: string | undefined;
  }>;
}>;

/**
 * A projected window reduced to the two facts both normalization owners are
 * required to agree on: WHICH BOUNDS EXIST, byte-exactly (an `undefined` bound
 * and a `null` one are different answers), and WHICH INSTANT each names.
 *
 * The third fact — how the instant is RENDERED — is deliberately not compared,
 * because it measurably differs today. This is a declared divergence tracked as
 * issue #463, not an oversight, and it was found by this property:
 *
 *   postgres.js, `store.query().select((ctx) => ctx.p)`
 *     meta.validFrom = "2026-08-09 10:36:26.73+00"     (raw driver text)
 *   postgres.js, `store.nodes.Kind.getByIds(...)`
 *     meta.validFrom = "2026-08-09T10:36:26.730Z"      (canonical ISO)
 *
 * The store path routes every metadata timestamp through `formatTimestamp`
 * (`src/backend/row-mappers.ts`); the query path casts the driver's value
 * straight through (`src/query/execution/result-mapper.ts`). better-sqlite3,
 * libsql, PGlite and node-postgres all hand back a value that is already
 * canonical, so the two owners agree there and the divergence is invisible —
 * which is exactly why it needed a property run on EVERY driver to surface.
 *
 * Filed as #463 for its own fix: it is a pre-existing defect in the query path's
 * normalization, not in the temporal contract this workstream changes, and
 * making the query path canonical is an observable change to what a compiled
 * query returns on postgres.js, so it needs its own changeset.
 *
 * What is NOT waived while #463 stands is the SHAPE of the divergence, which
 * {@link assertBoundsAreStrings} pins: the query path asserts `as string | null`
 * over a value it never normalizes, so a driver handing back `Date` objects
 * would widen "different text for the same instant" into "a different type",
 * silently — this canonicalizing comparison would not notice, and the pin is
 * what does.
 */
function windowsById(rows: readonly WindowedRow[]) {
  return rows
    .map((row) => ({
      id: row.id,
      hasLowerBound: row.meta.validFrom !== undefined,
      hasUpperBound: row.meta.validTo !== undefined,
      lowerInstant: canonicalizeDatabaseTimestamp(row.meta.validFrom),
      upperInstant: canonicalizeDatabaseTimestamp(row.meta.validTo),
    }))
    .toSorted((left, right) => (left.id < right.id ? -1 : 1));
}

/**
 * Every present bound is a `string` at RUNTIME, on both owners.
 *
 * `result-mapper.ts` asserts `as string | null` over a driver value it never
 * normalizes, so this is a check against a type lie, not a restatement of the
 * type: on a PostgreSQL `TIMESTAMPTZ` column a driver is free to hand back a
 * `Date`, and today none of the five in the matrix does. It is stated
 * absolutely rather than as an equality between the two owners, because two
 * owners that BOTH started returning `Date` would satisfy an equality.
 */
function assertBoundsAreStrings(
  label: string,
  rows: readonly WindowedRow[],
): void {
  const types = new Set<string>();
  for (const row of rows) {
    for (const bound of [row.meta.validFrom, row.meta.validTo]) {
      if (bound !== undefined) types.add(typeof bound);
    }
  }
  // Set, not per-row: a failure names the type, and every history stores at
  // least one bound of each kind, so an empty set would be a harness bug.
  expect({ label, types: [...types].toSorted() }).toEqual({
    label,
    types: ["string"],
  });
}

/**
 * P4': the window a compiled query projects names the same bounds, and the same
 * instants, as the window a store read returns — `undefined` included.
 * `valid_from` has two normalization owners and only one of them routes through
 * `formatTimestamp`; see {@link windowsById} for what that costs today (#463)
 * and {@link assertBoundsAreStrings} for the part of it that is still pinned.
 */
async function assertProjectionParity(
  store: OracleStore,
  facts: ScriptFacts,
): Promise<void> {
  const projected = await store
    .query()
    .from("OraclePerson", "p")
    .temporal("includeTombstones")
    .select((ctx) => ctx.p)
    .execute();
  const read = await store.nodes.OraclePerson.getByIds(
    facts.nodeIds.map((id) => asNodeId<typeof OraclePerson>(id)),
    { temporalMode: "includeTombstones" },
  );
  const readRows = read
    .filter((node) => node !== undefined)
    .map((node) => requireDefined(node, "node"));

  assertBoundsAreStrings("compiled query", projected);
  assertBoundsAreStrings("store read", readRows);
  expect(windowsById(projected)).toStrictEqual(windowsById(readRows));
}

// ============================================================
// The gap-CLOSED tests, one per cell the gap table used to declare
// ============================================================

async function storedRow(
  backend: GraphBackend,
  store: OracleStore,
  id: string,
): Promise<LedgerRow> {
  const ledger = await readTemporalLedger(
    { backend, graphId: store.graphId },
    { includeRecorded: false },
  );
  return requireDefined(
    ledger.nodes.find((row) => row.id === id),
    `stored row ${id}`,
  );
}

/**
 * What the three gap entries used to excuse, restated as what the tree now does.
 * These are the SAME scripts their reproductions ran — a lone past `validTo` on
 * a fresh id, on a tombstoned id, and through the resurrecting `upsertById` that
 * used to REFUSE it — with every assertion turned around: no lower bound instead
 * of a stamped one, an ordered window instead of a backwards one, a row readable
 * before its end instead of at no coordinate at all, and an accepted write
 * instead of a `ValidationError`. Keeping the scripts and inverting the
 * expectations is what makes these a closure record rather than three unrelated
 * tests that happen to be green.
 *
 * All three variants assert the SAME stored shape, which is I12 itself: one
 * stated window through three entry points reaches one outcome. The tombstoned
 * `create` is the one that fails if `buildUpdateNode`'s resurrection leg is left
 * on the old resolver while the eight insert builders are rewired; the
 * `upsertById` variant is the one that fails if `performNodeUpdate`'s
 * resurrection leg judges the raw instant instead of the bound the write stores.
 */
async function assertBornEndedWriteStoresNoLowerBound(
  context: IntegrationTestContext,
  variant: Readonly<{
    label: string;
    id: string;
    tombstoneFirst: boolean;
    entryPoint: "create" | "upsertById";
  }>,
): Promise<void> {
  const backend = context.getBackend();
  const store = freshStore(backend, variant.label);
  const nodeId = asNodeId<typeof OraclePerson>(variant.id);
  if (variant.tombstoneFirst) {
    await store.nodes.OraclePerson.create(
      { name: "first" },
      { id: variant.id },
    );
    await store.nodes.OraclePerson.delete(nodeId);
  }

  const created =
    variant.entryPoint === "create" ?
      await store.nodes.OraclePerson.create(
        { name: "born ended" },
        { id: variant.id, validTo: FIRST_PAST_ANCHOR },
      )
    : await store.nodes.OraclePerson.upsertById(
        variant.id,
        { name: "born ended" },
        { validTo: FIRST_PAST_ANCHOR },
      );
  expect(created.meta.validFrom).toBeUndefined();
  expect(created.meta.validTo).toBe(FIRST_PAST_ANCHOR);

  const row = await storedRow(backend, store, variant.id);
  expect(row.validTo).toBe(FIRST_PAST_ANCHOR);
  expect(row.validFrom).toBeUndefined();
  expect(rowSatisfiesOrderedWindow(row)).toBe(true);
  expect(intervalIsEmpty(intervalOf(row))).toBe(false);

  // "Ended at T, start unknown": readable at every coordinate before its end,
  // at none from its end onward. The upper bound is half-open, so the end
  // instant itself is already outside.
  for (const at of ["2019-01-01T00:00:00.000Z", "2019-12-31T23:59:59.999Z"]) {
    await expect(
      store.nodes.OraclePerson.getById(nodeId, {
        temporalMode: "asOf",
        asOf: at,
      }),
    ).resolves.toBeDefined();
  }
  for (const at of [FIRST_PAST_ANCHOR, LAST_FUTURE_ANCHOR]) {
    await expect(
      store.nodes.OraclePerson.getById(nodeId, {
        temporalMode: "asOf",
        asOf: at,
      }),
    ).resolves.toBeUndefined();
  }
}

// ============================================================
// The recorded axis
// ============================================================

type ClockRow = Readonly<{ recorded_at: unknown; revision: unknown }>;

async function readRecordedClock(
  backend: GraphBackend,
  graphId: string,
): Promise<RecordedInstant | undefined> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<ClockRow>(
    asCompiledRowsSql(sql`
      SELECT revision, recorded_at
      FROM ${schema.recordedClockTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  return recordedInstantFromDriver(row.revision, row.recorded_at);
}

/**
 * P5: the bitemporal grid. Two assertions per cell, because they exercise
 * different halves of `compileTemporalFilter`: an explicit valid coordinate, and
 * `current` mode pinned to the recorded instant (which must mean "valid-current
 * as of THAT instant", not "as of the wall clock at read time").
 */
async function assertRecordedGridAgrees(
  store: OracleStore,
  ledger: TemporalLedger,
  facts: ScriptFacts,
  recorded: RecordedInstant,
  coordinates: readonly Instant[],
): Promise<void> {
  const revision = recordedInstantRevision(recorded);
  const ids = facts.nodeIds.map((id) => asNodeId<typeof OraclePerson>(id));

  for (const at of coordinates) {
    const seen = await store
      .asOf(at)
      .asOfRecorded(recorded)
      .nodes.OraclePerson.getByIds(ids);
    expect({ at, seen: nodeKeys(definedIds(seen)) }).toEqual({
      at,
      seen: visibleAt(ledger.recordedNodes, {
        mode: "asOf",
        asOf: at,
        revision,
      }),
    });
  }

  const pinned = await store
    .view({ mode: "current" })
    .asOfRecorded(recorded)
    .nodes.OraclePerson.getByIds(ids);
  expect(nodeKeys(definedIds(pinned))).toEqual(
    visibleAt(ledger.recordedNodes, {
      mode: "asOf",
      asOf: recordedInstantWallTime(recorded),
      revision,
    }),
  );
}

// ============================================================
// Registration
// ============================================================

export function registerTemporalOracleIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Temporal oracle", () => {
    it("brackets every write instant with the anchor lattice", () => {
      // The generator's op SHAPES are defined by "past" and "future" relative to
      // the run's own writes. If the wall clock ever leaves the bracket, say so
      // here rather than through a mystifying property failure.
      const now = new Date().toISOString();
      expect(PAST_ANCHORS.every((anchor) => anchor < now)).toBe(true);
      expect(FUTURE_ANCHORS.every((anchor) => anchor > now)).toBe(true);
    });

    describe("closed contract gaps", () => {
      it("closed: a born-ended create on a fresh id stores no lower bound and reads back before its end", async () => {
        await assertBornEndedWriteStoresNoLowerBound(context, {
          label: "closed_insert",
          id: "f1",
          tombstoneFirst: false,
          entryPoint: "create",
        });
      });

      it("closed: a born-ended create on a tombstoned id stores the same shape as on a fresh id", async () => {
        await assertBornEndedWriteStoresNoLowerBound(context, {
          label: "closed_tombstone",
          id: "t1",
          tombstoneFirst: true,
          entryPoint: "create",
        });
      });

      it("closed: a born-ended upsertById on a tombstoned id stores that shape too, instead of refusing", async () => {
        await assertBornEndedWriteStoresNoLowerBound(context, {
          label: "closed_resurrect",
          id: "u1",
          tombstoneFirst: true,
          entryPoint: "upsertById",
        });
      });
    });

    it("stores no window readable at no coordinate, and stamps no bound it did not judge (P1/P1b/P2)", async () => {
      await fc.assert(
        fc.asyncProperty(generatedHistoryArb(12), async (history) => {
          const backend = context.getBackend();
          const store = freshStore(backend, "ledger");
          const facts = await runHistory(store, history);
          const ledger = await readTemporalLedger(
            { backend, graphId: store.graphId },
            { includeRecorded: false },
          );
          assertOrderedWindows(ledger);
          assertStampedBoundsAreNonEmpty(ledger, facts);
          assertBoundProvenance(ledger, facts);
        }),
        oracleRunConfig(),
      );
    });

    it("returns the same rows through the compiler, the collection filter, the in-memory matcher and the model (P3/P4')", async () => {
      await fc.assert(
        fc.asyncProperty(generatedHistoryArb(12), async (history) => {
          const backend = context.getBackend();
          const store = freshStore(backend, "visibility");
          const facts = await runHistory(store, history);
          const ledger = await readTemporalLedger(
            { backend, graphId: store.graphId },
            { includeRecorded: false },
          );
          for (const at of pickCoordinates(ledger, history.coordinatePicks)) {
            await assertVisibilityAgreesAt(store, ledger, facts, at);
          }
          await assertProjectionParity(store, facts);
        }),
        oracleRunConfig(),
      );
    });

    describe("bitemporal grid", () => {
      beforeEach(async () => {
        // Provisions the recorded relations over THIS test's backend. It must be
        // a nested `beforeEach`, not `beforeAll`: the suite assigns its backend
        // in its own `beforeEach`, and `createHistoryStore` throws while that is
        // still undefined. Every run below then uses a BARE history store over
        // these already-provisioned tables.
        await context.createHistoryStore(
          oracleGraph(nextRunGraphId("recorded_provisioning")),
        );
      });

      it("pins a current-mode recorded read to the instant it was recorded, not the wall clock (P5)", async () => {
        // The grid property below cannot reach this cell: its coordinates come
        // off an anchor lattice decades away from the run's own instants, so
        // "the recorded wall time" and "the wall clock at read time" pick the
        // same rows however the current branch resolves its instant. The cell
        // needs a row whose window ENDS between the two, which needs the clock.
        //
        // Only `Date` is faked (driver timers keep running), the shape
        // `recorded-time.ts` already uses on every backend in this matrix.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          vi.setSystemTime(new Date("2000-06-01T12:00:00.000Z"));
          const backend = context.getBackend();
          const store = freshHistoryStore(backend, "recorded_pin");
          const node = await store.nodes.OraclePerson.create(
            { name: "valid when recorded" },
            {
              id: "pinned",
              validFrom: "2000-01-01T00:00:00.000Z",
              validTo: "2000-06-01T12:00:01.000Z",
            },
          );
          const recorded = requireDefined(
            await readRecordedClock(backend, store.graphId),
            "recorded clock",
          );
          // Precondition: the row was genuinely valid-current when recorded.
          expect(
            recordedInstantWallTime(recorded) < "2000-06-01T12:00:01.000Z",
          ).toBe(true);

          // The wall clock moves past the row's end. A current-mode read pinned
          // to the recorded instant must still reconstruct the row as it was
          // THEN; a read that resolved "now" from the wall clock would drop it.
          vi.setSystemTime(new Date("2000-06-01T12:00:02.000Z"));

          const ledger = await readTemporalLedger(
            { backend, graphId: store.graphId },
            { includeRecorded: true },
          );
          const pinned = await store
            .view({ mode: "current" })
            .asOfRecorded(recorded)
            .nodes.OraclePerson.getByIds([node.id]);
          expect(nodeKeys(definedIds(pinned))).toEqual(
            visibleAt(ledger.recordedNodes, {
              mode: "asOf",
              asOf: recordedInstantWallTime(recorded),
              revision: recordedInstantRevision(recorded),
            }),
          );
          expect(nodeKeys(definedIds(pinned))).toEqual([
            rowKeyOf({ kind: NODE_KIND, id: "pinned" }),
          ]);
        } finally {
          vi.useRealTimers();
        }
      });

      it("agrees with the model on the asOfRecorded x asOf grid, and stores no unreadable window on the recorded relations (P5/P1/P1b)", async () => {
        await fc.assert(
          fc.asyncProperty(generatedHistoryArb(6), async (history) => {
            const backend = context.getBackend();
            const store = freshHistoryStore(backend, "recorded");
            const revisions: RecordedInstant[] = [];
            const facts = await runHistory(store, history, async () => {
              const instant = await readRecordedClock(backend, store.graphId);
              if (instant !== undefined) revisions.push(instant);
            });
            const ledger = await readTemporalLedger(
              { backend, graphId: store.graphId },
              { includeRecorded: true },
            );
            // I1/I1b over the RECORDED relations, which no other property can
            // reach: `recorded_nodes` / `recorded_edges` are written by their
            // own column binder and only a history store has any. Asserted
            // here rather than in P5's equality below, because that equality
            // derives its expectation from these same rows and so cannot see a
            // storage violation in them.
            assertOrderedWindows(ledger);
            assertStampedBoundsAreNonEmpty(ledger, facts);
            const coordinates = pickCoordinates(
              ledger,
              history.coordinatePicks.slice(0, 3),
            );
            const sampled = new Map(
              revisions.map((instant) => [
                recordedInstantRevision(instant),
                instant,
              ]),
            );
            for (const recorded of sampled.values()) {
              await assertRecordedGridAgrees(
                store,
                ledger,
                facts,
                recorded,
                coordinates,
              );
            }
          }),
          oracleRunConfig(),
        );
      });
    });

    it("round-trips every stored window through interchange, NULL included (P6)", async () => {
      await fc.assert(
        fc.asyncProperty(generatedHistoryArb(8), async (history) => {
          const backend = context.getBackend();
          const source = freshStore(backend, "roundtrip_source");
          await runHistory(source, history);
          const exported = await exportGraph(source, { includeTemporal: true });

          // Precondition, not decoration: `validFrom` is emitted only under
          // `includeTemporal`, so without this the comparison below could be
          // vacuously true.
          expect(exported.nodes.some((node) => node.validFrom === null)).toBe(
            true,
          );
          expect(
            exported.nodes.some((node) => typeof node.validFrom === "string"),
          ).toBe(true);

          const target = freshStore(backend, "roundtrip_target");
          await importGraph(target, exported, { onConflict: "error" });
          const targetLedger = await readTemporalLedger(
            { backend, graphId: target.graphId },
            { includeRecorded: false },
          );
          const stored = new Map(
            targetLedger.nodes.map((row) => [row.id, row]),
          );
          const roundTripped = exported.nodes.map((node) => {
            const row = requireDefined(
              stored.get(node.id),
              `round-tripped ${node.id}`,
            );
            return {
              id: node.id,
              validFrom: row.validFrom,
              validTo: row.validTo,
            };
          });
          expect(roundTripped).toStrictEqual(
            exported.nodes.map((node) => ({
              id: node.id,
              validFrom: node.validFrom ?? undefined,
              validTo: node.validTo,
            })),
          );
        }),
        oracleRunConfig(),
      );
    });

    describe("merge window laws (P7)", () => {
      it("resolves an end-claim set independently of its order", () => {
        fc.assert(
          fc.property(
            fc.array(
              fc.record({
                branchId: fc.constantFrom("a", "b", "c"),
                validTo: fc.constantFrom(...ANCHORS),
              }),
              { minLength: 1, maxLength: 6 },
            ),
            fc.option(fc.constantFrom("a", "b", "c"), { nil: undefined }),
            (rawClaims, rawPreferred) => {
              const claims = rawClaims.map((claim) => ({
                branchId: asBranchId(claim.branchId),
                validTo: claim.validTo,
              }));
              const preferred: BranchId | undefined =
                rawPreferred === undefined ? undefined : (
                  asBranchId(rawPreferred)
                );
              expect(resolveEndClaims(claims.toReversed(), preferred)).toBe(
                resolveEndClaims(claims, preferred),
              );
            },
          ),
          { numRuns: 100 },
        );
      });

      it("lets a deletion absorb an ending and reports an unapplicable validFrom divergence", () => {
        const branchId = asBranchId("fork");
        const windowedNode = (
          id: string,
          fork: Readonly<{ validFrom: Instant; validTo?: Instant }>,
        ) => ({
          branchId,
          node: {
            id: asNodeId<typeof OraclePerson>(id),
            kind: NODE_KIND,
            base: { validFrom: FIRST_PAST_ANCHOR, validTo: undefined },
            fork: { validFrom: fork.validFrom, validTo: fork.validTo },
          },
        });

        const resolution = resolveValidWindows(
          {
            windowedNodes: [
              windowedNode("absorbed", {
                validFrom: FIRST_PAST_ANCHOR,
                validTo: LAST_FUTURE_ANCHOR,
              }),
              windowedNode("diverged", { validFrom: pastAnchor(1) }),
            ],
            windowedEdges: [],
          },
          new Set([mergeKey(NODE_KIND, "absorbed")]),
          new Set(),
        );

        // Deletion absorbs the ending: the row the merge finally deletes gets no
        // end to write, and no conflict.
        expect([...resolution.nodeEnds.keys()]).toEqual([]);
        // A `validFrom` divergence the commit cannot apply is REPORTED.
        expect(
          resolution.dropped.map((item) => ({
            id: String(item.id),
            reason: item.reason,
          })),
        ).toEqual([
          { id: "diverged", reason: WINDOW_NOT_APPLICABLE_DROP_REASON },
        ]);
      });
    });
  });
}
