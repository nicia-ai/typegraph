/**
 * Composition windows — "a part holds exactly one whole" at every valid-time
 * coordinate, not only now.
 *
 * The composition claim (`./composition-claims.ts`) fences the CURRENT half of
 * the invariant: one claim row per part, held by its one open attachment. A
 * `population: "oneActive"` pair also keeps history — ended rows that a
 * valid-time read (`store.asOf(t)` with `parts()`, `wholes()` or
 * `subgraph({ composition })`) returns at every `t` inside their window — and a
 * claim row can say "one open row" but not "these intervals are disjoint". So
 * the valid-time half is a decision of its own: for one part, the windows of
 * its composition edges on a `oneActive` pair never share an instant.
 *
 * It is a lock-only decision. No key fences interval disjointness, so the
 * stored rows it reads are protected by the per-graph write fence every
 * composition edge write already takes (`edgeComposition`), advanced and
 * checked for snapshot freshness through `fenceLockOnlyDecision` before the
 * read, exactly as the acyclicity probe and the required-existence verdict
 * do.
 *
 * This module is the ONE owner of that decision:
 *
 * - {@link compositionWindowOf} — which rows count, and over which window: a
 *   non-deleted row of a composition edge kind, read through the row-membership
 *   rule of its own kind (`membershipValidityWindow`), across every realizing
 *   edge kind that holds the part — the holder scope the composition claim keys
 *   on (`compositionHolders`, `./composition-claims.ts`).
 * - {@link planCompositionWindowDecision} / `findCompositionWindowConflict`
 *   — the pure verdict over a frame's writes and the stored rows of the parts
 *   it touches.
 * - {@link readCompositionWindowConflict} — plan, read, decide; unfenced for
 *   a planner that judges writes it has not issued yet, fenced (through its
 *   `beforeRead`) for the write paths.
 * - {@link assertCompositionWindowsDisjoint} — the fenced form every store
 *   write path calls before its first statement.
 */
import {
  type EdgeRow,
  type GraphBackend,
  type GraphReadBackend,
  type InsertEdgeParams,
} from "../../backend/types";
import { CompositionError } from "../../errors";
import { compositionPopulationMembership } from "../../registry/composition-relation";
import { type KindRegistry } from "../../registry/kind-registry";
import { compareStrings } from "../../utils/compare";
import {
  nowIso,
  resolveStampedValidityLowerBound,
  type ValidityWindow,
  validityWindowCovers,
  validityWindowsOverlap,
} from "../../utils/date";
import { nodeRefKey } from "../../utils/tuple-key";
import {
  compositionRowEndpoints,
  readCompositionEdgesAtRole,
} from "../operations/composition-cascade";
import {
  fenceLockOnlyDecision,
  type GraphWriteLock,
} from "../recorded-capture/clock";
import { pageEdgesByKind } from "../row-fetch";
import { type CompositionNodeRef } from "../types";
import { membershipValidityWindow } from "./edge-claims";

/** How many composition rows the overlap audit reads per page. */
const COMPOSITION_WINDOW_PAGE_SIZE = 500;

/** A composition edge row as the window decision reads it. */
export type CompositionWindowEdge = Pick<
  EdgeRow,
  | "id"
  | "kind"
  | "from_kind"
  | "from_id"
  | "to_kind"
  | "to_id"
  | "valid_from"
  | "valid_to"
  | "deleted_at"
>;

/**
 * One row a frame writes, as the state it leaves: `after` is the row once the
 * write lands (with `deleted_at` set for a soft delete or a retire), `before`
 * the stored row it replaces — absent for an insert.
 */
export type CompositionWindowTransition = Readonly<{
  before?: CompositionWindowEdge;
  after: CompositionWindowEdge;
}>;

/** Every composition-row write one frame makes, judged together. */
export type CompositionWindowWrites = Readonly<{
  /** Rows the frame inserts, as the insert params state them. */
  inserts?: readonly InsertEdgeParams[];
  /** Rows the frame changes in place: updates, resurrections, retires. */
  revisions?: readonly CompositionWindowTransition[];
}>;

/**
 * A row the frame writes whose window shares an instant with another
 * composition edge of the same part — another row of the frame, or a stored
 * one.
 */
