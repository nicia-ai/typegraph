import type {
  BATCH_POINT_READ,
  ENDPOINT_SET_READ,
} from "../backend/capabilities/bundle-registry";
import { type BundleVerdictOf } from "../backend/capabilities/resolve";
import {
  type EdgeRow,
  type GraphReadBackend,
  type NodeRow,
} from "../backend/types";
import type { KindRegistry } from "../registry";
import {
  type EndpointEdgeReader,
  findEdgeRowsByEndpoints,
} from "../store/edge-fetch";
import {
  COMPOSITION_ATTACHMENT_PAGE_SIZE,
  readCompositionAttachmentsForPage,
  readLiveCompositionWholes,
  readNodeRowsByRef,
} from "../store/operations/composition-create";
import { chunk } from "../utils/array";
import { nowIso, validityWindowContainsInstant } from "../utils/date";
import { nodeRefKey } from "../utils/tuple-key";
import { type NormalizedConfig } from "./config";
import { edgeFromKey, keyToRef, refKey, rowKey } from "./keys";
import {
  appendGroupedValue,
  buildSupportEdges,
  type CompositionExistenceDependencies,
  NO_COMPOSITION_EXISTENCE_DEPENDENCIES,
  type ProvenanceRows,
  type SupportGraph,
} from "./support";
import { type ProvenanceNodeRef } from "./types";

type TemporalRow = Readonly<
  Pick<NodeRow, "deleted_at" | "valid_from" | "valid_to">
>;

/**
 * One row-currency rule of a support read. `holds` IS the rule; `scan` is the
 * same rule pushed down into a kind or endpoint read, and may only ever admit
 * a superset of what `holds` keeps. Every row a loader keeps has passed
 * `holds`, whichever read produced it, so the whole-graph loader and the
 * closure loader cannot disagree about which rows count.
 */
type RowCurrencyRule = Readonly<{
  scan: (asOf: string) => Readonly<{
    excludeDeleted: boolean;
    temporalMode: "current" | "includeTombstones";
    asOf?: string;
  }>;
  holds: (row: TemporalRow, asOf: string) => boolean;
}>;

/**
 * Provenance reads follow the store's currency semantics: a source,
 * justification, or support edge counts only while currently valid (the
 * default `"current"` read mode), so a validity-expired source no longer
 * supports anything and `holding()` agrees with the collection API about
 * which facts are currently believed.
 */
const CURRENT_ROLE_ROW: RowCurrencyRule = {
  scan: (asOf) => ({ excludeDeleted: true, temporalMode: "current", asOf }),
  holds: (row, asOf) =>
    row.deleted_at === undefined &&
    validityWindowContainsInstant(row.valid_from, row.valid_to, asOf),
};

/**
 * Fact rows additionally need their tombstones — a reopen candidate is by
 * definition soft-deleted — so they are read with tombstones and filtered to
 * the same validity instant.
 */
const FACT_ROW_AT_INSTANT: RowCurrencyRule = {
  scan: () => ({ excludeDeleted: false, temporalMode: "includeTombstones" }),
  holds: (row, asOf) =>
    validityWindowContainsInstant(row.valid_from, row.valid_to, asOf),
};

async function findNodeRows(
  backend: GraphReadBackend,
  graphId: string,
  kind: string,
  rule: RowCurrencyRule,
  asOf: string,
): Promise<readonly NodeRow[]> {
  const rows = await backend.findNodesByKind({
    graphId,
    kind,
    ...rule.scan(asOf),
    orderBy: "id",
  });
  return rows.filter((row) => rule.holds(row, asOf));
}

async function findEdgeRows(
  backend: GraphReadBackend,
  graphId: string,
  kind: string,
  asOf: string,
): Promise<readonly EdgeRow[]> {
  const rows = await backend.findEdgesByKind({
    graphId,
    kind,
    ...CURRENT_ROLE_ROW.scan(asOf),
    orderBy: "id",
  });
  return rows.filter((row) => CURRENT_ROLE_ROW.holds(row, asOf));
}

