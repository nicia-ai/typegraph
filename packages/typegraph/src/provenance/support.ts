import {
  type EdgeRow,
  isLiveNodeRow,
  isTombstonedNodeRow,
  type NodeRow,
  rowPropsToObject,
} from "../backend/types";
import { ConfigurationError } from "../errors";
import { isPlainObject } from "../utils/object";
import { isPremiseKind, type NormalizedConfig } from "./config";
import { edgeFromKey, edgeToKey, refKey, rowKey } from "./keys";
import { type ProvenanceNodeRef } from "./types";

export type ProvenanceRows = Readonly<{
  justifications: ReadonlyMap<string, NodeRow>;
  facts: ReadonlyMap<string, NodeRow>;
  premiseEdges: readonly EdgeRow[];
  deriveEdges: readonly EdgeRow[];
}>;

type SupportEdges = Readonly<{
  premisesByJustification: ReadonlyMap<string, readonly string[]>;
  factsByJustification: ReadonlyMap<string, readonly string[]>;
  justificationsByPremise: ReadonlyMap<string, readonly string[]>;
}>;

/**
 * The existence dependency composition adds to the support computation: a
 * REQUIRED composition part cannot exist without a live whole, so its belief
 * status follows the whole's. The maps are read once per transition alongside
 * the role rows — a transition flips source properties only, never a
 * composition edge or a non-fact node's liveness, so the pre- and
 * post-transition snapshots share this view exactly as they share the support
 * edges.
 *
 * `liveWholeKeys` covers only the wholes that are NOT fact rows; a fact whole
 * is judged by the snapshot's own support instead.
 *
 * `requiredPartFactKeys` holds every fact row whose kind is a required part,
 * including one whose whole could not be found: that fact is unsupported (the
 * same verdict `verifyConstraintFences`' `compositionExistence` family reports
 * as a violation while the part is live), which is why the set is kept
 * separately from `wholeKeyByPartKey` rather than inferred from it.
 */
export type CompositionExistenceDependencies = Readonly<{
  requiredPartFactKeys: ReadonlySet<string>;
  wholeKeyByPartKey: ReadonlyMap<string, string>;
  partKeysByWholeKey: ReadonlyMap<string, readonly string[]>;
  /** Whole keys that are not fact rows and are live at the snapshot instant. */
  liveWholeKeys: ReadonlySet<string>;
}>;

export const NO_COMPOSITION_EXISTENCE_DEPENDENCIES: CompositionExistenceDependencies =
  {
    requiredPartFactKeys: new Set<string>(),
    wholeKeyByPartKey: new Map<string, string>(),
    partKeysByWholeKey: new Map<string, readonly string[]>(),
    liveWholeKeys: new Set<string>(),
  };

/**
 * The selected fact rows grouped into composition rounds, shallowest first:
 * round `n` holds the rows whose required-part chain through
 * `wholeKeyByPartKey` is `n` steps long, so a part always sits in a later
 * round than its whole, its whole's whole, and so on — across fact kinds,
 * and whether or not an intermediate whole is itself selected. Rows that are
 * not required parts (or whose whole is not found) sit in round 0.
 *
 * The rounds feed `cascadeDeletionOrder` (`composition-cascade.ts`), the one
 * owner of "every part before the whole it belongs to, then by kind and id
 * within a level", exactly as a cascade's breadth-first discovery rounds do.
 * Each part hangs from at most one whole, so its depth is the length of one
 * chain: no ordering between unrelated rows is needed or implied. The chain
 * walk stops at a revisited key, so a composition cycle (refused at write
 * time; reachable only through rows written around that check) cannot hang
 * it.
 */
export function compositionDepthRounds<Row>(
  dependencies: CompositionExistenceDependencies,
  rows: ReadonlyMap<string, Row>,
): readonly (readonly Row[])[] {
  const rounds: Row[][] = [];
  for (const [key, row] of rows) {
    const depth = compositionDepth(dependencies, key);
    while (rounds.length <= depth) rounds.push([]);
    rounds[depth]?.push(row);
  }
  return rounds;
}