export type CompositionWindowConflict = Readonly<{
  part: CompositionNodeRef;
  proposed: CompositionWindowEdge;
  incumbent: CompositionWindowEdge;
}>;

/**
 * The window over which a row counts as its part's membership at an `asOf`
 * coordinate, or `undefined` when it counts at none: a deleted row, or a row
 * of an edge kind that realizes no composition pair.
 *
 * THE membership half of this module's decision. It is the rule the
 * valid-time composition reads render in SQL (`compileEdgeMembershipFilters`,
 * fed by `compositionEdgeKindMembers`), read through
 * `membershipValidityWindow`, so the rows this decision counts for a part are
 * exactly the rows `parts()`, `wholes()` and `subgraph({ composition })` can
 * return for it.
 */
function compositionWindowOf(
  registry: KindRegistry,
  row: CompositionWindowEdge,
): ValidityWindow | undefined {
  if (row.deleted_at !== undefined) return undefined;
  const population = registry.compositionEdgePopulation(row.kind);
  if (population === undefined) return undefined;
  return membershipValidityWindow(compositionPopulationMembership(population), {
    validFrom: row.valid_from,
    validTo: row.valid_to,
  });
}

/**
 * The row an insert leaves, with the lower bound it will be stamped with
 * decided at `operationInstant` (`resolveStampedValidityLowerBound`, the owner
 * every insert builder decides through). The insert's own stamp is taken
 * later, on the same clock, so the window the decision judges always contains
 * the one the row is stored with.
 */
function insertedRow(
  params: InsertEdgeParams,
  operationInstant: string,
): CompositionWindowEdge {
  return {
    id: params.id,
    kind: params.kind,
    from_kind: params.fromKind,
    from_id: params.fromId,
    to_kind: params.toKind,
    to_id: params.toId,
    valid_from: resolveStampedValidityLowerBound(
      params.validFrom,
      params.validTo,
      operationInstant,
    ),
    valid_to: params.validTo,
    deleted_at: undefined,
  };
}

/** One judged write: its part, the row it leaves and that row's window. */
type JudgedWrite = Readonly<{
  part: CompositionNodeRef;
  after: CompositionWindowEdge;
  afterWindow: ValidityWindow | undefined;
  beforeWindow: ValidityWindow | undefined;
}>;

/**
 * What a frame's writes decide before any stored row is read: a conflict
 * between two of the frame's own rows, or the parts whose stored rows the
 * verdict still needs.
 */
export type CompositionWindowPlan = Readonly<{
  /** A conflict among the frame's own rows, decided read-free. */
  inFrameConflict: CompositionWindowConflict | undefined;
  /** The parts whose stored rows {@link findCompositionWindowConflict} must see. */
  partsToRead: readonly CompositionNodeRef[];
  /** The ids of every row the frame writes — its `after` replaces the stored row. */
  writtenEdgeIds: ReadonlySet<string>;
  /**
   * The writes of `partsToRead` that can reach a stored row — those whose
   * window is not already held by the part (see
   * {@link planCompositionWindowDecision}).
   */
  uncoveredWrites: readonly JudgedWrite[];
}>;

/**
 * The read-free half of the decision over one frame's writes.
 *
 * Only writes to an edge kind of a `population: "oneActive"` pair are judged:
 * a `population: "one"` part is held to one row for the row's whole life by
 * its claim, which already makes overlap impossible.
 *
 * Within the frame, every pair of rows one part is left with must be disjoint.
 *
 * Against stored rows, a write is judged only when it brings the part an
 * instant the part did not already hold, and only those writes make the
 * decision read:
 *
 * - a row whose window lies inside the window of a row the same frame takes
 *   it from (its own stored window, shrunk; or a `reparent`'s incumbent, whose
 *   window the move splits into the ended half and the new attachment) cannot
 *   meet a stored row that window did not already meet;
 * - a row that starts at or after `operationInstant` — the ordinary attach,
 *   whose lower bound the insert stamps — cannot meet an ended stored row,
 *   because no composition window starts or ends later than the write that
 *   stated it (`assertCompositionWindowCurrent`, audited by the
 *   `compositionFutureWindow` family), and an open stored row is the part's
 *   claim holder, which the composition claim already refuses.
 *
 * Everything else — a backdated attach, a history row, a widened or reopened
 * window, a resurrection — reads the part's stored rows.
 *
 * Pure: the merge planner calls it with the writes it plans, the write paths
 * through {@link assertCompositionWindowsDisjoint}.
 */