async function readRoles(
  backend: GraphReadBackend,
  graphId: string,
  config: NormalizedConfig,
  asOf: string,
): Promise<ProvenanceRows> {
  const [justificationRows, factRowsByKind, premiseEdges, deriveEdges] =
    await Promise.all([
      findNodeRows(
        backend,
        graphId,
        config.justificationKind,
        CURRENT_ROLE_ROW,
        asOf,
      ),
      Promise.all(
        config.factKinds.map((kind) =>
          findNodeRows(backend, graphId, kind, FACT_ROW_AT_INSTANT, asOf),
        ),
      ),
      findEdgeRows(backend, graphId, config.premiseOfKind, asOf),
      findEdgeRows(backend, graphId, config.derivesKind, asOf),
    ]);
  const factRows = factRowsByKind.flat();

  return {
    justifications: rowsByKey(justificationRows),
    facts: rowsByKey(factRows),
    premiseEdges,
    deriveEdges,
  };
}

function rowsByKey(rows: readonly NodeRow[]): ReadonlyMap<string, NodeRow> {
  const byKey = new Map<string, NodeRow>();
  for (const row of rows) byKey.set(rowKey(row), row);
  return byKey;
}

/**
 * The WHOLE provenance graph, for a caller that needs every fact's verdict: a
 * retraction transition, which must find what its sources reach, and
 * `holding()`. A caller judging named facts reads
 * {@link loadSupportClosure} instead.
 */
export async function loadSupportGraph(
  backend: GraphReadBackend,
  registry: KindRegistry,
  graphId: string,
  config: NormalizedConfig,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
): Promise<SupportGraph> {
  // One read instant for every role read, so the whole snapshot shares a
  // single "currently valid" coordinate.
  const asOf = nowIso();
  const roles = await readRoles(backend, graphId, config, asOf);
  const supportEdges = buildSupportEdges(config, roles);
  const [compositionDependencies, sourceRowsByKind] = await Promise.all([
    readCompositionExistenceDependencies(
      backend,
      registry,
      graphId,
      roles.facts,
      batchPointRead,
    ),
    Promise.all(
      config.sourceKinds.map((kind) =>
        findNodeRows(backend, graphId, kind, CURRENT_ROLE_ROW, asOf),
      ),
    ),
  ]);
  return {
    roles,
    supportEdges,
    compositionDependencies,
    sourceRows: sourceRowsByKind.flat(),
  };
}

/**
 * Which fact rows are required composition parts, and the whole each one
 * currently hangs from. A required part with no current whole is in
 * `requiredPartFactKeys` and absent from `wholeKeyByPartKey`.
 */
type RequiredPartAttachments = Readonly<{
  requiredPartFactKeys: ReadonlySet<string>;
  wholeKeyByPartKey: ReadonlyMap<string, string>;
}>;

/**
 * Reads which of these fact rows are required composition parts and which
 * whole each currently hangs from, through `readCompositionAttachmentsForPage`
 * — the same owner `verifyConstraintFences`' `compositionExistence` family
 * reads, one bounded candidate read per page per orientation with a per-row
 * confirmation for a negative — so provenance re-spells neither composition
 * orientation nor the whole-side population predicate, nor the shape of that
 * read.
 *
 * A graph that declares no required part costs no read at all: the registry
 * answers `compositionExistence` per kind from its memoized relation.
 */
async function readRequiredPartAttachments(
  backend: GraphReadBackend,
  registry: KindRegistry,
  graphId: string,
  facts: Iterable<readonly [string, NodeRow]>,
): Promise<RequiredPartAttachments> {
  const requiredPartRows = [...facts].filter(
    ([, row]) => registry.compositionExistence(row.kind) === "required",
  );
  const requiredPartFactKeys = new Set<string>();
  const wholeKeyByPartKey = new Map<string, string>();
  for (const [factKey] of requiredPartRows) requiredPartFactKeys.add(factKey);

  for (const page of chunk(
    requiredPartRows,
    COMPOSITION_ATTACHMENT_PAGE_SIZE,
  )) {
    const attachments = await readCompositionAttachmentsForPage(
      registry,
      backend,
      graphId,
      page.map(([, row]) => row),
    );
    for (const [factKey, row] of page) {
      const attachment = attachments.get(nodeRefKey(row));
      if (attachment === undefined) continue;
      wholeKeyByPartKey.set(
        factKey,
        refKey({ kind: attachment.whole.kind, id: attachment.whole.id }),
      );
    }
  }
  return { requiredPartFactKeys, wholeKeyByPartKey };
}