function compositionDepth(
  dependencies: CompositionExistenceDependencies,
  factKey: string,
): number {
  const visited = new Set<string>([factKey]);
  let current = dependencies.wholeKeyByPartKey.get(factKey);
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    current = dependencies.wholeKeyByPartKey.get(current);
  }
  return visited.size - 1;
}

export type SupportSnapshot = Readonly<{
  facts: ReadonlyMap<string, NodeRow>;
  supportedFactKeys: ReadonlySet<string>;
  believedFactKeys: ReadonlySet<string>;
  firingJustificationKeysByFact: ReadonlyMap<string, readonly string[]>;
  affectedFactKeys: (
    sources: readonly ProvenanceNodeRef[],
    supportedBefore: ReadonlySet<string>,
  ) => ReadonlySet<string>;
}>;

export type SourceRetractedState = "retracted" | "available";

/**
 * What a support computation reads: the role rows, the support edges derived
 * from them, and the (non-retracted-visible) source rows. Either the whole
 * provenance graph or the part of it behind a set of facts — see the two
 * loaders in `./support-read`. A transition loads it once so its `before` and
 * `after` snapshots share one read instead of scanning the graph twice: the
 * structure is identical across a transition, only source availability
 * changes.
 */
export type SupportGraph = Readonly<{
  roles: ProvenanceRows;
  supportEdges: SupportEdges;
  compositionDependencies: CompositionExistenceDependencies;
  sourceRows: readonly NodeRow[];
}>;

function parseNodeProps(row: NodeRow): Record<string, unknown> {
  const parsed = rowPropsToObject(row.props) as unknown;
  if (!isPlainObject(parsed)) {
    throw new ConfigurationError(
      `Node ${row.kind}/${row.id} props are not an object.`,
      { kind: row.kind, id: row.id },
    );
  }
  return parsed;
}

export function sourceRetractedState(
  row: NodeRow,
  retractedField: string,
): SourceRetractedState {
  const props = parseNodeProps(row);
  const value = props[retractedField];
  if (value === undefined) return "available";
  if (typeof value !== "boolean") {
    throw new ConfigurationError(
      `Provenance source field "${retractedField}" must contain a boolean value.`,
      { kind: row.kind, id: row.id, field: retractedField },
      {
        suggestion:
          "Use a source node schema with a boolean retracted flag, for example z.boolean().default(false).",
      },
    );
  }
  return value ? "retracted" : "available";
}

export function availableSourceKeys(
  sourceRows: readonly NodeRow[],
  retractedField: string,
): Set<string> {
  const available = new Set<string>();
  for (const row of sourceRows) {
    if (sourceRetractedState(row, retractedField) === "available") {
      available.add(rowKey(row));
    }
  }
  return available;
}

export function appendGroupedValue(
  groups: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, [value]);
    return;
  }
  if (group.includes(value)) return;
  group.push(value);
}

export function buildSupportEdges(
  config: NormalizedConfig,
  rows: ProvenanceRows,
): SupportEdges {
  const premisesByJustification = new Map<string, string[]>();
  const factsByJustification = new Map<string, string[]>();
  const justificationsByPremise = new Map<string, string[]>();

  for (const edge of rows.premiseEdges) {
    if (edge.to_kind !== config.justificationKind) continue;
    if (!isPremiseKind(config, edge.from_kind)) continue;

    const premiseKey = edgeFromKey(edge);
    const justificationKey = edgeToKey(edge);
    appendGroupedValue(premisesByJustification, justificationKey, premiseKey);
    appendGroupedValue(justificationsByPremise, premiseKey, justificationKey);
  }

  for (const edge of rows.deriveEdges) {
    if (edge.from_kind !== config.justificationKind) continue;
    if (!config.factKinds.includes(edge.to_kind)) continue;
    appendGroupedValue(
      factsByJustification,
      edgeFromKey(edge),
      edgeToKey(edge),
    );
  }

  return {
    premisesByJustification,
    factsByJustification,
    justificationsByPremise,
  };
}

/**
 * The pure TMS fixpoint: given the loaded graph and the set of available
 * (non-retracted) source keys, derive which facts are supported and believed.
 * No I/O — the same {@link SupportGraph} feeds both the pre- and post-transition
 * snapshots with different availability sets.
 */