export function planCompositionWindowDecision(
  registry: KindRegistry,
  writes: CompositionWindowWrites,
  operationInstant: string,
): CompositionWindowPlan {
  const transitions = netTransitions(writes, operationInstant);
  const writesByPart = new Map<
    string,
    Readonly<{ part: CompositionNodeRef; writes: JudgedWrite[] }>
  >();
  const writtenEdgeIds = new Set<string>();
  for (const { before, after } of transitions) {
    writtenEdgeIds.add(after.id);
    if (registry.compositionEdgePopulation(after.kind) !== "oneActive") {
      continue;
    }
    const partSide = registry.compositionPartSide(after.kind);
    if (partSide === undefined) continue;
    const { part } = compositionRowEndpoints(partSide, after);
    const key = nodeRefKey(part);
    const group = writesByPart.get(key) ?? { part, writes: [] };
    writesByPart.set(key, group);
    group.writes.push({
      part,
      after,
      afterWindow: compositionWindowOf(registry, after),
      beforeWindow:
        before === undefined ? undefined : (
          compositionWindowOf(registry, before)
        ),
    });
  }

  const inFrameConflict = [...writesByPart.values()]
    .map((group) => firstInFrameConflict(group.writes))
    .find((conflict) => conflict !== undefined);

  const partsToRead: CompositionNodeRef[] = [];
  const uncoveredWrites: JudgedWrite[] = [];
  const opensAtOrAfterWrite: ValidityWindow = { validFrom: operationInstant };
  for (const { part, writes: partWrites } of writesByPart.values()) {
    const heldWindows = partWrites.flatMap((write) =>
      write.beforeWindow === undefined ? [] : [write.beforeWindow],
    );
    const uncovered = partWrites.filter(
      (write) =>
        write.afterWindow !== undefined &&
        !heldWindows.some((held) =>
          validityWindowCovers(held, write.afterWindow ?? {}),
        ),
    );
    const readsStoredRows = uncovered.some(
      (write) =>
        !validityWindowCovers(opensAtOrAfterWrite, write.afterWindow ?? {}),
    );
    if (readsStoredRows) {
      partsToRead.push(part);
      uncoveredWrites.push(...uncovered);
    }
  }

  return {
    inFrameConflict,
    partsToRead,
    writtenEdgeIds,
    uncoveredWrites,
  };
}

/**
 * One transition per row id: the state the frame leaves the row in (its last
 * write) and the stored state it started from (none for a row the frame
 * inserts). A frame inserts before it revises — a batch's paired updates may
 * target the rows it just inserted — so inserts are folded first.
 */
function netTransitions(
  writes: CompositionWindowWrites,
  operationInstant: string,
): readonly CompositionWindowTransition[] {
  const byId = new Map<string, CompositionWindowTransition>();
  for (const params of writes.inserts ?? []) {
    byId.set(params.id, { after: insertedRow(params, operationInstant) });
  }
  for (const { before, after } of writes.revisions ?? []) {
    const earlier = byId.get(after.id);
    byId.set(
      after.id,
      earlier === undefined ?
        { ...(before === undefined ? {} : { before }), after }
      : {
          ...(earlier.before === undefined ? {} : { before: earlier.before }),
          after,
        },
    );
  }
  return [...byId.values()];
}

/** The first two rows of one part's writes whose windows overlap, in write order. */
function firstInFrameConflict(
  partWrites: readonly JudgedWrite[],
): CompositionWindowConflict | undefined {
  for (const [index, write] of partWrites.entries()) {
    const window = write.afterWindow;
    if (window === undefined) continue;
    for (const earlier of partWrites.slice(0, index)) {
      const earlierWindow = earlier.afterWindow;
      if (earlierWindow === undefined) continue;
      if (validityWindowsOverlap(earlierWindow, window)) {
        return {
          part: write.part,
          proposed: write.after,
          incumbent: earlier.after,
        };
      }
    }
  }
  return undefined;
}