/**
 * Turns the attachments of a loaded set of fact rows into the support
 * computation's existence dependencies.
 *
 * A whole that is itself a fact carries a belief status, so its support decides
 * its parts'. Any other whole (a plain node, or a source — whose retraction is
 * a property flip, not a liveness change) is judged by `readLiveCompositionWholes`,
 * the whole-endpoint liveness owner: present and not tombstoned. Deliberately
 * NOT a validity-window question. A whole whose window has closed is still a
 * live row that the write path would accept as a whole, so treating it as dead
 * here would make a part unbelieved before a transition and tombstoned by it —
 * a close the report could not even name, since the fact was never believed.
 */
async function resolveCompositionExistenceDependencies(
  backend: GraphReadBackend,
  graphId: string,
  facts: ReadonlyMap<string, NodeRow>,
  attachments: RequiredPartAttachments,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
): Promise<CompositionExistenceDependencies> {
  if (attachments.requiredPartFactKeys.size === 0) {
    return NO_COMPOSITION_EXISTENCE_DEPENDENCIES;
  }
  const partKeysByWholeKey = new Map<string, string[]>();
  for (const [partKey, wholeKey] of attachments.wholeKeyByPartKey) {
    appendGroupedValue(partKeysByWholeKey, wholeKey, partKey);
  }

  const nonFactWholeKeys = [...partKeysByWholeKey.keys()].filter(
    (wholeKey) => !facts.has(wholeKey),
  );
  const liveWholes = await readLiveCompositionWholes(
    backend,
    graphId,
    nonFactWholeKeys.map((wholeKey) => keyToRef(wholeKey)),
    batchPointRead,
  );
  const liveWholeKeys = new Set(
    liveWholes.map((whole) => refKey({ kind: whole.kind, id: whole.id })),
  );

  return {
    requiredPartFactKeys: attachments.requiredPartFactKeys,
    wholeKeyByPartKey: attachments.wholeKeyByPartKey,
    partKeysByWholeKey,
    liveWholeKeys,
  };
}

/**
 * The existence dependencies of a set of fact rows: their attachments
 * ({@link readRequiredPartAttachments}) resolved against that same set
 * ({@link resolveCompositionExistenceDependencies}). The whole-graph loader
 * calls it over every fact row; the closure loader runs the two halves
 * itself, because the wholes it discovers decide which fact rows it loads.
 */
async function readCompositionExistenceDependencies(
  backend: GraphReadBackend,
  registry: KindRegistry,
  graphId: string,
  facts: ReadonlyMap<string, NodeRow>,
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>,
): Promise<CompositionExistenceDependencies> {
  return resolveCompositionExistenceDependencies(
    backend,
    graphId,
    facts,
    await readRequiredPartAttachments(backend, registry, graphId, facts),
    batchPointRead,
  );
}

/**
 * How many frontier facts one round of {@link loadSupportClosure} expands.
 * Bounds every statement of the round: the fact row read, the two endpoint
 * edge reads and the row reads for the justifications and sources they name.
 */
const SUPPORT_CLOSURE_ROUND_SIZE = 500;

/** The read surface the closure loader needs on top of the role reads. */
type SupportClosureBackend = GraphReadBackend & EndpointEdgeReader;

/** The verdicts and read instant every round of a closure load shares. */
type SupportClosureRead = Readonly<{
  backend: SupportClosureBackend;
  registry: KindRegistry;
  graphId: string;
  config: NormalizedConfig;
  batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
  endpointSetRead: BundleVerdictOf<typeof ENDPOINT_SET_READ>;
  asOf: string;
}>;