export function computeSupportSnapshot(
  graph: Pick<
    SupportGraph,
    "roles" | "supportEdges" | "compositionDependencies"
  >,
  available: ReadonlySet<string>,
): SupportSnapshot {
  const { roles, supportEdges, compositionDependencies } = graph;
  const supported = new Set<string>();
  const inSet = new Set<string>(available);
  const firingJustifications = new Set<string>();
  const firingJustificationKeysByFact = new Map<string, string[]>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const [justificationKey] of roles.justifications) {
      if (firingJustifications.has(justificationKey)) continue;
      const premises =
        supportEdges.premisesByJustification.get(justificationKey) ?? [];
      if (!allPremisesSupported(premises, inSet)) continue;

      firingJustifications.add(justificationKey);
      changed = true;
      const derivedFacts =
        supportEdges.factsByJustification.get(justificationKey) ?? [];
      for (const factKey of derivedFacts) {
        if (!roles.facts.has(factKey)) continue;
        appendGroupedValue(
          firingJustificationKeysByFact,
          factKey,
          justificationKey,
        );
      }
    }
    // A derived fact is supported only once its composition existence
    // dependency also holds, so a required part whose whole is unsupported
    // stays out of the set even while its own justification fires. Both
    // conjuncts only ever grow, so this remains the least fixpoint; the
    // dependency is re-checked every round because a whole that becomes
    // supported later admits the parts an earlier round held back.
    for (const factKey of firingJustificationKeysByFact.keys()) {
      if (supported.has(factKey)) continue;
      if (
        !compositionExistenceSupported(
          compositionDependencies,
          roles,
          supported,
          factKey,
        )
      ) {
        continue;
      }
      supported.add(factKey);
      inSet.add(factKey);
      changed = true;
    }
  }

  const believed = new Set<string>();
  for (const key of supported) {
    const row = roles.facts.get(key);
    if (row !== undefined && row.deleted_at === undefined) believed.add(key);
  }

  return {
    facts: roles.facts,
    supportedFactKeys: supported,
    believedFactKeys: believed,
    firingJustificationKeysByFact,
    affectedFactKeys(
      targets: readonly ProvenanceNodeRef[],
      supportedBefore: ReadonlySet<string>,
    ): ReadonlySet<string> {
      return computeAffectedFactKeys(
        targets,
        roles,
        supportEdges,
        compositionDependencies,
        supportedBefore,
        supported,
      );
    },
  };
}

function allPremisesSupported(
  premises: readonly string[],
  supported: ReadonlySet<string>,
): boolean {
  for (const premise of premises) {
    if (!supported.has(premise)) return false;
  }
  return true;
}

/**
 * THE support question composition adds: may this fact be supported at all,
 * given that a required composition part cannot exist without its whole?
 *
 * A fact that is not a required part always may. A required part may only
 * while the whole it currently hangs from is itself supported (a whole that is
 * a fact carries its own belief status) or live (any other whole). A required
 * part with no current whole may not: nothing holds it up.
 */
function compositionExistenceSupported(
  dependencies: CompositionExistenceDependencies,
  roles: ProvenanceRows,
  supported: ReadonlySet<string>,
  factKey: string,
): boolean {
  if (!dependencies.requiredPartFactKeys.has(factKey)) return true;
  const wholeKey = dependencies.wholeKeyByPartKey.get(factKey);
  if (wholeKey === undefined) return false;
  if (roles.facts.has(wholeKey)) return supported.has(wholeKey);
  return dependencies.liveWholeKeys.has(wholeKey);
}

/**
 * Whether bringing this fact row in line with its post-transition support
 * writes it: a live row that is unsupported closes, a tombstoned row that is
 * supported reopens. The one statement of "this row's currency moves", shared
 * by the walk that scopes a whole's parts. The close and reopen passes select
 * exactly these rows from the scope that walk builds.
 */
function currencyMovesWithSupport(row: NodeRow, supported: boolean): boolean {
  return supported ? isTombstonedNodeRow(row) : isLiveNodeRow(row);
}