/**
 * THE verdict: the first conflict a frame's writes leave, or `undefined` when
 * every part they touch keeps pairwise-disjoint windows.
 *
 * `storedRowsByPart` holds, keyed by `nodeRefKey(part)`, the stored
 * composition rows of every part in `plan.partsToRead` — as
 * {@link readCompositionWindowRows} reads them. Stored rows the frame itself
 * writes are judged by their `after` instead.
 *
 * Stored rows are taken in `(validFrom, id)` order, so the incumbent a
 * refusal names is deterministic.
 */
function findCompositionWindowConflict(
  registry: KindRegistry,
  plan: CompositionWindowPlan,
  storedRowsByPart: ReadonlyMap<string, readonly CompositionWindowEdge[]>,
): CompositionWindowConflict | undefined {
  if (plan.inFrameConflict !== undefined) return plan.inFrameConflict;
  for (const write of plan.uncoveredWrites) {
    const window = write.afterWindow;
    if (window === undefined) continue;
    const stored = (storedRowsByPart.get(nodeRefKey(write.part)) ?? [])
      .filter((row) => !plan.writtenEdgeIds.has(row.id))
      .toSorted(
        (left, right) =>
          compareStrings(left.valid_from ?? "", right.valid_from ?? "") ||
          compareStrings(left.id, right.id),
      );
    for (const row of stored) {
      const storedWindow = compositionWindowOf(registry, row);
      if (storedWindow === undefined) continue;
      if (validityWindowsOverlap(storedWindow, window)) {
        return { part: write.part, proposed: write.after, incumbent: row };
      }
    }
  }
  return undefined;
}

/**
 * Every non-deleted composition row whose PART endpoint is one of `parts`,
 * keyed by `nodeRefKey(part)`, across every realizing edge kind — the holder
 * scope the composition claim keys a part on. Ended rows are included: they
 * are the history the decision is about.
 *
 * Reads through the set-read port in one statement per orientation, falling
 * back to the per-part `findEdgesConnectedTo` read when the port is absent.
 */
async function readCompositionWindowRows(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  parts: readonly CompositionNodeRef[],
): Promise<ReadonlyMap<string, readonly CompositionWindowEdge[]>> {
  const byPart = new Map<string, CompositionWindowEdge[]>();
  if (parts.length === 0) return byPart;
  const edgeKinds = registry.compositionEdgeKinds();
  const partKeys = new Set(parts.map((part) => nodeRefKey(part)));
  const setRows = await readCompositionEdgesAtRole(
    { graphId, registry },
    backend,
    "part",
    parts,
    edgeKinds,
  );
  const rows =
    setRows ?? (await readConnectedRowsPerPart(backend, graphId, parts));
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.deleted_at !== undefined || seen.has(row.id)) continue;
    const partSide = registry.compositionPartSide(row.kind);
    if (partSide === undefined) continue;
    const key = nodeRefKey(compositionRowEndpoints(partSide, row).part);
    if (!partKeys.has(key)) continue;
    seen.add(row.id);
    const bucket = byPart.get(key) ?? [];
    byPart.set(key, bucket);
    bucket.push(row);
  }
  return byPart;
}

/** The per-part fallback when the set-read port is absent. */
async function readConnectedRowsPerPart(
  backend: GraphReadBackend,
  graphId: string,
  parts: readonly CompositionNodeRef[],
): Promise<readonly EdgeRow[]> {
  const perPart = await Promise.all(
    parts.map((part) =>
      backend.findEdgesConnectedTo({
        graphId,
        nodeKind: part.kind,
        nodeId: part.id,
      }),
    ),
  );
  return perPart.flat();
}

/**
 * THE decision over one frame's writes: plan, read what the plan names,
 * decide. Returns the first conflict the writes would leave, or `undefined`.
 *
 * `beforeRead` runs once, only when the plan needs stored rows, before the
 * read — the fenced write path's freshness gate
 * ({@link assertCompositionWindowsDisjoint}). Without it this is the
 * unfenced form, for a caller judging writes it has not issued against a
 * target it does not hold the write fence on (a merge planner previewing its
 * plan): `writes` is every composition-row write the plan would make, as
 * {@link CompositionWindowWrites}, and `operationInstant` the instant the
 * plan's stamped lower bounds are judged at (default: now).
 */