/** The rows a closure load has accumulated, and what it has already asked for. */
type SupportClosureState = Readonly<{
  facts: Map<string, NodeRow>;
  justifications: Map<string, NodeRow>;
  premiseEdges: EdgeRow[];
  deriveEdges: EdgeRow[];
  sourceRows: NodeRow[];
  requiredPartFactKeys: Set<string>;
  wholeKeyByPartKey: Map<string, string>;
  requestedFactKeys: Set<string>;
  requestedJustificationKeys: Set<string>;
  requestedSourceKeys: Set<string>;
  frontier: string[];
}>;

/** The by-reference rows a rule keeps, keyed by provenance key. */
async function readRowsHolding(
  read: SupportClosureRead,
  keys: readonly string[],
  rule: RowCurrencyRule,
): Promise<ReadonlyMap<string, NodeRow>> {
  const rowsByRef = await readNodeRowsByRef(
    read.backend,
    read.graphId,
    keys.map((key) => keyToRef(key)),
    read.batchPointRead,
  );
  const kept = new Map<string, NodeRow>();
  for (const row of rowsByRef.values()) {
    if (row === undefined || !rule.holds(row, read.asOf)) continue;
    kept.set(rowKey(row), row);
  }
  return kept;
}

async function currentEdgesInto(
  read: SupportClosureRead,
  kind: string,
  endpoints: readonly ProvenanceNodeRef[],
): Promise<readonly EdgeRow[]> {
  const rows = await findEdgeRowsByEndpoints(
    read.backend,
    read.endpointSetRead,
    {
      graphId: read.graphId,
      kind,
      side: "to",
      endpoints,
      ...CURRENT_ROLE_ROW.scan(read.asOf),
    },
  );
  return rows.filter((row) => CURRENT_ROLE_ROW.holds(row, read.asOf));
}

function enqueueFact(state: SupportClosureState, factKey: string): void {
  if (state.requestedFactKeys.has(factKey)) return;
  state.requestedFactKeys.add(factKey);
  state.frontier.push(factKey);
}

/**
 * One round of the backward walk: loads this round's fact rows and everything
 * one step behind them, and queues the facts found there.
 *
 * A fact with no row at the read instant is not expanded. It cannot be
 * supported, so nothing behind it can change any verdict, and as a premise it
 * simply fails to be in the supported set.
 */
async function expandSupportClosureRound(
  read: SupportClosureRead,
  state: SupportClosureState,
  factKeys: readonly string[],
): Promise<void> {
  const { config } = read;
  const factRows = await readRowsHolding(read, factKeys, FACT_ROW_AT_INSTANT);
  for (const [factKey, row] of factRows) state.facts.set(factKey, row);
  if (factRows.size === 0) return;

  const deriveEdges = await currentEdgesInto(
    read,
    config.derivesKind,
    [...factRows.keys()].map((factKey) => keyToRef(factKey)),
  );
  state.deriveEdges.push(...deriveEdges);
  const newJustificationKeys = new Set<string>();
  for (const edge of deriveEdges) {
    if (edge.from_kind !== config.justificationKind) continue;
    const justificationKey = edgeFromKey(edge);
    if (state.requestedJustificationKeys.has(justificationKey)) continue;
    state.requestedJustificationKeys.add(justificationKey);
    newJustificationKeys.add(justificationKey);
  }

  const justificationRows = await readRowsHolding(
    read,
    [...newJustificationKeys],
    CURRENT_ROLE_ROW,
  );
  for (const [justificationKey, row] of justificationRows) {
    state.justifications.set(justificationKey, row);
  }

  const premiseEdges = await currentEdgesInto(
    read,
    config.premiseOfKind,
    [...justificationRows.keys()].map((key) => keyToRef(key)),
  );
  state.premiseEdges.push(...premiseEdges);
  const newSourceKeys = new Set<string>();
  for (const edge of premiseEdges) {
    const premiseKey = edgeFromKey(edge);
    if (config.factKinds.includes(edge.from_kind)) {
      enqueueFact(state, premiseKey);
      continue;
    }
    if (!config.sourceKinds.includes(edge.from_kind)) continue;
    if (state.requestedSourceKeys.has(premiseKey)) continue;
    state.requestedSourceKeys.add(premiseKey);
    newSourceKeys.add(premiseKey);
  }
  const sourceRows = await readRowsHolding(
    read,
    [...newSourceKeys],
    CURRENT_ROLE_ROW,
  );
  state.sourceRows.push(...sourceRows.values());

  const attachments = await readRequiredPartAttachments(
    read.backend,
    read.registry,
    read.graphId,
    factRows,
  );
  for (const partKey of attachments.requiredPartFactKeys) {
    state.requiredPartFactKeys.add(partKey);
  }
  for (const [partKey, wholeKey] of attachments.wholeKeyByPartKey) {
    state.wholeKeyByPartKey.set(partKey, wholeKey);
    // A whole of a fact kind is judged by its own support, so it is part of
    // what is behind this fact. Any other whole is judged by its liveness.
    if (config.factKinds.includes(keyToRef(wholeKey).kind)) {
      enqueueFact(state, wholeKey);
    }
  }
}