function computeAffectedFactKeys(
  sources: readonly ProvenanceNodeRef[],
  roles: ProvenanceRows,
  supportEdges: SupportEdges,
  compositionDependencies: CompositionExistenceDependencies,
  supportedBefore: ReadonlySet<string>,
  supportedAfter: ReadonlySet<string>,
): ReadonlySet<string> {
  const affected = new Set<string>();
  // Seed the BFS with every source at once: the union of facts reachable from
  // any source falls out of one traversal, instead of one BFS per source.
  const frontier = sources.map((source) => refKey(source));
  const seen = new Set<string>(frontier);

  while (frontier.length > 0) {
    const current = frontier.shift();
    if (current === undefined) continue;

    const justifications =
      supportEdges.justificationsByPremise.get(current) ?? [];
    for (const justificationKey of justifications) {
      const derivedFacts =
        supportEdges.factsByJustification.get(justificationKey) ?? [];
      for (const factKey of derivedFacts) {
        if (!roles.facts.has(factKey)) continue;
        affected.add(factKey);
        if (seen.has(factKey)) continue;
        seen.add(factKey);
        frontier.push(factKey);
      }
    }

    // A whole carries its required parts into scope when this transition
    // moves the whole: its support changes, or its currency does (a live whole
    // that is unsupported after is about to close, a tombstoned whole that is
    // supported after is about to reopen — even when its support verdict did
    // not change, as for a fact reached while already unsupported). Either
    // way its parts cannot stay as they are, and a part that is itself a
    // whole folds out of the same walk. A whole reached with neither change
    // (another of its justifications still fires and its row is in step)
    // leaves its parts alone: their existence dependency has the same
    // verdict before and after. The one exception is a part, at any depth
    // below that whole, that is closed although it is supported after: a
    // caught failure part-way through the reopen pass (which runs every whole
    // before its parts) leaves exactly that state under a chain of wholes
    // already live, and a re-run that reaches the part only through them must
    // reopen it to complete the transition. A live part without support is
    // not carried in: no prefix of a transition leaves one (the close pass
    // closes every part before its whole and before any flag), and closing
    // it is the business of a transition that moves its support. Only a fact
    // whole propagates: a transition flips source properties, so a non-fact
    // whole's liveness is the same before and after.
    const wholeRow = roles.facts.get(current);
    if (wholeRow === undefined) continue;
    const wholeMoves =
      supportedBefore.has(current) !== supportedAfter.has(current) ||
      currencyMovesWithSupport(wholeRow, supportedAfter.has(current));
    const carriedParts =
      wholeMoves ?
        (compositionDependencies.partKeysByWholeKey.get(current) ?? []).filter(
          (partKey) => roles.facts.has(partKey),
        )
      : interruptedReopenPartKeys(
          current,
          roles,
          compositionDependencies,
          supportedAfter,
        );
    for (const partKey of carriedParts) {
      affected.add(partKey);
      if (seen.has(partKey)) continue;
      seen.add(partKey);
      frontier.push(partKey);
    }
  }

  return affected;
}

/**
 * The facts below a whole that does not move which a re-run must reopen: a
 * required part, at any depth, that is closed although it is supported
 * after. The descent passes through parts that are in step (a live part is
 * the whole of the next level, and its own parts may be the closed ones) and
 * stops at each part it returns: the affected-fact walk carries that part,
 * and a closed part that is supported after moves, so the walk carries its
 * whole subtree from there.
 */
function interruptedReopenPartKeys(
  wholeKey: string,
  roles: ProvenanceRows,
  compositionDependencies: CompositionExistenceDependencies,
  supportedAfter: ReadonlySet<string>,
): readonly string[] {
  const reopen: string[] = [];
  const visited = new Set<string>([wholeKey]);
  const pending = [wholeKey];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const parts = compositionDependencies.partKeysByWholeKey.get(current) ?? [];
    for (const partKey of parts) {
      if (visited.has(partKey)) continue;
      visited.add(partKey);
      const partRow = roles.facts.get(partKey);
      if (partRow === undefined) continue;
      if (supportedAfter.has(partKey) && isTombstonedNodeRow(partRow)) {
        reopen.push(partKey);
      } else {
        pending.push(partKey);
      }
    }
  }
  return reopen;
}