export async function readCompositionWindowConflict(
  registry: KindRegistry,
  backend: GraphReadBackend,
  graphId: string,
  writes: CompositionWindowWrites,
  options: Readonly<{
    operationInstant?: string;
    beforeRead?: () => Promise<void>;
  }> = {},
): Promise<CompositionWindowConflict | undefined> {
  const plan = planCompositionWindowDecision(
    registry,
    writes,
    options.operationInstant ?? nowIso(),
  );
  if (plan.inFrameConflict !== undefined) return plan.inFrameConflict;
  if (plan.partsToRead.length === 0) return undefined;
  await options.beforeRead?.();
  const stored = await readCompositionWindowRows(
    registry,
    backend,
    graphId,
    plan.partsToRead,
  );
  return findCompositionWindowConflict(registry, plan, stored);
}

/**
 * The typed refusal a conflict raises: the store's write paths throw it, and
 * the merge planner carries it as the `cause` of its plan-time conflict, so
 * both name the part, both edges and both windows the same way.
 */
export function compositionWindowOverlapError(
  registry: KindRegistry,
  conflict: CompositionWindowConflict,
): CompositionError {
  const whole = wholeOf(registry, conflict.proposed);
  const incumbentWhole = wholeOf(registry, conflict.incumbent);
  const window = compositionWindowOf(registry, conflict.proposed) ?? {};
  const incumbentWindow =
    compositionWindowOf(registry, conflict.incumbent) ?? {};
  return new CompositionError({
    situation: "windowOverlap",
    partKind: conflict.part.kind,
    partId: conflict.part.id,
    wholeKind: whole.kind,
    wholeId: whole.id,
    edgeKind: conflict.proposed.kind,
    edgeId: conflict.proposed.id,
    ...(window.validFrom === undefined ? {} : { validFrom: window.validFrom }),
    ...(window.validTo === undefined ? {} : { validTo: window.validTo }),
    incumbentEdgeKind: conflict.incumbent.kind,
    incumbentEdgeId: conflict.incumbent.id,
    incumbentWholeKind: incumbentWhole.kind,
    incumbentWholeId: incumbentWhole.id,
    ...(incumbentWindow.validFrom === undefined ?
      {}
    : { incumbentValidFrom: incumbentWindow.validFrom }),
    ...(incumbentWindow.validTo === undefined ?
      {}
    : { incumbentValidTo: incumbentWindow.validTo }),
  });
}

function wholeOf(
  registry: KindRegistry,
  row: CompositionWindowEdge,
): CompositionNodeRef {
  const partSide = registry.compositionPartSide(row.kind);
  return partSide === undefined ?
      { kind: row.to_kind, id: row.to_id }
    : compositionRowEndpoints(partSide, row).whole;
}

/** The surface the fenced decision reads through and fences on. */
export type CompositionWindowTarget = GraphReadBackend &
  Pick<GraphBackend, "capabilities" | "commands" | "dialect" | "execute">;

/**
 * THE gate every store write path takes before the first statement of a frame
 * that writes composition rows: refuses with `CompositionError`
 * (`COMPOSITION_WINDOW_OVERLAP`) when the frame would leave one part with two
 * composition edges whose valid-time windows share an instant.
 *
 * `writes` is EVERY composition-row write of the frame — its inserts, and the
 * stored rows it ends, widens, reopens, resurrects or retires — so the frame is
 * judged as the state it produces, not one row at a time.
 *
 * Read-free when the frame brings no part an instant it did not already hold
 * (see {@link planCompositionWindowDecision}); otherwise the read is a
 * lock-only decision, gated by `fenceLockOnlyDecision` on the frame's fence
 * evidence `lock` before it runs.
 *
 * @throws CompositionError (`COMPOSITION_WINDOW_OVERLAP`)
 * @throws TransactionConflictError when another decider committed after this
 *   session's snapshot
 * @throws ConfigurationError (`COMPOSITION_WINDOW_REQUIRES_FRESH_SNAPSHOT`)
 */