/**
 * The part of the provenance graph BEHIND the named facts, as a
 * {@link SupportGraph}: the `derives` edges into them, the current
 * justifications at the far end, the `premiseOf` edges into those, then the
 * premise sources and facts — with fact premises, and the fact wholes of
 * required composition parts, walked the same way until nothing new turns up.
 *
 * A fact's support depends on nothing else, so the least fixpoint
 * `computeSupportSnapshot` reaches over this graph gives every fact in it the
 * verdict and the firing justifications the whole-graph fixpoint gives it.
 * That holds because the walk is backward-CLOSED: every loaded fact has all of
 * its current `derives` edges, every loaded justification all of its current
 * `premiseOf` edges, and every loaded required part its whole.
 *
 * It reads at one instant and keeps exactly the rows the whole-graph loader
 * keeps (the {@link RowCurrencyRule}s above), in rounds of at most
 * {@link SUPPORT_CLOSURE_ROUND_SIZE} facts. Only the sources that are premises
 * inside the closure are read, so only their retracted state is ever parsed. A
 * named fact with no row at the read instant is absent from `roles.facts`.
 */
export async function loadSupportClosure(
  backend: SupportClosureBackend,
  registry: KindRegistry,
  graphId: string,
  config: NormalizedConfig,
  facts: readonly ProvenanceNodeRef[],
  verdicts: Readonly<{
    batchPointRead: BundleVerdictOf<typeof BATCH_POINT_READ>;
    endpointSetRead: BundleVerdictOf<typeof ENDPOINT_SET_READ>;
  }>,
): Promise<SupportGraph> {
  const read: SupportClosureRead = {
    backend,
    registry,
    graphId,
    config,
    ...verdicts,
    asOf: nowIso(),
  };
  const state: SupportClosureState = {
    facts: new Map(),
    justifications: new Map(),
    premiseEdges: [],
    deriveEdges: [],
    sourceRows: [],
    requiredPartFactKeys: new Set(),
    wholeKeyByPartKey: new Map(),
    requestedFactKeys: new Set(),
    requestedJustificationKeys: new Set(),
    requestedSourceKeys: new Set(),
    frontier: [],
  };
  for (const fact of facts) enqueueFact(state, refKey(fact));

  while (state.frontier.length > 0) {
    await expandSupportClosureRound(
      read,
      state,
      state.frontier.splice(0, SUPPORT_CLOSURE_ROUND_SIZE),
    );
  }

  const roles: ProvenanceRows = {
    justifications: state.justifications,
    facts: state.facts,
    premiseEdges: state.premiseEdges,
    deriveEdges: state.deriveEdges,
  };
  return {
    roles,
    supportEdges: buildSupportEdges(config, roles),
    compositionDependencies: await resolveCompositionExistenceDependencies(
      backend,
      graphId,
      state.facts,
      state,
      verdicts.batchPointRead,
    ),
    sourceRows: state.sourceRows,
  };
}