export async function assertCompositionWindowsDisjoint(
  ctx: Readonly<{
    graphId: string;
    registry: KindRegistry;
    lock: GraphWriteLock;
  }>,
  target: CompositionWindowTarget,
  writes: CompositionWindowWrites,
): Promise<void> {
  const conflict = await readCompositionWindowConflict(
    ctx.registry,
    target,
    ctx.graphId,
    writes,
    {
      beforeRead: () =>
        fenceLockOnlyDecision(target, ctx.graphId, ctx.lock, {
          code: "COMPOSITION_WINDOW_REQUIRES_FRESH_SNAPSHOT",
          subject: "Deciding whether composition edge windows overlap",
        }),
    },
  );
  if (conflict !== undefined) {
    throw compositionWindowOverlapError(ctx.registry, conflict);
  }
}

/**
 * Every part whose stored composition rows already overlap, with the edges
 * involved — what `verifyConstraintFences()` reports as the
 * `compositionWindowOverlap` family and the schema-commit preflight refuses.
 *
 * Reads every non-deleted row (ended rows included) of every realizing edge
 * kind of a `population: "oneActive"` pair, groups them by part — the holder
 * scope the write path judges — and reports each part holding two rows whose
 * windows ({@link compositionWindowOf}) share an instant, provided one of
 * them is a row of `edgeKinds`. The audit passes every realizing edge kind; the
 * preflight only the edge kinds of the pairs a commit adds, so a pre-existing
 * overlap elsewhere never refuses an unrelated commit, while a row of a newly
 * declared pair is still judged against the part's rows of a pre-existing one.
 *
 * Holds one window per scanned row in memory: the parts are not ordered by any
 * column a page could follow.
 */
export async function readCompositionWindowOverlaps(
  registry: KindRegistry,
  backend: Pick<GraphReadBackend, "findEdgesByKind">,
  graphId: string,
  edgeKinds: readonly string[],
): Promise<
  readonly Readonly<{ part: CompositionNodeRef; edgeIds: readonly string[] }>[]
> {
  const judgedKinds = new Set(edgeKinds);
  const rowsByPart = new Map<
    string,
    Readonly<{
      part: CompositionNodeRef;
      rows: Readonly<{ id: string; kind: string; window: ValidityWindow }>[];
    }>
  >();
  for (const edgeKind of registry.compositionEdgeKinds()) {
    if (registry.compositionEdgePopulation(edgeKind) !== "oneActive") continue;
    const partSide = registry.compositionPartSide(edgeKind);
    if (partSide === undefined) continue;
    for await (const rows of pageEdgesByKind(
      backend,
      {
        graphId,
        kind: edgeKind,
        excludeDeleted: true,
        temporalMode: "includeEnded",
      },
      COMPOSITION_WINDOW_PAGE_SIZE,
    )) {
      for (const row of rows) {
        const window = compositionWindowOf(registry, row);
        if (window === undefined) continue;
        const { part } = compositionRowEndpoints(partSide, row);
        const key = nodeRefKey(part);
        const group = rowsByPart.get(key) ?? { part, rows: [] };
        rowsByPart.set(key, group);
        group.rows.push({ id: row.id, kind: row.kind, window });
      }
    }
  }

  const overlaps: Readonly<{
    part: CompositionNodeRef;
    edgeIds: readonly string[];
  }>[] = [];
  for (const { part, rows } of rowsByPart.values()) {
    const involved = new Set<string>();
    for (const [index, row] of rows.entries()) {
      for (const other of rows.slice(index + 1)) {
        if (!judgedKinds.has(row.kind) && !judgedKinds.has(other.kind)) {
          continue;
        }
        if (validityWindowsOverlap(row.window, other.window)) {
          involved.add(row.id);
          involved.add(other.id);
        }
      }
    }
    if (involved.size === 0) continue;
    overlaps.push({
      part,
      edgeIds: [...involved].toSorted((left, right) =>
        compareStrings(left, right),
      ),
    });
  }
  return overlaps.toSorted(
    (left, right) =>
      compareStrings(left.part.kind, right.part.kind) ||
      compareStrings(left.part.id, right.part.id),
  );
}
